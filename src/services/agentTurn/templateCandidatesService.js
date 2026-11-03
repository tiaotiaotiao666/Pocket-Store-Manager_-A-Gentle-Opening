/**
 * 「模板候选推荐」服务（契约 `agent-template-candidates.v1`，plan.md 2.2.9）。
 *
 * 职责边界：
 * 1. 按契约精确构造请求体（字段名、类型、上限、去重）；
 * 2. 逐项校验响应：恰好 3 个已知模板 ID、互不重复、每个 ID 一条 ≤80 码点理由、
 *    `meta.mock` 必须为 false（Mock 响应不得冒充模型成功）；
 * 3. 提供 HTTP transport，并把失败映射成中文可读原因，交由 `agentService`
 *    决定是否降级到本地确定性排序。
 *
 * 本模块不做业务排序、不计算 score、不修改前端状态。
 */

import { templates as catalogTemplates } from '../../domain/catalog.mjs';
import {
  buildAgentRequestUrl,
  getAgentTransportConfig,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';

export const TEMPLATE_CANDIDATES_CONTRACT_VERSION = 'agent-template-candidates.v1';

/** 端点与 agent-turn / template-revise 独立，避免请求被路由到别的轮次。 */
export const DEFAULT_TEMPLATE_CANDIDATES_ENDPOINT = '/api/v1/agent/template-candidates';

/** 2.2.9 上限：selectedFeatures 0..11、brief 0..500、理由 ≤80、结果恰好 3 条。 */
export const TEMPLATE_CANDIDATES_LIMITS = Object.freeze({
  maxSelectedFeatures: 11,
  maxBrief: 500,
  maxReason: 80,
  expectedCount: 3,
});

/** 已知模板 ID；从 catalog 派生，保证与 3 套模板永远一致。 */
export const KNOWN_TEMPLATE_IDS = Object.freeze(catalogTemplates.map((template) => template.id));

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(text) {
  return [...String(text ?? '')].length;
}

function requestFailure(message, path = '') {
  return createAgentTurnError('AGENT_REQUEST_INVALID', {
    message,
    details: path ? [{ path, code: 'AGENT_REQUEST_INVALID', message }] : null,
  });
}

function responseFailure(message) {
  return createAgentTurnError('AGENT_RESPONSE_INVALID', { message: `响应字段不合法：${message}` });
}

/**
 * 构造 `agent-template-candidates.v1` 请求体。
 *
 * @param {object} input
 * @param {string[]} [input.selectedFeatures] 0..11 个功能 id
 * @param {string} [input.brief] 0..500 码点自然语言描述
 * @returns {{contractVersion:string, selectedFeatures:string[], brief:string,
 *   client:{surface:'desktop', phase:'template-pick'}, projectId:null}}
 */
export function buildTemplateCandidatesRequest(input = {}) {
  const source = isPlainObject(input) ? input : {};

  const rawFeatures = source.selectedFeatures === undefined ? [] : source.selectedFeatures;
  if (!Array.isArray(rawFeatures)) {
    throw requestFailure('selectedFeatures 必须是数组。', 'selectedFeatures');
  }
  if (rawFeatures.length > TEMPLATE_CANDIDATES_LIMITS.maxSelectedFeatures) {
    throw requestFailure(`selectedFeatures 最多 ${TEMPLATE_CANDIDATES_LIMITS.maxSelectedFeatures} 项。`, 'selectedFeatures');
  }
  const seen = new Set();
  const selectedFeatures = [];
  rawFeatures.forEach((feature, index) => {
    if (typeof feature !== 'string') {
      throw requestFailure('功能 ID 必须是字符串。', `selectedFeatures[${index}]`);
    }
    const id = feature.trim();
    if (!id) throw requestFailure('功能 ID 不能为空。', `selectedFeatures[${index}]`);
    if (seen.has(id)) return;
    seen.add(id);
    selectedFeatures.push(id);
  });

  const rawBrief = source.brief === undefined ? '' : source.brief;
  if (typeof rawBrief !== 'string') {
    throw requestFailure('brief 必须是字符串。', 'brief');
  }
  const brief = rawBrief.trim();
  if (codePointLength(brief) > TEMPLATE_CANDIDATES_LIMITS.maxBrief) {
    throw requestFailure(`描述最多 ${TEMPLATE_CANDIDATES_LIMITS.maxBrief} 个字。`, 'brief');
  }

  return {
    contractVersion: TEMPLATE_CANDIDATES_CONTRACT_VERSION,
    selectedFeatures,
    brief,
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  };
}

function assertResponse(condition, message) {
  if (!condition) throw responseFailure(message);
}

/**
 * 校验 `agent-template-candidates.v1` 响应。
 *
 * 契约版本不一致单独抛 `AGENT_CONTRACT_MISMATCH`，其余字段问题抛 `AGENT_RESPONSE_INVALID`。
 * 只要有一个 ID 未知 / 重复 / 数量不是 3 / 理由缺失或超长，就整份拒绝，
 * 不允许“部分采用”——否则前端会拿到半份模型结果。
 *
 * @returns 原样返回通过校验的响应体
 */
export function validateTemplateCandidatesResponse(body) {
  assertResponse(isPlainObject(body), '响应必须是 JSON 对象。');
  if (body.contractVersion !== TEMPLATE_CANDIDATES_CONTRACT_VERSION) {
    throw createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
      message: '模板推荐契约版本不一致，请更新应用。',
    });
  }

  assertResponse(typeof body.turnId === 'string' && body.turnId.trim().length > 0, '缺少 turnId。');

  assertResponse(Array.isArray(body.orderedTemplateIds), 'orderedTemplateIds 必须是数组。');
  assertResponse(
    body.orderedTemplateIds.length === TEMPLATE_CANDIDATES_LIMITS.expectedCount,
    `orderedTemplateIds 必须恰好 ${TEMPLATE_CANDIDATES_LIMITS.expectedCount} 个。`,
  );
  const seen = new Set();
  body.orderedTemplateIds.forEach((rawId, index) => {
    assertResponse(typeof rawId === 'string' && rawId.trim().length > 0, `orderedTemplateIds[${index}] 必须是字符串。`);
    const id = rawId.trim();
    assertResponse(KNOWN_TEMPLATE_IDS.includes(id), `orderedTemplateIds[${index}] 不是已知模板。`);
    assertResponse(!seen.has(id), `orderedTemplateIds 存在重复模板：${id}。`);
    seen.add(id);
  });

  assertResponse(isPlainObject(body.reasons), 'reasons 必须是对象。');
  for (const rawId of body.orderedTemplateIds) {
    const id = rawId.trim();
    const reason = body.reasons[id];
    assertResponse(typeof reason === 'string', `reasons.${id} 必须是字符串。`);
    const trimmed = reason.trim();
    assertResponse(trimmed.length > 0, `reasons.${id} 不能为空。`);
    assertResponse(
      codePointLength(trimmed) <= TEMPLATE_CANDIDATES_LIMITS.maxReason,
      `reasons.${id} 超过 ${TEMPLATE_CANDIDATES_LIMITS.maxReason} 码点。`,
    );
  }

  assertResponse(isPlainObject(body.meta), 'meta 必须是对象。');
  assertResponse(body.meta.transport === 'http', 'meta.transport 必须为 http。');
  assertResponse(typeof body.meta.provider === 'string' && body.meta.provider.length > 0, 'meta.provider 缺失。');
  assertResponse(body.meta.mock === false, 'meta.mock 必须为 false（Mock 响应不能当作模型结果）。');
  assertResponse(body.meta.model === null || typeof body.meta.model === 'string', 'meta.model 类型不合法。');
  assertResponse(
    typeof body.meta.latencyMs === 'number' && Number.isFinite(body.meta.latencyMs) && body.meta.latencyMs >= 0,
    'meta.latencyMs 必须是有限非负数字。',
  );

  return body;
}

