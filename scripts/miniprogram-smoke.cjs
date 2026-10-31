#!/usr/bin/env node
/**
 * B2 小程序服务层端到端冒烟。
 *
 * 复用 miniprogram/services 与 miniprogram/domain 的真实代码，
 * 在 Node 下用 fetch + 内存存储替换 wx.request / wx.storage，
 * 按「顾客下单 → 模拟支付 → 店主接单 → 制作 → 可取 → 完成」顺序验证后端契约。
 *
 * 用法：
 *   node scripts/miniprogram-smoke.cjs
 *   MINIPROGRAM_API_BASE_URL=http://127.0.0.1:3000/api/v1 node scripts/miniprogram-smoke.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.MINIPROGRAM_API_BASE_URL =
  process.env.MINIPROGRAM_API_BASE_URL || 'http://127.0.0.1:3000/api/v1';

const root = path.resolve(__dirname, '..');
const platform = require(path.join(root, 'miniprogram/services/platform'));
const session = require(path.join(root, 'miniprogram/services/session'));
const auth = require(path.join(root, 'miniprogram/services/auth'));
const storeService = require(path.join(root, 'miniprogram/services/store'));
const orderService = require(path.join(root, 'miniprogram/services/order'));
const merchantService = require(path.join(root, 'miniprogram/services/merchant'));
const cartStore = require(path.join(root, 'miniprogram/state/cart-store'));
const visitStore = require(path.join(root, 'miniprogram/state/visit-store'));
const cartDomain = require(path.join(root, 'miniprogram/domain/cart'));
const idempotency = require(path.join(root, 'miniprogram/domain/idempotency'));
const orderView = require(path.join(root, 'miniprogram/domain/orderView'));
const errorText = require(path.join(root, 'miniprogram/domain/errorText'));

const STORE_ID = process.env.MINIPROGRAM_STORE_ID || 'store-demo-001';
const TABLE_ID = 'tbl_A01';
const steps = [];

function step(name) {
  steps.push(name);
  console.log('  ✓ ' + name);
}

async function expectApiError(promise, expectedCode) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, expectedCode, '期望 ' + expectedCode + '，实际 ' + error.code + ': ' + error.message);
    return error;
  }
  throw new Error('期望抛出 ' + expectedCode + '，但请求成功了');
}

async function main() {
  console.log('\nB2 小程序服务层冒烟\n');

  platform.memoryStorage.clear();
  assert.equal(await storeService.getStore(STORE_ID).then((result) => result.id), STORE_ID);
  const store = await storeService.getStore(STORE_ID);
  assert.equal(store.name, '柑橘小馆');
  assert.equal(store.fulfillment.dineIn, true);
  step('公开门店信息可读（无需登录）');

  const catalog = await storeService.getCatalog(STORE_ID);
  assert.ok(Array.isArray(catalog.categories) && catalog.categories.length >= 1);
  const products = [];
  catalog.categories.forEach((category) => category.products.forEach((product) => products.push(product)));
  assert.ok(products.length >= 4);
  assert.equal(products.some((product) => product.available === false), false);
  step('公开菜单只含在售商品，共 ' + products.length + ' 个');

  const customer = await auth.ensureLogin('customer');
  assert.ok(customer.id);
  assert.ok(session.getToken());
  assert.equal(customer.memberships.length, 0);
  step('演示顾客登录成功：' + customer.displayName);

  const visit = visitStore.applyEntry({ storeId: STORE_ID, tableId: TABLE_ID, fromScene: true });
  visitStore.applyStore(store);
  assert.equal(visit.fulfillmentType, 'DINE_IN');
  assert.equal(visit.tableName, 'A01');
  step('扫码 scene 解析为堂食 A01 桌');

  const rice = products.filter((product) => product.id === 'prd_beef_rice')[0];
  const tea = products.filter((product) => product.id === 'prd_tea')[0];
  assert.ok(rice && tea);
  cartStore.clear(STORE_ID);
  cartStore.add(STORE_ID, rice);
  cartStore.add(STORE_ID, rice);
  const added = cartStore.add(STORE_ID, tea);
  assert.equal(added.added, true);
  const summary = cartStore.summary(STORE_ID);
  assert.equal(summary.totalQuantity, 3);
  assert.equal(summary.totalCents, rice.priceCents * 2 + tea.priceCents);
  step('购物车合并同商品，合计 ' + summary.totalCents + ' 分');

  const key = idempotency.createIdempotencyKey(Date.now(), Math.random);
  const created = await orderService.createOrder(
    {
      storeId: STORE_ID,
      fulfillmentType: 'DINE_IN',
      tableId: TABLE_ID,
      items: cartDomain.toOrderItems(cartStore.load(STORE_ID)),
      note: 'B2 冒烟 · 少辣',
    },
    key,
  );
  assert.equal(created.status, 'PENDING_PAYMENT');
  assert.equal(created.paymentStatus, 'UNPAID');
  assert.equal(created.totalCents, summary.totalCents);
  assert.equal(created.tableName, 'A01');
  assert.equal(created.items.length, 2);
  step('创建订单成功：' + created.id + '，服务端计价 ' + created.totalCents + ' 分');

  const replayed = await orderService.createOrder(
    {
      storeId: STORE_ID,
      fulfillmentType: 'DINE_IN',
      tableId: TABLE_ID,
      items: cartDomain.toOrderItems(cartStore.load(STORE_ID)),
      note: 'B2 冒烟 · 少辣',
    },
    key,
  );
  assert.equal(replayed.id, created.id);
  step('同幂等键重放返回原订单');

  await expectApiError(
    orderService.createOrder(
      {
        storeId: STORE_ID,
        fulfillmentType: 'DINE_IN',
        tableId: TABLE_ID,
        items: [{ productId: rice.id, quantity: 1 }],
        note: '内容不同',
      },
      key,
    ),
    'IDEMPOTENCY_CONFLICT',
  );
  step('同键不同内容被拒绝：IDEMPOTENCY_CONFLICT');

  await expectApiError(
    orderService.createOrder(
      {
        storeId: STORE_ID,
        fulfillmentType: 'DINE_IN',
        tableId: '',
        items: [{ productId: rice.id, quantity: 1 }],
      },
      idempotency.createIdempotencyKey(Date.now(), Math.random),
    ),
    'TABLE_REQUIRED',
  );
  step('堂食缺桌号被拒绝：TABLE_REQUIRED');

  await expectApiError(
    orderService.createOrder(
      {
        storeId: STORE_ID,
        fulfillmentType: 'DINE_IN',
        tableId: 'tbl_not_exist',
        items: [{ productId: rice.id, quantity: 1 }],
      },
      idempotency.createIdempotencyKey(Date.now(), Math.random),
    ),
    'TABLE_NOT_FOUND',
  );
  step('跨店桌号被拒绝：TABLE_NOT_FOUND');

  await expectApiError(
    orderService.createOrder(
      {
        storeId: STORE_ID,
        fulfillmentType: 'TAKEAWAY',
        items: [{ productId: 'prd_seasonal', quantity: 1 }],
      },
      idempotency.createIdempotencyKey(Date.now(), Math.random),
    ),
    'PRODUCT_UNAVAILABLE',
  );
  step('停售商品被拒绝：PRODUCT_UNAVAILABLE');

  const list = await orderService.listOrders({ storeId: STORE_ID, active: true });
  assert.ok(list.items.some((order) => order.id === created.id));
  step('顾客订单列表包含进行中订单，共 ' + list.total + ' 条');

  const paid = await orderService.demoPayment(created.id);
  assert.equal(paid.status, 'PENDING_ACCEPT');
  assert.equal(paid.paymentStatus, 'DEMO_PAID');
  step('演示模拟支付成功：PENDING_ACCEPT / DEMO_PAID');

  const paidAgain = await orderService.demoPayment(created.id);
  assert.equal(paidAgain.status, 'PENDING_ACCEPT');
  step('重复模拟支付幂等返回当前订单');

  const detailBefore = await orderService.getOrder(created.id);
  assert.equal(detailBefore.statusHistory.length, 2);

  const owner = await auth.switchIdentity('owner');
  assert.ok(owner.memberships.some((item) => item.storeId === STORE_ID && item.role === 'OWNER'));
  step('切换到演示店主，memberships 含 OWNER');

  const merchantOrders = await merchantService.listOrders(STORE_ID, {});
  assert.ok(merchantOrders.items.some((order) => order.id === created.id));
  step('店主订单台默认含待接单订单，共 ' + merchantOrders.total + ' 条');

  const preparing = await merchantService.updateOrderStatus(created.id, {
    toStatus: 'PREPARING',
    expectedStatus: 'PENDING_ACCEPT',
  });
  assert.equal(preparing.status, 'PREPARING');
  const ready = await merchantService.updateOrderStatus(created.id, { toStatus: 'READY', expectedStatus: 'PREPARING' });
  assert.equal(ready.status, 'READY');
  const completed = await merchantService.updateOrderStatus(created.id, {
    toStatus: 'COMPLETED',
    expectedStatus: 'READY',
  });
  assert.equal(completed.status, 'COMPLETED');
  step('店主推进 PENDING_ACCEPT → PREPARING → READY → COMPLETED');

  await expectApiError(
    merchantService.updateOrderStatus(created.id, { toStatus: 'PREPARING' }),
    'INVALID_STATUS_TRANSITION',
  );
  step('终态不可再流转：INVALID_STATUS_TRANSITION');

  const merchantProducts = await merchantService.listProducts(STORE_ID);
  const allProducts = [];
  merchantProducts.categories.forEach((category) => category.products.forEach((product) => allProducts.push(product)));
  const seasonal = allProducts.filter((product) => product.id === 'prd_seasonal')[0];
  assert.ok(seasonal);
  assert.equal(seasonal.available, false);
  step('店主商品列表包含下架商品（' + allProducts.length + ' 个）');

  const toggled = await merchantService.updateAvailability('prd_seasonal', true);
  assert.equal(toggled.available, true);
  const catalogAfter = await storeService.getCatalog(STORE_ID);
  const visibleAgain = [];
  catalogAfter.categories.forEach((category) =>
    category.products.forEach((product) => visibleAgain.push(product.id)),
  );
  assert.ok(visibleAgain.indexOf('prd_seasonal') >= 0);
  const restored = await merchantService.updateAvailability('prd_seasonal', false);
  assert.equal(restored.available, false);
  step('商品上下架生效并刷新公开目录');

  const canceledOrder = await orderService.createOrder(
    {
      storeId: STORE_ID,
      fulfillmentType: 'TAKEAWAY',
      items: [{ productId: tea.id, quantity: 1 }],
      note: 'B2 冒烟 · 取消用例',
    },
    idempotency.createIdempotencyKey(Date.now(), Math.random),
  );
  const canceled = await orderService.cancelOrder(canceledOrder.id, '冒烟用例清理');
  assert.equal(canceled.status, 'CANCELLED');
  assert.equal(canceled.paymentStatus, 'UNPAID');
  step('顾客取消待付款订单成功：CANCELLED');

  const customerAgain = await auth.switchIdentity('customer');
  assert.equal(customerAgain.memberships.length, 0);
  const finishDetail = await orderService.getOrder(created.id);
  assert.equal(finishDetail.status, 'COMPLETED');
  assert.equal(finishDetail.statusHistory.length, 5);
  const finishView = orderView.toOrderView(finishDetail);
  assert.equal(finishView.statusText, '已完成');
  assert.equal(finishView.paymentText, '演示已支付');
  assert.equal(finishView.timeline.length, 5);
  step('顾客详情状态历史 5 条，展示模型格式化正确');

  await expectApiError(merchantService.listOrders(STORE_ID, {}), 'FORBIDDEN');
  step('顾客身份访问店主订单台被拒绝：FORBIDDEN');

  const unauthorized = await orderService.getOrder('ord_not_exist').then(
    () => ({ code: '' }),
    (error) => error,
  );
  assert.equal(unauthorized.code, 'ORDER_NOT_FOUND');
  assert.equal(errorText.describeError(unauthorized).message, '订单不存在或无权查看');
  step('无效订单返回 ORDER_NOT_FOUND 并映射中文文案');

  cartStore.clear(STORE_ID);
  console.log('\n冒烟通过：' + steps.length + ' 项检查');
  console.log('顾客订单 ' + created.id + ' 已推进到 COMPLETED，取消用例 ' + canceledOrder.id + ' 为 CANCELLED。\n');
}

main().catch((error) => {
  console.error('\n冒烟失败：' + (error && error.message ? error.message : error));
  if (error && error.requestId) {
    console.error('requestId: ' + error.requestId);
  }
  process.exitCode = 1;
});