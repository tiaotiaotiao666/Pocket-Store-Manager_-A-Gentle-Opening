/**
 * 「对话修改当前模板」transport（契约 `agent-template-revise.v1`，plan.md 2.2.8）。
 *
 * 本模块只负责三件事：
 * 1. 按契约精确构造请求体（字段名、类型、上限、枚举）；
 * 2. 把 HTTP 响应字段逐项校验，缺失或类型错误统一抛 `AGENT_RESPONSE_INVALID`；
 * 3. 提供确定性的本地 Mock transport，用于没有后端时演示，并显式标记 `meta.mock: true`。
 *
 * 业务编排（前端补丁复核、错误文案映射）放在 templateReviseService.js，避免 transport 直接改 state。
 */

import {
  TEMPLATE_REVISE_CONTRACT_VERSION,
  buildAgentRequestUrl,
  getTemplateReviseConfig,
} from './agentServiceConfig.js';
import {
  createAgentTurnError,
  normalizeAgentTurnError,
} from './agentTurnError.js';
import {
  diffPresentationPatch,
  mergePresentationPatch,
  validatePresentationPatch,
} from '../../domain/presentationPatch.mjs';

export { TEMPLATE_REVISE_CONTRACT_VERSION };

/** 契约上限；与 plan.md 2.2.8 与 2.2.4 保持一致。 */
export const TEMPLATE_REVISE_LIMITS = Object.freeze({
  maxUtterance: 500,
  maxReply: 200,
  maxPlanFeatures: 3,
  maxImages: 1,
  maxChanges: 20,
});

/** 3 套模板与 layout 的固定对应关系（模板总数本轮不变）。 */
export const TEMPLATE_LAYOUTS = Object.freeze({
  'warm-bistro': 'menu',
  'modern-coffee': 'catalog',
  'signature-kitchen': 'editorial',
});

/** 当前唯一可移动 feature；与 2.2.8 注释一致，服务端只接受它。 */
const SUPPORTED_FEATURE_IDS = Object.freeze(['poster-carousel']);

/** 允许的目标插槽 → 所属页面（plan.md 2.2.2 落位表）。 */
const SLOT_PAGE = Object.freeze({
  'home-hero': 'home',
  'home-marketing': 'home',
  'menu-hero': 'menu',
  'menu-aside': 'menu',
});

const IMAGE_MEDIA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** 2.2.8 错误码表 + 2.2.4 补丁错误码，服务端返回时原样透传给 UI 映射。 */
const KNOWN_SERVER_CODES = Object.freeze([
  'AGENT_REQUEST_INVALID',
  'AGENT_BODY_TOO_LARGE',
  'AGENT_CONTRACT_MISMATCH',
  'AGENT_RESPONSE_INVALID',
  'DEEPSEEK_NOT_CONFIGURED',
  'DEEPSEEK_TIMEOUT',
  'DEEPSEEK_RESPONSE_INVALID',
  'DEEPSEEK_VISION_UNAVAILABLE',
  'PRESENTATION_PATCH_INVALID',
  'PATCH_THEME_COLOR_INVALID',
  'PATCH_SLOT_ORDER_UNSUPPORTED',
  'PATCH_SLOT_TARGET_INVALID',
  'PATCH_SIZE_UNSUPPORTED',
  'PATCH_COPY_DISH_UNKNOWN',
]);

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

function isKnownServerCode(code) {
  if (typeof code !== 'string' || !code) return false;
  if (KNOWN_SERVER_CODES.includes(code)) return true;
  return code.startsWith('PATCH_');
}

/**
 * 构造补丁校验上下文（2.2.4）。planFeatures 是「当前 Plan 的真实落位」，
 * 其中 poster-carousel 属于 feature-pack，因此此处直接给出 kind。
 * baseDraft 只需要 dishes 的 id 列表，用于校验 copy.dishes。
 */
export function buildTemplateRevisePatchContext(request = {}) {
  const planFeatures = Array.isArray(request.planFeatures) ? request.planFeatures : [];
  const occupiedFeatures = planFeatures
    .filter((feature) => isPlainObject(feature) && typeof feature.featureId === 'string')
    .map((feature) => ({ id: feature.featureId, kind: 'feature-pack' }));
  const baseDraft = isPlainObject(request.baseDraft) ? request.baseDraft : {};
  return {
    occupiedFeatures,
    hasCarousel: occupiedFeatures.some((feature) => feature.id === 'poster-carousel'),
    baseDraft: { dishes: Array.isArray(baseDraft.dishes) ? baseDraft.dishes : [] },
  };
}

