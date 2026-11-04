/**
 * 「对话修改当前模板」服务层（契约 `agent-template-revise.v1`，plan.md 2.2.8）。
 *
 * 职责边界：
 * - 组装请求 → 选 transport → 发请求；
 * - 用前端 `validatePresentationPatch` 复核服务端返回的补丁（不信任线上内容）；
 * - 把各类错误统一映射成带中文文案的 `AgentTurnError`；
 * - **不直接修改 sessionMachine 的 state**：只返回结果，由 App 派发
 *   `TEMPLATE_REVISE_SUCCESS` / `TEMPLATE_REVISE_FAILURE`。
 */

import { diffPresentationPatch, validatePresentationPatch } from '../../domain/presentationPatch.mjs';
import { getTemplateReviseConfig } from './agentServiceConfig.js';
import {
  createAgentTurnError,
  isAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';
import {
  TEMPLATE_REVISE_CONTRACT_VERSION,
  buildTemplateRevisePatchContext,
  buildTemplateReviseRequest,
  createTemplateReviseHttpTransport,
  createTemplateReviseMockTransport,

  validateTemplateReviseResponse,
} from './templateReviseTransport.js';

export { TEMPLATE_REVISE_CONTRACT_VERSION };

/**
 * 2.2.8「前端表现」列的固定文案。
 * 服务端若返回更具体的 `details`，会在后面追加可读原因。
 */
const REVISE_ERROR_MESSAGES = Object.freeze({
  AGENT_REQUEST_INVALID: '修改描述或模板信息不合法，请检查后重试。',
  PRESENTATION_PATCH_INVALID: '这版修改未通过展示校验，已保留上一版。',
  PATCH_THEME_COLOR_INVALID: '颜色必须是 #RRGGBB 格式，已保留上一版。',
  PATCH_SLOT_ORDER_UNSUPPORTED: '当前模板没有可移动的区块，已保留上一版。',
  PATCH_SLOT_TARGET_INVALID: '目标区块位置不可用，已保留上一版。',
  PATCH_SIZE_UNSUPPORTED: '当前模板不支持该尺寸调整，已保留上一版。',
  PATCH_COPY_DISH_UNKNOWN: '要修改的菜品不存在，已保留上一版。',
  DEEPSEEK_NOT_CONFIGURED: '模型未配置，请检查服务端。',
  DEEPSEEK_TIMEOUT: '模型超时，请重试。',
  DEEPSEEK_RESPONSE_INVALID: '模型返回无法解析，已保留上一版。',
  DEEPSEEK_VISION_UNAVAILABLE: '图片识别暂不可用，请稍后重试。',
  AGENT_BODY_TOO_LARGE: '图片过大，请压缩后重试。',
  AGENT_TIMEOUT: '请求超时，请重试。',
  AGENT_NETWORK: '网络不可用，请检查后重试。',
  AGENT_ABORTED: '请求已取消。',
  AGENT_RATE_LIMITED: '请求过于频繁，请稍后重试。',
  AGENT_HTTP_5XX: '服务暂时不可用，请稍后重试。',
  AGENT_HTTP_4XX: '请求未被接受，请检查后重新描述。',
  AGENT_RESPONSE_INVALID: '返回内容无法识别，已保留上一版。',
  AGENT_CONTRACT_MISMATCH: '客户端与服务端契约版本不一致，请更新应用。',
  AGENT_TRANSPORT_UNKNOWN: '服务未配置，请联系管理员。',
});

function firstDetailMessage(details) {
  if (!Array.isArray(details) || !details.length) return '';
  const first = details[0];
  if (!first || typeof first !== 'object') return '';
  return typeof first.message === 'string' ? first.message.trim() : '';
}

/**
 * 把任意错误映射成带稳定 code + 中文文案的 `AgentTurnError`。
 *
 * - 已知错误码：使用 2.2.8 的固定文案；有 `details[0].message` 时追加可读原因。
 * - 未知错误码：沿用原 message，避免吞掉后端新增的提示。
 * - 非 AgentTurnError：按网络错误归一。
 */
export function mapTemplateReviseError(error) {
  const normalized = isAgentTurnError(error) ? error : normalizeAgentTurnError(error);
  const code = normalized.code || 'AGENT_NETWORK';
  const baseMessage = Object.prototype.hasOwnProperty.call(REVISE_ERROR_MESSAGES, code)
    ? REVISE_ERROR_MESSAGES[code]
    : (normalized.message || '模板修改失败，请稍后再试。');
  const detailMessage = firstDetailMessage(normalized.details);
  const message = detailMessage && !baseMessage.includes(detailMessage)
    ? `${baseMessage}（${detailMessage}）`
    : baseMessage;

  return createAgentTurnError(code, {
    message,
    retryable: normalized.retryable,
    httpStatus: normalized.httpStatus,
    serverCode: normalized.serverCode,
    requestId: normalized.requestId,
    details: normalized.details,
  });
}

/** 生成前端单飞用的 requestId；浏览器优先用 crypto.randomUUID。 */
export function createReviseRequestId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch (error) {
    // 忽略：退化到时间戳 + 随机串
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `rev_${Date.now().toString(36)}_${random}`;
}

function resolveFetchImpl() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

/**
 * transport 选择：
 * - 显式注入优先（测试、或 App 想复用同一个 transport）；
 * - 否则按 `getTemplateReviseConfig().mode`：http → 真实后端，mock → 本地确定性演示。
 */
function resolveTransport(explicitTransport, options) {
  if (explicitTransport) {
    if (typeof explicitTransport.send !== 'function') {
      throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
        message: 'transport 必须提供 send 方法。',
      });
    }
    return explicitTransport;
  }

  const config = getTemplateReviseConfig();
  if (config.mode === 'http') {
    return createTemplateReviseHttpTransport({
      fetchImpl: options.fetchImpl ?? resolveFetchImpl(),
      getAuthorization: options.getAuthorization,
      endpoint: options.endpoint ?? config.endpoint,
      baseUrl: options.baseUrl ?? config.baseUrl,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
    });
  }
  return createTemplateReviseMockTransport({ delayMs: options.delayMs });
}

