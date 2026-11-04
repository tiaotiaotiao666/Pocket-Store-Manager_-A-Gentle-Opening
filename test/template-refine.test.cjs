'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadConstants() {
  return import('../src/state/constants.mjs');
}

async function loadCatalog() {
  return import('../src/domain/catalog.mjs');
}

async function loadAgentService() {
  return import('../src/services/agentService.js');
}

const SAMPLE_CANDIDATES = [
  { id: 'warm-bistro', name: '街巷食集', layout: 'menu', score: 100, summary: '菜单优先' },
  { id: 'modern-coffee', name: '一杯日常', layout: 'catalog', score: 91, summary: '高效选购' },
  { id: 'signature-kitchen', name: '主厨推荐', layout: 'editorial', score: 82, summary: '大幅主图' },
];

/** 走到 TEMPLATE_PICK，作为「模板页重新描述」的起点。 */
async function atTemplatePick() {
  const machine = await loadMachine();
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: SAMPLE_CANDIDATES });
  return { machine, state };
}

test('模板页提交自然语言描述：留在模板页、进入 building、消息进入当前会话', async () => {
  const { PHASES } = await loadConstants();
  const { machine, state } = await atTemplatePick();
  const next = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '想要大图和招牌菜' });

  assert.equal(next.phase, PHASES.TEMPLATE_PICK);
  assert.equal(next.build.status, 'building');
  assert.deepEqual(next.build.feedback, ['想要大图和招牌菜']);
  // 候选不清空：重建期间用户仍能看到上一版，不会闪成空白
  assert.deepEqual(next.build.candidates, SAMPLE_CANDIDATES);
  assert.equal(next.build.selectedId, 'warm-bistro');

  const session = next.sessions.find((item) => item.id === next.activeSessionId);
  const texts = session.messages.map((message) => message.text);
  assert.ok(texts.includes('想要大图和招牌菜'), '用户描述应进入会话消息流');
  assert.ok(
    session.messages.some((message) => message.role === 'agent' && message.meta?.kind === 'template-refine'),
    '应有一条 agent 的重新匹配回复',
  );
});

test('空描述与超长描述的处理：空的不生效，长的截断到上限', async () => {
  const machine = await loadMachine();
  const { TEMPLATE_REFINE } = await import('../src/domain/onboardingScript.mjs');
  const { state } = await atTemplatePick();

  const ignored = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '   ' });
  assert.equal(ignored, state, '空描述不应产生任何状态变化');

  const long = '想'.repeat(TEMPLATE_REFINE.maxLength + 40);
  const trimmed = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: long });
  assert.equal(trimmed.build.feedback[0].length, TEMPLATE_REFINE.maxLength);
});

test('building 期间重复提交被忽略，非模板阶段不接受该动作', async () => {
  const { machine, state } = await atTemplatePick();
  const building = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '第一句' });
  const again = machine.reducer(building, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '第二句' });
  assert.equal(again, building, 'rematch 未完成时不应叠加第二次请求');

  const { PHASES } = await loadConstants();
  const features = machine.reducer(state, { type: 'PHASE_GOTO', phase: PHASES.FEATURES });
  const rejected = machine.reducer(features, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '在功能页写描述' });
  assert.equal(rejected, features, '只有模板页才处理重新描述');
});

test('重新匹配完成：原地替换候选并选中第一个，describe 累积保留最近 8 条', async () => {
  const { machine, state } = await atTemplatePick();
  let next = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '想要门店故事' });
  next = machine.reducer(next, { type: 'TEMPLATE_REBUILD_READY', candidates: SAMPLE_CANDIDATES });
  assert.equal(next.build.status, 'ready');
  assert.equal(next.build.selectedId, 'warm-bistro');
  assert.equal(next.build.refineError, null);

  let many = next;
  for (let index = 1; index <= 10; index += 1) {
    many = machine.reducer(many, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: `第 ${index} 次补充` });
    many = machine.reducer(many, { type: 'TEMPLATE_REBUILD_READY', candidates: SAMPLE_CANDIDATES });
  }
  assert.equal(many.build.feedback.length, 8);
  assert.equal(many.build.feedback[many.build.feedback.length - 1], '第 10 次补充');
});

