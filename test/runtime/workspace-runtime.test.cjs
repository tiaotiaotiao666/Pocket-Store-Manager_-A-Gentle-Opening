'use strict';

/**
 * E0-R1：direct Workspace Runtime（X8 / X9）。
 *
 * 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.3 / §14.7 / §14.9。
 * 全部用 fake 模型 + fake Coordinator（不跑真实上游，也不碰真实 userData）：
 * - tool_calls → `coordinator.invokeTool` 的唯一出口，assistant/tool 消息回填，多轮推进到 stop；
 * - 平台专用名/未知名 → AGENT_TOOL_NOT_ALLOWED，且不触达 Coordinator、不再发起上游调用；
 * - truncated（有/无 tool_calls、空正文 + finish_reason=length）→ 本批工具零执行 + output_truncated；
 * - 预算（模型次数/工具次数/墙钟）与 loop detection；
 * - 取消后不再发起上游调用、迟到结果不入库；
 * - 安全 trace（无 prompt/reply/参数/data:image/sk-）与 X9（reply 原样透传，状态只来自证据）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const runtime = require('../../desktop/agent-runtime');
const {
  createDirectWorkspaceRuntime,
  buildToolDefinitions,
  deriveStatusFromEvidence,
  RUNTIME_CODES,
  MODEL_TOOL_NAMES,
  PLATFORM_ONLY_TOOL_NAMES,
  MAX_TOKENS,
} = runtime;

const RUNTIME_DIR = path.resolve(__dirname, '..', '..', 'desktop', 'agent-runtime');
const CONTEXT = Object.freeze({
  projectId: 'proj-r1',
  runId: 'frun-1',
  turnId: 'fturn-1',
  attemptId: 'att-1',
  subject: { kind: 'attempt', attemptId: 'att-1' },
});

/* ------------------------------ 夹具 ------------------------------ */

/** 脚本化 fake model：按顺序返回预设补全（耗尽后报错，避免“悄悄多调一轮”）。 */
function makeModelChat(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    describe: () => ({ transport: 'direct', wired: true }),
    chat: async (payload) => {
      calls.push(payload);
      const step = script[index];
      index += 1;
      if (!step) throw new Error('fake model 脚本已耗尽（第 ' + index + ' 次调用）');
      if (typeof step.beforeReturn === 'function') step.beforeReturn(payload);
      return {
        model: 'fake-model',
        content: typeof step.content === 'string' ? step.content : '',
        toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls : [],
        usage: step.usage || { promptTokens: 10, completionTokens: 5 },
        finishReason: step.finishReason === undefined ? 'stop' : step.finishReason,
        truncated: step.truncated === true || step.finishReason === 'length',
        maxTokens: 6000,
        profile: 'direct-edit',
      };
    },
  };
}

/** fake Coordinator：只记录 invokeTool 入参，返回脚本化 envelope。 */
function makeCoordinator(options) {
  const opts = options || {};
  const calls = [];
  let activeChecks = 0;
  return {
    calls,
    get activeChecks() {
      return activeChecks;
    },
    invokeTool: async (input) => {
      calls.push(input);
      if (typeof opts.invoke === 'function') return opts.invoke(input, calls.length);
      return { ok: true, data: { echoed: input.tool } };
    },
    assertRunActive: () => {
      activeChecks += 1;
      if (typeof opts.assertRunActive === 'function') return opts.assertRunActive(activeChecks);
      return { ok: true };
    },
  };
}

function toolCall(id, name, args) {
  return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) };
}

function makeRuntime(options) {
  const opts = options || {};
  return createDirectWorkspaceRuntime({
    coordinator: opts.coordinator === undefined ? makeCoordinator() : opts.coordinator,
    modelChat: opts.modelChat,
    systemPrompt: opts.systemPrompt,
    limits: opts.limits,
    clock: opts.clock,
  });
}

/* --------------------------- 1. 多轮 tool_calls --------------------------- */

