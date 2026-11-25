/**
 * ModelCallScheduler（服务端 / E0-R1b，契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` §14.6 rev15 + §14.6.1）
 *
 * 与桌面 `desktop/model-call-scheduler.cjs`（E0-R1a）**同一套语义、同一套跨进程令牌协议**：
 * ① 进程内公平 FIFO 槽位（1–3）；② 跨进程全局令牌（文件锁，池大小恒为 3）。
 * 两侧共用行为用例：`test/fixtures/model-scheduler/cases.json`（本模块的 parity 测试直接读它）。
 *
 * 类型与冻结常量集中在这里，避免服务端出现第二份同义常量。
 */

/** 用户 API 允许的上游并发上限：任何配置都不得突破。 */
export const MAX_UPSTREAM_CONCURRENCY = 3;
/** 排队超时下限（30s）。 */
export const MIN_QUEUE_TIMEOUT_MS = 30_000;
/** 排队超时上限（600s）。 */
export const MAX_QUEUE_TIMEOUT_MS = 600_000;
/** 排队超时默认值（180s）。 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 180_000;
/** 跨进程令牌租约默认值与心跳间隔（租约/3）。 */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** 等令牌轮询间隔。 */
export const DEFAULT_TOKEN_POLL_MS = 40;
/** 令牌目录默认名（系统临时目录下）。 */
export const DEFAULT_TOKEN_DIR_NAME = 'smart-store-model-slots';
/** 日志前缀：只含计数与原因，不含 prompt/Key/图片。 */
export const MODEL_SCHEDULER_LOG_PREFIX = '[model-scheduler]';

/**
 * 环境变量主名 / 兼容别名（与桌面冻结一致）。
 * `AGENT_MAX_CONCURRENT` 明确**不读**：那是 Agent HTTP 入口门槛，不是上游调用并发。
 */
export const ENV_NAMES = {
  maxConcurrent: 'MODEL_MAX_CONCURRENT',
  queueWait: 'MODEL_QUEUE_WAIT_MS',
  queueWaitLegacy: 'MODEL_QUEUE_TIMEOUT_MS',
  tokenDir: 'MODEL_UPSTREAM_TOKEN_DIR',
  forbiddenAgentEntry: 'AGENT_MAX_CONCURRENT',
} as const;

export const ERROR_CODES = {
  QUEUE_TIMEOUT: 'MODEL_QUEUE_TIMEOUT',
  BUSY: 'MODEL_BUSY',
  ABORTED: 'MODEL_ABORTED',
  CONFIG_INVALID: 'MODEL_CONFIG_INVALID',
} as const;

export type ModelSchedulerErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const MESSAGES: Readonly<Record<ModelSchedulerErrorCode, string>> = Object.freeze({
  MODEL_QUEUE_TIMEOUT: '模型请求排队太久（同一时间最多 3 次），请稍后重试。',
  MODEL_BUSY: '模型请求通道繁忙，请稍后重试。',
  MODEL_ABORTED: '模型请求已取消。',
  MODEL_CONFIG_INVALID: '模型并发配置不合法。',
});

export function schedulerMessageOf(code: ModelSchedulerErrorCode): string {
  return MESSAGES[code] ?? '模型请求通道暂时不可用。';
}

export interface ModelSchedulerErrorDetails {
  stage?: string;
  slotId?: string | null;
  waitMs?: number;
  queueTimeoutMs?: number;
  dir?: string;
  reason?: string;
  cause?: string | null;
  value?: unknown;
}

/** 调度器错误：错误码冻结（MODEL_QUEUE_TIMEOUT / MODEL_BUSY / MODEL_ABORTED / MODEL_CONFIG_INVALID）。 */
export class ModelSchedulerError extends Error {
  readonly code: ModelSchedulerErrorCode;

  readonly details: ModelSchedulerErrorDetails | null;

  constructor(
    code: ModelSchedulerErrorCode,
    message?: string,
    details?: ModelSchedulerErrorDetails | null,
  ) {
    super(message && message.trim() ? message : schedulerMessageOf(code));
    this.name = 'ModelSchedulerError';
    this.code = code;
    this.details = details ?? null;
  }
}

