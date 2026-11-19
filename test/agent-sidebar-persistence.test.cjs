'use strict';

/**
 * T2：右侧栏「Agent 对话」的项目级会话快照持久化。
 *
 * 断言口径：
 * - project.json 的 `agentChat.messages` 往返保存/恢复保序保内容；
 * - 条数上限 100、单条 5000 字只有 `domain/agentSidebar.mjs` 一份实现；
 * - 运行态（requesting / activeRequestId / lastError 原始响应 / trace / runId）、
 *   图片 base64、本机绝对路径一律不落盘；
 * - 老项目（无 agentChat 字段）恢复为空会话，不报错、不阻塞打开；
 * - 既有 project-snapshot 语义无回归。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');

async function load() {
  const machine = await import(pathToFileURL(path.join(REPO, 'src', 'state', 'sessionMachine.mjs')).href);
  const snapshot = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'projectSnapshot.mjs')).href);
  const sidebar = await import(pathToFileURL(path.join(REPO, 'src', 'domain', 'agentSidebar.mjs')).href);
  return { machine, snapshot, sidebar };
}

const PROJECT_ID = 'p_chat_persist_01';

/** 一份「看起来已经聊过几句」的会话消息（顺序即语义，必须原样往返）。 */
function sampleMessages() {
  return [
    {
      id: 'chat-user-req-1',
      role: 'user',
      text: '把营业时间改成 9:00-22:00',
      createdAt: '2026-11-19T09:00:00Z',
      status: 'done',
      actionKind: 'store-info',
      context: { phase: 'store-info', sessionId: 'session-main' },
    },
    {
      id: 'chat-assistant-req-1',
      role: 'assistant',
      text: '已把营业时间更新为 9:00-22:00，可在门店资料里复核。',
      createdAt: '2026-11-19T09:00:04Z',
      status: 'done',
      actionKind: 'store-info',
      context: { phase: 'store-info', sessionId: 'session-main' },
    },
    {
      id: 'chat-sys-guide-1',
      role: 'system',
      text: '本轮不调用模型，仅给出入口指引，不会修改项目内容。',
      createdAt: '2026-11-19T09:01:00Z',
      status: 'done',
      actionKind: 'guide',
      context: { phase: 'image-review', sessionId: 'session-main' },
    },
  ];
}

/** 带请求运行态的完整内存 state：运行态字段绝不能被序列化进 project.json。 */
function stateWithChat(machine, sidebar, chatOverrides = {}) {
  const base = machine.createInitialState();
  return {
    ...base,
    project: { ...base.project, activeId: PROJECT_ID },
    agentChat: {
      ...sidebar.createEmptyAgentChat(),
      messages: sampleMessages(),
      draft: '还没发出去的半句草稿',
      status: 'requesting',
      activeRequestId: 'req-in-flight-9',
      activeProjectId: PROJECT_ID,
      lastUtterance: '把营业时间改成 9:00-22:00',
      lastError: {
        code: 'AGENT_CHAT_FAILED',
        message: '请求失败，请重试。',
        // 下面这些是服务端原始响应/堆栈之类，绝不能进项目文件。
        response: { raw: 'RAW_RESPONSE_BODY', headers: { authorization: 'Bearer SECRET_TOKEN' } },
        stack: 'Error: boom',
      },
      lastRun: {
        requestId: 'req-in-flight-9',
        actionKind: 'store-info',
        status: 'done',
        durationMs: 1234,
        runId: 'run-abc123',
        trace: [{ tool: 'store.patch', args: { secret: true } }],
        tools: [{ label: '整理门店资料' }],
      },
      requestDraftRevision: 7,
      requestPhase: 'store-info',
      ...chatOverrides,
    },
  };
}