test('多轮 tool_calls → coordinator.invokeTool，assistant + tool 消息回填，stop 收尾', async () => {
  const modelChat = makeModelChat([
    {
      content: '',
      toolCalls: [toolCall('c1', 'get_context', {}), toolCall('c2', 'write_files', { changes: [{ path: 'pages/home/a.wxml', content: '<view/>' }] })],
    },
    { content: '已改好首页，请跑一次 source.check。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });

  const result = await run.invoke({ context: CONTEXT, request: { utterance: '把首页标题换掉' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'completed');
  assert.equal(result.data.stopReason, 'final_answer');
  assert.equal(result.data.reply, '已改好首页，请跑一次 source.check。');
  assert.equal(result.data.modelCalls, 2);

  // 唯一执行入口：两次工具调用都进了 Coordinator.invokeTool，参数是解析后的对象。
  assert.equal(coordinator.calls.length, 2);
  assert.deepEqual(coordinator.calls.map((call) => call.tool), ['get_context', 'write_files']);
  assert.deepEqual(coordinator.calls[1].args, { changes: [{ path: 'pages/home/a.wxml', content: '<view/>' }] });
  assert.equal(coordinator.calls[1].projectId, CONTEXT.projectId);
  assert.equal(coordinator.calls[1].runId, CONTEXT.runId);
  assert.equal(coordinator.calls[1].turnId, CONTEXT.turnId);
  assert.equal(coordinator.calls[1].attemptId, CONTEXT.attemptId);

  // 第二轮必须看到回填的 assistant.tool_calls + 两条 tool 结果。
  const second = modelChat.calls[1];
  const assistant = second.messages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
  assert.ok(assistant, 'assistant.tool_calls 必须回填');
  assert.equal(assistant.tool_calls.length, 2);
  const toolMessages = second.messages.filter((message) => message.role === 'tool');
  assert.deepEqual(toolMessages.map((message) => message.tool_call_id), ['c1', 'c2']);
  for (const message of toolMessages) {
    const body = JSON.parse(message.content);
    assert.equal(body.ok, true);
  }

  // trace 形状：name/ok/latencyMs/字节数 + 计数，不含正文与参数。
  assert.equal(result.data.toolCalls.length, 2);
  for (const trace of result.data.toolCalls) {
    assert.deepEqual(Object.keys(trace).sort(), [
      'attempts', 'callId', 'inputBytes', 'latencyMs', 'name', 'ok', 'outputBytes', 'truncated',
    ]);
  }
});

test('工具返回 ok:false 时回填 error.code，并继续下一轮（模型可自我修正）', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'read_file', { path: '../escape.js' })] },
    { content: '路径不合法，我改用 pages/home/a.wxml。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    invoke: () => ({ ok: false, code: 'AGENT_PATH_INVALID', message: '路径越界' }),
  });
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.toolCalls[0].ok, false);
  assert.equal(result.data.toolCalls[0].errorCode, 'AGENT_PATH_INVALID');
  const toolMessage = modelChat.calls[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).error.code, 'AGENT_PATH_INVALID');
});

/* ---------------------- 2. 工具面：只允许 11 个 ---------------------- */

test('模型调用平台专用工具 → AGENT_TOOL_NOT_ALLOWED，且不触达 Coordinator、不再发第二轮', async () => {
  for (const name of PLATFORM_ONLY_TOOL_NAMES) {
    const modelChat = makeModelChat([{ content: '', toolCalls: [toolCall('c1', name, {})] }]);
    const coordinator = makeCoordinator();
    const run = makeRuntime({ coordinator, modelChat });
    const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

    assert.equal(result.ok, false, name);
    assert.equal(result.code, RUNTIME_CODES.TOOL_NOT_ALLOWED, name);
    assert.match(result.message, /平台专用工具/);
    assert.equal(coordinator.calls.length, 0, name + ' 不得触达 Coordinator');
    assert.equal(modelChat.calls.length, 1, name + ' 不得再发起上游调用');
  }
});

test('未登记工具名（write_file/shell/exec）→ AGENT_TOOL_NOT_ALLOWED', async () => {
  for (const name of ['write_file', 'shell', 'exec', 'child_process']) {
    const modelChat = makeModelChat([{ content: '', toolCalls: [toolCall('c1', name, {})] }]);
    const coordinator = makeCoordinator();
    const run = makeRuntime({ coordinator, modelChat });
    const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
    assert.equal(result.code, RUNTIME_CODES.TOOL_NOT_ALLOWED, name);
    assert.equal(coordinator.calls.length, 0, name);
  }
});

