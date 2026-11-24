'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const facts = require('../scripts/agent-source-facts.cjs');

const BASE_ROOT = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0');

test('SourceFacts 覆盖 8 页并包含源码路径/数据/事件/状态/组件/插槽/契约', () => {
  const snapshot = facts.buildSnapshot();
  assert.equal(snapshot.version, 'source-facts.v2');
  assert.deepEqual(Object.keys(snapshot.pages), [...facts.PAGE_IDS]);
  assert.equal(Object.keys(snapshot.components).length, 15);
  assert.equal(snapshot.plans.length, 4);
  assert.equal(snapshot.checkIds.length, 10);

  for (const pageId of facts.PAGE_IDS) {
    const page = snapshot.pages[pageId];
    for (const key of ['wxml', 'wxss', 'js', 'json']) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, page.source[key])), pageId + ' 缺少 ' + key);
    }
    assert.ok(fs.existsSync(path.join(REPO_ROOT, page.source.root, 'index.wxml')));
    assert.ok(page.source.requiredJs.length > 0);
    assert.ok(Object.keys(page.data.initial).length > 0);
    assert.ok(page.data.setData.length > 0);
    assert.ok(page.handlers.methods.length > 0);
    assert.ok(page.handlers.events.length > 0);
    assert.ok(page.uiStates.some((state) => state.key === 'loading'));
    assert.ok(page.uiStates.some((state) => state.key === 'error'));
    assert.equal(page.pageContract.pageId, pageId);
    assert.ok(page.pageContract.availableCheckIds.length > 0);
    assert.ok(page.themeTokens.length === 7);
  }
});

test('data 事实来自 data/setData，而不是只看 WXML 是否使用', () => {
  const snapshot = facts.buildSnapshot();
  const menu = snapshot.pages.menu;
  // storeId / slotProps 在页面的 data 中存在，但 Base 旧 WXML 没有读取它们。
  assert.ok(menu.data.initial.storeId, 'menu.storeId 必须在 data.initial');
  assert.ok(menu.data.initial.slotProps, 'menu.slotProps 必须在 data.initial');
  const wxml = fs.readFileSync(path.join(REPO_ROOT, menu.source.wxml), 'utf8');
  assert.ok(!/\{\{[^{}]*\bstoreId\b/.test(wxml));
  assert.ok(!/\{\{[^{}]*\bslotProps\b/.test(wxml));
  // 嵌套字面量形状仍保留
  assert.equal(menu.data.initial.cartSummary.startsWith('object{'), true);
  assert.ok(menu.data.setData.includes('cartSummary'));
});

test('v2 包含 loading/error/submitting/轮询等真实 UI 状态', () => {
  const snapshot = facts.buildSnapshot();
  const checkout = snapshot.pages.checkout;
  assert.ok(checkout.uiStates.some((state) => state.key === 'submitting' && state.kind === 'loading'));
  assert.ok(checkout.uiStates.some((state) => state.key === 'loading' && state.usedInWxml));
  const merchant = snapshot.pages['merchant-orders'];
  for (const key of ['checking', 'polling', 'ordersLoading', 'productsLoading', 'postersLoading']) {
    assert.ok(merchant.uiStates.some((state) => state.key === key), '缺少状态 ' + key);
  }
  for (const page of Object.values(snapshot.pages)) {
    for (const state of page.uiStates) {
      assert.equal(typeof state.initial, 'string');
      assert.ok(state.initial.length > 0);
    }
  }
});

test('组件事实包含四件套路径、props/events/示例/限制，并保留 feature-pack 声明', () => {
  const snapshot = facts.buildSnapshot();
  const productCard = snapshot.components['product-card'];
  assert.deepEqual(productCard.files, ['index.js', 'index.json', 'index.wxml', 'index.wxss']);
  assert.deepEqual(productCard.props.map((prop) => prop[0]), ['disabled', 'product', 'quantity']);
  assert.deepEqual(productCard.events.map((event) => event[0]), ['add', 'openDetail', 'remove']);
  assert.ok(productCard.example.includes('<product-card'));
  assert.ok(productCard.limits.some((limit) => limit.includes('priceCents')));
  const poster = snapshot.components['poster-carousel'];
  assert.equal(poster.kind, 'feature-pack');
  for (const file of poster.files) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, poster.root, file)));
  }
  assert.equal(snapshot.pages.home.pageJson.usingComponents['poster-carousel'], '/components/poster-carousel/index');
  const declaredOnly = snapshot.pages.home.components.find((component) => component.id === 'poster-carousel');
  assert.equal(declaredOnly.usedInWxml, false);
});

test('page-contract 引用均可回查，checkId 为冻结注册表', () => {
  const snapshot = facts.buildSnapshot();
  assert.deepEqual(snapshot.checkIds.map((check) => check.id), [
    'source.check',
    'mini.check',
    'composer.dry-run',
    'output.consistency',
    'unit.targeted',
    'unit.full',
    'desktop.contract',
    'catalog.check',
    'registry.check',
    'wechat.verify',
  ]);
  for (const page of Object.values(snapshot.pages)) {
    assert.equal(page.pageContract.schemaVersion, 'page-contract.v1');
    for (const handler of page.pageContract.requiredHandlers) {
      assert.ok(page.handlers.methods.includes(handler) || page.handlers.lifecycle.includes(handler));
    }
    for (const route of page.pageContract.requiredRoutes) assert.ok(page.routes.includes(route));
  }
});

test('生成结果确定：无时间戳/绝对路径，模块可重算且 --check 通过', () => {
  const first = facts.buildSnapshot();
  const second = facts.buildSnapshot();
  assert.deepEqual(first, second);
  const json = JSON.stringify(first);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(json), '快照不应包含时间戳');
  assert.ok(!/[A-Za-z]:\\\\/.test(json), '快照不应包含 Windows 绝对路径');
  assert.ok(!json.includes('C:/'), '快照不应包含绝对路径');

  const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp', 'c1-facts-test-'));
  try {
    facts.writeSnapshot({ outDir: tempDir });
    const checked = facts.checkSnapshot({ outDir: tempDir });
    assert.equal(checked.ok, true, checked.errors.join('\n'));
    assert.equal(checked.files.length, 10);
    // 重算字节一致：再写一次不应有差异
    facts.writeSnapshot({ outDir: tempDir });
    assert.equal(facts.checkSnapshot({ outDir: tempDir }).ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fail closed：缺 Base 根目录 / 非法 JS / WXML 根解析都走确定性分析', () => {
  assert.throws(() => facts.buildSnapshot({ baseRoot: path.join(REPO_ROOT, '.tmp', 'no-such-base') }), /Base 根目录|manifest/);
  assert.throws(() => facts.analyzePageScript(require('typescript'), 'bad.js', 'Page({'), /data|Page/);
  const wxmlFacts = facts.analyzeWxml('<view wx:if="{{loading}}">{{noSuchRoot}}</view>', 'fixture');
  assert.deepEqual(wxmlFacts.mustacheRoots, ['loading', 'noSuchRoot']);
  assert.throws(() => facts.buildSnapshot({ catalogRoot: path.join(REPO_ROOT, '.tmp', 'no-such-catalog') }), /Catalog 根目录/);
});
