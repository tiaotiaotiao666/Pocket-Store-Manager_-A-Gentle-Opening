'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');

async function load() {
  const machine = await import(pathToFileURL(path.join(REPO, 'src', 'state', 'sessionMachine.mjs')).href);
  const rules = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'preflightRules.mjs')).href);
  return { machine, rules };
}

function baseState(machine, overrides) {
  const state = machine.createInitialState();
  return {
    ...state,
    view: 'flow',
    phase: 'deploy',
    project: { ...state.project, mode: 'desktop', activeId: 'p_12345678abcdef' },
    store: { name: '松月食堂', type: '社区餐馆', notes: '', address: '', phone: '' },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'takeaway'], custom: '' },
    agentDraft: {
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [
        { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '' },
        { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
        { id: 'dish-3', name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
      ],
    },
    ...overrides,
  };
}

function ids(list) {
  return list.map((item) => item.ruleId);
}

test('完整资料在桌面模式下本地规则无 error', async () => {
  const { machine, rules } = await load();
  const result = rules.evaluateLocal(baseState(machine), { devtoolsDetected: true });
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.infos.some((item) => item.ruleId === 'I-DEMO-PAYMENT'));
});

test('店名为空与超长命中 E-PLAN-NAME', async () => {
  const { machine, rules } = await load();
  const emptyState = baseState(machine, { store: { name: '', type: '' } });
  emptyState.agentDraft = { ...emptyState.agentDraft, storeName: '' };
  const empty = rules.evaluateLocal(emptyState);
  assert.ok(ids(empty.errors).includes('E-PLAN-NAME'));
  const long = rules.evaluateLocal(baseState(machine, { store: { name: '店'.repeat(49), type: '' } }));
  assert.ok(ids(long.errors).includes('E-PLAN-NAME'));
});

test('0 道菜与价格非法分别命中 E-PLAN-DISHES / E-PLAN-PRICE', async () => {
  const { machine, rules } = await load();
  const none = baseState(machine);
  none.agentDraft = { ...none.agentDraft, dishes: [] };
  assert.ok(ids(rules.evaluateLocal(none).errors).includes('E-PLAN-DISHES'));

  // 1 道有效菜就够，不再要求 3 道。
  const one = baseState(machine);
  one.agentDraft = { ...one.agentDraft, dishes: one.agentDraft.dishes.slice(0, 1) };
  assert.ok(!ids(rules.evaluateLocal(one).errors).includes('E-PLAN-DISHES'));

  const badPrice = baseState(machine);
  badPrice.agentDraft = {
    ...badPrice.agentDraft,
    dishes: badPrice.agentDraft.dishes.map((dish, index) => (index === 0 ? { ...dish, priceCents: 0 } : dish)),
  };
  assert.ok(ids(rules.evaluateLocal(badPrice).errors).includes('E-PLAN-PRICE'));
});

test('营业时间为空与取餐方式都关闭命中对应 error', async () => {
  const { machine, rules } = await load();
  const noHours = baseState(machine);
  noHours.agentDraft = { ...noHours.agentDraft, businessHours: '' };
  assert.ok(ids(rules.evaluateLocal(noHours).errors).includes('E-PLAN-HOURS'));

  const noFulfillment = baseState(machine);
  noFulfillment.agentDraft = { ...noFulfillment.agentDraft, fulfillment: { dineIn: false, takeaway: false } };
  assert.ok(ids(rules.evaluateLocal(noFulfillment).errors).includes('E-PLAN-FULFILLMENT'));

  const tooMany = baseState(machine);
  tooMany.agentDraft = { ...tooMany.agentDraft, businessHours: '08:00-09:00,10:00-11:00,12:00-13:00,14:00-15:00' };
  assert.ok(ids(rules.evaluateLocal(tooMany).errors).includes('E-PLAN-HOURS'));
});

