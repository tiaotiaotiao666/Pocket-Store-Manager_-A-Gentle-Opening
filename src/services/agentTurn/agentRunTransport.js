import {
  AGENT_RUN_CONTRACT_VERSION,
  buildAgentRequestUrl,
  getAgentRunConfig,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';

/**
 * `agent-run.v1` 的薄 HTTP transport。
 *
 * 只做三件事：拼请求头（契约 + requestId）、按独立超时发出请求、校验响应外壳。
 * 不做任何草稿合并、状态判定或工具循环 —— 服务端 Runtime 已经实现，这里不重写。
 *
 * 与 `httpAgentTransport.js` 的差别：
 * - 契约版本固定 `agent-run.v1`，不允许缺省回落到 turn；
 * - 请求体必须携带 `requestId` 头（服务端回写同值，便于排查串联）；
 * - 响应多出 `runId` / `trace` / `meta.mock`，任何一项不合规都整包拒绝，
 *   绝不把 Mock/伪造响应当成真实模型结果呈现给用户。
 */

export const ALLOWED_RUN_STATUS = new Set(['collecting', 'reviewing']);

export const ALLOWED_STOP_REASONS = new Set([
  'final_answer',
  'empty_reply',
  'max_model_calls',
  'max_tool_calls',
  'loop_detected',
  'time_limit',
  'aborted',
]);

/** 与服务端 `request-id.ts` 相同的可见 ASCII 集合，避免任意头内容回写。 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

const DEFAULT_HEADER_NAME = 'X-Request-Id';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertShape(condition, message) {
  if (!condition) {
    throw createAgentTurnError('AGENT_RESPONSE_INVALID', { message });
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function createRunRequestId(random = Math.random) {
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  const stamp = Date.now().toString(36);
  const candidate = `desktop-run-${stamp}-${suffix}`;
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : `desktop-run-${stamp}`.padEnd(8, '0');
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

/**
 * 响应外壳校验（不含草稿语义）。任何失败都抛 `AGENT_RESPONSE_INVALID`。
 * 返回 `{ runId, trace, meta, degraded, stopReason }` 供上层记录。
 */
export function validateAgentRunResponse(body) {
  assertShape(isPlainObject(body), '响应不是 JSON 对象。');
  if (body.contractVersion !== AGENT_RUN_CONTRACT_VERSION) {
    throw createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
      message: `响应契约版本不是 ${AGENT_RUN_CONTRACT_VERSION}，请更新应用或服务端。`,
    });
  }
  assertShape(typeof body.runId === 'string' && body.runId.trim().length > 0, '响应缺少 runId。');
  assertShape(ALLOWED_RUN_STATUS.has(body.status), '响应状态不合法。');
  assertShape(typeof body.reply === 'string' && body.reply.trim().length > 0, '响应缺少回复内容。');
  assertShape(isPlainObject(body.draft), '响应缺少草稿。');
  assertShape(isPlainObject(body.meta), '响应缺少元信息。');
  assertShape(isPlainObject(body.trace), '响应缺少 trace。');

  const { trace, meta } = body;

  assertShape(isNonNegativeInteger(trace.modelCalls), '响应 trace.modelCalls 不合法。');
  assertShape(Array.isArray(trace.toolCalls), '响应 trace.toolCalls 不合法。');
  for (const call of trace.toolCalls) {
    assertShape(isPlainObject(call), '响应 trace.toolCalls 项格式不合法。');
    assertShape(typeof call.name === 'string' && call.name.length > 0, '响应工具名不合法。');
    assertShape(typeof call.ok === 'boolean', '响应 trace.toolCalls[].ok 不合法。');
    assertShape(isNonNegativeInteger(call.latencyMs), '响应 trace.toolCalls[].latencyMs 不合法。');
    assertShape(isNonNegativeInteger(call.attempts), '响应 trace.toolCalls[].attempts 不合法。');
  }
  assertShape(ALLOWED_STOP_REASONS.has(trace.stopReason), '响应 trace.stopReason 不合法。');
  assertShape(typeof trace.degraded === 'boolean', '响应 trace.degraded 不合法。');

  // 真实模型响应必须显式 mock=false：mock=true 的响应是脚本化结果，不能冒充真实模型。
  assertShape(meta.mock === false, '响应来自 Mock，不能作为真实模型结果使用。');
  assertShape(
    typeof meta.runId === 'string' && meta.runId === body.runId,
    '响应 meta.runId 与 runId 不一致。',
  );
  assertShape(isNonNegativeInteger(meta.latencyMs), '响应 meta.latencyMs 不合法。');
  assertShape(typeof meta.model === 'string' && meta.model.trim().length > 0, '响应 meta.model 不合法。');

  const failedTools = trace.toolCalls
    .filter((call) => call.ok !== true)
    .map((call) => call.name);

  return {
    contractVersion: body.contractVersion,
    runId: body.runId,
    status: body.status,
    reply: body.reply,
    draft: body.draft,
    trace,
    meta,
    stopReason: trace.stopReason,
    degraded: trace.degraded === true || failedTools.length > 0,
    failedTools,
    modelCalls: trace.modelCalls,
    toolCallCount: trace.toolCalls.length,
  };
}