function normalizeCandidate(candidate) {
  if (!isPlainObject(candidate)) {
    throw requestFailure('candidate 必须是对象。', 'candidate');
  }
  const templateId = typeof candidate.templateId === 'string' ? candidate.templateId : '';
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_LAYOUTS, templateId)) {
    throw requestFailure('candidate.templateId 不是已知模板。', 'candidate.templateId');
  }
  const expectedLayout = TEMPLATE_LAYOUTS[templateId];
  const layout = typeof candidate.layout === 'string' ? candidate.layout : expectedLayout;
  if (layout !== expectedLayout) {
    throw requestFailure('candidate.layout 与 templateId 不匹配。', 'candidate.layout');
  }
  return { templateId, layout: expectedLayout };
}

function normalizePlanFeatures(planFeatures) {
  if (planFeatures === undefined || planFeatures === null) return [];
  if (!Array.isArray(planFeatures)) {
    throw requestFailure('planFeatures 必须是数组。', 'planFeatures');
  }
  if (planFeatures.length > TEMPLATE_REVISE_LIMITS.maxPlanFeatures) {
    throw requestFailure('planFeatures 最多 3 条。', 'planFeatures');
  }

  const seen = new Set();
  return planFeatures.map((feature, index) => {
    if (!isPlainObject(feature)) {
      throw requestFailure('planFeatures 每项必须是对象。', `planFeatures[${index}]`);
    }
    const featureId = typeof feature.featureId === 'string' ? feature.featureId : '';
    if (!SUPPORTED_FEATURE_IDS.includes(featureId)) {
      throw requestFailure(`暂不支持的 feature：${featureId || '(空)'}。`, `planFeatures[${index}].featureId`);
    }
    if (seen.has(featureId)) {
      throw requestFailure(`planFeatures 中 feature 重复：${featureId}。`, `planFeatures[${index}].featureId`);
    }
    seen.add(featureId);

    const pageId = typeof feature.pageId === 'string' ? feature.pageId : '';
    const slotId = typeof feature.slotId === 'string' ? feature.slotId : '';
    if (!Object.prototype.hasOwnProperty.call(SLOT_PAGE, slotId)) {
      throw requestFailure(`未知插槽：${slotId || '(空)'}。`, `planFeatures[${index}].slotId`);
    }
    if (SLOT_PAGE[slotId] !== pageId) {
      throw requestFailure(`插槽 ${slotId} 与页面 ${pageId || '(空)'} 不匹配。`, `planFeatures[${index}].pageId`);
    }
    return { featureId, pageId, slotId };
  });
}

function normalizeImages(images) {
  if (images === undefined || images === null) return null;
  if (!Array.isArray(images)) {
    throw requestFailure('images 必须是数组。', 'images');
  }
  if (images.length > TEMPLATE_REVISE_LIMITS.maxImages) {
    throw requestFailure('本轮最多携带 1 张门店环境照。', 'images');
  }
  return images.map((image, index) => {
    if (!isPlainObject(image)) {
      throw requestFailure('images 每项必须是对象。', `images[${index}]`);
    }
    if (image.kind !== 'store') {
      throw requestFailure('本轮只允许门店环境照（kind=store）。', `images[${index}].kind`);
    }
    if (!IMAGE_MEDIA_TYPES.includes(image.mediaType)) {
      throw requestFailure('图片类型不在白名单内。', `images[${index}].mediaType`);
    }
    if (typeof image.data !== 'string' || !image.data) {
      throw requestFailure('图片缺少 base64 数据。', `images[${index}].data`);
    }
    return { kind: 'store', mediaType: image.mediaType, data: image.data };
  });
}

/**
 * 构造 `agent-template-revise.v1` 请求体。
 *
 * 严格按 plan.md 2.2.8 的字段顺序与类型输出，**不附加 requestId 等契约外字段**：
 * requestId 属于前端单飞与晚响应控制（2.3），由 transport 放进 `X-Agent-Request-Id` 请求头，
 * 不污染请求体，服务端也可以忽略它。
 *
 * @param {object} input
 * @param {string} input.utterance 用户一句话（1..500 码点）
 * @param {{templateId: string, layout?: string}} input.candidate 当前候选
 * @param {Array<{featureId:string,pageId:string,slotId:string}>} [input.planFeatures]
 * @param {object} [input.basePatch] 当前已接受补丁
 * @param {object} [input.baseDraft] 当前草稿
 * @param {Array<{kind:'store',mediaType:string,data:string}>} [input.images]
 * @returns {object} 契约请求体
 */
