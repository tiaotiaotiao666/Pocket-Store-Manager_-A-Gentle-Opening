const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadSidebar() {
  return import('../src/domain/agentSidebar.mjs');
}

async function loadMachine() {
  return import('../src/state/sessionMachine.mjs');
}

async function loadConstants() {
  return import('../src/state/constants.mjs');
}

/** 已打开一个项目、停在门店资料阶段的会话状态（右侧栏可以真正发请求）。 */
async function seededProject(projectId = 'p_sidebar0001') {
  const machine = await loadMachine();
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'PROJECT_NEW_SUCCESS', projectId, createdAt: '2026-11-19T00:00:00.000Z' });
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  return { machine, state, projectId };
}

function message(overrides = {}) {
  return {
    id: 'chat-1',
    role: 'user',
    text: '补充营业时间 10:00-21:00',
    createdAt: '2026-11-19T09:00:00.000Z',
    status: 'done',
    actionKind: 'store-info',
    context: { phase: 'store-info', sessionId: 'session-main' },
    ...overrides,
  };
}

test('空会话工厂字段完整且与契约一致', async () => {
  const { createEmptyAgentChat } = await loadSidebar();
  const empty = createEmptyAgentChat();
  assert.deepEqual(empty, {
    messages: [],
    draft: '',
    status: 'idle',
    activeRequestId: null,
    activeProjectId: null,
    lastUtterance: '',
    lastError: null,
    lastRun: null,
    revision: 0,
    requestDraftRevision: null,
    requestPhase: null,
    requestContextRevision: null,
  });
  // 每次都是新对象，不复用同一份引用。
  assert.notEqual(createEmptyAgentChat(), empty);
  assert.notEqual(createEmptyAgentChat().messages, empty.messages);
});

