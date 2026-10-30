import {
  AGENT_CONTRACT_VERSION,
  AGENT_ENDPOINT,
  AGENT_TIMEOUT_MS,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';

const ALLOWED_STATUS = new Set(['collecting', 'reviewing']);

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

function validateResponseShape(body) {
  assertShape(body.contractVersion === AGENT_CONTRACT_VERSION, '契约版本不一致。');
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
}

export function createHttpTransport(options = {}) {
  const fetchImpl = options.fetchImpl;
  const endpoint = options.endpoint ?? AGENT_ENDPOINT;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : AGENT_TIMEOUT_MS;
  const getAuthorization = typeof options.getAuthorization === 'function'
    ? options.getAuthorization
    : () => null;

  return {
    name: 'http',
    async send(request, context = {}) {
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
          'X-Agent-Contract': AGENT_CONTRACT_VERSION,
        };
        if (typeof authorization === 'string' && authorization.trim()) {
          headers.Authorization = authorization;
        }

        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers,
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
            message: status === 401 || status === 403 ? '登录状态已失效，请重新登录后再试。' : undefined,
          });
        }

        if (!isPlainObject(body)) {
          throw createAgentTurnError('AGENT_RESPONSE_INVALID');
        }
        if (body.contractVersion !== AGENT_CONTRACT_VERSION) {
          throw createAgentTurnError('AGENT_CONTRACT_MISMATCH');
        }
        validateResponseShape(body);
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