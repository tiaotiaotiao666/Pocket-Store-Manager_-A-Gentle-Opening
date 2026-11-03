/**
 * `image-prompt-spec.v1`（plan.md 2.2.10）的唯一事实与纯函数实现。
 *
 * 约定：
 * 1. 输出是结构化对象（`spec`）+ 由固定段落拼接的 `prompt`
 *    （主体 → 构图 → 色调 → 光源 → 留白 → 禁止项 → 门店事实 → 风格 → 补充要求）；
 * 2. `prompt` 长度 ≤ 1200 码点；超长时只截断「补充要求」，禁止项永远保留；
 * 3. 本模块不发起任何网络请求，也不改变生图 provider 标识；
 * 4. 尺寸比例提示复用 `preview-size-tokens.v1`（plan.md 2.2.1），不另造数值。
 */

import specDoc from '../../templates/image-prompt-spec.v1.json' with { type: 'json' };
import { STYLE_PRESETS } from './storeBrief.mjs';
import { resolveSizeToken } from './previewSizeTokens.mjs';

export const IMAGE_PROMPT_SPEC_CONTRACT = specDoc.contract;
export const IMAGE_PROMPT_SPEC_STATUS = specDoc.status;
export const IMAGE_PROMPT_MAX_LENGTH = specDoc.defaults.maxPromptLength;
export const IMAGE_PROMPT_MAX_EXTRA = specDoc.defaults.maxExtraRequirement;
export const IMAGE_PROMPT_DEFAULT_ASPECT = specDoc.defaults.aspect;

/** 合法 layout；与 3 套模板一一对应。 */
export const IMAGE_PROMPT_LAYOUTS = Object.freeze(Object.keys(specDoc.templates));

/** 每种 layout 的结构化约束（只读引用，禁止调用方改写冻结事实）。 */
export const IMAGE_PROMPT_TEMPLATE_RULES = Object.freeze(specDoc.templates);

/** 尺寸档位 → 画面比例的映射表（plan.md 2.2.10「按尺寸档位附加比例提示」）。 */
export const IMAGE_PROMPT_ASPECT_BY_SIZE = Object.freeze(specDoc.aspectBySize);

/**
 * 任何 layout 的禁止项都必须包含这 4 条。
 * 测试与调用方据此校验 JSON 是否被误改。
 */
export const IMAGE_PROMPT_NEGATIVE_REQUIRED = Object.freeze([
  '不得出现文字/水印',
  '不得出现可识别真人正脸',
  '不得生成二维码',
  '不得出现平台 Logo',
]);

/** 真实生图接入的固定说明；`composePrompt` 的 tips 必须包含它。 */
export const IMAGE_PROMPT_PROVIDER_TIP = '接入真实生图需要服务商/Base URL/模型名/API Key';

export const IMAGE_PROMPT_TIPS = Object.freeze([
  '可以补充店内的代表色',
  '可以指出想突出的招牌菜',
  '可以说明想要的时段氛围（白天 / 夜晚）',
  IMAGE_PROMPT_PROVIDER_TIP,
]);

const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);
const FALLBACK_LAYOUT = 'menu';
const FALLBACK_STYLE_ID = 'warm';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 码点长度（不能用 String.length，中文与 emoji 会算错）。 */
export function codePointLength(text) {
  return [...String(text ?? '')].length;
}

