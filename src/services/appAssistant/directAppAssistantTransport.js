import { AGENT_DRAFT_LIMITS } from '../../domain/agentDraft.mjs';
import {
  buildAppCapabilityCatalog,
  classifyFieldId,
  findAppCapabilityAction,
  findAppCapabilityField,
  validateCapabilityFieldValue,
} from '../../domain/appCapabilities.mjs';
import { getModelConfig } from '../agentTurn/agentServiceConfig.js';
import {
  createAgentTurnError,
  isAgentTurnError,
} from '../agentTurn/agentTurnError.js';
import { APP_ASSISTANT_CONTRACT_VERSION } from './appAssistantConfig.js';
import { createAppAssistantError } from './appAssistantError.js';
import {
  APP_ASSISTANT_DIRECT_LIMITS,
  APP_ASSISTANT_SYSTEM_PROMPT,
  APP_ASSISTANT_TOOL_NAMES,
  APP_ASSISTANT_TOOLS,
} from './appAssistantPrompt.mjs';

/**
 * 直连 DeepSeek 的 `app-assistant.v1` transport。
 *
 * 与 server Runtime 分工一致，只是把工具循环搬到渲染层：
 * - 模型只能调用五个受控工具，参数由本机能力目录先校验一遍；
 * - 提案只累积在内存，绝不写桌面项目；
 * - 返回值仍是 `app-assistant.v1` 外壳，交给 `validateAppAssistantResponse` 统一校验。
 *
 * 密钥不进入渲染层：真正的 HTTP 请求由主进程用 safeStorage 里的 Key 发出。
 * 主进程的 `modelChat` 只转发 messages/tools、没有图片通道，因此带图时
 * 直接返回结构化错误，而不是把图片静默丢掉。
 */

const MAX_REPLY_CHARS = 500;
const MAX_CHANGES = 24;
const MAX_QUESTIONS = 3;
const MAX_ACTION_REQUESTS = 2;
const MAX_EVIDENCE_CHARS = 120;
const MAX_TOOL_RESULT_CHARS = 20000;

const CHANGE_OPS = Object.freeze(['field.set', 'dish.upsert', 'dish.remove', 'action.request']);
const FORBIDDEN_VALUE_PATTERNS = Object.freeze(['data:', 'file://', 'http://', 'https://', '../', '..\\', '\\\\']);
const FORBIDDEN_PARAM_KEYS = Object.freeze(['path', 'absolutePath', 'url', 'script', 'command', 'ipc', 'reducer', 'actionType', 'cwd']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function clipText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return codePointLength(text) > maxChars ? Array.from(text).slice(0, maxChars).join('') : text;
}

