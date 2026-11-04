'use strict';

/**
 * T10：Composer 消费 Plan 展示声明（C-PLAN-PRESENTATION@1）的回归测试。
 *
 * 覆盖：
 * - `presentationTokens` / `slotOrder` 均为可选字段，缺省时 Composer 仍放行并按 md 处理；
 * - 非法尺寸、非法落位目标、非完整排列被拒绝；
 * - `planDigest` 包含两个字段，且相同语义输入摘要稳定；
 * - `resolve` 用 `slotOrder` 目标插槽作为 assignment key，同时不改写 `features[].slots[]`；
 * - `order-poster` 的 `props.size` 与 `recipeCatalog` 镜像、`cloneProps` 白名单一致。
 *
 * 说明：resolve 用例使用“真实 Base/Feature manifest + 桩注册表”，避免依赖
 * `registry.lock.json` 的资产摘要（T10 改动了 `templates/recipes/order-poster/.../plan.json`，
 * 摘要刷新由 T12 执行）；其余输入一律取自真实 Recipe 与真实 manifest。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
  validatePlan,
  normalizePresentationTokens,
  presentationSlotDataKey,
} = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
const { planDigest } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));

const POSTER_PLAN_FILE = path.join(REPO, 'templates', 'recipes', 'order-poster', '1.0.0', 'plan.json');
const BASE_DIR = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const POSTER_DIR = path.join(REPO, 'templates', 'features', 'poster-carousel', '1.0.0');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recipePlan() {
  return readJson(POSTER_PLAN_FILE);
}

/** 真实 Base/Feature manifest + 最小注册表桩，避开 registry.lock 摘要漂移。 */
function stubLoaded() {
  const baseManifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  const posterManifest = readJson(path.join(POSTER_DIR, 'manifest.json'));
  const baseAsset = { id: 'ordering-base', version: '1.0.0', kind: 'base', dir: BASE_DIR, manifest: baseManifest };
  const posterAsset = {
    id: 'poster-carousel',
    version: '1.0.0',
    kind: 'feature-pack',
    dir: POSTER_DIR,
    manifest: posterManifest,
  };
  const assets = [baseAsset, posterAsset];
  return {
    ok: true,
    registry: { registryVersion: recipePlan().registryVersion, assets },
    registryDigest: 'sha256:' + 'b'.repeat(64),
    assets,
    byKey: new Map(assets.map((asset) => [asset.id + '@' + asset.version, asset])),
  };
}

test('presentationTokens 与 slotOrder 均为可选：缺省 Plan 通过校验', () => {
  const plan = recipePlan();
  assert.strictEqual(Object.hasOwn(plan, 'presentationTokens'), false);
  assert.strictEqual(Object.hasOwn(plan, 'slotOrder'), false);

  const result = validatePlan(plan);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(normalizePresentationTokens(plan.presentationTokens), {
    homeHeroSize: 'md',
    productCardSize: 'md',
  });
});

test('presentationTokens 合法值通过，缺项按 md 补齐', () => {
  const plan = recipePlan();
  plan.presentationTokens = { homeHeroSize: 'lg' };
  assert.strictEqual(validatePlan(plan).ok, true, JSON.stringify(validatePlan(plan)));
  assert.deepStrictEqual(normalizePresentationTokens(plan.presentationTokens), {
    homeHeroSize: 'lg',
    productCardSize: 'md',
  });
});

test('非法尺寸档位被拒绝（PRESENTATION_SIZE_INVALID）', () => {
  const plan = recipePlan();
  plan.presentationTokens = { homeHeroSize: 'xl', productCardSize: 'md' };
  const result = validatePlan(plan);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'PRESENTATION_SIZE_INVALID');
  assert.strictEqual(result.path, 'presentationTokens.homeHeroSize');
});

