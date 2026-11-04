'use strict';

/**
 * T11：导出侧消费展示声明（C-PLAN-PRESENTATION@1 + C-SIZE-TOKENS@1）的回归测试。
 *
 * 覆盖：
 * - `buildThemeWxss(theme, presentationTokens)` 输出两个尺寸 CSS 变量，值取自
 *   `templates/presentation/size-tokens.v1.json` 的 rpx，缺省 `md`；
 * - `buildSlotsModule()` 以 `assignment.dataKey` 作为配置键（含 `menuHero`），
 *   `props.size` 原样透传；
 * - Base manifest 声明 `menu-hero` 且不新增 `dataKey` 字段，菜单页 wxml 有完整锚点；
 * - 海报 Feature Pack 声明并应用 `size`（三档 rpx + 默认 md）；
 * - 端到端 `buildProjectFiles`：菜单页锚点被替换为 `<poster-carousel>`，
 *   `pages/menu/index.json` 的 `usingComponents` 含 `poster-carousel`。
 *
 * 说明：本文件不读 `registry.lock.json`，全部用「真实模板文件 + 桩 graph」，
 * 因为模板资产改动后的摘要刷新由 T12 统一执行。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const EMIT = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));

const BASE_DIR = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_MANIFEST_FILE = path.join(BASE_DIR, 'manifest.json');
const MENU_WXML_FILE = path.join(BASE_DIR, 'src', 'pages', 'menu', 'index.wxml');
const STORE_HEADER_WXSS_FILE = path.join(BASE_DIR, 'src', 'components', 'store-header', 'index.wxss');
const PRODUCT_CARD_WXSS_FILE = path.join(BASE_DIR, 'src', 'components', 'product-card', 'index.wxss');
const POSTER_DIR = path.join(REPO, 'templates', 'features', 'poster-carousel', '1.0.0');
const POSTER_MANIFEST_FILE = path.join(POSTER_DIR, 'manifest.json');
const POSTER_COMPONENT_DIR = path.join(POSTER_DIR, 'src', 'components', 'poster-carousel');
const SIZE_TOKENS_FILE = path.join(REPO, 'templates', 'presentation', 'size-tokens.v1.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function text(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function sizeTokens() {
  return readJson(SIZE_TOKENS_FILE);
}

/** 与 Base manifest 对齐的完整主题 token，避免 fillThemeDefaults 干扰断言。 */
function themeTokens() {
  return {
    pageBackground: '#FFF8F1',
    primaryColor: '#E86A17',
    accentColor: '#1F6F54',
    textColor: '#2F2A25',
    tabBarBackground: '#FFFFFF',
    tabBarColor: '#8A8178',
    tabBarSelectedColor: '#E86A17',
  };
}

/**
 * 构造最小 graph：Base 使用真实模板目录（读盘），Feature 使用真实海报组件目录。
 * `assignments` 的 key 与 resolve 一致（`pageId#slotId`），条目带 `dataKey`。
 */