test('AppID 非法与浏览器模式分别命中 error', async () => {
  const { machine, rules } = await load();
  const badAppid = baseState(machine, { project: { ...baseState(machine).project, appid: 'wx123' } });
  assert.ok(ids(rules.evaluateLocal(badAppid).errors).includes('E-APPID-FORMAT'));

  const browser = baseState(machine, { project: { ...baseState(machine).project, mode: 'browser' } });
  assert.ok(ids(rules.evaluateLocal(browser).errors).includes('E-DESKTOP-REQUIRED'));
});

test('模板外能力、菜品丢弃与缺少 AppID 产生 warn（B4：只有前两类需要确认后果）', async () => {
  const { machine, rules } = await load();
  const state = baseState(machine, {
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking', 'store-gallery'], custom: '' },
  });
  state.agentDraft = {
    ...state.agentDraft,
    dishes: [...state.agentDraft.dishes, { id: 'dish-4', name: '', priceCents: 100, priceText: '1.00', description: '' }],
  };
  const result = rules.evaluateLocal(state);
  assert.ok(ids(result.warns).includes('W-UNMAPPED-FEATURE'));
  assert.ok(ids(result.warns).includes('W-DISH-DROPPED'));
  assert.ok(ids(result.warns).includes('W-NO-APPID'));
  // B4 规则 8：缺 AppID 只是披露，不再要求用户点「我已了解」。
  const byId = (id) => result.warns.find((item) => item.ruleId === id);
  assert.strictEqual(byId('W-NO-APPID').requiresAck, false);
  // 用户自己勾了但不会交付的能力，必须保留一次明确的后果说明。
  assert.strictEqual(byId('W-UNMAPPED-FEATURE').requiresAck, true);
  assert.ok(String(byId('W-UNMAPPED-FEATURE').consequence || '').length > 0);
  assert.strictEqual(byId('W-DISH-DROPPED').requiresAck, true);
});

test('未勾选的基础能力仍随模板导出：W-BASE-FEATURE-UNCHECKED 只披露、不要求确认', async () => {
  const { machine, rules } = await load();
  const result = rules.evaluateLocal(baseState(machine));
  const hits = result.warns.filter((item) => item.ruleId === 'W-BASE-FEATURE-UNCHECKED');
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].message.includes('堂食'));
  assert.ok(hits[0].message.includes('由基础模板自带'));
  // B4 规则 8：这类说明不进「我已了解」清单。
  assert.strictEqual(hits[0].requiresAck, false);
  assert.strictEqual(hits[0].fieldPath, 'features.selected');
  assert.deepStrictEqual(hits[0].action, { label: '去确认能力勾选', phase: 'features' });
  // 9 个基础能力全部勾选时不再提示
  const all = baseState(machine, {
    features: {
      selected: [
        'scan-order', 'product-catalog', 'cart-checkout', 'order-tracking',
        'table-dining', 'takeaway', 'merchant-orders', 'product-availability', 'store-profile',
      ],
      custom: '',
    },
  });
  assert.ok(!ids(rules.evaluateLocal(all).warns).includes('W-BASE-FEATURE-UNCHECKED'));
  // 一个都没勾（边界）时也不提示，避免首屏噪音
  const none = baseState(machine, { features: { selected: [], custom: '' } });
  assert.ok(!ids(rules.evaluateLocal(none).warns).includes('W-BASE-FEATURE-UNCHECKED'));
});

test('图片、长会话与开发者工具缺失进入 info', async () => {
  const { machine, rules } = await load();
  const state = baseState(machine);
  state.assets = { images: [{ assetId: 'a_3f9c1d7e5b2a8406', fileName: 'x.png' }] };
  state.sessions = [{ id: 'session-main', messages: Array.from({ length: 130 }, (_, index) => ({ id: `m${index}`, role: 'user', text: 'x' })) }];
  const result = rules.evaluateLocal(state, { devtoolsDetected: false });
  assert.ok(ids(result.infos).includes('I-IMG-NOT-EXPORTED'));
  assert.ok(ids(result.infos).includes('I-SESSION-LONG'));
  assert.ok(ids(result.infos).includes('I-DEVTOOLS-NOT-FOUND'));
});

