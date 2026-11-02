const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const orderView = require(path.join(root, 'miniprogram/domain/orderView.js'));

function freshAuthModules() {
  ['services/request.js', 'services/auth.js', 'services/session.js', 'services/platform.js'].forEach((relativePath) => {
    const file = path.join(root, 'miniprogram', relativePath);
    delete require.cache[require.resolve(file)];
  });
  const platform = require(path.join(root, 'miniprogram/services/platform.js'));
  const session = require(path.join(root, 'miniprogram/services/session.js'));
  const auth = require(path.join(root, 'miniprogram/services/auth.js'));
  platform.memoryStorage.clear();
  session.clear();
  return { platform, session, auth };
}

function loginResponse(call, identity) {
  call.callback({
    statusCode: 200,
    data: {
      token: identity + '-token',
      expiresIn: 604800,
      user: { id: identity, displayName: identity, memberships: [] },
    },
    header: {},
  });
}

function loadMerchantPage() {
  const file = path.join(root, 'miniprogram/pages/merchant-orders/index.js');
  const previousPage = global.Page;
  let definition = null;
  global.Page = (value) => {
    definition = value;
  };
  delete require.cache[require.resolve(file)];
  require(file);
  global.Page = previousPage;
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch || {});
  };
  return page;
}

function rawOrder(orderId, status, createdAt) {
  return {
    id: orderId,
    storeId: 'store-demo-001',
    status,
    paymentStatus: status === 'PENDING_PAYMENT' ? 'UNPAID' : 'DEMO_PAID',
    items: [],
    totalCents: 1000,
    createdAt: createdAt || '2026-10-31T04:00:00.000Z',
    updatedAt: createdAt || '2026-10-31T04:00:00.000Z',
  };
}

function orderPayload(orderId, status, options) {
  const input = options || {};
  const items = input.items || [rawOrder(orderId, status)];
  return {
    items,
    page: input.page || 1,
    pageSize: input.pageSize || 20,
    total: input.total === undefined ? items.length : input.total,
  };
}

function merchantOrder(orderId, status) {
  return orderView.toMerchantOrderView(orderView.toOrderView(rawOrder(orderId, status)));
}

test('身份切换后，旧登录请求不能覆盖新会话', async () => {
  const { platform, session, auth } = freshAuthModules();
  const calls = [];
  platform.sendRequest = (options, callback) => calls.push({ options, callback });

  const customerLogin = auth.ensureLogin('customer');
  const ownerLogin = auth.switchIdentity('owner');
  assert.equal(calls.length, 2);
  loginResponse(calls[1], 'owner');
  await ownerLogin;
  loginResponse(calls[0], 'customer');
  await assert.rejects(customerLogin, (error) => error.code === 'SESSION_SUPERSEDED');

  assert.equal(session.getIdentity(), 'owner');
  assert.equal(session.getUser().id, 'owner');
  assert.equal(session.getToken(), 'owner-token');
});

test('退出登录后，尚未完成的登录不能恢复会话', async () => {
  const { platform, session, auth } = freshAuthModules();
  const calls = [];
  platform.sendRequest = (options, callback) => calls.push({ options, callback });

  const pending = auth.ensureLogin('customer');
  auth.logout();
  loginResponse(calls[0], 'customer');
  await assert.rejects(pending, (error) => error.code === 'SESSION_SUPERSEDED');

  assert.equal(session.isLoggedIn(), false);
  assert.equal(session.getUser(), null);
  assert.equal(session.getToken(), '');
});

