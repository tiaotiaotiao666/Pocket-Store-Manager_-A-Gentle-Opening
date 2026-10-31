'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const { buildPayResult, loadingPayResult, errorPayResult } = require(path.join(REPO, 'miniprogram', 'domain', 'payResult.js'));
const BASE = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const MIRROR = path.join(REPO, 'miniprogram');

function view(overrides) {
  return {
    id: 'order-123456',
    shortId: '123456',
    status: 'PREPARING',
    paymentStatus: 'DEMO_PAID',
    totalText: '¥32.00',
    fulfillmentText: '堂食 · 8 号桌',
    ...overrides,
  };
}

test('DEMO_PAID → success，取餐号来自订单 shortId', () => {
  const result = buildPayResult(view());
  assert.strictEqual(result.state, 'success');
  assert.strictEqual(result.shortId, '123456');
  assert.strictEqual(result.totalText, '¥32.00');
  assert.strictEqual(result.fulfillmentText, '堂食 · 8 号桌');
});

test('UNPAID / PENDING_PAYMENT → pending', () => {
  assert.strictEqual(buildPayResult(view({ paymentStatus: 'UNPAID' })).state, 'pending');
  assert.strictEqual(buildPayResult(view({ status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' })).state, 'pending');
});

test('已取消订单不展示结果页', () => {
  assert.strictEqual(buildPayResult(view({ status: 'CANCELLED' })), null);
  assert.strictEqual(buildPayResult(null), null);
});

test('loading / error 覆盖状态与文案，不会被 pending 覆盖', () => {
  const loading = loadingPayResult(view({ paymentStatus: 'UNPAID' }));
  assert.strictEqual(loading.state, 'loading');
  assert.ok(loading.title.includes('正在确认'));

  const error = errorPayResult(view({ paymentStatus: 'UNPAID' }), { message: '网络超时', requestId: 'req-1' });
  assert.strictEqual(error.state, 'error');
  assert.strictEqual(error.description, '网络超时');
  assert.strictEqual(error.requestId, 'req-1');
});

test('结果页四态文案与按钮映射（组件 observer）', () => {
  const source = fs.readFileSync(path.join(MIRROR, 'components', 'pay-result', 'index.js'), 'utf8');
  let definition = null;
  vm.runInNewContext(source, {
    Component: (def) => { definition = def; },
    require: () => ({}),
    console,
  });
  assert.ok(definition, '组件定义未捕获');
  const observer = definition.observers['state, title, description, primaryText, secondaryText'];
  assert.strictEqual(typeof observer, 'function');

  const cases = [
    { state: 'loading', primary: '', showNumber: false, hasError: false },
    { state: 'success', primary: '查看订单进度', showNumber: true, hasError: false },
    { state: 'pending', primary: '刷新状态', showNumber: true, hasError: false },
    { state: 'error', primary: '重试支付', showNumber: false, hasError: true },
  ];
  for (const item of cases) {
    const data = { state: item.state };
    const ctx = { data, setData(patch) { Object.assign(data, patch); } };
    observer.call(ctx, item.state, '', '', '', '');
    assert.strictEqual(data.primary, item.primary, item.state + ' 主按钮');
    assert.strictEqual(data.showNumber, item.showNumber, item.state + ' 取餐号');
    assert.strictEqual(data.hasError, item.hasError, item.state + ' 错误态');
    assert.ok(data.headline, item.state + ' 缺少标题');
  }

  const data = { state: 'success' };
  const ctx = { data, setData(patch) { Object.assign(data, patch); } };
  observer.call(ctx, 'success', '', '', '', '');
  assert.strictEqual(data.secondary, '返回订单列表');
});

test('演示声明出现在成功态，且组件不调用 wx / 路由 / globalData', () => {
  const wxml = fs.readFileSync(path.join(MIRROR, 'components', 'pay-result', 'index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(MIRROR, 'components', 'pay-result', 'index.js'), 'utf8');
  assert.ok(js.includes('本页为演示付款，未发生真实扣款，取餐号仅用于演示。'));
  assert.ok(wxml.includes('demoNotice'));
  assert.ok(!/wx\.(request|navigateTo|redirectTo|switchTab)/.test(js));
  assert.ok(!/globalData/.test(js));
});

test('订单详情注册 pay-result，且不新增页面', () => {
  const json = JSON.parse(fs.readFileSync(path.join(MIRROR, 'pages', 'order-detail', 'index.json'), 'utf8'));
  assert.ok(json.usingComponents['pay-result']);
  const appJson = JSON.parse(fs.readFileSync(path.join(MIRROR, 'app.json'), 'utf8'));
  assert.strictEqual(appJson.pages.length, 7);
  assert.ok(!appJson.pages.includes('pages/order-result/index'));
});

test('商家身份从 ?pay=1 进入时重定向回接单列表', () => {
  const source = fs.readFileSync(path.join(MIRROR, 'pages', 'order-detail', 'index.js'), 'utf8');
  assert.ok(source.includes('session.isMerchantOf'));
  assert.ok(source.includes("wx.redirectTo({ url: '/pages/merchant-orders/index' })"));
  assert.ok(source.includes("platform.toast('店主身份不进行顾客支付')"));
  assert.ok(source.includes('payResultView.buildPayResult'));
});

test('Base 与镜像的支付结果文件一致', () => {
  for (const relative of [
    'components/pay-result/index.js',
    'components/pay-result/index.json',
    'components/pay-result/index.wxml',
    'components/pay-result/index.wxss',
    'domain/payResult.js',
    'pages/order-detail/index.js',
    'pages/order-detail/index.json',
    'pages/order-detail/index.wxml',
    'pages/order-detail/index.wxss',
  ]) {
    const baseFile = path.join(BASE, relative);
    const mirrorFile = path.join(MIRROR, relative);
    assert.ok(fs.existsSync(baseFile), 'Base 缺少 ' + relative);
    assert.strictEqual(fs.readFileSync(baseFile, 'utf8'), fs.readFileSync(mirrorFile, 'utf8'), '内容不一致：' + relative);
  }
});