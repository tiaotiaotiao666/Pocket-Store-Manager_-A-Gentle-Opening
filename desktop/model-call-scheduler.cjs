'use strict';

/**
 * ModelCallScheduler（X12 / E0-R1a，契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §14.6 rev15
 * + Captain amend rev1：跨进程全局令牌）。
 *
 * 唯一职责：把**发往用户 API 的每一次 chat/completions 实际请求**收敛到
 * ① 进程内公平 FIFO 槽位（`maxConcurrent`，1–3）+ ② 跨进程全局令牌（文件锁，池大小恒为 3），
 * 保证「同一时刻在飞的上游请求数 ≤ 3」在单进程与多进程两种拓扑下都成立。
 *
 * 冻结语义（逐条对应 §14.6 / 计划 §4 E0-R1a / amend rev1）：
 * 1. 单一出口：调用方（`desktop/model-credentials.cjs#requestChat`）在**真正的上游调用**外面包一层
 *    `run()`；UI / IPC 层不得再各加一套限流。
 * 2. 上限只允许 1–3：`MODEL_MAX_CONCURRENT` >3 或非法 → clamp 到 3 并发出**可见警告**，绝不静默接受；
 *    任何路径都拿不到 >3（`configure()` 同样如此）。**不读 `AGENT_MAX_CONCURRENT`**：
 *    那是 Nest Agent HTTP 入口门槛，不是上游调用并发。
 * 3. 公平 FIFO 排队；排队超时抛 `MODEL_QUEUE_TIMEOUT`（不是上游超时、不是 429），默认 180s（30–600s 可配）。
 *    排队预算覆盖"本地排队 + 跨进程等令牌"两段。
 * 4. 请求自身 timeout 从**真正开始发上游请求时**计时（本地槽位 → 全局令牌 → task 启动），
 *    排队时间不消耗请求 timeout。
 * 5. 槽位/令牌在 task 的 Promise settle（= 响应体读完 / 明确失败 / 超时 / 取消）之后才释放；
 *    只拿到 HTTP 头不算 settle。
 * 6. 重试必须继续持有同一槽位与令牌：`run()` 一次 = 一个槽位，task 内部想重试多少次都可以，
 *    任何时刻都不会出现第 4 个并发。
 * 7. 取消（`signal`）：排队中 → 出队并 reject `MODEL_ABORTED`（不算已执行）；等令牌中 → 放弃等待；
 *    运行中 → abort 交给 task 的 `signal`，settle 后释放。取消后不再发起上游请求。
 * 8. 可观测性：`stats()` 只有计数与等待时长，**不含 prompt / 源码 / 图片 / Key**。
 *    跨进程令牌状态单独走 `globalStats()`（目录、占用数、降级原因），同样不含用户内容。
 * 9. 进程拓扑：E0 真实模型链只走桌面 direct 单出口；HTTP transport 默认不可用。
 *    跨进程令牌让"HTTP + direct 同时启用"也不会合计超 3，但 E0 期不做该拓扑的功能验收。
 *
 * 全局令牌协议（桌面/服务端共用，供 E0-R1b 对齐；机器可读用例见
 * `test/fixtures/model-scheduler/cases.json`）：
 * - 目录：`MODEL_UPSTREAM_TOKEN_DIR`，默认 `<系统临时目录>/smart-store-model-slots`；
 * - 令牌文件：`slot-<n>.token`（n = 1..3），用 `O_CREAT|O_EXCL` 原子创建 → 天然互斥；
 * - 内容：`{"v":1,"pid","host","acquiredAt","expiresAt","label"}`；心跳每 leaseTtl/3 用
 *   "临时文件 + rename" 续租 `expiresAt`；
 * - 回收：`expiresAt` 已过且（同机 pid 已死，或跨机 / 无法判断）→ unlink 后重试；
 * - 目录不可用（EPERM/EACCES/EROFS…）→ **可见警告 + 可读原因**，`globalStats().degraded=true`，
 *   不静默宣称"已限流"；`strictGlobalTokens:true` 时改为 fail closed（`MODEL_BUSY`）。
 *
 * 纯 CJS、无 Electron 依赖；`now` / `timers` / `onWarn` / `tokenDir` 均可注入，便于可控时钟测试。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 用户 API 允许的上游并发上限：任何配置都不得突破。 */
