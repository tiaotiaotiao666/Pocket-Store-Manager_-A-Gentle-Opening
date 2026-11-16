/**
 * P3：参考截图识别服务（`screen-reference.v1`）。
 *
 * 复用点：
 * - 同一端点 `/api/v1/agent/turn`、同一鉴权、同一超时与错误归一化
 *   （`agentServiceConfig` / `agentTurnError`），与 agent-turn.v2 图片路由同源；
 * - 图片仍走 base64 + `images[]` 结构，服务端复用同一套图片校验器。
 *
 * 边界：
 * - 请求里只带白名单目录（`catalog`），模型只能从里面挑 id；
 * - 响应必须再本地过一遍白名单，未知 id 进「未采纳」；
 * - mock / 无视觉能力时如实返回 degraded，不伪造识别结果。
 */

import { buildAgentRequestUrl, getAgentTransportConfig } from './agentServiceConfig.js';
import { normalizeAgentTurnError } from './agentTurnError.js';
import {
  SCREEN_REFERENCE_CONTRACT,
  SCREEN_REFERENCE_LIMITS,
  buildScreenReferenceCatalog,
  parseScreenReferenceResponse,
  validateReferenceImage,
} from '../../domain/screenReference.mjs';

const RECOGNITION_INSTRUCTION = [
  '参考截图分析：请只做布局与组件识别，不要复刻对方文案、图片或品牌素材。',
  '只能从给定的 layouts / components / style 白名单中选择 id；无法支持的部分写进 unsupported。',
  '返回 JSON：{"layouts":[],"components":[],"style":{"theme":{},"sizes":{}},"approximate":[],"unsupported":[],"notes":""}。',
].join('\n');

export const SCREEN_REFERENCE_ENDPOINT = '/api/v1/agent/turn';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createScreenReferenceRequestId(now = Date.now(), random = Math.random) {
  const tail = Math.floor(random() * 1e9).toString(36);
  return `sr-${now.toString(36)}-${tail}`;
}

export function buildScreenReferenceRequest({ image, draft, requestId }) {
  return {
    contractVersion: SCREEN_REFERENCE_CONTRACT,
    utterance: RECOGNITION_INSTRUCTION,
    draft: draft ?? { storeName: '', category: '', businessHours: '', fulfillment: { dineIn: false, takeaway: false }, dishes: [] },
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
    catalog: buildScreenReferenceCatalog(),
    images: [{
      kind: 'reference',
      mediaType: image.mediaType,
      dataBase64: image.dataBase64,
    }],
    catalogVersion: buildScreenReferenceCatalog().version,
    requestId,
  };
}

/**
 * 识别一张参考截图。
 *
 * @returns {Promise<{ok: true, recognition, meta} | {ok: false, code, message, degraded?}>}
 */
export async function requestScreenReference(params = {}) {
  const { image, draft, requestId, fetchImpl, getAuthorization, signal } = params;
  const validation = validateReferenceImage(image);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message, degraded: false };
  }

  const config = getAgentTransportConfig();
  if (config.mode === 'mock') {
    // 本地模拟模式没有视觉能力：如实降级，不用假数据顶替。
    return {
      ok: false,
      code: 'SCREEN_REF_VISION_UNAVAILABLE',
      degraded: true,
      message: '当前是本地模拟模式，没有真实图片识别能力；请在设置里接入后端后重试。',
    };
  }

  const body = buildScreenReferenceRequest({ image, draft, requestId });
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30000;
  const timer = controller && typeof setTimeout === 'function'
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  if (controller && signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const doFetch = typeof fetchImpl === 'function'
      ? fetchImpl
      : (url, init) => fetch(url, init);
    let authorization = '';
    if (typeof getAuthorization === 'function') {
      authorization = await getAuthorization();
    }
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'X-Agent-Contract': SCREEN_REFERENCE_CONTRACT,
    };
    if (typeof authorization === 'string' && authorization.trim()) {
      headers.Authorization = authorization;
    }
    // 请求号放在 body 里，不额外加自定义头：与后端 CORS allowedHeaders 白名单保持一致。

    let response;
    try {
      response = await doFetch(buildAgentRequestUrl(config.baseUrl, SCREEN_REFERENCE_ENDPOINT), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      const normalized = normalizeAgentTurnError(error);
      return {
        ok: false,
        code: normalized.code || 'SCREEN_REF_NETWORK_FAILED',
        degraded: false,
        message: '没能连上识别服务，检查后端是否已启动后重试。',
      };
    }

    let payload = null;
    if (typeof response.text === 'function') {
      const text = await response.text().catch(() => '');
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = null;
        }
      }
    }

    if (!response.ok) {
      const status = Number(response.status);
      if (status === 413) {
        return { ok: false, code: 'SCREEN_REF_IMAGE_TOO_LARGE', degraded: false, message: '截图太大了，请压到 400KB 以内再上传。' };
      }
      if (status === 502 && isPlainObject(payload) && payload.code === 'DEEPSEEK_VISION_UNAVAILABLE') {
        return {
          ok: false,
          code: 'SCREEN_REF_VISION_UNAVAILABLE',
          degraded: true,
          message: '图片识别服务当前不可用（上游视觉模型返回 502），这次没有识别结果，也没有生成候选模板。',
        };
      }
      return {
        ok: false,
        code: 'SCREEN_REF_HTTP_' + status,
        degraded: status >= 500,
        message: '识别服务返回异常（HTTP ' + status + '），可以稍后重试。',
      };
    }

    if (!isPlainObject(payload)) {
      return { ok: false, code: 'SCREEN_REF_RESPONSE_INVALID', degraded: false, message: '识别结果无法解析，没有改动你的项目。' };
    }

    const parsed = parseScreenReferenceResponse(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        code: parsed.code,
        degraded: Boolean(parsed.degraded),
        message: parsed.message,
      };
    }
    return { ok: true, recognition: parsed.recognition, meta: parsed.meta };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { SCREEN_REFERENCE_LIMITS };
