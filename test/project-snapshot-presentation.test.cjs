'use strict';

/**
 * W0 / P0-2：展示补丁（templateId + whitelist patch）的保存与恢复。
 *
 * 验收口径不是「界面文案还在」，而是重开项目后
 * `buildPlanFromSession()` 能重新得到同一份展示补丁 —— 这里直接比对 Plan。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');

async function load() {
  const machine = await import(pathToFileURL(path.join(REPO, 'src', 'state', 'sessionMachine.mjs')).href);
  const snapshot = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'projectSnapshot.mjs')).href);
  const planFromSession = await import(pathToFileURL(path.join(REPO, 'src', 'composition', 'planFromSession.mjs')).href);
  return { machine, snapshot, planFromSession };
}

/** 一个「主题 + 尺寸 + 文案」都改过的项目状态。 */
function makeStateWithPresentation(machine) {
  const base = machine.createInitialState();
  return {
    ...base,
    build: {
      status: 'ready',
      candidates: [{ id: 'warm-bistro', name: '街巷食集', layout: 'menu', score: 92, summary: '菜单优先' }],
      selectedId: 'warm-bistro',
      feedback: [],
    },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'], custom: '' },
    visual: { ...base.visual, styleId: 'warm' },
    agentDraft: {
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [
        { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣' },
        { id: 'dish-2', name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
      ],
    },
    presentation: {
      ...base.presentation,
      templateId: 'warm-bistro',
      patch: {
        theme: { primaryColor: '#C2410C' },
        sizes: { productCard: 'lg' },
        copy: { storeName: '松月食堂（试营业）' },
      },
      // 以下都是请求期状态，必须不落盘
      changes: [{ path: 'theme.primaryColor', label: '主色', before: '#111111', after: '#C2410C' }],
      status: 'failed',
      requestId: 'req_should_not_persist',
      lastUtterance: '把主色换成橙色',
      error: { code: 'TEMPLATE_REVISE_FAILED', message: '上游超时' },
    },
  };
}

function makeDoc(snapshot, machine) {
  return snapshot.toDocument(makeStateWithPresentation(machine), { projectId: 'p_w0_snapshot' });
}

test('保存：只序列化 templateId 与白名单 patch，请求期状态一律不落盘', async () => {
  const { machine, snapshot } = await load();
  const doc = makeDoc(snapshot, machine);

  assert.ok(doc.presentation, 'project.json 必须包含 presentation 段');
  assert.deepStrictEqual(Object.keys(doc.presentation).sort(), ['patch', 'templateId']);
  assert.strictEqual(doc.presentation.templateId, 'warm-bistro');
  assert.deepStrictEqual(doc.presentation.patch, {
    theme: { primaryColor: '#C2410C' },
    sizes: { productCard: 'lg' },
    copy: { storeName: '松月食堂（试营业）' },
  });

  const serialized = JSON.stringify(doc);
  for (const forbidden of ['req_should_not_persist', 'TEMPLATE_REVISE_FAILED', '上游超时', '把主色换成橙色']) {
    assert.ok(!serialized.includes(forbidden), `快照不应包含请求期数据：${forbidden}`);
  }
});

test('恢复：重开后 Plan 与原状态一致（主题 token、尺寸档位都真实还原）', async () => {
  const { machine, snapshot, planFromSession } = await load();
  const state = makeStateWithPresentation(machine);
  const doc = makeDoc(snapshot, machine);
  const hydrated = snapshot.fromDocument(doc);

  assert.deepStrictEqual(hydrated.presentation.patch, doc.presentation.patch);
  assert.strictEqual(hydrated.presentation.templateId, 'warm-bistro');
  assert.strictEqual(hydrated.presentation.status, 'idle');
  assert.strictEqual(hydrated.presentation.error, null);
  assert.strictEqual(hydrated.presentationRestore, null);

  const before = planFromSession.buildPlanFromSession(state).plan;
  const after = planFromSession.buildPlanFromSession({ ...state, ...hydrated }).plan;

  assert.deepStrictEqual(after.themeTokens, before.themeTokens, '主题 token 必须逐项一致');
  assert.strictEqual(after.themeTokens.primaryColor, '#C2410C');
  assert.deepStrictEqual(after.presentationTokens, before.presentationTokens, '尺寸档位必须一致');
  assert.deepStrictEqual(after.storeProfile, before.storeProfile);
});

test('恢复：二次读写幂等，不会因为保存-打开-保存而漂移', async () => {
  const { machine, snapshot } = await load();
  const first = makeDoc(snapshot, machine);
  const hydrated = snapshot.fromDocument(first);
  const second = snapshot.toDocument({ ...makeStateWithPresentation(machine), ...hydrated }, { projectId: 'p_w0_snapshot' });
  assert.deepStrictEqual(second.presentation, first.presentation);
});

test('旧快照（没有 presentation 段）能照常打开，外观回到默认而不是崩溃', async () => {
  const { machine, snapshot } = await load();
  const doc = makeDoc(snapshot, machine);
  const legacy = { ...doc };
  delete legacy.presentation;

  const hydrated = snapshot.fromDocument(legacy);
  assert.deepStrictEqual(hydrated.presentation.patch, {});
  assert.strictEqual(hydrated.presentation.templateId, 'warm-bistro');
  assert.strictEqual(hydrated.presentationRestore, null);
});

test('非法补丁：安全回退到默认外观，并留下明确 notice（不静默吞掉）', async () => {
  const { machine, snapshot } = await load();
  const doc = makeDoc(snapshot, machine);
  const broken = {
    ...doc,
    presentation: { templateId: 'warm-bistro', patch: { theme: { primaryColor: 'red' } } },
  };

  const hydrated = snapshot.fromDocument(broken);
  assert.deepStrictEqual(hydrated.presentation.patch, {});
  assert.ok(hydrated.presentationRestore, '必须给出可见提示');
  assert.strictEqual(hydrated.presentationRestore.code, 'PRESENTATION_PATCH_DISCARDED');
  assert.match(hydrated.presentationRestore.message, /默认外观/);
});

test('补丁属于另一个模板：丢弃补丁并提示，绝不错配应用', async () => {
  const { machine, snapshot } = await load();
  const doc = makeDoc(snapshot, machine);
  const mismatched = {
    ...doc,
    presentation: { templateId: 'order-classic', patch: doc.presentation.patch },
  };

  const hydrated = snapshot.fromDocument(mismatched);
  assert.deepStrictEqual(hydrated.presentation.patch, {});
  assert.strictEqual(hydrated.presentation.templateId, 'warm-bistro', '以当前选中模板为准');
  assert.strictEqual(hydrated.presentationRestore.code, 'PRESENTATION_PATCH_TEMPLATE_MISMATCH');
});

test('保存端也会校验：非法补丁不会写进 project.json', async () => {
  const { machine, snapshot } = await load();
  const state = makeStateWithPresentation(machine);
  state.presentation = { ...state.presentation, patch: { theme: { primaryColor: 'not-a-color' } } };
  const doc = snapshot.toDocument(state, { projectId: 'p_w0_snapshot' });
  assert.deepStrictEqual(doc.presentation.patch, {});
  assert.strictEqual(doc.presentation.templateId, 'warm-bistro');
});

test('presentation 已登记为已知顶层键，不会被当成未知字段反复回写', async () => {
  const { machine, snapshot } = await load();
  const doc = makeDoc(snapshot, machine);
  const unknown = snapshot.collectUnknown(doc);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(unknown, 'presentation'), false);
  assert.ok(snapshot.KNOWN_TOP_KEYS.includes('presentation'));
});

test('存盘白名单：presentation 必须留在顶层，不能被搬进 unmappedFields', async () => {
  const { machine, snapshot } = await load();
  const { normalizeDocumentForSave } = require(path.join(REPO, 'desktop', 'project-store.cjs'));
  const projectId = 'p_w0roundtrip01';
  const doc = snapshot.toDocument(makeStateWithPresentation(machine), { projectId, name: '存盘白名单' });
  const saved = normalizeDocumentForSave(doc, projectId);

  assert.ok(Object.prototype.hasOwnProperty.call(saved, 'presentation'), 'presentation 必须在顶层');
  assert.deepStrictEqual(saved.presentation, doc.presentation);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(saved.unmappedFields || {}, 'presentation'),
    false,
    'presentation 一旦落入 unmappedFields，重开项目就读不回来了',
  );
});

test('无补丁状态：templateId 跟随当前选中模板，patch 为空', async () => {
  const { machine, snapshot } = await load();
  const base = machine.createInitialState();
  const doc = snapshot.toDocument({
    ...base,
    build: { status: 'ready', candidates: [{ id: 'order-classic', name: '经典', layout: 'menu', score: 80, summary: '' }], selectedId: 'order-classic', feedback: [] },
  }, { projectId: 'p_w0_empty' });
  assert.deepStrictEqual(doc.presentation, { templateId: 'order-classic', patch: {} });
});
