const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadProcess() {
  return import('../src/domain/agentRunProcess.mjs');
}

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadRunService() {
  return import('../src/services/agentTurn/agentRunService.js');
}

/** 取自 W2 真实 smoke 的 trace 形状（deepseek-v4.1-flash，两工具各一次且成功）。 */
function realTrace(overrides = {}) {
  return {
    modelCalls: 3,
    toolCalls: [
      { callId: 'call_00_NVYGcaS5oMuOGUJT07403719', name: 'get_store_draft', ok: true, errorCode: null, latencyMs: 0, attempts: 1, truncated: false },
      { callId: 'call_00_CgKSqkshms7XmogDED5g4853', name: 'update_store_draft', ok: true, errorCode: null, latencyMs: 1, attempts: 1, truncated: false },
    ],
    stopReason: 'final_answer',
    degraded: false,
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    storeName: '松月食堂',
    category: '面馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { id: 'dish-1', name: '牛肉面', priceCents: 2800, priceText: '28.00', description: '' },
    ],
    ...overrides,
  };
}

test('P1 工具名翻译：只输出人话标签，未知工具折叠为辅助步骤', async () => {
  const { translateToolName, TOOL_STEP_LABELS } = await loadProcess();
  assert.equal(translateToolName('get_store_draft'), '读取门店资料');
  assert.equal(translateToolName('update_store_draft'), '更新门店资料');
  assert.deepEqual(TOOL_STEP_LABELS, {
    get_store_draft: '读取门店资料',
    update_store_draft: '更新门店资料',
  });
  assert.equal(translateToolName('run_sql'), '辅助步骤');
  assert.equal(translateToolName(''), '辅助步骤');
  assert.equal(translateToolName(undefined), '辅助步骤');
});

test('P2 步骤只来自真实 trace：真实两工具 → 四步齐全且全绿', async () => {
  const { buildProcessSteps } = await loadProcess();
  const steps = buildProcessSteps({ trace: realTrace() });

  assert.deepEqual(steps.map((step) => step.label), ['理解需求', '读取门店资料', '更新门店资料', '校验信息']);
  assert.deepEqual(steps.map((step) => step.state), ['done', 'done', 'done', 'done']);
  assert.equal(steps[0].detail, '调用模型 3 次');

  // 模型没有调用读取工具：不得凭空补「读取门店资料」这一步。
  const updateOnly = buildProcessSteps({
    trace: realTrace({ toolCalls: [realTrace().toolCalls[1]] }),
  });
  assert.deepEqual(updateOnly.map((step) => step.label), ['理解需求', '更新门店资料', '校验信息']);

  // 完全没有工具调用：只有理解 + 校验，且不能宣称调用过工具。
  const noTools = buildProcessSteps({ trace: realTrace({ toolCalls: [] }) });
  assert.deepEqual(noTools.map((step) => step.id), ['understand', 'validate']);
});

test('P3 处理中只有一步在进行，没有假进度', async () => {
  const { buildProcessSteps, buildProcessView } = await loadProcess();
  const steps = buildProcessSteps({ status: 'requesting' });
  assert.equal(steps.length, 1, '请求中不得预先点亮后续步骤');
  assert.equal(steps[0].id, 'understand');
  assert.equal(steps[0].state, 'active');

  const view = buildProcessView({ status: 'requesting' });
  assert.equal(view.tone, 'running');
  assert.equal(view.title, '处理中');
  assert.equal(view.steps.filter((step) => step.state === 'done').length, 0);
  assert.equal(view.retryable, false);
});

test('P4 降级不得显示全绿成功，工具失败不能说资料完整', async () => {
  const { buildProcessView } = await loadProcess();
  const failedTrace = realTrace({
    toolCalls: [
      { callId: 'c1', name: 'get_store_draft', ok: true, latencyMs: 1, attempts: 1, truncated: false },
      { callId: 'c2', name: 'update_store_draft', ok: false, errorCode: 'TOOL_TIMEOUT', latencyMs: 12000, attempts: 2, truncated: false },
    ],
    stopReason: 'time_limit',
    degraded: true,
  });

  const view = buildProcessView({
    trace: failedTrace,
    degradation: { degraded: true, stopReason: 'time_limit', failedTools: ['update_store_draft'], toolCallCount: 2 },
  });

  assert.equal(view.tone, 'partial');
  assert.equal(view.title, '部分完成');
  assert.notEqual(view.title, '完成');
  const updateStep = view.steps.find((step) => step.id === 'update');
  assert.equal(updateStep.state, 'failed');
  assert.equal(updateStep.label, '更新门店资料');
  assert.match(updateStep.detail, /未成功/);
  const validateStep = view.steps.find((step) => step.id === 'validate');
  assert.equal(validateStep.state, 'partial');
  assert.match(view.headline, /未成功/);
  assert.match(view.headline, /时间上限/);
  assert.match(view.notice, /可能还不完整/);
  assert.equal(view.tools.failed, 1);
  assert.equal(view.tools.ok, 1);

  // 即使 trace.degraded 漏报，只要有失败调用也必须降级。
  const silentDegrade = buildProcessView({ trace: realTrace({ degraded: false, toolCalls: [
    { callId: 'c3', name: 'update_store_draft', ok: false, attempts: 1, truncated: false },
  ] }) });
  assert.equal(silentDegrade.tone, 'partial');
});