test('模型工具列表恰好是 §14.3 的 11 个，且不含平台专用名', async () => {
  const tools = buildToolDefinitions();
  assert.equal(tools.length, 11);
  assert.deepEqual(tools.map((tool) => tool.function.name), MODEL_TOOL_NAMES.slice());
  for (const name of PLATFORM_ONLY_TOOL_NAMES) {
    assert.ok(!tools.some((tool) => tool.function.name === name), name + ' 不得出现在模型工具列表');
  }
  const described = makeRuntime().describe();
  assert.deepEqual(described.toolNames, MODEL_TOOL_NAMES.slice());
  assert.equal(described.transport, 'direct');
  assert.deepEqual(described.maxTokens, { default: 6000, max: 8000 });
  assert.equal(described.available, true);
});

/* ------------------------- 3. 截断（X8 核心） ------------------------- */

test('截断（正文 + finish_reason=length）→ output_truncated，本批工具零执行', async () => {
  const modelChat = makeModelChat([{ content: '只写了一 half 的源码', finishReason: 'length' }]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.OUTPUT_TRUNCATED);
  assert.equal(result.data.status, 'output_truncated');
  assert.equal(result.data.retryable, true);
  assert.equal(result.data.toolCalls.length, 0);
  assert.equal(coordinator.calls.length, 0, '截断时不得写入工作树');
  assert.equal(modelChat.calls.length, 1, '截断后不得再发起上游调用');
  assert.equal(result.data.steps[0].truncated, true);
});

test('截断 + 带 tool_calls → 立即停止本批（工具一个都不执行）', async () => {
  const modelChat = makeModelChat([{
    content: '部分正文',
    finishReason: 'length',
    toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'a.wxml', content: '<view/>' }] })],
  }]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.code, RUNTIME_CODES.OUTPUT_TRUNCATED);
  assert.equal(coordinator.calls.length, 0, '截断批的 tool_calls 一律不执行');
  assert.equal(result.data.toolCalls.length, 0);
});

test('空正文 + finish_reason=length → truncated（不得当成“无响应”）', async () => {
  const modelChat = makeModelChat([{ content: '', finishReason: 'length' }]);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '看图改首页' } });

  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.OUTPUT_TRUNCATED);
  assert.equal(result.data.status, 'output_truncated');
  // 不是 empty_reply、也不是“跑完但没有回复”。
  assert.notEqual(result.data.stopReason, 'empty_reply');
  assert.equal(modelChat.calls.length, 1);
});

/* --------------------- 4. 预算与 loop detection --------------------- */

test('预算：模型调用次数上限 → max_model_calls（不再发起第 N+1 次）', async () => {
  const script = [
    { content: '', toolCalls: [toolCall('c1', 'get_context', {})] },
    { content: '', toolCalls: [toolCall('c2', 'list_files', {})] },
    { content: '', toolCalls: [toolCall('c3', 'get_diff', {})] },
  ];
  const modelChat = makeModelChat(script);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat, limits: { maxModelCalls: 2 } });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.stopReason, 'max_model_calls');
  assert.equal(result.data.status, 'limit_reached');
  assert.equal(result.data.degraded, true);
  assert.equal(modelChat.calls.length, 2);
});

test('预算：工具次数上限 → max_tool_calls（超限那批不执行）', async () => {
  const modelChat = makeModelChat([{
    content: '',
    toolCalls: [toolCall('c1', 'get_context', {}), toolCall('c2', 'list_files', {}), toolCall('c3', 'get_diff', {})],
  }]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat, limits: { maxToolCalls: 2 } });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.data.stopReason, 'max_tool_calls');
  assert.equal(coordinator.calls.length, 0);
});

test('loop detection：同一工具 + 同一参数第 3 次 → loop_detected', async () => {
  const same = () => ({ content: '', toolCalls: [toolCall('c-' + Math.random(), 'read_file', { path: 'app.js' })] });
  const modelChat = makeModelChat([same(), same(), same(), same()]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.data.stopReason, 'loop_detected');
  assert.equal(modelChat.calls.length, 3, '第 3 轮就判死循环');
  assert.equal(coordinator.calls.length, 2, '被判死循环的那一批不执行');
});

