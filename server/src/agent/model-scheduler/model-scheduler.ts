/**
 * ModelCallScheduler（服务端 / E0-R1b）。
 *
 * 与桌面 `desktop/model-call-scheduler.cjs` **同语义**（rev15 §14.6 / §14.6.1）：
 * 1. 单一出口：每一次真正发往 `/chat/completions` 的请求都在 `run()` 里执行；
 * 2. 上限只允许 1–3：`MODEL_MAX_CONCURRENT` >3 或非法 → clamp 到 3 + **可见警告**；
 *    **不读 `AGENT_MAX_CONCURRENT`**（那是 Agent HTTP 入口门槛）；
 * 3. 公平 FIFO；排队超时抛 `MODEL_QUEUE_TIMEOUT`（不是上游超时、不是 429），默认 180s（30–600s）；
 * 4. 请求自身 timeout 从**真正开始发上游请求时**计时（排队不消耗请求 timeout）；
 * 5. 槽位/令牌在 task settle（响应体读完 / 明确失败 / 超时 / 取消）之后才释放；
 * 6. 一次 `run()` = 一个槽位 + 一个令牌：task 内部重试不会产生第 4 个并发；
 * 7. 取消：排队中 → 出队 + `MODEL_ABORTED`（不计入已执行）；等令牌 → 放弃；运行中 → abort 交给 task；
 * 8. 可观测性：`stats()` 只有计数与等待时长；`globalStats()` 只有目录/占用/降级原因。
 */

import {
  DEFAULT_QUEUE_TIMEOUT_MS,
  ENV_NAMES,
  ERROR_CODES,
  MAX_QUEUE_TIMEOUT_MS,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  ModelSchedulerError,
  schedulerMessageOf,
  type EnvSource,
  type GlobalTokenStats,
  type ModelCallScheduler,
  type ModelCallSchedulerOptions,
  type ResolvedSchedulerOptions,
  type RunOptions,
  type ScheduledTask,
  type SchedulerConfigView,
  type SchedulerStats,
  type TokenBroker,
  type TokenLease,
  type WarnSink,
} from './model-scheduler.types';
import { createUpstreamTokenBroker, defaultSchedulerWarn } from './upstream-token-broker';
import { ensureUpstreamFetchGuard, runInsideSlot } from './scheduled-fetch';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unrefTimer<T>(handle: T): T {
  const candidate = handle as { unref?: () => void } | null;
  if (candidate && typeof candidate.unref === 'function') candidate.unref();
  return handle;
}

/** 规范化并发上限：只有 1–3 会被接受；>3 截断到 3；其余非法值回落 3。两条路径都给可见警告。 */
export function normalizeMaxConcurrent(raw: unknown, warn: WarnSink): number {
  if (raw === undefined || raw === null || raw === '') return MAX_UPSTREAM_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    warn(
      `并发上限 ${JSON.stringify(String(raw))} 不合法（只允许 1–${MAX_UPSTREAM_CONCURRENCY} 的整数），已回落为 ${MAX_UPSTREAM_CONCURRENCY}。`,
    );
    return MAX_UPSTREAM_CONCURRENCY;
  }
  if (value > MAX_UPSTREAM_CONCURRENCY) {
    warn(`并发上限 ${value} 超过上游允许的 ${MAX_UPSTREAM_CONCURRENCY}，已 clamp 到 ${MAX_UPSTREAM_CONCURRENCY}。`);
    return MAX_UPSTREAM_CONCURRENCY;
  }
  return value;
}

/** 规范化排队超时：非整数回落默认值；越界 clamp 到 [30s, 600s]，都给可见警告。 */
export function normalizeQueueTimeout(raw: unknown, warn: WarnSink): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_QUEUE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    warn(`排队超时 ${JSON.stringify(String(raw))} 不合法（只允许整数毫秒），已回落为 ${DEFAULT_QUEUE_TIMEOUT_MS}ms。`);
    return DEFAULT_QUEUE_TIMEOUT_MS;
  }
  if (value < MIN_QUEUE_TIMEOUT_MS) {
    warn(`排队超时 ${value}ms 小于下限，已 clamp 到 ${MIN_QUEUE_TIMEOUT_MS}ms。`);
    return MIN_QUEUE_TIMEOUT_MS;
  }
  if (value > MAX_QUEUE_TIMEOUT_MS) {
    warn(`排队超时 ${value}ms 大于上限，已 clamp 到 ${MAX_QUEUE_TIMEOUT_MS}ms。`);
    return MAX_QUEUE_TIMEOUT_MS;
  }
  return value;
}

