'use strict';

/**
 * `C-SESSION-PRESENTATION@1` 的验收测试。
 *
 * 契约来源：.codeartsdoer/plans/full-chain-agent/plan.md 2.2.3 / T3。
 * 覆盖：初始切片、四个动作、requestId 守卫、copy 映射、模板切换重置、撤销/重做、选择器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const CANDIDATES = [
  { id: 'warm-bistro', name: '街巷食集', layout: 'menu', score: 100, summary: '菜单优先' },
  { id: 'modern-coffee', name: '一杯日常', layout: 'catalog', score: 91, summary: '高效选购' },
  { id: 'signature-kitchen', name: '主厨推荐', layout: 'editorial', score: 82, summary: '大幅主图' },
];

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

/** 走到模板页且候选已就绪（build.status === 'ready'）。 */
async function atTemplatePick() {
  const machine = await loadMachine();
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: CANDIDATES });
  return { machine, state };
}

/** 在模板页基础上准备一份带菜品与价格的 Agent 草稿。 */
async function atTemplatePickWithDraft() {
  const { machine, state } = await atTemplatePick();
  const { normalizeAgentDraft } = await import('../src/domain/agentDraft.mjs');
  const draft = normalizeAgentDraft({
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'd1', name: '招牌牛肉面', priceText: '28', description: '清汤慢炖' },
      { id: 'd2', name: '桂花酒酿', priceText: '12', description: '饭后甜点' },
      { id: 'd3', name: '葱油拌面', priceText: '18', description: '现拌现吃' },
    ],
  });
  return { machine, state: { ...state, agentDraft: draft } };
}

/** 发一次请求，进入 revising。 */
function requestRevise(machine, state, requestId, utterance = '把主色换成暖一点的颜色') {
  return machine.reducer(state, { type: 'TEMPLATE_REVISE_REQUEST', utterance, requestId });
}

const FIRST_PATCH = {
  theme: { primaryColor: '#C96049' },
  copy: {
    storeName: '松鼠食堂',
    category: '社区烘焙',
    tagline: '每天现烤',
    dishes: [
      { id: 'd1', name: '招牌可颂', description: '黄油香浓' },
      { id: 'd2', description: '午后限定' },
    ],
  },
};

const SECOND_PATCH = {
  ...FIRST_PATCH,
  theme: { ...FIRST_PATCH.theme, accentColor: '#E1AB62' },
  sizes: { homeHero: 'lg' },
};

const THIRD_CHANGES = [
  { path: 'theme.primaryColor', label: '主色', before: '#334F59', after: '#C96049' },
  { path: 'copy.storeName', label: '店名', before: '松月食堂', after: '松鼠食堂' },
  { path: 'copy.tagline', label: '门店口号', before: null, after: '每天现烤' },
];

test('初始切片：presentation 严格按 2.2.3 的字段与初始值', async () => {
  const machine = await loadMachine();
  const state = machine.createInitialState();
  assert.deepEqual(state.presentation, {
    templateId: null,
    patch: {},
    changes: [],
    status: 'idle',
    requestId: null,
    lastUtterance: '',
    error: null,
  });
});

test('TEMPLATE_REVISE_REQUEST：进入 revising、追加用户消息、记录 requestId，patch 不变', async () => {
  const { machine, state } = await atTemplatePick();
  const next = requestRevise(machine, state, 'req-1', '  把主色改成暖一点的  ');

  assert.equal(next.presentation.status, 'revising');
  assert.equal(next.presentation.requestId, 'req-1');
  assert.equal(next.presentation.lastUtterance, '把主色改成暖一点的');
  assert.deepEqual(next.presentation.patch, {});
  assert.deepEqual(next.presentation.changes, []);
  assert.equal(next.presentation.templateId, 'warm-bistro', '请求时绑定当前模板');
  assert.equal(next.presentation.error, null);

  const session = next.sessions.find((item) => item.id === next.activeSessionId);
  const last = session.messages[session.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.text, '把主色改成暖一点的');
  assert.equal(last.meta.kind, 'template-revise-request');
});

