/**
 * P3：「参考截图 → 候选模板」的领域层。
 *
 * 硬约束（P3 目标 2/3/7/8）：
 * 1. 这是**参考**：只借鉴布局与组件组合，不复制对方源码、文案或品牌素材；
 *    所有展示文案来自本地白名单目录，模型只允许返回 id，不能返回可执行代码/文案。
 * 2. 模型输出必须逐项过白名单：未知 id 一律进「未采纳」，绝不静默接受，
 *    也绝不把模型给的字符串当组件、样式或代码使用。
 * 3. 未经用户确认识别结果，不能生成候选 Recipe（`buildCandidateRecipe` 会拒绝）。
 * 4. 候选 Recipe 只改模板选择与白名单样式参数，门店资料与菜品原样保留；
 *    采用前不覆盖当前版本，放弃可回退。
 * 5. 图片识别不可用时如实降级（`status='degraded'`），不伪造识别结果，
 *    也不把本地规则/演示数据当模型结果。
 */

import { features as catalogFeatures } from './catalog.mjs';
import { RECIPES, RECIPE_VERSION, REGISTRY_VERSION, TEMPLATE_TO_RECIPE } from './recipeCatalog.mjs';
import { SIZE_STEPS, THEME_TOKEN_KEYS } from './presentationPatch.mjs';

export const SCREEN_REFERENCE_CONTRACT = 'screen-reference.v1';

export const SCREEN_REFERENCE_LIMITS = Object.freeze({
  maxImages: 1,
  maxBytes: 409600,
  maxEdgePx: 1600,
  mediaTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  maxNoteChars: 240,
  maxReasonChars: 120,
  maxApproximate: 6,
  maxUnsupported: 8,
});

export const SCREEN_REF_STATUS = Object.freeze({
  IDLE: 'idle',
  RECOGNIZING: 'recognizing',
  READY: 'ready',
  DEGRADED: 'degraded',
  FAILED: 'failed',
});

export const SCREEN_REF_DISCLAIMER = '参考截图生成候选模板：只借鉴布局与组件组合，不复制对方源码、文案或品牌素材。';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 组件/布局的白名单：全部来自本地目录，模型只能引用这些 id。 */
export function buildScreenReferenceCatalog() {
  const recipeIds = Object.keys(RECIPES);
  return {
    version: REGISTRY_VERSION,
    recipeVersion: RECIPE_VERSION,
    recipeIds: Object.freeze(recipeIds.slice()),
    features: Object.freeze(catalogFeatures.map((feature) => Object.freeze({
      id: feature.id,
      label: feature.label,
    }))),
    featureIds: Object.freeze(catalogFeatures.map((feature) => feature.id)),
    themeKeys: Object.freeze(THEME_TOKEN_KEYS.slice()),
    sizeKeys: Object.freeze(SIZE_STEPS.slice()),
  };
}

const CATALOG = buildScreenReferenceCatalog();
const FEATURE_LABEL = new Map(CATALOG.features.map((feature) => [feature.id, feature.label]));
const RECIPE_LABEL = new Map(Object.values(RECIPES).map((recipe) => [recipe.id, recipe.displayName]));

export function recipeLabel(recipeId) {
  return RECIPE_LABEL.get(recipeId) ?? '候选模板';
}

export function featureLabel(featureId) {
  return FEATURE_LABEL.get(featureId) ?? featureId;
}

