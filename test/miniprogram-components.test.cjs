const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function loadComponent(relativePath) {
  let definition = null;
  const previousComponent = global.Component;
  global.Component = (config) => {
    definition = config;
  };
  const file = path.join(root, 'miniprogram/components', relativePath, 'index.js');
  delete require.cache[require.resolve(file)];
  require(file);
  global.Component = previousComponent;
  assert.ok(definition, relativePath + ' 未调用 Component()');

  const events = [];
  const instance = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail) {
      events.push({ name, detail });
    },
  });

  if (definition.properties) {
    Object.keys(definition.properties).forEach((key) => {
      instance.data[key] = definition.properties[key].value;
    });
  }

  Object.keys(definition.methods || {}).forEach((method) => {
    instance[method] = definition.methods[method].bind(instance);
  });

  function runObservers() {
    Object.keys(definition.observers || {}).forEach((key) => {
      const fields = key.split(',').map((field) => field.trim());
      const args = fields.map((field) => instance.data[field]);
      definition.observers[key].apply(instance, args);
    });
  }

  function setProperty(key, value) {
    instance.data[key] = value;
    const observers = definition.observers || {};
    Object.keys(observers).forEach((observerKey) => {
      const fields = observerKey.split(',').map((field) => field.trim());
      if (fields.indexOf(key) >= 0) {
        observers[observerKey].apply(
          instance,
          fields.map((field) => instance.data[field]),
        );
      }
    });
  }

  return { instance, events, runObservers, setProperty };
}

test('product-card 组件：金额格式化、加购与详情事件', () => {
  const { instance, events, setProperty } = loadComponent('product-card');
  setProperty('product', {
    id: 'prd_beef_rice',
    name: '柑橘牛肉饭',
    description: '现炒牛肉',
    priceCents: 2800,
    available: true,
  });
  assert.equal(instance.data.display.amount, '28.00');
  assert.equal(instance.data.display.initial, '柑');

  instance.onAdd({});
  assert.deepEqual(events[0], { name: 'add', detail: { productId: 'prd_beef_rice' } });

  instance.onOpen();
  assert.deepEqual(events[1], { name: 'openDetail', detail: { productId: 'prd_beef_rice' } });

  instance.data.disabled = true;
  instance.onAdd({});
  assert.equal(events.length, 2, '停售商品不应派发 add');
});

test('product-card 组件：缺省数据不抛异常', () => {
  const { instance, events, runObservers } = loadComponent('product-card');
  assert.doesNotThrow(runObservers);
  assert.equal(instance.data.display.amount, '0.00');
  assert.equal(instance.data.display.initial, '菜');
  assert.doesNotThrow(() => instance.onAdd({}));
  assert.equal(events.length, 0);
});

test('cart-bar 组件：金额显示与结算事件', () => {
  const { instance, events, setProperty } = loadComponent('cart-bar');
  setProperty('totalCents', 6600);
  setProperty('totalQuantity', 3);
  assert.equal(instance.data.totalText, '¥66.00');

  instance.onCheckout();
  assert.deepEqual(events[0], { name: 'checkout', detail: { totalCents: 6600, totalQuantity: 3 } });

  instance.onExpand();
  assert.equal(events[1].name, 'expand');

  instance.data.totalQuantity = 0;
  instance.onCheckout();
  assert.equal(events.length, 2, '空购物车不应派发 checkout');
});

test('cart-panel 组件：行金额格式化与事件 detail 只含契约字段', () => {
  const { instance, events, setProperty } = loadComponent('cart-panel');
  setProperty('items', [
    { productId: 'prd_tea', name: '自选鲜泡茶', unitPriceCents: 1000, quantity: 2, lineTotalCents: 2000 },
  ]);
  setProperty('totalCents', 2000);
  assert.equal(instance.data.rows[0].unitPriceText, '¥10.00');
  assert.equal(instance.data.rows[0].lineTotalText, '¥20.00');
  assert.equal(instance.data.totalText, '¥20.00');

  instance.onAdd({ currentTarget: { dataset: { id: 'prd_tea' } } });
  assert.deepEqual(events[0], { name: 'add', detail: { productId: 'prd_tea' } });
  instance.onRemove({ currentTarget: { dataset: { id: 'prd_tea' } } });
  assert.deepEqual(events[1], { name: 'remove', detail: { productId: 'prd_tea' } });
  setProperty('totalQuantity', 2);
  instance.onCheckout();
  assert.deepEqual(events[2], {
    name: 'checkout',
    detail: {
      totalCents: 2000,
      items: [{ productId: 'prd_tea', name: '自选鲜泡茶', unitPriceCents: 1000, quantity: 2, lineTotalCents: 2000 }],
    },
  });
});

