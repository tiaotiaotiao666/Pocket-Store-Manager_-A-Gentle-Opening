import {
  createAgentTurnError,
  isAgentTurnError,
} from '../agentTurn/agentTurnError.js';

/**
 * 统一会话错误。
 *
 * 形状沿用 `AgentTurnError`（单一错误类型，调用方只需 `isAgentTurnError` 判断），
 * 只补上 `APP_ASSISTANT_*` 稳定码的默认人话。上游网络/模型错误仍抛
 * `DEEPSEEK_*` / `AGENT_*`，不在这里另建同义体系。
 */
const MESSAGES = Object.freeze({
  APP_ASSISTANT_REQUEST_INVALID: '请求内容不符合统一会话契约，请检查后重试。',
  APP_ASSISTANT_CONTRACT_MISMATCH: '客户端与服务端契约版本不一致，请更新应用。',
  APP_ASSISTANT_CATALOG_MISMATCH: '应用能力目录版本不一致，请更新应用后重试。',
  APP_ASSISTANT_CONTEXT_INVALID: '项目上下文不合法，本次请求未发送。',
  APP_ASSISTANT_CONTEXT_STALE: '项目在此期间已变化，这次结果未写入，请重试。',
  APP_ASSISTANT_RESPONSE_INVALID: '返回内容不符合统一会话契约，已丢弃。',
  APP_ASSISTANT_FIELD_UNKNOWN: '响应里包含未知字段，已丢弃。',
  APP_ASSISTANT_FIELD_READ_ONLY: '响应试图写入只读字段，已丢弃。',
  APP_ASSISTANT_VALUE_INVALID: '响应里的字段值不合法，已丢弃。',
  APP_ASSISTANT_OPERATION_DENIED: '响应试图执行不被允许的操作，已丢弃。',
  APP_ASSISTANT_CONFIRMATION_REQUIRED: '这项修改需要你确认后才能应用。',
  APP_ASSISTANT_ACTION_UNAVAILABLE: '当前阶段不能执行这个动作。',
  APP_ASSISTANT_ATTACHMENT_PURPOSE_UNKNOWN: '还不确定图片用途，请先说明要做什么。',
  APP_ASSISTANT_PROPOSAL_DUPLICATE: '有一条修改与前面的内容重复，已跳过；其余内容不受影响。',
});

export function createAppAssistantError(code, options = {}) {
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message
    : MESSAGES[code];
  return createAgentTurnError(code, { ...options, message });
}

export function isAppAssistantError(value) {
  return isAgentTurnError(value) && typeof value.code === 'string' && value.code.startsWith('APP_ASSISTANT_');
}

export function appAssistantErrorCodes() {
  return Object.keys(MESSAGES);
}