test('墙钟预算 → time_limit', async () => {
  let now = 0;
  const clock = () => now;
  const modelChat = {
    calls: [],
    chat: async (payload) => {
      modelChat.calls.push(payload);
      now += 60_000;
      return { model: 'fake', content: '', toolCalls: [toolCall('c1', 'get_context', {})], usage: null, finishReason: 'tool_calls', truncated: false };
    },
  };
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat, clock, limits: { maxWallClockMs: 5_000 } });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(result.data.stopReason, 'time_limit');
});

/* ----------------------------- 5. 取消 ----------------------------- */

test('取消（signal 已 abort）→ 不发起任何上游调用', async () => {
  const controller = new AbortController();
  controller.abort();
  const modelChat = makeModelChat([{ content: '不该到这里' }]);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x', signal: controller.signal } });

  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.CANCELLED);
  assert.equal(modelChat.calls.length, 0);
});

test('取消（Coordinator.assertRunActive 拒绝）→ 不发起上游调用', async () => {
  const modelChat = makeModelChat([{ content: '不该到这里' }]);
  const coordinator = makeCoordinator({ assertRunActive: () => ({ ok: false, code: 'AGENT_CANCELLED', message: 'run 已取消' }) });
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(result.code, RUNTIME_CODES.CANCELLED);
  assert.equal(modelChat.calls.length, 0);
});

test('取消发生在模型返回后 → 迟到结果丢弃，工具零执行、不再发起上游调用', async () => {
  const controller = new AbortController();
  const modelChat = makeModelChat([{
    content: '迟到的回复',
    toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'a.wxml', content: 'x' }] })],
    beforeReturn: () => controller.abort(),
  }]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x', signal: controller.signal } });

  assert.equal(result.code, RUNTIME_CODES.CANCELLED);
  assert.equal(coordinator.calls.length, 0, '迟到结果不得落盘');
  assert.equal(modelChat.calls.length, 1);
  assert.equal(result.data.status, 'aborted');
});

test('取消发生在工具执行前（工具之间）→ 后续工具不执行', async () => {
  let checksAfterFirstTool = 0;
  const modelChat = makeModelChat([{
    content: '',
    toolCalls: [toolCall('c1', 'get_context', {}), toolCall('c2', 'write_files', { changes: [{ path: 'a.wxml', content: 'x' }] })],
  }]);
  const coordinator = makeCoordinator({
    invoke: () => ({ ok: true, data: {} }),
    // gate 调用次序：① 起始 ② 每轮上游调用前 ③ 上游返回后 ④ 每个工具前。
    // 让前 4 次通过（含第一个工具），第 5 次（第二个工具前）返回取消。
    assertRunActive: () => {
      checksAfterFirstTool += 1;
      return checksAfterFirstTool <= 4 ? { ok: true } : { ok: false, code: 'AGENT_CANCELLED', message: 'run 已取消' };
    },
  });
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.code, RUNTIME_CODES.CANCELLED);
  assert.equal(coordinator.calls.length, 1, '取消后第二个工具不得执行');
});

/* --------------------------- 6. 安全 trace --------------------------- */

test('trace 不含 prompt / reply / 工具参数 / 图片 data URL / Key', async () => {
  const utterance = '把首页标题改成「源麦甜秘制」，密钥 sk-test-0123456789abcdef';
  const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'read_file', { path: 'pages/home/index.wxml' })] },
    { content: '改好了', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    invoke: () => ({ ok: true, data: { content: 'SOURCE BODY ' + imageDataUrl } }),
  });
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance } });

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('sk-test-0123456789abcdef'), 'trace 不得含 Key');
  assert.ok(!serialized.includes('data:image'), 'trace 不得含图片 data URL');
  assert.ok(!serialized.includes('源麦甜秘制'), 'trace 不得含 prompt 原文');
  assert.ok(!serialized.includes('SOURCE BODY'), 'trace 不得含工具返回正文');
  assert.ok(!serialized.includes('base64'), 'trace 不得含 base64');
  // 但 reply 字段本身是模型回复（允许），tool 正文只回填给模型、不进 trace.data.toolCalls
  for (const trace of result.data.toolCalls) {
    assert.ok(!JSON.stringify(trace).includes('index.wxml'), 'trace 不得含工具参数');
  }
  assert.equal(result.data.reply, '改好了');
});

