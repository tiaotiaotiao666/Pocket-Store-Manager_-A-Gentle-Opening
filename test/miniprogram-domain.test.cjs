const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../miniprogram/domain/money');
const cart = require('../miniprogram/domain/cart');
const orderStatus = require('../miniprogram/domain/orderStatus');
const scene = require('../miniprogram/domain/scene');
const idempotency = require('../miniprogram/domain/idempotency');
const orderView = require('../miniprogram/domain/orderView');
const errorText = require('../miniprogram/domain/errorText');

test('money: 整数分格式化为两位小数', () => {
  assert.equal(money.formatCents(2800), '¥28.00');
  assert.equal(money.formatCents(5), '¥0.05');
  assert.equal(money.formatCents(0), '¥0.00');
  assert.equal(money.formatAmount(123456), '1234.56');
});

test('money: 非法与负数输入不产生 NaN', () => {
  assert.equal(money.formatCents(undefined), '¥0.00');
  assert.equal(money.formatCents('abc'), '¥0.00');
  assert.equal(money.formatCents(-50), '-¥0.50');
  assert.equal(money.toSafeCents('2800'), 2800);
});

test('cart: 同商品合并、数量累加、总额为整数分', () => {
  const product = { id: 'prd_beef_rice', name: '柑橘牛肉饭', priceCents: 2800, available: true };
  const first = cart.addItem({}, product);
  const second = cart.addItem(first.cart, product);
  const summary = cart.cartSummary(second.cart);
  assert.equal(second.cart.prd_beef_rice.quantity, 2);
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.totalCents, 5600);
  assert.equal(summary.items[0].lineTotalCents, 5600);
});

test('cart: 数量上限 99、停售商品不能加入', () => {
  const product = { id: 'prd_tea', name: '自选鲜泡茶', priceCents: 1000, available: true };
  const full = {};
  full.prd_tea = { productId: 'prd_tea', name: '自选鲜泡茶', unitPriceCents: 1000, quantity: 99 };
  const limited = cart.addItem(full, product);
  assert.equal(limited.added, false);
  assert.equal(limited.limited, true);
  assert.equal(limited.cart.prd_tea.quantity, 99);

  const blocked = cart.addItem({}, { id: 'prd_seasonal', name: '季节限定甜品', priceCents: 1800, available: false });
  assert.equal(blocked.added, false);
  assert.equal(blocked.reason, 'UNAVAILABLE');
  assert.deepEqual(blocked.cart, {});
});

test('cart: 减少到 0 自动移除，setQuantity 限制范围', () => {
  let current = cart.addItem({}, { id: 'prd_tea', name: '茶', priceCents: 1000 }).cart;
  current = cart.decreaseItem(current, 'prd_tea');
  assert.deepEqual(current, {});

  current = cart.addItem({}, { id: 'prd_tea', name: '茶', priceCents: 1000 }).cart;
  current = cart.setQuantity(current, 'prd_tea', 120);
  assert.equal(current.prd_tea.quantity, 99);
  current = cart.setQuantity(current, 'prd_tea', 0);
  assert.deepEqual(current, {});
});

test('cart: 生成下单 items 时只保留 productId 与 quantity', () => {
  const current = cart.addItem({}, { id: 'prd_tea', name: '茶', priceCents: 1000 }).cart;
  const items = cart.toOrderItems(current);
  assert.deepEqual(items, [{ productId: 'prd_tea', quantity: 1 }]);
  assert.equal(Object.keys(items[0]).length, 2);
});

test('cart: 目录变化时剔除停售商品并刷新价格快照', () => {
  let current = cart.addItem({}, { id: 'prd_tea', name: '茶', priceCents: 1000 }).cart;
  current = cart.addItem(current, { id: 'prd_beef_rice', name: '饭', priceCents: 2800 }).cart;
  const merged = cart.mergeCatalogAvailability(current, {
    categories: [
      {
        products: [
          { id: 'prd_tea', name: '自选鲜泡茶', priceCents: 1200, available: true },
          { id: 'prd_beef_rice', name: '柑橘牛肉饭', priceCents: 2800, available: false },
        ],
      },
    ],
  });
  assert.equal(merged.cart.prd_tea.unitPriceCents, 1200);
  assert.equal(merged.cart.prd_beef_rice, undefined);
  assert.equal(merged.removed.length, 1);
});