test('TEMPLATE_REVISE_REQUEST 守卫：非模板页 / 未就绪 / 单飞 / 空描述都原样返回', async () => {
  const { machine, state } = await atTemplatePick();

  const building = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '换个大图的' });
  assert.equal(
    machine.reducer(building, { type: 'TEMPLATE_REVISE_REQUEST', utterance: '改颜色', requestId: 'r1' }),
    building,
    'build.status 不是 ready 时没有可改的模板',
  );

  const { PHASES } = await import('../src/state/constants.mjs');
  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });
  assert.equal(
    machine.reducer(features, { type: 'TEMPLATE_REVISE_REQUEST', utterance: '改颜色', requestId: 'r1' }),
    features,
    '只有模板页处理展示修改',
  );

  const revising = requestRevise(machine, state, 'r1');
  assert.equal(
    machine.reducer(revising, { type: 'TEMPLATE_REVISE_REQUEST', utterance: '再改一次', requestId: 'r2' }),
    revising,
    '单飞：revising 期间忽略新请求',
  );

  assert.equal(
    machine.reducer(state, { type: 'TEMPLATE_REVISE_REQUEST', utterance: '   ', requestId: 'r1' }),
    state,
    '空描述不产生请求',
  );
  assert.equal(
    machine.reducer(state, { type: 'TEMPLATE_REVISE_REQUEST', utterance: '改颜色' }),
    state,
    '缺少 requestId 不产生请求',
  );
});

test('TEMPLATE_REVISE_SUCCESS：写入服务端补丁、changes 截断 20、reply 为空时回落到「已更新 N 项」', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const revising = requestRevise(machine, state, 'req-1');

  const manyChanges = Array.from({ length: 25 }, (_, index) => ({
    path: `copy.dishes[${index}].name`,
    label: '菜品名称',
    before: '旧',
    after: '新',
  }));
  const next = machine.reducer(revising, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: { ...FIRST_PATCH, theme: { primaryColor: '#c96049' } },
    changes: manyChanges,
  });

  assert.equal(next.presentation.status, 'idle');
  assert.equal(next.presentation.changes.length, 20, 'changes 必须截断到 20 条');
  assert.equal(next.presentation.requestId, 'req-1');
  assert.equal(next.presentation.templateId, 'warm-bistro');
  // 颜色写入前统一转大写（plan.md 2.2.4 第 5 条）
  assert.equal(next.presentation.patch.theme.primaryColor, '#C96049');

  const session = next.sessions.find((item) => item.id === next.activeSessionId);
  const last = session.messages[session.messages.length - 1];
  assert.equal(last.role, 'agent');
  assert.equal(last.text, '已更新 20 项');
  assert.equal(last.meta.kind, 'template-revise');
});

test('copy 映射：店名/品类双写、tagline 写 store.notes、菜品文案按 id 更新且价格不变', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const beforeDishes = state.agentDraft.dishes.map((dish) => ({ ...dish }));
  const revising = requestRevise(machine, state, 'req-1');
  const next = machine.reducer(revising, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
    reply: '已经按你说的改好了。',
  });

  assert.equal(next.store.name, '松鼠食堂');
  assert.equal(next.store.type, '社区烘焙');
  assert.equal(next.store.notes, '每天现烤');

  assert.equal(next.agentDraft.storeName, '松鼠食堂');
  assert.equal(next.agentDraft.category, '社区烘焙');
  assert.equal(next.agentDraft.dishes.length, beforeDishes.length, '补丁不得新增或删除菜品');

  const d1 = next.agentDraft.dishes.find((dish) => dish.id === 'd1');
  const d2 = next.agentDraft.dishes.find((dish) => dish.id === 'd2');
  const d3 = next.agentDraft.dishes.find((dish) => dish.id === 'd3');
  assert.equal(d1.name, '招牌可颂');
  assert.equal(d1.description, '黄油香浓');
  assert.equal(d1.priceCents, beforeDishes[0].priceCents, '价格必须保持不变');
  assert.equal(d1.priceText, beforeDishes[0].priceText);
  assert.equal(d2.description, '午后限定');
  assert.equal(d2.name, '桂花酒酿', '未出现在补丁里的字段保持原值');
  assert.deepEqual(d3, beforeDishes[2], '未出现在补丁里的菜品保持原值');

  const session = next.sessions.find((item) => item.id === next.activeSessionId);
  assert.equal(session.messages[session.messages.length - 1].text, '已经按你说的改好了。');
});

