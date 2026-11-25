'use strict';

/**
 * modelChat 适配层（rev15 §14.7「direct 与 modelChat 对等」）。
 *
 * 唯一职责：把 `desktop/model-credentials.cjs#requestChat` 的返回体**强制**归一成
 * `{ model, content, toolCalls, usage, finishReason, truncated, maxTokens, profile }`，
 * 让 direct 循环拿到确定的截断信号（X8）：
 * - `finishReason` 字段永远存在（上游没给时是 `''`，并置 `finishReasonMissing:true`）；
 * - `truncated` 只看 `finish_reason=length`（**空正文 + length 也算**，不得当成“无响应”）；
 * - 绝不在这里改写模型的措辞（X9：reply 仅供参考，不做“已验证/已采用”伪状态修正）。
 *
 * 这里不做重试、不做排队：排队/并发由 `model-credentials` 的 ModelCallScheduler 统一负责，
 * 保证“进程内同时在飞的上游请求 ≤ 3”只有一条出口。
 */

const { ModelCredentialError } = require('../model-credentials.cjs');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 归一一条上游补全结果；字段缺失只标记不猜测。 */
function normalizeCompletion(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const finishReasonPresent = typeof source.finishReason === 'string';
  const finishReason = finishReasonPresent ? source.finishReason : '';
  const toolCalls = Array.isArray(source.toolCalls)
    ? source.toolCalls.map((call) => ({
      id: typeof call?.id === 'string' ? call.id : '',
      name: typeof call?.name === 'string' ? call.name : '',
      arguments: typeof call?.arguments === 'string' ? call.arguments : '{}',
    }))
    : [];
  const usage = isPlainObject(source.usage) ? source.usage : null;
  return {
    model: typeof source.model === 'string' ? source.model : '',
    content: typeof source.content === 'string' ? source.content : '',
    toolCalls,
    usage,
    finishReason,
    finishReasonMissing: !finishReasonPresent,
    // §14.7：截断信号只认 finish_reason=length，且与正文是否为空无关。
    truncated: finishReason === 'length' || source.truncated === true,
    maxTokens: Number.isInteger(source.maxTokens) ? source.maxTokens : null,
    profile: source.profile === 'direct-edit' ? 'direct-edit' : 'chat',
  };
}

/**
 * @param {object} options
 * @param {object} options.credentials `createModelCredentials()` 的返回值（必须带 chat）
 * @param {(payload: object) => Promise<object>} [options.chat] 测试用注入：直接替换底层调用
 * @param {boolean} [options.supportsVision] 该模型是否支持视觉输入（X2：**必须显式声明**，
 *   未声明即视为不支持，direct 循环会以 `AGENT_VISION_UNAVAILABLE` 拒绝发图，绝不静默降级）
 */
function createModelChat(options) {
  const opts = isPlainObject(options) ? options : {};
  const injected = typeof opts.chat === 'function' ? opts.chat : null;
  const credentials = opts.credentials;
  const supportsVision = opts.supportsVision === true;

  async function chat(payload) {
    const source = isPlainObject(payload) ? payload : {};
    if (!Array.isArray(source.messages) || source.messages.length === 0) {
      throw new ModelCredentialError('MODEL_REQUEST_INVALID', '对话内容为空。');
    }
    const call = injected || (credentials && typeof credentials.chat === 'function' ? credentials.chat : null);
    if (!call) {
      throw new ModelCredentialError('DEEPSEEK_NOT_CONFIGURED', '模型通道未接线（缺少 credentials.chat）。');
    }
    const args = {
      model: source.model,
      baseUrl: source.baseUrl,
      timeoutMs: source.timeoutMs,
      // 源码编辑走 6000/8000 预算；普通对话保持 1200/4096（两个数字只在 model-credentials 里定义）。
      profile: source.profile === 'direct-edit' ? 'direct-edit' : 'chat',
      maxTokens: source.maxTokens,
      temperature: source.temperature,
      thinking: source.thinking,
      messages: source.messages,
      tools: source.tools,
      signal: source.signal,
    };
    const raw = injected ? await injected(args) : await credentials.chat(args);
    return normalizeCompletion(raw);
  }

  return {
    chat,
    describe: () => ({
      transport: 'direct',
      wired: Boolean(injected || credentials),
      // X2：视觉能力随模型一起声明；下游用 describe().supportsVision 决定能不能发图。
      supportsVision,
    }),
  };
}

module.exports = {
  createModelChat,
  normalizeCompletion,
};