test('P5 四种状态：处理中 / 部分完成 / 完成 / 失败可重试', async () => {
  const { buildProcessView } = await loadProcess();

  const running = buildProcessView({ status: 'requesting' });
  const partial = buildProcessView({ trace: realTrace({ degraded: true, toolCalls: [
    { callId: 'c1', name: 'update_store_draft', ok: false, attempts: 1, truncated: false },
  ] }) });
  const done = buildProcessView({ trace: realTrace(), runId: 'run_ok' });
  const failedRetryable = buildProcessView({
    status: 'failed',
    lastError: { code: 'AGENT_TIMEOUT', message: '请求超时，请重试。', retryable: true },
  });
  const failedFatal = buildProcessView({
    status: 'failed',
    lastError: { code: 'AGENT_HTTP_4XX', message: '登录状态已失效，请重新登录后再试。', retryable: false },
  });

  assert.deepEqual(
    [running.tone, partial.tone, done.tone, failedRetryable.tone, failedFatal.tone],
    ['running', 'partial', 'done', 'failed', 'failed'],
  );
  assert.deepEqual(
    [running.title, partial.title, done.title, failedRetryable.title, failedFatal.title],
    ['处理中', '部分完成', '完成', '失败', '失败'],
  );
  assert.equal(done.headline, '本轮共 2 次工具调用，全部成功。');
  assert.equal(done.roundId, 'run_ok');
  assert.equal(failedRetryable.retryable, true);
  assert.equal(failedFatal.retryable, false, '401/403 不给重试按钮');
  assert.equal(failedRetryable.notice, '这一轮没有改动你的草稿。');
  assert.deepEqual(failedRetryable.steps.map((step) => step.state), ['failed']);

  // 失败时不得残留「已完成」的假象
  assert.ok(!failedRetryable.steps.some((step) => step.state === 'done'));
});

test('P6 视图里不出现原始 JSON、工具参数、工具结果、堆栈或密钥', async () => {
  const { buildProcessView } = await loadProcess();
  const view = buildProcessView({
    trace: realTrace({
      toolCalls: [
        { callId: 'call_abc', name: 'update_store_draft', ok: false, attempts: 2, truncated: true, errorCode: 'TOOL_FAILED' },
        { callId: 'call_def', name: 'get_store_draft', ok: true, attempts: 1, truncated: false },
      ],
      degraded: true,
    }),
    degradation: { degraded: true, stopReason: 'max_tool_calls', failedTools: ['update_store_draft'], toolCallCount: 2 },
    changeSummary: ['新增菜品：凉皮'],
    runId: 'run_1',
  });
  const serialized = JSON.stringify(view);

  for (const forbidden of ['update_store_draft', 'get_store_draft', 'call_abc', 'arguments', 'toolCalls', 'toolResults', 'stack', 'apiKey', 'Authorization']) {
    assert.ok(!serialized.includes(forbidden), `过程卡视图不得包含 ${forbidden}`);
  }
  // 未知工具只显示「辅助步骤」，失败调用带具体工具名时也不能把真名抛给用户。
  const unknownView = buildProcessView({ trace: realTrace({ toolCalls: [
    { callId: 'c1', name: 'internal_debug_tool', ok: true, attempts: 1, truncated: false },
  ] }) });
  assert.ok(!JSON.stringify(unknownView).includes('internal_debug_tool'));
});