async function readResponseBody(response) {
  if (!response || typeof response.text !== 'function') return null;
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/**
 * 把非 2xx 响应映射成带服务端错误码的 `AgentTurnError`。
 * 已知业务码原样保留，未知状态按 HTTP 状态兜底。
 */
export function mapTemplateCandidatesHttpError(status, body, requestId = null) {
  const safeStatus = Number(status) || 0;
  const safeBody = isPlainObject(body) ? body : null;
  const serverCode = safeBody && typeof safeBody.code === 'string' ? safeBody.code : null;
  const serverMessage = safeBody && typeof safeBody.message === 'string' && safeBody.message.trim()
    ? safeBody.message.trim()
    : undefined;
  const serverRequestId = safeBody && typeof safeBody.requestId === 'string' ? safeBody.requestId : requestId;

  if (serverCode === 'DEEPSEEK_NOT_CONFIGURED') {
    return createAgentTurnError('DEEPSEEK_NOT_CONFIGURED', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
    });
  }
  if (serverCode === 'DEEPSEEK_TIMEOUT') {
    return createAgentTurnError('DEEPSEEK_TIMEOUT', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
    });
  }
  if (serverCode === 'DEEPSEEK_RESPONSE_INVALID' || serverCode === 'AGENT_RESPONSE_INVALID') {
    return createAgentTurnError('AGENT_RESPONSE_INVALID', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId,
      message: serverMessage || `响应字段不合法：${serverCode}。`,
    });
  }
  if (serverCode === 'AGENT_REQUEST_INVALID') {
    return createAgentTurnError('AGENT_REQUEST_INVALID', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
    });
  }
  if (serverCode === 'AGENT_CONTRACT_MISMATCH') {
    return createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
    });
  }

  if (safeStatus === 429) {
    return createAgentTurnError('AGENT_RATE_LIMITED', { httpStatus: safeStatus, serverCode, requestId: serverRequestId });
  }
  if (safeStatus === 401 || safeStatus === 403) {
    return createAgentTurnError('AGENT_HTTP_4XX', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId,
      message: '登录状态已失效，请重新登录后再试。',
    });
  }
  if (safeStatus >= 500) {
    return createAgentTurnError('AGENT_HTTP_5XX', {
      httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
    });
  }
  return createAgentTurnError('AGENT_HTTP_4XX', {
    httpStatus: safeStatus, serverCode, requestId: serverRequestId, message: serverMessage,
  });
}

