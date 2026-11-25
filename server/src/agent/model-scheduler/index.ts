/**
 * 服务端 ModelCallScheduler 统一出口。
 *
 * 适配器只需要：
 * ```ts
 * const scheduler = getSharedModelCallScheduler();
 * const fetch = createScheduledFetch(rawFetch, scheduler, 'agent-extract');
 * ```
 * 或直接把真正的上游调用包进 `scheduler.run()`。
 */

export {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_TOKEN_DIR_NAME,
  ENV_NAMES,
  ERROR_CODES,
  MAX_QUEUE_TIMEOUT_MS,
  MAX_UPSTREAM_CONCURRENCY,
  MIN_QUEUE_TIMEOUT_MS,
  ModelSchedulerError,
  MODEL_SCHEDULER_LOG_PREFIX,
  isModelSchedulerError,
  schedulerMessageOf,
} from './model-scheduler.types';
export type {
  EnvSource,
  GlobalTokenStats,
  ModelCallScheduler,
  ModelCallSchedulerOptions,
  ModelSchedulerErrorCode,
  ResolvedSchedulerOptions,
  RunOptions,
  ScheduledTask,
  SchedulerConfigView,
  SchedulerStats,
  ScheduleSlot,
  TimersLike,
  TokenAcquireRequest,
  TokenBroker,
  TokenLease,
  WarnSink,
} from './model-scheduler.types';

export {
  createModelCallScheduler,
  getSharedModelCallScheduler,
  normalizeMaxConcurrent,
  normalizeQueueTimeout,
  peekSharedModelCallScheduler,
  resetSharedModelCallScheduler,
  resolveSchedulerOptionsFromEnv,
} from './model-scheduler';
export type { SharedSchedulerOptions } from './model-scheduler';

export { createUpstreamTokenBroker, defaultSchedulerWarn, defaultTokenDir } from './upstream-token-broker';
export type { UpstreamTokenBrokerOptions } from './upstream-token-broker';

export {
  createScheduledFetch,
  ensureUpstreamFetchGuard,
  isChatCompletionsUrl,
  isInsideScheduledSlot,
  isUpstreamFetchGuardInstalled,
  runInsideSlot,
  uninstallUpstreamFetchGuard,
} from './scheduled-fetch';
export type { AnyFetch } from './scheduled-fetch';

export {
  AGENT_ENTRY_BUSY_CODE,
  AGENT_ROUTE_PREFIX,
  AgentEntryQueue,
  AgentEntryQueueInterceptor,
  DEFAULT_AGENT_ENTRY_WAIT_MS,
  DEFAULT_AGENT_MAX_CONCURRENT,
  decorateBusyResponse,
  isAgentRoute,
  readAgentEntryQueueOptions,
} from './agent-entry-queue';
export type { AgentEntryQueueOptions, AgentEntryStats } from './agent-entry-queue';