test('presentationTokens 未知键按 PLAN_FIELD_FORBIDDEN 处理', () => {
  const plan = recipePlan();
  plan.presentationTokens = { homeHeroSize: 'md', carouselSize: 'lg' };
  const result = validatePlan(plan);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'PLAN_FIELD_FORBIDDEN');
  assert.strictEqual(result.path, 'presentationTokens.carouselSize');
});

test('slotOrder 不是已占用 Feature 的完整排列时被拒绝', () => {
  const empty = recipePlan();
  empty.slotOrder = [];
  const emptyResult = validatePlan(empty);
  assert.strictEqual(emptyResult.code, 'PLAN_SLOT_ORDER_INVALID');

  const unknownFeature = recipePlan();
  unknownFeature.slotOrder = [{ featureId: 'not-a-feature', pageId: 'home', slotId: 'home-hero' }];
  assert.strictEqual(validatePlan(unknownFeature).code, 'PLAN_SLOT_ORDER_INVALID');
});

test('slotOrder 目标插槽非法或页面矛盾时被拒绝（PLAN_SLOT_TARGET_INVALID）', () => {
  const wrongPage = recipePlan();
  wrongPage.slotOrder = [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'menu-hero' }];
  const wrongPageResult = validatePlan(wrongPage);
  assert.strictEqual(wrongPageResult.code, 'PLAN_SLOT_TARGET_INVALID');
  assert.strictEqual(wrongPageResult.path, 'slotOrder[0].slotId');

  const unknownSlot = recipePlan();
  unknownSlot.slotOrder = [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-footer' }];
  assert.strictEqual(validatePlan(unknownSlot).code, 'PLAN_SLOT_TARGET_INVALID');
});

test('planDigest 包含 presentationTokens 与 slotOrder，且缺省等价 md 时摘要一致', () => {
  const legacy = recipePlan();
  const defaults = recipePlan();
  defaults.presentationTokens = { homeHeroSize: 'md', productCardSize: 'md' };
  const extraSlotOrder = recipePlan();
  extraSlotOrder.slotOrder = [];

  const legacyDigest = planDigest(legacy);
  assert.match(legacyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(planDigest(legacy), legacyDigest, '相同输入重复摘要一致');
  assert.strictEqual(planDigest(defaults), legacyDigest, '缺省与显式 md 语义等价，摘要相同');
  assert.strictEqual(planDigest(extraSlotOrder), legacyDigest, '缺省与显式空落位语义等价，摘要相同');

  const larger = recipePlan();
  larger.presentationTokens = { homeHeroSize: 'lg', productCardSize: 'md' };
  assert.notStrictEqual(planDigest(larger), legacyDigest, '尺寸参与摘要');

  const moved = recipePlan();
  moved.slotOrder = [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }];
  assert.notStrictEqual(planDigest(moved), legacyDigest, '落位参与摘要');
  assert.strictEqual(planDigest(moved), planDigest(moved), '带落位的摘要同样稳定');

  // 摘要不得回写 plan。
  assert.strictEqual(Object.hasOwn(legacy, 'presentationTokens'), false);
  assert.strictEqual(Object.hasOwn(legacy, 'slotOrder'), false);
});

test('resolve 缺省展示声明时输出 md 尺寸与空落位，且不改写输入', () => {
  const plan = recipePlan();
  const snapshot = JSON.parse(JSON.stringify(plan));
  const graph = resolvePlan(plan, stubLoaded(), {});

  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  assert.deepStrictEqual(graph.presentationTokens, { homeHeroSize: 'md', productCardSize: 'md' });
  assert.deepStrictEqual(graph.slotOrder, []);
  assert.deepStrictEqual(plan, snapshot, 'resolve 不得修改调用方 Plan');
  assert.strictEqual(graph.assignments.has('home#home-hero'), true);
});

