const test = require('node:test');
const assert = require('node:assert/strict');

const RUN = 'agent-run.v1';

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadRunService() {
  return import('../src/services/agentTurn/agentRunService.js');
}

async function loadTransport() {
  return import('../src/services/agentTurn/agentRunTransport.js');
}

async function loadMerge() {
  return import('../src/domain/agentRunDraft.mjs');
}

async function loadConfig() {
  return import('../src/services/agentTurn/agentServiceConfig.js');
}

function emptyContractDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function contractDraft(overrides = {}) {
  return {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'dish_1', name: '宫保鸡丁', priceCents: 2800, description: '' },
      { id: 'dish_2', name: '番茄炒蛋', priceCents: 1600, description: '' },
      { id: 'dish_3', name: '米饭', priceCents: 300, description: '' },
    ],
    ...overrides,
  };
}

function validRunResponse(overrides = {}) {
  return {
    contractVersion: RUN,
    runId: 'run_test_1',
    status: 'reviewing',
    reply: '资料已整理好，请确认。',
    draft: contractDraft(),
    missingFields: [],
    errors: [],
    nextQuestion: null,
    trace: {
      modelCalls: 2,
      toolCalls: [
        { callId: 'call_1', name: 'update_store_draft', ok: true, latencyMs: 3, attempts: 1, truncated: false },
      ],
      stopReason: 'final_answer',
      degraded: false,
    },
    meta: {
      transport: 'http',
      provider: 'deepseek',
      mock: false,
      model: 'deepseek-chat',
      latencyMs: 1200,
      runId: 'run_test_1',
    },
    ...overrides,
  };
}

function responseStub(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

/** 本地草稿：含用户手改过的菜品 id 与一个响应里不会出现的菜（用于验证不删除）。 */
function localDraft() {
  return {
    storeName: '松月食堂',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '' },
      { id: 'dish-2', name: '手工水饺', priceCents: 1800, priceText: '18.00', description: '用户自己加的' },
    ],
  };
}

async function seededStoreInfo() {
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
  return { machine, state };
}

// ---------------------------------------------------------------------------
// 路由：只有「无图片 + HTTP + 资料阶段」才允许打到 agent-run.v1
// ---------------------------------------------------------------------------

test('W2-1 路由：无图 HTTP 命中 agent-run.v1，有图走 v2，Mock 走旧链路', async () => {
  const { resolveAgentRequestRoute, isAgentRunRoute } = await loadRunService();

  assert.equal(
    resolveAgentRequestRoute({ phase: 'store-info', imageCount: 0, transportMode: 'http' }),
    'agent-run.v1',
  );
  assert.equal(isAgentRunRoute('agent-run.v1'), true);

  assert.equal(
    resolveAgentRequestRoute({ phase: 'store-info', imageCount: 2, transportMode: 'http' }),
    'agent-turn.v2',
    '有图片必须继续走 agent-turn.v2',
  );
  assert.equal(
    resolveAgentRequestRoute({ phase: 'store-info', imageCount: 0, transportMode: 'mock' }),
    'agent-turn.v1',
    'Mock 模式必须走旧 transport',
  );
  assert.equal(
    resolveAgentRequestRoute({ phase: 'store-info', imageCount: 1, transportMode: 'mock' }),
    'agent-turn.v2',
    'Mock + 图片仍是既有 v2 本地链路',
  );
  // 模板修订阶段不进本服务（由 template-revise 独立链路处理）。
  assert.equal(
    resolveAgentRequestRoute({ phase: 'template-pick', imageCount: 0, transportMode: 'http' }),
    'agent-turn',
  );
  assert.equal(isAgentRunRoute('agent-turn'), false);
});