export function isModelSchedulerError(value: unknown): value is ModelSchedulerError {
  return value instanceof ModelSchedulerError;
}

/** 槽位内可见的调用上下文（与桌面 `run()` 的 task 参数一致）。 */
export interface ScheduleSlot {
  signal: AbortSignal;
  slotId: string;
  waitMs: number;
  acquiredAt: number;
}

export interface ScheduledTask<T> {
  (slot: ScheduleSlot): Promise<T> | T;
}

export interface RunOptions {
  signal?: AbortSignal | null;
  label?: string;
}

/** 运维可见统计：只有计数与等待时长，**不含** prompt / 源码 / 图片 / Key。 */
export interface SchedulerStats {
  maxConcurrent: number;
  active: number;
  queued: number;
  maxQueueLength: number;
  totalAcquired: number;
  totalTimedOut: number;
  lastWaitMs: number;
}

/** 跨进程令牌状态：只有目录、占用数与降级原因。 */
export interface GlobalTokenStats {
  enabled: boolean;
  dir: string | null;
  maxTokens: number;
  held: number;
  available: boolean;
  degraded: boolean;
  reason: string | null;
}

export interface SchedulerConfigView {
  maxConcurrent: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number | null;
  tokenDir: string | null;
  warnings: string[];
}

export interface TokenLease {
  index: number | null;
  dir: string;
  degraded: boolean;
  release(): void;
}

export interface TokenAcquireRequest {
  waitMs: number;
  signal?: AbortSignal | null;
  label?: string;
}

export interface TokenBrokerGlobalStats {
  dir: string;
  maxTokens: number;
  held: number;
  available: boolean;
  degraded: boolean;
  reason: string | null;
}

export interface TokenBroker {
  readonly dir: string;
  readonly maxTokens: number;
  readonly leaseTtlMs: number;
  readonly heartbeatMs: number;
  acquire(request: TokenAcquireRequest): Promise<TokenLease>;
  globalStats(): TokenBrokerGlobalStats;
}

/** 可注入定时器（测试用可控时钟）。 */
export interface TimersLike {
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type WarnSink = (message: string) => void;
export type EnvSource = Record<string, string | undefined>;

export interface ModelCallSchedulerOptions {
  /** 上游并发上限：只允许 1–3，>3 截断 + 警告。 */
  maxConcurrent?: number | string;
  /** 排队预算（本地排队 + 等令牌），默认 180s，只允许 30s–600s。 */
  queueTimeoutMs?: number | string;
  /** 环境变量来源（给了就按冻结主名解析，见 `ENV_NAMES`）。 */
  env?: EnvSource | null;
  /** 槽位级硬上限：超时后 abort 交给 task 的 signal。 */
  requestTimeoutMs?: number | string;
  /** 跨进程令牌目录（默认 `MODEL_UPSTREAM_TOKEN_DIR` 或系统临时目录）。 */
  tokenDir?: string | null;
  /** false = 关闭跨进程令牌（只用于单进程测试）。 */
  globalTokens?: boolean;
  /** 直接注入令牌代理（测试用）。 */
  tokenBroker?: TokenBroker | null;
  /** true = 令牌目录不可用时 fail closed（MODEL_BUSY）；服务端单例默认开启。 */
  strictGlobalTokens?: boolean;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  tokenPollMs?: number;
  now?: () => number;
  timers?: TimersLike | null;
  onWarn?: WarnSink;
}

export interface ModelCallScheduler {
  run<T>(task: ScheduledTask<T>, options?: RunOptions): Promise<T>;
  stats(): SchedulerStats;
  globalStats(): GlobalTokenStats;
  configure(patch: { maxConcurrent?: number; queueTimeoutMs?: number }): SchedulerConfigView;
  config(): SchedulerConfigView;
  close(): SchedulerStats;
}

export interface ResolvedSchedulerOptions {
  maxConcurrent: number;
  queueTimeoutMs: number;
  tokenDir: string | null;
  warnings: string[];
}
