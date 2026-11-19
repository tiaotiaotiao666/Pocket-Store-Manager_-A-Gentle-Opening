'use strict';

/**
 * B3 行为回归：用户试用反馈的三件事。
 *
 * 1) 菜品数量：只要求「至少 1 道」，1/2/5/6/8 道都能保存并继续，绝不静默截断；
 * 2) 营业时间：时段选择器语义（跨零点、开始=结束、重叠、段数上限）前后端同一口径；
 * 3) 模板修改：一个输入框 + 两种模式，提交后原话/状态/前后对比就地可见，
 *    失败保留原文可重试、不追加重复消息、不污染预览，采用后可撤销。
 *
 * 这是**代码级回归**，不代表真机走查已通过（真机走查单独记录）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const CANDIDATES = [
  { id: 'warm-bistro', name: '街巷食集', layout: 'menu', score: 100, summary: '菜单优先' },
  { id: 'modern-coffee', name: '一杯日常', layout: 'catalog', score: 91, summary: '高效选购' },
  { id: 'signature-kitchen', name: '主厨推荐', layout: 'editorial', score: 82, summary: '大幅主图' },
];

function dish(id, name, priceText) {
  return { id, name, priceText, description: '' };
}

const BASE = {
  storeName: '松月食堂',
  category: '社区餐馆',
  businessHours: '10:00-21:00',
  fulfillment: { dineIn: true, takeaway: false },
};

// ---------------------------------------------------------------- 菜品数量

test('B3-1 菜品数量：0 道给缺项提示，1/2/5/6/8 道都合法，9 道明确拒绝', async () => {
  const { validateAgentDraft, normalizeAgentDraft } = await import('../src/domain/agentDraft.mjs');
  const { MIN_DISHES, MAX_DISHES, describeDishRequirement } = await import('../src/domain/storeLimits.mjs');

  assert.equal(MIN_DISHES, 1, '不再强制 3 道起');
  assert.equal(MAX_DISHES, 8);
  assert.match(describeDishRequirement(), /1/);

  const zero = validateAgentDraft(normalizeAgentDraft({ ...BASE, dishes: [] }));
  const zeroDish = zero.missingFields.find((item) => item.field === 'dishes');
  assert.ok(zeroDish, '0 道仍算缺项');
  assert.match(zeroDish.detail, /还没有菜品/, '提示要直白说明先加 1 道菜');

  for (const count of [1, 2, 5, 6, 8]) {
    const dishes = Array.from({ length: count }, (_, index) => dish(`d${index}`, `菜${index}`, '18'));
    const draft = normalizeAgentDraft({ ...BASE, dishes });
    const result = validateAgentDraft(draft);
    assert.ok(
      !result.missingFields.some((item) => item.field === 'dishes'),
      `${count} 道不应再要求补菜`,
    );
    assert.equal(result.errors.length, 0, `${count} 道不应报错`);
    assert.equal(draft.dishes.length, count, `${count} 道必须全部保留`);
  }

  const nine = Array.from({ length: 9 }, (_, index) => dish(`d${index}`, `菜${index}`, '18'));
  const tooMany = validateAgentDraft(normalizeAgentDraft({ ...BASE, dishes: nine }));
  assert.ok(
    tooMany.errors.some((item) => item.code === 'DISHES_TOO_MANY'),
    '超过上限要明确拒绝，而不是静默截断',
  );
});

test('B3-1 项目快照不截断菜品：6 道写进去，重开还是 6 道', async () => {
  const snapshot = await import('../src/domain/projectSnapshot.mjs');
  const { normalizeAgentDraft } = await import('../src/domain/agentDraft.mjs');

  const dishes = Array.from({ length: 6 }, (_, index) => dish(`d${index}`, `菜${index}`, String(10 + index)));
  const draft = normalizeAgentDraft({ ...BASE, dishes });

  const doc = snapshot.toDocument(
    { agentDraft: draft, store: { name: '松月食堂' }, project: { activeId: 'p1' } },
    { projectId: 'p1' },
  );
  const restored = snapshot.fromDocument(doc);
  assert.equal(restored.agentDraft.dishes.length, 6, '6 道菜不能被截断');
});

// ---------------------------------------------------------------- 营业时间

test('B3-2 营业时间：跨零点/午饭分段/开始=结束/重叠/段数上限口径一致', async () => {
  const hours = await import('../src/domain/businessHours.mjs');
  const codesOf = (text) => hours.validateHoursSegments(hours.parseHoursText(text)).map((item) => item.code);

  // 22:00-02:00 表示营业到「次日」，一段即可，不要求用户手工拆成两段。
  const night = hours.parseHoursText('22:00-02:00');
  assert.equal(night.length, 1);
  assert.equal(hours.segmentTimeline(night[0]).crossesMidnight, true);
  assert.equal(hours.describeHoursSegment(night[0]), '22:00–次日 02:00');

  // 午饭分段：两段并存且都合法。
  const split = hours.parseHoursText('10:00-14:00,17:00-21:00');
  assert.equal(split.length, 2);
  assert.deepEqual(codesOf('10:00-14:00,17:00-21:00'), []);

  // 开始时间 = 结束时间 → 明确报错（不是「营业 0 分钟」）。
  assert.deepEqual(codesOf('10:00-10:00'), ['HOURS_SAME_TIME']);

  // 相邻端点不算重叠；真重叠（含跨零点段）要报。
  assert.deepEqual(codesOf('10:00-14:00,14:00-21:00'), []);
  assert.ok(codesOf('22:00-02:00,01:00-03:00').includes('HOURS_OVERLAP'), '跨零点段与凌晨段重叠必须拦住');

  // 段数上限。
  assert.ok(
    codesOf('08:00-09:00,10:00-11:00,12:00-13:00,14:00-15:00').includes('HOURS_TOO_MANY'),
    '最多 3 段',
  );

  // 单一数据链：格式化回字符串再解析，语义不变。
  const roundTrip = hours.parseHoursText(hours.formatHoursText(split));
  assert.deepEqual(roundTrip.map((item) => item.start), ['10:00', '17:00']);
  assert.deepEqual(roundTrip.map((item) => item.end), ['14:00', '21:00']);
  assert.deepEqual(roundTrip.map((item) => hours.toMinutes(item.start)), [600, 1020]);
});

test('B3-2 营业时间：编辑器是时间选择器 + 分段增删，且走同一条 businessHours 数据链', () => {
  const editor = read('src/components/agent/DraftEditor.jsx');
  assert.match(editor, /type="time"/, '主入口必须是时间选择器，不是自由文本');
  assert.match(editor, /增加时段/);
  assert.match(editor, /删除第 \$\{index \+ 1\} 个营业时段/, '每个时段可删除');
  assert.match(editor, /次日/, '跨零点要标「次日」');
  assert.match(editor, /onChangeField\?\.\('businessHours'/, '所有编辑都写回同一个 businessHours');
  assert.doesNotMatch(editor, /minDishes\s*=\s*3/, '不再有 3 道起的默认约束');
});

test('B3-2 旧项目仍能打开：老格式营业时间按同一语义解析', async () => {
  const hours = await import('../src/domain/businessHours.mjs');
  for (const legacy of ['10:00-21:00', '10:00 - 21:00', '10:00—21:00', '10:00~21:00']) {
    const parsed = hours.parseHoursText(legacy);
    assert.equal(parsed.length, 1, `${legacy} 应能解析`);
    assert.deepEqual(
      hours.validateHoursSegments(parsed).map((item) => item.code),
      [],
      `${legacy} 应合法`,
    );
  }
});

// ---------------------------------------------------------------- 模板修改

test('B3-3 只有一个主输入框：候选区不再有第二/第三个输入框', () => {
  const gallery = read('src/components/flow/TemplateGallery.jsx');
  assert.doesNotMatch(gallery, /template-refine-input/, '旧的「重新描述候选」独立输入框必须删掉');
  assert.doesNotMatch(gallery, /onRefineChange/, '子组件不再自己维护第二份输入状态');

  const panel = read('src/components/flow/TemplateRevisePanel.jsx');
  const inputs = panel.match(/<input[\s\S]*?aria-label=/g) ?? [];
  assert.equal(inputs.length, 1, '面板里只能有一个输入框');
  assert.match(panel, /修改当前页面/);
  assert.match(panel, /重新匹配候选/);
  assert.match(panel, /aria-pressed=/, '两种模式必须是可识别的开关，而不是同义输入框');

  const app = read('src/App.jsx');
  assert.match(
    app,
    /phase === PHASES\.TEMPLATE_PICK \|\| phase === PHASES\.IMAGE_REVIEW/,
    '模板页不再复用全局 Composer（避免第三个重复入口）',
  );
});

test('B3-3 提交后原话常驻输入框旁边，处理中/失败都有就地反馈', () => {
  const panel = read('src/components/flow/TemplateRevisePanel.jsx');
  assert.match(panel, /你刚才要求/);
  assert.match(panel, /lastRequest/, '提交即记下原话，不用回翻历史');
  assert.match(panel, /正在按你的描述/);
  assert.match(panel, /这次没有成功/, '失败要说明原因且保留原文');
  assert.match(panel, /describeValue\(item\?\.before\)/);
  assert.match(panel, /describeValue\(item\?\.after\)/);
  assert.match(panel, /撤销这次修改/, '采用后的修改可撤销');

  const machine = read('src/state/sessionMachine.mjs');
  assert.match(machine, /lastUtterance: typeof presentation\.lastUtterance/, '选择器要暴露原话给面板');
});

test('B3-3 失败不追加重复消息、不改预览；连按回车只发一次', async () => {
  const machine = await import('../src/state/sessionMachine.mjs');
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: CANDIDATES });

  const once = machine.reducer(state, {
    type: 'TEMPLATE_REVISE_REQUEST',
    utterance: '主色换成暖橙',
    requestId: 'req-1',
  });
  assert.equal(once.presentation.status, 'revising');

  const twice = machine.reducer(once, {
    type: 'TEMPLATE_REVISE_REQUEST',
    utterance: '主色换成暖橙',
    requestId: 'req-2',
  });
  assert.equal(twice, once, '请求在飞时第二次提交是 no-op');

  const messageCount = once.sessions.find((item) => item.id === once.activeSessionId).messages.length;

  const failed = machine.reducer(once, {
    type: 'TEMPLATE_REVISE_FAILURE',
    requestId: 'req-1',
    error: { code: 'TEMPLATE_REVISE_FAILED', message: '模型暂时没返回' },
  });
  assert.equal(failed.presentation.status, 'failed');
  assert.equal(failed.presentation.error.message, '模型暂时没返回');
  assert.deepEqual(failed.presentation.patch, {}, '失败不改当前预览（补丁仍是旧的）');
  const failedMessages = failed.sessions.find((item) => item.id === failed.activeSessionId).messages;
  assert.equal(failedMessages.length, messageCount, '失败不得再追加一条重复的用户消息');
});

test('B3-3 采用后可撤销：补丁、店名与菜品文案一起回滚', async () => {
  const machine = await import('../src/state/sessionMachine.mjs');
  const { normalizeAgentDraft } = await import('../src/domain/agentDraft.mjs');
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: CANDIDATES });
  state = {
    ...state,
    agentDraft: normalizeAgentDraft({ ...BASE, dishes: [dish('d1', '招牌牛肉面', '28')] }),
    store: { ...state.store, name: '松月食堂' },
  };

  const requested = machine.reducer(state, {
    type: 'TEMPLATE_REVISE_REQUEST',
    utterance: '店名改成松鼠食堂',
    requestId: 'req-1',
  });
  const applied = machine.reducer(requested, {
    type: 'TEMPLATE_REVISE_SUCCESS',
    requestId: 'req-1',
    patch: { theme: { primaryColor: '#C96049' }, copy: { storeName: '松鼠食堂' } },
  });
  assert.equal(applied.presentation.status, 'idle');
  assert.equal(applied.store.name, '松鼠食堂');
  assert.ok(applied.presentation.changes.length > 0, '要有可读的前后对比');

  const undone = machine.reducer(applied, { type: 'UNDO_APPLY' });
  assert.deepEqual(undone.presentation.patch, {}, '撤销回到修改前');
  assert.equal(undone.store.name, '松月食堂');
  assert.deepEqual(undone.presentation.changes, [], '撤销后不再显示本轮变更清单');
});

// ---------------------------------------------------------------- 诚实状态

test('B3-4 不再有裸百分比，降级标签只限定这次候选推荐', () => {
  const gallery = read('src/components/flow/TemplateGallery.jsx');
  assert.doesNotMatch(gallery, /\{Math\.round\(item\.score\)\}%/, '候选卡不再展示裸百分比');
  assert.doesNotMatch(gallery, /\{Math\.round\(selected\.score\)\}%/, '详情区不再展示裸百分比');

  const compare = read('src/components/flow/TemplateCompare.jsx');
  assert.doesNotMatch(compare, /\{meta\.score\}%/, '对比条不再展示裸百分比');

  const candidatePanel = read('src/components/screenRef/FrontendCandidatePanel.jsx');
  assert.doesNotMatch(candidatePanel, /confidence\}%/, '识别把握不再用裸百分比');

  const service = read('src/services/agentService.js');
  assert.match(service, /本地规则（候选推荐未用模型）/, '降级只说这次候选推荐没用模型');
  assert.doesNotMatch(service, /本地规则（模型不可用）/, '不得声称整个资料助手不可用');
});

test('B3-4 海报步骤只说「上传或跳过」，不再承诺打磨提示词/开始生成', () => {
  const studio = read('src/components/build/PromptStudio.jsx');
  assert.doesNotMatch(studio, /开始生成/, '不再承诺开始生成图片');
  assert.doesNotMatch(studio, /生图提示词/, '不再以「生图提示词」命名这一步');
  assert.match(studio, /不生成图片/);
  assert.match(studio, /海报素材（可选）/);
  assert.match(studio, /跳过/);
});