test('W2-2 agent-run 请求：严格字段、contract 头、requestId 头与独立超时', async () => {
  const { createAgentRunTransport } = await loadTransport();
  const { resolveAgentRunConfig } = await loadConfig();
  const { calls, fetchImpl } = fakeFetch(() => responseStub(validRunResponse()));
  const transport = createAgentRunTransport({
    endpoint: '/api/v1/agent/run',
    timeoutMs: 1234,
    fetchImpl,
  });

  const request = {
    contractVersion: RUN,
    utterance: '开一家面馆，堂食和外卖，牛肉面 28 元',
    draft: emptyContractDraft(),
    client: { surface: 'desktop', phase: 'store-info' },
    projectId: null,
  };
  const result = await transport.send(request, { requestId: 'agent-request-9' });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/agent\/run$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Agent-Contract'], RUN);
  assert.equal(calls[0].init.headers['X-Request-Id'], 'agent-request-9');
  const body = bodyOf(calls[0]);
  assert.deepEqual(Object.keys(body).sort(), ['client', 'contractVersion', 'draft', 'projectId', 'utterance']);
  assert.deepEqual(body.client, { surface: 'desktop', phase: 'store-info' });
  assert.equal(body.projectId, null);
  assert.equal(result.runId, 'run_test_1');
  assert.equal(result.requestId, 'agent-request-9');
  assert.equal(result.degraded, false);
  assert.equal(result.stopReason, 'final_answer');

  // 超时配置独立于 agent-turn：http 模式默认 75s，可被 run 专用变量覆盖。
  const httpConfig = resolveAgentRunConfig({ transport: 'http' });
  assert.equal(httpConfig.endpoint, '/api/v1/agent/run');
  assert.equal(httpConfig.contractVersion, RUN);
  assert.equal(httpConfig.timeoutMs, 75000);
  assert.equal(resolveAgentRunConfig({ transport: 'http', agentRunTimeoutMs: 3000 }).timeoutMs, 3000);
  assert.equal(
    resolveAgentRunConfig({ transport: 'http', agentRunEndpoint: '/x/agent/run' }).endpoint,
    '/x/agent/run',
  );

  // 缺 requestId 时自动生成合法 id，不能发出空头。
  const generated = await transport.send(request, {});
  assert.equal(generated.requestId, calls[1].init.headers['X-Request-Id']);
  assert.match(calls[1].init.headers['X-Request-Id'], /^[A-Za-z0-9._:-]{8,80}$/);
});

test('W2-3 非法契约与伪造响应一律拒绝', async () => {
  const { createAgentRunTransport } = await loadTransport();

  // 服务端回了 agent-turn.v1
  {
    const { fetchImpl } = fakeFetch(() => responseStub({ ...validRunResponse(), contractVersion: 'agent-turn.v1' }));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(
      () => transport.send({ contractVersion: RUN }, {}),
      (error) => error.code === 'AGENT_CONTRACT_MISMATCH',
    );
  }

  // 请求本身契约版本不对：发出前就拒绝，不发网络请求
  {
    const { calls, fetchImpl } = fakeFetch(() => responseStub(validRunResponse()));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(
      () => transport.send({ contractVersion: 'agent-turn.v2' }, {}),
      (error) => error.code === 'AGENT_CONTRACT_MISMATCH',
    );
    assert.equal(calls.length, 0);
  }

  // meta.runId 与 runId 不一致
  {
    const { fetchImpl } = fakeFetch(() => responseStub(validRunResponse({
      meta: { ...validRunResponse().meta, runId: 'run_other' },
    })));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(
      () => transport.send({ contractVersion: RUN }, {}),
      (error) => error.code === 'AGENT_RESPONSE_INVALID' && /runId/.test(error.message),
    );
  }

  // mock=true 冒充真实模型
  {
    const { fetchImpl } = fakeFetch(() => responseStub(validRunResponse({
      meta: { ...validRunResponse().meta, mock: true },
    })));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(
      () => transport.send({ contractVersion: RUN }, {}),
      (error) => error.code === 'AGENT_RESPONSE_INVALID' && /Mock/.test(error.message),
    );
  }

  // 缺 trace / stopReason 非法
  {
    const { fetchImpl } = fakeFetch(() => responseStub({ ...validRunResponse(), trace: undefined }));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(() => transport.send({ contractVersion: RUN }, {}), (error) => (
      error.code === 'AGENT_RESPONSE_INVALID'
    ));
  }
  {
    const bad = validRunResponse();
    bad.trace = { ...bad.trace, stopReason: 'whatever' };
    const { fetchImpl } = fakeFetch(() => responseStub(bad));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(() => transport.send({ contractVersion: RUN }, {}), (error) => (
      error.code === 'AGENT_RESPONSE_INVALID'
    ));
  }
});