test('领域模块是纯函数：不依赖 React / service / fetch / fs / localStorage', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'agentSidebar.mjs'), 'utf8');
  // 去掉注释再扫描：注释里提到 localStorage/fetch 只是说明「不用它们」。
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = source.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
  assert.equal(imports.length, 1, `只允许 import 阶段常量，实际：${imports.join(' | ')}`);
  assert.ok(imports[0].includes("from '../state/constants.mjs'"));
  assert.ok(!/from 'react'/.test(source));
  assert.ok(!/from '\.\.\/services\//.test(source));
  assert.ok(!/\bfetch\s*\(/.test(source));
  assert.ok(!/localStorage/.test(source));
  assert.ok(!/\bwindow\./.test(source));
  assert.ok(!/require\(/.test(source));
  assert.ok(!/node:fs/.test(source));
});

test('消息规范化：非法 role/status/actionKind 与非字符串正文被过滤', async () => {
  const { normalizeChatMessages } = await loadSidebar();
  const normalized = normalizeChatMessages([
    message({ id: 'ok-1' }),
    message({ id: 'bad-role', role: 'bot' }),
    message({ id: 'bad-status', status: 'pending' }),
    message({ id: 'bad-kind', actionKind: 'anything' }),
    message({ id: 'bad-text', text: 123 }),
    message({ id: 'blank-text', text: '   ' }),
    null,
    'not-a-message',
    [],
  ]);
  assert.deepEqual(normalized.map((item) => item.id), ['ok-1']);
  assert.deepEqual(Object.keys(normalized[0]).sort(), [
    'actionKind', 'context', 'createdAt', 'id', 'role', 'status', 'text',
  ]);
});

test('消息上下文只保留 phase 与 sessionId，草稿/图片等大对象被丢弃', async () => {
  const { normalizeChatMessages } = await loadSidebar();
  const [normalized] = normalizeChatMessages([
    message({
      context: {
        phase: 'store-info',
        sessionId: 'session-main',
        draft: { dishes: [{ id: 'dish-1', name: '牛肉面' }] },
        image: { dataUrl: 'data:image/png;base64,AAAA' },
        plan: { steps: [] },
      },
    }),
  ]);
  assert.deepEqual(normalized.context, { phase: 'store-info', sessionId: 'session-main' });
  assert.ok(!JSON.stringify(normalized).includes('base64'));
});

test('消息规范化：单条上限 5000 字、总量上限 100 条且保留最新', async () => {
  const { CHAT_MESSAGE_LIMIT, CHAT_MESSAGE_MAX_CHARS, normalizeChatMessages } = await loadSidebar();
  assert.equal(CHAT_MESSAGE_LIMIT, 100);
  assert.equal(CHAT_MESSAGE_MAX_CHARS, 5000);

  const long = normalizeChatMessages([message({ text: 'a'.repeat(6000) })]);
  assert.equal(long[0].text.length, CHAT_MESSAGE_MAX_CHARS);

  const many = Array.from({ length: 150 }, (_, index) => message({ id: `m-${index + 1}` }));
  const trimmed = normalizeChatMessages(many);
  assert.equal(trimmed.length, CHAT_MESSAGE_LIMIT);
  assert.equal(trimmed[0].id, 'm-51');
  assert.equal(trimmed[trimmed.length - 1].id, 'm-150');

  // 超长正文截断后再按条数裁剪，顺序不变。
  const mixed = normalizeChatMessages(Array.from({ length: 120 }, (_, index) => message({
    id: `x-${index + 1}`,
    text: 'b'.repeat(5200),
  })));
  assert.equal(mixed.length, 100);
  assert.ok(mixed.every((item) => item.text.length === 5000));
});

test('消息规范化是幂等的（规范化两次结果相同）', async () => {
  const { normalizeChatMessages } = await loadSidebar();
  const raw = [
    message({ id: 'a', text: '补充一道菜：宫保鸡丁 28 元' }),
    message({ id: '', role: 'assistant', actionKind: 'guide', text: '本地指引：先填资料' }),
    message({ id: 'c', role: 'system', actionKind: 'guide', status: 'failed', text: '上一轮失败' }),
    message({ id: 'd', text: 'c'.repeat(5200) }),
    { role: 'assistant', status: 'done', actionKind: 'guide', text: '没有 id 的助手消息' },
  ];
  const once = normalizeChatMessages(raw);
  const twice = normalizeChatMessages(once);
  assert.deepEqual(twice, once);
  assert.equal(new Set(once.map((item) => item.id)).size, once.length, '缺 id 的消息要拿到互不相同的稳定 id');
});

test('appendChatMessage 对同 id 不重复追加（StrictMode / 重试不产生重复气泡）', async () => {
  const { appendChatMessage, createChatMessage } = await loadSidebar();
  const first = createChatMessage(message({ id: 'dedupe-1' }));
  const once = appendChatMessage([], first);
  const twice = appendChatMessage(once, first);
  assert.equal(twice.length, 1);
  assert.deepEqual(twice, once);

  const capped = Array.from({ length: 100 }, (_, index) => message({ id: `cap-${index + 1}` }));
  const appended = appendChatMessage(capped, message({ id: 'cap-101' }));
  assert.equal(appended.length, 100);
  assert.equal(appended[0].id, 'cap-2');
  assert.equal(appended[appended.length - 1].id, 'cap-101');
});

test('isValidChatDraft：空白与超限不可发送', async () => {
  const { isValidChatDraft, CHAT_DRAFT_MAX_CHARS } = await loadSidebar();
  assert.equal(CHAT_DRAFT_MAX_CHARS, 500);
  assert.equal(isValidChatDraft(''), false);
  assert.equal(isValidChatDraft('   \n  '), false);
  assert.equal(isValidChatDraft(null), false);
  assert.equal(isValidChatDraft(undefined), false);
  assert.equal(isValidChatDraft('补充营业时间'), true);
  assert.equal(isValidChatDraft('好'.repeat(500)), true);
  assert.equal(isValidChatDraft('好'.repeat(501)), false);
});

test('统一入口：有项目时任意阶段都进入 app-assistant，阶段不再决定能否发送', async () => {
  const { buildAgentChatSubmitPlan } = await loadSidebar();
  const { PHASES } = await loadConstants();
  const projectId = 'p_route0001';

  for (const phase of Object.values(PHASES)) {
    const plan = buildAgentChatSubmitPlan({ projectId, phase, hasProject: true });
    assert.equal(plan.allowed, true, `${phase} 有项目时允许发送`);
    assert.equal(plan.actionKind, 'app-assistant', `${phase} 走统一入口`);
    assert.equal(plan.label, '项目 Agent');
    assert.ok(plan.notice.includes('桌面再次校验'));

    const same = buildAgentChatSubmitPlan({ projectId, phase });
    assert.deepEqual(same, plan, `${phase} 缺省 hasProject 时口径一致`);
  }

  // 文案如实：不暗示「任何话都能改任意内容」。
  const plan = buildAgentChatSubmitPlan({ projectId, phase: PHASES.DEPLOY });
  assert.ok(!/任何|任意|什么都能|全能/.test(`${plan.label}${plan.notice}`));

  // 无活动项目：禁止发送并提示先打开项目。
  const none = buildAgentChatSubmitPlan({ projectId: null, phase: PHASES.STORE_INFO, hasProject: false });
  assert.deepEqual(none, {
    allowed: false,
    actionKind: 'guide',
    label: '先打开项目',
    notice: '还没有打开项目：先在左侧打开或新建一个项目，再在右侧对话。',
  });
  for (const phase of Object.values(PHASES)) {
    assert.equal(buildAgentChatSubmitPlan({ projectId: null, phase }).allowed, false, `${phase} 无项目时一律禁止`);
  }
});

test('isChatResponseAcceptable 冻结 projectId + requestId + contextRevision；phase 不参与', async () => {
  const { isChatResponseAcceptable, createEmptyAgentChat } = await loadSidebar();
  const chat = {
    ...createEmptyAgentChat(),
    status: 'requesting',
    activeProjectId: 'p_a',
    activeRequestId: 'req-1',
    requestContextRevision: 3,
    requestPhase: 'store-info',
  };
  const ok = { chat, projectId: 'p_a', requestId: 'req-1', contextRevision: 3 };
  assert.equal(isChatResponseAcceptable(ok), true);
  assert.equal(isChatResponseAcceptable({ ...ok, projectId: 'p_b' }), false);
  assert.equal(isChatResponseAcceptable({ ...ok, requestId: 'req-2' }), false);
  assert.equal(isChatResponseAcceptable({ ...ok, contextRevision: 4 }), false);
  assert.equal(isChatResponseAcceptable({ ...ok, contextRevision: null }), false);
  // 跨阶段是核心场景：阶段变化不影响接收。
  assert.equal(isChatResponseAcceptable({ ...ok, phase: 'template-pick' }), true);
  assert.equal(isChatResponseAcceptable({ ...ok, phase: 'deploy' }), true);
  assert.equal(isChatResponseAcceptable({ ...ok, projectId: undefined }), false);
  assert.equal(isChatResponseAcceptable({ ...ok, chat: { ...chat, status: 'idle' } }), false);
  assert.equal(isChatResponseAcceptable({ ...ok, chat: { ...chat, requestContextRevision: null } }), false);
  assert.equal(isChatResponseAcceptable({}), false);
});

test('reducer：REQUEST_START 写入一条用户消息，SUCCESS 只追加一条助手消息', async () => {
  const { machine, state, projectId } = await seededProject();
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-1',
    draftRevision: 0,
    utterance: '补充营业时间 10:00-21:00',
  });
  assert.equal(started.agentChat.status, 'requesting');
  assert.equal(started.agentChat.activeProjectId, projectId);
  assert.equal(started.agentChat.activeRequestId, 'req-1');
  assert.equal(started.agentChat.requestPhase, 'store-info');
  assert.equal(started.agentChat.lastUtterance, '补充营业时间 10:00-21:00');
  assert.equal(started.agentChat.messages.length, 1);
  assert.deepEqual(started.agentChat.messages[0].context, { phase: 'store-info', sessionId: started.activeSessionId });
  assert.equal(started.agentChat.messages[0].actionKind, 'app-assistant');

  const done = machine.reducer(started, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId,
    requestId: 'req-1',
    draftRevision: 0,
    phase: 'store-info',
    reply: '已按你的说法更新门店资料。',
    run: {
      status: 'done',
      durationMs: 1234,
      tools: [{ label: '读取门店资料' }, { label: '更新门店资料' }],
      // 明细不进会话：过程卡只保留标签与耗时。
      trace: { toolCalls: [{ callId: 'call_1', name: 'update_store_draft' }] },
      runId: 'run-9',
    },
  });
  assert.equal(done.agentChat.status, 'idle');
  assert.equal(done.agentChat.activeRequestId, null);
  assert.equal(done.agentChat.requestPhase, null);
  assert.equal(done.agentChat.messages.length, 2);
  assert.equal(done.agentChat.messages[1].role, 'assistant');
  assert.equal(done.agentChat.messages[1].text, '已按你的说法更新门店资料。');
  assert.equal(done.agentChat.messages[1].actionKind, 'app-assistant');
  assert.deepEqual(done.agentChat.lastRun.toolLabels, ['读取门店资料', '更新门店资料']);
  assert.equal(done.agentChat.lastRun.trace, undefined);
  assert.equal(done.agentChat.lastRun.runId, 'run-9');

  // 同一轮的重复成功回调：状态已归 idle，整包忽略，不会追加第二条助手消息。
  const repeated = machine.reducer(done, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId,
    requestId: 'req-1',
    draftRevision: 0,
    phase: 'store-info',
    reply: '又来一条',
  });
  assert.equal(repeated, done);
  assert.equal(repeated.agentChat.messages.length, 2);
});