test('mergeComposerResult：契约错误、主题对比度、previewOnly 与版本缺口', async () => {
  const { machine, rules } = await load();
  const local = rules.evaluateLocal(baseState(machine));

  const contract = rules.mergeComposerResult(local, { ok: false, code: 'PLAN_FIELD_FORBIDDEN', message: 'Plan 含禁止字段' });
  assert.ok(ids(contract.errors).includes('E-PLAN-CONTRACT'));

  const theme = rules.mergeComposerResult(local, { ok: false, code: 'THEME_CONTRAST_LOW', message: '对比度不足' });
  assert.ok(ids(theme.errors).includes('E-THEME-CONTRAST'));

  const preview = rules.mergeComposerResult(local, {
    ok: true,
    planDigest: 'sha256:plan',
    previewOnly: ['store-gallery'],
    updatesAvailable: [{ id: 'ui-block', current: '1.0.0', available: '1.1.0' }],
  });
  assert.ok(ids(preview.warns).includes('W-PREVIEW-ONLY'));
  assert.ok(ids(preview.warns).includes('W-VERSION-GAP'));
  assert.strictEqual(preview.planDigest, 'sha256:plan');
});

test('目标预检：冲突只追加一条 E-TARGET-EXISTS，重复合并去重', async () => {
  const { machine, rules } = await load();
  const local = rules.evaluateLocal(baseState(machine));
  assert.deepStrictEqual(local.errors, []);

  const conflict = rules.mergeTargetPreflight(local, {
    status: 'conflict',
    exists: true,
    projectName: '松月食堂',
    suggestedName: '松月食堂-2',
  });
  const hits = conflict.errors.filter((item) => item.ruleId === 'E-TARGET-EXISTS');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].level, 'error');
  assert.strictEqual(hits[0].fieldPath, 'deploy.projectName');
  assert.ok(hits[0].message.includes('不会覆盖'));
  assert.ok(hits[0].message.includes('松月食堂-2'));

  const again = rules.mergeTargetPreflight(conflict, {
    status: 'conflict',
    exists: true,
    projectName: '松月食堂',
    suggestedName: '松月食堂-2',
  });
  assert.strictEqual(again.errors.filter((item) => item.ruleId === 'E-TARGET-EXISTS').length, 1);
});

test('目标预检：目标不存在不产生 error，检查失败追加阻断 error', async () => {
  const { machine, rules } = await load();
  const local = rules.evaluateLocal(baseState(machine));

  const ok = rules.mergeTargetPreflight(local, { status: 'ok', exists: false, projectName: '松月食堂' });
  assert.deepStrictEqual(ok.errors, local.errors);
  assert.deepStrictEqual(ok.warns, local.warns);

  const failed = rules.mergeTargetPreflight(local, {
    status: 'failed',
    code: 'TARGET_PARENT_MISSING',
    message: '导出位置不存在，请重新选择目录',
  });
  const hits = failed.errors.filter((item) => item.ruleId === 'E-TARGET-CHECK-FAILED');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].fieldPath, 'deploy.directory');
  assert.ok(hits[0].message.includes('导出位置不存在'));

  assert.ok(rules.PREFLIGHT_RULE_IDS.ERROR.includes('E-TARGET-EXISTS'));
  assert.ok(rules.PREFLIGHT_RULE_IDS.ERROR.includes('E-TARGET-CHECK-FAILED'));
});

test('本地 error 存在时不会调用 Composer（由 App 层负责，但规则结果必须阻断）', async () => {
  const { machine, rules } = await load();
  const state = baseState(machine, { store: { name: '', type: '' } });
  state.agentDraft = { ...state.agentDraft, storeName: '' };
  const result = rules.evaluateLocal(state);
  assert.ok(result.errors.length > 0);
  assert.strictEqual(result.errors[0].level, 'error');
  assert.ok(result.errors[0].action.phase);
});