test('往返：project.json 的 agentChat.messages 保序保内容，且只有白名单字段', async () => {
  const { machine, snapshot, sidebar } = await load();
  const state = stateWithChat(machine, sidebar);
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });

  assert.deepStrictEqual(Object.keys(doc.agentChat), ['messages'], 'agentChat 只允许 messages 键');
  const expected = sidebar.normalizeChatMessages(sampleMessages());
  assert.deepStrictEqual(doc.agentChat.messages, expected, '落盘消息应等于领域层规范化结果');
  assert.deepStrictEqual(doc.agentChat.messages.map((message) => message.id), [
    'chat-user-req-1',
    'chat-assistant-req-1',
    'chat-sys-guide-1',
  ], '顺序不能变');

  for (const message of doc.agentChat.messages) {
    assert.deepStrictEqual(
      Object.keys(message).sort(),
      ['actionKind', 'context', 'createdAt', 'id', 'role', 'status', 'text'],
      '单条消息只保留可读字段',
    );
    assert.deepStrictEqual(Object.keys(message.context).sort(), ['phase', 'sessionId'], 'context 只留最小上下文');
  }

  const hydrated = snapshot.fromDocument(doc);
  assert.deepStrictEqual(hydrated.agentChat.messages, doc.agentChat.messages, 'restore 后内容与顺序一致');
  assert.strictEqual(hydrated.agentChat.status, 'idle', '重开后会话回到 idle');
  assert.strictEqual(hydrated.agentChat.activeRequestId, null);
  assert.strictEqual(hydrated.agentChat.draft, '');

  // 二次保存幂等：save → load → save 之后文档不再变化。
  const resaved = snapshot.toDocument(hydrated, { projectId: PROJECT_ID });
  assert.deepStrictEqual(resaved.agentChat, doc.agentChat);
});

