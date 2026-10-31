const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

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

function orderPayload(orderId, status) {
  return {
    items: [
      {
        id: orderId,
        storeId: 'store-demo-001',
        status,
        paymentStatus: status === 'PENDING_PAYMENT' ? 'UNPAID' : 'DEMO_PAID',
        items: [],
        totalCents: 1000,
        createdAt: '2026-10-31T04:00:00.000Z',
        updatedAt: '2026-10-31T04:00:00.000Z',
      },
    ],
    page: 1,
    pageSize: 50,
    total: 1,
  };
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
  page.setData({ allowed: true, storeId: 'store-demo-001', segment: 'pending' });

  try {
    const pendingRequest = page.loadOrders(true);
    page.setData({ segment: 'working', orders: [] });
    const workingRequest = page.loadOrders(true);
    resolvers['PREPARING,READY'](orderPayload('ord_working', 'PREPARING'));
    await workingRequest;
    resolvers['PENDING_PAYMENT,PENDING_ACCEPT'](orderPayload('ord_pending', 'PENDING_ACCEPT'));
    await pendingRequest;

    assert.deepEqual(page.data.orders.map((order) => order.id), ['ord_working']);
    assert.equal(page.data.segment, 'working');
  } finally {
    merchantService.listOrders = originalListOrders;
  }
});