test('生产登录配置只发送微信 code，不发送 demoOpenId', async () => {
  const configFile = path.join(root, 'miniprogram/config/env.js');
  const config = require(configFile);
  const original = config.USE_WECHAT_CODE_LOGIN;
  config.USE_WECHAT_CODE_LOGIN = true;
  try {
    const { platform, auth } = freshAuthModules();
    const calls = [];
    platform.loginWithWechatCode = async () => 'wechat-login-code';
    platform.sendRequest = (options, callback) => calls.push({ options, callback });
    const pending = auth.login({ identity: 'customer' });
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.data, { code: 'wechat-login-code' });
    assert.equal('demoOpenId' in calls[0].options.data, false);
    loginResponse(calls[0], 'wechat-user');
    await pending;
  } finally {
    config.USE_WECHAT_CODE_LOGIN = original;
  }
});

test('店主页初始化期间离开，不得补发订单请求或重启轮询', async () => {
  const auth = require(path.join(root, 'miniprogram/services/auth.js'));
  const session = require(path.join(root, 'miniprogram/services/session.js'));
  const originalEnsureLogin = auth.ensureLogin;
  const originalMemberships = session.memberships;
  let resolveLogin;
  let orderLoads = 0;
  auth.ensureLogin = () => new Promise((resolve) => {
    resolveLogin = resolve;
  });
  session.memberships = () => [{ storeId: 'store-demo-001', role: 'OWNER' }];

  const page = loadMerchantPage();
  page.loadStoreName = async () => {};
  page.loadOrders = async () => {
    orderLoads += 1;
  };

  try {
    page.onLoad({ storeId: 'store-demo-001' });
    page.onHide();
    resolveLogin({ id: 'owner' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.data.allowed, true);
    assert.equal(orderLoads, 0);
    assert.equal(page.timer, null);
    assert.equal(page.ordersRequestSerial, 1);
  } finally {
    page.stopPolling();
    auth.ensureLogin = originalEnsureLogin;
    session.memberships = originalMemberships;
  }
});

test('店主分段切换后，旧响应不得覆盖新分段订单', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListOrders = merchantService.listOrders;
  const resolvers = {};
  merchantService.listOrders = (storeId, query) => new Promise((resolve) => {
    resolvers[query.status] = resolve;
  });

  const page = loadMerchantPage();
  page.pageActive = true;
  page.ordersRequestSerial = 0;
  page.ordersInFlight = {};
  page.setData({ allowed: true, storeId: 'store-demo-001', segment: 'pending' });

  try {
    const pendingRequest = page.loadOrders(true);
    const preparingRequest = page.onChangeSegment({
      currentTarget: { dataset: { key: 'preparing' } },
    });
    resolvers.PREPARING(orderPayload('ord_preparing', 'PREPARING'));
    await preparingRequest;
    resolvers.PENDING_ACCEPT(orderPayload('ord_pending', 'PENDING_ACCEPT'));
    await pendingRequest;

    assert.deepEqual(page.data.orders.map((order) => order.id), ['ord_preparing']);
    assert.equal(page.data.segment, 'preparing');
    assert.equal(page.data.emptyText, '暂时没有制作中的订单');
    assert.deepEqual(page.ordersInFlight, {});
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});

test('店主四队列不包含待付款订单并显示各自空态', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListOrders = merchantService.listOrders;
  const calls = [];
  merchantService.listOrders = async (storeId, query) => {
    calls.push(query);
    return orderPayload(null, 'PENDING_ACCEPT', { items: [], total: 0 });
  };
  const page = loadMerchantPage();
  page.ordersRequestSerial = 0;
  page.ordersInFlight = {};
  page.setData({ allowed: true, storeId: 'store-demo-001' });

  try {
    await page.loadOrders(true);
    const segments = [
      ['preparing', 'PREPARING', '暂时没有制作中的订单'],
      ['ready', 'READY', '暂时没有待取餐订单'],
      ['history', 'COMPLETED,CANCELLED', '暂时没有历史订单'],
    ];
    for (const [key, status, emptyText] of segments) {
      await page.onChangeSegment({ currentTarget: { dataset: { key } } });
      assert.equal(page.data.segment, key);
      assert.equal(page.data.emptyText, emptyText);
      assert.equal(calls.at(-1).status, status);
    }
    assert.deepEqual(page.data.segments.map((item) => item.key), ['pending', 'preparing', 'ready', 'history']);
    assert.equal(calls[0].status, 'PENDING_ACCEPT');
    assert.equal(calls.some((query) => query.status.includes('PENDING_PAYMENT')), false);
    assert.equal(calls.every((query) => query.order === 'desc' && query.pageSize === 20), true);
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});

test('55 单时订单首页按 desc 请求 20 条并显示最新订单', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListOrders = merchantService.listOrders;
  const source = Array.from({ length: 55 }, (unused, index) => {
    const number = index + 1;
    return rawOrder(
      'ord_' + String(number).padStart(3, '0'),
      'PENDING_ACCEPT',
      new Date(Date.UTC(2026, 9, 31, 4, 0, index)).toISOString(),
    );
  });
  source.push(rawOrder('ord_unpaid', 'PENDING_PAYMENT', '2026-10-31T05:00:00.000Z'));
  const calls = [];
  merchantService.listOrders = async (storeId, query) => {
    calls.push(query);
    const statuses = query.status.split(',');
    const direction = query.order === 'desc' ? -1 : 1;
    const filtered = source.filter((order) => statuses.includes(order.status)).sort((left, right) => {
      const created = left.createdAt.localeCompare(right.createdAt);
      return (created || left.id.localeCompare(right.id)) * direction;
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
    };
  };
  const page = loadMerchantPage();
  page.ordersRequestSerial = 0;
  page.ordersInFlight = {};
  page.setData({ allowed: true, storeId: 'store-demo-001', segment: 'pending' });

  try {
    await page.loadOrders(true);
    assert.deepEqual(calls[0], {
      status: 'PENDING_ACCEPT',
      page: 1,
      pageSize: 20,
      order: 'desc',
    });
    assert.deepEqual(
      page.data.orders.map((order) => order.id),
      Array.from({ length: 20 }, (unused, index) => 'ord_' + String(55 - index).padStart(3, '0')),
    );
    assert.equal(page.data.total, 55);
    assert.equal(page.data.page, 1);
    assert.equal(page.data.hasMore, true);
    assert.equal(page.data.orders.some((order) => order.status === 'PENDING_PAYMENT'), false);
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});

test('订单加载更多按 id 去重并更新 total 与 hasMore', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListOrders = merchantService.listOrders;
  const calls = [];
  merchantService.listOrders = async (storeId, query) => {
    calls.push(query);
    if (query.page === 1) {
      return orderPayload('ord_1', 'PENDING_ACCEPT', { page: 1, total: 3 });
    }
    return orderPayload(null, 'PENDING_ACCEPT', {
      items: [
        rawOrder('ord_1', 'PENDING_ACCEPT'),
        rawOrder('ord_2', 'PENDING_ACCEPT'),
        rawOrder('ord_3', 'PENDING_ACCEPT'),
      ],
      page: 2,
      total: 3,
    });
  };
  const page = loadMerchantPage();
  page.ordersRequestSerial = 0;
  page.ordersInFlight = {};
  page.setData({ allowed: true, storeId: 'store-demo-001' });

  try {
    await page.loadOrders(true);
    assert.equal(page.data.hasMore, true);
    await page.onLoadMore();
    assert.deepEqual(page.data.orders.map((order) => order.id), ['ord_1', 'ord_2', 'ord_3']);
    assert.equal(page.data.total, 3);
    assert.equal(page.data.page, 2);
    assert.equal(page.data.hasMore, false);
    assert.deepEqual(calls.map((query) => [query.page, query.pageSize, query.order]), [
      [1, 20, 'desc'],
      [2, 20, 'desc'],
    ]);
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});

test('同门店同分段慢请求未结束时轮询与刷新只发一次', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListOrders = merchantService.listOrders;
  let resolveOrders;
  let calls = 0;
  merchantService.listOrders = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveOrders = resolve;
    });
  };
  const page = loadMerchantPage();
  page.ordersRequestSerial = 0;
  page.ordersInFlight = {};
  page.setData({ allowed: true, storeId: 'store-demo-001', segment: 'pending' });

  try {
    const first = page.loadOrders(true);
    await page.loadOrders(false);
    assert.equal(calls, 1);
    assert.equal(page.ordersRequestSerial, 1);
    resolveOrders(orderPayload('ord_slow', 'PENDING_ACCEPT'));
    await first;
    assert.deepEqual(page.data.orders.map((order) => order.id), ['ord_slow']);
    assert.deepEqual(page.ordersInFlight, {});
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});