test('W2-4 HTTP 失败不返回草稿：超时 / 401 / 429 / 5xx 分型', async () => {
  const { createAgentRunTransport } = await loadTransport();

  // 超时
  {
    const transport = createAgentRunTransport({
      timeoutMs: 30,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    });
    await assert.rejects(
      () => transport.send({ contractVersion: RUN }, {}),
      (error) => error.code === 'AGENT_TIMEOUT' && error.retryable === true,
    );
  }

  // 401
  {
    const { fetchImpl } = fakeFetch(() => responseStub({ code: 'AUTH_INVALID', message: '未登录', requestId: 'req_1' }, 401));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(() => transport.send({ contractVersion: RUN }, {}), (error) => (
      error.code === 'AGENT_HTTP_4XX'
      && error.httpStatus === 401
      && error.serverCode === 'AUTH_INVALID'
      && error.retryable === false
      && /登录/.test(error.message)
    ));
  }

  // 429
  {
    const { fetchImpl } = fakeFetch(() => responseStub({ code: 'DEEPSEEK_RATE_LIMITED' }, 429));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(() => transport.send({ contractVersion: RUN }, {}), (error) => (
      error.code === 'AGENT_RATE_LIMITED' && error.retryable === true
    ));
  }

  // 503
  {
    const { fetchImpl } = fakeFetch(() => responseStub({ code: 'DEEPSEEK_NOT_CONFIGURED' }, 503));
    const transport = createAgentRunTransport({ fetchImpl });
    await assert.rejects(() => transport.send({ contractVersion: RUN }, {}), (error) => (
      error.code === 'AGENT_HTTP_5XX' && error.serverCode === 'DEEPSEEK_NOT_CONFIGURED'
    ));
  }
});

// ---------------------------------------------------------------------------
// 草稿合并与降级
// ---------------------------------------------------------------------------

test('W2-5 草稿合并：id 优先、精确 name 兜底、改名保 id、未传字段不覆盖、不删除', async () => {
  const { mergeAgentRunDraft } = await loadMerge();
  const current = {
    storeName: '松月食堂',
    category: '',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '' },
      { id: 'dish-2', name: '手工水饺', priceCents: 1800, priceText: '18.00', description: '用户自己加的' },
    ],
  };

  const merged = mergeAgentRunDraft(current, {
    // storeName 未传 → 保留；category 空字符串 → 不覆盖；businessHours 传了 → 覆盖
    category: '',
    businessHours: '09:00-20:00',
    fulfillment: { takeaway: true },
    dishes: [
      // 同 id 改名：保留 dish-1，只更新名字与价格
      { id: 'dish-1', name: '宫保鸡丁（大份）', priceCents: 3200 },
      // 未知 id 但精确同名：合并到 dish-2，保留 dish-2 的 id
      { id: 'srv_9', name: '手工水饺', priceCents: 2000 },
      // 全新菜品：追加
      { id: 'srv_3', name: '紫菜蛋花汤', priceCents: 800 },
    ],
  });

  assert.equal(merged.storeName, '松月食堂', '未传字段不得被清空');
  assert.equal(merged.category, '', '空字符串不清值');
  assert.equal(merged.businessHours, '09:00-20:00', '传了的值要生效');
  assert.deepEqual(merged.fulfillment, { dineIn: true, takeaway: true }, '只更新传入的放位标记');

  const ids = merged.dishes.map((dish) => dish.id);
  assert.deepEqual(ids, ['dish-1', 'dish-2', 'srv_3'], '成品 id 保持本地值，新菜追加，不删除');
  const renamed = merged.dishes[0];
  assert.equal(renamed.name, '宫保鸡丁（大份）');
  assert.equal(renamed.priceCents, 3200);
  assert.equal(merged.dishes[1].name, '手工水饺');
  assert.equal(merged.dishes[1].priceCents, 2000);
  assert.equal(merged.dishes[1].description, '用户自己加的', '未传描述不清空');
  assert.equal(merged.dishes[2].priceText, '8.00');

  // 空 patch / 非对象响应：草稿原样保留
  assert.deepEqual(mergeAgentRunDraft(current, {}), current);
  assert.deepEqual(mergeAgentRunDraft(current, null), current);
});