export function buildTemplateReviseRequest(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const utterance = typeof source.utterance === 'string' ? source.utterance.trim() : '';
  if (!utterance) {
    throw requestFailure('请先输入一句修改描述。', 'utterance');
  }
  if (codePointLength(utterance) > TEMPLATE_REVISE_LIMITS.maxUtterance) {
    throw requestFailure(`修改描述最多 ${TEMPLATE_REVISE_LIMITS.maxUtterance} 个字。`, 'utterance');
  }

  const candidate = normalizeCandidate(source.candidate);
  const planFeatures = normalizePlanFeatures(source.planFeatures);

  const basePatch = source.basePatch === undefined ? {} : source.basePatch;
  if (!isPlainObject(basePatch)) {
    throw requestFailure('basePatch 必须是对象。', 'basePatch');
  }

  const baseDraft = source.baseDraft === undefined ? {} : source.baseDraft;
  if (!isPlainObject(baseDraft)) {
    throw requestFailure('baseDraft 必须是对象。', 'baseDraft');
  }

  const images = normalizeImages(source.images);

  const request = {
    contractVersion: TEMPLATE_REVISE_CONTRACT_VERSION,
    utterance,
    candidate,
    planFeatures,
    basePatch,
    baseDraft,
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  };
  if (images && images.length) request.images = images;
  return request;
}

function assertResponse(condition, message) {
  if (!condition) throw responseFailure(message);
}

/**
 * 校验 `agent-template-revise.v1` 响应。
 * 契约版本不一致单独抛 `AGENT_CONTRACT_MISMATCH`，其余字段问题抛 `AGENT_RESPONSE_INVALID`。
 */
