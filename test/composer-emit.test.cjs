'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { buildProjectFiles } = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

function buildGraph() {
  const loaded = loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.errors));
  const graph = resolvePlan(PLAN, loaded);
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  return graph;
}

test('端到端生成完整工程并注册全部页面', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.stats.pages, 7);
  assert.ok(result.stats.files > 100);

  const appJson = JSON.parse(result.files.get('app.json').toString('utf8'));
  assert.strictEqual(appJson.pages.length, 7);
  assert.strictEqual(appJson.tabBar.list.length, 4);
  assert.ok(appJson.pages.every((page) => result.files.has(page + '.js')));
  assert.ok(appJson.pages.every((page) => result.files.has(page + '.wxml')));

  ['app.js', 'app.wxss', 'theme.generated.wxss', 'config/store.generated.js', 'config/slots.generated.js', 'config/env.js', 'project.config.json', 'sitemap.json', 'README.md'].forEach((file) => {
    assert.ok(result.files.has(file), '缺少 ' + file);
  });
});

test('导出配置只含白名单字段且金额唯一事实为 priceCents', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  const text = result.files.get('config/store.generated.js').toString('utf8');
  assert.ok(!text.includes('priceText'));
  assert.ok(!text.includes('totalCents'));
  assert.ok(!text.includes('process.env'));
  assert.ok(text.includes('"delivery": false'));

  const sandbox = { module: { exports: {} } };
  const vm = require('node:vm');
  vm.runInNewContext(text, sandbox);
  const config = sandbox.module.exports;
  assert.strictEqual(config.schemaVersion, 2);
  assert.deepStrictEqual(Object.keys(config).sort(), [
    'api', 'catalog', 'capabilities', 'demoPaymentDisclaimer', 'fulfillmentOptions', 'meta', 'schemaVersion', 'store', 'theme',
  ].sort());
  assert.strictEqual(config.fulfillmentOptions.delivery, false);
  assert.ok(config.theme.pageBackground);
  assert.ok(config.capabilities.onlineReady.includes('store-header') === false);
});

test('主题 Token 全部写入且页面样式只引用变量', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  const theme = result.files.get('theme.generated.wxss').toString('utf8');
  ['pageBackground', 'primaryColor', 'accentColor', 'textColor', 'tabBarBackground', 'tabBarColor', 'tabBarSelectedColor'].forEach((key) => {
    assert.ok(theme.includes('--store-' + key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase()) + ':'), '缺少 Token ' + key);
  });
  assert.ok(theme.includes('--color-bg: var(--store-page-background)'));
});

test('未分配插槽时 fallback 原样保留且锚点仍在', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  const home = result.files.get('pages/home/index.wxml').toString('utf8');
  assert.ok(home.includes('<!-- @slot:home-hero -->'));
  assert.ok(/<!-- @slot-fallback:home-hero -->[\s\S]*<store-header[\s\S]*<!-- @slot-fallback:home-hero:end -->/.test(home));
  const slotsModule = result.files.get('config/slots.generated.js').toString('utf8');
  assert.ok(slotsModule.includes('"homeHero": []'));
});

test('usingComponents 只保留实际使用的组件', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  const homeJson = JSON.parse(result.files.get('pages/home/index.json').toString('utf8'));
  assert.deepStrictEqual(Object.keys(homeJson.usingComponents).sort(), [
    'error-banner', 'fulfillment-switch', 'order-card', 'state-view', 'store-header',
  ]);
  const mineJson = JSON.parse(result.files.get('pages/mine/index.json').toString('utf8'));
  assert.ok(!Object.prototype.hasOwnProperty.call(mineJson.usingComponents, 'product-card'));
});

test('产物不含动态组件加载或宿主依赖', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  for (const [file, content] of result.files.entries()) {
    if (!/\.(js|wxml|json)$/.test(file)) continue;
    const source = content.toString('utf8');
    assert.ok(!/require\(\s*[^'"]/.test(source), file + ' 含动态 require');
    assert.ok(!source.includes('process.env'), file + ' 含 process.env');
  }
});

test('相同输入两次生成逐字节一致', () => {
  const graph = buildGraph();
  const first = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  const second = buildProjectFiles(graph, { mode: 'development', projectName: 'emit-check' });
  assert.deepStrictEqual([...first.files.keys()].sort(), [...second.files.keys()].sort());
  for (const [file, content] of first.files.entries()) {
    assert.ok(Buffer.compare(content, second.files.get(file)) === 0, file + ' 两次生成不一致');
  }
});

test('production 模式缺 HTTPS Base URL 被拒绝', () => {
  const graph = buildGraph();
  const result = buildProjectFiles(graph, { mode: 'production', projectName: 'emit-check' });
  assert.strictEqual(result.ok, false);
  assert.ok(['FIELD_MISSING', 'API_BASE_URL_NOT_HTTPS'].includes(result.code), result.code);
});