test('PENDING_ACCEPT 接单必须经 modal 确认', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const platform = require(path.join(root, 'miniprogram/services/platform.js'));
  const originalUpdate = merchantService.updateOrderStatus;
  const originalModal = platform.modal;
  const originalToast = platform.toast;
  const calls = [];
  const modals = [];
  merchantService.updateOrderStatus = async (orderId, payload) => {
    calls.push({ orderId, payload });
    return {};
  };
  platform.toast = () => {};
  const page = loadMerchantPage();
  page.setData({ orders: [merchantOrder('ord_accept', 'PENDING_ACCEPT')], orderActingIds: {} });
  page.loadOrders = async () => {};
  const event = { detail: { orderId: 'ord_accept', toStatus: 'PREPARING' } };

  try {
    platform.modal = async (options) => {
      modals.push(options);
      return { confirm: false };
    };
    await page.onAdvance(event);
    assert.equal(calls.length, 0);
    assert.deepEqual(page.data.orderActingIds, {});

    platform.modal = async (options) => {
      modals.push(options);
      return { confirm: true };
    };
    await page.onAdvance(event);
    assert.deepEqual(calls, [
      {
        orderId: 'ord_accept',
        payload: { toStatus: 'PREPARING', expectedStatus: 'PENDING_ACCEPT', reason: '' },
      },
    ]);
    assert.deepEqual(modals.map((item) => item.title), ['确认接单', '确认接单']);
    assert.deepEqual(page.data.orderActingIds, {});
    assert.equal(page.data.actingId, '');
  } finally {
    merchantService.updateOrderStatus = originalUpdate;
    platform.modal = originalModal;
    platform.toast = originalToast;
  }
});