test('P7 本轮修改摘要：新增 / 改价 / 改名 / 补时间，超限折叠成计数', async () => {
  const { summarizeDraftChanges } = await loadProcess();

  const before = {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [{ id: 'dish-1', name: '牛肉面', priceCents: 2800, priceText: '28.00', description: '' }],
  };
  const after = {
    storeName: '松月食堂',
    category: '面馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { id: 'dish-1', name: '牛肉面（大碗）', priceCents: 3000, priceText: '30.00', description: '' },
      { id: 'dish-2', name: '凉皮', priceCents: 1200, priceText: '12.00', description: '' },
    ],
  };

  const changes = summarizeDraftChanges(before, after);
  assert.ok(changes.some((item) => /店名/.test(item)), '应说明补了店名');
  assert.ok(changes.some((item) => /品类/.test(item)));
  assert.ok(changes.some((item) => /营业时间/.test(item)));
  assert.ok(changes.some((item) => /取餐方式/.test(item)));
  assert.ok(changes.some((item) => /30\.00 元/.test(item)), '改价要显示金额');
  assert.ok(changes.some((item) => /改名/.test(item)), '改名要说明');
  assert.ok(changes.some((item) => /新增菜品：凉皮/.test(item)));

  // 未变化不产生噪音
  assert.deepEqual(summarizeDraftChanges(after, after), []);

  // 超限折叠
  const many = summarizeDraftChanges(
    { dishes: [] },
    { dishes: Array.from({ length: 12 }, (_, index) => ({ id: `d-${index}`, name: `菜${index}`, priceCents: 100 })) },
  );
  assert.equal(many.length, 9);
  assert.equal(many.at(-1), '另有 4 项调整');
});

test('P8 历史轮次只留摘要，默认折叠且有条数上限', async () => {
  const { compactProcessRound, PROCESS_HISTORY_LIMIT } = await loadProcess();
  assert.equal(PROCESS_HISTORY_LIMIT, 3);

  const view = {
    tone: 'done',
    title: '完成',
    headline: '本轮共 2 次工具调用，全部成功。',
    steps: [
      { id: 'understand', label: '理解需求', state: 'done', detail: '' },
      { id: 'read', label: '读取门店资料', state: 'done', detail: '' },
      { id: 'validate', label: '校验信息', state: 'done', detail: '' },
    ],
    summary: ['新增菜品：凉皮'],
    degraded: false,
    stopReason: 'final_answer',
    roundId: 'run_1',
  };
  const compact = compactProcessRound(view, '2026-11-16T04:00:00.000Z');
  assert.equal(compact.roundId, 'run_1');
  assert.equal(compact.changeCount, 1);
  assert.deepEqual(compact.doneStepLabels, ['理解需求', '读取门店资料', '校验信息']);
  assert.equal(compact.headline, view.headline);
  assert.equal(compact.steps, undefined, '历史摘要不保留逐步骤细节');

  // 没有 roundId 的空卡不进历史
  assert.equal(compactProcessRound({ tone: 'idle', title: '等待输入', steps: [] }), null);
});

test('P9 reducer 接入：主过程卡随请求切换，历史折叠，W2 门禁不变', async () => {
  const machine = await loadMachine();
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, {
    type: 'BUILD_READY',
    candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }],
  });
  state = machine.reducer(state, { type: 'CONFIRM_TEMPLATE' });
  assert.equal(state.agent.process, null, '初始不显示过程卡');

  const revision = state.agent.draftRevision;
  let s = machine.reducer(state, { type: 'AGENT_TURN_REQUEST', utterance: '开一家面馆', requestId: 'r-1', draftRevision: revision });
  assert.equal(s.agent.process.tone, 'running');
  assert.equal(s.agent.process.title, '处理中');
  assert.equal(s.agent.process.steps.length, 1);

  s = machine.reducer(s, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-1',
    draftRevision: revision,
    draft: draft(),
    reply: '整理好了',
    runId: 'run_1',
    trace: realTrace(),
    changeSummary: ['新增菜品：牛肉面'],
  });
  assert.equal(s.agent.process.tone, 'done');
  assert.equal(s.agent.process.roundId, 'run_1');
  assert.deepEqual(s.agent.process.summary, ['新增菜品：牛肉面']);
  assert.equal(s.agent.process.steps.length, 4);

  // 下一轮：上一轮压进历史，主卡只有一张
  s = machine.reducer(s, { type: 'AGENT_TURN_REQUEST', utterance: '再加一道凉皮', requestId: 'r-2', draftRevision: s.agent.draftRevision });
  assert.equal(s.agent.process.tone, 'running');
  assert.equal(s.agent.processHistory.length, 1);
  assert.equal(s.agent.processHistory[0].roundId, 'run_1');
  assert.equal(s.agent.processHistory[0].steps, undefined);

  // 失败：仍是一张卡，留下可重试状态
  s = machine.reducer(s, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'r-2',
    error: { code: 'AGENT_TIMEOUT', message: '请求超时，请重试。', retryable: true },
  });
  assert.equal(s.agent.process.tone, 'failed');
  assert.equal(s.agent.process.retryable, true);
  assert.equal(s.agent.processHistory.length, 1);
  assert.equal(s.agentDraft.dishes.length, 1, '失败不得改动草稿');

  // W2 门禁：手改后到达的回复保草稿，过程卡按真实 trace 呈现但不是「完成」
  let t = machine.reducer(s, { type: 'AGENT_TURN_RETRY', requestId: 'r-3', draftRevision: s.agent.draftRevision });
  t = machine.reducer(t, { type: 'EDIT_AGENT_DRAFT_FIELD', field: 'storeName', value: '我自己的店名' });
  t = machine.reducer(t, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-3',
    draftRevision: s.agent.draftRevision,
    draft: draft({ storeName: '服务端店名' }),
    reply: '迟到结果',
    runId: 'run_3',
    trace: realTrace(),
    changeSummary: ['补全了店名：服务端店名'],
  });
  assert.equal(t.agentDraft.storeName, '我自己的店名');
  assert.equal(t.agent.staleDraftNotice.code, 'AGENT_DRAFT_CHANGED');
  assert.deepEqual(t.agent.process.summary, [], '草稿没被应用，摘要必须为空');
  assert.equal(t.agent.process.roundId, 'run_3');
});