function scanForbidden(value, depth = 0) {
  if (depth > 4) return true;
  if (typeof value === 'string') {
    const text = value.trim();
    return FORBIDDEN_VALUE_PATTERNS.some((pattern) => text.includes(pattern));
  }
  if (Array.isArray(value)) return value.some((item) => scanForbidden(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).some((item) => scanForbidden(item, depth + 1));
  return false;
}

function normalizeEvidence(raw, utterance) {
  const source = isPlainObject(raw) && typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim().slice(0, 24)
    : '';
  const fallback = clipText(utterance, MAX_EVIDENCE_CHARS);
  if (!source && !fallback) return null;
  let excerpt = isPlainObject(raw) && typeof raw.excerpt === 'string' ? raw.excerpt.trim() : '';
  if (!excerpt) excerpt = fallback;
  if (codePointLength(excerpt) > MAX_EVIDENCE_CHARS) excerpt = clipText(excerpt, MAX_EVIDENCE_CHARS);
  if (!excerpt) return null;
  if (scanForbidden(excerpt)) return null;
  const evidence = { source: source || 'utterance', excerpt };
  if (isPlainObject(raw) && typeof raw.attachmentId === 'string' && raw.attachmentId.trim()) {
    evidence.attachmentId = raw.attachmentId.trim().slice(0, 80);
  }
  return evidence;
}

function failChange(code, message) {
  return { ok: false, code, message };
}

/** 用能力目录预校验一条模型提案；这里只做「能不能提交」，写入仍由桌面 reducer 负责。 */
function normalizeProposedChange(raw, context) {
  if (!isPlainObject(raw)) return failChange('APP_ASSISTANT_RESPONSE_INVALID', '修改项必须是对象。');
  const op = raw.op;
  if (!CHANGE_OPS.includes(op)) {
    return failChange('APP_ASSISTANT_OPERATION_DENIED', `不支持的操作 ${String(op)}。`);
  }
  const evidence = normalizeEvidence(raw.evidence, context.utterance);
  if (!evidence) {
    return failChange('APP_ASSISTANT_RESPONSE_INVALID', '缺少 evidence；请摘录用户原话。');
  }
  if (scanForbidden(raw.value) || scanForbidden(raw.params)) {
    return failChange('APP_ASSISTANT_OPERATION_DENIED', '值里不允许出现地址、路径或 data URL。');
  }
  const opId = `op_${context.nextOpId}`;

  if (op === 'field.set') {
    const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId.trim() : '';
    const kind = classifyFieldId(fieldId);
    if (!fieldId || kind === 'unknown') return failChange('APP_ASSISTANT_FIELD_UNKNOWN', `未知字段 ${fieldId}。`);
    if (kind !== 'writable') return failChange('APP_ASSISTANT_FIELD_READ_ONLY', `${fieldId} 不可写。`);
    const field = findAppCapabilityField(fieldId);
    if (!field || field.writeMode !== 'field.set') {
      return failChange('APP_ASSISTANT_OPERATION_DENIED', `${fieldId} 不能用 field.set 写入。`);
    }
    const checked = validateCapabilityFieldValue(fieldId, raw.value);
    if (!checked.ok) return failChange(checked.code, checked.message);
    const change = { opId, op, fieldId, value: checked.value, evidence };
    if (typeof raw.reason === 'string' && raw.reason.trim()) change.reason = clipText(raw.reason, 120);
    return { ok: true, change };
  }

  if (op === 'dish.upsert') {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return failChange('APP_ASSISTANT_RESPONSE_INVALID', 'dish.upsert 缺少菜名。');
    if (codePointLength(name) > AGENT_DRAFT_LIMITS.maxDishName) {
      return failChange('APP_ASSISTANT_VALUE_INVALID', `菜名不能超过 ${AGENT_DRAFT_LIMITS.maxDishName} 个字。`);
    }
    const change = { opId, op, name, evidence };
    if (raw.dishId !== undefined) {
      const dishId = typeof raw.dishId === 'string' ? raw.dishId.trim() : '';
      if (!dishId) return failChange('APP_ASSISTANT_VALUE_INVALID', 'dishId 非法。');
      const dishes = context.projectContext?.fields?.['store.dishes'];
      if (Array.isArray(dishes) && !dishes.some((dish) => dish.id === dishId)) {
        return failChange('APP_ASSISTANT_VALUE_INVALID', `菜品 ${dishId} 不存在。`);
      }
      change.dishId = dishId;
    }
    if (raw.priceCents === null) {
      change.priceCents = null;
    } else if (raw.priceCents !== undefined) {
      if (!Number.isInteger(raw.priceCents)
        || raw.priceCents < AGENT_DRAFT_LIMITS.minPriceCents
        || raw.priceCents > AGENT_DRAFT_LIMITS.maxPriceCents) {
        return failChange('APP_ASSISTANT_VALUE_INVALID', '价格必须是合法整数分（0.01–9999.99 元）。');
      }
      change.priceCents = raw.priceCents;
    }
    if (raw.description !== undefined) {
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      if (codePointLength(description) > AGENT_DRAFT_LIMITS.maxDescription) {
        return failChange('APP_ASSISTANT_VALUE_INVALID', `描述不能超过 ${AGENT_DRAFT_LIMITS.maxDescription} 个字。`);
      }
      change.description = description;
    }
    if (typeof raw.reason === 'string' && raw.reason.trim()) change.reason = clipText(raw.reason, 120);
    return { ok: true, change };
  }

  if (op === 'dish.remove') {
    const dishId = typeof raw.dishId === 'string' ? raw.dishId.trim() : '';
    if (!dishId) return failChange('APP_ASSISTANT_RESPONSE_INVALID', 'dish.remove 缺少 dishId。');
    const dishes = context.projectContext?.fields?.['store.dishes'];
    if (Array.isArray(dishes) && !dishes.some((dish) => dish.id === dishId)) {
      return failChange('APP_ASSISTANT_VALUE_INVALID', `菜品 ${dishId} 不存在。`);
    }
    return { ok: true, change: { opId, op, dishId, evidence } };
  }

  const actionId = typeof raw.actionId === 'string' ? raw.actionId.trim() : '';
  const action = findAppCapabilityAction(actionId);
  if (!action) return failChange('APP_ASSISTANT_OPERATION_DENIED', `未知动作 ${actionId}。`);
  if (isPlainObject(raw.params)) {
    for (const key of Object.keys(raw.params)) {
      if (FORBIDDEN_PARAM_KEYS.includes(key)) {
        return failChange('APP_ASSISTANT_OPERATION_DENIED', `动作参数不允许包含 ${key}。`);
      }
    }
  }
  const change = {
    opId,
    op,
    actionId,
    params: isPlainObject(raw.params) ? { ...raw.params } : {},
    evidence,
  };
  if (Array.isArray(raw.attachmentIds)) {
    const ids = raw.attachmentIds
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim().slice(0, 80))
      .slice(0, 3);
    if (ids.length) change.attachmentIds = ids;
  }
  return { ok: true, change };
}

