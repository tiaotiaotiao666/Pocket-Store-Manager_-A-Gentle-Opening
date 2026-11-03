const test = require('node:test');
const assert = require('node:assert/strict');

const CONTRACT = 'agent-turn.v1';

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadService() {
  return import('../src/services/agentTurn/agentTurnService.js');
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

function messagesOf(state) {
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  return session?.messages ?? [];
}

function userMessages(state) {
  return messagesOf(state).filter((message) => message.role === 'user');
}

async function runTurn(machine, state, service, utterance, options = {}) {
  const requested = machine.reducer(state, { type: 'AGENT_TURN_REQUEST', utterance });
  try {
    const result = await service.requestAgentTurn({
      utterance,
      draft: requested.agentDraft,
      simulateFailureOnce: options.simulateFailureOnce,
    });
    return {
      ok: true,
      state: machine.reducer(requested, { type: 'AGENT_TURN_SUCCESS', ...result }),
      result,
    };
  } catch (error) {
    return {
      ok: false,
      state: machine.reducer(requested, { type: 'AGENT_TURN_FAILURE', error }),
      error,
    };
  }
}

const FULL_UTTERANCE = '做社区家常菜，每天 10:00-21:00，堂食和自取，宫保鸡丁 28 元、番茄炒蛋 16 元、米饭 3 元。';

test('F0 初始化包含 agent 切片，RESET 后恢复空草稿', async () => {
  const machine = await loadMachine();
  const initial = machine.createInitialState();
  assert.equal(initial.agent.status, 'idle');
  assert.deepEqual(initial.agentDraft, {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  });
  const dirty = machine.reducer(initial, { type: 'AGENT_SIMULATE_FAILURE', value: true });
  assert.equal(dirty.agent.simulateFailure, true);
  const reset = machine.reducer(dirty, { type: 'RESET' });
  assert.equal(reset.agent.status, 'idle');
  assert.equal(reset.agent.simulateFailure, false);
  assert.equal(reset.agentDraft.dishes.length, 0);
});

test('F1 资料不完整时追问营业时间，状态为 collecting', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const outcome = await runTurn(machine, state, service, '做社区家常菜');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state.agent.status, 'collecting');
  assert.equal(outcome.state.agent.nextQuestion.field, 'businessHours');
  assert.equal(outcome.state.agentDraft.category, '社区餐馆');
  assert.equal(outcome.state.agentDraft.storeName, '松月食堂');
  const last = messagesOf(outcome.state).at(-1);
  assert.equal(last.role, 'agent');
  assert.ok(last.text.includes('还差'));
  assert.ok(last.text.includes('营业时间'));
});

test('F2 资料完整时进入 reviewing，草稿可编辑确认', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const outcome = await runTurn(machine, state, service, FULL_UTTERANCE);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.state.agent.status, 'reviewing');
  assert.equal(outcome.result.validation.readyForReview, true);
  assert.equal(outcome.state.agent.nextQuestion, null);
  assert.equal(outcome.state.agentDraft.businessHours, '10:00-21:00');
  assert.deepEqual(outcome.state.agentDraft.fulfillment, { dineIn: true, takeaway: true });
  assert.equal(outcome.state.agentDraft.dishes.length, 3);
  const last = messagesOf(outcome.state).at(-1);
  assert.ok(last.text.includes('资料齐了'));
});

test('F3 修改价格为非法文本后重新校验为 PRICE_INVALID，状态回到 collecting', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const reviewing = (await runTurn(machine, state, service, FULL_UTTERANCE)).state;
  const dishId = reviewing.agentDraft.dishes[0].id;
  const edited = machine.reducer(reviewing, {
    type: 'EDIT_AGENT_DISH',
    id: dishId,
    field: 'priceText',
    value: 'abc',
  });
  assert.equal(edited.agentDraft.dishes[0].priceCents, null);
  assert.equal(edited.agentDraft.dishes[0].priceText, 'abc');
  assert.ok(edited.agent.errors.some((error) => error.code === 'PRICE_INVALID'));
  assert.equal(edited.agent.status, 'collecting');

  const legal = machine.reducer(edited, {
    type: 'EDIT_AGENT_DISH',
    id: dishId,
    field: 'priceText',
    value: '28.5',
  });
  assert.equal(legal.agentDraft.dishes[0].priceCents, 2850);
  assert.equal(legal.agentDraft.dishes[0].priceText, '28.5');
  assert.equal(legal.agent.status, 'reviewing');
});

