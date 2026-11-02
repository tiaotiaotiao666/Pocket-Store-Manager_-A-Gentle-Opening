'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { resolvePlan, contrastRatio } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { REGISTRY_VERSION } = require(path.join(REPO, 'scripts', 'composer', 'version.cjs'));

const FIXTURE_PLAN = path.join(REPO, 'templates', 'registry', 'schema', 'fixtures', 'valid', 'composition.json');

function basePlan() {
  const plan = JSON.parse(fs.readFileSync(FIXTURE_PLAN, 'utf8'));
  plan.components = [];
  return plan;
}

function baseManifest() {
  return {
    identity: { id: 'ordering-base', version: '1.0.0' },
    entry: { root: 'src', files: ['app.js', 'app.json', 'app.wxss', 'sitemap.json'], assets: [] },
    pages: [
      { pageId: 'home', path: 'pages/home', required: true, audience: 'customer' },
      { pageId: 'menu', path: 'pages/menu', required: true, audience: 'customer' },
      { pageId: 'checkout', path: 'pages/checkout', required: true, audience: 'customer' },
      { pageId: 'orders', path: 'pages/orders', required: true, audience: 'customer' },
      { pageId: 'order-detail', path: 'pages/order-detail', required: true, audience: 'customer' },
      { pageId: 'mine', path: 'pages/mine', required: true, audience: 'customer' },
      { pageId: 'merchant-orders', path: 'pages/merchant-orders', required: true, audience: 'merchant' },
    ],
    themeTokens: [
      { key: 'pageBackground', cssVar: '--store-page-background', type: 'color', required: true },
      { key: 'primaryColor', cssVar: '--store-primary-color', type: 'color', required: true },
      { key: 'accentColor', cssVar: '--store-accent-color', type: 'color', required: true },
      { key: 'textColor', cssVar: '--store-text-color', type: 'color', required: true },
    ],
    slots: [
      { slotId: 'home-hero', pageId: 'home', maxItems: 1, accepts: ['feature-pack', 'ui-block'], required: false },
      { slotId: 'home-marketing', pageId: 'home', maxItems: 2, accepts: ['feature-pack'], required: false },
      { slotId: 'menu-aside', pageId: 'menu', maxItems: 1, accepts: ['ui-block'], required: false },
    ],
    compatibility: { baseRange: '^1.0.0', minWechatLib: '3.0.0', apiContract: 'storefront.v1' },
    release: { stage: 'stable', verifiedRecipes: [] },
  };
}

function asset(kind, id, version, overrides) {
  const manifest = {
    identity: { id, version },
    kind,
    entry: { path: 'src', files: ['index.js'], assets: [] },
    interface: { props: [], events: [] },
    boundary: { allowNetwork: false, allowRoutes: false, allowGlobalState: false, allowServices: false },
    compatibility: { baseRange: '^1.0.0', minWechatLib: '3.0.0', apiContract: 'storefront.v1' },
    requiredPages: ['home'],
    requiresSlots: [],
    dependencies: [],
    conflicts: [],
    preview: { dir: 'preview', kinds: ['normal', 'empty', 'error', 'long'] },
    release: { stage: 'online-ready', knownLimits: [] },
  };
  const merged = { ...manifest, ...((overrides && overrides.manifest) || {}) };
  return { id, version, kind, dir: path.join(REPO, 'templates', 'components', id, version), manifest: merged };
}

function loadedWith(assets) {
  const all = [asset('base', 'ordering-base', '1.0.0', { manifest: baseManifest() }), ...assets];
  const byKey = new Map(all.map((item) => [item.id + '@' + item.version, item]));
  return {
    ok: true,
    registry: { registryVersion: REGISTRY_VERSION, assets: all },
    registryDigest: 'sha256:' + 'a'.repeat(64),
    assets: all,
    byKey,
  };
}

test('正常 Plan 解析成功且输出稳定排序', () => {
  const result = resolvePlan(basePlan(), loadedWith([]));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.capabilitySet, []);
  assert.deepStrictEqual(result.pageIds, ['home', 'menu', 'checkout', 'orders', 'order-detail', 'mine', 'merchant-orders']);
  assert.strictEqual(result.baseSrc.endsWith('src'), true);
});

