import { features as catalogFeatures } from '../domain/catalog.mjs';
import { normalizePresentationTokens, SIZE_STEPS } from '../domain/previewSizeTokens.mjs';
import { REGISTRY_VERSION, resolveRecipe } from '../domain/recipeCatalog.mjs';
import { resolveThemeTokens } from './themePresets.mjs';

/**
 * 展示补丁允许覆盖的 7 个主题 token（与 plan.md 2.2.4 完全一致）。
 * 顺序固定，便于 diff 与日志稳定。
 */
const PRESENTATION_THEME_KEYS = Object.freeze([
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
]);

/** 允许落位的目标插槽 → 所属页面（与 plan.md 2.2.2 的落位表一致）。 */
const SLOT_PAGE = Object.freeze({
  'home-hero': 'home',
  'home-marketing': 'home',
  'menu-aside': 'menu',
  'menu-hero': 'menu',
});


/** 补丁输入允许小写十六进制；写入 Plan 前统一大写。 */
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const BASE_CAPABILITIES = new Set([
  'scan-order',
  'product-catalog',
  'cart-checkout',
  'order-tracking',
  'table-dining',
  'takeaway',
  'merchant-orders',
  'product-availability',
  'store-profile',
]);


const PAGES = [
  { pageId: 'home' },
  { pageId: 'menu' },
  { pageId: 'orders' },
  { pageId: 'mine' },
  { pageId: 'checkout' },
  { pageId: 'order-detail' },
  { pageId: 'product-detail' },
  { pageId: 'merchant-orders' },
];

function featureLabel(id) {
  const matched = catalogFeatures.find((feature) => feature.id === id);
  return matched ? matched.label : id;
}

export function parseBusinessHours(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  return source
    .split(/[，,;；、]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(segment);
      return match ? { start: match[1] + ':' + match[2], end: match[3] + ':' + match[4] } : null;
    })
    .filter(Boolean);
}

export function mapDishes(dishes) {
  return (Array.isArray(dishes) ? dishes : [])
    .filter((dish) => dish && String(dish.name || '').trim() && Number.isInteger(dish.priceCents))
    .map((dish) => ({
      name: String(dish.name).trim().slice(0, 24),
      priceCents: dish.priceCents,
      description: String(dish.description || '').trim().slice(0, 60),
    }));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读取会话中"已接受的展示补丁"。
 *
 * 契约来源：plan.md 2.2.3 `PresentationState.patch`。
 * T3 尚未落地时 `state.presentation` 可能不存在，此时返回 `null`，
 * 表示"没有展示补丁"，Plan 与改动前的形状、语义完全一致。
 *
 * @param {object} state
 * @returns {object|null}
 */
export function readPresentationPatch(state) {
  if (!isRecord(state)) return null;
  const slice = state.presentation;
  if (!isRecord(slice)) return null;
  // 正常形状是 { patch, changes, ... }；也容忍直接传入补丁对象，便于调用方裁剪。
  if (isRecord(slice.patch)) return slice.patch;
  return slice;
}

/**
 * 主题 = 预设主题 + 已接受补丁的浅合并。
 * 只接受 7 个白名单 token 与 #RRGGBB；非法值静默忽略（补丁在 T1/T3 已校验，这里做防御）。
 */
function mergeThemeTokens(baseTokens, patchTheme) {
  const tokens = { ...baseTokens };
  if (!isRecord(patchTheme)) return tokens;
  for (const key of PRESENTATION_THEME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patchTheme, key)) continue;
    const value = patchTheme[key];
    if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) continue;
    tokens[key] = value.toUpperCase();
  }
  return tokens;
}

/**
 * 把补丁的 `slotOrder` 投影成 `featureId → 目标落位`。
 *
 * 只接受 2.2.2 落位表中存在的 pageId/slotId 组合；不合法条目忽略，
 * 对应 Feature 继续使用 Recipe 的原始落位。
 */
function collectPlacements(slotOrder) {
  const placements = new Map();
  for (const entry of Array.isArray(slotOrder) ? slotOrder : []) {
    if (!isRecord(entry)) continue;
    const featureId = typeof entry.featureId === 'string' ? entry.featureId : '';
    const slotId = typeof entry.slotId === 'string' ? entry.slotId : '';
    if (!featureId || placements.has(featureId)) continue;
    if (!Object.prototype.hasOwnProperty.call(SLOT_PAGE, slotId)) continue;
    if (SLOT_PAGE[slotId] !== entry.pageId) continue;
    placements.set(featureId, { pageId: SLOT_PAGE[slotId], slotId });
  }
  return placements;
}

/**
 * 投影 `features[].slots[]`：只补海报尺寸 props，**不改写落位**。
 *
 * 契约（plan.md 2.2.2）：`features[].slots[]` 必须保持 Recipe 原样，否则
 * `poster-carousel.requiresSlots=['home-hero']` 会在 Composer 侧触发
 * `SLOT_REQUIRED_MISSING`；落位一律由顶层 `slotOrder` 表达。
 *
 * 返回全新对象（含 props.items 的浅拷贝），不共享 Recipe 常量。
 */
function projectFeatures(features, carouselSize) {
  return (Array.isArray(features) ? features : []).map((feature) => {
    const slots = (Array.isArray(feature.slots) ? feature.slots : []).map((slot) => {
      const sourceProps = isRecord(slot.props) ? slot.props : {};
      const props = { ...sourceProps };
      if (Array.isArray(sourceProps.items)) {
        props.items = sourceProps.items.map((item) => ({ ...item }));
      }
      if (carouselSize && feature.id === 'poster-carousel') {
        props.size = carouselSize;
      }
      return { ...slot, props };
    });
    return { ...feature, slots };
  });
}