function cleanText(value, maxChars) {
  const source = typeof value === 'string' ? value : '';
  return source
    .replace(CONTROL_CHARS, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** 单张参考截图的本地校验（与服务端 agent-image.validator 的限宽一致）。 */
export function validateReferenceImage(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) {
    return { ok: false, code: 'SCREEN_REF_IMAGE_INVALID', message: '没有拿到截图，请重新选择一张图片。' };
  }
  const mediaType = typeof image.mediaType === 'string' ? image.mediaType : '';
  if (!SCREEN_REFERENCE_LIMITS.mediaTypes.includes(mediaType)) {
    return { ok: false, code: 'SCREEN_REF_IMAGE_TYPE', message: '只支持 JPG / PNG / WebP 截图。' };
  }
  const data = typeof image.dataBase64 === 'string' ? image.dataBase64 : '';
  if (!data) {
    return { ok: false, code: 'SCREEN_REF_IMAGE_INVALID', message: '截图为空，请重新选择。' };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return { ok: false, code: 'SCREEN_REF_IMAGE_INVALID', message: '截图数据无法解析，请重新选择。' };
  }
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > SCREEN_REFERENCE_LIMITS.maxBytes) {
    return { ok: false, code: 'SCREEN_REF_IMAGE_TOO_LARGE', message: '截图太大了，请压到 400KB 以内再上传。' };
  }
  return { ok: true, code: null, message: '', bytes };
}

/**
 * 严格归一化「识别结果」。
 *
 * 只接受白名单 id；任何未知 id、未知样式键、非 #RRGGBB 颜色都进 `rejected`，
 * 不参与后续 Plan。模型永远不能提供展示文案 —— label 由本地目录决定。
 */
export function normalizeRecognition(raw, catalog = CATALOG) {
  const rejected = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (Object.keys(input).length === 0) {
    rejected.push({ id: 'recognition', reason: '识别结果为空', source: 'model' });
  }

  const recipeIds = new Set(catalog.recipeIds);
  const featureIds = new Set(catalog.featureIds);
  const themeKeys = new Set(catalog.themeKeys);
  const sizeKeys = new Set(catalog.sizeKeys);

  const layouts = [];
  const rawLayouts = Array.isArray(input.layouts) ? input.layouts : [];
  rawLayouts.slice(0, 4).forEach((entry) => {
    const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : '';
    if (!id) return;
    if (!recipeIds.has(id)) {
      rejected.push({ id, reason: '不在已验证布局白名单', source: 'layout' });
      return;
    }
    if (layouts.some((item) => item.id === id)) return;
    layouts.push({ id, label: recipeLabel(id) });
  });

  const components = [];
  const rawComponents = Array.isArray(input.components) ? input.components : [];
  rawComponents.slice(0, 16).forEach((entry) => {
    const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : '';
    if (!id) return;
    if (!featureIds.has(id)) {
      rejected.push({ id, reason: '不在已验证组件白名单', source: 'component' });
      return;
    }
    if (components.some((item) => item.id === id)) return;
    components.push({ id, label: featureLabel(id) });
  });

  const theme = {};
  const sizes = {};
  const rawStyle = input.style && typeof input.style === 'object' && !Array.isArray(input.style) ? input.style : {};
  const rawTheme = rawStyle.theme && typeof rawStyle.theme === 'object' ? rawStyle.theme : {};
  Object.keys(rawTheme).forEach((key) => {
    if (!themeKeys.has(key)) {
      rejected.push({ id: `theme.${key}`, reason: '不在样式白名单', source: 'style' });
      return;
    }
    const value = rawTheme[key];
    if (typeof value !== 'string' || !HEX.test(value)) {
      rejected.push({ id: `theme.${key}`, reason: '颜色必须是 #RRGGBB', source: 'style' });
      return;
    }
    theme[key] = value.toUpperCase();
  });
  const rawSizes = rawStyle.sizes && typeof rawStyle.sizes === 'object' ? rawStyle.sizes : {};
  Object.keys(rawSizes).forEach((key) => {
    if (!['homeHero', 'productCard', 'carousel'].includes(key)) {
      rejected.push({ id: `sizes.${key}`, reason: '不在尺寸白名单', source: 'style' });
      return;
    }
    const value = rawSizes[key];
    if (!sizeKeys.has(value)) {
      rejected.push({ id: `sizes.${key}`, reason: '尺寸只能是 sm/md/lg', source: 'style' });
      return;
    }
    sizes[key] = value;
  });

  const approximate = [];
  (Array.isArray(input.approximate) ? input.approximate : []).slice(0, SCREEN_REFERENCE_LIMITS.maxApproximate).forEach((entry) => {
    const label = cleanText(entry && (entry.label ?? entry.id), SCREEN_REFERENCE_LIMITS.maxReasonChars);
    const reason = cleanText(entry && entry.reason, SCREEN_REFERENCE_LIMITS.maxReasonChars);
    if (!label && !reason) return;
    approximate.push({ label: label || '只能近似的部分', reason: reason || '只能用现有组件近似。' });
  });

  const unsupported = [];
  (Array.isArray(input.unsupported) ? input.unsupported : []).slice(0, SCREEN_REFERENCE_LIMITS.maxUnsupported).forEach((entry) => {
    const label = cleanText(entry && (entry.label ?? entry.id), SCREEN_REFERENCE_LIMITS.maxReasonChars);
    const reason = cleanText(entry && entry.reason, SCREEN_REFERENCE_LIMITS.maxReasonChars);
    if (!label && !reason) return;
    unsupported.push({ label: label || '暂不支持的部分', reason: reason || '当前模板体系里没有对应组件。' });
  });

  rejected.forEach((entry) => {
    if (unsupported.length >= SCREEN_REFERENCE_LIMITS.maxUnsupported) return;
    unsupported.push({ label: entry.id, reason: `${entry.reason}，已跳过。` });
  });

  const recognition = {
    layouts,
    components,
    style: { theme, sizes },
    approximate,
    unsupported,
    rejected,
    notes: cleanText(input.notes, SCREEN_REFERENCE_LIMITS.maxNoteChars),
  };
  return recognition;
}

