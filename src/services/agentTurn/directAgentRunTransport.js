import {
  applyDraftPatch,
  buildNextQuestion,
  fromContractDraft,
  normalizeAgentDraft,
  toContractDraft,
  validateAgentDraft,
} from '../../domain/agentDraft.mjs';
import { getModelConfig } from './agentServiceConfig.js';
import { createAgentTurnError, isAgentTurnError } from './agentTurnError.js';
import {
  STORE_SETUP_SYSTEM_PROMPT,
  STORE_SETUP_TOOLS,
  STORE_SETUP_TOOL_NAMES,
} from './storeSetupDirectPrompt.mjs';

/**
 * 直连 DeepSeek 的 `agent-run.v1` transport。
 *
 * 与服务端 Runtime 的分工保持一致，只是把循环搬到了渲染层：
 * - 模型只负责「说什么 + 调哪个工具」，草稿、缺项、校验结论始终由本机领域层决定；
 * - 每一轮都重新用 `validateAgentDraft` 算 missingFields/errors，模型无权改结论；
 * - 返回值仍是 `agent-run.v1` 外壳，交给 `validateAgentRunResponse` 统一校验，
 *   因此上层（过程卡、会话、持久化）不需要第二套逻辑。
 *
 * 密钥永远不进入这里：真正的 HTTP 请求由主进程用 safeStorage 里的 Key 发出。
 * 浏览器预览没有主进程桥时，本 transport 直接失败并给出可执行提示。
 */

const MAX_MODEL_CALLS = 6;
const MAX_TOOL_CALLS = 12;
const MAX_WALL_CLOCK_MS = 60000;
const MAX_REPLY_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 20000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveBridgeChat() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  if (!api || typeof api.modelChat !== 'function') return null;
  return (payload) => api.modelChat(payload);
}

function createRunId() {
  const stamp = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run_${stamp}${suffix}`;
}

function durationMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function clipReply(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  return Array.from(value).slice(0, MAX_REPLY_CHARS).join('');
}

function truncateToolPayload(value) {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…`;
}

function summarizeDraftForPrompt(draft) {
  const contract = toContractDraft(draft);
  return {
    storeName: contract.storeName,
    category: contract.category,
    businessHours: contract.businessHours,
    fulfillment: contract.fulfillment,
    dishes: contract.dishes.map((dish) => ({
      id: dish.id,
      name: dish.name,
      priceCents: dish.priceCents,
      description: dish.description,
    })),
  };
}

function toolResultFor(errorCode, message) {
  return truncateToolPayload({ ok: false, code: errorCode, message });
}

function parseToolArguments(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    return null;
  }
}

/**
 * @param {object} options
 * @param {(payload: object) => Promise<object>} [options.chat] 主进程模型调用（测试可注入）
 * @param {() => object} [options.getModel] 当前模型配置（测试可注入）
 */