test('F4 删除菜品至 2 道回到缺项，第 6 道被拒绝', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const reviewing = (await runTurn(machine, state, service, FULL_UTTERANCE)).state;

  const removed = machine.reducer(reviewing, {
    type: 'REMOVE_AGENT_DISH',
    id: reviewing.agentDraft.dishes[2].id,
  });
  assert.equal(removed.agentDraft.dishes.length, 2);
  assert.ok(removed.agent.missingFields.some((item) => item.field === 'dishes'));
  assert.equal(removed.agent.status, 'collecting');

  let five = removed;
  for (let index = 0; index < 3; index += 1) {
    five = machine.reducer(five, { type: 'ADD_AGENT_DISH' });
  }
  assert.equal(five.agentDraft.dishes.length, 5);
  const rejected = machine.reducer(five, { type: 'ADD_AGENT_DISH' });
  assert.equal(rejected, five);
  assert.equal(rejected.agentDraft.dishes.length, 5);
});

test('F5 确认后再次编辑回到 reviewing，重新确认后 store 同步', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const reviewing = (await runTurn(machine, state, service, FULL_UTTERANCE)).state;
  const confirmed = machine.reducer(reviewing, { type: 'CONFIRM_AGENT_DRAFT' });
  assert.equal(confirmed.agent.status, 'confirmed');
  assert.equal(confirmed.store.name, '松月食堂');
  assert.equal(confirmed.store.type, '社区餐馆');
  assert.equal(confirmed.store.notes, reviewing.store.notes);

  const edited = machine.reducer(confirmed, {
    type: 'EDIT_AGENT_DRAFT_FIELD',
    field: 'storeName',
    value: '松月食堂二店',
  });
  assert.equal(edited.agent.status, 'reviewing');
  assert.equal(edited.agentDraft.storeName, '松月食堂二店');
  assert.equal(edited.store.name, '松月食堂');

  const reconfirmed = machine.reducer(edited, { type: 'CONFIRM_AGENT_DRAFT' });
  assert.equal(reconfirmed.agent.status, 'confirmed');
  assert.equal(reconfirmed.store.name, '松月食堂二店');
});

test('F6 Mock 失败后可重试，attempts 递增且不重复 user 消息', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();

  const failed = await runTurn(machine, state, service, FULL_UTTERANCE, { simulateFailureOnce: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'AGENT_MOCK_FAILURE');
  assert.equal(failed.state.agent.status, 'failed');
  assert.equal(failed.state.agent.attempts, 1);
  const userCountAfterFailure = userMessages(failed.state).length;

  const retried = machine.reducer(failed.state, { type: 'AGENT_TURN_RETRY' });
  assert.equal(retried.agent.status, 'requesting');
  assert.equal(retried.agent.attempts, 2);
  assert.equal(userMessages(retried).length, userCountAfterFailure);

  const result = await service.requestAgentTurn({
    utterance: retried.agent.lastUtterance,
    draft: retried.agentDraft,
  });
  const done = machine.reducer(retried, { type: 'AGENT_TURN_SUCCESS', ...result });
  assert.equal(done.agent.status, 'reviewing');
  assert.equal(done.agent.attempts, 2);
  assert.equal(userMessages(done).length, userCountAfterFailure);
});