export function validateTemplateReviseResponse(body) {
  assertResponse(isPlainObject(body), '响应必须是 JSON 对象。');
  if (body.contractVersion !== TEMPLATE_REVISE_CONTRACT_VERSION) {
    throw createAgentTurnError('AGENT_CONTRACT_MISMATCH', {
      message: '模板修改契约版本不一致，请更新应用。',
    });
  }

  assertResponse(typeof body.turnId === 'string' && body.turnId.trim().length > 0, '缺少 turnId。');
  assertResponse(typeof body.reply === 'string', 'reply 必须是字符串。');
  assertResponse(
    codePointLength(body.reply) >= 1 && codePointLength(body.reply) <= TEMPLATE_REVISE_LIMITS.maxReply,
    `reply 长度必须在 1..${TEMPLATE_REVISE_LIMITS.maxReply} 码点之间。`,
  );
  assertResponse(isPlainObject(body.patch), 'patch 必须是对象。');

  assertResponse(Array.isArray(body.changes), 'changes 必须是数组。');
  assertResponse(body.changes.length <= TEMPLATE_REVISE_LIMITS.maxChanges, 'changes 超过 20 条。');
  body.changes.forEach((item, index) => {
    assertResponse(isPlainObject(item), `changes[${index}] 必须是对象。`);
    assertResponse(typeof item.path === 'string' && item.path.length > 0, `changes[${index}].path 缺失。`);
    assertResponse(typeof item.label === 'string' && item.label.length > 0, `changes[${index}].label 缺失。`);
    assertResponse(
      item.before === null || typeof item.before === 'string',
      `changes[${index}].before 必须是字符串或 null。`,
    );
    assertResponse(
      item.after === null || typeof item.after === 'string',
      `changes[${index}].after 必须是字符串或 null。`,
    );
  });

  assertResponse(isPlainObject(body.meta), 'meta 必须是对象。');
  assertResponse(typeof body.meta.transport === 'string' && body.meta.transport.length > 0, 'meta.transport 缺失。');
  assertResponse(typeof body.meta.provider === 'string' && body.meta.provider.length > 0, 'meta.provider 缺失。');
  assertResponse(typeof body.meta.mock === 'boolean', 'meta.mock 必须是布尔值。');
  assertResponse(body.meta.model === null || typeof body.meta.model === 'string', 'meta.model 类型不合法。');
  assertResponse(
    typeof body.meta.latencyMs === 'number' && Number.isFinite(body.meta.latencyMs) && body.meta.latencyMs >= 0,
    'meta.latencyMs 必须是有限非负数字。',
  );

  return body;
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
 * 把非 2xx 响应映射为带服务端错误码的 `AgentTurnError`。
 * 已知业务码原样保留（UI 再统一换中文文案）；未知码按 HTTP 状态兜底。
 */
export function mapTemplateReviseHttpError(status, body, requestId = null) {
  const safeStatus = Number(status) || 0;
  const safeBody = isPlainObject(body) ? body : null;
  const serverCode = safeBody && typeof safeBody.code === 'string' ? safeBody.code : null;
  const serverMessage = safeBody && typeof safeBody.message === 'string' && safeBody.message.trim()
    ? safeBody.message.trim()
    : undefined;
  const serverRequestId = safeBody && typeof safeBody.requestId === 'string' ? safeBody.requestId : requestId;
  const details = Array.isArray(safeBody?.details) ? safeBody.details : null;

  if (isKnownServerCode(serverCode)) {
    return createAgentTurnError(serverCode, {
      httpStatus: safeStatus,
      serverCode,
      requestId: serverRequestId,
      details,
      message: serverMessage,
    });
  }

  if (safeStatus === 413) {
    return createAgentTurnError('AGENT_BODY_TOO_LARGE', {
      httpStatus: safeStatus,
      serverCode,
      requestId: serverRequestId,
      message: '图片过大，请压缩后重试。',
    });
  }
  if (safeStatus === 429) {
    return createAgentTurnError('AGENT_RATE_LIMITED', { httpStatus: safeStatus, serverCode, requestId: serverRequestId });
  }
  if (safeStatus === 401 || safeStatus === 403) {
    return createAgentTurnError('AGENT_HTTP_4XX', {
      httpStatus: safeStatus,
      serverCode,
      requestId: serverRequestId,
      message: '登录状态已失效，请重新登录后再试。',
    });
  }
  if (safeStatus >= 500) {
    return createAgentTurnError('AGENT_HTTP_5XX', {
      httpStatus: safeStatus,
      serverCode,
      requestId: serverRequestId,
      message: serverMessage,
    });
  }
  return createAgentTurnError('AGENT_HTTP_4XX', {
    httpStatus: safeStatus,
    serverCode,
    requestId: serverRequestId,
    details,
    message: serverMessage,
  });
}

/**
 * HTTP transport。
 *
 * @param {{fetchImpl?: Function, getAuthorization?: () => (string|null|Promise<string|null>),
 *   endpoint?: string, timeoutMs?: number, baseUrl?: string}} options
 */
export function createTemplateReviseHttpTransport(options = {}) {
  const fetchImpl = options.fetchImpl;
  const getAuthorization = typeof options.getAuthorization === 'function'
    ? options.getAuthorization
    : () => null;

  return {
    name: 'http',
    async send(request, context = {}) {
      const config = getTemplateReviseConfig();
      const endpoint = options.endpoint ?? config.endpoint;
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config.timeoutMs;
      const requestId = typeof context.requestId === 'string' ? context.requestId.trim() : '';

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
          'X-Agent-Contract': TEMPLATE_REVISE_CONTRACT_VERSION,
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
          throw mapTemplateReviseHttpError(response.status, body, requestId);
        }
        if (body === null) {
          throw createAgentTurnError('AGENT_RESPONSE_INVALID', {
            message: '响应字段不合法：响应不是合法 JSON。',
            requestId,
          });
        }
        return validateTemplateReviseResponse(body);
      } finally {
        clearTimeout(timer);
        if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
          externalSignal.removeEventListener('abort', handleExternalAbort);
        }
      }
    },
  };
}