function makeGraph(options) {
  const opts = options || {};
  const baseManifest = readJson(BASE_MANIFEST_FILE);
  const posterManifest = readJson(POSTER_MANIFEST_FILE);
  const asset = {
    id: 'poster-carousel',
    version: '1.0.0',
    kind: 'feature-pack',
    dir: POSTER_DIR,
    manifest: posterManifest,
  };
  const feature = { id: 'poster-carousel', version: '1.0.0' };
  const slot = {
    slotId: opts.targetSlotId || 'menu-hero',
    pageId: opts.targetPageId || 'menu',
    dataKey: opts.dataKey || 'menuHero',
    props: {
      items: [{ id: 'poster-1', title: '秋日暖锅上新', subtitle: '两人份 · 到店自取也可', tone: 'warm' }],
      autoplay: true,
      interval: 4000,
      showIndicator: true,
      size: 'md',
    },
  };
  const assignments = new Map();
  if (opts.withAssignment !== false) {
    assignments.set(slot.pageId + '#' + slot.slotId, [{
      asset,
      feature,
      slot,
      pageId: slot.pageId,
      slotId: slot.slotId,
      dataKey: slot.dataKey,
      placement: 'slotOrder',
    }]);
  }
  const plan = {
    planId: 'ordering-starter',
    planVersion: '1.0.0',
    pages: baseManifest.pages.map((page) => ({ pageId: page.pageId, enabled: true })),
    storeProfile: { name: '示例小馆', category: '简餐', address: '', phone: '', notes: '' },
    apiBinding: { contract: 'storefront.v1', baseUrl: 'http://127.0.0.1:3000/api/v1' },
    themeTokens: themeTokens(),
    features: opts.withAssignment === false ? [] : [{ id: feature.id, version: feature.version, slots: [slot] }],
  };
  if (opts.presentationTokens) plan.presentationTokens = opts.presentationTokens;
  return {
    ok: true,
    base: { dir: BASE_DIR, manifest: baseManifest },
    baseDir: BASE_DIR,
    baseSrc: path.join(BASE_DIR, baseManifest.entry.root),
    plan,
    assignments,
    pageIds: plan.pages.map((page) => page.pageId),
    themeTokens: plan.themeTokens,
    presentationTokens: opts.presentationTokens,
    onlineReady: ['poster-carousel'],
    previewOnly: [],
    updatesAvailable: [],
    degraded: [],
  };
}

// ---------------------------------------------------------------------------
// 尺寸 CSS 变量
// ---------------------------------------------------------------------------

test('buildThemeWxss 缺省 presentationTokens 时输出 md 档 rpx 变量', () => {
  const wxss = EMIT.buildThemeWxss(themeTokens(), undefined);
  const tokens = sizeTokens();
  assert.ok(wxss.includes('--store-home-hero-min-height: ' + tokens.sizes.homeHero.md.rpx + 'rpx;'), wxss);
  assert.ok(wxss.includes('--store-product-card-min-height: ' + tokens.sizes.productCard.md.rpx + 'rpx;'), wxss);
  assert.strictEqual(tokens.sizes.homeHero.md.rpx, 190);
  assert.strictEqual(tokens.sizes.productCard.md.rpx, 140);
});

test('buildThemeWxss 按 homeHeroSize=lg / productCardSize=sm 取值', () => {
  const wxss = EMIT.buildThemeWxss(themeTokens(), { homeHeroSize: 'lg', productCardSize: 'sm' });
  assert.ok(wxss.includes('--store-home-hero-min-height: 250rpx;'), wxss);
  assert.ok(wxss.includes('--store-product-card-min-height: 110rpx;'), wxss);
});

test('buildThemeWxss 三档取值与 size-tokens.v1.json 的 rpx 完全一致', () => {
  const tokens = sizeTokens();
  for (const step of ['sm', 'md', 'lg']) {
    const wxss = EMIT.buildThemeWxss(themeTokens(), { homeHeroSize: step, productCardSize: step });
    assert.ok(
      wxss.includes('--store-home-hero-min-height: ' + tokens.sizes.homeHero[step].rpx + 'rpx;'),
      'homeHero ' + step + ' → ' + tokens.sizes.homeHero[step].rpx + 'rpx',
    );
    assert.ok(
      wxss.includes('--store-product-card-min-height: ' + tokens.sizes.productCard[step].rpx + 'rpx;'),
      'productCard ' + step + ' → ' + tokens.sizes.productCard[step].rpx + 'rpx',
    );
  }
});

test('buildThemeWxss 不以 px 输出小程序尺寸（导出只用 rpx）', () => {
  const wxss = EMIT.buildThemeWxss(themeTokens(), { homeHeroSize: 'lg' });
  assert.doesNotMatch(wxss, /--store-(?:home-hero|product-card)-min-height:\s*\d+px;/);
});

// ---------------------------------------------------------------------------
// 插槽配置：dataKey 映射
// ---------------------------------------------------------------------------