function buildHttpError(status, body) {
  const serverMessage = isPlainObject(body) && typeof body.message === 'string'
    ? body.message.trim()
    : '';
  if (status === 413) {
    return { message: '请求内容过大，请精简后重试。' };
  }
  if (status === 401 || status === 403) {
    return { message: serverMessage || '登录状态已失效，请重新登录后再试。' };
  }
  if (status === 429) return { message: serverMessage || undefined };
  if (status === 408) {
    return { message: serverMessage || '请求已被取消。' };
  }
  return { message: serverMessage || undefined };
}

export function createAgentRunTransport(options = {}) {
  const fetchImpl = options.fetchImpl;
  const getAuthorization = typeof options.getAuthorization === 'function'
    ? options.getAuthorization
    : () => null;

  return {
    name: 'agent-run',
    async send(request, context = {}) {
      const config = getAgentRunConfig();
      const endpoint = options.endpoint ?? config.endpoint;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.timeoutMs;
      const headerName = typeof options.requestIdHeader === 'string' && options.requestIdHeader
        ? options.requestIdHeader
        : DEFAULT_HEADER_NAME;

      if (typeof fetchImpl !== 'function') {
        throw createAgentTurnError('AGENT_TRANSPORT_UNKNOWN', {
          message: 'HTTP transport 需要注入 fetch 实现。',
        });
      }
      if (request && request.contractVersion !== AGENT_RUN_CONTRACT_VERSION) {
        throw createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
          message: '客户端与服务端契约版本不一致，请更新应用。',
        });
      }

      const requestId = isValidRequestId(context.requestId)
        ? context.requestId
        : createRunRequestId();

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
          'X-Agent-Contract': AGENT_RUN_CONTRACT_VERSION,
          [headerName]: requestId,
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
          const { message } = buildHttpError(status, body);
          throw createAgentTurnError(code, {
            httpStatus: status,
            serverCode: isPlainObject(body) && typeof body.code === 'string' ? body.code : null,
            requestId: isPlainObject(body) && typeof body.requestId === 'string'
              ? body.requestId
              : requestId,
            message,
            details: isPlainObject(body)
              ? { code: typeof body.code === 'string' ? body.code : null }
              : null,
          });
        }

        if (!isPlainObject(body)) {
          throw createAgentTurnError('AGENT_RESPONSE_INVALID', {
            message: '返回内容无法识别，请重新描述。',
            requestId,
          });
        }

        const validated = validateAgentRunResponse(body);
        return { ...validated, requestId };
      } finally {
        clearTimeout(timer);
        if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
          externalSignal.removeEventListener('abort', handleExternalAbort);
        }
      }
    },
  };
}