function normalizeRequestTimeout(raw: unknown, warn: WarnSink): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    warn(`槽位请求上限 ${JSON.stringify(String(raw))} 不合法（只允许 ≥1000 的整数毫秒），已忽略。`);
    return null;
  }
  return value;
}

/** 排队超时环境变量：主名 `MODEL_QUEUE_WAIT_MS`，`MODEL_QUEUE_TIMEOUT_MS` 仅兼容别名。 */
function readQueueWaitEnv(env: EnvSource | null | undefined, warn: WarnSink): string | undefined {
  const source = isPlainObject(env) ? (env as EnvSource) : {};
  const primary = source[ENV_NAMES.queueWait];
  if (primary !== undefined && primary !== '') return primary;
  const legacy = source[ENV_NAMES.queueWaitLegacy];
  if (legacy !== undefined && legacy !== '') {
    warn(`${ENV_NAMES.queueWaitLegacy} 是兼容别名，请改用 ${ENV_NAMES.queueWait}。`);
    return legacy;
  }
  return undefined;
}

/**
 * 从环境变量解析调度器选项。
 * 只读 `MODEL_MAX_CONCURRENT` / `MODEL_QUEUE_WAIT_MS`（+兼容别名）/ `MODEL_UPSTREAM_TOKEN_DIR`；
 * **不读** `AGENT_MAX_CONCURRENT`，也不读任何 Key。
 */
export function resolveSchedulerOptionsFromEnv(
  env?: EnvSource | null,
  options?: { onWarn?: WarnSink },
): ResolvedSchedulerOptions {
  const source = isPlainObject(env) ? (env as EnvSource) : {};
  const warn = typeof options?.onWarn === 'function' ? options.onWarn : defaultSchedulerWarn;
  const warnings: string[] = [];
  const warnOnce = (message: string): void => {
    warnings.push(message);
    warn(message);
  };
  const maxConcurrent = normalizeMaxConcurrent(source[ENV_NAMES.maxConcurrent], warnOnce);
  const queueTimeoutMs = normalizeQueueTimeout(readQueueWaitEnv(source, warnOnce), warnOnce);
  const rawTokenDir = source[ENV_NAMES.tokenDir];
  const tokenDir = typeof rawTokenDir === 'string' && rawTokenDir.trim() ? rawTokenDir.trim() : null;
  return { maxConcurrent, queueTimeoutMs, tokenDir, warnings };
}

interface SlotEntry<T = unknown> {
  id: string;
  label: string;
  task: ScheduledTask<T>;
  externalSignal: AbortSignal | null;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  acquired: boolean;
  settled: boolean;
  waitMs: number;
  acquiredAt: number;
  waitTimer: unknown;
  requestTimer: unknown;
  controller: AbortController | null;
  token: TokenLease | null;
  onAbort: (() => void) | null;
}

