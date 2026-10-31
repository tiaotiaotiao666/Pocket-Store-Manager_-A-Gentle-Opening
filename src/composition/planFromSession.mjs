import { features as catalogFeatures } from '../domain/catalog.mjs';
import { resolveThemeTokens } from './themePresets.mjs';

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

const TEMPLATE_TO_RECIPE = {
  'warm-bistro': 'order-classic',
  'modern-coffee': 'order-classic',
  'signature-kitchen': 'order-classic',
};

const PAGES = [
  { pageId: 'home' },
  { pageId: 'menu' },
  { pageId: 'orders' },
  { pageId: 'mine' },
  { pageId: 'checkout' },
  { pageId: 'order-detail' },
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

export function buildPlanFromSession(state) {
  const warnings = [];
  const unmappedCapabilities = [];

  const selectedTemplateId = state.build && state.build.selectedId;
  const recipeId = TEMPLATE_TO_RECIPE[selectedTemplateId] || 'order-classic';
  if (selectedTemplateId && !TEMPLATE_TO_RECIPE[selectedTemplateId]) {
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

  const draft = state.agentDraft || {};
  const store = state.store || {};
  const storeName = String(store.name || draft.storeName || '我的餐馆').trim().slice(0, 48) || '我的餐馆';
  const dishes = mapDishes(draft.dishes);
  if (draft.dishes && draft.dishes.length > 0 && dishes.length !== draft.dishes.length) {
    warnings.push('有菜品缺少名称或整数价格，未写入导出配置。');
  }

  const plan = {
    schemaVersion: 'composition.v1',
    planId: recipeId,
    planVersion: '1.0.0',
    baseTemplate: { id: 'ordering-base', version: '1.0.0' },
    registryVersion: '2026.11.0',
    pages: PAGES.map((page) => ({ ...page })),
    features: [],
    components: [],
    themeTokens: { ...theme.tokens },
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
    themePresetId: theme.presetId,
  };
}