/** 识别结果是否足以形成候选（至少要认出布局或组件之一）。 */
export function recognitionUsable(recognition) {
  if (!recognition) return false;
  return (Array.isArray(recognition.layouts) && recognition.layouts.length > 0)
    || (Array.isArray(recognition.components) && recognition.components.length > 0);
}

/**
 * 面板视图模型：把识别结果整理成「可复用 / 只能近似 / 不支持」三组。
 */
export function buildRecognitionView(recognition) {
  const safe = recognition ?? { layouts: [], components: [], style: { theme: {}, sizes: {} }, approximate: [], unsupported: [], rejected: [], notes: '' };
  const reusable = [
    ...safe.layouts.map((item) => ({ id: item.id, label: item.label, kind: '布局' })),
    ...safe.components.map((item) => ({ id: item.id, label: item.label, kind: '组件' })),
  ];
  return {
    headline: reusable.length
      ? `认出 ${safe.layouts.length} 个可用布局、${safe.components.length} 个可用组件。`
      : '这张截图没有认出可直接复用的布局或组件。',
    disclaimer: SCREEN_REF_DISCLAIMER,
    groups: {
      reusable,
      approximate: safe.approximate.map((item) => ({ label: item.label, reason: item.reason })),
      unsupported: safe.unsupported.map((item) => ({ label: item.label, reason: item.reason })),
    },
    counts: {
      reusable: reusable.length,
      approximate: safe.approximate.length,
      unsupported: safe.unsupported.length,
      rejected: safe.rejected.length,
    },
    styleSummary: describeStyle(safe.style),
    notes: safe.notes,
    canConfirm: recognitionUsable(safe),
    confirmHint: recognitionUsable(safe)
      ? '确认后才会生成候选模板，你在确认前不会改动当前项目。'
      : '识别结果不足以生成候选模板，可以换一张更清晰的首页截图，或手动挑一个现有模板。',
  };
}

export function describeStyle(style) {
  const source = style && typeof style === 'object' ? style : {};
  const theme = source.theme && typeof source.theme === 'object' ? source.theme : {};
  const sizes = source.sizes && typeof source.sizes === 'object' ? source.sizes : {};
  const parts = [];
  const themeKeys = Object.keys(theme);
  if (themeKeys.length) parts.push(`${themeKeys.length} 个主题色`);
  const sizeKeys = Object.keys(sizes);
  if (sizeKeys.length) parts.push(`${sizeKeys.length} 个尺寸档位`);
  return parts.length ? `可沿用的样式：${parts.join('、')}` : '可沿用的样式：无';
}