function waitDelay(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(createAgentTurnError('AGENT_ABORTED'));
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(createAgentTurnError('AGENT_ABORTED'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const COLOR_HINTS = Object.freeze([
  { pattern: /橙|暖|夕阳|焦糖/, primary: '#E07A3F', accent: '#F2B27A', label: '暖橙色调' },
  { pattern: /绿|森|清爽|抹茶/, primary: '#3F8A6B', accent: '#8FBF9F', label: '植物绿' },
  { pattern: /蓝|海|冷色/, primary: '#3B6EA5', accent: '#7FA6CC', label: '海雾蓝' },
  { pattern: /紫|梦幻/, primary: '#6D5EFC', accent: '#B3AAFF', label: '紫罗兰' },
  { pattern: /红|喜庆|中式/, primary: '#B5544A', accent: '#E2A092', label: '砖红' },
  { pattern: /金|高级|质感/, primary: '#9A7B3F', accent: '#D8BE84', label: '香槟金' },
]);

function extractCopy(utterance) {
  const copy = {};
  const storeName = /(?:店名|店铺名|店铺名称).{0,4}?(?:改成|改为|换成|叫)\s*([^，,。；;\n]{1,24})/.exec(utterance);
  if (storeName) copy.storeName = storeName[1].trim();
  const tagline = /(?:口号|标语|slogan).{0,4}?(?:改成|改为|换成|是)\s*([^，,。；;\n]{1,40})/i.exec(utterance);
  if (tagline) copy.tagline = tagline[1].trim();
  return copy;
}

/**
 * 由一句话生成确定性 Mock 补丁（只做可读、可在 UI 演示的最小改动）。
 * 结果仍会经过 `mergePresentationPatch` + `validatePresentationPatch` 复核。
 */
export function buildMockRevisePatch(request = {}) {
  const utterance = typeof request?.utterance === 'string' ? request.utterance : '';
  const patch = {};
  const labels = [];

  const color = COLOR_HINTS.find((rule) => rule.pattern.test(utterance));
  if (color) {
    patch.theme = { primaryColor: color.primary, accentColor: color.accent };
    labels.push(color.label);
  } else if (/深色|夜间|黑金|暗色/.test(utterance)) {
    patch.theme = { pageBackground: '#171614', textColor: '#F7F3EA', tabBarBackground: '#171614' };
    labels.push('深色夜间主题');
  }

  if (/更大|大气|醒目|放大|再大/.test(utterance)) {
    patch.sizes = { homeHero: 'lg', productCard: 'lg' };
    labels.push('放大首屏与商品卡');
  } else if (/更小|紧凑|简约|缩小/.test(utterance)) {
    patch.sizes = { homeHero: 'sm', productCard: 'sm' };
    labels.push('收紧首屏与商品卡');
  }

  const copy = extractCopy(utterance);
  if (Object.keys(copy).length) {
    patch.copy = copy;
    if (copy.storeName) labels.push(`店名改为「${copy.storeName}」`);
    if (copy.tagline) labels.push(`口号改为「${copy.tagline}」`);
  }

  if (!Object.keys(patch).length) {
    // 兜底：永远给出一个可被契约接受的可见变化，避免 Mock 演示出现“点了没反应”。
    patch.theme = { accentColor: '#E07A3F' };
    labels.push('强调色改为暖橙');
  }

  return { patch, labels };
}

/**
 * 本地 Mock transport：零网络请求、确定性输出，并显式标记 `meta.mock: true`。
 * UI 必须据此显示「本地 Mock 演示」，不得标成真实模型成功。
 */
export function createTemplateReviseMockTransport(options = {}) {
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 360;

  return {
    name: 'mock',
    async send(request, context = {}) {
      const startedAt = Date.now();
      const requestId = typeof context.requestId === 'string' ? context.requestId : null;
      await waitDelay(delayMs, context.signal);

      const patchContext = buildTemplateRevisePatchContext(request);
      const { patch: proposed, labels } = buildMockRevisePatch(request);
      const merged = mergePresentationPatch(request.basePatch ?? {}, proposed, patchContext);
      if (!merged.ok) {
        const detail = Array.isArray(merged.details) ? merged.details[0] : null;
        throw createAgentTurnError('AGENT_RESPONSE_INVALID', {
          message: `响应字段不合法：${detail?.message || 'Mock 补丁未通过校验。'}`,
          requestId,
        });
      }

      const changes = diffPresentationPatch(request.basePatch ?? {}, merged.patch, patchContext);
      const reply = changes.length
        ? `已更新 ${changes.length} 项展示：${labels.join('、')}。`
        : '这一版没有产生可见变化，可以再具体一点。';

      const response = {
        contractVersion: TEMPLATE_REVISE_CONTRACT_VERSION,
        turnId: `mock_${requestId || 'local'}`,
        reply: [...reply].slice(0, TEMPLATE_REVISE_LIMITS.maxReply).join(''),
        patch: merged.patch,
        changes,
        meta: {
          transport: 'mock',
          provider: 'local-mock',
          mock: true,
          model: null,
          latencyMs: Math.max(0, Date.now() - startedAt),
        },
      };
      return validateTemplateReviseResponse(response);
    },
  };
}

/** 供 service 计算「前端复核后的变更清单」时复用。 */
export function diffTemplateReviseChanges(basePatch, nextPatch, context) {
  return diffPresentationPatch(basePatch, nextPatch, context);
}

/** 供 service 校验合并结果时复用（例如后续版本需要前端自行合并）。 */
export function validateTemplateRevisePatch(patch, context) {
  return validatePresentationPatch(patch, context);
}