test('requestId 不匹配的 SUCCESS 整包忽略：patch/changes/撤销栈/会话消息都不动', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const revising = requestRevise(machine, state, 'req-1');
  const undoBefore = machine.selectUndoState(revising);
  const messagesBefore = revising.sessions[0].messages.length;

  const stale = machine.reducer(revising, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-old',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });

  assert.equal(stale, revising, '晚响应必须保持原 state 引用');
  assert.deepEqual(stale.presentation.patch, {});
  assert.equal(stale.presentation.status, 'revising');
  assert.equal(stale.sessions[0].messages.length, messagesBefore);
  assert.deepEqual(machine.selectUndoState(stale), undoBefore);
});

test('templateId 与当前补丁模板不一致时忽略（切换模板后旧结果不落到新模板）', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const revising = requestRevise(machine, state, 'req-1');
  const stale = machine.reducer(revising, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'signature-kitchen',
    patch: FIRST_PATCH,
  });
  assert.equal(stale, revising);
  assert.deepEqual(stale.presentation.patch, {});
});

test('多轮累积：第二轮带上第一轮补丁，连续撤销两次回到初始展示，重做可再前进', async () => {
  const { machine, state } = await atTemplatePickWithDraft();

  const round1Request = requestRevise(machine, state, 'req-1');
  assert.deepEqual(machine.selectPresentationState(round1Request).patch, {}, '第一轮请求携带空补丁');
  const round1 = machine.reducer(round1Request, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });
  assert.deepEqual(round1.presentation.patch, FIRST_PATCH);

  const round2Request = requestRevise(machine, round1, 'req-2', '再大一点的首屏');
  assert.deepEqual(
    machine.selectPresentationState(round2Request).patch,
    FIRST_PATCH,
    '第二轮请求必须携带第一轮已接受补丁',
  );
  const round2 = machine.reducer(round2Request, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-2',
    templateId: 'warm-bistro',
    patch: SECOND_PATCH,
    changes: [{ path: 'sizes.homeHero', label: '首屏主视觉尺寸', before: 'md', after: 'lg' }],
  });
  assert.equal(round2.presentation.patch.sizes.homeHero, 'lg');
  assert.equal(round2.presentation.patch.theme.accentColor, '#E1AB62');
  assert.equal(round2.agentDraft.storeName, '松鼠食堂');

  const undo1 = machine.reducer(round2, { type: 'UNDO_APPLY' });
  assert.deepEqual(undo1.presentation.patch, FIRST_PATCH, '第一次撤销回到第一轮');
  assert.equal(undo1.presentation.status, 'idle');

  const undo2 = machine.reducer(undo1, { type: 'UNDO_APPLY' });
  assert.deepEqual(undo2.presentation.patch, {}, '第二次撤销回到初始展示');
  assert.deepEqual(undo2.presentation.changes, []);
  assert.equal(undo2.store.name, '松月食堂', 'store 一并回退');
  assert.equal(undo2.agentDraft.storeName, '松月食堂', 'agentDraft 一并回退');
  assert.equal(undo2.agentDraft.dishes[0].name, '招牌牛肉面', '菜品文案一并回退');

  const redo1 = machine.reducer(undo2, { type: 'REDO_APPLY' });
  assert.deepEqual(redo1.presentation.patch, FIRST_PATCH);
  assert.equal(redo1.store.name, '松鼠食堂');

  const redo2 = machine.reducer(redo1, { type: 'REDO_APPLY' });
  assert.equal(redo2.presentation.patch.sizes.homeHero, 'lg');
  assert.equal(redo2.presentation.patch.theme.accentColor, '#E1AB62');
});