export function createModelCallScheduler(options: ModelCallSchedulerOptions = {}): ModelCallScheduler {
  const timers = options.timers ?? null;
  const setTimer = typeof timers?.setTimeout === 'function'
    ? (timers.setTimeout as (cb: () => void, ms: number) => unknown)
    : (cb: () => void, ms: number): unknown => setTimeout(cb, ms);
  const clearTimer = typeof timers?.clearTimeout === 'function'
    ? (timers.clearTimeout as (handle: unknown) => void)
    : (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const baseWarn = typeof options.onWarn === 'function' ? options.onWarn : defaultSchedulerWarn;

  const warnings: string[] = [];
  const warnOnce = (message: string): void => {
    warnings.push(message);
    baseWarn(message);
  };

  const env = isPlainObject(options.env) ? (options.env as EnvSource) : null;
  const rawMaxConcurrent = options.maxConcurrent !== undefined
    ? options.maxConcurrent
    : (env ? env[ENV_NAMES.maxConcurrent] : undefined);
  const rawQueueTimeout = options.queueTimeoutMs !== undefined
    ? options.queueTimeoutMs
    : (env ? readQueueWaitEnv(env, warnOnce) : undefined);

  let maxConcurrent = normalizeMaxConcurrent(rawMaxConcurrent, warnOnce);
  let queueTimeoutMs = normalizeQueueTimeout(rawQueueTimeout, warnOnce);
  const requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs, warnOnce);

  let broker: TokenBroker | null = null;
  if (options.tokenBroker && typeof options.tokenBroker.acquire === 'function') {
    broker = options.tokenBroker;
  } else if (options.globalTokens !== false) {
    const envTokenDir = env ? env[ENV_NAMES.tokenDir] : undefined;
    broker = createUpstreamTokenBroker({
      dir: options.tokenDir ?? (typeof envTokenDir === 'string' && envTokenDir.trim() ? envTokenDir : undefined),
      maxTokens: MAX_UPSTREAM_CONCURRENCY,
      now: options.now,
      timers: options.timers,
      onWarn: warnOnce,
      strict: options.strictGlobalTokens === true,
      leaseTtlMs: options.leaseTtlMs,
      heartbeatMs: options.heartbeatMs,
      pollMs: options.tokenPollMs,
    });
  }

  const state = {
    active: 0,
    queue: [] as SlotEntry[],
    maxQueueLength: 0,
    totalAcquired: 0,
    totalTimedOut: 0,
    lastWaitMs: 0,
    closed: false,
  };
  let slotSeq = 0;

  function stats(): SchedulerStats {
    return {
      maxConcurrent,
      active: state.active,
      queued: state.queue.length,
      maxQueueLength: state.maxQueueLength,
      totalAcquired: state.totalAcquired,
      totalTimedOut: state.totalTimedOut,
      lastWaitMs: state.lastWaitMs,
    };
  }

  function globalStats(): GlobalTokenStats {
    if (!broker) {
      return {
        enabled: false,
        dir: null,
        maxTokens: 0,
        held: 0,
        available: false,
        degraded: false,
        reason: 'disabled',
      };
    }
    const raw = typeof broker.globalStats === 'function' ? broker.globalStats() : null;
    if (!raw) {
      return {
        enabled: true,
        dir: broker.dir ?? null,
        maxTokens: broker.maxTokens ?? MAX_UPSTREAM_CONCURRENCY,
        held: 0,
        available: true,
        degraded: false,
        reason: null,
      };
    }
    return { enabled: true, ...raw };
  }

  function config(): SchedulerConfigView {
    return {
      maxConcurrent,
      queueTimeoutMs,
      requestTimeoutMs,
      tokenDir: broker && typeof broker.dir === 'string' ? broker.dir : null,
      warnings: warnings.slice(),
    };
  }

  function removeFromQueue(entry: SlotEntry): boolean {
    const index = state.queue.indexOf(entry);
    if (index >= 0) state.queue.splice(index, 1);
    return index >= 0;
  }

  function detachAbort(entry: SlotEntry): void {
    if (entry.onAbort && entry.externalSignal && typeof entry.externalSignal.removeEventListener === 'function') {
      try {
        entry.externalSignal.removeEventListener('abort', entry.onAbort);
      } catch {
        /* 解绑失败不影响结果 */
      }
    }
    entry.onAbort = null;
  }

  function releaseSlotResources(entry: SlotEntry): void {
    if (entry.waitTimer) {
      clearTimer(entry.waitTimer);
      entry.waitTimer = null;
    }
    if (entry.requestTimer) {
      clearTimer(entry.requestTimer);
      entry.requestTimer = null;
    }
    if (entry.token && typeof entry.token.release === 'function') {
      try {
        entry.token.release();
      } catch {
        /* 释放失败不影响结果 */
      }
      entry.token = null;
    }
    detachAbort(entry);
    if (entry.acquired) {
      state.active -= 1;
      entry.acquired = false;
    }
  }

  function finish<T>(entry: SlotEntry<T>, error?: unknown, value?: T): void {
    if (entry.settled) return;
    entry.settled = true;
    releaseSlotResources(entry as SlotEntry);
    let settledError = error ?? null;
    const externallyAborted = Boolean(entry.externalSignal?.aborted);
    const code = (settledError as { code?: string } | null)?.code;
    if (externallyAborted && code !== ERROR_CODES.ABORTED) {
      settledError = new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED), {
        slotId: entry.id,
        waitMs: entry.waitMs,
        cause: typeof code === 'string' ? code : null,
      });
    }
    if (settledError) entry.reject(settledError);
    else entry.resolve(value as T);
    drain();
  }

  function onQueueTimeout(entry: SlotEntry): void {
    if (entry.settled) return;
    entry.waitTimer = null;
    state.totalTimedOut += 1;
    if (!entry.acquired) {
      removeFromQueue(entry);
      finish(entry, new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, schedulerMessageOf(ERROR_CODES.QUEUE_TIMEOUT), {
        stage: 'local-queue',
        queueTimeoutMs,
        slotId: entry.id,
      }));
      return;
    }
    // 已经在等跨进程令牌：放弃等待并释放本地槽位。
    try {
      entry.controller?.abort();
    } catch {
      /* abort 幂等 */
    }
    finish(entry, new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, schedulerMessageOf(ERROR_CODES.QUEUE_TIMEOUT), {
      stage: 'token-wait',
      queueTimeoutMs,
      slotId: entry.id,
    }));
  }

  function taskStart(entry: SlotEntry): void {
    if (entry.settled) return;
    if (entry.waitTimer) {
      clearTimer(entry.waitTimer);
      entry.waitTimer = null;
    }
    entry.waitMs = Math.max(0, now() - entry.enqueuedAt);
    state.lastWaitMs = entry.waitMs;
    entry.acquiredAt = now();
    // 请求自身 timeout 从「真正开始发上游请求」开始；调用方也可用自己的计时器。
    if (requestTimeoutMs) {
      entry.requestTimer = unrefTimer(setTimer(() => {
        entry.requestTimer = null;
        try {
          entry.controller?.abort();
        } catch {
          /* abort 幂等 */
        }
      }, requestTimeoutMs));
    }
    let result: Promise<unknown> | unknown;
    try {
      // 标记「已经在槽位内」：适配器里再包一层 createScheduledFetch / 全局 fetch 兜底时
      // 必须透传，否则同一个请求会二次排队（3 个外层槽位被自己占满 → 死锁）。
      result = runInsideSlot(() => entry.task({
        signal: (entry.controller as AbortController).signal,
        slotId: entry.id,
        waitMs: entry.waitMs,
        acquiredAt: entry.acquiredAt,
      }));
    } catch (error) {
      finish(entry, error || new Error('model task threw'));
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(entry, null, value),
      (error) => finish(entry, error || new Error('model task failed')),
    );
  }

  async function acquireTokenThenRun(entry: SlotEntry): Promise<void> {
    if (!broker) {
      taskStart(entry);
      return;
    }
    try {
      const token = await broker.acquire({
        waitMs: Math.max(0, queueTimeoutMs - (now() - entry.enqueuedAt)),
        signal: entry.controller?.signal ?? null,
        label: entry.label,
      });
      if (entry.settled) {
        if (typeof token.release === 'function') token.release();
        return;
      }
      entry.token = token;
      taskStart(entry);
    } catch (error) {
      finish(entry, error);
    }
  }

  function dispatch(entry: SlotEntry): void {
    if (entry.settled) return;
    entry.acquired = true;
    state.active += 1;
    state.totalAcquired += 1;
    entry.controller = new AbortController();
    if (entry.externalSignal?.aborted) entry.controller.abort();
    // 排队预算（本地排队 + 等令牌）一直在跑，直到真正发起上游请求才清除。
    if (!entry.waitTimer) {
      entry.waitTimer = unrefTimer(setTimer(() => onQueueTimeout(entry), queueTimeoutMs));
    }
    void acquireTokenThenRun(entry);
  }

  function drain(): void {
    while (!state.closed && state.active < maxConcurrent && state.queue.length > 0) {
      const next = state.queue.shift();
      if (!next || next.settled) continue;
      dispatch(next);
    }
  }

  function onAbort(entry: SlotEntry): void {
    if (entry.settled) return;
    if (!entry.acquired) {
      // 排队中取消：直接出队，不占槽位、不计入已执行。
      removeFromQueue(entry);
      finish(entry, new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED), {
        slotId: entry.id,
        stage: 'queued',
      }));
      return;
    }
    // 等令牌 / 运行中取消：abort 交给内部 signal，settle 后释放。
    try {
      entry.controller?.abort();
    } catch {
      /* abort 幂等 */
    }
  }

  function run<T>(task: ScheduledTask<T>, runOptions?: RunOptions): Promise<T> {
    if (typeof task !== 'function') {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, schedulerMessageOf(ERROR_CODES.CONFIG_INVALID), {
        reason: 'task-not-function',
      }));
    }
    if (state.closed) {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.BUSY, schedulerMessageOf(ERROR_CODES.BUSY), {
        reason: 'closed',
      }));
    }
    const externalSignal = runOptions?.signal && typeof runOptions.signal === 'object' ? runOptions.signal : null;
    if (externalSignal?.aborted) {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.ABORTED, schedulerMessageOf(ERROR_CODES.ABORTED), {
        stage: 'before-queue',
      }));
    }
    return new Promise<T>((resolve, reject) => {
      slotSeq += 1;
      const entry: SlotEntry<T> = {
        id: `slot-${slotSeq}`,
        label: typeof runOptions?.label === 'string' ? runOptions.label.slice(0, 40) : '',
        task,
        externalSignal,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: now(),
        acquired: false,
        settled: false,
        waitMs: 0,
        acquiredAt: 0,
        waitTimer: null,
        requestTimer: null,
        controller: null,
        token: null,
        onAbort: null,
      };
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        entry.onAbort = () => onAbort(entry as SlotEntry);
        externalSignal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (state.active < maxConcurrent && state.queue.length === 0) {
        dispatch(entry as SlotEntry);
        return;
      }
      state.queue.push(entry as SlotEntry);
      state.maxQueueLength = Math.max(state.maxQueueLength, state.queue.length);
      if (!entry.waitTimer) {
        entry.waitTimer = unrefTimer(setTimer(() => onQueueTimeout(entry as SlotEntry), queueTimeoutMs));
      }
    });
  }

  /** 只在 1–3 内调整；>3 截断 + 警告，非整数抛 MODEL_CONFIG_INVALID。 */
  function configure(patch: { maxConcurrent?: number; queueTimeoutMs?: number }): SchedulerConfigView {
    if (!isPlainObject(patch)) {
      throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, schedulerMessageOf(ERROR_CODES.CONFIG_INVALID), {
        reason: 'patch-not-object',
      });
    }
    if (patch.maxConcurrent !== undefined) {
      const value = Number(patch.maxConcurrent);
      if (!Number.isInteger(value) || value < 1) {
        throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, schedulerMessageOf(ERROR_CODES.CONFIG_INVALID), {
          reason: 'maxConcurrent-invalid',
          value: patch.maxConcurrent,
        });
      }
      maxConcurrent = normalizeMaxConcurrent(value, warnOnce);
    }
    if (patch.queueTimeoutMs !== undefined) {
      const value = Number(patch.queueTimeoutMs);
      if (!Number.isInteger(value)) {
        throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, schedulerMessageOf(ERROR_CODES.CONFIG_INVALID), {
          reason: 'queueTimeoutMs-invalid',
          value: patch.queueTimeoutMs,
        });
      }
      queueTimeoutMs = normalizeQueueTimeout(value, warnOnce);
    }
    drain();
    return config();
  }

  /** 关闭调度器：排队项立即以 MODEL_BUSY 结束；运行中的 task 不被打断。 */
  function close(): SchedulerStats {
    state.closed = true;
    const pending = state.queue.slice();
    state.queue.length = 0;
    pending.forEach((entry) => {
      finish(entry, new ModelSchedulerError(ERROR_CODES.BUSY, schedulerMessageOf(ERROR_CODES.BUSY), {
        reason: 'closed',
        slotId: entry.id,
      }));
    });
    return stats();
  }

  return { run, stats, configure, config, close, globalStats };
}

