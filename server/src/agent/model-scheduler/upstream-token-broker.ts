/**
 * 跨进程全局令牌（文件锁）。**与桌面 `desktop/model-call-scheduler.cjs#createUpstreamTokenBroker`
 * 共用同一协议**，两侧进程因此共享同一个「全局最多 3」配额（HTTP + direct 不叠加）。
 *
 * 协议（机器可读副本在 `test/fixtures/model-scheduler/cases.json#tokenProtocol`）：
 * - 目录：`MODEL_UPSTREAM_TOKEN_DIR`，默认 `<os.tmpdir()>/smart-store-model-slots`；
 * - 令牌文件：`slot-<n>.token`（n = 1..3），`O_CREAT|O_EXCL` 原子创建即互斥；
 * - 内容：`{"v":1,"pid","host","acquiredAt","expiresAt","label"}`；
 * - 心跳：每 `leaseTtl/3` 用「临时文件 + rename」续租 `expiresAt`；
 * - 回收：`expiresAt` 已过且（同机 pid 已死 / 跨机 / 内容不可读且 mtime 超过 TTL）才 unlink 重试；
 * - 目录不可用（EPERM/EACCES/EROFS…）→ 可见 warning + 可读原因 + `globalStats().degraded=true`；
 *   `strict` 模式改为 fail closed（`MODEL_BUSY`），**绝不静默退回「各算 3」**。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_TOKEN_DIR_NAME,
  DEFAULT_TOKEN_POLL_MS,
  ENV_NAMES,
  ERROR_CODES,
  MAX_UPSTREAM_CONCURRENCY,
  ModelSchedulerError,
  MODEL_SCHEDULER_LOG_PREFIX,
  schedulerMessageOf,
  type TimersLike,
  type TokenAcquireRequest,
  type TokenBroker,
  type TokenBrokerGlobalStats,
  type TokenLease,
  type WarnSink,
} from './model-scheduler.types';

export interface UpstreamTokenBrokerOptions {
  dir?: string | null;
  maxTokens?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  now?: () => number;
  timers?: TimersLike | null;
  onWarn?: WarnSink;
  strict?: boolean;
}

export function defaultTokenDir(): string {
  return path.join(os.tmpdir(), DEFAULT_TOKEN_DIR_NAME);
}

export function defaultSchedulerWarn(message: string): void {
  try {
    console.warn(`${MODEL_SCHEDULER_LOG_PREFIX} ${message}`);
  } catch {
    /* 警告失败不影响调度 */
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && ['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', 'EINVAL', 'EBUSY'].includes(code);
}