export function createDirectAgentRunTransport(options = {}) {
  const chat = typeof options.chat === 'function' ? options.chat : null;
  const getModel = typeof options.getModel === 'function' ? options.getModel : getModelConfig;

  return {
    name: 'agent-run-direct',
    async send(request, context = {}) {
      const call = chat || resolveBridgeChat();
      if (typeof call !== 'function') {
        throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
          message: '直连模式需要在桌面应用里使用；浏览器预览无法保存或读取 API Key。',
        });
      }
      const model = getModel() || {};
      const startedAt = Date.now();
      const runId = createRunId();

      let draft = normalizeAgentDraft(fromContractDraft(request && request.draft));
      const messages = [
        { role: 'system', content: STORE_SETUP_SYSTEM_PROMPT },
        {
          role: 'system',
          content: `当前草稿（JSON）：${JSON.stringify(summarizeDraftForPrompt(draft))}`,
        },
        { role: 'user', content: String(request && request.utterance ? request.utterance : '') },
      ];

      const toolCalls = [];
      let modelCalls = 0;
      let stopReason = 'final_answer';
      let degraded = false;
      let reply = '';
      let lastSignature = null;
      let duplicateCount = 0;

      while (true) {
        if (context.signal && context.signal.aborted) {
          throw createAgentTurnError('AGENT_ABORTED');
        }
        if (modelCalls >= MAX_MODEL_CALLS) {
          stopReason = 'max_model_calls';
          degraded = true;
          break;
        }
        if (durationMs(startedAt) >= MAX_WALL_CLOCK_MS) {
          stopReason = 'time_limit';
          degraded = true;
          break;
        }
        modelCalls += 1;

        let result;
        try {
          result = await call({
            baseUrl: model.baseUrl,
            model: model.model,
            timeoutMs: model.timeoutMs,
            temperature: 0.2,
            maxTokens: 1200,
            messages,
            tools: STORE_SETUP_TOOLS,
          });
        } catch (error) {
          if (isAgentTurnError(error)) throw error;
          throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
            message: '模型调用没有完成，请检查网络后重试。',
          });
        }

        if (!result || result.ok !== true) {
          const code = result && typeof result.code === 'string' ? result.code : 'DEEPSEEK_UPSTREAM_ERROR';
          const message = result && typeof result.message === 'string'
            ? result.message
            : '模型服务暂时不可用，请稍后重试。';
          // 鉴权/配置类错误直接失败，让用户去设置里修；网络与限流同样失败，避免把半成品说成本轮完成。
          throw createAgentTurnError(code === 'DEEPSEEK_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_HTTP_5XX', {
            serverCode: code,
            message,
          });
        }

        const data = result.data && typeof result.data === 'object' ? result.data : {};
        const assistantContent = typeof data.content === 'string' ? data.content : '';
        const rawToolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];

        if (assistantContent.trim()) reply = clipReply(assistantContent);

        if (rawToolCalls.length === 0) {
          if (!reply) {
            stopReason = 'empty_reply';
            degraded = true;
          }
          break;
        }

        const assistantMessage = { role: 'assistant', content: assistantContent };
        if (rawToolCalls.length > 0) {
          assistantMessage.tool_calls = rawToolCalls.map((item) => ({
            id: item.id || `call_${toolCalls.length + 1}`,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '{}' },
          }));
        }
        messages.push(assistantMessage);

        for (const item of rawToolCalls) {
          const name = typeof item.name === 'string' ? item.name : '';
          const callId = item.id || `call_${toolCalls.length + 1}`;
          const signature = `${name}:${item.arguments || ''}`;
          if (signature === lastSignature) duplicateCount += 1;
          else {
            lastSignature = signature;
            duplicateCount = 0;
          }
          if (duplicateCount >= 2) {
            stopReason = 'loop_detected';
            degraded = true;
            messages.push({
              role: 'tool',
              tool_call_id: callId,
              content: toolResultFor('DUPLICATE_CALL', '这次调用与上一步完全相同，已跳过。'),
            });
            toolCalls.push({ callId, name, ok: false, errorCode: 'DUPLICATE_CALL', latencyMs: 0, attempts: 0, truncated: false });
            continue;
          }
          if (toolCalls.length >= MAX_TOOL_CALLS) {
            stopReason = 'max_tool_calls';
            degraded = true;
            break;
          }

          const toolStartedAt = Date.now();
          let content;
          let ok = true;
          let errorCode = null;

          if (!STORE_SETUP_TOOL_NAMES.includes(name)) {
            ok = false;
            errorCode = 'UNKNOWN_TOOL';
            content = toolResultFor(errorCode, '不支持这个操作，请改用 get_store_draft 或 update_store_draft。');
          } else if (name === 'get_store_draft') {
            const validation = validateAgentDraft(draft);
            content = truncateToolPayload({
              ok: true,
              draft: toContractDraft(draft),
              missingFields: validation.missingFields,
              errors: validation.errors,
              readyForReview: validation.readyForReview,
              nextQuestion: buildNextQuestion(validation),
            });
          } else {
            const args = parseToolArguments(item.arguments);
            if (args === null) {
              ok = false;
              errorCode = 'ARGUMENTS_INVALID';
              content = toolResultFor(errorCode, '参数不是合法 JSON，请重新提交这次修改。');
            } else {
              draft = applyDraftPatch(draft, args);
              const validation = validateAgentDraft(draft);
              content = truncateToolPayload({
                ok: true,
                draft: toContractDraft(draft),
                missingFields: validation.missingFields,
                errors: validation.errors,
                readyForReview: validation.readyForReview,
                nextQuestion: buildNextQuestion(validation),
              });
            }
          }

          toolCalls.push({
            callId,
            name,
            ok,
            errorCode,
            latencyMs: durationMs(toolStartedAt),
            attempts: 1,
            truncated: content.length >= MAX_TOOL_RESULT_CHARS,
          });
          messages.push({ role: 'tool', tool_call_id: callId, content });
        }

        if (stopReason === 'max_tool_calls') break;
      }

      const validation = validateAgentDraft(draft);
      const failedCalls = toolCalls.filter((entry) => entry.ok !== true);
      if (failedCalls.length > 0) degraded = true;
      if (stopReason === 'max_model_calls' || stopReason === 'time_limit' || stopReason === 'loop_detected') {
        degraded = true;
      }

      let finalReply = reply;
      if (!finalReply) {
        const question = buildNextQuestion(validation);
        finalReply = validation.readyForReview
          ? '这次补充的资料已经整理好，请检查右侧草稿后确认。'
          : `已更新草稿。${question ? question.text : '还需要再补充一些资料。'}`;
      }

      const latencyMs = durationMs(startedAt);
      return {
        contractVersion: 'agent-run.v1',
        runId,
        status: validation.readyForReview ? 'reviewing' : 'collecting',
        reply: finalReply,
        draft: toContractDraft(draft),
        trace: {
          modelCalls,
          toolCalls,
          stopReason,
          degraded,
        },
        meta: {
          transport: 'direct',
          provider: 'deepseek',
          mock: false,
          model: model.model || 'deepseek-chat',
          latencyMs,
          runId,
        },
      };
    },
  };
}

export const DIRECT_AGENT_RUN_LIMITS = Object.freeze({
  maxModelCalls: MAX_MODEL_CALLS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxWallClockMs: MAX_WALL_CLOCK_MS,
});