/* ------------------------------------------------------------------------------------------- *
 * 进程级单例（Nest 进程共用一套配额）
 * ------------------------------------------------------------------------------------------- */

let sharedScheduler: ModelCallScheduler | null = null;

export interface SharedSchedulerOptions {
  env?: EnvSource | null;
  onWarn?: WarnSink;
  /** 测试可覆盖（默认读进程环境变量）。 */
  overrides?: Partial<ModelCallSchedulerOptions>;
}

/**
 * 取进程级共享调度器（首次调用创建）。
 *
 * 服务端默认 `strictGlobalTokens: true`：跨进程令牌目录不可用时**禁用 HTTP 真实生成通道**
 * 并给出可读原因（fail closed），不会静默退回「各算 3」。
 */
export function getSharedModelCallScheduler(options: SharedSchedulerOptions = {}): ModelCallScheduler {
  if (sharedScheduler) return sharedScheduler;
  const env = options.env ?? (process.env as EnvSource);
  const scheduler = createModelCallScheduler({
    env,
    onWarn: options.onWarn ?? defaultSchedulerWarn,
    strictGlobalTokens: true,
    ...(options.overrides ?? {}),
  });
  sharedScheduler = scheduler;
  // 进程级兜底：任何未显式接线的 /chat/completions 调用也走同一套限流（无第二条出口）。
  ensureUpstreamFetchGuard(scheduler);
  return scheduler;
}

/** 测试用：丢弃共享单例（不影响已发出的请求）。 */
export function resetSharedModelCallScheduler(): void {
  sharedScheduler = null;
}

export function peekSharedModelCallScheduler(): ModelCallScheduler | null {
  return sharedScheduler;
}