function unrefTimer<T>(handle: T): T {
  const candidate = handle as { unref?: () => void } | null;
  if (candidate && typeof candidate.unref === 'function') candidate.unref();
  return handle;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface TokenPayload {
  v: number;
  pid: number;
  host: string;
  acquiredAt: number;
  expiresAt: number;
  label: string;
}

export function createUpstreamTokenBroker(options: UpstreamTokenBrokerOptions = {}): TokenBroker {
  const timers = options.timers ?? null;
  const setTimer = typeof timers?.setTimeout === 'function'
    ? (timers.setTimeout as (cb: () => void, ms: number) => unknown)
    : (cb: () => void, ms: number): unknown => setTimeout(cb, ms);
  const clearTimer = typeof timers?.clearTimeout === 'function'
    ? (timers.clearTimeout as (handle: unknown) => void)
    : (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>);
  const setIntervalFn = typeof timers?.setInterval === 'function'
    ? (timers.setInterval as (cb: () => void, ms: number) => unknown)
    : (cb: () => void, ms: number): unknown => setInterval(cb, ms);
  const clearIntervalFn = typeof timers?.clearInterval === 'function'
    ? (timers.clearInterval as (handle: unknown) => void)
    : (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>);

  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const warn = typeof options.onWarn === 'function' ? options.onWarn : defaultSchedulerWarn;
  const dir = typeof options.dir === 'string' && options.dir.trim() ? path.resolve(options.dir.trim()) : defaultTokenDir();
  const maxTokens = Math.min(
    MAX_UPSTREAM_CONCURRENCY,
    Number.isInteger(options.maxTokens) && (options.maxTokens as number) > 0
      ? (options.maxTokens as number)
      : MAX_UPSTREAM_CONCURRENCY,
  );
  const leaseTtlMs = Number.isInteger(options.leaseTtlMs) && (options.leaseTtlMs as number) >= 1000
    ? (options.leaseTtlMs as number)
    : DEFAULT_LEASE_TTL_MS;
  const heartbeatMs = Number.isInteger(options.heartbeatMs) && (options.heartbeatMs as number) >= 100
    ? (options.heartbeatMs as number)
    : Math.max(100, Math.floor(leaseTtlMs / 3));
  const pollMs = Number.isInteger(options.pollMs) && (options.pollMs as number) >= 5
    ? (options.pollMs as number)
    : DEFAULT_TOKEN_POLL_MS;
  const strict = options.strict === true;
  const host = os.hostname();

  const state = {
    held: 0,
    degraded: false,
    reason: null as string | null,
    dirReady: false,
  };

  function tokenPath(index: number): string {
    return path.join(dir, `slot-${index}.token`);
  }

  function markDegraded(reason: string): true {
    if (!state.degraded) {
      state.degraded = true;
      state.reason = reason;
      warn(
        `跨进程模型并发令牌不可用（${reason}），本进程只保留进程内限流；这不再是「全局最多 3」的保证，请修复 ${dir} 的权限或设置 ${ENV_NAMES.tokenDir}。`,
      );
    }
    return true;
  }

  function ensureDir(): boolean {
    if (state.dirReady) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 目录存在但只读时 mkdir 不会报错，必须真写一次才能确认可用。
      const probe = path.join(dir, `.probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(probe, '1', { flag: 'wx' });
      fs.unlinkSync(probe);
      state.dirReady = true;
      return true;
    } catch (error) {
      markDegraded(`${(error as { code?: string }).code ?? 'ERROR'}: ${String((error as Error).message ?? error)}`);
      return false;
    }
  }

  function isOwnerAlive(payload: Record<string, unknown>): boolean | null {
    if (payload.host !== host) return null;
    const pid = Number(payload.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string } | null)?.code === 'EPERM' ? true : false;
    }
  }

  function readTokenPayload(file: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function fileAgeMs(file: string): number {
    try {
      return Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** 过期回收：租约过期且（同机 pid 已死 / 跨机 / 内容不可读且 mtime 超过 TTL）才删。 */
  function reclaimIfStale(file: string): boolean {
    const payload = readTokenPayload(file);
    if (payload) {
      const expiresAt = Number(payload.expiresAt);
      const expired = Number.isFinite(expiresAt) ? expiresAt <= now() : fileAgeMs(file) > leaseTtlMs;
      if (!expired) return false;
      if (isOwnerAlive(payload) === true) return false; // 同机仍活着：不抢别人的令牌
    } else if (fileAgeMs(file) <= leaseTtlMs) {
      return false;
    }
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      return (error as { code?: string } | null)?.code === 'ENOENT';
    }
  }

  function writeTokenPayload(file: string, payload: TokenPayload): void {
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(temp, JSON.stringify(payload), { flag: 'w' });
    fs.renameSync(temp, file);
  }

  function buildPayload(label: string): TokenPayload {
    const stamp = now();
    return {
      v: 1,
      pid: process.pid,
      host,
      acquiredAt: stamp,
      expiresAt: stamp + leaseTtlMs,
      label: typeof label === 'string' ? label.slice(0, 40) : '',
    };
  }

  function releaseToken(index: number): void {
    try {
      fs.unlinkSync(tokenPath(index));
    } catch {
      /* 已被回收或已释放：幂等 */
    }
  }

  function tryTakeIndex(index: number, label: string): TokenLease | null {
    const file = tokenPath(index);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let fd: number | null = null;
      try {
        fd = fs.openSync(file, 'wx');
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') {
          if (reclaimIfStale(file)) continue;
          return null;
        }
        if (isPermissionError(error)) {
          markDegraded(`${(error as { code?: string }).code}: ${String((error as Error).message)}`);
          return null;
        }
        throw error;
      }
      try {
        const payload = buildPayload(label);
        fs.writeFileSync(fd, JSON.stringify(payload));
        fs.closeSync(fd);
        fd = null;
        state.held += 1;
        const heartbeat = unrefTimer(setIntervalFn(() => {
          try {
            writeTokenPayload(file, buildPayload(label));
          } catch {
            /* 心跳失败：租约到期后会被其它进程回收 */
          }
        }, heartbeatMs));
        return {
          index,
          dir,
          degraded: false,
          release(): void {
            clearIntervalFn(heartbeat);
            state.held = Math.max(0, state.held - 1);
            releaseToken(index);
          },
        };
      } catch (error) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* 忽略关闭失败 */
          }
        }
        releaseToken(index);
        if (isPermissionError(error)) {
          markDegraded(`${(error as { code?: string }).code}: ${String((error as Error).message)}`);
          return null;
        }
        throw error;
      }
    }
    return null;
  }

  function degradedToken(): TokenLease {
    state.held += 1;
    return {
      index: null,
      dir,
      degraded: true,
      release(): void {
        state.held = Math.max(0, state.held - 1);
      },
    };
  }

  function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED)));
    }
    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const cleanup = (): void => {
        clearTimer(timer);
        if (signal && onAbort && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const timer = setTimer(() => {
        cleanup();
        resolve();
      }, ms);
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          cleanup();
          reject(new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async function acquire(request: TokenAcquireRequest): Promise<TokenLease> {
    const waitMs = Number.isInteger(request?.waitMs) && request.waitMs >= 0
      ? request.waitMs
      : DEFAULT_QUEUE_TIMEOUT_MS;
    const signal = request?.signal ?? null;
    const label = typeof request?.label === 'string' ? request.label : '';
    const deadlineAt = now() + waitMs;

    if (!ensureDir()) {
      if (strict) {
        throw new ModelSchedulerError(ERROR_CODES.BUSY, schedulerMessageOf(ERROR_CODES.BUSY), {
          reason: 'token-dir-unavailable',
          dir,
          cause: state.reason,
        });
      }
      return degradedToken();
    }

    for (;;) {
      if (signal?.aborted) {
        throw new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED), {
          stage: 'token-wait',
        });
      }
      for (let index = 1; index <= maxTokens; index += 1) {
        const token = tryTakeIndex(index, label);
        if (token) return token;
        if (state.degraded) {
          if (strict) {
            throw new ModelSchedulerError(ERROR_CODES.BUSY, schedulerMessageOf(ERROR_CODES.BUSY), {
              reason: 'token-dir-unavailable',
              dir,
              cause: state.reason,
            });
          }
          return degradedToken();
        }
      }
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        throw new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, schedulerMessageOf(ERROR_CODES.QUEUE_TIMEOUT), {
          stage: 'token-wait',
          waitMs,
          dir,
        });
      }
      await sleep(Math.min(pollMs, remaining), signal);
    }
  }

  function globalStats(): TokenBrokerGlobalStats {
    return {
      dir,
      maxTokens,
      held: state.held,
      available: !state.degraded,
      degraded: state.degraded,
      reason: state.reason,
    };
  }

  return { acquire, globalStats, dir, maxTokens, leaseTtlMs, heartbeatMs };
}