/**
 * 把失败原因翻译成一句中文，供降级提示直接展示（plan.md 2.2.9 语义 3）。
 *
 * @param {unknown} error
 * @param {{degradedSuffix?: string}} [options]
 * @returns {string}
 */
export function describeTemplateCandidatesError(error, options = {}) {
  const suffix = typeof options.degradedSuffix === 'string'
    ? options.degradedSuffix
    : '已切换为本地规则排序';
  const code = error && typeof error.code === 'string' ? error.code : '';
  const status = error && Number.isFinite(error.httpStatus) ? error.httpStatus : null;
  const statusText = status ? `（HTTP ${status}）` : '';

  switch (code) {
    case 'AGENT_TIMEOUT':
    case 'DEEPSEEK_TIMEOUT':
      return `模板推荐请求超时${statusText}，${suffix}。`;
    case 'AGENT_NETWORK':
      return `无法连接模板推荐服务${statusText}，${suffix}。`;
    case 'DEEPSEEK_NOT_CONFIGURED':
      return `后端未配置模型服务${statusText}，${suffix}。`;
    case 'AGENT_RESPONSE_INVALID':
    case 'DEEPSEEK_RESPONSE_INVALID':
      return `模型返回的候选不合法${statusText}，${suffix}。`;
    case 'AGENT_CONTRACT_MISMATCH':
      return `客户端与服务端模板推荐契约版本不一致，${suffix}；请更新应用。`;
    case 'AGENT_RATE_LIMITED':
      return `模板推荐请求过于频繁${statusText}，${suffix}。`;
    case 'AGENT_HTTP_5XX':
      return `模板推荐服务暂时不可用${statusText}，${suffix}。`;
    case 'AGENT_HTTP_4XX':
      return `模板推荐请求未被接受${statusText}，${suffix}。`;
    case 'AGENT_ABORTED':
      return `模板推荐请求已取消，${suffix}。`;
    default: {
      const message = error && typeof error.message === 'string' ? error.message.trim() : '';
      return message ? `${message}（${suffix}）` : `模板推荐失败，${suffix}。`;
    }
  }
}