function transportResult(overrides = {}) {
  return {
    contractVersion: RUN,
    runId: 'run_test_1',
    status: 'reviewing',
    reply: '资料已整理好，请确认。',
    draft: contractDraft(),
    trace: {
      modelCalls: 2,
      toolCalls: [
        { callId: 'call_1', name: 'update_store_draft', ok: true, latencyMs: 3, attempts: 1, truncated: false },
      ],
      stopReason: 'final_answer',
      degraded: false,
    },
    meta: {
      transport: 'http',
      provider: 'deepseek',
      mock: false,
      model: 'deepseek-chat',
      latencyMs: 1200,
      runId: 'run_test_1',
    },
    stopReason: 'final_answer',
    degraded: false,
    failedTools: [],
    requestId: 'agent-request-1',
    ...overrides,
  };
}

function runServiceWith(result) {
  return {
    send: async () => result,
    name: 'agent-run',
  };
}

test('W2-6 降级（部分完成）：草稿可用、状态由本地校验决定、不断言工具全成功', async () => {
  const runService = await loadRunService();

  const degradedResult = transportResult({
    status: 'collecting',
    trace: {
      modelCalls: 3,
      toolCalls: [
        { callId: 'c1', name: 'get_store_draft', ok: true, latencyMs: 1, attempts: 1, truncated: false },
        { callId: 'c2', name: 'update_store_draft', ok: false, errorCode: 'TOOL_TIMEOUT', latencyMs: 15000, attempts: 2, truncated: false },
      ],
      stopReason: 'time_limit',
      degraded: true,
    },
    degraded: true,
    failedTools: ['update_store_draft'],
    stopReason: 'time_limit',
  });

  const service = runService.createAgentRunService({ transport: runServiceWith(degradedResult) });
  const result = await service.requestAgentRun({ utterance: '帮我补全资料', draft: localDraft() });

  assert.equal(result.degraded, true, '存在失败工具调用必须标记降级');
  assert.match(result.degradation.message, /部分完成/);
  assert.match(result.degradation.message, /update_store_draft/);
  assert.equal(result.stopReason, 'time_limit');
  assert.deepEqual(result.degradation.failedTools, ['update_store_draft']);
  // 本地校验通过 → reviewing（不盲信服务端给的 collecting）
  assert.equal(result.status, 'reviewing');
  assert.equal(result.draft.storeName, '松月食堂');
  assert.equal(result.runId, 'run_test_1');
  assert.equal(result.trace.toolCalls.length, 2);
  assert.equal(result.trace.toolCalls[1].ok, false);

  // 非 final_answer 的 stopReason（工具上限）同样视为降级
  const limitResult = transportResult({
    trace: { modelCalls: 6, toolCalls: [], stopReason: 'max_tool_calls', degraded: false },
    stopReason: 'max_tool_calls',
    degraded: false,
    status: 'collecting',
  });
  const limitService = runService.createAgentRunService({ transport: runServiceWith(limitResult) });
  const limitApplied = await limitService.requestAgentRun({ utterance: '继续', draft: localDraft() });
  assert.equal(limitApplied.degraded, true);
  assert.match(limitApplied.degradation.message, /工具调用上限/);

  // 正常响应：不误报降级
  const okService = runService.createAgentRunService({ transport: runServiceWith(transportResult()) });
  const ok = await okService.requestAgentRun({ utterance: '资料齐了', draft: localDraft() });
  assert.equal(ok.degraded, false);
  assert.equal(ok.degradation.message, '');
});