test('orderStatus: 六态文案、支付文案与可操作性', () => {
  assert.equal(orderStatus.statusText('PREPARING'), '制作中');
  assert.equal(orderStatus.statusText('UNKNOWN'), '状态未知');
  assert.equal(orderStatus.paymentText('DEMO_PAID'), '演示已支付');
  assert.equal(orderStatus.isActiveStatus('READY'), true);
  assert.equal(orderStatus.isActiveStatus('COMPLETED'), false);
  assert.equal(orderStatus.isTerminalStatus('CANCELLED'), true);

  const unpaid = { status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID' };
  assert.equal(orderStatus.canCustomerPay(unpaid), true);
  assert.equal(orderStatus.canCustomerCancel(unpaid), true);
  assert.equal(orderStatus.canCustomerPay({ status: 'PENDING_ACCEPT', paymentStatus: 'DEMO_PAID' }), false);
  assert.deepEqual(orderStatus.merchantActions(unpaid), []);
});

test('orderStatus: 店主可操作按钮严格按状态机映射', () => {
  const accept = orderStatus.merchantActions({ status: 'PENDING_ACCEPT' });
  assert.deepEqual(accept.map((item) => item.toStatus), ['PREPARING', 'CANCELLED']);
  assert.equal(accept[1].requiresReason, true);

  assert.deepEqual(orderStatus.merchantActions({ status: 'PREPARING' }).map((item) => item.toStatus), ['READY', 'CANCELLED']);
  assert.deepEqual(orderStatus.merchantActions({ status: 'READY' }).map((item) => item.toStatus), ['COMPLETED', 'CANCELLED']);
  assert.deepEqual(orderStatus.merchantActions({ status: 'COMPLETED' }), []);
  assert.deepEqual(orderStatus.merchantActions({ status: 'CANCELLED' }), []);
});

test('orderStatus: 进度步骤以当前状态为 current', () => {
  const steps = orderStatus.buildProgressSteps('PREPARING');
  assert.deepEqual(steps.map((step) => step.state), ['done', 'done', 'current', 'pending', 'pending']);
  const cancelled = orderStatus.buildProgressSteps('CANCELLED');
  assert.deepEqual(cancelled.map((step) => step.state), ['pending', 'pending', 'pending', 'pending', 'pending']);
});

test('scene: 解析 URL 编码的 query scene', () => {
  const parsed = scene.parseScene('storeId%3Dstore-demo-001%26tableId%3Dtbl_A01');
  assert.equal(parsed.storeId, 'store-demo-001');
  assert.equal(parsed.tableId, 'tbl_A01');
});

test('scene: 解析纯 storeId、原始 query 与别名键', () => {
  assert.deepEqual(scene.parseScene('store-demo-001'), { storeId: 'store-demo-001', tableId: '', raw: 'store-demo-001' });
  const parsed = scene.parseScene('s=store-demo-001&t=tbl_A02');
  assert.equal(parsed.storeId, 'store-demo-001');
  assert.equal(parsed.tableId, 'tbl_A02');
  assert.equal(scene.parseScene('').storeId, '');
});

test('scene: 入口参数优先级为显式 query > scene > 默认门店', () => {
  const entry = scene.resolveEntry(
    { scene: 'storeId%3Dstore-from-scene%26tableId%3Dtbl_A01', storeId: 'store-demo-001' },
    'store-fallback',
  );
  assert.equal(entry.storeId, 'store-demo-001');
  assert.equal(entry.tableId, 'tbl_A01');
  assert.equal(entry.fromScene, true);

  const fallback = scene.resolveEntry({}, 'store-demo-001');
  assert.equal(fallback.storeId, 'store-demo-001');
  assert.equal(fallback.tableId, '');
  assert.equal(fallback.fromScene, false);
});

test('scene: 非法编码不抛异常', () => {
  assert.doesNotThrow(() => scene.parseScene('%E0%A4%A'));
  const parsed = scene.parseScene('%E0%A4%A');
  assert.equal(typeof parsed.storeId, 'string');
});

test('idempotency: 生成的 Key 满足可见 ASCII 与长度要求', () => {
  const key = idempotency.createIdempotencyKey(1760000000000, () => 0.123456);
  assert.equal(idempotency.isValidKey(key), true);
  assert.ok(key.length >= 8 && key.length <= 128);
  assert.match(key, /^idem_/);
  assert.notEqual(idempotency.createIdempotencyKey(1760000000000, () => 0.9), key);
});

test('idempotency: 非法 Key 被拒绝', () => {
  assert.equal(idempotency.isValidKey('short'), false);
  assert.equal(idempotency.isValidKey(''), false);
  assert.equal(idempotency.isValidKey('a'.repeat(129)), false);
  assert.equal(idempotency.isValidKey('含中文的键'), false);
  assert.equal(idempotency.isValidKey('a b c d e'), false);
});

test('orderView: 时间按 Asia/Shanghai 展示', () => {
  assert.equal(orderView.formatDateTime('2026-10-29T04:30:00.000Z'), '10-29 12:30');
  assert.equal(orderView.formatFullDateTime('2026-10-29T16:30:00.000Z'), '2026-10-30 00:30');
  assert.equal(orderView.formatTime('2026-10-29T04:30:00.000Z'), '12:30');
  assert.equal(orderView.formatDateTime('not-a-date'), '');
  assert.equal(orderView.formatRelative('2026-10-31T04:00:00.000Z', '2026-10-31T04:10:00.000Z'), '10 分钟前');
});

test('orderView: 订单展示模型包含金额、履约、操作与时间线', () => {
  const order = {
    id: 'ord_001',
    storeId: 'store-demo-001',
    storeName: '柑橘小馆',
    tableId: 'tbl_A01',
    tableName: 'A01',
    fulfillmentType: 'DINE_IN',
    status: 'PENDING_PAYMENT',
    paymentStatus: 'UNPAID',
    items: [{ productId: 'prd_beef_rice', name: '柑橘牛肉饭', unitPriceCents: 2800, quantity: 2, lineTotalCents: 5600 }],
    totalCents: 5600,
    note: '少辣',
    createdAt: '2026-10-31T04:00:00.000Z',
    updatedAt: '2026-10-31T04:00:00.000Z',
    statusHistory: [
      { id: 'log_1', fromStatus: null, toStatus: 'PENDING_PAYMENT', actorType: 'CUSTOMER', reason: null, createdAt: '2026-10-31T04:00:00.000Z' },
    ],
  };

  const view = orderView.toOrderView(order, '2026-10-31T05:00:00.000Z');
  assert.equal(view.totalText, '¥56.00');
  assert.equal(view.fulfillmentText, '堂食 · A01 桌');
  assert.equal(view.statusText, '待付款');
  assert.equal(view.paymentText, '未支付');
  assert.equal(view.canPay, true);
  assert.equal(view.canCancel, true);
  assert.equal(view.itemViews[0].lineTotalText, '¥56.00');
  assert.equal(view.itemSummary, '柑橘牛肉饭 ×2');
  assert.equal(view.timeline[0].title, '待付款');
  assert.equal(view.timeline[0].actorText, '顾客');
  assert.equal(view.timeline[0].timeText, '2026-10-31 12:00');
  assert.equal(view.progressSteps.length, 5);
});

test('orderView: 自取订单不显示桌号，非法订单返回 null', () => {
  const view = orderView.toOrderView({
    id: 'ord_002',
    fulfillmentType: 'TAKEAWAY',
    tableName: null,
    status: 'PENDING_ACCEPT',
    paymentStatus: 'DEMO_PAID',
    items: [],
    totalCents: 0,
    createdAt: '2026-10-31T04:00:00.000Z',
  });
  assert.equal(view.fulfillmentText, '到店自取');
  assert.equal(view.canPay, false);
  assert.equal(orderView.toOrderView(null), null);
  assert.equal(orderView.toOrderView({}), null);
});

test('orderView: 店主订单模型附带操作按钮与未支付标记', () => {
  const view = orderView.toMerchantOrderView({
    id: 'ord_003',
    storeId: 'store-demo-001',
    status: 'PENDING_ACCEPT',
    paymentStatus: 'DEMO_PAID',
    items: [],
    totalCents: 1000,
    createdAt: '2026-10-31T04:00:00.000Z',
  });
  assert.deepEqual(view.actions.map((item) => item.toStatus), ['PREPARING', 'CANCELLED']);
  assert.equal(view.unpaid, false);
  assert.equal(view.waitText.indexOf('下单'), 0);
});

test('errorText: 错误码映射为可展示文案与建议动作', () => {
  const described = errorText.describeError({ code: 'PRODUCT_UNAVAILABLE', message: '商品已停售' });
  assert.equal(described.message, '有商品已停售，请刷新菜单后重新选择');
  assert.equal(described.action, '刷新菜单');
  assert.equal(described.code, 'PRODUCT_UNAVAILABLE');

  const network = errorText.describeError(new Error('boom'));
  assert.equal(network.code, 'NETWORK_ERROR');
  assert.equal(errorText.isAuthError('AUTH_INVALID'), true);
  assert.equal(errorText.isAuthError('FORBIDDEN'), false);
  assert.equal(errorText.isCatalogError('PRODUCT_NOT_FOUND'), true);
  assert.equal(errorText.normalizeError({ code: 'X', message: '', requestId: 'req_1' }).requestId, 'req_1');
});