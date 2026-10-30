const ERROR_DEFINITIONS = Object.freeze({
  AGENT_MOCK_FAILURE: { message: '本地 Mock 模拟失败（仅用于验证失败态）', retryable: true },
  AGENT_TIMEOUT: { message: '请求超时，请重试。', retryable: true },
  AGENT_NETWORK: { message: '网络不可用，请检查后重试。', retryable: true },
  AGENT_ABORTED: { message: '请求已取消。', retryable: false },
  AGENT_HTTP_4XX: { message: '请求未被接受，请检查后重新描述。', retryable: false },
  AGENT_RATE_LIMITED: { message: '请求过于频繁，请稍后重试。', retryable: true },
  AGENT_HTTP_5XX: { message: '服务暂时不可用，请重试。', retryable: true },
  AGENT_RESPONSE_INVALID: { message: '返回内容无法识别，请重新描述。', retryable: false },
  AGENT_CONTRACT_MISMATCH: { message: '客户端与服务端契约版本不一致，请更新应用。', retryable: false },
  AGENT_TRANSPORT_UNKNOWN: { message: '服务未配置，请联系管理员。', retryable: false },
  AGENT_REQUEST_INVALID: { message: '请先输入一段开店资料。', retryable: false },
});

export function createAgentTurnError(code, options = {}) {
  const definition = ERROR_DEFINITIONS[code] ?? {
    message: 'Agent 请求失败，请稍后再试。',
    retryable: false,
  };
  const error = new Error(options.message || definition.message);
  error.name = 'AgentTurnError';
  error.code = code;
  error.retryable = options.retryable === undefined ? definition.retryable : Boolean(options.retryable);
  error.httpStatus = options.httpStatus ?? null;
  error.serverCode = options.serverCode ?? null;
  error.requestId = options.requestId ?? null;
  error.details = options.details ?? null;
  error.toJSON = () => ({
    name: 'AgentTurnError',
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    httpStatus: error.httpStatus,
    serverCode: error.serverCode,
    requestId: error.requestId,
    details: error.details,
  });
  return error;
}

export function isAgentTurnError(value) {
  return Boolean(value)
    && value instanceof Error
    && value.name === 'AgentTurnError'
    && typeof value.code === 'string';
}

export function normalizeAgentTurnError(error) {
  if (isAgentTurnError(error)) return error;
  if (error && error.name === 'AbortError') {
    return createAgentTurnError('AGENT_ABORTED');
  }
  if (error instanceof TypeError) {
    return createAgentTurnError('AGENT_NETWORK');
  }
  return createAgentTurnError('AGENT_NETWORK', { details: null });
}

export function agentErrorCodes() {
  return Object.keys(ERROR_DEFINITIONS);
}