/**
 * 生成顶层 `slotOrder`：必须是当前已占用 Feature 的完整排列。
 * 顺序与 `features` 一致（不改变区块语义与顺序），未改落位的 Feature 补上原始落位。
 */
function buildSlotOrderEntries(features, placements) {
  const entries = [];
  for (const feature of features) {
    const placement = placements.get(feature.id);
    if (placement) {
      entries.push({ featureId: feature.id, pageId: placement.pageId, slotId: placement.slotId });
      continue;
    }
    const slot = Array.isArray(feature.slots) ? feature.slots[0] : null;
    if (!isRecord(slot)) continue;
    const pageId = typeof slot.pageId === 'string' ? slot.pageId : '';
    const slotId = typeof slot.slotId === 'string' ? slot.slotId : '';
    if (!pageId || !slotId) continue;
    entries.push({ featureId: feature.id, pageId, slotId });
  }
  return entries;
}

export function buildPlanFromSession(state, options = {}) {
  const pages = options.role === 'customer'
    ? PAGES.filter((page) => page.pageId !== 'merchant-orders')
    : options.role === 'merchant'
      ? PAGES.filter((page) => page.pageId === 'merchant-orders')
      : PAGES;
  const warnings = [];
  const unmappedCapabilities = [];

  const selectedTemplateId = state.build && state.build.selectedId;
  const resolved = resolveRecipe(selectedTemplateId);
  const recipe = resolved.recipe;
  const recipeId = recipe.id;
  if (resolved.fallback) {
    warnings.push('未找到候选模板对应的 Recipe，已回落到 order-classic。');
  }

  const selectedFeatures = Array.isArray(state.features && state.features.selected)
    ? state.features.selected
    : [];
  selectedFeatures.forEach((id) => {
    if (!BASE_CAPABILITIES.has(id)) {
      unmappedCapabilities.push({ id, label: featureLabel(id) });
    }
  });
  if (unmappedCapabilities.length > 0) {
    warnings.push('以下能力暂无模板资产，不会写入导出工程：' + unmappedCapabilities.map((item) => item.label).join('、'));
  }

  const theme = resolveThemeTokens(state.visual && state.visual.styleId);
  if (theme.fallback) {
    warnings.push('未识别的装修风格，已回落到暖橙主题。');
  }

  // 展示补丁投影。无 `presentation` 时 hasPresentation=false，Plan 保持旧形状与旧语义。
  const presentationPatch = readPresentationPatch(state);
  const hasPresentation = presentationPatch !== null;
  const patchTheme = hasPresentation && isRecord(presentationPatch.theme)
    ? presentationPatch.theme
    : null;
  const patchSizes = hasPresentation && isRecord(presentationPatch.sizes)
    ? presentationPatch.sizes
    : {};
  const themeTokens = mergeThemeTokens(theme.tokens, patchTheme);
  // 尺寸一律经 normalizePresentationTokens 归一为两键；缺省 md，与 2.2.1 defaults 一致。
  const presentationTokens = normalizePresentationTokens({
    homeHeroSize: patchSizes.homeHero,
    productCardSize: patchSizes.productCard,
  });
  // carousel 档位不进 presentationTokens，只作为海报块的 props.size 传递（2.2.1 规则 4）。
  const carouselSize = SIZE_STEPS.includes(patchSizes.carousel) ? patchSizes.carousel : null;
  const placements = collectPlacements(hasPresentation ? presentationPatch.slotOrder : null);
  const features = projectFeatures(recipe.features, carouselSize);
  const patchSlotOrder = hasPresentation && Array.isArray(presentationPatch.slotOrder)
    ? presentationPatch.slotOrder
    : null;

  const draft = state.agentDraft || {};
  const store = state.store || {};
  const storeNameSource = options.storeNameSource === 'draft-first' ? 'draft-first' : 'confirmed-first';
  const storeName = String(
    storeNameSource === 'draft-first'
      ? draft.storeName || store.name || '我的餐馆'
      : store.name || draft.storeName || '我的餐馆',
  ).trim().slice(0, 48) || '我的餐馆';
  const dishes = mapDishes(draft.dishes);
  if (draft.dishes && draft.dishes.length > 0 && dishes.length !== draft.dishes.length) {
    warnings.push('有菜品缺少名称或整数价格，未写入导出配置。');
  }

  const plan = {
    schemaVersion: 'composition.v1',
    planId: recipeId,
    planVersion: recipe.version,
    baseTemplate: { id: 'ordering-base', version: '1.0.0' },
    registryVersion: REGISTRY_VERSION,
    pages: pages.map((page) => ({ ...page })),
    features,
    components: [],
    themeTokens,
    ...(hasPresentation ? { presentationTokens } : {}),
    // `slotOrder` 只在补丁显式提供时写入；缺省时由 `features[].slots[]` 的声明落位决定。
    ...(patchSlotOrder ? { slotOrder: buildSlotOrderEntries(features, placements) } : {}),
    apiBinding: { contract: 'storefront.v1' },
    storeProfile: {
      name: storeName,
      category: String(draft.category || store.type || '餐饮').trim().slice(0, 48),
      address: String(store.address || '').trim().slice(0, 120),
      phone: String(store.phone || '').trim().slice(0, 32),
      notes: String(store.notes || '').trim().slice(0, 200),
      businessHours: parseBusinessHours(draft.businessHours),
      dishes,
      fulfillment: {
        dineIn: Boolean(draft.fulfillment && draft.fulfillment.dineIn),
        takeaway: Boolean(draft.fulfillment && draft.fulfillment.takeaway),
      },
    },
    previewOnlyAck: false,
    degradations: [],
  };

  return {
    plan,
    warnings,
    unmappedCapabilities,
    recipeId,
    recipeDisplayName: recipe.displayName,
    themePresetId: theme.presetId,
  };
}