import {
  AGENT_CONTRACT_VERSION,
  buildAgentRequestUrl,
  getAgentTransportConfig,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';

const ALLOWED_STATUS = new Set(['collecting', 'reviewing']);

/**
 * `agent-turn.v2` 契约（plan.md 2.2.7）。
 *
 * 注意：v2 常量刻意定义在本文件内，避免修改 `agentServiceConfig.js`
 * （该文件由模板修改任务独占）。`agentServiceConfig.AGENT_CONTRACT_VERSION`
 * 仍是 v1，保证未传 images 的旧调用行为不变。
 */
export const AGENT_TURN_V1_CONTRACT_VERSION = AGENT_CONTRACT_VERSION;
export const AGENT_TURN_V2_CONTRACT_VERSION = 'agent-turn.v2';

const SUPPORTED_CONTRACT_VERSIONS = new Set([
  AGENT_TURN_V1_CONTRACT_VERSION,
  AGENT_TURN_V2_CONTRACT_VERSION,
]);

/** 413 的统一可读文案（plan.md T5 验收 6）。 */
const BODY_TOO_LARGE_MESSAGE = '图片过大，请压缩后重试。';
const IMAGE_REJECTED_MESSAGE = '图片未通过服务端校验，请重新选择后重试。';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readResponseBody(response) {
  if (typeof response.text !== 'function') return null;
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

function assertShape(condition, message) {
  if (!condition) {
    throw createAgentTurnError('AGENT_RESPONSE_INVALID', { message });
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateVisionShape(vision) {
  assertShape(vision === null || isPlainObject(vision), '响应 vision 格式不合法。');
  if (vision === null) return;
  assertShape(isNonNegativeInteger(vision.menuImages), '响应 vision.menuImages 不合法。');
  assertShape(isNonNegativeInteger(vision.storeImages), '响应 vision.storeImages 不合法。');
  assertShape(typeof vision.analyzed === 'boolean', '响应 vision.analyzed 不合法。');
  assertShape(typeof vision.degraded === 'boolean', '响应 vision.degraded 不合法。');
}

function validateResponseShape(body, contractVersion) {
  assertShape(body.contractVersion === contractVersion, '契约版本不一致。');
  assertShape(typeof body.turnId === 'string' && body.turnId.length > 0, '响应缺少 turnId。');
  assertShape(ALLOWED_STATUS.has(body.status), '响应状态不合法。');
  assertShape(typeof body.reply === 'string' && body.reply.trim().length > 0, '响应缺少回复内容。');
  assertShape(isPlainObject(body.draft), '响应缺少草稿。');
  assertShape(isPlainObject(body.meta), '响应缺少元信息。');
  assertShape(Array.isArray(body.missingFields), '响应缺少缺项列表。');
  assertShape(Array.isArray(body.errors), '响应缺少错误列表。');
  assertShape(body.nextQuestion === null || isPlainObject(body.nextQuestion), '响应追问格式不合法。');

  const draft = body.draft;
  assertShape(typeof draft.storeName === 'string', '草稿店名格式不合法。');
  assertShape(Array.from(draft.storeName).length <= 48, '草稿店名超长。');
  assertShape(typeof draft.category === 'string' && Array.from(draft.category).length <= 24, '草稿品类格式不合法。');
  assertShape(typeof draft.businessHours === 'string', '草稿营业时间格式不合法。');
  assertShape(isPlainObject(draft.fulfillment), '草稿取餐方式格式不合法。');
  assertShape(typeof draft.fulfillment.dineIn === 'boolean' && typeof draft.fulfillment.takeaway === 'boolean', '草稿取餐方式类型不合法。');
  assertShape(Array.isArray(draft.dishes) && draft.dishes.length <= 5, '草稿菜品数量越界。');
  for (const dish of draft.dishes) {
    assertShape(isPlainObject(dish), '菜品格式不合法。');
    assertShape(typeof dish.id === 'string' && dish.id.length > 0 && dish.id.length <= 32, '菜品 id 格式不合法。');
    assertShape(typeof dish.name === 'string' && Array.from(dish.name).length <= 24, '菜品名称格式不合法。');
    assertShape(dish.priceCents === null || Number.isInteger(dish.priceCents), '菜品价格必须是整数分或 null。');
    assertShape(typeof dish.description === 'string' && Array.from(dish.description).length <= 60, '菜品描述格式不合法。');
  }

  // v1 响应没有 vision 字段；v2 允许 null 或对象。v1 请求出现 vision 也不拒绝，
  // 保持「响应形状对 v1 调用方透明」的旧语义。
  if (contractVersion === AGENT_TURN_V2_CONTRACT_VERSION) {
    assertShape(Object.prototype.hasOwnProperty.call(body, 'vision'), '响应缺少 vision。');
    validateVisionShape(body.vision);
  }
}

function resolveContractVersion(request) {
  const raw = request && typeof request === 'object' ? request.contractVersion : undefined;
  if (raw === undefined || raw === null || raw === '') return AGENT_TURN_V1_CONTRACT_VERSION;
  if (SUPPORTED_CONTRACT_VERSIONS.has(raw)) return raw;
  throw createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
    message: '客户端与服务端契约版本不一致，请更新应用。',
  });
}

function buildHttpErrorMessage(status, body, contractVersion) {
  if (status === 413) return BODY_TOO_LARGE_MESSAGE;
  if (status === 401 || status === 403) return '登录状态已失效，请重新登录后再试。';
  if (status === 422 && contractVersion === AGENT_TURN_V2_CONTRACT_VERSION) {
    const serverMessage = isPlainObject(body) && typeof body.message === 'string'
      ? body.message.trim()
      : '';
    return serverMessage || IMAGE_REJECTED_MESSAGE;
  }
  return undefined;
}

export function createHttpTransport(options = {}) {
  const fetchImpl = options.fetchImpl;
  const getAuthorization = typeof options.getAuthorization === 'function'
    ? options.getAuthorization
    : () => null;

  return {
    name: 'http',
    async send(request, context = {}) {
      const config = getAgentTransportConfig();
      const endpoint = options.endpoint ?? config.endpoint;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.timeoutMs;
      const contractVersion = resolveContractVersion(request);

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
          throw createAgentTurnError('AGENT_ABORTED');
        }
        externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
      }

      try {
        const authorization = await getAuthorization();
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          'X-Agent-Contract': contractVersion,
        };
        if (typeof authorization === 'string' && authorization.trim()) {
          headers.Authorization = authorization;
        }

        const requestUrl = buildAgentRequestUrl(config.baseUrl, endpoint);
        let response;
        try {
          response = await fetchImpl(requestUrl, {
            method: 'POST',
            headers,
            // 请求体原样序列化：v1 请求保持旧字段，v2 请求额外携带 images。
            body: JSON.stringify(request),
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOut) throw createAgentTurnError('AGENT_TIMEOUT');
          if (error && error.name === 'AbortError') throw createAgentTurnError('AGENT_ABORTED');
          throw normalizeAgentTurnError(error);
        }

        const body = await readResponseBody(response);
        if (!response.ok) {
          const status = Number(response.status);
          const code = status === 429
            ? 'AGENT_RATE_LIMITED'
            : (status >= 500 ? 'AGENT_HTTP_5XX' : 'AGENT_HTTP_4XX');
          throw createAgentTurnError(code, {
            httpStatus: status,
            serverCode: isPlainObject(body) && typeof body.code === 'string' ? body.code : null,
            requestId: isPlainObject(body) && typeof body.requestId === 'string' ? body.requestId : null,
            message: buildHttpErrorMessage(status, body, contractVersion),
            details: isPlainObject(body)
              ? {
                code: typeof body.code === 'string' ? body.code : null,
                field: typeof body.field === 'string' ? body.field : null,
              }
              : null,
          });
        }

        if (!isPlainObject(body)) {
          throw createAgentTurnError('AGENT_RESPONSE_INVALID');
        }
        if (body.contractVersion !== contractVersion) {
          throw createAgentTurnError('AGENT_CONTRACT_MISMATCH');
        }
        validateResponseShape(body, contractVersion);
        return body;
      } finally {
        clearTimeout(timer);
        if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
          externalSignal.removeEventListener('abort', handleExternalAbort);
        }
      }
    },
  };
}