test('resolve 用 slotOrder 目标插槽作为 assignment key，features[].slots[] 保持原样', () => {
  const plan = recipePlan();
  plan.slotOrder = [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-marketing' }];
  assert.strictEqual(validatePlan(plan).ok, true, JSON.stringify(validatePlan(plan)));

  const graph = resolvePlan(plan, stubLoaded(), {});
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));

  const originalSlot = graph.plan.features[0].slots[0];
  assert.strictEqual(originalSlot.slotId, 'home-hero', '不得改写声明落位');
  assert.strictEqual(originalSlot.pageId, 'home');
  assert.strictEqual(originalSlot.dataKey, 'homeHero');

  assert.strictEqual(graph.assignments.has('home#home-hero'), false);
  const moved = graph.assignments.get('home#home-marketing');
  assert.ok(Array.isArray(moved) && moved.length === 1, '落位到 home-marketing');
  assert.strictEqual(moved[0].asset.id, 'poster-carousel');
  assert.strictEqual(moved[0].dataKey, 'homeMarketing');
  assert.strictEqual(moved[0].placement, 'slotOrder');
  // requiresSlots=['home-hero'] 仍按原始声明满足，不会误报 SLOT_REQUIRED_MISSING。
  assert.deepStrictEqual(graph.slotOrder, [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-marketing' }]);
});

test('resolve 支持把海报移动到菜单页 menu-hero，配置键映射 menuHero', () => {
  const plan = recipePlan();
  plan.slotOrder = [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }];
  assert.strictEqual(validatePlan(plan).ok, true, JSON.stringify(validatePlan(plan)));

  const graph = resolvePlan(plan, stubLoaded(), {});
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));

  assert.deepStrictEqual([...graph.assignments.keys()], ['menu#menu-hero']);
  const moved = graph.assignments.get('menu#menu-hero')[0];
  assert.strictEqual(moved.dataKey, 'menuHero');
  assert.strictEqual(moved.slotId, 'menu-hero');
  assert.strictEqual(moved.placement, 'slotOrder');
  // 原始声明落位与 props 均未被改写，海报 items 仍然完整。
  assert.strictEqual(graph.plan.features[0].slots[0].slotId, 'home-hero');
  assert.strictEqual(moved.slot.props.items.length, 3);
});

test('resolve 拒绝 accepts 不匹配的落位目标（SLOT_TYPE_REJECTED）', () => {
  const plan = recipePlan();
  plan.slotOrder = [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-aside' }];
  assert.strictEqual(validatePlan(plan).ok, true, JSON.stringify(validatePlan(plan)));

  const graph = resolvePlan(plan, stubLoaded(), {});
  assert.strictEqual(graph.ok, false);
  assert.strictEqual(graph.code, 'SLOT_TYPE_REJECTED');
  assert.strictEqual(graph.details.slotId, 'menu-aside');
});

test('order-poster 的 props.size 与 RECIPES 镜像、cloneProps 白名单一致', async () => {
  const plan = recipePlan();
  const slot = plan.features[0].slots[0];
  assert.strictEqual(slot.props.size, 'md');

  const { RECIPES, resolveRecipe } = await import('../src/domain/recipeCatalog.mjs');
  assert.deepStrictEqual(
    RECIPES['order-poster'].features,
    plan.features,
    'RECIPES 镜像必须与 plan.json 逐字段一致（recipe-catalog-sync 门禁）',
  );

  // cloneProps 若丢弃 size，镜像深拷贝后会缺字段，预览与导出即漂移。
  const cloned = resolveRecipe('signature-kitchen').recipe.features[0].slots[0].props;
  assert.strictEqual(cloned.size, 'md');
  assert.strictEqual(presentationSlotDataKey('menu-hero'), 'menuHero');

  // 真实 Plan + 真实 manifest 端到端：`size` 必须被 Feature Pack 声明，否则 PROP_UNKNOWN。
  const graph = resolvePlan(recipePlan(), stubLoaded(), {});
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  assert.strictEqual(graph.assignments.get('home#home-hero')[0].slot.props.size, 'md');
  assert.deepStrictEqual(graph.presentationTokens, { homeHeroSize: 'md', productCardSize: 'md' });
});