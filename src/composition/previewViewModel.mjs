import { formatCents } from '../domain/agentDraft.mjs';
import { features as catalogFeatures } from '../domain/catalog.mjs';
import {
  DEFAULT_SIZE_TOKENS,
  normalizePresentationTokens,
  SIZE_STEPS,
  toPx,
} from '../domain/previewSizeTokens.mjs';
import { describeRecipe } from '../domain/recipeCatalog.mjs';
import { buildPlanFromSession } from './planFromSession.mjs';
import { resolveThemeTokens } from './themePresets.mjs';

/**
 * @typedef {'menu'|'catalog'|'editorial'} PreviewLayout
 * @typedef {{ key:string, name:string, note:string, priceCents:number,
 *   priceDisplay:string, thumbnail:'theme-gradient' }} PreviewProduct
 * @typedef {{
 *   schemaVersion:'preview-view-model.v1', layout:PreviewLayout,
 *   recipe:{ id:string, displayName:string, version:string },
 *   blocks:Array<{ id:string, pageId:'home'|'menu', slotId:string, dataKey:string,
 *     size:'sm'|'md'|'lg', props:object }>,
 *   sizes:{ homeHeroPx:number, productCardPx:number },
 *   theme:{ pageBackground:string, primaryColor:string, accentColor:string,
 *     textColor:string, tabBarBackground:string, tabBarColor:string,
 *     tabBarSelectedColor:string },
 *   store:{ name:string, initial:string, category:string,
 *     businessHoursText:string, fulfillmentText:string, subtitle:string,
 *     tagline:string },
 *   hero:{ kicker:string, title:string, cta:string, sectionTitle:string,
 *     story:string|null },
 *   products:PreviewProduct[], menuCountText:string,
 *   tabs:Array<{ id:'home'|'menu'|'orders'|'mine', label:string,
 *     icon:'home'|'menu'|'orders'|'mine' }>,
 *   order:{ number:string, context:string, status:string, estimate:string,
 *     steps:Array<{ key:string, label:string,
 *       state:'done'|'current'|'pending' }> },
 *   capabilities:Array<{ key:string, label:string }>
 * }} PreviewViewModel
 */

const PREVIEW_LAYOUTS = new Set(['menu', 'catalog', 'editorial']);
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const HOURS_POINT_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const THEME_KEYS = [
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
];

// 所有主题字段都逐项回落到现有 warm-orange 预设，而不是复用另一套展示色值。
const WARM_ORANGE_TOKENS = Object.freeze({ ...resolveThemeTokens('warm').tokens });

const SAMPLE_PRODUCTS = Object.freeze([
  Object.freeze({ key: 'sample-dish-1', name: '门店招牌饭', note: '现点现做', priceCents: 2800 }),
  Object.freeze({ key: 'sample-dish-2', name: '时令小食拼盘', note: '清爽分享', priceCents: 1600 }),
  Object.freeze({ key: 'sample-dish-3', name: '自选鲜泡茶', note: '每日现泡', priceCents: 1000 }),
  Object.freeze({ key: 'sample-dish-4', name: '今日限定', note: '售完即止', priceCents: 2200 }),
]);

const HERO_BY_LAYOUT = Object.freeze({
  menu: Object.freeze({
    kicker: '今日菜单已准备好',
    title: '从一份招牌开始',
    cta: '开始点餐',
    sectionTitle: '本店推荐',
    story: null,
  }),
  catalog: Object.freeze({
    kicker: '今日新鲜出炉',
    title: '从一杯开始',
    cta: '开始点餐',
    sectionTitle: '今日精选',
    story: null,
  }),
  editorial: Object.freeze({
    kicker: '今日主厨推荐',
    title: '一道招牌，记住这家店',
    cta: '看看招牌',
    sectionTitle: '主厨故事',
    story: '从清晨备料到晚间收档，这家店只做当天的新鲜。',
  }),
});

const TABS = Object.freeze([
  Object.freeze({ id: 'home', label: '首页', icon: 'home' }),
  Object.freeze({ id: 'menu', label: '菜单', icon: 'menu' }),
  Object.freeze({ id: 'orders', label: '订单', icon: 'orders' }),
  Object.freeze({ id: 'mine', label: '我的', icon: 'mine' }),
]);