const MAX_UPSTREAM_CONCURRENCY = 3;
/** 排队超时下限（30s）。 */
const MIN_QUEUE_TIMEOUT_MS = 30000;
/** 排队超时上限（600s）。 */
const MAX_QUEUE_TIMEOUT_MS = 600000;
/** 排队超时默认值（180s）：覆盖一次正常长生成。 */
const DEFAULT_QUEUE_TIMEOUT_MS = 180000;
/** 全局令牌租约默认值与心跳间隔（租约/3）。 */
const DEFAULT_LEASE_TTL_MS = 30000;
/** 等令牌轮询间隔。 */
const DEFAULT_TOKEN_POLL_MS = 40;
/** 令牌目录默认名（系统临时目录下）。 */
const DEFAULT_TOKEN_DIR_NAME = 'smart-store-model-slots';
/** 日志前缀：只用于主进程 stderr，不含用户内容。 */
const LOG_PREFIX = '[model-call-scheduler]';
/** 环境变量主名 / 兼容别名（冻结）。 */
const ENV_NAMES = Object.freeze({
  maxConcurrent: 'MODEL_MAX_CONCURRENT',
  queueWait: 'MODEL_QUEUE_WAIT_MS',
  queueWaitLegacy: 'MODEL_QUEUE_TIMEOUT_MS',
  tokenDir: 'MODEL_UPSTREAM_TOKEN_DIR',
  /** 明确不支持：Agent HTTP 入口门槛，不能替代上游并发调度。 */
  forbiddenAgentEntry: 'AGENT_MAX_CONCURRENT',
});

const ERROR_CODES = Object.freeze({
  QUEUE_TIMEOUT: 'MODEL_QUEUE_TIMEOUT',
  BUSY: 'MODEL_BUSY',
  ABORTED: 'MODEL_ABORTED',
  CONFIG_INVALID: 'MODEL_CONFIG_INVALID',
});

const MESSAGES = Object.freeze({
  MODEL_QUEUE_TIMEOUT: '模型请求排队太久（同一时间最多 3 次），请稍后重试。',
  MODEL_BUSY: '模型请求通道繁忙，请稍后重试。',
  MODEL_ABORTED: '模型请求已取消。',
  MODEL_CONFIG_INVALID: '模型并发配置不合法。',
});