/**
 * HTTP transport。
 *
 * @param {{fetchImpl?: Function, getAuthorization?: () => (string|null|Promise<string|null>),
 *   endpoint?: string, timeoutMs?: number, baseUrl?: string}} options
 */
export function createTemplateCandidatesTransport(options = {}) {
  const fetchImpl = options.fetchImpl;

  return {
    name: 'http',
    async send(request, context = {}) {
      const config = getAgentTransportConfig();
      const endpoint = options.endpoint ?? DEFAULT_TEMPLATE_CANDIDATES_ENDPOINT;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.timeoutMs;
      const requestId = typeof context.requestId === 'string' ? context.requestId.trim() : '';
      const getAuthorization = typeof options.getAuthorization === 'function'
        ? options.getAuthorization
        : () => null;

      if (typeof fetchImpl !== 'function') {
        throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
          message: 'HTTP transport 需要注入 fetch 实现。',
        });
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const externalSignal = context.signal;
      const handleExternalAbort = () => controller.abort();
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        if (externalSignal.aborted) {
          clearTimeout(timer);
          throw createAgentTurnError('AGENT_ABORTED', { requestId });
        }
        externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
      }

      try {
        const authorization = await getAuthorization();
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          'X-Agent-Contract': TEMPLATE_CANDIDATES_CONTRACT_VERSION,
        };
        if (requestId) headers['X-Agent-Request-Id'] = requestId;
        if (typeof authorization === 'string' && authorization.trim()) {
          headers.Authorization = authorization;
        }

        const requestUrl = buildAgentRequestUrl(options.baseUrl ?? config.baseUrl, endpoint);
        let response;
        try {
          response = await fetchImpl(requestUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOut) throw createAgentTurnError('AGENT_TIMEOUT', { requestId });
          if (error && error.name === 'AbortError') throw createAgentTurnError('AGENT_ABORTED', { requestId });
          throw normalizeAgentTurnError(error);
        }

        const body = await readResponseBody(response);
        if (!response.ok) {
          throw mapTemplateCandidatesHttpError(response.status, body, requestId);
        }
        if (body === null) {
          throw responseFailure('响应不是合法 JSON。');
        }
        return validateTemplateCandidatesResponse(body);
      } finally {
        clearTimeout(timer);
        if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
          externalSignal.removeEventListener('abort', handleExternalAbort);
        }
      }
    },
  };
}

/**
 * 发起一次模板候选推荐请求。
 *
 * 失败时**抛出** `AgentTurnError`（不返回半份结果），由调用方决定降级。
 *
 * @param {{selectedFeatures?: string[], brief?: string}} input
 * @param {{transport?: {send: Function}, fetchImpl?: Function, endpoint?: string, timeoutMs?: number,
 *   baseUrl?: string, getAuthorization?: Function, signal?: AbortSignal, requestId?: string}} [options]
 * @returns {Promise<{orderedTemplateIds: string[], reasons: Record<string,string>,
 *   turnId: string, meta: object}>}
 */
export async function requestTemplateCandidates(input = {}, options = {}) {
  const request = buildTemplateCandidatesRequest(input);
  const transport = options.transport && typeof options.transport.send === 'function'
    ? options.transport
    : createTemplateCandidatesTransport(options);
  const body = await transport.send(request, {
    signal: options.signal,
    requestId: options.requestId,
  });

  // 本地再校验一次：注入的 transport 可能是测试替身或未来的 mock，不能跳过契约。
  validateTemplateCandidatesResponse(body);
  return {
    orderedTemplateIds: body.orderedTemplateIds.map((id) => id.trim()),
    reasons: Object.fromEntries(
      body.orderedTemplateIds.map((id) => [id.trim(), String(body.reasons[id] ?? body.reasons[id.trim()]).trim()]),
    ),
    turnId: body.turnId,
    meta: body.meta,
  };
}