test('裁剪：超过 100 条只保留最新 100 条，且两侧（保存/读取）口径一致', async () => {
  const { machine, snapshot, sidebar } = await load();
  const many = Array.from({ length: 120 }, (_, index) => ({
    id: `chat-m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `第 ${index} 条消息`,
    createdAt: '2026-11-19T09:00:00Z',
    status: 'done',
    actionKind: 'guide',
    context: { phase: 'image-review', sessionId: 'session-main' },
  }));
  const state = stateWithChat(machine, sidebar, { messages: many });
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });

  assert.strictEqual(snapshot.AGENT_CHAT_SNAPSHOT_LIMITS.maxMessages, sidebar.CHAT_MESSAGE_LIMIT);
  assert.strictEqual(doc.agentChat.messages.length, sidebar.CHAT_MESSAGE_LIMIT);
  assert.strictEqual(doc.agentChat.messages[0].text, '第 20 条消息');
  assert.strictEqual(doc.agentChat.messages[99].text, '第 119 条消息');

  const hydrated = snapshot.fromDocument(doc);
  assert.strictEqual(hydrated.agentChat.messages.length, sidebar.CHAT_MESSAGE_LIMIT);
  assert.deepStrictEqual(hydrated.agentChat.messages, doc.agentChat.messages);
});

test('裁剪：单条超长正文按 5000 字截断，保存与读取复用同一份上限', async () => {
  const { machine, snapshot, sidebar } = await load();
  const longText = 'あ'.repeat(sidebar.CHAT_MESSAGE_MAX_CHARS + 1000);
  const state = stateWithChat(machine, sidebar, {
    messages: [{
      id: 'chat-long',
      role: 'user',
      text: longText,
      createdAt: '2026-11-19T09:00:00Z',
      status: 'done',
      actionKind: 'guide',
      context: { phase: 'image-review', sessionId: 'session-main' },
    }],
  });

  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });
  assert.strictEqual(snapshot.AGENT_CHAT_SNAPSHOT_LIMITS.maxMessageChars, sidebar.CHAT_MESSAGE_MAX_CHARS);
  assert.strictEqual(doc.agentChat.messages[0].text.length, sidebar.CHAT_MESSAGE_MAX_CHARS);
  assert.strictEqual(doc.agentChat.messages[0].text, longText.slice(0, sidebar.CHAT_MESSAGE_MAX_CHARS));

  const hydrated = snapshot.fromDocument(doc);
  assert.strictEqual(hydrated.agentChat.messages[0].text, doc.agentChat.messages[0].text);
});

test('过滤：非法角色/状态/动作类型与空正文不会落盘，也不会在恢复时冒出来', async () => {
  const { machine, snapshot, sidebar } = await load();
  const dirty = [
    { id: 'bad-role', role: 'admin', text: '越权角色', status: 'done', actionKind: 'guide' },
    { id: 'bad-status', role: 'user', text: '请求中', status: 'requesting', actionKind: 'store-info' },
    { id: 'bad-action', role: 'user', text: '未知动作', status: 'done', actionKind: 'teleport' },
    { id: 'empty-text', role: 'user', text: '   ', status: 'done', actionKind: 'guide' },
    { id: 'not-string-text', role: 'user', text: 42, status: 'done', actionKind: 'guide' },
    'not-an-object',
    null,
    { id: 'ok-message', role: 'user', text: '这条是有效的', status: 'done', actionKind: 'guide', context: {} },
  ];
  const state = stateWithChat(machine, sidebar, { messages: dirty });
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });

  assert.deepStrictEqual(doc.agentChat.messages.map((message) => message.id), ['ok-message']);
  assert.deepStrictEqual(doc.agentChat.messages[0].context, { phase: null, sessionId: null });

  const hydrated = snapshot.fromDocument(doc);
  assert.deepStrictEqual(hydrated.agentChat.messages.map((message) => message.id), ['ok-message']);

  // 恢复侧同样过滤：被手工塞进 project.json 的脏数据不会进内存。
  const tampered = snapshot.fromDocument({ ...doc, agentChat: { messages: dirty } });
  assert.deepStrictEqual(tampered.agentChat.messages.map((message) => message.id), ['ok-message']);
});

test('老项目兼容：没有 agentChat 字段时恢复为空会话，不抛错、不阻塞打开', async () => {
  const { machine, snapshot, sidebar } = await load();
  const state = stateWithChat(machine, sidebar);
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });
  const legacy = { ...doc };
  delete legacy.agentChat;

  const hydrated = snapshot.fromDocument(legacy);
  assert.deepStrictEqual(hydrated.agentChat, sidebar.createEmptyAgentChat(), '老项目得到空会话');
  // 不影响其它切片：项目照常打开。
  assert.strictEqual(hydrated.project.activeId, PROJECT_ID);
  assert.strictEqual(hydrated.agentChat.messages.length, 0);

  // 极端输入也不抛错。
  for (const input of [null, {}, { agentChat: null }, { agentChat: 42 }, { agentChat: { messages: 'x' } }]) {
    const restored = snapshot.fromDocument(input);
    assert.deepStrictEqual(restored.agentChat, sidebar.createEmptyAgentChat());
  }
});

test('安全：requesting / activeRequestId / trace / runId / base64 / 绝对路径都不进序列化结果', async () => {
  const { machine, snapshot, sidebar } = await load();
  const base64Text = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk'.repeat(5);
  const state = stateWithChat(machine, sidebar, {
    messages: [
      ...sampleMessages(),
      {
        id: 'chat-image',
        role: 'user',
        text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        createdAt: '2026-11-19T09:02:00Z',
        status: 'done',
        actionKind: 'frontend-reconstruct',
        context: { phase: 'image-review', sessionId: 'session-main' },
      },
      {
        id: 'chat-base64',
        role: 'user',
        text: base64Text,
        createdAt: '2026-11-19T09:03:00Z',
        status: 'done',
        actionKind: 'guide',
        context: { phase: 'image-review', sessionId: 'session-main' },
      },
      {
        id: 'chat-path',
        role: 'assistant',
        text: '导出结果在 E:\\智能开店app\\out\\songyue 目录',
        createdAt: '2026-11-19T09:04:00Z',
        status: 'done',
        actionKind: 'guide',
        context: { phase: 'image-review', sessionId: 'session-main' },
      },
      {
        id: 'chat-context-dirty',
        role: 'assistant',
        text: '这条正文干净，但 context 里塞了运行态。',
        createdAt: '2026-11-19T09:05:00Z',
        status: 'done',
        actionKind: 'store-info',
        context: {
          phase: 'store-info',
          sessionId: 'session-main',
          trace: [{ tool: 'store.patch' }],
          runId: 'run-abc123',
          prompt: '把门店资料改一遍',
        },
      },
    ],
  });
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });
  const chatJson = JSON.stringify(doc.agentChat);
  const docJson = JSON.stringify(doc);

  // 大体积/敏感正文的气泡整条丢弃；context 里的运行态字段被剥掉但消息本身保留。
  assert.deepStrictEqual(doc.agentChat.messages.map((message) => message.id), [
    'chat-user-req-1',
    'chat-assistant-req-1',
    'chat-sys-guide-1',
    'chat-context-dirty',
  ]);
  assert.deepStrictEqual(doc.agentChat.messages[3].context, { phase: 'store-info', sessionId: 'session-main' });

  for (const forbidden of [
    'activeRequestId',
    'requesting',
    'trace',
    'runId',
    'run-abc123',
    'req-in-flight-9',
    'RAW_RESPONSE_BODY',
    'SECRET_TOKEN',
    'base64',
    'data:image',
    'E:\\',
    'lastError',
    'lastRun',
    'requestDraftRevision',
    'requestPhase',
    'draft',
  ]) {
    assert.strictEqual(chatJson.includes(forbidden), false, `agentChat 序列化结果不得包含 ${forbidden}`);
  }
  // 整份文档层面：运行态与绝对路径同样不出现（初始 state 的 deploy/visual 均为空。
  for (const forbidden of ['activeRequestId', '"requesting"', 'RAW_RESPONSE_BODY', 'base64', 'E:\\']) {
    assert.strictEqual(docJson.includes(forbidden), false, `project.json 不得包含 ${forbidden}`);
  }

  assert.strictEqual(snapshot.isChatMessageSafeForSnapshot('把营业时间改成 9:00-22:00'), true);
  assert.strictEqual(snapshot.isChatMessageSafeForSnapshot('data:image/png;base64,AAAA'), false);
  assert.strictEqual(snapshot.isChatMessageSafeForSnapshot(base64Text), false);
  assert.strictEqual(snapshot.isChatMessageSafeForSnapshot('导出结果在 C:\\Users\\me\\out'), false);
});

test('白名单登记：agentChat 是已知顶层键，不会被搬进 unmappedFields', async () => {
  const { machine, snapshot, sidebar } = await load();
  assert.ok(snapshot.KNOWN_TOP_KEYS.includes('agentChat'));
  assert.deepStrictEqual(snapshot.AGENT_CHAT_SNAPSHOT_KEYS, ['messages']);

  const doc = snapshot.toDocument(stateWithChat(machine, sidebar), { projectId: PROJECT_ID });
  assert.deepStrictEqual(snapshot.collectUnknown(doc), {}, 'agentChat 不能被当成未知字段');
  assert.strictEqual(snapshot.fromDocument(doc).unmappedFields.agentChat, undefined);
});

test('旧版误存进 unmappedFields 的 agentChat：打开项目后仍能恢复历史', async () => {
  const { snapshot, sidebar } = await load();
  const legacy = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    // 旧版主进程白名单漏了 agentChat，这段历史曾整体被搬到 unmappedFields。
    unmappedFields: { agentChat: { messages: sampleMessages() } },
  };
  const hydrated = snapshot.fromDocument(legacy);
  assert.deepStrictEqual(
    hydrated.agentChat.messages,
    sidebar.normalizeChatMessages(sampleMessages()),
    '顶层缺失时必须尝试从 unmappedFields 迁移，而不是直接清空',
  );
});

test('接线：save → project.json → PROJECT_OPEN_SUCCESS 后侧栏会话消息与快照一致', async () => {
  const { machine, snapshot, sidebar } = await load();
  const saved = stateWithChat(machine, sidebar);
  const doc = snapshot.toDocument(saved, { projectId: PROJECT_ID });

  const fresh = machine.reducer(machine.createInitialState(), {
    type: 'PROJECT_OPEN_SUCCESS',
    projectId: PROJECT_ID,
    doc,
  });

  assert.deepStrictEqual(fresh.agentChat.messages, doc.agentChat.messages, '打开项目后消息原样恢复');
  assert.deepStrictEqual(fresh.agentChat.messages.map((message) => message.id), [
    'chat-user-req-1',
    'chat-assistant-req-1',
    'chat-sys-guide-1',
  ]);
  assert.strictEqual(fresh.agentChat.status, 'idle', '重开项目不会继承 requesting');
  assert.strictEqual(fresh.agentChat.activeRequestId, null);
  assert.strictEqual(fresh.agentChat.activeProjectId, PROJECT_ID);

  // 老项目（无 agentChat）打开后同样是空会话，不报错。
  const legacyDoc = { ...doc };
  delete legacyDoc.agentChat;
  const legacyState = machine.reducer(machine.createInitialState(), {
    type: 'PROJECT_OPEN_SUCCESS',
    projectId: PROJECT_ID,
    doc: legacyDoc,
  });
  assert.deepStrictEqual(legacyState.agentChat.messages, []);
  assert.strictEqual(legacyState.project.activeId, PROJECT_ID);
});

test('无回归：既有 project-snapshot 字段与语义保持不变', async () => {
  const { machine, snapshot, sidebar } = await load();
  const state = stateWithChat(machine, sidebar);
  const doc = snapshot.toDocument(state, { projectId: PROJECT_ID });

  // schemaVersion 语义不变；agent 运行态仍然不进文档。
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(snapshot.SNAPSHOT_SCHEMA_VERSION, 1);
  assert.strictEqual(doc.agent, undefined);
  assert.deepStrictEqual(snapshot.PRESENTATION_SNAPSHOT_KEYS, ['templateId', 'patch']);
  assert.deepStrictEqual(Object.keys(doc.deploy).sort(), ['directory', 'handoff', 'projectName', 'resultDigest']);
  assert.deepStrictEqual(Object.keys(doc.presentation).sort(), ['patch', 'templateId']);
  assert.strictEqual(snapshot.MAX_MESSAGES, 200);

  // 会话消息裁剪仍是 200 条（与 agentChat 的 100 条互不影响）。
  const base = machine.createInitialState();
  const manyMessages = Array.from({ length: 260 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index === 0 ? 'agent' : 'user',
    text: index === 0 ? '命名引导' : `消息 ${index}`,
    meta: null,
  }));
  const sessionsDoc = snapshot.toDocument({
    ...base,
    project: { ...base.project, activeId: PROJECT_ID },
    sessions: [{ ...base.sessions[0], messages: manyMessages }],
  }, { projectId: PROJECT_ID });
  assert.strictEqual(sessionsDoc.sessions[0].messages.length, 200);
  assert.strictEqual(sessionsDoc.sessions[0].messages[0].text, '命名引导');
  assert.strictEqual(sessionsDoc.sessions[0].messages[199].text, '消息 259');
  assert.deepStrictEqual(sessionsDoc.agentChat.messages, [], '没有会话切片时 agentChat 是空消息列表');

  // 其它切片往返不受影响。
  const hydrated = snapshot.fromDocument(doc);
  assert.deepStrictEqual(hydrated.store, doc.store);
  assert.deepStrictEqual(hydrated.features, doc.features);
  assert.deepStrictEqual(hydrated.agentDraft, doc.agentDraft);
  assert.deepStrictEqual(hydrated.sessions, snapshot.fromDocument(snapshot.toDocument(hydrated, { projectId: PROJECT_ID })).sessions);
});
