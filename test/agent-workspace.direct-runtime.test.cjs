'use strict';

/**
 * E0-W2 交付锁：direct 通道的**惰性**装配（desktop/agent-workspace/direct-runtime.cjs）
 * 与 `desktop/main.cjs` 的接线断言。
 *
 * 核心要求（t5 验收 14）：
 * - 接线后 `coordinator.invokeDirect` 不再返回 AGENT_RUNTIME_TOOL_MISSING；
 * - 未接线（directRuntime:null）或未配置凭据时该码仍**显式**（不静默降级、不假成功）；
 * - 请求有界、无绝对路径/base64/密钥；返回值只回 content/finishReason/model，不回密钥。
 *
 * 不联网：传输全部注入替身；不读真实 Key（只读 `status()`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const h = require('./agent-workspace.helpers.cjs');

const REPO = h.REPO;
const PROJECT_ID = 'p_e0w2direct';

const versionsMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'versions.cjs'));
const checksMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'));
const directMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'direct-runtime.cjs'));
const workspaceRuntime = require(path.join(REPO, 'desktop', 'agent-runtime', 'workspace-runtime.cjs'));
const { createRunCoordinator } = require(path.join(REPO, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));

function setup(t) {
  const userDataDir = h.userDataWith(t, 'direct');
  const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, JSON.stringify(init));
  const start = (coordinator) => {
    const run = coordinator.startRun({
      projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '把菜单标题改短',
    });
    assert.strictEqual(run.ok, true, JSON.stringify(run));
    return {
      projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId,
    };
  };
  const make = (directRuntime) => createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime,
    emitProgress: () => {},
  });
  return { userDataDir, start, make };
}

const REQUEST = { messages: [{ role: 'user', content: '把菜单页的副标题改成一句话' }] };

test('direct：未接线 → AGENT_RUNTIME_TOOL_MISSING（显式，不假成功）', async (t) => {
  const { start, make } = setup(t);
  const coordinator = make(null);
  const ctx = start(coordinator);
  const result = await coordinator.invokeDirect({ ...ctx, request: REQUEST });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.code, 'AGENT_RUNTIME_TOOL_MISSING');
});

test('direct：接线后 invokeDirect 正常返回（不是 RUNTIME_TOOL_MISSING），且不回密钥/路径', async (t) => {
  const { start, make } = setup(t);
  const seen = [];
  const transport = async (request, callOptions) => {
    seen.push({ request, callOptions });
    return {
      id: 'chatcmpl-test',
      model: 'deepseek-chat',
      choices: [{ message: { role: 'assistant', content: '好的：把副标题改成“今天想吃什么？”' }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
      // 下游多余字段不得原样穿透：
      apiKey: 'sk-should-never-leak-0001',
      debugPath: 'C:\\Users\\someone\\secret.txt',
    };
  };
  const directRuntime = directMod.createDirectWorkspaceRuntime({
    coordinator: () => coordinator,
    transport,
  });
  const coordinator = make(directRuntime);
  const ctx = start(coordinator);

  const result = await coordinator.invokeDirect({ ...ctx, request: REQUEST });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.notStrictEqual(result.code, 'AGENT_RUNTIME_TOOL_MISSING');
  assert.ok(typeof result.data.content === 'string' && result.data.content.length > 0);
  assert.strictEqual(result.data.finishReason, 'stop');
  assert.strictEqual(result.data.model, 'deepseek-chat');
  const text = JSON.stringify(result);
  assert.ok(!text.includes('sk-should-never-leak'), '不得回传密钥');
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), '不得回传绝对路径');
  // 平台上下文由 coordinator 注入，模型侧看到的 subject 必须是 attempt。
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].callOptions.subject.kind, 'attempt');
  assert.strictEqual(seen[0].callOptions.subject.attemptId, ctx.attemptId);
  assert.deepStrictEqual(seen[0].request.messages, REQUEST.messages);
  assert.deepStrictEqual(directRuntime.describe(), {
    ready: true, hasCoordinator: true, hasTransport: true, defaultTransport: false,
  });
});

test('direct：未配置凭据 / 凭据未接线 → 仍然显式 RUNTIME_TOOL_MISSING', async () => {
  const noCredentials = directMod.createDirectWorkspaceRuntime({ coordinator: () => ({}) });
  assert.deepStrictEqual(noCredentials.describe(), {
    ready: false, hasCoordinator: true, hasTransport: false, defaultTransport: false,
  });
  const ctx = {
    projectId: PROJECT_ID,
    runId: 'frun-x',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    subject: { kind: 'attempt', attemptId: 'attempt-1' },
  };
  const result = await noCredentials.invoke({ context: ctx, request: REQUEST });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'AGENT_RUNTIME_TOOL_MISSING');

  // 凭据层明确 DEEPSEEK_NOT_CONFIGURED → 同样映射成能力缺失（不是假成功、不是空 content）。
  const notConfigured = directMod.createDirectWorkspaceRuntime({
    coordinator: () => ({}),
    credentials: { chat: async () => { const error = new Error('未配置'); error.code = 'DEEPSEEK_NOT_CONFIGURED'; throw error; } },
  });
  const second = await notConfigured.invoke({ context: ctx, request: REQUEST });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, 'AGENT_RUNTIME_TOOL_MISSING');
});

test('direct：请求有界校验（越界/路径/base64/密钥/坏 role）→ PAYLOAD_INVALID，且不发起传输', async () => {
  let calls = 0;
  const runtime = directMod.createDirectWorkspaceRuntime({
    coordinator: () => ({}),
    transport: async () => { calls += 1; return { choices: [] }; },
  });
  const context = {
    projectId: PROJECT_ID,
    runId: 'frun-x',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    subject: { kind: 'attempt', attemptId: 'attempt-1' },
  };
  const bad = [
    undefined,
    {},
    { messages: [] },
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: 42 }] },
    { messages: [{ role: 'user', content: 'C:\\Users\\a\\b.wxml' }] },
    { messages: [{ role: 'user', content: 'data:image/png;base64,AAAA' }] },
    { messages: [{ role: 'user', content: 'key sk-abcdef1234567890' }] },
    { messages: Array.from({ length: directMod.LIMITS.maxMessages + 1 }, () => ({ role: 'user', content: 'x' })) },
    { messages: [{ role: 'user', content: 'x'.repeat(directMod.LIMITS.maxMessageChars + 1) }] },
    { messages: [{ role: 'user', content: 'ok' }], model: 'x'.repeat(200) },
    { messages: [{ role: 'user', content: 'ok' }], temperature: 9 },
  ];
  for (const request of bad) {
    const result = await runtime.invoke({ context, request });
    assert.strictEqual(result.ok, false, JSON.stringify(request));
    assert.strictEqual(result.code, 'AGENT_PAYLOAD_INVALID', JSON.stringify(request));
  }
  assert.strictEqual(calls, 0, '非法请求不得发起传输');
  assert.strictEqual(directMod.normalizeRequest(REQUEST).ok, true);
});

test('main.cjs 产品主链接真正的多轮/多模态 Runtime，而非旧单次聊天适配器', () => {
  const main = fs.readFileSync(path.join(REPO, 'desktop', 'main.cjs'), 'utf8');
  assert.ok(!/directRuntime:\s*null/.test(main), '不得再写死 directRuntime: null');
  assert.ok(main.includes("require('./agent-runtime')"));
  assert.ok(!main.includes("require('./agent-workspace/direct-runtime.cjs')"));
  assert.ok(/directRuntime:\s*createDirectWorkspaceRuntime\(\{/.test(main));
  assert.ok(/coordinator:\s*\(\)\s*=>\s*workspaceRunCoordinator/.test(main), 'coordinator 必须惰性解析');
  assert.ok(/credentials:\s*modelCredentials/.test(main), '凭据必须用主进程唯一实例');
  assert.ok(/userDataDir,/.test(main), '图片资产解析必须由主进程提供 userDataDir');
  assert.ok(/vision:\s*true/.test(main), 'D0 已验证的 Flash 视觉能力必须显式声明');
  // 依赖顺序：modelCredentials 必须在 coordinator 之前定义（否则惰性 getter 拿不到）。
  assert.ok(main.indexOf('const modelCredentials') < main.indexOf('createDirectWorkspaceRuntime({'));
});

test('产品 Runtime：模型工具调用确实回到 Coordinator，而非只发一条文本消息', async (t) => {
  const { start, make, userDataDir } = setup(t);
  let coordinator;
  const calls = [];
  const modelChat = {
    describe: () => ({ supportsVision: true }),
    chat: async (payload) => {
      calls.push(payload);
      if (calls.length === 1) {
        return {
          model: 'deepseek-flash', content: '', finishReason: 'tool_calls', truncated: false,
          toolCalls: [{ id: 'call-read', name: 'read_file', arguments: JSON.stringify({ path: 'pages/menu/index.wxml' }) }],
        };
      }
      return { model: 'deepseek-flash', content: '已读取候选页', finishReason: 'stop', truncated: false, toolCalls: [] };
    },
  };
  const runtime = workspaceRuntime.createDirectWorkspaceRuntime({
    coordinator: () => coordinator, modelChat, userDataDir,
  });
  coordinator = make(runtime);
  const ctx = start(coordinator);
  const result = await coordinator.invokeDirect({ ...ctx, request: { utterance: '先读取菜单页' } });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.data.status, 'completed');
  assert.strictEqual(result.data.reply, '已读取候选页');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(result.data.toolCalls.length, 1);
  assert.strictEqual(result.data.toolCalls[0].name, 'read_file');
  assert.strictEqual(result.data.toolCalls[0].ok, true);
  const toolMessage = calls[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, '第二轮必须回填真实工具结果');
  assert.ok(toolMessage.content.includes('pages/menu/index.wxml'));
});