test('TEMPLATE_REVISE_FAILURE：保留上一版补丁与变更、状态 failed、error 可读、不压栈', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const round1 = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });
  const undoBefore = machine.selectUndoState(round1);
  const requesting = requestRevise(machine, round1, 'req-2', '再来一版');
  const messagesBefore = requesting.sessions[0].messages.length;

  const failed = machine.reducer(requesting, {
    type: 'TEMPLATE_REVISE_FAILURE',
    requestId: 'req-2',
    error: { code: 'AGENT_TIMEOUT', message: '模型响应超时' },
  });

  assert.equal(failed.presentation.status, 'failed');
  assert.deepEqual(failed.presentation.error, { code: 'AGENT_TIMEOUT', message: '模型响应超时' });
  assert.deepEqual(failed.presentation.patch, FIRST_PATCH, '失败保留上一版补丁');
  assert.deepEqual(failed.presentation.changes, THIRD_CHANGES, '失败保留上一版变更');
  assert.equal(failed.sessions[0].messages.length, messagesBefore, '失败不追加成功回复');
  assert.equal(
    machine.selectUndoState(failed).undoCount,
    undoBefore.undoCount,
    '失败动作不进入撤销栈',
  );

  const ignored = machine.reducer(failed, {
    type: 'TEMPLATE_REVISE_FAILURE',
    requestId: 'req-stale',
    error: { code: 'X', message: '旧请求失败' },
  });
  assert.equal(ignored, failed, '非当前请求的失败整包忽略');
});

test('TEMPLATE_REVISE_CLEAR：清空错误并回到 idle，且不影响补丁', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const failed = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_FAILURE',
    requestId: 'req-1',
    error: { code: 'AGENT_FAILED', message: '网络中断' },
  });
  assert.equal(failed.presentation.status, 'failed');

  const cleared = machine.reducer(failed, { type: 'TEMPLATE_REVISE_CLEAR' });
  assert.equal(cleared.presentation.status, 'idle');
  assert.equal(cleared.presentation.error, null);
  assert.deepEqual(cleared.presentation.patch, failed.presentation.patch);

  assert.equal(machine.reducer(cleared, { type: 'TEMPLATE_REVISE_CLEAR' }), cleared, '已 idle 时幂等');
});

test('SELECT_TEMPLATE：切换不同模板重置补丁与状态；重复选择同一模板不重置', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const applied = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });

  const same = machine.reducer(applied, { type: 'SELECT_TEMPLATE', id: 'warm-bistro' });
  assert.deepEqual(same.presentation.patch, FIRST_PATCH, '同模板重复选择不重置');
  assert.deepEqual(same.presentation.changes, THIRD_CHANGES);
  assert.equal(same.build.selectedId, 'warm-bistro');

  const switched = machine.reducer(applied, { type: 'SELECT_TEMPLATE', id: 'signature-kitchen' });
  assert.equal(switched.build.selectedId, 'signature-kitchen');
  assert.deepEqual(switched.presentation.patch, {}, '切换模板清空旧补丁');
  assert.deepEqual(switched.presentation.changes, []);
  assert.equal(switched.presentation.status, 'idle');
  assert.equal(switched.presentation.error, null);
  assert.equal(switched.presentation.templateId, 'signature-kitchen');
  assert.equal(switched.presentation.requestId, null, '切换模板丢弃挂起请求');
});