test('W2-7 传输失败不产出草稿，reducer 保留旧草稿与可重试状态', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const before = machine.reducer(state, { type: 'EDIT_AGENT_DRAFT_FIELD', field: 'storeName', value: '现有草稿' });

  const requested = machine.reducer(before, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '继续补全',
    requestId: 'r-1',
    draftRevision: before.agent.draftRevision,
  });
  const failed = machine.reducer(requested, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'r-1',
    error: { code: 'AGENT_TIMEOUT', message: '请求超时，请重试。', retryable: true },
  });

  assert.deepEqual(failed.agentDraft, before.agentDraft, '失败不得改动草稿');
  assert.equal(failed.agent.status, 'failed');
  assert.equal(failed.agent.lastError.code, 'AGENT_TIMEOUT');
  assert.equal(failed.agent.lastError.retryable, true);
  assert.equal(failed.agent.activeRequestId, null);
  assert.equal(failed.agent.lastUtterance, '继续补全', '失败后仍保留可重试的原话');

  // 不可重试的错误（401/403）同样保留草稿，但 retryable=false
  const requested2 = machine.reducer(failed, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '继续补全',
    requestId: 'r-2',
    draftRevision: failed.agent.draftRevision,
  });
  const unauthorized = machine.reducer(requested2, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'r-2',
    error: { code: 'AGENT_HTTP_4XX', message: '登录状态已失效，请重新登录后再试。', retryable: false, httpStatus: 401 },
  });
  assert.deepEqual(unauthorized.agentDraft, before.agentDraft);
  assert.equal(unauthorized.agent.lastError.retryable, false);
  assert.equal(unauthorized.agent.lastError.httpStatus, 401);
});

// ---------------------------------------------------------------------------
// 并发与手改保护
// ---------------------------------------------------------------------------

test('W2-8 手改草稿后到达的回复：保留用户现稿并提示，不整份应用', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const frozen = state.agent.draftRevision;

  const requested = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '开一家面馆',
    requestId: 'r-1',
    draftRevision: frozen,
  });
  const edited = machine.reducer(requested, { type: 'EDIT_AGENT_DRAFT_FIELD', field: 'storeName', value: '我自己的店名' });
  assert.equal(edited.agent.draftRevision, frozen + 1, '手改必须推进修订号');

  const messageCount = (edited.sessions.find((s) => s.id === edited.activeSessionId)?.messages ?? []).length;

  const applied = machine.reducer(edited, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-1',
    draftRevision: frozen,
    draft: contractDraft({ storeName: '服务端店名' }),
    reply: '已按你的描述整理。',
    runId: 'run_1',
    trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
    degraded: false,
  });

  assert.equal(applied.agentDraft.storeName, '我自己的店名', '手改内容不得被覆盖');
  assert.notEqual(applied.agent.status, 'requesting');
  assert.equal(applied.agent.staleDraftNotice.code, 'AGENT_DRAFT_CHANGED');
  assert.match(applied.agent.staleDraftNotice.message, /保留你现在的草稿/);
  assert.equal(applied.agent.activeRequestId, null);
  assert.equal(applied.agent.runId, 'run_1', '可观测信息仍记录，便于排查');
  const afterMessages = (applied.sessions.find((s) => s.id === applied.activeSessionId)?.messages ?? []).length;
  assert.equal(afterMessages, messageCount, '迟到的回复不追加对话消息');

  // 再次请求会清掉提示；菜品增删同样推进修订号
  const reRequested = machine.reducer(applied, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '再试一次',
    requestId: 'r-2',
    draftRevision: applied.agent.draftRevision,
  });
  assert.equal(reRequested.agent.staleDraftNotice, null);
  const added = machine.reducer(reRequested, { type: 'ADD_AGENT_DISH' });
  assert.equal(added.agent.draftRevision, applied.agent.draftRevision + 1);
});

