/**
 * Agent Runtime 公共出口。
 *
 * 该目录刻意不依赖 Nest：可以单独在脚本、测试或其它进程里复用。
 * 业务侧（store-setup）只从这里取 runtime 能力。
 */

export * from './json-schema';
export * from './runtime.errors';
export * from './runtime.types';
export * from './json-utils';

export {
  MAX_REGISTERED_TOOLS,
  MAX_TOOL_ATTEMPTS,
  MAX_TOOL_BACKOFF_MS,
  MAX_TOOL_PARAMETERS_BYTES,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_BACKOFF_MS,
  MIN_TOOL_TIMEOUT_MS,
  TOOL_DESCRIPTION_MAX_LENGTH,
  TOOL_DESCRIPTION_MIN_LENGTH,
  TOOL_NAME_MAX_LENGTH,
  TOOL_TITLE_MAX_LENGTH,
  defineTool,
  isValidToolName,
  ToolRegistry,
} from './tool-registry';
export type {
  AgentTool,
  AgentToolApprovalHook,
  AgentToolApprovalRequest,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolRetryPolicy,
} from './tool-registry';

export {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_ARGUMENT_BYTES,
  ToolExecutor,
} from './tool-executor';
export type {
  AgentToolBatchContext,
  AgentToolCallOutcome,
  AgentToolCallRequest,
  AgentToolCallTrace,
  ToolExecutorOptions,
} from './tool-executor';

export {
  DEFAULT_AGENT_RUN_LIMITS,
  EMPTY_REPLY_NUDGE,
  resolveAgentRunLimits,
  runAgent,
} from './agent-loop';
export type {
  AgentRunLimits,
  AgentRunOptions,
  AgentRunResult,
  AgentRunStatus,
  AgentStepTrace,
  AgentStopReason,
} from './agent-loop';

export { DeepseekChatModel, readDeepseekChatSettings } from './adapters/deepseek-chat-model';
export type {
  ConfigReader,
  DeepseekChatModelOptions,
  DeepseekChatSettings,
  RuntimeFetch,
} from './adapters/deepseek-chat-model';