/**
 * 预览支持的插槽块类型。
 *
 * 只登记桌面端已经能"看起来和真机一致"的块；新增一种块必须同时满足：
 * 1) Composer 能在同一 recipe 下真的注入它；
 * 2) 有一个 React 组件按同一份 props 渲染。
 * 未登记的 Feature 会被安全忽略，预览不会凭 ID 猜出结构。
 */
const PREVIEW_BLOCK_TYPES = Object.freeze({
  'poster-carousel': Object.freeze({
    // 允许的落位目标：首页 hero 或菜单 hero。预览按 Plan 的实际落位决定页面归属。
    slotIds: Object.freeze(['home-hero', 'menu-hero']),
    defaultSlotId: 'home-hero',
    maxItems: 6,
    tones: Object.freeze(['warm', 'green', 'ink']),
    defaultSize: DEFAULT_SIZE_TOKENS.carousel,
  }),
});

/** 目标插槽 → 所属页面（与 plan.md 2.2.2 落位表一致），用于 preview 的页面归属。 */
const SLOT_PAGE = Object.freeze({
  'home-hero': 'home',
  'home-marketing': 'home',
  'menu-aside': 'menu',
  'menu-hero': 'menu',
});

const POSTER_TITLE_LIMIT = 24;
const POSTER_SUBTITLE_LIMIT = 40;
const POSTER_INTERVAL_MIN = 3000;
const POSTER_INTERVAL_MAX = 8000;
const POSTER_INTERVAL_DEFAULT = 4000;