test('reducer：侧栏来源不再把用户原话与助手回复重复写进主会话', async () => {
  const { machine, state } = await seededProject();
  const before = state.sessions;

  const started = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '把营业时间改成 09:00-22:00',
    requestId: 'sidebar-turn-1',
    draftRevision: state.agent.draftRevision,
    origin: 'sidebar',
  });
  assert.equal(started.agent.status, 'requesting', '侧栏请求仍要推进主状态机');
  assert.deepStrictEqual(started.sessions, before, '侧栏原话不得再追加到中间主会话');

  const done = machine.reducer(started, {
    type: 'AGENT_TURN_SUCCESS',
    requestId: 'sidebar-turn-1',
    draftRevision: started.agent.requestDraftRevision,
    reply: '已把营业时间更新为 09:00-22:00。',
    draft: started.agentDraft,
    origin: 'sidebar',
  });
  assert.deepStrictEqual(done.sessions, before, '侧栏助手回复同样不得写进中间主会话');

  // 主输入框来源行为不变：用户消息仍然进入主会话。
  const mainStarted = machine.reducer(state, {
    type: 'AGENT_TURN_REQUEST',
    utterance: '补充一条营业时间',
    requestId: 'main-turn-1',
    draftRevision: state.agent.draftRevision,
  });
  assert.strictEqual(
    mainStarted.sessions[0].messages.length,
    before[0].messages.length + 1,
    '主输入框的用户消息必须保持原有写入',
  );
});