test('工具返回超大正文时只回填占位符并标 truncated', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'read_file', { path: 'a.js' })] },
    { content: '好', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    invoke: () => ({ ok: true, data: { content: 'x'.repeat(64 * 1024) } }),
  });
  const run = makeRuntime({ coordinator, modelChat, limits: { maxToolResultBytes: 1024 } });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.data.toolCalls[0].truncated, true);
  const toolMessage = modelChat.calls[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /tool_result_truncated/);
  assert.ok(toolMessage.content.length < 2048);
});

/* ------------------------------ 7. X9 ------------------------------ */

test('X9：reply 原样透传（不把「已采用/已验证」改写成「待本地确认」）', async () => {
  const claim = '已采用并通过验证，源码已导出到工作区。';
  const modelChat = makeModelChat([{ content: claim, finishReason: 'stop' }]);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(result.data.reply, claim);
  assert.ok(!result.data.reply.includes('待本地确认'), '不得做伪状态改写');
});

test('X9：adopted/verified/exported 只来自本地证据，与 reply 无关', async () => {
  assert.deepEqual(deriveStatusFromEvidence({ status: 'PASS', adopted: true, exported: true }), {
    adopted: true,
    verified: true,
    exported: true,
    status: 'PASS',
  });
  assert.deepEqual(deriveStatusFromEvidence({ status: 'BLOCKED' }), {
    adopted: false,
    verified: false,
    exported: false,
    status: 'BLOCKED',
  });
  // 空证据 = 全部 false（模型说自己“已验证”不算）。
  assert.deepEqual(deriveStatusFromEvidence(null), { adopted: false, verified: false, exported: false, status: 'NOT_RUN' });
  // 非法状态值不放大成 PASS。
  assert.equal(deriveStatusFromEvidence({ status: 'partial' }).status, 'NOT_RUN');
});

test('X9/X2 源码断言：agent-runtime 不写盘（仅 images.cjs 只读资产），也没有伪状态改写', () => {
  const files = fs.readdirSync(RUNTIME_DIR).filter((name) => name.endsWith('.cjs'));
  assert.ok(files.length >= 5, '至少要包含 runtime/model-chat/tools/http-bridge/constants');
  // X2（§14.8）之后唯一的例外：images.cjs 要按 assetId 只读项目资产（写入永远发生在 Coordinator）。
  const READ_ONLY_FS_ALLOWED = new Set(['images.cjs']);
  const WRITE_APIS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmdir|rmdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|chmod|chmodSync|createWriteStream|openSync|writeSync|fs\.promises)\b/;
  for (const name of files) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
    assert.ok(!source.includes('待本地确认'), name + ' 不得含「待本地确认」改写');
    assert.ok(!/replace\([^)]*已采用/.test(source), name + ' 不得把「已采用」正则替换');
    assert.ok(!/FORBIDDEN_CLAIM/.test(source), name + ' 不得有 claim 白名单正则');
    // 第二套状态链的典型迹象：本模块自己写文件 / 起子进程 / 走 shell。
    assert.ok(!WRITE_APIS.test(source), name + ' 不得写盘（落盘只在 Coordinator）');
    const requiresFs = /require\(['"](node:)?fs(\/promises)?['"]\)/.test(source);
    if (READ_ONLY_FS_ALLOWED.has(name)) {
      assert.ok(requiresFs, name + ' 应只读资产（§14.8 要求从 assetId 派生路径）');
    } else {
      assert.ok(!requiresFs, name + ' 不得读文件（资产解析只允许在 images.cjs）');
    }
    assert.ok(!/require\(['"](node:)?(child_process|node:child_process)['"]\)/.test(source), name + ' 不得起子进程');
    assert.ok(!/\bexecSync\b|\bspawnSync\b/.test(source), name + ' 不得同步执行命令');
  }
});

test('省略 Coordinator 时可用惰性 `() => coordinator`（main.cjs 注入顺序友好）', async () => {
  const coordinator = makeCoordinator();
  const modelChat = makeModelChat([{ content: '延迟解析也正常', finishReason: 'stop' }]);
  const run = createDirectWorkspaceRuntime({ coordinator: () => coordinator, modelChat });
  assert.equal(run.describe().available, true);
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.reply, '延迟解析也正常');
  // 惰性返回 null → 仍然是 AGENT_RUNTIME_TOOL_MISSING，而不是抛出
  const broken = createDirectWorkspaceRuntime({ coordinator: () => null, modelChat });
  assert.equal(broken.describe().available, false);
  const failed = await broken.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(failed.code, RUNTIME_CODES.RUNTIME_TOOL_MISSING);
});

/* --------------------------- 8. 边界与形状 --------------------------- */

test('缺少 Coordinator → AGENT_RUNTIME_TOOL_MISSING（不自己造执行链）', async () => {
  const run = createDirectWorkspaceRuntime({ modelChat: makeModelChat([{ content: 'x' }]) });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.RUNTIME_TOOL_MISSING);
});

test('缺少用户消息 → AGENT_PAYLOAD_INVALID', async () => {
  const run = makeRuntime({ modelChat: makeModelChat([{ content: 'x' }]) });
  const result = await run.invoke({ context: CONTEXT, request: {} });
  assert.equal(result.code, RUNTIME_CODES.PAYLOAD_INVALID);
});

test('模型一直空回复 → 先 nudge 一次再 empty_reply', async () => {
  const modelChat = makeModelChat([
    { content: '', finishReason: 'stop' },
    { content: '', finishReason: 'stop' },
  ]);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.stopReason, 'empty_reply');
  assert.equal(modelChat.calls.length, 2);
  const nudge = modelChat.calls[1].messages.at(-1);
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /一句简体中文/);
});