/**
 * 生成候选 Recipe。**必须先确认识别结果**，否则返回 `{ok:false}`。
 *
 * 候选只携带：模板 id、组件 id 列表、白名单样式参数，以及生成时的门店资料快照。
 * 门店资料与菜品原样保留，不做任何“顺手改写”。
 */
export function buildCandidateRecipe(params = {}) {
  const { recognition, confirmedAt, baseRecipeId, draft, createdAt } = params;
  if (!confirmedAt) {
    return { ok: false, code: 'SCREEN_REF_NOT_CONFIRMED', message: '请先确认识别结果，再生成候选模板。' };
  }
  if (!recognitionUsable(recognition)) {
    return { ok: false, code: 'SCREEN_REF_RECOGNITION_EMPTY', message: '识别结果不足，无法生成候选模板。' };
  }
  const recipeIds = new Set(CATALOG.recipeIds);
  const recipeId = recipeIds.has(baseRecipeId)
    ? baseRecipeId
    : (recognition.layouts[0] && recipeIds.has(recognition.layouts[0].id)
      ? recognition.layouts[0].id
      : CATALOG.recipeIds[0]);

  const featureIds = recognition.components.map((item) => item.id);
  const style = {
    theme: { ...recognition.style.theme },
    sizes: { ...recognition.style.sizes },
  };
  const store = draft && typeof draft === 'object' ? draft : {};
  const candidate = {
    id: `candidate-${createdAt || 'local'}`,
    recipeId,
    recipeLabel: recipeLabel(recipeId),
    featureIds,
    presentation: style,
    storeSnapshot: {
      storeName: typeof store.storeName === 'string' ? store.storeName : '',
      category: typeof store.category === 'string' ? store.category : '',
      businessHours: typeof store.businessHours === 'string' ? store.businessHours : '',
      dishes: Array.isArray(store.dishes) ? store.dishes.map((dish) => ({ ...dish })) : [],
    },
    approximate: recognition.approximate.map((item) => ({ ...item })),
    unsupported: recognition.unsupported.map((item) => ({ ...item })),
    source: 'screen-reference',
    createdAt: createdAt || null,
  };
  return { ok: true, candidate };
}

/**
 * 候选 → 会话补丁（采用时由 reducer 应用，只动模板与白名单样式）。
 *
 * 注意：`build.selectedId` 在既有模型里是**模板 id**（模板页选的那个），
 * Recipe 由 `TEMPLATE_TO_RECIPE` 反查，所以这里必须转成模板 id，
 * 否则 `buildPlanFromSession` 会回退到默认 Recipe。
 */
export function templateIdForRecipe(recipeId) {
  const matched = Object.keys(TEMPLATE_TO_RECIPE).find((templateId) => TEMPLATE_TO_RECIPE[templateId] === recipeId);
  return matched ?? null;
}

export function candidateToSessionPatch(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const presentation = { theme: {}, sizes: {} };
  const style = candidate.presentation && typeof candidate.presentation === 'object' ? candidate.presentation : {};
  Object.keys(style.theme ?? {}).forEach((key) => {
    if (CATALOG.themeKeys.includes(key) && HEX.test(style.theme[key])) {
      presentation.theme[key] = String(style.theme[key]).toUpperCase();
    }
  });
  Object.keys(style.sizes ?? {}).forEach((key) => {
    if (['homeHero', 'productCard', 'carousel'].includes(key) && CATALOG.sizeKeys.includes(style.sizes[key])) {
      presentation.sizes[key] = style.sizes[key];
    }
  });
  const recipeId = CATALOG.recipeIds.includes(candidate.recipeId) ? candidate.recipeId : null;
  return {
    selectedId: recipeId ? templateIdForRecipe(recipeId) : null,
    recipeId,
    featureIds: Array.isArray(candidate.featureIds)
      ? candidate.featureIds.filter((id) => CATALOG.featureIds.includes(id))
      : [],
    presentation: {
      theme: presentation.theme,
      sizes: presentation.sizes,
    },
  };
}