test('reducer：requesting 期间重复提交与无活动项目都被拒绝', async () => {
  const { machine, state, projectId } = await seededProject();
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-1',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  const doubleSubmit = machine.reducer(started, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-2',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  assert.equal(doubleSubmit, started);

  const noProject = machine.createInitialState();
  const blocked = machine.reducer(noProject, {
    type: 'AGENT_CHAT_REQUEST_START',
    requestId: 'req-9',
    utterance: '补充营业时间',
  });
  assert.equal(blocked, noProject);
  assert.equal(blocked.agentChat.status, 'idle');

  const blankUtterance = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-3',
    utterance: '   ',
  });
  assert.equal(blankUtterance, state);
});

test('reducer：失败保留草稿与用户消息，重试不重复追加用户消息', async () => {
  const { machine, state, projectId } = await seededProject();
  const drafted = machine.reducer(state, { type: 'AGENT_CHAT_DRAFT_SET', value: '顺便把营业时间改成 09:00-22:00' });
  assert.equal(drafted.agentChat.draft, '顺便把营业时间改成 09:00-22:00');

  const started = machine.reducer(drafted, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-fail-1',
    draftRevision: 0,
    utterance: '补充营业时间 10:00-21:00',
  });
  const failed = machine.reducer(started, {
    type: 'AGENT_CHAT_FAILURE',
    projectId,
    requestId: 'req-fail-1',
    draftRevision: 0,
    phase: 'store-info',
    error: { code: 'AGENT_NETWORK', message: '网络开小差了，请重试。', retryable: true, raw: { stack: '...' } },
  });
  assert.equal(failed.agentChat.status, 'failed');
  assert.equal(failed.agentChat.lastError.code, 'AGENT_NETWORK');
  assert.equal(failed.agentChat.lastError.message, '网络开小差了，请重试。');
  assert.equal(failed.agentChat.lastError.raw, undefined, '原始服务端响应不进状态');
  // 草稿与已发消息都保留，重试有据可依。
  assert.equal(failed.agentChat.draft, '顺便把营业时间改成 09:00-22:00');
  assert.equal(failed.agentChat.messages.length, 1);
  assert.equal(failed.agentChat.lastUtterance, '补充营业时间 10:00-21:00');
  assert.equal(failed.agentChat.activeRequestId, null);

  const retried = machine.reducer(failed, {
    type: 'AGENT_CHAT_RETRY_PREPARE',
    projectId,
    requestId: 'req-fail-2',
  });
  assert.equal(retried.agentChat.status, 'requesting');
  assert.equal(retried.agentChat.activeRequestId, 'req-fail-2');
  assert.equal(retried.agentChat.lastError, null);
  assert.equal(retried.agentChat.messages.length, 1, '重试不重复追加用户消息');
  assert.equal(retried.agentChat.lastUtterance, '补充营业时间 10:00-21:00');

  // 上一轮的迟到失败：requestId 已经不是当前挂起的那个，整包忽略。
  const lateOld = machine.reducer(retried, {
    type: 'AGENT_CHAT_FAILURE',
    projectId,
    requestId: 'req-fail-1',
    draftRevision: 0,
    phase: 'store-info',
    error: { code: 'AGENT_NETWORK', message: '迟到的失败' },
  });
  assert.equal(lateOld, retried);

  const retriedDone = machine.reducer(retried, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId,
    requestId: 'req-fail-2',
    phase: 'store-info',
    reply: '重试成功，资料已更新。',
  });
  assert.equal(retriedDone.agentChat.status, 'idle');
  assert.equal(retriedDone.agentChat.messages.length, 2);
  assert.equal(retriedDone.agentChat.messages[1].role, 'assistant');

  // 只允许从失败态重试。
  const notFailed = machine.reducer(retriedDone, { type: 'AGENT_CHAT_RETRY_PREPARE', projectId, requestId: 'req-x' });
  assert.equal(notFailed, retriedDone);
});