test('取消订单选择原因后仍需 modal 确认', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const platform = require(path.join(root, 'miniprogram/services/platform.js'));
  const originalUpdate = merchantService.updateOrderStatus;
  const originalModal = platform.modal;
  const originalToast = platform.toast;
  const previousWx = global.wx;
  const calls = [];
  const modals = [];
  let actionSheets = 0;
  merchantService.updateOrderStatus = async (orderId, payload) => {
    calls.push({ orderId, payload });
    return {};
  };
  platform.toast = () => {};
  global.wx = {
    showActionSheet(options) {
      actionSheets += 1;
      options.success({ tapIndex: 1 });
    },
  };
  const page = loadMerchantPage();
  page.setData({ orders: [merchantOrder('ord_cancel', 'PENDING_ACCEPT')], orderActingIds: {} });
  page.loadOrders = async () => {};
  const event = { detail: { orderId: 'ord_cancel', toStatus: 'CANCELLED' } };

  try {
    platform.modal = async (options) => {
      modals.push(options);
      return { confirm: false };
    };
    await page.onAdvance(event);
    assert.equal(actionSheets, 1);
    assert.equal(calls.length, 0);
    assert.deepEqual(page.data.orderActingIds, {});

    platform.modal = async (options) => {
      modals.push(options);
      return { confirm: true };
    };
    await page.onAdvance(event);
    assert.equal(actionSheets, 2);
    assert.deepEqual(calls, [
      {
        orderId: 'ord_cancel',
        payload: { toStatus: 'CANCELLED', expectedStatus: 'PENDING_ACCEPT', reason: '顾客要求取消' },
      },
    ]);
    assert.equal(modals.every((item) => item.title === '确认取消订单'), true);
    assert.equal(modals.every((item) => item.content.includes('顾客要求取消')), true);
  } finally {
    merchantService.updateOrderStatus = originalUpdate;
    platform.modal = originalModal;
    platform.toast = originalToast;
    if (previousWx === undefined) {
      delete global.wx;
    } else {
      global.wx = previousWx;
    }
  }
});