test('非法已接受补丁不写入 state：进入 failed 并保留上一版补丁', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const round1 = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });
  const undoBefore = machine.selectUndoState(round1).undoCount;

  const invalid = machine.reducer(requestRevise(machine, round1, 'req-2'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-2',
    templateId: 'warm-bistro',
    patch: { theme: { primaryColor: 'red' } },
    changes: THIRD_CHANGES,
  });

  assert.equal(invalid.presentation.status, 'failed');
  assert.equal(invalid.presentation.error.code, 'PATCH_THEME_COLOR_INVALID');
  assert.deepEqual(invalid.presentation.patch, FIRST_PATCH, '非法补丁不写入 state');
  assert.deepEqual(invalid.presentation.changes, THIRD_CHANGES, 'changes 也不写入');
  assert.equal(machine.selectUndoState(invalid).undoCount, undoBefore, '非法结果不压栈');
  assert.equal(invalid.store.name, '松鼠食堂', 'store 不被非法补丁改动');
});

test('signature-kitchen 允许轮播尺寸与 slotOrder；无轮播的模板拒绝 carousel', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const switched = machine.reducer(state, { type: 'SELECT_TEMPLATE', id: 'signature-kitchen' });

  const ok = machine.reducer(requestRevise(machine, switched, 'req-s1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-s1',
    templateId: 'signature-kitchen',
    patch: {
      sizes: { carousel: 'lg' },
      slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
    },
  });
  assert.equal(ok.presentation.status, 'idle');
  assert.equal(ok.presentation.patch.sizes.carousel, 'lg');
  assert.equal(ok.presentation.patch.slotOrder[0].slotId, 'menu-hero');

  const rejected = machine.reducer(requestRevise(machine, state, 'req-s2'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-s2',
    templateId: 'warm-bistro',
    patch: { sizes: { carousel: 'lg' } },
  });
  assert.equal(rejected.presentation.status, 'failed');
  assert.equal(rejected.presentation.error.code, 'PATCH_SIZE_UNSUPPORTED');
});

test('selectPresentationState：返回 2.2.3 定义字段，canRevise 跟随阶段与候选就绪', async () => {
  const { machine, state } = await atTemplatePick();
  const initial = machine.selectPresentationState(state);
  assert.deepEqual(initial, {
    canRevise: true,
    patch: {},
    changes: [],
    status: 'idle',
    error: null,
  });

  const { PHASES } = await import('../src/state/constants.mjs');
  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });
  assert.equal(machine.selectPresentationState(features).canRevise, false);

  const building = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '换个大图的' });
  assert.equal(machine.selectPresentationState(building).canRevise, false, 'build 未就绪时不可修改');

  const failed = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_FAILURE',
    requestId: 'req-1',
    error: { code: 'AGENT_FAILED', message: '网络中断' },
  });
  const failedView = machine.selectPresentationState(failed);
  assert.equal(failedView.status, 'failed');
  assert.deepEqual(failedView.error, { code: 'AGENT_FAILED', message: '网络中断' });
});
test('SET_STYLE：清除 patch.theme，保留 sizes/slotOrder/copy，并同步移除 theme.* 变更项', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const switched = machine.reducer(state, { type: 'SELECT_TEMPLATE', id: 'signature-kitchen' });
  const applied = machine.reducer(requestRevise(machine, switched, 'req-1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'signature-kitchen',
    patch: {
      theme: { primaryColor: '#C96049' },
      sizes: { homeHero: 'lg' },
      slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
      copy: { tagline: '每天现烤' },
    },
    changes: [
      { path: 'theme.primaryColor', label: '主色', before: null, after: '#C96049' },
      { path: 'sizes.homeHero', label: '首屏主视觉尺寸', before: 'md', after: 'lg' },
    ],
  });
  assert.ok(applied.presentation.patch.theme, '前置条件：补丁里有 theme');

  const restyled = machine.reducer(applied, { type: 'SET_STYLE', id: 'jade' });
  assert.equal(restyled.visual.styleId, 'jade');
  assert.equal(restyled.presentation.patch.theme, undefined, '换风格清除配色补丁');
  assert.deepEqual(restyled.presentation.patch.sizes, { homeHero: 'lg' });
  assert.deepEqual(restyled.presentation.patch.slotOrder, [
    { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' },
  ]);
  assert.deepEqual(restyled.presentation.patch.copy, { tagline: '每天现烤' });
  assert.deepEqual(
    restyled.presentation.changes.map((item) => item.path),
    ['sizes.homeHero'],
    'theme.* 变更项同步移除',
  );

  const plain = { ...state, visual: { ...state.visual, styleId: 'jade' } };
  assert.equal(
    machine.reducer(plain, { type: 'SET_STYLE', id: 'ink' }).presentation.patch,
    plain.presentation.patch,
    '没有 theme 补丁时保持原样',
  );
});