test('reducer：清空错误回到 idle，并保留消息', async () => {
  const { machine, state, projectId } = await seededProject();
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-clear-1',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  const failed = machine.reducer(started, {
    type: 'AGENT_CHAT_FAILURE',
    projectId,
    requestId: 'req-clear-1',
    draftRevision: 0,
    phase: 'store-info',
    error: { message: '失败' },
  });
  const cleared = machine.reducer(failed, { type: 'AGENT_CHAT_CLEAR_ERROR' });
  assert.equal(cleared.agentChat.status, 'idle');
  assert.equal(cleared.agentChat.lastError, null);
  assert.equal(cleared.agentChat.messages.length, 1);
  assert.equal(machine.reducer(cleared, { type: 'AGENT_CHAT_CLEAR_ERROR' }), cleared);
});

test('请求防串：项目切换后旧 requestId 的成功/失败都被拒收，且不改动新项目消息', async () => {
  const { machine, state, projectId } = await seededProject('p_old');
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-old',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  assert.equal(started.agentChat.status, 'requesting');

  // 切到另一个项目：在途请求作废，旧项目的消息不跟过来。
  const switched = machine.reducer(started, {
    type: 'PROJECT_OPEN_SUCCESS',
    projectId: 'p_new',
    doc: { schemaVersion: 1 },
  });
  assert.equal(switched.agentChat.status, 'idle');
  assert.equal(switched.agentChat.activeRequestId, null);
  assert.equal(switched.agentChat.activeProjectId, 'p_new');
  assert.deepEqual(switched.agentChat.messages, []);

  // 旧请求的成功回调迟到：状态与消息都不变，并且严格返回同一引用（连 undo 元数据都不碰）。
  const lateSuccess = machine.reducer(switched, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId: 'p_old',
    requestId: 'req-old',
    draftRevision: 0,
    phase: 'store-info',
    reply: '旧项目的迟到回复',
  });
  assert.equal(lateSuccess, switched);
  assert.deepEqual(lateSuccess.agentChat.messages, []);

  const lateFailure = machine.reducer(switched, {
    type: 'AGENT_CHAT_FAILURE',
    projectId: 'p_old',
    requestId: 'req-old',
    draftRevision: 0,
    phase: 'store-info',
    error: { message: '旧项目的迟到失败' },
  });
  assert.equal(lateFailure, switched);
  assert.equal(lateFailure.agentChat.lastError, null);

  // 新项目开了自己的请求：旧 requestId（即使不带 projectId）也不能串进来。
  const newStarted = machine.reducer(switched, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId: 'p_new',
    requestId: 'req-new',
    draftRevision: 0,
    utterance: '新项目的补充说明',
  });
  const crossedSuccess = machine.reducer(newStarted, {
    type: 'AGENT_CHAT_SUCCESS',
    requestId: 'req-old',
    draftRevision: 0,
    phase: 'store-info',
    reply: '串项目的回复',
  });
  assert.equal(crossedSuccess, newStarted);
  assert.equal(crossedSuccess.agentChat.messages.length, 1);

  const crossedFailure = machine.reducer(newStarted, {
    type: 'AGENT_CHAT_FAILURE',
    requestId: 'req-old',
    draftRevision: 0,
    phase: 'store-info',
    error: { message: '串项目的失败' },
  });
  assert.equal(crossedFailure, newStarted);

  // 阶段不再参与拒收：跨阶段到达的合法响应可以落地（这是本功能的核心场景）。
  const crossPhaseAccepted = machine.reducer(newStarted, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId: 'p_new',
    requestId: 'req-new',
    contextRevision: newStarted.project.contentRevision,
    phase: 'template-pick',
    reply: '阶段变化后仍然合法',
  });
  assert.equal(crossPhaseAccepted.agentChat.status, 'idle');
  assert.equal(crossPhaseAccepted.agentChat.messages.length, 2);

  // 项目业务内容版本不匹配同样拒收（请求期间手改业务字段）。
  const wrongRevision = machine.reducer(newStarted, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId: 'p_new',
    requestId: 'req-new',
    contextRevision: newStarted.project.contentRevision + 7,
    phase: 'store-info',
    reply: '版本不匹配',
  });
  assert.equal(wrongRevision, newStarted);
});