function changeSignature(change) {
  return JSON.stringify([
    change.op,
    change.fieldId ?? change.dishId ?? change.actionId ?? change.name ?? '',
    change.value ?? change.priceCents ?? change.params ?? '',
  ]);
}

function toolFail(code, message) {
  return { ok: false, code, message };
}

function countActionRequests(context) {
  return context.proposals.filter((item) => item.op === 'action.request').length;
}

function acceptProposedChanges(rawChanges, context) {
  if (!Array.isArray(rawChanges)) {
    return toolFail('ARGUMENTS_INVALID', 'changes 必须是数组。');
  }
  const rejected = [];
  let accepted = 0;
  rawChanges.forEach((item, index) => {
    if (context.proposals.length + rejected.length >= MAX_CHANGES) {
      rejected.push({ index, code: 'APP_ASSISTANT_RESPONSE_INVALID', message: `单轮最多 ${MAX_CHANGES} 条修改。` });
      return;
    }
    if (isPlainObject(item) && item.op === 'action.request' && countActionRequests(context) >= MAX_ACTION_REQUESTS) {
      rejected.push({ index, code: 'APP_ASSISTANT_OPERATION_DENIED', message: `单轮最多 ${MAX_ACTION_REQUESTS} 个动作请求。` });
      return;
    }
    const normalized = normalizeProposedChange(item, context);
    if (!normalized.ok) {
      rejected.push({ index, code: normalized.code, message: normalized.message });
      return;
    }
    const signature = changeSignature(normalized.change);
    if (context.signatures.has(signature)) {
      rejected.push({ index, code: 'APP_ASSISTANT_PROPOSAL_DUPLICATE', message: '这条修改与前面重复，已跳过。' });
      return;
    }
    context.signatures.add(signature);
    context.nextOpId += 1;
    context.proposals.push(normalized.change);
    accepted += 1;
  });
  return {
    ok: rejected.length === 0,
    accepted,
    rejected,
    totalChanges: context.proposals.length,
  };
}

function acceptQuestions(rawQuestions, context) {
  if (!Array.isArray(rawQuestions)) return toolFail('ARGUMENTS_INVALID', 'questions 必须是数组。');
  const rejected = [];
  let accepted = 0;
  rawQuestions.forEach((item, index) => {
    if (context.questions.length >= MAX_QUESTIONS) {
      rejected.push({ index, code: 'APP_ASSISTANT_RESPONSE_INVALID', message: `最多 ${MAX_QUESTIONS} 个追问。` });
      return;
    }
    const rawText = typeof item === 'string' ? item : (isPlainObject(item) ? item.text : '');
    const text = clipText(rawText, 200);
    if (!text) {
      rejected.push({ index, code: 'APP_ASSISTANT_RESPONSE_INVALID', message: '追问内容不能为空。' });
      return;
    }
    context.questions.push({ id: `q_${context.questions.length + 1}`, text });
    accepted += 1;
  });
  return { ok: rejected.length === 0, accepted, rejected, totalQuestions: context.questions.length };
}

