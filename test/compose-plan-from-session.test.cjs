'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { validatePlan } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));

function sessionState(overrides) {
  return {
    store: {
      name: '松月食堂',
      type: '社区餐馆',
      address: '上海市静安区示例路 8 号',
      phone: '13800000000',
      notes: '社区家常菜',
    },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'merchant-orders', 'loyalty-membership'] },
    build: { selectedId: 'warm-bistro' },
    visual: { styleId: 'fresh' },
    agentDraft: {
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-14:00,17:00-21:00',
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [
        { name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣' },
        { name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
        { name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
        { name: '无价菜', priceCents: null, priceText: '', description: '' },
      ],
    },
    ...overrides,
  };
}

test('会话状态生成合法 Plan，页面固定 7 个', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(sessionState());
  assert.strictEqual(result.plan.planId, 'order-classic');
  assert.strictEqual(result.plan.pages.length, 7);
  assert.deepStrictEqual(result.plan.pages.map((page) => page.pageId), ['home', 'menu', 'orders', 'mine', 'checkout', 'order-detail', 'merchant-orders']);
  const validation = validatePlan(result.plan);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation));
  assert.deepStrictEqual(result.unmappedCapabilities.map((item) => item.id), ['loyalty-membership']);
  assert.ok(result.warnings.some((warning) => warning.includes('会员积分')));
});

test('同一 state 两次调用深相等（纯函数）', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const first = buildPlanFromSession(sessionState());
  const second = buildPlanFromSession(sessionState());
  assert.deepStrictEqual(first, second);
});

test('未知模板回落 order-classic 并告警', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(sessionState({ build: { selectedId: 'not-a-template' } }));
  assert.strictEqual(result.plan.planId, 'order-classic');
  assert.ok(result.warnings.some((warning) => warning.includes('回落')));
});

test('AgentDraft 映射：整数分、营业时段、履约方式与店名', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const { plan } = buildPlanFromSession(sessionState());
  assert.strictEqual(plan.storeProfile.name, '松月食堂');
  assert.strictEqual(plan.storeProfile.category, '社区餐馆');
  assert.deepStrictEqual(plan.storeProfile.businessHours, [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '21:00' },
  ]);
  assert.deepStrictEqual(plan.storeProfile.fulfillment, { dineIn: true, takeaway: false });
  assert.strictEqual(plan.storeProfile.dishes.length, 3, '缺价菜品不应写入');
  assert.deepStrictEqual(Object.keys(plan.storeProfile.dishes[0]).sort(), ['description', 'name', 'priceCents']);
  assert.ok(plan.storeProfile.dishes.every((dish) => Number.isInteger(dish.priceCents)));
});

test('装修风格映射到 Base 主题预设', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const green = buildPlanFromSession(sessionState({ visual: { styleId: 'fresh' } }));
  assert.strictEqual(green.themePresetId, 'deep-green');
  assert.strictEqual(green.plan.themeTokens.pageBackground, '#F3F6F1');

  const unknown = buildPlanFromSession(sessionState({ visual: { styleId: 'unknown-style' } }));
  assert.strictEqual(unknown.themePresetId, 'warm-orange');
  assert.ok(unknown.warnings.some((warning) => warning.includes('暖橙')));
  assert.strictEqual(validatePlan(unknown.plan).ok, true);
});