test('打开项目把遗留 requesting 归一为 idle，重开不会永久转圈', async () => {
  const { machine, state, projectId } = await seededProject();
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-spin',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  assert.equal(started.agentChat.status, 'requesting');

  // 打开项目请求刚发出：先放弃在途请求（加载期间不该继续显示忙碌）。
  const reopening = machine.reducer(started, { type: 'PROJECT_OPEN_REQUEST' });
  assert.equal(reopening.agentChat.status, 'idle');
  assert.equal(reopening.agentChat.activeRequestId, null);

  // 打开成功：遗留 requesting 一律归 idle，activeRequestId 清空。
  const reopened = machine.reducer(started, {
    type: 'PROJECT_OPEN_SUCCESS',
    projectId,
    doc: { schemaVersion: 1 },
  });
  assert.equal(reopened.agentChat.status, 'idle');
  assert.equal(reopened.agentChat.activeRequestId, null);
  assert.equal(reopened.agentChat.requestDraftRevision, null);
  assert.equal(reopened.agentChat.requestPhase, null);

  // 重置项目、删除活动项目同样不留下在途请求。
  const resetProject = machine.reducer(started, { type: 'RESET_PROJECT' });
  assert.equal(resetProject.agentChat.status, 'idle');
  assert.equal(resetProject.agentChat.activeRequestId, null);
  assert.equal(resetProject.agentChat.activeProjectId, projectId);

  const deleted = machine.reducer(started, { type: 'PROJECT_DELETE_SUCCESS', projectId });
  assert.equal(deleted.agentChat.status, 'idle');
  assert.equal(deleted.agentChat.activeProjectId, null);
  assert.deepEqual(deleted.agentChat.messages, []);
});

test('AGENT_CHAT_HYDRATE 从快照恢复消息，并把状态强制归一为 idle', async () => {
  const { machine, state, projectId } = await seededProject();
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-hydrate',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  const hydrated = machine.reducer(started, {
    type: 'AGENT_CHAT_HYDRATE',
    projectId,
    messages: [
      message({ id: 'restored-1', role: 'user', text: '补充一道菜：宫保鸡丁 28 元' }),
      message({ id: 'restored-2', role: 'assistant', text: '已加入宫保鸡丁。', actionKind: 'store-info' }),
      { id: 'bad', role: 'bot', text: '非法消息' },
    ],
  });
  assert.equal(hydrated.agentChat.status, 'idle');
  assert.equal(hydrated.agentChat.activeRequestId, null);
  assert.equal(hydrated.agentChat.activeProjectId, projectId);
  assert.deepEqual(hydrated.agentChat.messages.map((item) => item.id), ['restored-1', 'restored-2']);

  // 水合后旧请求的回调仍然不能写入。
  const late = machine.reducer(hydrated, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId,
    requestId: 'req-hydrate',
    draftRevision: 0,
    phase: 'store-info',
    reply: '迟到的回复',
  });
  assert.equal(late, hydrated);
});