test('撤销回旧模板时 presentation 与 build.selectedId 同步恢复，不错配', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const warmApplied = machine.reducer(requestRevise(machine, state, 'req-w'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-w',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });
  const switched = machine.reducer(warmApplied, { type: 'SELECT_TEMPLATE', id: 'signature-kitchen' });
  const signatureApplied = machine.reducer(requestRevise(machine, switched, 'req-s'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-s',
    templateId: 'signature-kitchen',
    patch: { sizes: { carousel: 'lg' } },
    changes: [{ path: 'sizes.carousel', label: '轮播区尺寸', before: 'md', after: 'lg' }],
  });
  assert.equal(signatureApplied.presentation.templateId, 'signature-kitchen');
  assert.equal(signatureApplied.build.selectedId, 'signature-kitchen');

const backOnce = machine.reducer(signatureApplied, { type: 'UNDO_APPLY' });
  assert.equal(backOnce.build.selectedId, 'signature-kitchen');
  assert.equal(backOnce.presentation.templateId, 'signature-kitchen', '展示切片与当前模板同步');
  assert.deepEqual(backOnce.presentation.patch, {}, '撤销到 signature 补丁应用前');
  assert.equal(backOnce.presentation.status, 'idle');

  const backTwice = machine.reducer(backOnce, { type: 'UNDO_APPLY' });
  assert.equal(backTwice.build.selectedId, 'warm-bistro', '再撤销一次回到旧模板');
  assert.equal(backTwice.presentation.templateId, 'warm-bistro', '展示切片跟随旧模板');
  assert.deepEqual(backTwice.presentation.patch, {});
  assert.equal(backTwice.presentation.status, 'idle');

  // 重做回到 warm-bistro 的已接受补丁时，模板与补丁必须同时回到 warm-bistro。
  const redoWarm = machine.reducer(machine.reducer(backTwice, { type: 'REDO_APPLY' }), { type: 'REDO_APPLY' });
  assert.equal(redoWarm.build.selectedId, 'signature-kitchen');
  assert.equal(redoWarm.presentation.templateId, 'signature-kitchen');
  assert.deepEqual(redoWarm.presentation.patch, { sizes: { carousel: 'lg' } });
});

test('撤销快照与当前模板错配时丢弃旧补丁（防「补丁属于 A、模板是 B」）', async () => {
  const { machine, state } = await atTemplatePickWithDraft();
  const applied = machine.reducer(requestRevise(machine, state, 'req-1'), {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    templateId: 'warm-bistro',
    patch: FIRST_PATCH,
    changes: THIRD_CHANGES,
  });

  // 手工构造一份错配快照：selectedId 是 warm-bistro，但补丁标着 signature-kitchen。
  const tampered = {
    ...applied,
    undo: {
      past: [{
        store: applied.store,
        features: applied.features,
        build: { selectedId: 'warm-bistro' },
        visual: applied.visual,
        agentDraft: applied.agentDraft,
        presentation: { ...applied.presentation, templateId: 'signature-kitchen' },
        appid: '',
      }],
      future: [],
      lastKey: null,
    },
  };

  const restored = machine.reducer(tampered, { type: 'UNDO_APPLY' });
  assert.equal(restored.build.selectedId, 'warm-bistro');
  assert.equal(restored.presentation.templateId, 'warm-bistro');
  assert.deepEqual(restored.presentation.patch, {}, '不属于当前模板的补丁必须丢弃');
  assert.deepEqual(restored.presentation.changes, []);
  assert.equal(restored.presentation.status, 'idle');
});