test('主题低对比度被拒绝', () => {
  const plan = basePlan();
  plan.themeTokens.textColor = '#FFFFFF';
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.code, 'THEME_CONTRAST_LOW');
  assert.strictEqual(result.path, 'themeTokens.textColor');
  assert.ok(contrastRatio('#FAF7F1', '#FFFFFF') < 4.5);
});

test('未知主题 Token 被拒绝', () => {
  const plan = basePlan();
  plan.themeTokens.shadowColor = '#000000';
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.code, 'THEME_TOKEN_UNKNOWN');
});

test('未登记资产与可用版本提示', () => {
  const plan = basePlan();
  plan.components = [{ id: 'ghost-block', version: '1.0.0' }];
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.code, 'ASSET_NOT_REGISTERED');

  const blocked = asset('ui-block', 'store-header', '1.0.0');
  const plan2 = basePlan();
  plan2.components = [{ id: 'store-header', version: '2.0.0' }];
  const versionResult = resolvePlan(plan2, loadedWith([blocked]));
  assert.strictEqual(versionResult.code, 'ASSET_VERSION_NOT_FOUND');
  assert.deepStrictEqual(versionResult.details.available, ['1.0.0']);
});

test('高版本可用但不自动升级', () => {
  const plan = basePlan();
  plan.components = [{ id: 'store-header', version: '1.0.0' }];
  const result = resolvePlan(plan, loadedWith([
    asset('ui-block', 'store-header', '1.0.0'),
    asset('ui-block', 'store-header', '1.1.0'),
  ]));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.updatesAvailable, [{ id: 'store-header', current: '1.0.0', available: '1.1.0' }]);
  assert.deepStrictEqual(result.capabilitySet, ['store-header']);
});

test('缺依赖拒绝且不自动补依赖', () => {
  const plan = basePlan();
  plan.features = [{ id: 'poster-carousel', version: '1.0.0', slots: [] }];
  const feature = asset('feature-pack', 'poster-carousel', '1.0.0', {
    manifest: {
      dependencies: [{ id: 'hero-carousel', version: '1.0.0' }],
      requiresSlots: ['home-hero'],
    },
  });
  const result = resolvePlan(plan, loadedWith([feature]));
  assert.strictEqual(result.code, 'DEPENDENCY_MISSING');
  assert.strictEqual(result.details.id, 'hero-carousel');
});

test('依赖成环被拒绝并给出环路径', () => {
  const plan = basePlan();
  plan.components = [{ id: 'block-a', version: '1.0.0' }];
  const a = asset('ui-block', 'block-a', '1.0.0', { manifest: { dependencies: [{ id: 'block-b', version: '1.0.0' }] } });
  const b = asset('ui-block', 'block-b', '1.0.0', { manifest: { dependencies: [{ id: 'block-a', version: '1.0.0' }] } });
  const result = resolvePlan(plan, loadedWith([a, b]));
  assert.strictEqual(result.code, 'DEPENDENCY_CYCLE');
  assert.ok(result.details.cycle.includes('block-a'));
});

test('资产冲突被拒绝', () => {
  const plan = basePlan();
  plan.components = [
    { id: 'block-a', version: '1.0.0' },
    { id: 'block-b', version: '1.0.0' },
  ];
  const a = asset('ui-block', 'block-a', '1.0.0', { manifest: { conflicts: ['block-b'] } });
  const b = asset('ui-block', 'block-b', '1.0.0');
  const result = resolvePlan(plan, loadedWith([a, b]));
  assert.strictEqual(result.code, 'ASSET_CONFLICT');
  assert.deepStrictEqual([result.details.a, result.details.b], ['block-a', 'block-b']);
});

test('同一资产多版本被拒绝', () => {
  const plan = basePlan();
  plan.components = [
    { id: 'block-a', version: '1.0.0' },
    { id: 'block-a', version: '1.1.0' },
  ];
  const result = resolvePlan(plan, loadedWith([
    asset('ui-block', 'block-a', '1.0.0'),
    asset('ui-block', 'block-a', '1.1.0'),
  ]));
  assert.strictEqual(result.code, 'VERSION_CONFLICT');
});