/** 按码点截断，超长时补一个省略号，保证返回值不超过 max。 */
function clip(text, max) {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return chars.join('');
  if (max <= 1) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 解析 layout。
 *
 * 显式传入合法 layout 时直接用；否则按门店类型推导：
 * 咖啡/茶饮/烘焙 → catalog，特色/主厨/烧烤 → editorial，其余 → menu。
 * 推导失败一律回落 menu，并通过 `layoutFallback` 让调用方知道发生过回落。
 */
export function resolveImageLayout(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const explicit = typeof source.layout === 'string' ? source.layout.trim() : '';
  if (IMAGE_PROMPT_LAYOUTS.includes(explicit)) return explicit;

  const profile = isPlainObject(source.storeProfile) ? source.storeProfile : {};
  const type = String(profile.type ?? source.category ?? '').trim();
  if (/咖啡|茶饮|奶茶|烘焙|甜品|轻食|面包/.test(type)) return 'catalog';
  if (/特色|招牌|主厨|宴请|火锅|烧烤|夜宵/.test(type)) return 'editorial';
  return FALLBACK_LAYOUT;
}

function normalizeSizeTokens(input) {
  const source = isPlainObject(input) ? input : {};
  const pick = (...values) => values.find((value) => SIZE_STEPS.includes(value)) || null;
  return {
    homeHero: pick(source.homeHero, source.homeHeroSize) || 'md',
    productCard: pick(source.productCard, source.productCardSize) || 'md',
    // carousel 允许缺省：缺省时只给主视觉比例，不额外编造轮播比例。
    carousel: pick(source.carousel, source.carouselSize),
  };
}

/** 主视觉比例由 homeHero 档位决定，尺寸标签取自共享尺寸表。 */
function resolveAspect(sizes) {
  const table = IMAGE_PROMPT_ASPECT_BY_SIZE.homeHero;
  const step = SIZE_STEPS.includes(sizes.homeHero) ? sizes.homeHero : 'md';
  const entry = table[step] || table.md;
  const resolved = resolveSizeToken('homeHero', step);
  return {
    value: entry.value || IMAGE_PROMPT_DEFAULT_ASPECT,
    hint: entry.hint,
    group: 'homeHero',
    step: resolved.step,
    label: resolved.label,
    px: resolved.px,
    rpx: resolved.rpx,
  };
}

/** 轮播比例（仅当调用方明确给出 carousel 档位时才产出，避免编造）。 */
function resolveCarouselAspect(sizes) {
  if (!sizes.carousel) return null;
  const table = IMAGE_PROMPT_ASPECT_BY_SIZE.carousel;
  const entry = table[sizes.carousel] || table.md;
  return { value: entry.value, hint: entry.hint, step: sizes.carousel };
}

function normalizeStoreProfile(input) {
  const source = isPlainObject(input) ? input : {};
  const profile = isPlainObject(source.storeProfile) ? source.storeProfile : {};
  const name = clip(String(profile.name ?? source.storeName ?? '').trim(), 32);
  const category = clip(String(profile.type ?? source.category ?? '').trim(), 24);
  const notes = clip(String(profile.notes ?? source.notes ?? '').trim(), 120);
  const dishes = Array.isArray(profile.dishes)
    ? profile.dishes
      .filter((dish) => isPlainObject(dish) && typeof dish.name === 'string' && dish.name.trim())
      .slice(0, 3)
      .map((dish) => ({ id: typeof dish.id === 'string' ? dish.id : null, name: clip(dish.name.trim(), 16) }))
    : [];
  return { name, category, notes, dishes };
}

function resolveStyle(styleId, styleName) {
  const preset = STYLE_PRESETS.find((item) => item.id === styleId)
    || STYLE_PRESETS.find((item) => item.id === FALLBACK_STYLE_ID)
    || STYLE_PRESETS[0];
  const name = String(styleName ?? '').trim() || preset.name;
  return {
    id: preset.id,
    name: clip(name, 24),
    caption: clip(preset.caption, 40),
    colors: Array.isArray(preset.colors) ? [...preset.colors] : [],
  };
}

/** 合并禁止项：JSON 里的负向约束 + 4 条硬性要求（去重，保持固定顺序）。 */
function mergeNegative(layoutNegative) {
  const merged = [];
  for (const item of IMAGE_PROMPT_NEGATIVE_REQUIRED) merged.push(item);
  for (const item of Array.isArray(layoutNegative) ? layoutNegative : []) {
    const text = String(item ?? '').trim();
    if (text && !merged.includes(text)) merged.push(text);
  }
  return merged;
}

function storeSentence(store) {
  const parts = [];
  if (store.name) parts.push(store.name);
  if (store.category) parts.push(store.category);
  if (store.dishes.length) parts.push(`招牌印象：${store.dishes.map((dish) => dish.name).join('、')}`);
  if (store.notes) parts.push(`门店氛围：${store.notes}`);
  return parts.join('；') || '未提供门店信息，按普通餐饮门店处理';
}

function styleSentence(style) {
  return style.caption ? `${style.name}（${style.caption}）` : style.name;
}

/**
 * 固定段落拼接。
 *
 * 段落顺序即契约顺序；禁止项单独成段，截断时只动「补充要求」。
 */
function buildSegments(spec, extra) {
  const segments = [
    `主体：${spec.subject}。`,
    `构图：${spec.composition}；画面比例 ${spec.aspect.value}（${spec.aspect.hint}，首屏档位 ${spec.aspect.step}·${spec.aspect.label}）。`,
    `色调：${spec.palette.join('、')}${spec.style.colors[1] ? `，主色 ${spec.style.colors[1]}` : ''}。`,
    `光源：${spec.lighting}。`,
    `留白：${spec.whiteSpace}。`,
    `禁止项：${spec.negative.join('；')}。`,
    `门店事实：${storeSentence(spec.store)}。`,
    `风格：${styleSentence(spec.style)}。`,
  ];
  if (spec.carouselAspect) {
    segments.push(`轮播比例：${spec.carouselAspect.value}（${spec.carouselAspect.hint}）。`);
  }
  if (extra) segments.push(`补充要求：${extra}。`);
  return segments;
}

/**
 * 拼 prompt 并保证 ≤ maxLength。
 * 超长时先截断补充要求；补充要求清空后仍超长则继续截断门店氛围（notes），
 * 但禁止项段落永远不截断。
 */
function composePromptText(spec, maxLength) {
  const extra = spec.extraRequirement;
  const base = buildSegments(spec, '').join('');
  if (!extra) return { prompt: base, extraTruncated: false };

  const withExtra = buildSegments(spec, extra).join('');
  if (codePointLength(withExtra) <= maxLength) return { prompt: withExtra, extraTruncated: false };

  const overhead = codePointLength(buildSegments(spec, 'X').join('')) - 1;
  const budget = maxLength - overhead;
  const trimmed = budget > 1 ? clip(extra, budget) : '';
  const prompt = buildSegments(spec, trimmed).join('');
  if (codePointLength(prompt) <= maxLength) return { prompt, extraTruncated: true };

  // 极端情况（门店事实本身过长）：保留无补充要求版本，必要时再截门店氛围。
  const fallback = buildSegments(spec, '').join('');
  return { prompt: clip(fallback, maxLength), extraTruncated: true };
}

/**
 * 构造结构化生图提示词。
 *
 * @param {object} input
 * @param {'menu'|'catalog'|'editorial'} [input.layout] 缺省按门店类型推导
 * @param {{name?:string,type?:string,notes?:string,dishes?:Array<{id?:string,name:string}>}} [input.storeProfile]
 * @param {string} [input.storeName] 兼容 2.2.10 声明的扁平字段
 * @param {string} [input.category] 兼容 2.2.10 声明的扁平字段
 * @param {string} [input.notes] 兼容 2.2.10 声明的扁平字段
 * @param {string} [input.styleId] 风格预设 id（见 storeBrief.mjs）
 * @param {string} [input.styleName] 显式风格名（优先于预设名）
 * @param {string} [input.extraRequirement] 追加要求（超长优先截断）
 * @param {{homeHero?:string,productCard?:string,carousel?:string}} [input.sizeTokens] 尺寸档位
 * @returns {{prompt: string, spec: object, tips: string[]}}
 */
export function buildImagePromptSpec(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const layout = resolveImageLayout(source);
  const layoutFallback = source.layout !== layout;
  const rule = IMAGE_PROMPT_TEMPLATE_RULES[layout];
  const store = normalizeStoreProfile(source);
  const style = resolveStyle(source.styleId, source.styleName);
  const sizes = normalizeSizeTokens(source.sizeTokens);
  const aspect = resolveAspect(sizes);
  const carouselAspect = resolveCarouselAspect(sizes);
  const negative = mergeNegative(rule.negative);
  const rawExtra = String(source.extraRequirement ?? '').trim();
  const extraRequirement = clip(rawExtra, IMAGE_PROMPT_MAX_EXTRA);
  const extraClipped = codePointLength(rawExtra) > IMAGE_PROMPT_MAX_EXTRA;

  const baseSpec = {
    contract: IMAGE_PROMPT_SPEC_CONTRACT,
    layout,
    layoutFallback,
    templateId: rule.templateId,
    composition: rule.composition,
    subject: rule.subject,
    palette: [...rule.palette],
    lighting: rule.lighting,
    whiteSpace: rule.whiteSpace,
    negative,
    aspect,
    carouselAspect,
    sizes,
    store,
    style,
    extraRequirement,
    extraClipped,
  };

  const { prompt, extraTruncated } = composePromptText(baseSpec, IMAGE_PROMPT_MAX_LENGTH);
  const spec = {
    ...baseSpec,
    prompt,
    promptLength: codePointLength(prompt),
    maxPromptLength: IMAGE_PROMPT_MAX_LENGTH,
    extraTruncated,
  };

  return { prompt, spec, tips: [...IMAGE_PROMPT_TIPS] };
}

function mergeExtraRequirement(previous, feedback) {
  const parts = [String(previous ?? '').trim(), String(feedback ?? '').trim()].filter(Boolean);
  return clip(parts.join('；'), IMAGE_PROMPT_MAX_EXTRA);
}

/**
 * 按用户反馈改提示词（plan.md 2.2.10 规则 4）。
 *
 * 反馈作为 `extraRequirement` 追加，禁止项与布局约束保持不变；
 * `baseSpec` 缺失时退回「旧字符串拼接」，保证老调用方不崩。
 *
 * @returns {{prompt: string, spec: object, tips: string[]}}
 */
export function reviseImagePrompt(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const baseSpec = isPlainObject(source.baseSpec) ? source.baseSpec : {};
  const feedback = clip(String(source.feedback ?? '').trim(), IMAGE_PROMPT_MAX_EXTRA);

  if (!IMAGE_PROMPT_LAYOUTS.includes(baseSpec.layout)) {
    const legacy = clip(
      `${String(source.basePrompt ?? '').trim()} 补充要求：${feedback}`.trim(),
      IMAGE_PROMPT_MAX_LENGTH,
    );
    return {
      prompt: legacy,
      spec: {
        contract: IMAGE_PROMPT_SPEC_CONTRACT,
        layout: FALLBACK_LAYOUT,
        layoutFallback: true,
        negative: [...IMAGE_PROMPT_NEGATIVE_REQUIRED],
        legacy: true,
        extraRequirement: feedback,
        prompt: legacy,
        promptLength: codePointLength(legacy),
        maxPromptLength: IMAGE_PROMPT_MAX_LENGTH,
        extraTruncated: false,
      },
      tips: [...IMAGE_PROMPT_TIPS],
    };
  }

  const next = buildImagePromptSpec({
    layout: baseSpec.layout,
    storeProfile: baseSpec.store,
    styleId: baseSpec.style?.id,
    styleName: baseSpec.style?.name,
    sizeTokens: baseSpec.sizes,
    extraRequirement: mergeExtraRequirement(baseSpec.extraRequirement, feedback),
  });
  return { prompt: next.prompt, spec: next.spec, tips: next.tips };
}