test('订单操作按卡片独立 loading 且其他卡仍可操作', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const platform = require(path.join(root, 'miniprogram/services/platform.js'));
  const originalUpdate = merchantService.updateOrderStatus;
  const originalModal = platform.modal;
  const originalToast = platform.toast;
  const calls = [];
  const resolvers = {};
  merchantService.updateOrderStatus = (orderId, payload) => {
    calls.push({ orderId, payload });
    return new Promise((resolve) => {
      resolvers[orderId] = resolve;
    });
  };
  platform.modal = async () => ({ confirm: true });
  platform.toast = () => {};
  const page = loadMerchantPage();
  page.setData({
    orders: [
      merchantOrder('ord_1', 'PENDING_ACCEPT'),
      merchantOrder('ord_2', 'PENDING_ACCEPT'),
    ],
    orderActingIds: {},
  });
  page.loadOrders = async () => {};

  try {
    const first = page.onAdvance({ detail: { orderId: 'ord_1', toStatus: 'PREPARING' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(page.data.orderActingIds, { ord_1: 'PREPARING' });
    assert.deepEqual(calls.map((item) => item.orderId), ['ord_1']);

    await page.onAdvance({ detail: { orderId: 'ord_1', toStatus: 'PREPARING' } });
    assert.equal(calls.length, 1);

    const second = page.onAdvance({ detail: { orderId: 'ord_2', toStatus: 'PREPARING' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((item) => item.orderId), ['ord_1', 'ord_2']);
    assert.deepEqual(page.data.orderActingIds, { ord_1: 'PREPARING', ord_2: 'PREPARING' });

    resolvers.ord_2({});
    await second;
    assert.deepEqual(page.data.orderActingIds, { ord_1: 'PREPARING' });
    resolvers.ord_1({});
    await first;
    assert.deepEqual(page.data.orderActingIds, {});
  } finally {
    merchantService.updateOrderStatus = originalUpdate;
    platform.modal = originalModal;
    platform.toast = originalToast;
  }
});

test('order-card 在处理中阻止重复 advance 事件', () => {
  const file = path.join(root, 'miniprogram/components/order-card/index.js');
  const previousComponent = global.Component;
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  delete require.cache[require.resolve(file)];
  require(file);
  global.Component = previousComponent;
  const events = [];
  const instance = {
    data: {
      order: { id: 'ord_1' },
      actingId: 'ord_1',
      actingStatus: 'PREPARING',
    },
    triggerEvent(name, detail) {
      events.push({ name, detail });
    },
  };
  instance.orderId = definition.methods.orderId;
  instance.onAdvance = definition.methods.onAdvance;
  const event = {
    stopPropagation() {},
    currentTarget: { dataset: { status: 'PREPARING' } },
  };

  instance.onAdvance(event);
  assert.equal(events.length, 0);
  instance.data.actingId = '';
  instance.onAdvance(event);
  assert.deepEqual(events, [
    { name: 'advance', detail: { orderId: 'ord_1', toStatus: 'PREPARING' } },
  ]);
  assert.equal(definition.properties.actingId.type, String);
  assert.equal(definition.properties.actingStatus.type, String);
});

test('商品运营服务按约定发送分类、商品与改价请求', async () => {
  const requestFile = path.join(root, 'miniprogram/services/request.js');
  const merchantFile = path.join(root, 'miniprogram/services/merchant.js');
  const requestModule = require(requestFile);
  const originalRequest = requestModule.request;
  const calls = [];
  requestModule.request = async (options) => {
    calls.push(options);
    return { id: 'created' };
  };
  delete require.cache[require.resolve(merchantFile)];
  const merchantService = require(merchantFile);

  try {
    await merchantService.createCategory('store A', { name: '饮品', sortOrder: 0 });
    await merchantService.updateCategory('cat/1', { name: '主食', sortOrder: 2 });
    await merchantService.createProduct('store A', {
      categoryId: 'cat/1',
      name: '牛肉饭',
      description: '少辣',
      priceCents: 2800,
      available: false,
      sortOrder: 3,
    });
    await merchantService.updateProductPrice('prd/1', {
      priceCents: 3000,
      expectedUpdatedAt: '2026-11-02T01:00:00.000Z',
    });

    assert.deepEqual(calls, [
      {
        path: '/merchant/stores/store%20A/categories',
        method: 'POST',
        data: { name: '饮品', sortOrder: 0 },
      },
      {
        path: '/merchant/categories/cat%2F1',
        method: 'PATCH',
        data: { name: '主食', sortOrder: 2 },
      },
      {
        path: '/merchant/stores/store%20A/products',
        method: 'POST',
        data: {
          categoryId: 'cat/1',
          name: '牛肉饭',
          priceCents: 2800,
          description: '少辣',
          available: false,
          sortOrder: 3,
        },
      },
      {
        path: '/merchant/products/prd%2F1/price',
        method: 'PATCH',
        data: { priceCents: 3000, expectedUpdatedAt: '2026-11-02T01:00:00.000Z' },
      },
    ]);
  } finally {
    requestModule.request = originalRequest;
    delete require.cache[require.resolve(merchantFile)];
  }
});

test('商品旧响应不得覆盖新目录，映射保留版本与排序字段', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalListProducts = merchantService.listProducts;
  const resolvers = [];
  merchantService.listProducts = () => new Promise((resolve) => {
    resolvers.push(resolve);
  });

  const page = loadMerchantPage();
  page.productsRequestSerial = 0;
  page.setData({ allowed: true, storeId: 'store-demo-001' });

  try {
    const oldRequest = page.loadProducts();
    const newRequest = page.loadProducts();
    resolvers[1]({
      categories: [
        {
          id: 'cat_new',
          name: '新分类',
          sortOrder: 2,
          products: [
            {
              id: 'prd_new',
              name: '新商品',
              description: '新描述',
              priceCents: 1234,
              available: true,
              sortOrder: 4,
              imageUrl: 'https://example.com/new.png',
              updatedAt: '2026-11-02T02:00:00.000Z',
            },
          ],
        },
      ],
    });
    await newRequest;
    resolvers[0]({ categories: [{ id: 'cat_old', name: '旧分类', products: [] }] });
    await oldRequest;

    assert.equal(page.data.categories.length, 1);
    assert.equal(page.data.categories[0].id, 'cat_new');
    assert.equal(page.data.categories[0].sortOrder, 2);
    const product = page.data.categories[0].products[0];
    assert.equal(product.priceCents, 1234);
    assert.equal(product.updatedAt, '2026-11-02T02:00:00.000Z');
    assert.equal(product.sortOrder, 4);
    assert.equal(product.imageUrl, 'https://example.com/new.png');
    assert.equal(product.amountText, '¥12.34');
  } finally {
    merchantService.listProducts = originalListProducts;
  }
});

test('零分类时新建商品表单可先创建分类并保留表单', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalCreateCategory = merchantService.createCategory;
  merchantService.createCategory = async () => ({ id: 'cat_new', name: '首个分类' });

  const page = loadMerchantPage();
  page.setData({
    isOwner: true,
    storeId: 'store-demo-001',
    showProductForm: true,
    productCategoryName: '首个分类',
    categories: [],
  });
  page.loadProducts = async function loadProducts() {
    this.setData({ categories: [{ id: 'cat_new', name: '首个分类', products: [] }] });
  };

  try {
    await page.onCreateProductCategory();
    assert.equal(page.data.showProductForm, true);
    assert.equal(page.data.productCategoryId, 'cat_new');
    assert.equal(page.data.productCategoryIndex, 0);
    assert.equal(page.data.productWriting, false);
  } finally {
    merchantService.createCategory = originalCreateCategory;
  }
});

test('STAFF 不能创建商品，OWNER 重复提交只发送一次请求', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalCreateProduct = merchantService.createProduct;
  const calls = [];
  let resolveCreate;
  let reloads = 0;
  merchantService.createProduct = (storeId, payload) => {
    calls.push({ storeId, payload });
    return new Promise((resolve) => {
      resolveCreate = resolve;
    });
  };

  const page = loadMerchantPage();
  page.setData({
    isOwner: false,
    storeId: 'store-demo-001',
    productName: '新商品',
    productCategoryId: 'cat_1',
    productPrice: '12.30',
    productDescription: ' 商品描述 ',
    productAvailable: false,
  });
  page.loadProducts = async () => {
    reloads += 1;
  };

  try {
    await page.onCreateProduct();
    assert.equal(calls.length, 0);
    page.setData({ isOwner: true });
    const first = page.onCreateProduct();
    await page.onCreateProduct();
    assert.equal(calls.length, 1);
    assert.equal(page.data.productWriting, true);
    resolveCreate({ id: 'prd_new' });
    await first;
    assert.deepEqual(calls[0], {
      storeId: 'store-demo-001',
      payload: {
        categoryId: 'cat_1',
        name: '新商品',
        description: '商品描述',
        priceCents: 1230,
        available: false,
      },
    });
    assert.equal(reloads, 1);
    assert.equal(page.data.productWriting, false);
  } finally {
    merchantService.createProduct = originalCreateProduct;
  }
});

test('改价冲突携带原始版本，只提示并刷新而不自动重试', async () => {
  const merchantService = require(path.join(root, 'miniprogram/services/merchant.js'));
  const originalUpdateProductPrice = merchantService.updateProductPrice;
  const calls = [];
  let reloads = 0;
  merchantService.updateProductPrice = async (productId, payload) => {
    calls.push({ productId, payload });
    throw { code: 'PRODUCT_CONFLICT', message: '商品已更新', requestId: 'req_conflict' };
  };

  const page = loadMerchantPage();
  page.setData({
    isOwner: true,
    storeId: 'store-demo-001',
    priceEditorId: 'prd_1',
    priceValue: '18.80',
    priceOriginalUpdatedAt: '2026-11-02T01:00:00.000Z',
    categories: [
      {
        id: 'cat_1',
        products: [{ id: 'prd_1', updatedAt: '2026-11-02T03:00:00.000Z' }],
      },
    ],
  });
  page.loadProducts = async () => {
    reloads += 1;
  };

  try {
    await page.onSavePrice();
    assert.deepEqual(calls, [
      {
        productId: 'prd_1',
        payload: { priceCents: 1880, expectedUpdatedAt: '2026-11-02T01:00:00.000Z' },
      },
    ]);
    assert.equal(reloads, 1);
    assert.match(page.data.error, /商品价格已被其他操作更新/);
    assert.equal(page.data.requestId, 'req_conflict');
    assert.equal(page.data.priceEditorId, '');
    assert.equal(page.data.productWriting, false);
  } finally {
    merchantService.updateProductPrice = originalUpdateProductPrice;
  }
});

test('商品 tab 重新显示时会刷新目录', () => {
  const page = loadMerchantPage();
  let refreshes = 0;
  page.setData({ allowed: true, tab: 'products' });
  page.loadProducts = () => {
    refreshes += 1;
  };
  page.onShow();
  assert.equal(refreshes, 1);
});