test('插槽：类型、容量、未知、重复与必需缺失', () => {
  const plan = basePlan();
  plan.features = [{ id: 'poster-carousel', version: '1.0.0', slots: [{ slotId: 'menu-aside', dataKey: 'poster' }] }];
  const feature = asset('feature-pack', 'poster-carousel', '1.0.0', { manifest: { requiresSlots: ['menu-aside'] } });
  assert.strictEqual(resolvePlan(plan, loadedWith([feature])).code, 'SLOT_TYPE_REJECTED');

  const planUnknown = basePlan();
  planUnknown.features = [{ id: 'poster-carousel', version: '1.0.0', slots: [{ slotId: 'home-footer', dataKey: 'poster' }] }];
  assert.strictEqual(resolvePlan(planUnknown, loadedWith([feature])).code, 'SLOT_UNKNOWN');

  const planCapacity = basePlan();
  planCapacity.features = [
    { id: 'pack-a', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: 'hero' }] },
    { id: 'pack-b', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: 'hero' }] },
  ];
  const capacityResult = resolvePlan(planCapacity, loadedWith([
    asset('feature-pack', 'pack-a', '1.0.0'),
    asset('feature-pack', 'pack-b', '1.0.0'),
  ]));
  assert.strictEqual(capacityResult.code, 'SLOT_CAPACITY_EXCEEDED');

  const planMissing = basePlan();
  planMissing.features = [{ id: 'poster-carousel', version: '1.0.0', slots: [] }];
  const poster = asset('feature-pack', 'poster-carousel', '1.0.0', { manifest: { requiresSlots: ['home-hero'] } });
  assert.strictEqual(resolvePlan(planMissing, loadedWith([poster])).code, 'SLOT_REQUIRED_MISSING');

  const planDuplicate = basePlan();
  planDuplicate.features = [{
    id: 'poster-carousel', version: '1.0.0',
    slots: [{ slotId: 'home-hero', dataKey: 'a' }, { slotId: 'home-hero', dataKey: 'b' }],
  }];
  const duplicate = asset('feature-pack', 'poster-carousel', '1.0.0', { manifest: { requiresSlots: ['home-hero'] } });
  assert.strictEqual(resolvePlan(planDuplicate, loadedWith([duplicate])).code, 'SLOT_DUPLICATED');
});

test('插槽 props 校验类型、必填与未知键', () => {
  const make = (props) => {
    const plan = basePlan();
    plan.features = [{ id: 'pack-a', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: 'hero', props }] }];
    return plan;
  };
  const manifest = {
    interface: {
      props: [
        { name: 'items', type: 'array', required: true },
        { name: 'interval', type: 'number', required: false },
      ],
      events: [],
    },
    requiresSlots: ['home-hero'],
  };
  const pack = asset('feature-pack', 'pack-a', '1.0.0', { manifest });

  assert.strictEqual(resolvePlan(make({}), loadedWith([pack])).code, 'PROP_REQUIRED_MISSING');
  assert.strictEqual(resolvePlan(make({ items: [], interval: 'fast' }), loadedWith([pack])).code, 'PROP_TYPE_MISMATCH');
  assert.strictEqual(resolvePlan(make({ items: [], unknown: 1 }), loadedWith([pack])).code, 'PROP_UNKNOWN');
});

test('Base 与 API 契约不兼容被拒绝', () => {
  const plan = basePlan();
  plan.components = [{ id: 'block-a', version: '1.0.0' }];
  const incompatible = asset('ui-block', 'block-a', '1.0.0', {
    manifest: { compatibility: { baseRange: '^2.0.0', minWechatLib: '3.0.0', apiContract: 'storefront.v1' } },
  });
  assert.strictEqual(resolvePlan(plan, loadedWith([incompatible])).code, 'BASE_VERSION_INCOMPATIBLE');

  const apiIncompatible = asset('ui-block', 'block-a', '1.0.0', {
    manifest: { compatibility: { baseRange: '^1.0.0', minWechatLib: '3.0.0', apiContract: 'storefront.v2' } },
  });
  assert.strictEqual(resolvePlan(plan, loadedWith([apiIncompatible])).code, 'API_CONTRACT_INCOMPATIBLE');
});

