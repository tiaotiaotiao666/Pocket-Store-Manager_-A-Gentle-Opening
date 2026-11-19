import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from '../agentTurn/agentTurnError.js';
import {
  APP_ASSISTANT_CONTRACT_VERSION,
  buildAppAssistantRequestUrl,
  resolveAppAssistantConfig,
} from './appAssistantConfig.js';
import { createAppAssistantError } from './appAssistantError.js';

/**
 * `POST /api/v1/agent/app-assistant` 的桌面 HTTP transport。
 *
 * 只负责发请求、解 JSON 与非 2xx 映射；响应字段的严格校验统一交给
 * `validateAppAssistantResponse`，HTTP 与 direct 走同一个校验器。
 *
 * 安全：Authorization 由调用方按现有方式注入，Key 不落日志、不进错误对象；
 * 不记录请求头与请求体。
 */

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

function httpErrorMessage(status) {
  if (status === 401 || status === 403) return '登录状态已失效，请重新登录后再试。';
  if (status === 413) return '请求内容过大，请压缩图片后重试。';
  if (status === 422) return '请求未通过服务端校验，请检查后重新描述。';
  return undefined;
}

function resolveFetchImpl(options) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return null;
}

export function createHttpAppAssistantTransport(options = {}) {
  const fetchImpl = resolveFetchImpl(options);
  const getAuthorization = typeof options.getAuthorization === 'function'
    ? options.getAuthorization
    : () => null;

  return {
    name: 'http',
    async send(request, context = {}) {
      const config = resolveAppAssistantConfig({
        mode: 'http',
        endpoint: options.endpoint,
        timeoutMs: options.timeoutMs,
      });

      if (typeof fetchImpl !== 'function') {
        throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
          message: 'HTTP 通道需要可用的网络请求实现。',
        });
      }
      const requestId = typeof request.requestId === 'string' ? request.requestId.trim() : '';
      if (!requestId) {
        throw createAppAssistantError('APP_ASSISTANT_REQUEST_INVALID', {
          message: '请求缺少 requestId，未发送。',
        });
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
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
          'X-Agent-Contract': APP_ASSISTANT_CONTRACT_VERSION,
          'X-Agent-Request-Id': requestId,
        };
        if (typeof authorization === 'string' && authorization.trim()) {
          headers.Authorization = authorization;
        }

        let response;
        try {
          response = await fetchImpl(buildAppAssistantRequestUrl(config), {
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
            requestId: isPlainObject(body) && typeof body.requestId === 'string' ? body.requestId : requestId,
            message: httpErrorMessage(status),
          });
        }

        if (!isPlainObject(body)) {
          throw createAppAssistantError('APP_ASSISTANT_RESPONSE_INVALID', {
            message: '服务端返回的不是合法 JSON 对象。',
          });
        }
        if (body.contractVersion !== APP_ASSISTANT_CONTRACT_VERSION) {
          throw createAppAssistantError('APP_ASSISTANT_CONTRACT_MISMATCH');
        }
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