// v1 仅提供演示订单；这些常量不表示后端订单或真实履约进度。
const DEMO_ORDER = Object.freeze({
  number: '#20261031',
  context: '堂食 · 3 号桌',
  status: '制作中',
  estimate: '预计 20 分钟后可取餐',
  steps: Object.freeze([
    Object.freeze({ key: 'order-placed', label: '已下单', state: 'done' }),
    Object.freeze({ key: 'order-preparing', label: '制作中', state: 'current' }),
    Object.freeze({ key: 'order-ready', label: '可取餐', state: 'pending' }),
  ]),
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeLayout(layout) {
  return PREVIEW_LAYOUTS.has(layout) ? layout : 'menu';
}

function buildTheme(themeTokens) {
  const source = isRecord(themeTokens) ? themeTokens : {};
  const theme = {};
  for (const key of THEME_KEYS) {
    theme[key] = typeof source[key] === 'string' && COLOR_PATTERN.test(source[key])
      ? source[key]
      : WARM_ORANGE_TOKENS[key];
  }
  return theme;
}

function buildBusinessHoursText(businessHours) {
  const segments = (Array.isArray(businessHours) ? businessHours : [])
    .map((segment) => {
      if (!isRecord(segment)) return null;
      const start = readText(segment.start);
      const end = readText(segment.end);
      return HOURS_POINT_PATTERN.test(start) && HOURS_POINT_PATTERN.test(end)
        ? `${start}-${end}`
        : null;
    })
    .filter(Boolean);
  return segments.length > 0 ? segments.join('，') : '营业时间待完善';
}

function buildFulfillmentText(fulfillment) {
  const source = isRecord(fulfillment) ? fulfillment : {};
  const dineIn = source.dineIn === true;
  const takeaway = source.takeaway === true;
  if (dineIn && takeaway) return '堂食 · 到店自取';
  if (dineIn) return '堂食';
  if (takeaway) return '到店自取';
  return '取餐方式待完善';
}

function normalizeProduct(dish) {
  if (!isRecord(dish)) return null;
  const name = readText(dish.name);
  const priceCents = dish.priceCents;
  if (!name || !Number.isInteger(priceCents) || priceCents < 1 || priceCents > 999999) {
    return null;
  }
  return {
    name,
    note: readText(dish.description) || '现点现做',
    priceCents,
  };
}

function normalizeDraftKeySource(dish) {
  // 与 planFromSession 的菜品过滤顺序保持一致，再应用 Preview 的价格范围约束。
  // 返回的本地 ID 只用于 key，名称、描述与价格仍完全以 Plan 为准。
  return normalizeProduct(dish) ? { id: readText(dish.id) } : null;
}

function createProductKeyAllocator() {
  const occurrences = new Map();
  const usedKeys = new Set();
  return (baseKey) => {
    let occurrence = (occurrences.get(baseKey) || 0) + 1;
    let key = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
    while (usedKeys.has(key)) {
      occurrence += 1;
      key = `${baseKey}#${occurrence}`;
    }
    occurrences.set(baseKey, occurrence);
    usedKeys.add(key);
    return key;
  };
}

function buildSampleProducts() {
  return SAMPLE_PRODUCTS.map((product) => ({
    ...product,
    priceDisplay: formatCents(product.priceCents),
    thumbnail: 'theme-gradient',
  }));
}

function buildProducts(storeProfile, draft) {
  const products = (Array.isArray(storeProfile.dishes) ? storeProfile.dishes : [])
    .map(normalizeProduct)
    .filter(Boolean);
  if (products.length === 0) return buildSampleProducts();

  const draftDishes = isRecord(draft) && Array.isArray(draft.dishes) ? draft.dishes : [];
  const keySources = draftDishes.map(normalizeDraftKeySource).filter(Boolean);
  const allocateKey = createProductKeyAllocator();
  return products.map((product, index) => {
    const localId = keySources[index]?.id || '';
    const baseKey = localId || `dish:${product.name}:${product.priceCents}`;
    return {
      key: allocateKey(baseKey),
      name: product.name,
      note: product.note,
      priceCents: product.priceCents,
      priceDisplay: formatCents(product.priceCents),
      thumbnail: 'theme-gradient',
    };
  });
}

function clampPosterInterval(value) {
  if (!Number.isFinite(value)) return POSTER_INTERVAL_DEFAULT;
  if (value < POSTER_INTERVAL_MIN) return POSTER_INTERVAL_MIN;
  if (value > POSTER_INTERVAL_MAX) return POSTER_INTERVAL_MAX;
  return Math.round(value);
}

function normalizePosterItem(item, index) {
  if (!isRecord(item)) return null;
  const title = readText(item.title).slice(0, POSTER_TITLE_LIMIT);
  if (!title) return null;
  const tones = PREVIEW_BLOCK_TYPES['poster-carousel'].tones;
  return {
    id: readText(item.id) || `poster-${index + 1}`,
    title,
    subtitle: readText(item.subtitle).slice(0, POSTER_SUBTITLE_LIMIT),
    tone: tones.includes(item.tone) ? item.tone : 'warm',
  };
}

/**
 * 按 Feature Pack manifest 的 `interface.props` 契约清洗海报 props。
 *
 * 刻意不投影 `image`：PLAN 禁止外部 URL，预览也不该从 Plan 里取出未经校验的
 * 资源地址去渲染。真机侧的图片能力由店主在导出工程里自行替换。
 */
function buildPosterProps(rawProps) {
  const source = isRecord(rawProps) ? rawProps : {};
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(normalizePosterItem)
    .filter(Boolean)
    .slice(0, PREVIEW_BLOCK_TYPES['poster-carousel'].maxItems);
  return {
    items,
    autoplay: source.autoplay === true,
    interval: clampPosterInterval(source.interval),
    showIndicator: source.showIndicator === true,
  };
}

/**
 * 读取 Plan 顶层 `slotOrder`（C-PLAN-PRESENTATION@1）。
 *
 * 只接受与 2.2.2 落位表一致的 pageId/slotId 组合；非法条目忽略，
 * 对应 Feature 继续使用 `features[].slots[]` 的声明落位。
 */
function collectPlanPlacements(slotOrder) {
  const placements = new Map();
  for (const entry of Array.isArray(slotOrder) ? slotOrder : []) {
    if (!isRecord(entry)) continue;
    const featureId = readText(entry.featureId);
    const slotId = readText(entry.slotId);
    if (!featureId || placements.has(featureId)) continue;
    if (!Object.prototype.hasOwnProperty.call(SLOT_PAGE, slotId)) continue;
    if (SLOT_PAGE[slotId] !== entry.pageId) continue;
    placements.set(featureId, { pageId: SLOT_PAGE[slotId], slotId });
  }
  return placements;
}

function normalizeBlockSize(value) {
  return SIZE_STEPS.includes(value) ? value : null;
}

/**
 * 把 Plan 的 `features[].slots[]` 投影成预览块。
 *
 * 这是"预览与导出一致"的关键：导出侧 Composer 按同一 `slotId` 把组件写进 wxml，
 * 预览侧按同一 `slotId` 渲染对应 React 组件。两边都不再自己发明页面结构。
 *
 * `features[].slots[]` 保持 Recipe 原样（见 plan.md 2.2.2），实际落位由顶层
 * `slotOrder` 覆盖：块上的 `pageId`/`slotId` 反映"最终渲染目标"，因此组件可以
 * 只按 `block.pageId` 决定渲染到首页还是菜单页。`size` 读 `props.size`，缺省按
 * `preview-size-tokens.v1` 的 md 兜底。
 */
function buildBlocks(plan) {
  const features = Array.isArray(plan.features) ? plan.features : [];
  const placements = collectPlanPlacements(plan.slotOrder);
  const blocks = [];
  for (const feature of features) {
    if (!isRecord(feature)) continue;
    const featureId = readText(feature.id);
    const spec = PREVIEW_BLOCK_TYPES[featureId];
    if (!spec) continue;
    const slots = Array.isArray(feature.slots) ? feature.slots : [];
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      if (!isRecord(slot)) continue;
      const declaredSlotId = readText(slot.slotId);
      if (!spec.slotIds.includes(declaredSlotId)) continue;
      const dataKey = readText(slot.dataKey);
      if (!dataKey) continue;
      // 声明落位自相矛盾时视为无效（slotOrder 的目标落位另行覆盖）。
      const declaredPage = readText(slot.pageId);
      if (declaredPage && declaredPage !== SLOT_PAGE[declaredSlotId]) continue;

      // 一个 Feature 只对外暴露一个落位；多插槽 Feature 仅首个插槽接受 slotOrder 覆盖。
      const placement = index === 0 ? placements.get(featureId) : null;
      const usePlacement = placement && spec.slotIds.includes(placement.slotId);
      const pageId = usePlacement ? placement.pageId : SLOT_PAGE[declaredSlotId];
      const slotId = usePlacement ? placement.slotId : declaredSlotId;
      const props = isRecord(slot.props) ? slot.props : {};
      blocks.push({
        id: featureId,
        pageId,
        slotId,
        dataKey,
        size: normalizeBlockSize(props.size) || spec.defaultSize,
        props: buildPosterProps(props),
      });
    }
  }
  return blocks;
}

function buildRecipe(plan) {
  return describeRecipe(readText(plan.planId));
}

/**
 * 尺寸 token → React 预览 px。
 *
 * Plan 未提供 `presentationTokens` 时 `normalizePresentationTokens` 已按 `md` 兜底，
 * 因此旧 Plan 的视觉与改动前完全一致。
 */
function buildSizes(presentationTokens) {
  const tokens = normalizePresentationTokens(presentationTokens);
  return {
    homeHeroPx: toPx('homeHero', tokens.homeHeroSize),
    productCardPx: toPx('productCard', tokens.productCardSize),
  };
}

function buildCapabilities(featureIds) {
  const capabilities = [];
  const seen = new Set();
  for (const rawId of Array.isArray(featureIds) ? featureIds : []) {
    const id = readText(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const feature = catalogFeatures.find((item) => item.id === id);
    capabilities.push({ key: id, label: feature ? feature.label : id });
    if (capabilities.length === 4) break;
  }
  return capabilities;
}

/**
 * 构建唯一预览投影。compact/full 必须消费同一个返回值，不得分别构造展示事实。
 *
 * @param {{ plan?:object, layout?:string, featureIds?:string[], draft?:object }} options
 * @returns {PreviewViewModel}
 */
export function buildPreviewViewModel(options = {}) {
  const source = isRecord(options) ? options : {};
  const plan = isRecord(source.plan) ? source.plan : {};
  const storeProfile = isRecord(plan.storeProfile) ? plan.storeProfile : {};
  const layout = normalizeLayout(source.layout === undefined ? 'menu' : source.layout);
  const name = readText(storeProfile.name) || '我的餐馆';
  const category = readText(storeProfile.category) || '品类待完善';
  const fulfillmentText = buildFulfillmentText(storeProfile.fulfillment);
  const products = buildProducts(storeProfile, source.draft);

  return {
    schemaVersion: 'preview-view-model.v1',
    layout,
    recipe: buildRecipe(plan),
    blocks: buildBlocks(plan),
    sizes: buildSizes(plan.presentationTokens),
    theme: buildTheme(plan.themeTokens),
    store: {
      name,
      initial: Array.from(name)[0] || '店',
      category,
      businessHoursText: buildBusinessHoursText(storeProfile.businessHours),
      fulfillmentText,
      subtitle: `${category} · ${fulfillmentText}`,
      // 门店口号只来自 Plan 的 storeProfile.notes（T3 已把 copy.tagline 写入 store.notes）。
      tagline: readText(storeProfile.notes),
    },
    hero: { ...HERO_BY_LAYOUT[layout] },
    products,
    menuCountText: `共 ${products.length} 道`,
    tabs: TABS.map((tab) => ({ ...tab })),
    order: {
      number: DEMO_ORDER.number,
      context: DEMO_ORDER.context,
      status: DEMO_ORDER.status,
      estimate: DEMO_ORDER.estimate,
      steps: DEMO_ORDER.steps.map((step) => ({ ...step })),
    },
    capabilities: buildCapabilities(source.featureIds),
  };
}

function setOwn(record, key, value) {
  // defineProperty 也能安全处理名为 "__proto__" 的异常候选 ID。
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * session 级 selector：只构建一次 draft-first Plan，并让所有模板共享同一展示事实。
 *
 * @param {object} state
 * @returns {{ selected:PreviewViewModel, byTemplateId:Record<string, PreviewViewModel> }}
 */
export function buildSessionPreviewViewModels(state) {
  const session = isRecord(state) ? state : {};
  const build = isRecord(session.build) ? session.build : {};
  const candidates = Array.isArray(build.candidates) ? build.candidates : [];
  const featureIds = isRecord(session.features) && Array.isArray(session.features.selected)
    ? session.features.selected
    : [];
  const draft = isRecord(session.agentDraft) ? session.agentDraft : {};

  // 门店资料全 session 共享，但 Recipe 必须跟随各自的候选模板：
  // 否则选了「主厨推荐」也会拿到「经典点餐」的配方，预览与导出对不上。
  const planCache = new Map();
  const planFor = (templateId) => {
    if (planCache.has(templateId)) return planCache.get(templateId);
    const candidateState = {
      ...session,
      build: { ...build, selectedId: templateId },
    };
    const { plan } = buildPlanFromSession(candidateState, { storeNameSource: 'draft-first' });
    planCache.set(templateId, plan);
    return plan;
  };

  const byTemplateId = {};
  let firstViewModel = null;

  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id) continue;
    if (Object.prototype.hasOwnProperty.call(byTemplateId, candidate.id)) continue;
    const viewModel = buildPreviewViewModel({
      plan: planFor(candidate.id),
      layout: candidate.layout,
      featureIds,
      draft,
    });
    setOwn(byTemplateId, candidate.id, viewModel);
    if (!firstViewModel) firstViewModel = viewModel;
  }

  const selectedId = typeof build.selectedId === 'string' ? build.selectedId : null;
  const selected = selectedId && Object.prototype.hasOwnProperty.call(byTemplateId, selectedId)
    ? byTemplateId[selectedId]
    : firstViewModel || buildPreviewViewModel({
      plan: planFor(selectedId),
      layout: 'menu',
      featureIds,
      draft,
    });

  return { selected, byTemplateId };
}