function executeTool(name, args, context) {
  switch (name) {
    case 'get_project_capabilities':
      return {
        ok: true,
        data: {
          catalogVersion: context.projectContext?.capabilitiesVersion ?? 'app-capabilities.v1',
          catalog: buildAppCapabilityCatalog(),
        },
      };
    case 'get_project_context':
      return {
        ok: true,
        data: {
          context: context.projectContext,
          userMessage: context.utterance,
        },
      };
    case 'propose_project_changes':
      return acceptProposedChanges(args.changes, context);
    case 'request_business_action': {
      if (countActionRequests(context) >= MAX_ACTION_REQUESTS) {
        return toolFail('APP_ASSISTANT_OPERATION_DENIED', `单轮最多 ${MAX_ACTION_REQUESTS} 个动作请求。`);
      }
      const normalized = normalizeProposedChange({
        op: 'action.request',
        actionId: args.actionId,
        params: args.params,
        attachmentIds: args.attachmentIds,
        evidence: args.evidence,
      }, context);
      if (!normalized.ok) return toolFail(normalized.code, normalized.message);
      const signature = changeSignature(normalized.change);
      if (context.signatures.has(signature)) {
        return toolFail('APP_ASSISTANT_PROPOSAL_DUPLICATE', '这个动作请求已经登记过。');
      }
      context.signatures.add(signature);
      context.nextOpId += 1;
      context.proposals.push(normalized.change);
      return { ok: true, actionId: normalized.change.actionId, totalChanges: context.proposals.length };
    }
    case 'ask_follow_up':
      return acceptQuestions(args.questions, context);
    default:
      return toolFail('UNKNOWN_TOOL', '不支持这个操作，请使用已提供的五个工具。');
  }
}