test('F7 失败后 Composer 可继续编辑与提交', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const failed = await runTurn(machine, state, service, '做社区家常菜', { simulateFailureOnce: true });
  assert.equal(failed.state.agent.status, 'failed');
  const composer = machine.selectAgentComposerState(failed.state);
  assert.equal(composer.visible, true);
  assert.equal(composer.editable, true);
  assert.equal(composer.submitDisabled, false);
  assert.equal(composer.placeholder.includes('店名'), true);
  assert.equal(composer.submitLabel, '整理资料');
});

test('F8 collecting 下 SUBMIT_STORE_INFO 被拒绝，不进入下一阶段', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state: seeded } = await seededStoreInfo();
  assert.equal(seeded.agent.status, 'idle');
  const service = serviceModule.createAgentTurnService();
  const { state } = await runTurn(machine, seeded, service, '做社区家常菜');
  assert.equal(state.agent.status, 'collecting');
  const next = machine.reducer(state, { type: 'SUBMIT_STORE_INFO', summary: '资料', styleId: 'fresh' });
  assert.equal(next, state);
});

test('F9 idle 路径兼容：直接提交店铺信息仍进入 PROMPT_STUDIO', async () => {
  const machine = await loadMachine();
  const { PHASES } = await import('../src/state/constants.mjs');
  const initial = machine.createInitialState();
  assert.equal(initial.agent.status, 'idle');
  const next = machine.reducer(initial, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  assert.equal(next.phase, PHASES.PROMPT_STUDIO);
});

test('F10 CONFIRM_TEMPLATE 用已命名店名预填草稿', async () => {
  const { state } = await seededStoreInfo();
  assert.equal(state.store.name, '松月食堂');
  assert.equal(state.agentDraft.storeName, '松月食堂');
  assert.ok(state.agent.missingFields.some((item) => item.field === 'businessHours'));
});

test('F11 RESET 清空 Agent 状态与草稿', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const reset = machine.reducer(state, { type: 'RESET' });
  assert.equal(reset.agent.status, 'idle');
  assert.deepEqual(reset.agent.missingFields, []);
  assert.deepEqual(reset.agent.errors, []);
  assert.equal(reset.agentDraft.dishes.length, 0);
  assert.equal(reset.agentDraft.storeName, '');
});

test('F12 确认映射 store，保留营业时间/履约/菜品，交接 payload 含契约草稿', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const reviewing = (await runTurn(machine, state, service, FULL_UTTERANCE)).state;
  const confirmed = machine.reducer(reviewing, { type: 'CONFIRM_AGENT_DRAFT' });
  const kept = {
    businessHours: confirmed.agentDraft.businessHours,
    fulfillment: confirmed.agentDraft.fulfillment,
    dishes: confirmed.agentDraft.dishes.length,
  };
  assert.equal(confirmed.store.name, '松月食堂');
  assert.equal(confirmed.store.type, '社区餐馆');
  assert.deepEqual(kept, { businessHours: '10:00-21:00', fulfillment: { dineIn: true, takeaway: true }, dishes: 3 });

  const submitted = machine.reducer(confirmed, {
    type: 'SUBMIT_STORE_INFO',
    summary: '店铺资料',
    styleId: 'fresh',
  });
  const visual = submitted.sessions.find((session) => session.id === 'session-visual');
  assert.equal(typeof visual.handoff, 'string');
  assert.ok(visual.handoff.includes('"agentDraft"'));
  assert.ok(visual.handoff.includes('"priceCents"'));
  assert.equal(visual.handoff.includes('priceText'), false);
});

test('F13 自由品类确认后 store.type 使用自由文本', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const reviewing = (await runTurn(machine, state, service, FULL_UTTERANCE)).state;
  const custom = machine.reducer(reviewing, {
    type: 'EDIT_AGENT_DRAFT_FIELD',
    field: 'category',
    value: '社区家常菜',
  });
  assert.equal(custom.agent.status, 'reviewing');
  const confirmed = machine.reducer(custom, { type: 'CONFIRM_AGENT_DRAFT' });
  assert.equal(confirmed.store.type, '社区家常菜');
});