test('buildSlotsModule 用 assignment.dataKey 作为配置键并固定输出 menuHero', () => {
  const module = EMIT.buildSlotsModule(makeGraph());
  assert.ok(module.includes('"menuHero": ['), module);
  assert.ok(module.includes('"homeHero": []'), module);
  assert.ok(module.includes('"homeMarketing": []'), module);
  assert.ok(module.includes('"menuAside": []'), module);
  // 海报落在 menu-hero 时不得被塞进 menuAside。
  assert.match(module, /"menuHero": \[\s*\{\s*"assetId": "poster-carousel"/);
  assert.match(module, /"menuAside": \[\]/);
});

test('buildSlotsModule 原样透传 props.size，并保持组件 tag/assetId', () => {
  const module = EMIT.buildSlotsModule(makeGraph());
  assert.ok(module.includes('"component": "poster-carousel"'), module);
  assert.match(module, /"props": \{[\s\S]*?"size": "md"/);
  assert.match(module, /"props": \{[\s\S]*?"interval": 4000/);
});

test('buildSlotsModule 对声明落位（home-hero）同样使用 dataKey', () => {
  const graph = makeGraph({ targetSlotId: 'home-hero', targetPageId: 'home', dataKey: 'homeHero' });
  const module = EMIT.buildSlotsModule(graph);
  assert.match(module, /"homeHero": \[\s*\{\s*"assetId": "poster-carousel"/);
  assert.match(module, /"menuHero": \[\]/);
});

// ---------------------------------------------------------------------------
// Base 插槽与菜单页锚点
// ---------------------------------------------------------------------------

test('Base manifest 声明 menu-hero（menu / maxItems 1 / feature-pack+ui-block）且不新增 dataKey', () => {
  const manifest = readJson(BASE_MANIFEST_FILE);
  const slot = manifest.slots.find((item) => item.slotId === 'menu-hero');
  assert.ok(slot, '缺少 menu-hero 插槽声明');
  assert.strictEqual(slot.pageId, 'menu');
  assert.strictEqual(slot.maxItems, 1);
  assert.deepStrictEqual(slot.accepts, ['feature-pack', 'ui-block']);
  assert.strictEqual(slot.required, false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(slot, 'dataKey'), false);
  for (const declared of manifest.slots) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(declared, 'dataKey'), false);
  }
});

test('菜单页 wxml 有完整的 @slot:menu-hero 锚点与 fallback', () => {
  const wxml = text(MENU_WXML_FILE);
  const begin = wxml.indexOf('<!-- @slot:menu-hero -->');
  const fallbackBegin = wxml.indexOf('<!-- @slot-fallback:menu-hero -->');
  const fallbackEnd = wxml.indexOf('<!-- @slot-fallback:menu-hero:end -->');
  const end = wxml.indexOf('<!-- @slot:menu-hero:end -->');
  assert.ok(begin >= 0, '缺少 @slot:menu-hero 锚点');
  assert.ok(fallbackBegin > begin, '缺少 fallback 起始锚点');
  assert.ok(fallbackEnd > fallbackBegin, '缺少 fallback 结束锚点');
  assert.ok(end > fallbackEnd, '缺少 @slot:menu-hero:end 锚点');
});

test('Base 组件样式消费尺寸变量且兜底值为原硬编码值', () => {
  const header = text(STORE_HEADER_WXSS_FILE);
  const card = text(PRODUCT_CARD_WXSS_FILE);
  assert.match(header, /min-height:\s*var\(--store-home-hero-min-height,\s*190rpx\)/);
  assert.match(card, /width:\s*var\(--store-product-card-min-height,\s*168rpx\)/);
  assert.match(card, /height:\s*var\(--store-product-card-min-height,\s*168rpx\)/);
});

// ---------------------------------------------------------------------------
// 海报 Feature Pack 的 size prop
// ---------------------------------------------------------------------------

test('海报 manifest 声明 size（string、非必填）', () => {
  const manifest = readJson(POSTER_MANIFEST_FILE);
  const prop = manifest.interface.props.find((item) => item.name === 'size');
  assert.ok(prop, 'manifest 未声明 size prop');
  assert.strictEqual(prop.type, 'string');
  assert.strictEqual(prop.required, false);
});

test('海报组件声明 properties.size 默认 md，wxml 输出 size 类', () => {
  const js = text(path.join(POSTER_COMPONENT_DIR, 'index.js'));
  const wxml = text(path.join(POSTER_COMPONENT_DIR, 'index.wxml'));
  assert.match(js, /const DEFAULT_SIZE = 'md';/);
  assert.match(js, /size:\s*\{\s*type:\s*String,\s*value:\s*DEFAULT_SIZE\s*,?\s*\}/);
  assert.match(wxml, /class="poster-carousel poster-carousel--\{\{size\}\}"/);
});

test('海报 wxss 三档高度与尺寸表 rpx 一致，默认档为 md', () => {
  const wxss = text(path.join(POSTER_COMPONENT_DIR, 'index.wxss'));
  const tokens = sizeTokens();
  for (const step of ['sm', 'md', 'lg']) {
    assert.match(
      wxss,
      new RegExp('\\.poster-carousel--' + step + ' \\.poster-swiper\\s*\\{\\s*height:\\s*' + tokens.sizes.carousel[step].rpx + 'rpx;'),
      'carousel ' + step + ' → ' + tokens.sizes.carousel[step].rpx + 'rpx',
    );
  }
  assert.strictEqual(tokens.sizes.carousel.md.rpx, 240);
});

// ---------------------------------------------------------------------------
// 端到端 emit
// ---------------------------------------------------------------------------

test('导出工程：theme.generated.wxss 含尺寸变量，菜单页替换为海报并挂载 menuHero 配置', () => {
  const graph = makeGraph({ presentationTokens: { homeHeroSize: 'lg', productCardSize: 'md' } });
  const result = EMIT.buildProjectFiles(graph, {
    mode: 'development',
    projectName: 'presentation-emit',
    theme: themeTokens(),
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const theme = result.files.get('theme.generated.wxss').toString('utf8');
  assert.match(theme, /--store-home-hero-min-height:\s*250rpx;/);
  assert.match(theme, /--store-product-card-min-height:\s*140rpx;/);

  const menuWxml = result.files.get('pages/menu/index.wxml').toString('utf8');
  assert.match(menuWxml, /<poster-carousel[\s\S]*?\/>/);
  assert.ok(menuWxml.includes('items="{{slotProps.menuHero[0].props.items}}"'), menuWxml);
  assert.ok(menuWxml.includes('size="{{slotProps.menuHero[0].props.size}}"'), menuWxml);
  assert.ok(menuWxml.includes('<!-- @slot:menu-hero -->'));
  assert.ok(menuWxml.includes('<!-- @slot-fallback:menu-hero -->'));

  const menuJson = JSON.parse(result.files.get('pages/menu/index.json').toString('utf8'));
  assert.strictEqual(menuJson.usingComponents['poster-carousel'], '/components/poster-carousel/index');

  const slotsModule = result.files.get('config/slots.generated.js').toString('utf8');
  assert.match(slotsModule, /"menuHero": \[\s*\{\s*"assetId": "poster-carousel"/);
  assert.ok(result.files.has('components/poster-carousel/index.wxml'));
});

test('导出工程：未占用 menu-hero 时菜单页 fallback 原样保留', () => {
  const graph = makeGraph({ withAssignment: false });
  const result = EMIT.buildProjectFiles(graph, {
    mode: 'development',
    projectName: 'presentation-emit-empty',
    theme: themeTokens(),
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const menuWxml = result.files.get('pages/menu/index.wxml').toString('utf8');
  assert.ok(!menuWxml.includes('<poster-carousel'), menuWxml);
  assert.ok(menuWxml.includes('<!-- @slot-fallback:menu-hero -->'));
  const menuJson = JSON.parse(result.files.get('pages/menu/index.json').toString('utf8'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(menuJson.usingComponents, 'poster-carousel'), false);
});