test('selectAgentChatState 暴露侧栏视图模型且不外泄请求身份', async () => {
  const { machine, state, projectId } = await seededProject();
  const idleView = machine.selectAgentChatState(state);
  assert.equal(idleView.projectId, projectId);
  assert.equal(idleView.phase, 'store-info');
  assert.equal(idleView.busy, false);
  assert.equal(idleView.plan.actionKind, 'app-assistant');
  assert.equal(idleView.activeRequestId, undefined);
  assert.equal(idleView.requestDraftRevision, undefined);

  const drafted = machine.reducer(state, { type: 'AGENT_CHAT_DRAFT_SET', value: '补充营业时间' });
  assert.equal(machine.selectAgentChatState(drafted).canSend, true);
  const blank = machine.reducer(drafted, { type: 'AGENT_CHAT_DRAFT_SET', value: '   ' });
  assert.equal(machine.selectAgentChatState(blank).canSend, false);

  const started = machine.reducer(drafted, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-view',
    draftRevision: 0,
    utterance: '补充营业时间',
  });
  const busyView = machine.selectAgentChatState(started);
  assert.equal(busyView.busy, true);
  assert.equal(busyView.canSend, false);
  assert.equal(busyView.canRetry, false);

  const failed = machine.reducer(started, {
    type: 'AGENT_CHAT_FAILURE',
    projectId,
    requestId: 'req-view',
    draftRevision: 0,
    phase: 'store-info',
    error: { code: 'AGENT_NETWORK', message: '失败' },
  });
  const failedView = machine.selectAgentChatState(failed);
  assert.equal(failedView.status, 'failed');
  assert.equal(failedView.canRetry, true);
  assert.equal(failedView.lastError.code, 'AGENT_NETWORK');

  // 无活动项目时视图模型如实返回「先打开项目」。
  const emptyView = machine.selectAgentChatState(machine.createInitialState());
  assert.equal(emptyView.plan.allowed, false);
  assert.equal(emptyView.canSend, false);
});
test('时间线：本轮结果锚在那一轮之后，新发的消息排在它下面', async () => {
  const { buildAgentChatTimeline } = await loadSidebar();
  const messages = [
    message({ id: 'chat-user-req1', role: 'user', text: '店名改成松月食堂' }),
    message({ id: 'chat-assistant-req1', role: 'assistant', text: '已按你的话整理成提案。' }),
    message({ id: 'chat-user-req2', role: 'user', text: '再把配色换暖一点' }),
  ];
  const timeline = buildAgentChatTimeline({
    messages,
    run: { requestId: 'req1', status: 'done', toolLabels: ['读取项目上下文'] },
    applied: {
      requestId: 'req1',
      appliedRevision: 2,
      entries: [{ fieldId: 'store.name', label: '店名', before: '旧名字', after: '松月食堂' }],
    },
    pending: null,
    stale: null,
  });

  assert.deepEqual(
    timeline.map((item) => item.kind),
    ['message', 'message', 'result', 'message'],
    '结果块必须紧跟那一轮的助手消息，后续新消息排在它下面',
  );
  assert.equal(timeline[2].key, 'result:chat-assistant-req1');
  assert.equal(timeline[2].run.requestId, 'req1');
  assert.equal(timeline[2].applied.requestId, 'req1');
  assert.equal(timeline[3].message.text, '再把配色换暖一点');

  // 再补一轮：新一轮结果落在最新那条消息之后；上一轮的结果是运行态，只保留最近一份。
  const next = buildAgentChatTimeline({
    messages: [...messages, message({ id: 'chat-assistant-req2', role: 'assistant', text: '配色已调整。' })],
    run: { requestId: 'req2', status: 'done', toolLabels: [] },
    applied: { requestId: 'req2', appliedRevision: 3, entries: [] },
    stale: null,
    pending: null,
  });
  assert.deepEqual(
    next.map((item) => item.kind),
    ['message', 'message', 'message', 'message', 'result'],
  );
  assert.equal(next[4].key, 'result:chat-assistant-req2');
});