test('F14 请求失败不追加错误气泡，只记录展示用 lastError', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const service = serviceModule.createAgentTurnService();
  const before = messagesOf(state).length;
  const failed = await runTurn(machine, state, service, '做社区家常菜', { simulateFailureOnce: true });
  assert.equal(messagesOf(failed.state).length, before + 1);
  assert.equal(failed.state.agent.lastError.code, 'AGENT_MOCK_FAILURE');
  assert.equal(failed.state.agent.lastError.retryable, true);
  assert.equal(Object.prototype.hasOwnProperty.call(failed.state.agent.lastError, 'stack'), false);
});

test('F15 重试复用最新草稿：失败后编辑，再重试时请求体使用编辑后的草稿', async () => {
  const machine = await loadMachine();
  const serviceModule = await loadService();
  const { state } = await seededStoreInfo();
  const captured = [];
  const transport = {
    name: 'stub',
    async send(request) {
      captured.push(request);
      return {
        contractVersion: CONTRACT,
        turnId: 'turn-stub-1',
        status: 'collecting',
        reply: '已记录。',
        draft: request.draft,
        missingFields: [],
        errors: [],
        nextQuestion: null,
        meta: { transport: 'stub', provider: 'test', mock: true, model: null, latencyMs: 0 },
      };
    },
  };
  const service = serviceModule.createAgentTurnService({ transport });
  const requested = machine.reducer(state, { type: 'AGENT_TURN_REQUEST', utterance: '做社区家常菜' });
  const failedState = machine.reducer(requested, {
    type: 'AGENT_TURN_FAILURE',
    error: { code: 'AGENT_NETWORK', message: '网络不可用', retryable: true },
  });
  const edited = machine.reducer(failedState, {
    type: 'EDIT_AGENT_DRAFT_FIELD',
    field: 'storeName',
    value: '松月食堂二店',
  });
  const retried = machine.reducer(edited, { type: 'AGENT_TURN_RETRY' });
  await service.requestAgentTurn({
    utterance: retried.agent.lastUtterance,
    draft: retried.agentDraft,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].utterance, '做社区家常菜');
  assert.equal(captured[0].draft.storeName, '松月食堂二店');
  assert.equal(captured[0].projectId, null);
});

test('F16 请求中重复提交被忽略，消息与 attempts 只增加一次', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const before = messagesOf(state).length;
  const first = machine.reducer(state, { type: 'AGENT_TURN_REQUEST', utterance: '做社区家常菜' });
  const second = machine.reducer(first, { type: 'AGENT_TURN_REQUEST', utterance: '再说一次' });
  assert.equal(second, first);
  assert.equal(messagesOf(second).length, before + 1);
  assert.equal(second.agent.attempts, 1);
});

test('F17 选择器：requesting 提交禁用但可编辑，confirmed 隐藏，非 STORE_INFO 不显示', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const requesting = machine.reducer(state, { type: 'AGENT_TURN_REQUEST', utterance: '做社区家常菜' });
  const requestingComposer = machine.selectAgentComposerState(requesting);
  assert.equal(requestingComposer.visible, true);
  assert.equal(requestingComposer.editable, true);
  assert.equal(requestingComposer.submitDisabled, true);

  const confirmed = { ...requesting, agent: { ...requesting.agent, status: 'confirmed' } };
  assert.equal(machine.selectAgentComposerState(confirmed).visible, false);

  const home = machine.createInitialState();
  assert.equal(machine.selectAgentComposerState(home).visible, false);
});

