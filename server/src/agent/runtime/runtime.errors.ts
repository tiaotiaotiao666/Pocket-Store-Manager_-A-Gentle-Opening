/**
 * Runtime 错误类型。
 *
 * 约定：
 * - message 允许回传给模型或 HTTP 调用方，因此不得包含堆栈、上游响应体、密钥或文件路径；
 * - code 是稳定的机器可读错误码，测试与客户端都以它为准；
 * - retryable 只描述“同一请求重试是否可能成功”，由执行器/循环决定是否真的重试。
 */

export interface AgentErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: AgentErrorOptions = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 工具/注册表/配置写错时抛出，属于开发期错误，不应被重试。 */
export class AgentConfigurationError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'retryable'> = {}) {
    super('AGENT_CONFIGURATION_INVALID', message, { ...options, retryable: false });
    this.name = 'AgentConfigurationError';
  }
}

/** 工具作者主动抛出的可安全展示错误。 */
export class AgentToolError extends AgentError {
  constructor(code: string, message: string, options: Omit<AgentErrorOptions, 'retryable'> & { retryable?: boolean } = {}) {
    super(code, message, options);
    this.name = 'AgentToolError';
  }
}

/** 模型适配器错误。code 沿用 DEEPSEEK_*，便于现有错误处理复用。 */
export class AgentModelError extends AgentError {
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: AgentErrorOptions & { status?: number } = {},
  ) {
    super(code, message, options);
    this.name = 'AgentModelError';
    if (options.status !== undefined) this.status = options.status;
  }
}

export class AgentAbortedError extends AgentError {
  constructor(message = '本次运行已取消。') {
    super('AGENT_ABORTED', message, { retryable: false });
    this.name = 'AgentAbortedError';
  }
}

export class AgentLimitError extends AgentError {
  constructor(code: string, message: string) {
    super(code, message, { retryable: false });
    this.name = 'AgentLimitError';
  }
}

/** 内部错误：工具超时。执行器据此决定是否按 retryOnTimeout 重试。 */
export class AgentToolTimeoutError extends AgentError {
  constructor(toolName: string, timeoutMs: number) {
    super('TOOL_TIMEOUT', `工具 ${toolName} 执行超时（${timeoutMs}ms）。`, { retryable: false });
    this.name = 'AgentToolTimeoutError';
  }
}

export const AGENT_RUNTIME_ERROR_CODES = {
  configuration: 'AGENT_CONFIGURATION_INVALID',
  aborted: 'AGENT_ABORTED',
  timeLimit: 'AGENT_TIME_LIMIT',
  modelCallLimit: 'AGENT_MODEL_CALL_LIMIT',
  toolCallLimit: 'AGENT_TOOL_CALL_LIMIT',
  loopDetected: 'AGENT_LOOP_DETECTED',
  modelResponseInvalid: 'AGENT_MODEL_RESPONSE_INVALID',
} as const;

export const AGENT_TOOL_ERROR_CODES = {
  notFound: 'TOOL_NOT_FOUND',
  argumentsTooLarge: 'TOOL_ARGUMENTS_TOO_LARGE',
  argumentsInvalid: 'TOOL_ARGUMENTS_INVALID',
  approvalRequired: 'TOOL_APPROVAL_REQUIRED',
  denied: 'TOOL_DENIED',
  timedOut: 'TOOL_TIMEOUT',
  executionFailed: 'TOOL_EXECUTION_FAILED',
  resultInvalid: 'TOOL_RESULT_INVALID',
} as const;