/** 服务端 `screen-reference.v1` 响应 → 面板可用的结果。 */
export function parseScreenReferenceResponse(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (input.contractVersion !== undefined && input.contractVersion !== SCREEN_REFERENCE_CONTRACT) {
    return {
      ok: false,
      code: 'SCREEN_REF_CONTRACT_MISMATCH',
      message: '服务端返回的识别契约与请求不一致，请升级后再试。',
    };
  }
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
  // 服务端明确说“没看成图”，就如实降级，绝不用别的东西顶替。
  if (input.status === 'unavailable' || meta.analyzed === false) {
    return {
      ok: false,
      code: 'SCREEN_REF_VISION_UNAVAILABLE',
      degraded: true,
      message: '当前模型读不了这张图（图片识别服务未就绪），所以没有识别结果，也不会生成候选模板。',
      unsupported: normalizeRecognition(input.recognition ?? {}).unsupported,
    };
  }
  const recognition = normalizeRecognition(input.recognition ?? {}, CATALOG);
  return {
    ok: true,
    recognition,
    meta: {
      model: typeof meta.model === 'string' ? meta.model : '',
      latencyMs: Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
      analyzed: meta.analyzed === true,
      runId: typeof meta.runId === 'string' ? meta.runId : '',
    },
  };
}

/**
 * 面板总视图模型。`slice` 就是 `state.screenRef`。
 */
export function buildScreenRefView(slice) {
  const source = slice && typeof slice === 'object' ? slice : {};
  const status = Object.values(SCREEN_REF_STATUS).includes(source.status)
    ? source.status
    : SCREEN_REF_STATUS.IDLE;
  const recognition = source.recognition ?? null;
  const recognitionView = recognition ? buildRecognitionView(recognition) : null;
  const candidate = source.candidate ?? null;
  const adopted = Boolean(source.adopted);

  let tone = 'idle';
  let title = '还没上传截图';
  let body = '上传一张别人的小程序首页截图，我们先说明能借鉴什么、哪些只能近似、哪些做不到。';
  if (status === SCREEN_REF_STATUS.RECOGNIZING) {
    tone = 'running';
    title = '正在识别截图';
    body = '正在读布局与组件；识别完成前不会改动你的项目。';
  } else if (status === SCREEN_REF_STATUS.READY) {
    tone = 'ready';
    title = '识别完成，待你确认';
    body = '确认后才会生成候选模板；不确认就什么都不改。';
  } else if (status === SCREEN_REF_STATUS.DEGRADED) {
    tone = 'degraded';
    title = '没能完成识别';
    body = source.error || '这张截图没有得到可用识别结果，可以换一张更清晰的首页截图。';
  } else if (status === SCREEN_REF_STATUS.FAILED) {
    tone = 'failed';
    title = '识别失败';
    body = source.error || '识别没有成功，可以直接重试，或手动挑一个现有模板。';
  }

  return {
    status,
    tone,
    title,
    body,
    disclaimer: SCREEN_REF_DISCLAIMER,
    image: source.image
      ? { name: source.image.name || '参考截图', mediaType: source.image.mediaType || '', previewUrl: source.image.previewUrl || '' }
      : null,
    recognition: recognitionView,
    confirmed: Boolean(source.confirmedAt),
    confirmable: Boolean(recognitionView && recognitionView.canConfirm && status === SCREEN_REF_STATUS.READY),
    candidate: candidate
      ? {
        id: candidate.id,
        label: candidate.recipeLabel,
        components: candidate.featureIds.map((id) => featureLabel(id)),
        styleSummary: describeStyle(candidate.presentation),
        approximate: candidate.approximate?.length ?? 0,
        unsupported: candidate.unsupported?.length ?? 0,
        preservedDishes: candidate.storeSnapshot?.dishes?.length ?? 0,
        preservedStoreName: candidate.storeSnapshot?.storeName || '',
      }
      : null,
    adopted,
    canAdopt: Boolean(candidate) && !adopted,
    canDiscard: Boolean(candidate),
    canRetry: status === SCREEN_REF_STATUS.FAILED || status === SCREEN_REF_STATUS.DEGRADED,
  };
}