test('F18 确认前 editing 不会写 store；SET_STORE_FIELD 只在 confirmed 同步草稿', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const edited = machine.reducer(state, {
    type: 'SET_STORE_FIELD',
    field: 'name',
    value: '另一个名字',
  });
  assert.equal(edited.store.name, '另一个名字');
  assert.equal(edited.agentDraft.storeName, '松月食堂');
});
test('F19 success/failure 只接受当前 requestId，晚响应严格返回原 state', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const requested = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '更新门店资料',
    requestId: 'agent-request-1',
  });
  assert.equal(requested.agent.activeRequestId, 'agent-request-1');

  const staleSuccess = machine.reducer(requested, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-0',
    reply: '过期响应不应出现',
    draft: { ...requested.agentDraft, storeName: '过期门店' },
  });
  assert.equal(staleSuccess, requested);
  const staleFailure = machine.reducer(requested, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-0',
    error: { code: 'AGENT_NETWORK', message: '过期失败不应出现' },
  });
  assert.equal(staleFailure, requested);
  assert.equal(requested.agentDraft.storeName, '松月食堂');
  assert.equal(requested.agent.lastError, null);
  assert.equal(requested.agent.activeRequestId, 'agent-request-1');

  const succeeded = machine.reducer(requested, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-1',
    reply: '已接受当前响应',
    draft: { ...requested.agentDraft, storeName: '当前门店' },
  });
  assert.equal(succeeded.agentDraft.storeName, '当前门店');
  assert.equal(succeeded.agent.activeRequestId, null);
  const lateFailure = machine.reducer(succeeded, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-1',
    error: { code: 'AGENT_NETWORK', message: '完成后到的失败' },
  });
  assert.equal(lateFailure, succeeded);
});

test('F20 旧 Node 调用使用 null 身份兼容，retry 切换到新的 requestId', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const legacyRequested = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '旧调用',
  });
  assert.equal(legacyRequested.agent.activeRequestId, null);
  const identifiedResponse = machine.reducer(legacyRequested, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-external',
    error: { code: 'AGENT_NETWORK', message: '身份不符' },
  });
  assert.equal(identifiedResponse, legacyRequested);

  const legacyFailed = machine.reducer(legacyRequested, {
    type: 'AGENT_TURN_FAILURE',
    error: { code: 'AGENT_NETWORK', message: '旧调用失败', retryable: true },
  });
  assert.equal(legacyFailed.agent.status, 'failed');
  assert.equal(legacyFailed.agent.activeRequestId, null);

  const retried = machine.reducer(legacyFailed, {
    type: 'AGENT_TURN_RETRY',
    requestId: 'agent-request-2',
  });
  assert.equal(retried.agent.activeRequestId, 'agent-request-2');
  const staleLegacyFailure = machine.reducer(retried, {
    type: 'AGENT_TURN_FAILURE',
    error: { code: 'AGENT_NETWORK', message: '旧 null 响应' },
  });
  assert.equal(staleLegacyFailure, retried);

  const succeeded = machine.reducer(retried, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-2',
    draft: retried.agentDraft,
  });
  assert.equal(succeeded.agent.status, 'collecting');
  assert.equal(succeeded.agent.activeRequestId, null);
});

test('F21 RESET_PROJECT 后新请求不会接受 reset 前的 success/failure', async () => {
  const machine = await loadMachine();
  const { state } = await seededStoreInfo();
  const oldRequest = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: 'reset 前请求',
    requestId: 'agent-request-old',
  });
  const reset = machine.reducer(oldRequest, { type: 'RESET_PROJECT' });
  assert.equal(reset.agent.status, 'idle');
  assert.equal(reset.agent.activeRequestId, null);

  const newRequest = machine.reducer(reset, {
    type: 'AGENT_TURN_REQUEST',
    utterance: 'reset 后新请求',
    requestId: 'agent-request-new',
  });
  const staleSuccess = machine.reducer(newRequest, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'agent-request-old',
    reply: '旧成功',
    draft: { ...newRequest.agentDraft, storeName: '旧响应门店' },
  });
  assert.equal(staleSuccess, newRequest);
  const staleFailure = machine.reducer(newRequest, {
    type: 'AGENT_TURN_FAILURE',
    requestId: 'agent-request-old',
    error: { code: 'AGENT_NETWORK', message: '旧失败' },
  });
  assert.equal(staleFailure, newRequest);
  assert.equal(newRequest.agent.activeRequestId, 'agent-request-new');
  assert.equal(newRequest.agent.lastUtterance, 'reset 后新请求');
  assert.equal(newRequest.agentDraft.storeName, '');
});