test('时间线：拿不到 requestId 的结果退回末尾，不丢展示', async () => {
  const { buildAgentChatTimeline } = await loadSidebar();
  const timeline = buildAgentChatTimeline({
    messages: [message({ id: 'chat-user-old', role: 'user', text: '旧消息' })],
    run: null,
    applied: { proposalId: 'proposal_old', appliedRevision: 1, entries: [] },
    pending: { fields: [{ opId: 'op_1', fieldId: 'store.name' }], actions: [] },
    stale: null,
  });
  assert.equal(timeline.length, 2);
  assert.equal(timeline[1].kind, 'result');
  assert.equal(timeline[1].anchorId, null);
});

test('时间线：参考图摘要挂在触发它的那条消息后面', async () => {
  const { buildAgentChatTimeline } = await loadSidebar();
  const timeline = buildAgentChatTimeline({
    messages: [
      message({ id: 'chat-user-req9', role: 'user', text: '照这张图改首页' }),
      message({ id: 'chat-assistant-req9', role: 'assistant', text: '收到，先进候选面板。' }),
    ],
    candidate: { summary: '参考图意图：首页三卡并排' },
    candidateMessageId: 'chat-assistant-req9',
  });
  assert.equal(timeline.length, 3);
  assert.equal(timeline[2].kind, 'result');
  assert.equal(timeline[2].candidate.summary, '参考图意图：首页三卡并排');
  assert.equal(timeline[2].anchorId, 'chat-assistant-req9');
});

// R2 D1：同一轮不再自报冲突，撤销后清理卡片/冲突；未写入路径的冲突必须保留。
test('reducer：写入轮次不报 stale，撤销后清理变更卡，未写入的迟到响应仍报 stale', async () => {
  const { machine, state, projectId } = await seededProject();
  const base = Number.isInteger(state.project.contentRevision) ? state.project.contentRevision : 0;
  const started = machine.reducer(state, {
    type: 'AGENT_CHAT_REQUEST_START',
    projectId,
    requestId: 'req-d1',
    draftRevision: 0,
    contextRevision: base,
    utterance: '联系电话改成 010-88886666',
  });
  const success = (from, requestId) => machine.reducer(from, {
    type: 'AGENT_CHAT_SUCCESS',
    projectId,
    requestId,
    draftRevision: 0,
    phase: started.phase,
    reply: '联系电话已改好。',
    run: { status: 'done', durationMs: 1, tools: [] },
  });

  // 1) 未写入 + 请求期间内容被外部改动：冲突必须保留。
  const changedOutside = { ...started, project: { ...started.project, contentRevision: base + 1 } };
  const staleDone = success(changedOutside, 'req-d1');
  assert.ok(staleDone.agentChat.lastStale, '未写入的轮次遇到外部改动仍要报冲突');
  assert.equal(staleDone.agentChat.lastStale.expectedRevision, base);

  // 2) 本轮自己写入（contentRevision 前进）：不得同时报冲突。
  const appliedState = {
    ...started,
    project: { ...started.project, contentRevision: base + 1 },
    agentChat: {
      ...started.agentChat,
      lastApplied: {
        requestId: 'req-d1',
        proposalId: 'prop-d1',
        appliedRevision: base + 1,
        entries: [{ fieldId: 'store.phone', label: '联系电话', before: '', after: '010-88886666' }],
      },
    },
  };
  const appliedDone = success(appliedState, 'req-d1');
  assert.equal(appliedDone.agentChat.lastStale, null, '本轮写入造成的版本前进不算冲突');
  assert.ok(appliedDone.agentChat.lastApplied);

  // 3) 撤销本轮后：变更卡与冲突状态一起清掉，并记下撤销的是哪一轮。
  const undone = machine.reducer(appliedDone, { type: 'AGENT_CHAT_UNDO_APPLIED', requestId: 'req-d1' });
  assert.equal(undone.agentChat.lastApplied, null);
  assert.equal(undone.agentChat.lastStale, null);
  assert.deepEqual(undone.agentChat.lastUndone, { requestId: 'req-d1' });
});