class ModelSchedulerError extends Error {
  constructor(code, message, details) {
    super(message || MESSAGES[code] || '模型调度失败。');
    this.name = 'ModelSchedulerError';
    this.code = code;
    this.details = details || null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(code) {
  return MESSAGES[code] || '模型请求通道暂时不可用。';
}

/** 默认警告出口：写主进程 stderr，保证 clamp / 降级这类事实对运维可见。 */
function defaultWarn(message) {
  try {
    console.warn(`${LOG_PREFIX} ${message}`);
  } catch (error) {
    /* 警告失败不影响调度 */
  }
}

function unrefTimer(handle) {
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

function isPermissionError(error) {
  return Boolean(error) && ['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', 'EINVAL', 'EBUSY'].includes(error.code);
}

/**
 * 规范化并发上限：只有 1–3 会被接受；>3 截断到 3；其余非法值回落 3。两条路径都给可见警告。
 */
function normalizeMaxConcurrent(raw, warn) {
  if (raw === undefined || raw === null || raw === '') return MAX_UPSTREAM_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    warn(`并发上限 ${JSON.stringify(String(raw))} 不合法（只允许 1–${MAX_UPSTREAM_CONCURRENCY} 的整数），已回落为 ${MAX_UPSTREAM_CONCURRENCY}。`);
    return MAX_UPSTREAM_CONCURRENCY;
  }
  if (value > MAX_UPSTREAM_CONCURRENCY) {
    warn(`并发上限 ${value} 超过上游允许的 ${MAX_UPSTREAM_CONCURRENCY}，已 clamp 到 ${MAX_UPSTREAM_CONCURRENCY}。`);
    return MAX_UPSTREAM_CONCURRENCY;
  }
  return value;
}

/** 规范化排队超时：非整数回落默认值；越界 clamp 到 [30s, 600s]，都给可见警告。 */
function normalizeQueueTimeout(raw, warn) {
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

function normalizeRequestTimeout(raw, warn) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    warn(`槽位请求上限 ${JSON.stringify(String(raw))} 不合法（只允许 ≥1000 的整数毫秒），已忽略。`);
    return null;
  }
  return value;
}

/** 排队超时环境变量：主名 `MODEL_QUEUE_WAIT_MS`，`MODEL_QUEUE_TIMEOUT_MS` 仅兼容别名。 */
function readQueueWaitEnv(env, warn) {
  const source = isPlainObject(env) ? env : {};
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
 * 从环境变量解析调度器选项（桌面模块级单例用）。
 * 只读 `MODEL_MAX_CONCURRENT` / `MODEL_QUEUE_WAIT_MS`（+兼容别名）/ `MODEL_UPSTREAM_TOKEN_DIR`；
 * **不读** `AGENT_MAX_CONCURRENT`（那是 Agent HTTP 入口门槛），也不读任何 Key。
 */
function resolveSchedulerOptionsFromEnv(env, options) {
  const source = isPlainObject(env) ? env : {};
  const opts = isPlainObject(options) ? options : {};
  const warn = typeof opts.onWarn === 'function' ? opts.onWarn : defaultWarn;
  const warnings = [];
  const warnOnce = (message) => {
    warnings.push(message);
    warn(message);
  };
  const maxConcurrent = normalizeMaxConcurrent(source[ENV_NAMES.maxConcurrent], warnOnce);
  const queueTimeoutMs = normalizeQueueTimeout(readQueueWaitEnv(source, warnOnce), warnOnce);
  const rawTokenDir = source[ENV_NAMES.tokenDir];
  const tokenDir = typeof rawTokenDir === 'string' && rawTokenDir.trim() ? rawTokenDir.trim() : null;
  return { maxConcurrent, queueTimeoutMs, tokenDir, warnings };
}

/* ------------------------------------------------------------------------------------------- *
 * 跨进程全局令牌（文件锁）
 * ------------------------------------------------------------------------------------------- */

function defaultTokenDir() {
  return path.join(os.tmpdir(), DEFAULT_TOKEN_DIR_NAME);
}

/**
 * 创建跨进程令牌代理。池大小恒为 `MAX_UPSTREAM_CONCURRENCY`（=3），与本地 `maxConcurrent` 解耦：
 * 本地配 1 只是本进程更保守，不会把全局配额改小。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 令牌目录（默认 `MODEL_UPSTREAM_TOKEN_DIR` 或系统临时目录）。
 * @param {number} [options.maxTokens=3] 令牌数（冷冻为 3，>3 会被截断）。
 * @param {number} [options.leaseTtlMs] 租约 TTL（默认 30s）。
 * @param {number} [options.heartbeatMs] 心跳间隔（默认 TTL/3）。
 * @param {number} [options.pollMs] 等令牌轮询间隔（默认 40ms）。
 * @param {() => number} [options.now]
 * @param {{setTimeout:Function,clearTimeout:Function,setInterval:Function,clearInterval:Function}} [options.timers]
 * @param {(message:string)=>void} [options.onWarn]
 * @param {boolean} [options.strict] true = 目录不可用时 fail closed（MODEL_BUSY）。
 */
function createUpstreamTokenBroker(options) {
  const opts = isPlainObject(options) ? options : {};
  const timers = isPlainObject(opts.timers) ? opts.timers : {};
  const setTimer = typeof timers.setTimeout === 'function' ? timers.setTimeout.bind(timers) : setTimeout;
  const clearTimer = typeof timers.clearTimeout === 'function' ? timers.clearTimeout.bind(timers) : clearTimeout;
  const setIntervalFn = typeof timers.setInterval === 'function' ? timers.setInterval.bind(timers) : setInterval;
  const clearIntervalFn = typeof timers.clearInterval === 'function' ? timers.clearInterval.bind(timers) : clearInterval;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const warn = typeof opts.onWarn === 'function' ? opts.onWarn : defaultWarn;
  const dir = typeof opts.dir === 'string' && opts.dir.trim() ? path.resolve(opts.dir.trim()) : defaultTokenDir();
  const maxTokens = Math.min(
    MAX_UPSTREAM_CONCURRENCY,
    Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : MAX_UPSTREAM_CONCURRENCY,
  );
  const leaseTtlMs = Number.isInteger(opts.leaseTtlMs) && opts.leaseTtlMs >= 1000 ? opts.leaseTtlMs : DEFAULT_LEASE_TTL_MS;
  const heartbeatMs = Number.isInteger(opts.heartbeatMs) && opts.heartbeatMs >= 100
    ? opts.heartbeatMs
    : Math.max(100, Math.floor(leaseTtlMs / 3));
  const pollMs = Number.isInteger(opts.pollMs) && opts.pollMs >= 5 ? opts.pollMs : DEFAULT_TOKEN_POLL_MS;
  const strict = opts.strict === true;
  const host = os.hostname();

  const state = {
    held: 0,
    degraded: false,
    reason: null,
    dirReady: false,
    unreadableCount: 0,
  };

  function warnOnce(message) {
    state.warnings.push(message);
    warn(message);
  }
  state.warnings = [];

  function tokenPath(index) {
    return path.join(dir, `slot-${index}.token`);
  }

  function markDegraded(reason) {
    if (!state.degraded) {
      state.degraded = true;
      state.reason = reason;
      warnOnce(`跨进程模型并发令牌不可用（${reason}），本进程只保留进程内限流；这不再是「全局最多 3」的保证，请修复 ${dir} 的权限或设置 ${ENV_NAMES.tokenDir}。`);
    }
    return state.degraded;
  }

  function ensureDir() {
    if (state.dirReady) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 校验可写：目录存在但只读时 mkdir 不会报错，必须真写一次。
      const probe = path.join(dir, `.probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(probe, '1', { flag: 'wx' });
      fs.unlinkSync(probe);
      state.dirReady = true;
      return true;
    } catch (error) {
      markDegraded(`${error.code || 'ERROR'}: ${error.message}`);
      return false;
    }
  }

  function isOwnerAlive(payload) {
    if (!isPlainObject(payload) || payload.host !== host) return null;
    const pid = Number(payload.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM' ? true : false;
    }
  }

  function readTokenPayload(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      return isPlainObject(parsed) ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  function fileAgeMs(file) {
    try {
      return Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
    } catch (error) {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** 过期回收：租约过期且（同机 pid 已死 / 跨机 / 内容不可读且 mtime 超过 TTL）才删。 */
  function reclaimIfStale(file) {
    const payload = readTokenPayload(file);
    if (payload) {
      const expiresAt = Number(payload.expiresAt);
      const expired = Number.isFinite(expiresAt) ? expiresAt <= now() : fileAgeMs(file) > leaseTtlMs;
      if (!expired) return false;
      const alive = isOwnerAlive(payload);
      if (alive === true) return false; // 同机仍活着：不抢别人的令牌
    } else {
      state.unreadableCount += 1;
      if (fileAgeMs(file) <= leaseTtlMs) return false;
    }
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      return error && error.code === 'ENOENT';
    }
  }

  function writeTokenPayload(file, payload) {
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(temp, JSON.stringify(payload), { flag: 'w' });
    fs.renameSync(temp, file);
  }

  function buildPayload(label) {
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

  function releaseToken(index) {
    try {
      fs.unlinkSync(tokenPath(index));
    } catch (error) {
      /* 已被回收或已释放：幂等 */
    }
  }

  /** 在给定索引上尝试原子建令牌；返回 token 或 null。 */
  function tryTakeIndex(index, label) {
    const file = tokenPath(index);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let fd = null;
      try {
        fd = fs.openSync(file, 'wx');
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          if (reclaimIfStale(file)) continue;
          return null;
        }
        if (isPermissionError(error)) {
          markDegraded(`${error.code}: ${error.message}`);
          return null;
        }
        throw error;
      }
      // 抢到文件：先写内容，再起心跳。写失败要立刻清理，避免留下空令牌卡住全局吞吐。
      try {
        const payload = buildPayload(label);
        fs.writeFileSync(fd, JSON.stringify(payload));
        fs.closeSync(fd);
        fd = null;
        state.held += 1;
        const heartbeat = unrefTimer(setIntervalFn(() => {
          try {
            writeTokenPayload(file, buildPayload(label));
          } catch (error) {
            /* 心跳失败：租约到期后会被其它进程回收 */
          }
        }, heartbeatMs));
        return {
          index,
          dir,
          degraded: false,
          release() {
            clearIntervalFn(heartbeat);
            state.held = Math.max(0, state.held - 1);
            releaseToken(index);
          },
        };
      } catch (error) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (closeError) {
            /* 忽略 */
          }
        }
        releaseToken(index);
        if (isPermissionError(error)) {
          markDegraded(`${error.code}: ${error.message}`);
          return null;
        }
        throw error;
      }
    }
    return null;
  }

  function degradedToken() {
    state.held += 1;
    return {
      index: null,
      dir,
      degraded: true,
      release() {
        state.held = Math.max(0, state.held - 1);
      },
    };
  }

  function sleep(ms, signal) {
    if (signal && signal.aborted) return Promise.reject(new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED)));
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const cleanup = () => {
        clearTimer(timer);
        if (signal && onAbort && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimer(() => {
        cleanup();
        resolve();
      }, ms);
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          cleanup();
          reject(new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * 申请一个全局令牌。
   * @param {{waitMs:number, signal?:AbortSignal, label?:string}} request
   * @returns {Promise<{index:number|null, dir:string, degraded:boolean, release:Function}>}
   */
  async function acquire(request) {
    const req = isPlainObject(request) ? request : {};
    const waitMs = Number.isInteger(req.waitMs) && req.waitMs >= 0 ? req.waitMs : DEFAULT_QUEUE_TIMEOUT_MS;
    const signal = req.signal && typeof req.signal === 'object' ? req.signal : null;
    const label = typeof req.label === 'string' ? req.label : '';
    const startedAt = now();
    const deadlineAt = startedAt + waitMs;

    if (!ensureDir()) {
      if (strict) {
        throw new ModelSchedulerError(ERROR_CODES.BUSY, messageOf(ERROR_CODES.BUSY), {
          reason: 'token-dir-unavailable',
          dir,
          cause: state.reason,
        });
      }
      return degradedToken();
    }

    for (;;) {
      if (signal && signal.aborted) {
        throw new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED), { stage: 'token-wait' });
      }
      for (let index = 1; index <= maxTokens; index += 1) {
        const token = tryTakeIndex(index, label);
        if (token) return token;
        if (state.degraded) return strict
          ? (() => { throw new ModelSchedulerError(ERROR_CODES.BUSY, messageOf(ERROR_CODES.BUSY), { reason: 'token-dir-unavailable', dir, cause: state.reason }); })()
          : degradedToken();
      }
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        throw new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, messageOf(ERROR_CODES.QUEUE_TIMEOUT), {
          stage: 'token-wait',
          waitMs,
          dir,
        });
      }
      await sleep(Math.min(pollMs, remaining), signal);
    }
  }

  function globalStats() {
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

/* ------------------------------------------------------------------------------------------- *
 * 调度器
 * ------------------------------------------------------------------------------------------- */

/**
 * 创建调度器。
 *
 * @param {object} [options]
 * @param {number} [options.maxConcurrent=3] 上游并发上限（1–3，>3 截断）。
 * @param {number} [options.queueTimeoutMs=180000] 排队超时（30s–600s）。
 * @param {object} [options.env] 环境变量来源（给了就按冻结主名解析，见 `ENV_NAMES`）。
 * @param {number} [options.requestTimeoutMs] 可选的槽位级硬上限：超时后 abort 交给 task 的 signal。
 * @param {string} [options.tokenDir] 跨进程令牌目录（默认 `MODEL_UPSTREAM_TOKEN_DIR` / 系统临时目录）。
 * @param {boolean} [options.globalTokens=true] false = 关闭跨进程令牌（只用于单进程测试）。
 * @param {object} [options.tokenBroker] 直接注入令牌代理（测试/服务端复用）。
 * @param {boolean} [options.strictGlobalTokens] true = 令牌目录不可用时 fail closed。
 * @param {() => number} [options.now] 时钟（测试注入）。
 * @param {object} [options.timers] 定时器（测试注入）。
 * @param {(message:string)=>void} [options.onWarn] 可见警告出口（默认 `console.warn`）。
 */
function createModelCallScheduler(options) {
  const opts = isPlainObject(options) ? options : {};
  const timers = isPlainObject(opts.timers) ? opts.timers : null;
  const setTimer = timers && typeof timers.setTimeout === 'function' ? timers.setTimeout.bind(timers) : setTimeout;
  const clearTimer = timers && typeof timers.clearTimeout === 'function' ? timers.clearTimeout.bind(timers) : clearTimeout;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const baseWarn = typeof opts.onWarn === 'function' ? opts.onWarn : defaultWarn;

  const warnings = [];
  function warnOnce(message) {
    warnings.push(message);
    baseWarn(message);
  }

  // `env` 注入时按冻结的主名解析（MODEL_QUEUE_TIMEOUT_MS 仅兼容别名）；
  // 显式参数优先，便于测试与服务端复用同一实现。
  const env = isPlainObject(opts.env) ? opts.env : null;
  const rawMaxConcurrent = opts.maxConcurrent !== undefined
    ? opts.maxConcurrent
    : (env ? env[ENV_NAMES.maxConcurrent] : undefined);
  const rawQueueTimeout = opts.queueTimeoutMs !== undefined
    ? opts.queueTimeoutMs
    : (env ? readQueueWaitEnv(env, warnOnce) : undefined);

  let maxConcurrent = normalizeMaxConcurrent(rawMaxConcurrent, warnOnce);
  let queueTimeoutMs = normalizeQueueTimeout(rawQueueTimeout, warnOnce);
  const requestTimeoutMs = normalizeRequestTimeout(opts.requestTimeoutMs, warnOnce);

  let broker = null;
  if (opts.tokenBroker && typeof opts.tokenBroker.acquire === 'function') {
    broker = opts.tokenBroker;
  } else if (opts.globalTokens !== false) {
    const envTokenDir = isPlainObject(opts.env) ? opts.env[ENV_NAMES.tokenDir] : undefined;
    broker = createUpstreamTokenBroker({
      dir: opts.tokenDir || (typeof envTokenDir === 'string' && envTokenDir.trim() ? envTokenDir : undefined),
      maxTokens: MAX_UPSTREAM_CONCURRENCY,
      now: opts.now,
      timers: opts.timers,
      onWarn: warnOnce,
      strict: opts.strictGlobalTokens === true,
      leaseTtlMs: opts.leaseTtlMs,
      heartbeatMs: opts.heartbeatMs,
      pollMs: opts.tokenPollMs,
    });
  }

  const state = {
    active: 0,
    queue: [],
    maxQueueLength: 0,
    totalAcquired: 0,
    totalTimedOut: 0,
    lastWaitMs: 0,
    closed: false,
  };
  let slotSeq = 0;

  function stats() {
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

  function globalStats() {
    if (!broker) {
      return { enabled: false, dir: null, maxTokens: 0, held: 0, available: false, degraded: false, reason: 'disabled' };
    }
    const raw = typeof broker.globalStats === 'function'
      ? broker.globalStats()
      : { dir: broker.dir || null, maxTokens: broker.maxTokens || MAX_UPSTREAM_CONCURRENCY, held: 0, available: true, degraded: false, reason: null };
    return { enabled: true, ...raw };
  }

  function config() {
    return {
      maxConcurrent,
      queueTimeoutMs,
      requestTimeoutMs,
      tokenDir: broker ? (typeof broker.dir === 'string' ? broker.dir : null) : null,
      warnings: warnings.slice(),
    };
  }

  function removeFromQueue(entry) {
    const index = state.queue.indexOf(entry);
    if (index >= 0) state.queue.splice(index, 1);
    return index >= 0;
  }

  function detachAbort(entry) {
    if (entry.onAbort && entry.externalSignal && typeof entry.externalSignal.removeEventListener === 'function') {
      try {
        entry.externalSignal.removeEventListener('abort', entry.onAbort);
      } catch (error) {
        /* 解绑失败不影响结果 */
      }
    }
    entry.onAbort = null;
  }

  function releaseSlotResources(entry) {
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
      } catch (error) {
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

  function finish(entry, error, value) {
    if (entry.settled) return;
    entry.settled = true;
    releaseSlotResources(entry);
    let settledError = error || null;
    const externallyAborted = Boolean(entry.externalSignal && entry.externalSignal.aborted);
    if (externallyAborted && !(settledError && settledError.code === ERROR_CODES.ABORTED)) {
      settledError = new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED), {
        slotId: entry.id,
        waitMs: entry.waitMs,
        cause: settledError && settledError.code ? settledError.code : null,
      });
    }
    if (settledError) entry.reject(settledError);
    else entry.resolve(value);
    drain();
  }

  function onQueueTimeout(entry) {
    if (entry.settled) return;
    entry.waitTimer = null;
    state.totalTimedOut += 1;
    if (!entry.acquired) {
      removeFromQueue(entry);
      finish(entry, new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, messageOf(ERROR_CODES.QUEUE_TIMEOUT), {
        stage: 'local-queue',
        queueTimeoutMs,
        slotId: entry.id,
      }));
      return;
    }
    // 已经在等跨进程令牌：放弃等待并释放本地槽位。
    try {
      entry.slotController.abort();
    } catch (error) {
      /* abort 幂等 */
    }
    finish(entry, new ModelSchedulerError(ERROR_CODES.QUEUE_TIMEOUT, messageOf(ERROR_CODES.QUEUE_TIMEOUT), {
      stage: 'token-wait',
      queueTimeoutMs,
      slotId: entry.id,
    }));
  }

  function taskStart(entry) {
    if (entry.settled) return;
    if (entry.waitTimer) {
      clearTimer(entry.waitTimer);
      entry.waitTimer = null;
    }
    entry.waitMs = Math.max(0, now() - entry.enqueuedAt);
    state.lastWaitMs = entry.waitMs;
    entry.acquiredAt = now();
    // 请求自身 timeout 从「真正开始发上游请求」开始：交给 task（credentials 在自己的计时器里实现）。
    if (requestTimeoutMs) {
      entry.requestTimer = unrefTimer(setTimer(() => {
        entry.requestTimer = null;
        try {
          entry.slotController.abort();
        } catch (error) {
          /* abort 幂等 */
        }
      }, requestTimeoutMs));
    }
    let result;
    try {
      result = entry.task({
        signal: entry.slotController.signal,
        slotId: entry.id,
        waitMs: entry.waitMs,
        acquiredAt: entry.acquiredAt,
      });
    } catch (error) {
      finish(entry, error || new Error('model task threw'));
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(entry, null, value),
      (error) => finish(entry, error || new Error('model task failed')),
    );
  }

  async function acquireTokenThenRun(entry) {
    if (!broker) {
      taskStart(entry);
      return;
    }
    try {
      const token = await broker.acquire({
        waitMs: Math.max(0, queueTimeoutMs - (now() - entry.enqueuedAt)),
        signal: entry.slotController.signal,
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

  function dispatch(entry) {
    if (entry.settled) return;
    entry.acquired = true;
    state.active += 1;
    state.totalAcquired += 1;
    entry.slotController = new AbortController();
    if (entry.externalSignal && entry.externalSignal.aborted) entry.slotController.abort();
    // 排队预算（本地排队 + 等令牌）一直在跑，直到真正发起上游请求才清除。
    if (!entry.waitTimer) {
      entry.waitTimer = unrefTimer(setTimer(() => onQueueTimeout(entry), queueTimeoutMs));
    }
    acquireTokenThenRun(entry);
  }

  function drain() {
    while (!state.closed && state.active < maxConcurrent && state.queue.length > 0) {
      const next = state.queue.shift();
      if (!next || next.settled) continue;
      dispatch(next);
    }
  }

  function onAbort(entry) {
    if (entry.settled) return;
    if (!entry.acquired) {
      // 排队中取消：直接出队，不占槽位、不计入已执行。
      removeFromQueue(entry);
      finish(entry, new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED), {
        slotId: entry.id,
        stage: 'queued',
      }));
      return;
    }
    // 等令牌 / 运行中取消：abort 交给内部 signal（令牌等待或上游 fetch 都会响应），settle 后释放。
    try {
      entry.slotController.abort();
    } catch (error) {
      /* abort 幂等 */
    }
  }

  /**
   * 申请一个槽位并在槽位内执行 `task`。
   *
   * @param {(slot:{signal:AbortSignal, slotId:string, waitMs:number, acquiredAt:number}) => Promise<any>} task
   * @param {{signal?:AbortSignal, label?:string}} [runOptions]
   */
  function run(task, runOptions) {
    const runOpts = isPlainObject(runOptions) ? runOptions : {};
    if (typeof task !== 'function') {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, messageOf(ERROR_CODES.CONFIG_INVALID), {
        reason: 'task-not-function',
      }));
    }
    if (state.closed) {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.BUSY, messageOf(ERROR_CODES.BUSY), { reason: 'closed' }));
    }
    const externalSignal = runOpts.signal && typeof runOpts.signal === 'object' ? runOpts.signal : null;
    if (externalSignal && externalSignal.aborted) {
      return Promise.reject(new ModelSchedulerError(ERROR_CODES.ABORTED, messageOf(ERROR_CODES.ABORTED), {
        stage: 'before-queue',
      }));
    }
    return new Promise((resolve, reject) => {
      slotSeq += 1;
      const entry = {
        id: `slot-${slotSeq}`,
        label: typeof runOpts.label === 'string' ? runOpts.label.slice(0, 40) : '',
        task,
        externalSignal,
        resolve,
        reject,
        enqueuedAt: now(),
        acquired: false,
        settled: false,
        waitMs: 0,
        acquiredAt: 0,
        waitTimer: null,
        requestTimer: null,
        slotController: null,
        token: null,
        onAbort: null,
      };
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        entry.onAbort = () => onAbort(entry);
        externalSignal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (state.active < maxConcurrent && state.queue.length === 0) {
        dispatch(entry);
        return;
      }
      state.queue.push(entry);
      state.maxQueueLength = Math.max(state.maxQueueLength, state.queue.length);
      if (!entry.waitTimer) {
        entry.waitTimer = unrefTimer(setTimer(() => onQueueTimeout(entry), queueTimeoutMs));
      }
    });
  }

  /** 只在 1–3 内调整；>3 截断 + 警告，非整数抛 MODEL_CONFIG_INVALID。 */
  function configure(patch) {
    if (!isPlainObject(patch)) {
      throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, messageOf(ERROR_CODES.CONFIG_INVALID), {
        reason: 'patch-not-object',
      });
    }
    if (patch.maxConcurrent !== undefined) {
      const value = Number(patch.maxConcurrent);
      if (!Number.isInteger(value) || value < 1) {
        throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, messageOf(ERROR_CODES.CONFIG_INVALID), {
          reason: 'maxConcurrent-invalid',
          value: patch.maxConcurrent,
        });
      }
      maxConcurrent = normalizeMaxConcurrent(value, warnOnce);
    }
    if (patch.queueTimeoutMs !== undefined) {
      const value = Number(patch.queueTimeoutMs);
      if (!Number.isInteger(value)) {
        throw new ModelSchedulerError(ERROR_CODES.CONFIG_INVALID, messageOf(ERROR_CODES.CONFIG_INVALID), {
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
  function close() {
    state.closed = true;
    const pending = state.queue.slice();
    state.queue.length = 0;
    pending.forEach((entry) => {
      finish(entry, new ModelSchedulerError(ERROR_CODES.BUSY, messageOf(ERROR_CODES.BUSY), {
        reason: 'closed',
        slotId: entry.id,
      }));
    });
    return stats();
  }

  return { run, stats, configure, config, close, globalStats };
}

module.exports = {
  createModelCallScheduler,
  createUpstreamTokenBroker,
  resolveSchedulerOptionsFromEnv,
  normalizeMaxConcurrent,
  normalizeQueueTimeout,
  ModelSchedulerError,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  MAX_QUEUE_TIMEOUT_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  // amend rev1 的 env 主名是 MODEL_QUEUE_WAIT_MS，常量别名一并导出，避免两侧命名漂移。
  DEFAULT_QUEUE_WAIT_MS: DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_TOKEN_DIR_NAME,
  ENV_NAMES,
  ERROR_CODES,
};