test('重新匹配失败：保留旧候选、记录错误并追问用户重试', async () => {
  const { machine, state } = await atTemplatePick();
  let next = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '想要大图' });
  next = machine.reducer(next, {
    type: 'TEMPLATE_REBUILD_FAILED',
    error: { code: 'TEMPLATE_REBUILD_FAILED', message: '网络中断' },
  });
  assert.equal(next.build.status, 'ready');
  assert.deepEqual(next.build.candidates, SAMPLE_CANDIDATES);
  assert.equal(next.build.refineError.message, '网络中断');
  const session = next.sessions.find((item) => item.id === next.activeSessionId);
  assert.ok(session.messages.some((message) => message.meta?.kind === 'template-refine-failed'));
});

test('空候选视为失败态而不是把模板页搞成空列表', async () => {
  const { machine, state } = await atTemplatePick();
  let next = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '随便' });
  next = machine.reducer(next, { type: 'TEMPLATE_REBUILD_READY', candidates: [] });
  assert.equal(next.build.status, 'ready');
  assert.deepEqual(next.build.candidates, SAMPLE_CANDIDATES);
  assert.equal(next.build.refineError.code, 'TEMPLATE_REBUILD_EMPTY');
});

test('关键词排序：能识别风格词，识别不到时如实返回 recognized=false', async () => {
  const { rankTemplatesByBrief } = await loadCatalog();

  const signature = rankTemplatesByBrief('想要大图招牌菜和门店故事，突出主厨');
  assert.equal(signature.recognized, true);
  assert.equal(signature.order[0], 'signature-kitchen');
  assert.ok(signature.topKeywords.includes('招牌菜'));

  const coffee = rankTemplatesByBrief('做咖啡和奶茶，希望清单简洁');
  assert.equal(coffee.recognized, true);
  assert.equal(coffee.order[0], 'modern-coffee');

  const meaningless = rankTemplatesByBrief('我想随便看看');
  assert.equal(meaningless.recognized, false);
  assert.deepEqual(meaningless.order, ['warm-bistro', 'modern-coffee', 'signature-kitchen']);
  assert.equal(meaningless.hits['warm-bistro'], 0);
});

test('候选生成：描述会改变置顶模板，并在 note 里写清命中了哪些词', async () => {
  const { buildTemplateCandidates } = await loadAgentService();
  const features = ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'];

  const plain = await buildTemplateCandidates({ selectedFeatures: features, delayMs: 0 });
  assert.equal(plain[0].source, '功能匹配');
  assert.equal(plain[0].customized, false);

  const refined = await buildTemplateCandidates({
    selectedFeatures: features,
    customPrompt: '想要大幅招牌菜图片和门店故事',
    delayMs: 0,
  });
  assert.equal(refined[0].id, 'signature-kitchen', '描述命中多的模板应置顶');
  assert.equal(refined[0].source, '按你的描述匹配');
  assert.equal(refined[0].customized, true);
  assert.ok(refined[0].briefHits > 0);
  assert.match(refined[0].note, /已按/);
  assert.match(refined[0].note, /招牌/);

  const unmatched = await buildTemplateCandidates({
    selectedFeatures: features,
    customPrompt: '我也不知道要什么',
    delayMs: 0,
  });
  assert.match(unmatched[0].note, /没有可识别的风格词/);
});

test('重新描述累积到项目快照：project.json 能保住 feedback，避免重开项目后失忆', async () => {
  const { fromDocument, toDocument } = await import('../src/domain/projectSnapshot.mjs');
  const { machine, state } = await atTemplatePick();
  const next = machine.reducer(state, { type: 'SUBMIT_TEMPLATE_FEEDBACK', value: '想要大图招牌菜' });

  const doc = toDocument(
    { ...next, build: { ...next.build, status: 'ready' } },
    { projectId: 'p_test', createdAt: '2026-11-03T04:00:00Z', appid: '' },
  );
  assert.deepEqual(doc.build.feedback, ['想要大图招牌菜']);

  const hydrated = fromDocument(doc);
  assert.deepEqual(hydrated.build.feedback, ['想要大图招牌菜']);
});