function parseToolArguments(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function truncateToolPayload(value) {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…`;
}

function createRunId() {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function durationMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function resolveBridgeChat() {
  if (typeof window === 'undefined') return null;
  const api = window.smartStore;
  if (!api || typeof api.modelChat !== 'function') return null;
  return (payload) => api.modelChat(payload);
}

function buildModelMessages(request) {
  const context = request.project?.context ?? null;
  const messages = [
    { role: 'system', content: APP_ASSISTANT_SYSTEM_PROMPT },
    {
      role: 'system',
      content: `当前项目上下文（JSON，只读）：${JSON.stringify(context)}`,
    },
    {
      role: 'system',
      content: '先调用 get_project_capabilities 与 get_project_context，再提交提案。不要假设字段值。',
    },
  ];
  for (const item of Array.isArray(request.history) ? request.history : []) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string') {
      messages.push({ role: item.role, content: item.text });
    }
  }
  messages.push({ role: 'user', content: request.utterance });
  return { messages };
}

function mapUpstreamError(result) {
  const code = result && typeof result.code === 'string' ? result.code : 'DEEPSEEK_UPSTREAM_ERROR';
  const message = result && typeof result.message === 'string'
    ? result.message
    : '模型服务暂时不可用，请稍后重试。';
  return createAgentTurnError(code === 'DEEPSEEK_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_HTTP_5XX', {
    serverCode: code,
    message,
  });
}

/**
 * @param {object} options
 * @param {(payload: object) => Promise<object>} [options.chat] 主进程模型调用（测试可注入）
 * @param {() => object} [options.getModel] 当前模型配置（测试可注入）
 */
export function createDirectAppAssistantTransport(options = {}) {
  const chat = typeof options.chat === 'function' ? options.chat : null;
  const getModel = typeof options.getModel === 'function' ? options.getModel : getModelConfig;

  return {
    name: 'direct',
    async send(request, transportContext = {}) {
      const signal = transportContext.signal;
      const call = chat || resolveBridgeChat();
      if (typeof call !== 'function') {
        throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
          message: '直连模式需要在桌面应用里使用；浏览器预览无法保存或读取 API Key。',
        });
      }

      const attachments = Array.isArray(request.attachments) ? request.attachments : [];
      if (attachments.length > 0) {
        // 主进程 modelChat 没有图片通道：明确拒绝，绝不把图片从请求里静默删除后继续。
        throw createAgentTurnError('AGENT_REQUEST_INVALID', {
          message: '当前直连 DeepSeek 不支持图片输入，请改用本机模型服务后再发送图片。',
          details: {
            reason: 'DIRECT_ATTACHMENTS_UNSUPPORTED',
            attachmentIds: attachments.map((item) => item.id).filter(Boolean),
          },
        });
      }

      const model = getModel() || {};
      const startedAt = Date.now();
      const runId = createRunId();
      const projectContext = isPlainObject(request.project?.context) ? request.project.context : null;
      const { messages } = buildModelMessages(request);

      const context = {
        projectContext,
        utterance: typeof request.utterance === 'string' ? request.utterance : '',
        proposals: [],
        questions: [],
        signatures: new Set(),
        nextOpId: 1,
      };

      const toolCalls = [];
      const rejectedChanges = [];
      let modelCalls = 0;
      let stopReason = 'final_answer';
      let degraded = false;
      let reply = '';
      let lastSignature = null;
      let duplicateCount = 0;

      while (true) {
        if (signal && signal.aborted) {
          throw createAgentTurnError('AGENT_ABORTED');
        }
        if (modelCalls >= APP_ASSISTANT_DIRECT_LIMITS.maxModelCalls) {
          stopReason = 'max_model_calls';
          degraded = true;
          break;
        }
        if (durationMs(startedAt) >= APP_ASSISTANT_DIRECT_LIMITS.maxWallClockMs) {
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
            tools: APP_ASSISTANT_TOOLS,
          });
        } catch (error) {
          if (isAgentTurnError(error)) throw error;
          throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
            message: '模型调用没有完成，请检查网络后重试。',
          });
        }

        if (!result || result.ok !== true) throw mapUpstreamError(result);

        const data = result.data && typeof result.data === 'object' ? result.data : {};
        const assistantContent = typeof data.content === 'string' ? data.content : '';
        const rawToolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];

        if (assistantContent.trim()) reply = clipText(assistantContent, MAX_REPLY_CHARS);

        if (rawToolCalls.length === 0) {
          if (!reply) {
            stopReason = 'empty_reply';
            degraded = true;
          }
          break;
        }

        const assistantMessage = { role: 'assistant', content: assistantContent };
        assistantMessage.tool_calls = rawToolCalls.map((item, index) => ({
          id: item.id || `call_${toolCalls.length + index + 1}`,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        }));
        messages.push(assistantMessage);

        for (const item of rawToolCalls) {
          if (signal && signal.aborted) throw createAgentTurnError('AGENT_ABORTED');
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
              content: truncateToolPayload({ ok: false, code: 'DUPLICATE_CALL', message: '这次调用与上一步完全相同，已跳过。' }),
            });
            toolCalls.push({ name, ok: false, errorCode: 'DUPLICATE_CALL', latencyMs: 0 });
            continue;
          }
          if (toolCalls.length >= APP_ASSISTANT_DIRECT_LIMITS.maxToolCalls) {
            stopReason = 'max_tool_calls';
            degraded = true;
            break;
          }

          const toolStartedAt = Date.now();
          let outcome;
          if (!APP_ASSISTANT_TOOL_NAMES.includes(name)) {
            outcome = toolFail('UNKNOWN_TOOL', '不支持这个操作，请使用已提供的五个工具。');
          } else {
            const args = parseToolArguments(item.arguments);
            outcome = args === null
              ? toolFail('ARGUMENTS_INVALID', '参数不是合法 JSON，请重新提交这次修改。')
              : executeTool(name, args, context);
          }

          if (outcome.ok !== true) {
            degraded = true;
            if (Array.isArray(outcome.rejected)) {
              for (const entry of outcome.rejected) {
                rejectedChanges.push({ tool: name, ...entry });
              }
            }
          }

          toolCalls.push({
            name,
            ok: outcome.ok === true,
            errorCode: outcome.ok === true ? null : (outcome.code || 'TOOL_FAILED'),
            latencyMs: durationMs(toolStartedAt),
          });
          messages.push({ role: 'tool', tool_call_id: callId, content: truncateToolPayload(outcome) });
        }

        if (stopReason === 'max_tool_calls') break;
      }

      const actionRequests = context.proposals.filter((item) => item.op === 'action.request');
      const fieldChanges = context.proposals.filter((item) => item.op !== 'action.request');
      const questions = [...context.questions];
      let status;
      if (context.proposals.length > 0) {
        status = 'proposal';
      } else if (questions.length > 0) {
        status = 'needs-input';
      } else if (rejectedChanges.length > 0) {
        status = 'rejected';
      } else {
        status = 'needs-input';
        questions.push({ id: 'q_next', text: '请告诉我这次要修改哪一项资料。' });
      }

      if (!reply) {
        reply = status === 'proposal'
          ? '已整理这些资料，请核对。'
          : (status === 'rejected' ? '这个请求超出了当前能力范围，没有生成任何写入。' : '还需要你补充一些信息。');
      }
      reply = clipText(reply, MAX_REPLY_CHARS);

      if (stopReason !== 'final_answer') degraded = true;
      return {
        contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
        requestId: request.requestId,
        runId,
        catalogVersion: request.catalogVersion,
        contextRevision: request.contextRevision,
        status,
        reply,
        proposalId: `proposal_${runId}`,
        // 契约里 action.request 也走 changes，桌面校验器会把它提取到 actionRequests。
        changes: [...fieldChanges, ...actionRequests],
        questions,
        actionRequests,
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
          latencyMs: durationMs(startedAt),
          runId,
        },
      };
    },
  };
}

export const DIRECT_APP_ASSISTANT_LIMITS = APP_ASSISTANT_DIRECT_LIMITS;