test('W2-9 晚成功 / 晚失败不得清除新请求状态与输入', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();

  let s = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST', utterance: '第一次', requestId: 'r-1', draftRevision: state.agent.draftRevision,
  });
  s = machine.reducer(s, {
    type: 'AGENT_TURN_FAILURE', requestId: 'r-1', error: { code: 'AGENT_NETWORK', message: '网络不可用' },
  });
  s = machine.reducer(s, { type: 'EDIT_AGENT_DRAFT_FIELD', field: 'category', value: '面馆' });
  const revision = s.agent.draftRevision;
  s = machine.reducer(s, { type: 'AGENT_TURN_RETRY', requestId: 'r-2', draftRevision: revision });
  assert.equal(s.agent.status, 'requesting');
  assert.equal(s.agent.activeRequestId, 'r-2');
  assert.equal(s.agent.requestDraftRevision, revision);

  const draftBefore = s.agentDraft;
  const messagesBefore = (s.sessions.find((x) => x.id === s.activeSessionId)?.messages ?? []).length;

  // 迟到的旧请求结果：两个方向都必须被整包忽略
  const lateSuccess = machine.reducer(s, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-1',
    draftRevision: 0,
    draft: contractDraft({ storeName: '迟到结果' }),
    reply: '迟到的回复',
  });
  assert.equal(lateSuccess.agent.status, 'requesting');
  assert.equal(lateSuccess.agent.activeRequestId, 'r-2');
  assert.deepEqual(lateSuccess.agentDraft, draftBefore);

  const lateFailure = machine.reducer(s, {
    type: 'AGENT_TURN_FAILURE', requestId: 'r-1', error: { code: 'AGENT_TIMEOUT', message: '超时' },
  });
  assert.equal(lateFailure.agent.status, 'requesting');
  assert.equal(lateFailure.agent.lastError, null);
  assert.equal(
    (lateFailure.sessions.find((x) => x.id === lateFailure.activeSessionId)?.messages ?? []).length,
    messagesBefore,
  );

  // 当前请求正常完成
  const done = machine.reducer(s, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-2',
    draftRevision: revision,
    draft: contractDraft(),
    reply: '整理完成',
    runId: 'run_2',
  });
  assert.equal(done.agent.status, 'reviewing');
  assert.equal(done.agent.activeRequestId, null);
  assert.equal(done.agent.runId, 'run_2');
});

test('W2-10 重试：新 requestId + 最新草稿版本，成功后正常应用', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();

  let s = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST', utterance: '补全资料', requestId: 'r-1', draftRevision: state.agent.draftRevision,
  });
  s = machine.reducer(s, { type: 'AGENT_TURN_FAILURE', requestId: 'r-1', error: { code: 'AGENT_HTTP_5XX', message: '服务暂时不可用' } });
  s = machine.reducer(s, { type: 'EDIT_AGENT_DISH' });
  s = machine.reducer(s, { type: 'AGENT_TURN_RETRY', requestId: 'r-2', draftRevision: s.agent.draftRevision });

  assert.equal(s.agent.attempts, 2, '重试计入尝试次数');
  assert.equal(s.agent.lastUtterance, '补全资料');

  const done = machine.reducer(s, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-2',
    draftRevision: s.agent.requestDraftRevision,
    draft: contractDraft(),
    reply: '这次补齐了',
    runId: 'run_retry',
  });
  assert.equal(done.agent.status, 'reviewing');
  assert.equal(done.agent.runId, 'run_retry');
  assert.equal(done.agent.attempts, 2);
});

test('W2-11 请求期间新增图片不得被静默忽略', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();

  const requested = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST', utterance: '看看我的菜单', requestId: 'r-1', draftRevision: state.agent.draftRevision,
  });
  const applied = machine.reducer(requested, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'r-1',
    draftRevision: state.agent.draftRevision,
    draft: contractDraft(),
    reply: '已记录',
    imagesAddedDuringRequest: true,
  });
  assert.equal(applied.agent.hint.code, 'AGENT_IMAGES_PENDING');
  assert.match(applied.agent.hint.message, /图片/);

  // 下一次请求清掉提示
  const next = machine.reducer(applied, {
    type: 'AGENT_TURN_REQUEST', utterance: '继续', requestId: 'r-2', draftRevision: applied.agent.draftRevision,
  });
  assert.equal(next.agent.hint, null);
});