test('preview-only 未确认拒绝，确认后进入 previewOnly 列表', () => {
  const plan = basePlan();
  plan.components = [{ id: 'preview-block', version: '1.0.0' }];
  const previewAsset = asset('ui-block', 'preview-block', '1.0.0', {
    manifest: { release: { stage: 'preview-only', knownLimits: ['后端能力未实现'] } },
  });
  assert.strictEqual(resolvePlan(plan, loadedWith([previewAsset])).code, 'PREVIEW_ONLY_NOT_ACKNOWLEDGED');

  const acked = { ...plan, previewOnlyAck: true };
  const result = resolvePlan(acked, loadedWith([previewAsset]));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.previewOnly, ['preview-block']);
  assert.deepStrictEqual(result.onlineReady, []);

  const online = resolvePlan(acked, loadedWith([previewAsset]), { onlineRecipe: true });
  assert.strictEqual(online.code, 'PREVIEW_ONLY_IN_ONLINE_RECIPE');
});

test('显式降级允许移除资产并上报', () => {
  const plan = basePlan();
  plan.components = [{ id: 'ghost-block', version: '1.0.0' }];
  plan.degradations = [{ assetId: 'ghost-block', reason: '后端能力未就绪' }];
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.degraded, [{ assetId: 'ghost-block', version: '1.0.0', reason: '后端能力未就绪' }]);
});

test('缺少 Base 必选页面被拒绝', () => {
  const plan = basePlan();
  plan.pages = plan.pages.filter((page) => page.pageId !== 'merchant-orders');
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.code, 'BASE_REQUIRED_PAGE_MISSING');
});

test('Plan 页面不在 Base 被拒绝', () => {
  const plan = basePlan();
  plan.pages.push({ pageId: 'coupon-center' });
  const result = resolvePlan(plan, loadedWith([]));
  assert.strictEqual(result.code, 'PAGE_NOT_IN_BASE');
});
test('customer 只要求顾客必选页面', () => {
  const plan = basePlan();
  plan.pages = plan.pages.filter((page) => page.pageId !== 'merchant-orders');
  const result = resolvePlan(plan, loadedWith([]), { role: 'customer' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.pageIds, ['home', 'menu', 'checkout', 'orders', 'order-detail', 'mine']);

  const missing = basePlan();
  missing.pages = missing.pages.filter((page) => page.pageId !== 'merchant-orders' && page.pageId !== 'home');
  const rejected = resolvePlan(missing, loadedWith([]), { role: 'customer' });
  assert.strictEqual(rejected.code, 'BASE_REQUIRED_PAGE_MISSING');
  assert.strictEqual(rejected.details.pageId, 'home');
});

test('merchant 只要求店主必选页面', () => {
  const plan = basePlan();
  plan.pages = plan.pages.filter((page) => page.pageId === 'merchant-orders');
  const result = resolvePlan(plan, loadedWith([]), { role: 'merchant' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.pageIds, ['merchant-orders']);

  const missing = basePlan();
  missing.pages = missing.pages.filter((page) => page.pageId === 'home');
  const rejected = resolvePlan(missing, loadedWith([]), { role: 'merchant' });
  assert.strictEqual(rejected.code, 'BASE_REQUIRED_PAGE_MISSING');
  assert.strictEqual(rejected.details.pageId, 'merchant-orders');
});

test('combined 保持全量必选页校验，非法 role 明确拒绝', () => {
  const plan = basePlan();
  plan.pages = plan.pages.filter((page) => page.pageId !== 'merchant-orders');
  assert.strictEqual(resolvePlan(plan, loadedWith([])).code, 'BASE_REQUIRED_PAGE_MISSING');
  assert.strictEqual(resolvePlan(plan, loadedWith([]), { role: 'combined' }).code, 'BASE_REQUIRED_PAGE_MISSING');

  const invalid = resolvePlan(basePlan(), loadedWith([]), { role: 'owner' });
  assert.strictEqual(invalid.code, 'ROLE_INVALID');
  assert.strictEqual(invalid.path, 'role');
  assert.ok(invalid.message.includes('customer'));
});