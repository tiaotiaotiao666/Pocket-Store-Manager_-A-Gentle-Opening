/**
 * Recipe 配方投影：桌面预览与导出 Plan 共用的唯一配方事实。
 *
 * 本文件是 `templates/recipes/<id>/<version>/plan.json` 中 `features` 段的运行时镜像。
 * 之所以不直接 import JSON，是因为同一模块要同时被 Vite（渲染层）、Node ESM（测试）
 * 与 Composer（CommonJS）消费，JSON import 断言在三条链路上语法不一致。
 * 两处一致由 `test/recipe-catalog-sync.test.cjs` 机械校验，任何漂移都会让测试失败。
 *
 * 依据文档：
 * - docs/模板库与组合生成规划.md §4「桌面预览、Composer 和测试共用 CompositionPlan」
 * - docs/模板库与组合生成规划.md §9「桌面 React 预览……以同一 CompositionPlan 为输入」
 */

/** 与 templates/registry/registry.v1.json 的 registryVersion 保持一致。 */
export const REGISTRY_VERSION = '2026.11.0';

/** 当前生产可用的 Plan 版本。 */
export const RECIPE_VERSION = '1.0.0';

/** 海报尺寸档位；与 `C-SIZE-TOKENS@1` 的 `sm|md|lg` 一致。 */
const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);

/**
 * poster-carousel 的默认营销文案，逐字取自
 * `templates/recipes/order-poster/1.0.0/plan.json` 的 `features[0].slots[0].props.items`。
 * 属于 Recipe 自带的演示素材，不随门店资料变化；门店个性化文案是后续产品决策。
 */
const POSTER_ITEMS = Object.freeze([
  Object.freeze({ id: 'poster-1', title: '秋日暖锅上新', subtitle: '两人份 · 到店自取也可', tone: 'warm' }),
  Object.freeze({ id: 'poster-2', title: '午后茶点 8 折', subtitle: '14:00-17:00 限时', tone: 'green' }),
  Object.freeze({ id: 'poster-3', title: '扫码点餐免排队', subtitle: '堂食扫码直达桌号', tone: 'ink' }),
]);

function clonePosterItems() {
  return POSTER_ITEMS.map((item) => ({ ...item }));
}

/**
 * 一份 Recipe 的完整投影。
 *
 * `features` 的结构必须与 templates/registry/schema/composition.v1.json 的
 * `properties.features` 白名单一致：`{ id, version, slots: [{ slotId, pageId, dataKey, props }] }`。
 */
export const RECIPES = Object.freeze({
  'order-classic': Object.freeze({
    id: 'order-classic',
    version: RECIPE_VERSION,
    displayName: '经典点餐',
    description: '以首页门店头部、菜单列表、购物车与六态订单为核心的餐饮扫码点餐基线方案。',
    features: [],
  }),
  'order-poster': Object.freeze({
    id: 'order-poster',
    version: RECIPE_VERSION,
    displayName: '海报点餐',
    description: '在经典点餐基线上，用海报轮播替换首页门店头部，突出当季活动与扫码点餐入口。',
    features: Object.freeze([
      Object.freeze({
        id: 'poster-carousel',
        version: RECIPE_VERSION,
        slots: Object.freeze([
          Object.freeze({
            slotId: 'home-hero',
            pageId: 'home',
            dataKey: 'homeHero',
            // 默认 props 必须与 templates/recipes/order-poster/1.0.0/plan.json 逐字段一致；
// `size` 是海报轮播的默认尺寸档（md），由 Feature Pack 的 interface.props 声明。
            props: Object.freeze({
              items: POSTER_ITEMS,
              autoplay: true,
              interval: 4000,
              showIndicator: true,
              size: 'md',
            }),
          }),
        ]),
      }),
    ]),
  }),
});

/**
 * 三个候选模板到 Recipe 的映射。
 *
 * 现状如实反映：只有 `order-classic` 与 `order-poster` 两套已验证配方，
 * 因此 `modern-coffee` 与 `warm-bistro` 共用 `order-classic`，视觉差异只来自
 * 主题 Token 与候选自身的 layout 提示。新增模板必须先新增 Recipe，再改这张表。
 */
export const TEMPLATE_TO_RECIPE = Object.freeze({
  'warm-bistro': 'order-classic',
  'modern-coffee': 'order-classic',
  'signature-kitchen': 'order-poster',
});

/** 缺省 Recipe：任何未知或缺失模板的回落目标。 */
export const DEFAULT_RECIPE_ID = 'order-classic';

/**
 * 只从自有属性取值，避免 `__proto__` / `constructor` 这类键穿透到 Object.prototype。
 *
 * @param {Record<string, unknown>} source
 * @param {unknown} key
 * @returns {string|null}
 */
function ownKey(source, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(source, key)
    ? key
    : null;
}

/**
 * 解析模板 ID 对应的 Recipe，返回可直接写进 Plan 的深拷贝。
 *
 * @param {string|null|undefined} templateId
 * @returns {{ recipe: {id:string,version:string,displayName:string,description:string,features:Array}, fallback: boolean }}
 */
export function resolveRecipe(templateId) {
  const mappedKey = ownKey(TEMPLATE_TO_RECIPE, templateId);
  const mapped = mappedKey ? ownKey(RECIPES, TEMPLATE_TO_RECIPE[mappedKey]) : null;
  const recipeId = mapped || DEFAULT_RECIPE_ID;
  const entry = RECIPES[recipeId];
  return {
    fallback: ownKey(TEMPLATE_TO_RECIPE, templateId) === null && Boolean(templateId),
    recipe: {
      id: entry.id,
      version: entry.version,
      displayName: entry.displayName,
      description: entry.description,
      features: cloneFeatures(entry.features),
    },
  };
}

/**
 * 按 Recipe ID 取展示名；用于预览层从 Plan 的 planId 还原可读配方名。
 *
 * @param {string|null|undefined} recipeId
 * @returns {{ id:string, displayName:string, version:string }}
 */
export function describeRecipe(recipeId) {
  const key = ownKey(RECIPES, recipeId);
  const entry = key ? RECIPES[key] : RECIPES[DEFAULT_RECIPE_ID];
  return { id: entry.id, displayName: entry.displayName, version: entry.version };
}

function cloneFeatures(features) {
  return (Array.isArray(features) ? features : []).map((feature) => ({
    id: feature.id,
    version: feature.version,
    slots: (Array.isArray(feature.slots) ? feature.slots : []).map((slot) => ({
      slotId: slot.slotId,
      pageId: slot.pageId,
      dataKey: slot.dataKey,
      props: cloneProps(slot.props),
    })),
  }));
}

function cloneProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const clone = {};
  if (Array.isArray(props.items)) {
    clone.items = props.items.map((item) => ({ ...item }));
  }
  if (typeof props.autoplay === 'boolean') clone.autoplay = props.autoplay;
  if (Number.isFinite(props.interval)) clone.interval = props.interval;
  if (typeof props.showIndicator === 'boolean') clone.showIndicator = props.showIndicator;
  // `size` 必须显式出现在白名单里：Composer 的 PROP_UNKNOWN 与预览尺寸都依赖它，
  // 漏掉会导致“预览是 md、导出无 size”的同源漂移（recipe-catalog-sync 会失败）。
  if (SIZE_STEPS.includes(props.size)) clone.size = props.size;
  return clone;
}