test('P10 服务层给出本轮修改摘要，且与合并结果一致', async () => {
  const runService = await loadRunService();
  const service = runService.createAgentRunService({
    transport: {
      name: 'agent-run',
      send: async () => ({
        contractVersion: 'agent-run.v1',
        runId: 'run_x',
        status: 'reviewing',
        reply: '已整理。',
        draft: draft({ dishes: [
          { id: 'dish-1', name: '牛肉面', priceCents: 3000 },
          { id: 'dish-9', name: '凉皮' },
        ] }),
        trace: realTrace(),
        meta: { transport: 'http', provider: 'deepseek', mock: false, runId: 'run_x' },
        degraded: false,
        failedTools: [],
        stopReason: 'final_answer',
        requestId: 'req-1',
      }),
    },
  });

  const result = await service.requestAgentRun({
    utterance: '牛肉面改成 30 元，再加一份凉皮',
    draft: draft({ businessHours: '' }),
  });

  assert.ok(Array.isArray(result.changeSummary));
  assert.ok(result.changeSummary.some((item) => /30\.00 元/.test(item)), '改价要体现在摘要里');
  assert.ok(result.changeSummary.some((item) => /新增菜品：凉皮/.test(item)), '新菜要体现在摘要里');
  assert.ok(result.changeSummary.some((item) => /营业时间/.test(item)), '补全的营业时间要体现');
  assert.equal(result.draft.dishes.length, 2);
  // 摘要只描述结果，不带工具名或原始字段名
  assert.ok(!result.changeSummary.join(' ').includes('store_draft'));
});

test('P11 面板只渲染一张过程卡，旧的重复「部分完成 / 失败」块已合并', () => {
  const panelPath = path.join(__dirname, '..', 'src', 'components', 'agent', 'AgentIntakePanel.jsx');
  const source = fs.readFileSync(panelPath, 'utf8');

  assert.ok(source.includes('agent-process is-'), '主过程卡样式类必须存在');
  assert.equal(source.split('agent-process is-').length - 1, 1, '只允许一张主过程卡');
  assert.ok(!source.includes('agent-partial'), '不得保留重复的部分完成块');
  assert.ok(!source.includes('agent-failure'), '不得保留独立的失败块');
  // 可访问性：卡片有 role + aria-label，步骤与摘要列表有可读名称
  assert.match(source, /role="group"/);
  assert.match(source, /aria-label=\{`本轮处理过程：\$\{process\.title\}`\}/);
  assert.match(source, /aria-label="处理步骤"/);
  assert.match(source, /aria-label="本轮修改摘要"/);
  assert.match(source, /aria-label="历史轮次摘要"/);
  // 四态文案都在组件里可达
  for (const word of ['已完成', '未成功', '进行中', '等待中', '不完整']) {
    assert.ok(source.includes(word), `步骤状态缺少可读文字：${word}`);
  }
  // 不渲染原始 JSON / trace / 工具参数
  assert.ok(!/JSON\.stringify\(/.test(source), '组件不应序列化原始数据');
  assert.ok(!source.includes('toolCalls'), '组件不应直接读取 trace 结构');
});