test('attempt 已只读（AGENT_ATTEMPT_IMMUTABLE）→ 整轮立即停，不再让模型试写', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'a.wxml', content: 'x' }] })] },
    { content: '不该有第二轮' },
  ]);
  const coordinator = makeCoordinator({
    invoke: () => ({ ok: false, code: 'AGENT_ATTEMPT_IMMUTABLE', message: '该 attempt 已提交/已采用，只读' }),
  });
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.ATTEMPT_IMMUTABLE);
  assert.equal(modelChat.calls.length, 1);
});

test('X12 口径：一轮内的模型调用是串行的（并发只由 ModelCallScheduler 控制，≤3）', async () => {
  let active = 0;
  let peak = 0;
  const modelChat = {
    calls: [],
    chat: async (payload) => {
      modelChat.calls.push(payload);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const first = modelChat.calls.length === 1;
      return {
        model: 'fake',
        content: first ? '' : '完成',
        toolCalls: first ? [toolCall('c1', 'get_context', {})] : [],
        usage: null,
        finishReason: first ? 'tool_calls' : 'stop',
        truncated: false,
      };
    },
  };
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.data.modelCalls, 2);
  assert.equal(peak, 1, '同一轮内不得并行发起上游请求（3 槽只由调度器管）');
});

test('direct-edit 预算以 profile 形式下传（maxTokens 由 model-credentials 统一解析）', async () => {
  const modelChat = makeModelChat([{ content: 'ok', finishReason: 'stop' }]);
  const run = makeRuntime({ coordinator: makeCoordinator(), modelChat });
  await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  assert.equal(modelChat.calls[0].profile, 'direct-edit');
  assert.equal(modelChat.calls[0].maxTokens, undefined, 'runtime 不自己写 maxTokens 数字');
  assert.equal(MAX_TOKENS.directEditDefault, 6000);
  assert.equal(MAX_TOKENS.directEditMax, 8000);
  // 工具定义随请求下发给模型
  assert.equal(modelChat.calls[0].tools.length, 11);
});

test('非法工具参数（非 JSON）→ 不调用 Coordinator，错误回填给模型', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{不是 JSON' }] },
    { content: '参数错了，我重试。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator();
  const run = makeRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(coordinator.calls.length, 0);
  assert.equal(result.data.toolCalls[0].ok, false);
  assert.equal(result.data.toolCalls[0].errorCode, RUNTIME_CODES.ARGUMENT_INVALID);
});