/**
 * 发出一次「对话修改当前模板」请求。
 *
 * @param {object} input
 * @param {string} input.utterance 用户一句话
 * @param {{templateId: string, layout?: string}} input.candidate 当前候选
 * @param {Array<{featureId:string,pageId:string,slotId:string}>} [input.planFeatures]
 * @param {object} [input.basePatch] 当前已接受补丁
 * @param {object} [input.baseDraft] 当前草稿
 * @param {Array<{kind:'store',mediaType:string,data:string}>} [input.images]
 * @param {string} [input.requestId] 前端单飞标识；缺省自动生成
 * @param {object} [options] `{ transport, fetchImpl, getAuthorization, endpoint, baseUrl, timeoutMs, delayMs, signal }`
 * @returns {Promise<{requestId:string, templateId:string, contractVersion:string, turnId:string,
 *   reply:string, patch:object, changes:Array, meta:object, appliedChanges:Array}>}
 *
 * 失败时抛出经过中文文案映射的 `AgentTurnError`，调用方派发 `TEMPLATE_REVISE_FAILURE`。
 */
export async function requestTemplateRevise(input = {}, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const settings = options && typeof options === 'object' ? options : {};
  const requestId = typeof source.requestId === 'string' && source.requestId.trim()
    ? source.requestId.trim()
    : createReviseRequestId();

  let request;
  try {
    request = buildTemplateReviseRequest(source);
  } catch (error) {
    throw mapTemplateReviseError(error);
  }

  let transport;
  try {
    transport = resolveTransport(settings.transport, settings);
  } catch (error) {
    throw mapTemplateReviseError(error);
  }

  try {
    const rawResponse = await transport.send(request, {
      requestId,
      signal: settings.signal,
    });

    // 注入的自定义 transport 可能没做字段校验，这里再兜一次。
    const response = validateTemplateReviseResponse(rawResponse);
    const context = buildTemplateRevisePatchContext(request);
    const validated = validatePresentationPatch(response.patch, context);

    if (!validated.ok) {
      const detail = Array.isArray(validated.details) ? validated.details[0] : null;
      throw createAgentTurnError('AGENT_RESPONSE_INVALID', {
        message: detail?.message || '服务端补丁未通过前端校验。',
        requestId,
        details: validated.details,
      });
    }

    const appliedChanges = diffPresentationPatch(request.basePatch ?? {}, validated.patch, context);
    // 服务端 changes 是契约要求的展示来源；appliedChanges 是前端复核结果，供 UI 兜底比对。
    const changes = Array.isArray(response.changes) && response.changes.length
      ? response.changes
      : diffPresentationPatch(request.basePatch ?? {}, validated.patch, context);

    return {
      requestId,
      templateId: request.candidate.templateId,
      contractVersion: response.contractVersion,
      turnId: response.turnId,
      reply: response.reply,
      patch: validated.patch,
      changes,
      meta: response.meta,
      appliedChanges,
    };
  } catch (error) {
    throw mapTemplateReviseError(error);
  }
}

/** 给 UI 用：当前模板修改通道是否处于 Mock 演示模式。 */
export function describeTemplateReviseTransport() {
  const config = getTemplateReviseConfig();
  return {
    mode: config.mode,
    mock: config.mode !== 'http',
    label: config.mode === 'http'
      ? 'DeepSeek 后端（真实模型）'
      : '本地 Mock 演示（未接入真实模型）',
  };
}