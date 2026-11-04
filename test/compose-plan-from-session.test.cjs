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
  assert.deepStrictEqual(result.plan.features, [], '经典点餐不携带任何 Feature Pack');
  assert.strictEqual(result.recipeId, 'order-classic');
  assert.strictEqual(result.recipeDisplayName, '经典点餐');
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

test('主厨推荐映射到 order-poster，Plan 携带 home-hero 海报插槽并通过 schema', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(sessionState({ build: { selectedId: 'signature-kitchen' } }));

  assert.strictEqual(result.plan.planId, 'order-poster');
  assert.strictEqual(result.recipeId, 'order-poster');
  assert.strictEqual(result.recipeDisplayName, '海报点餐');
  assert.strictEqual(result.plan.features.length, 1);

  const feature = result.plan.features[0];
  assert.strictEqual(feature.id, 'poster-carousel');
  assert.strictEqual(feature.version, '1.0.0');
  assert.deepStrictEqual(feature.slots.map((slot) => slot.slotId), ['home-hero']);
  assert.strictEqual(feature.slots[0].dataKey, 'homeHero');
  assert.strictEqual(feature.slots[0].props.items.length, 3);
  assert.strictEqual(feature.slots[0].props.autoplay, true);
  assert.strictEqual(feature.slots[0].props.interval, 4000);

  const validation = validatePlan(result.plan);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation));
});

test('Plan 的 features 是深拷贝：改写返回值不污染同模板的下一次调用', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const state = sessionState({ build: { selectedId: 'signature-kitchen' } });
  const first = buildPlanFromSession(state);
  first.plan.features[0].slots[0].props.items[0].title = '被篡改';
  first.plan.features[0].slots[0].props.items.push({ id: 'x', title: '多余', subtitle: '', tone: 'warm' });

  const second = buildPlanFromSession(state);
  assert.strictEqual(second.plan.features[0].slots[0].props.items.length, 3);
  assert.strictEqual(second.plan.features[0].slots[0].props.items[0].title, '秋日暖锅上新');
  assert.deepStrictEqual(buildPlanFromSession(state), second, '纯函数：同 state 仍深相等');
});

test('咖啡模板与街巷食集共用 order-classic：结构差异只由候选 layout 承担', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const coffee = buildPlanFromSession(sessionState({ build: { selectedId: 'modern-coffee' } }));
  const bistro = buildPlanFromSession(sessionState({ build: { selectedId: 'warm-bistro' } }));

  assert.strictEqual(coffee.plan.planId, 'order-classic');
  assert.strictEqual(bistro.plan.planId, 'order-classic');
  assert.deepStrictEqual(coffee.plan.features, []);
  assert.deepStrictEqual(bistro.plan.features, []);
});

test('按角色过滤页面，combined 与缺省一致且不修改 state', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const state = sessionState();
  const snapshot = JSON.stringify(state);
  const customer = buildPlanFromSession(state, { role: 'customer' });
  const merchant = buildPlanFromSession(state, { role: 'merchant' });
  assert.deepStrictEqual(customer.plan.pages.map((page) => page.pageId), ['home', 'menu', 'orders', 'mine', 'checkout', 'order-detail']);
  assert.deepStrictEqual(merchant.plan.pages.map((page) => page.pageId), ['merchant-orders']);
  assert.strictEqual(validatePlan(customer.plan).ok, true);
  assert.strictEqual(validatePlan(merchant.plan).ok, true);
  assert.deepStrictEqual(buildPlanFromSession(state, { role: 'combined' }), buildPlanFromSession(state));
  assert.strictEqual(JSON.stringify(state), snapshot);
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
test('店名来源缺省及未知值均为 confirmed-first，预览可显式 draft-first', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const state = sessionState({
    store: { ...sessionState().store, name: '已确认门店' },
    agentDraft: { ...sessionState().agentDraft, storeName: '未确认草稿门店' },
  });

  assert.strictEqual(buildPlanFromSession(state).plan.storeProfile.name, '已确认门店');
  assert.strictEqual(
    buildPlanFromSession(state, { storeNameSource: 'confirmed-first' }).plan.storeProfile.name,
    '已确认门店',
  );
  assert.strictEqual(
    buildPlanFromSession(state, { storeNameSource: 'unknown-source' }).plan.storeProfile.name,
    '已确认门店',
  );

  const preview = buildPlanFromSession(state, { storeNameSource: 'draft-first' });
  assert.strictEqual(preview.plan.storeProfile.name, '未确认草稿门店');
  assert.strictEqual(validatePlan(preview.plan).ok, true);
  assert.strictEqual(Object.hasOwn(preview.plan.storeProfile, 'storeNameSource'), false);
  assert.ok(preview.plan.storeProfile.dishes.every((dish) => !Object.hasOwn(dish, 'id')));
});

test('draft-first 保留空值回落、trim、48 字截断与纯函数约束', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const base = sessionState({
    store: { ...sessionState().store, name: '已确认门店' },
  });
  const emptyDraft = {
    ...base,
    agentDraft: { ...base.agentDraft, storeName: '' },
  };
  assert.strictEqual(
    buildPlanFromSession(emptyDraft, { storeNameSource: 'draft-first' }).plan.storeProfile.name,
    '已确认门店',
  );
  const blankDraft = {
    ...base,
    agentDraft: { ...base.agentDraft, storeName: '   ' },
  };
  assert.strictEqual(
    buildPlanFromSession(blankDraft, { storeNameSource: 'draft-first' }).plan.storeProfile.name,
    '我的餐馆',
  );

  const state = {
    ...base,
    agentDraft: { ...base.agentDraft, storeName: `  ${'草'.repeat(60)}  ` },
  };
  const snapshot = JSON.stringify(state);
  const first = buildPlanFromSession(state, { storeNameSource: 'draft-first' });
  const second = buildPlanFromSession(state, { storeNameSource: 'draft-first' });
  assert.strictEqual(first.plan.storeProfile.name, '草'.repeat(48));
  assert.deepStrictEqual(first, second);
  assert.strictEqual(JSON.stringify(state), snapshot);
});