test('order-status 组件：六态文案来自领域层', () => {
  const { instance, setProperty } = loadComponent('order-status');
  setProperty('status', 'PREPARING');
  setProperty('paymentStatus', 'DEMO_PAID');
  assert.equal(instance.data.label, '制作中');
  assert.equal(instance.data.tone, 'primary');
  assert.equal(instance.data.paymentLabel, '演示已支付');
  assert.equal(instance.data.hint, '店家正在制作，请稍候');

  setProperty('status', 'UNKNOWN_STATUS');
  assert.equal(instance.data.label, '状态未知');
  assert.equal(instance.data.tone, 'neutral');
});

test('fulfillment-switch 组件：变更事件与禁用选项', () => {
  const { instance, events, setProperty } = loadComponent('fulfillment-switch');
  instance.onSelect({ currentTarget: { dataset: { value: 'DINE_IN' } } });
  assert.deepEqual(events[0], { name: 'change', detail: { value: 'DINE_IN' } });

  setProperty('value', 'DINE_IN');
  instance.onSelect({ currentTarget: { dataset: { value: 'DINE_IN' } } });
  assert.equal(events.length, 1, '相同值不应重复派发');

  setProperty('dineInEnabled', false);
  setProperty('value', 'TAKEAWAY');
  instance.onSelect({ currentTarget: { dataset: { value: 'DINE_IN' } } });
  assert.equal(events.length, 1, '不支持的履约方式不应派发');
});

test('category-nav 组件：分类选择事件', () => {
  const { instance, events } = loadComponent('category-nav');
  instance.data.activeId = 'cat_sig';
  instance.onSelect({ currentTarget: { dataset: { id: 'cat_snack' } } });
  assert.deepEqual(events[0], { name: 'select', detail: { id: 'cat_snack' } });

  instance.onSelect({ currentTarget: { dataset: { id: 'cat_sig' } } });
  assert.equal(events.length, 1, '当前分类不应重复派发');
});

test('order-card 组件：顾客操作与店主推进事件', () => {
  const { instance, events } = loadComponent('order-card');
  instance.data.order = { id: 'ord_001', canPay: true, canCancel: true, actions: [] };
  instance.onPay({});
  assert.deepEqual(events[0], { name: 'pay', detail: { orderId: 'ord_001' } });

  instance.onCancel({});
  assert.deepEqual(events[1], { name: 'cancel', detail: { orderId: 'ord_001', reason: '' } });

  instance.onAdvance({ currentTarget: { dataset: { status: 'PREPARING' } } });
  assert.deepEqual(events[2], { name: 'advance', detail: { orderId: 'ord_001', toStatus: 'PREPARING' } });

  instance.onOpen();
  assert.deepEqual(events[3], { name: 'open', detail: { orderId: 'ord_001' } });
});

test('state-view 组件：重试事件不携带路由信息', () => {
  const { instance, events } = loadComponent('state-view');
  instance.onAction();
  assert.deepEqual(events[0], { name: 'retry', detail: {} });
});

test('error-banner 组件：重试与关闭事件', () => {
  const { instance, events } = loadComponent('error-banner');
  instance.onRetry();
  instance.onClose();
  assert.deepEqual(events.map((item) => item.name), ['retry', 'close']);
});

test('loading-block 组件：行数限制在 1–8', () => {
  const { instance, setProperty } = loadComponent('loading-block');
  setProperty('rows', 5);
  assert.equal(instance.data.bars.length, 5);
  setProperty('rows', 99);
  assert.equal(instance.data.bars.length, 8);
  setProperty('rows', -3);
  assert.equal(instance.data.bars.length, 1);
});

test('store-header 组件：缺省门店名不显示 undefined', () => {
  const { instance } = loadComponent('store-header');
  assert.equal(instance.data.storeName, '');
  assert.equal(instance.data.mode, 'TAKEAWAY');
  assert.equal(instance.data.compact, false);
});

test('status-timeline 组件：属性默认空数组', () => {
  const { instance } = loadComponent('status-timeline');
  assert.deepEqual(instance.data.steps, []);
  assert.deepEqual(instance.data.timeline, []);
  assert.equal(instance.data.status, '');
});

test('product-detail 组件：停售商品不派发加购', () => {
  const { instance, events, setProperty } = loadComponent('product-detail');
  setProperty('product', { id: 'prd_seasonal', name: '季节限定甜品', priceCents: 1800, available: false });
  instance.onAdd();
  assert.equal(events.length, 0);
  instance.data.product.available = true;
  instance.onAdd();
  assert.deepEqual(events[0], { name: 'add', detail: { productId: 'prd_seasonal' } });
});