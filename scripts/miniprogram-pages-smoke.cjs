#!/usr/bin/env node
/**
 * B2 页面级集成冒烟（真实后端 + 页面方法直调）。
 *
 * 用最小 Page/wx 运行时加载 7 个页面，按真实用户路径调用生命周期与事件处理函数，
 * 验证「扫码 → 菜单 → 加购 → 结算 → 创建订单 → 模拟支付 → 店主接单 → 制作 → 可取 → 完成」
 * 的页面状态与服务层接线。它不能替代微信开发者工具的视觉检查，但能覆盖点击链路背后的逻辑。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.MINIPROGRAM_API_BASE_URL =
  process.env.MINIPROGRAM_API_BASE_URL || 'http://127.0.0.1:3000/api/v1';

const root = path.resolve(__dirname, '..');
const platform = require(path.join(root, 'miniprogram/services/platform'));
const session = require(path.join(root, 'miniprogram/services/session'));
const auth = require(path.join(root, 'miniprogram/services/auth'));
const cartStore = require(path.join(root, 'miniprogram/state/cart-store'));
const visitStore = require(path.join(root, 'miniprogram/state/visit-store'));

const navigation = [];
const steps = [];

let capturedPage = null;

global.Page = (config) => {
  capturedPage = config;
};

global.wx = {
  redirectTo(options) {
    navigation.push({ type: 'redirectTo', url: options.url });
  },
  navigateTo(options) {
    navigation.push({ type: 'navigateTo', url: options.url });
  },
  switchTab(options) {
    navigation.push({ type: 'switchTab', url: options.url });
  },
  reLaunch(options) {
    navigation.push({ type: 'reLaunch', url: options.url });
  },
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  showModal(options) {
    if (options && options.success) {
      options.success({ confirm: true, cancel: false, content: '' });
    }
  },
  showActionSheet(options) {
    if (options && options.success) {
      options.success({ tapIndex: 0 });
    }
  },
};

function loadPage(name) {
  const file = path.join(root, 'miniprogram/pages', name, 'index.js');
  delete require.cache[require.resolve(file)];
  capturedPage = null;
  require(file);
  assert.ok(capturedPage, '页面 ' + name + ' 未调用 Page()');
  const definition = capturedPage;
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch || {});
  };
  return page;
}

function waitFor(predicate, label, timeout) {
  const limit = timeout || 8000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let value = false;
      try {
        value = predicate();
      } catch (error) {
        value = false;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - start > limit) {
        clearInterval(timer);
        reject(new Error('等待超时：' + label));
      }
    }, 40);
  });
}

function step(name) {
  steps.push(name);
  console.log('  ✓ ' + name);
}

function lastNavigation() {
  return navigation[navigation.length - 1] || null;
}

function queryOf(url) {
  const index = String(url || '').indexOf('?');
  const result = {};
  if (index < 0) {
    return result;
  }
  String(url)
    .slice(index + 1)
    .split('&')
    .forEach((pair) => {
      if (!pair) {
        return;
      }
      const separator = pair.indexOf('=');
      const key = decodeURIComponent(separator >= 0 ? pair.slice(0, separator) : pair);
      const value = separator >= 0 ? decodeURIComponent(pair.slice(separator + 1)) : '';
      result[key] = value;
    });
  return result;
}

async function main() {
  console.log('\nB2 页面级集成冒烟（真实后端）\n');

  platform.memoryStorage.clear();
  session.clear();
  visitStore.reset();
  navigation.length = 0;

  const home = loadPage('home');
  home.onLoad({ scene: encodeURIComponent('storeId=store-demo-001&tableId=tbl_A01') });
  await waitFor(() => home.data.loading === false && home.data.store, '首页加载门店');
  assert.equal(home.data.store.name, '柑橘小馆');
  assert.equal(home.data.mode, 'DINE_IN');
  assert.equal(home.data.tableName, 'A01');
  assert.equal(home.data.identityLabel, '演示顾客');
  step('首页解析扫码 scene：堂食 A01 桌 + 演示顾客自动登录');

  home.onModeChange({ detail: { value: 'TAKEAWAY' } });
  assert.equal(home.data.mode, 'TAKEAWAY');
  home.onModeChange({ detail: { value: 'DINE_IN' } });
  assert.equal(home.data.mode, 'DINE_IN');
  home.onPickTable({ currentTarget: { dataset: { id: 'tbl_A02', name: 'A02' } } });
  assert.equal(home.data.tableName, 'A02');
  home.onPickTable({ currentTarget: { dataset: { id: 'tbl_A01', name: 'A01' } } });
  step('首页切换履约方式与演示桌号');

  home.goMenu();
  assert.equal(lastNavigation().type, 'switchTab');
  assert.equal(lastNavigation().url, '/pages/menu/index');
  step('首页「开始点餐」跳转菜单 tab');

  const menu = loadPage('menu');
  menu.onLoad();
  await waitFor(() => menu.data.loading === false && menu.data.categories.length > 0, '菜单加载目录');
  assert.equal(menu.data.mode, 'DINE_IN');
  assert.equal(menu.data.tableName, 'A01');
  assert.ok(menu.data.products.length > 0);
  step('菜单页加载分类与在售商品（当前分类 ' + menu.data.products.length + ' 个）');

  menu.onProductAdd({ detail: { productId: 'prd_beef_rice' } });
  menu.onProductAdd({ detail: { productId: 'prd_beef_rice' } });
  menu.onProductAdd({ detail: { productId: 'prd_tea' } });
  await waitFor(() => menu.data.cartSummary.totalQuantity === 3, '购物车数量');
  assert.equal(menu.data.cartSummary.totalCents, 6600);
  assert.equal(menu.data.quantityMap.prd_beef_rice, 2);
  step('菜单加购合并同商品：3 件 / 6600 分');

  menu.onOpenDetail({ detail: { productId: 'prd_tea' } });
  assert.equal(menu.data.detailVisible, true);
  assert.equal(menu.data.detailQuantity, 1);
  menu.onDetailAdd({ detail: { productId: 'prd_tea' } });
  assert.equal(menu.data.cartSummary.totalQuantity, 4);
  menu.onDetailRemove({ detail: { productId: 'prd_tea' } });
  assert.equal(menu.data.cartSummary.totalQuantity, 3);
  menu.onDetailClose();
  step('商品详情弹层与数量联动');

  menu.onExpandCart();
  assert.equal(menu.data.cartVisible, true);
  menu.onPanelClose();
  assert.equal(menu.data.cartVisible, false);
  step('购物车面板展开与收起');

  menu.onCheckout();
  const checkoutNav = lastNavigation();
  assert.equal(checkoutNav.type, 'navigateTo');
  assert.equal(checkoutNav.url.indexOf('/pages/checkout/index'), 0);
  assert.equal(queryOf(checkoutNav.url).mode, 'DINE_IN');
  assert.equal(queryOf(checkoutNav.url).tableId, 'tbl_A01');
  step('菜单结算跳转携带履约方式与桌号');

  const checkout = loadPage('checkout');
  checkout.onLoad({ mode: 'DINE_IN', tableId: 'tbl_A01' });
  await waitFor(() => checkout.data.loading === false && checkout.data.loggedIn, '结算页登录');
  assert.equal(checkout.data.items.length, 2);
  assert.equal(checkout.data.totalText, '¥66.00');
  assert.equal(checkout.data.tableName, 'A01');
  step('结算页展示菜品、桌号与合计');

  checkout.onNoteInput({ detail: { value: '少辣' } });
  assert.equal(checkout.data.note, '少辣');
  assert.equal(checkout.data.noteLength, 2);

  navigation.length = 0;
  checkout.onSubmit();
  await waitFor(() => navigation.some((item) => item.type === 'redirectTo'), '提交订单后跳转详情');
  const detailNav = navigation.filter((item) => item.type === 'redirectTo')[0];
  const orderId = queryOf(detailNav.url).id;
  assert.ok(orderId);
  assert.equal(queryOf(detailNav.url).pay, '1');
  assert.equal(cartStore.summary('store-demo-001').totalQuantity, 0);
  step('提交订单成功，购物车清空并携带 pay=1 跳转详情');

  const detail = loadPage('order-detail');
  detail.onLoad({ id: orderId, pay: '1' });
  detail.onShow();
  await waitFor(() => detail.data.loading === false && detail.data.order, '订单详情加载');
  assert.equal(detail.data.order.status, 'PENDING_PAYMENT');
  assert.equal(detail.data.order.paymentStatus, 'UNPAID');
  assert.equal(detail.data.order.canPay, true);
  assert.equal(detail.data.order.canCancel, true);
  assert.equal(detail.data.showPayHint, true);
  assert.equal(detail.data.order.timeline.length, 1);
  step('订单详情展示待付款、操作按钮与状态历史');

  detail.onPay();
  await waitFor(() => detail.data.order.status === 'PENDING_ACCEPT', '模拟支付后状态');
  assert.equal(detail.data.order.paymentStatus, 'DEMO_PAID');
  assert.equal(detail.data.order.canPay, false);
  assert.equal(detail.data.order.canCancel, false);
  step('详情页演示模拟支付成功：PENDING_ACCEPT / DEMO_PAID');
  assert.equal(detail.data.payResult.state, 'success');
  assert.equal(detail.data.payResult.shortId, detail.data.order.shortId);
  assert.equal(detail.data.payResult.totalText, detail.data.order.totalText);
  step('支付结果页 success，取餐号等于订单 shortId');

  const mine = loadPage('mine');
  mine.onShow();
  await waitFor(() => mine.data.loading === false && mine.data.identity, '我的页加载身份');
  assert.equal(mine.data.identity.key, 'customer');
  assert.equal(mine.data.merchantEntries.length, 0);
  step('我的页显示演示顾客且无门店入口');

  await mine.onSwitchIdentity({ currentTarget: { dataset: { key: 'owner' } } });
  assert.equal(mine.data.identity.key, 'owner');
  assert.equal(mine.data.merchantEntries.length > 0, true);
  assert.equal(mine.data.merchantEntries[0].role, 'OWNER');
  step('我的页切换演示店主，memberships 出现 OWNER 入口');

  const merchant = loadPage('merchant-orders');
  merchant.onLoad({ storeId: 'store-demo-001' });
  await waitFor(() => merchant.data.checking === false && merchant.data.allowed, '店主订单台鉴权');
  await waitFor(() => merchant.data.orders.length > 0, '店主订单台拉取订单');
  const pendingOrder = merchant.data.orders.filter((item) => item.id === orderId)[0];
  assert.ok(pendingOrder, '订单台应包含刚支付的订单');
  assert.equal(pendingOrder.status, 'PENDING_ACCEPT');
  assert.equal(pendingOrder.unpaid, false);
  assert.equal(pendingOrder.actions.length, 2);
  assert.ok(merchant.timer, '订单台应启动 10 秒轮询');
  step('店主订单台鉴权通过、显示待接单并启动轮询');

  await merchant.onAdvance({ detail: { orderId, toStatus: 'PREPARING' } });
  await waitFor(() => isOrderGone(merchant, orderId), '接单后移出待处理');
  step('店主接单：PENDING_ACCEPT → PREPARING，订单移出待处理');

  merchant.onChangeSegment({ currentTarget: { dataset: { key: 'working' } } });
  await waitFor(() => merchant.data.orders.some((item) => item.id === orderId), '进行中分段');
  assert.equal(merchant.data.orders.filter((item) => item.id === orderId)[0].status, 'PREPARING');
  merchant.onAdvance({ detail: { orderId, toStatus: 'READY' } });
  await waitFor(
    () => (merchant.data.orders.filter((item) => item.id === orderId)[0] || {}).status === 'READY',
    '制作完成',
  );
  merchant.onAdvance({ detail: { orderId, toStatus: 'COMPLETED' } });
  await waitFor(
    () => isOrderGone(merchant, orderId),
    '完成订单移出进行中',
  );
  step('店主推进 PREPARING → READY → COMPLETED，订单移出工作台');

  merchant.onChangeTab({ currentTarget: { dataset: { tab: 'products' } } });
  await waitFor(() => merchant.data.productsLoading === false && merchant.data.categories.length > 0, '商品管理');
  assert.equal(merchant.data.productCount, 6);
  assert.equal(merchant.data.availableCount, 5);
  assert.equal(merchant.timer, null, '切到商品管理后应停止轮询');
  step('商品管理加载 6 个商品（含 1 个下架）并停止轮询');

  merchant.onToggleProduct({
    currentTarget: { dataset: { id: 'prd_seasonal', name: '季节限定甜品' } },
    detail: { value: true },
  });
  await waitFor(() => merchant.data.availableCount === 6, '上架季节限定甜品');
  merchant.onToggleProduct({
    currentTarget: { dataset: { id: 'prd_seasonal', name: '季节限定甜品' } },
    detail: { value: false },
  });
  await waitFor(() => merchant.data.availableCount === 5, '恢复下架');
  step('商品上下架切换并回读最新状态');

  merchant.onUnload();
  assert.equal(merchant.timer, null);
  step('离开店主订单台停止轮询');

  await auth.switchIdentity('customer');
  const orders = loadPage('orders');
  orders.onShow();
  await waitFor(() => orders.data.loading === false && orders.data.orders.length > 0, '顾客订单列表');
  assert.equal(orders.data.filter, 'active');
  orders.onChangeFilter({ currentTarget: { dataset: { key: 'history' } } });
  await waitFor(() => orders.data.orders.some((item) => item.id === orderId), '历史订单出现');
  const finished = orders.data.orders.filter((item) => item.id === orderId)[0];
  assert.equal(finished.status, 'COMPLETED');
  assert.equal(finished.statusText, '已完成');
  step('顾客订单页「已完成」过滤包含该订单');

  console.log('\n页面级冒烟通过：' + steps.length + ' 项检查');
  console.log('本次真实写入订单 ' + orderId + '（COMPLETED）。\n');
  process.exit(0);
}

function isOrderGone(merchant, orderId) {
  return !merchant.data.orders.some((item) => item.id === orderId);
}

main().catch((error) => {
  console.error('\n页面级冒烟失败：' + (error && error.message ? error.message : error));
  if (error && error.stack) {
    console.error(error.stack.split('\n').slice(0, 6).join('\n'));
  }
  process.exit(1);
});