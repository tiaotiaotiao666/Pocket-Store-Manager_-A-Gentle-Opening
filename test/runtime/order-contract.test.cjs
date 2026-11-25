'use strict';

/**
 * E0-R1 验收第 9 条：rev15 §14.13-3（F3）**顺序契约写入 direct 循环**。
 *
 * 冻结要求：
 * - 唯一合法顺序 `写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt`
 *   必须写进工具说明与停止条件；
 * - 任何 write_files/delete_files 成功都使既有检查证据失效；
 * - 模型收到 `AGENT_EVIDENCE_STALE`（issue `EVIDENCE_STALE_RERUN_CHECKS`，`nextAction:"rerun-checks"`）时
 *   必须按 nextAction 重跑检查，**不得重复 submit，也不得改证据** —— 这条由运行时闸门强制：
 *   重跑检查成功前，`submit_candidate` 一律本地拒绝且不触达 Coordinator。
 */

const test = require('node:test');
const assert = require('node:assert');

const runtime = require('../../desktop/agent-runtime');
const {
  createDirectWorkspaceRuntime,
  buildToolDefinitions,
  toolDescription,
  EVIDENCE_STALE_ISSUE,
  NEXT_ACTION_RERUN_CHECKS,
  MODEL_TOOL_NAMES,
  RUNTIME_CODES,
} = runtime;

const CONTEXT = Object.freeze({
  projectId: 'proj-r1',
  runId: 'frun-1',
  turnId: 'fturn-1',
  attemptId: 'att-1',
});

const SEQUENCE = '写(可多次) → derive bundle(一次) → source.check → composer.dry-run → mini/output → submit → (wechat) → adopt';

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
      return {
        model: 'fake-model',
        content: typeof step.content === 'string' ? step.content : '',
        toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls : [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: step.finishReason === undefined ? 'stop' : step.finishReason,
        truncated: false,
      };
    },
  };
}

function toolCall(id, name, args) {
  return { id, name, arguments: JSON.stringify(args || {}) };
}

/** 按工具名分派 envelope 的 fake Coordinator。 */
function makeCoordinator(handlers) {
  const calls = [];
  return {
    calls,
    invokeTool: async (input) => {
      calls.push(input);
      const handler = handlers[input.tool];
      return handler ? handler(input, calls.length) : { ok: true, data: {} };
    },
    assertRunActive: () => ({ ok: true }),
  };
}

const STALE_ENVELOPE = Object.freeze({
  ok: false,
  code: 'AGENT_EVIDENCE_STALE',
  message: '检查证据与当前 revision 不一致，请重跑检查。',
  nextAction: NEXT_ACTION_RERUN_CHECKS,
  issues: [{ code: EVIDENCE_STALE_ISSUE }],
});

/* ------------------------- 1. 顺序契约写进工具说明 ------------------------- */

test('11 个工具说明都写明唯一合法顺序', () => {
  const tools = buildToolDefinitions();
  assert.equal(tools.length, 11);
  for (const tool of tools) {
    const description = tool.function.description;
    assert.ok(description.includes('顺序契约'), tool.function.name + ' 缺顺序契约声明');
    assert.ok(description.includes(SEQUENCE), tool.function.name + ' 缺顺序链原文');
  }
  // 顺序链与导出的单一常量一致（不许出现第二份措辞）
  assert.equal(runtime.ORDER_CONTRACT, SEQUENCE);
});

test('写入类工具说明写明“写入即失效”，submit 写明 stale 与不得重复 submit', () => {
  for (const name of ['write_files', 'delete_files']) {
    const text = toolDescription(name);
    assert.match(text, /失效/, name + ' 必须说明写入使证据失效');
    assert.match(text, /重新派生/, name + ' 必须说明要重新派生 bundle');
  }
  const submit = toolDescription('submit_candidate');
  assert.match(submit, /AGENT_EVIDENCE_STALE/);
  assert.match(submit, new RegExp(EVIDENCE_STALE_ISSUE));
  assert.match(submit, /rerun-checks/);
  assert.match(submit, /不得重复 submit/);

  const check = toolDescription('run_check');
  assert.match(check, /nextAction/);
  assert.match(check, /重跑检查/);
});

test('系统提示词（停止条件）写明顺序契约、写入即失效、陈旧必须重跑检查', async () => {
  const modelChat = makeModelChat([{ content: '好', finishReason: 'stop' }]);
  const run = createDirectWorkspaceRuntime({
    coordinator: makeCoordinator({}),
    modelChat,
    systemPrompt: undefined,
  });
  await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });
  const system = modelChat.calls[0].messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes(SEQUENCE), '系统提示词必须含顺序链原文');
  assert.match(system.content, /写入即失效/);
  assert.match(system.content, new RegExp(EVIDENCE_STALE_ISSUE));
  assert.match(system.content, /rerun-checks/);
  assert.match(system.content, /停止条件/);

  // describe() 也暴露同一份契约，便于 UI/验证器读取
  const described = run.describe();
  assert.equal(described.orderContract.sequence, SEQUENCE);
  assert.equal(described.orderContract.writeInvalidatesEvidence, true);
  assert.equal(described.orderContract.staleEvidenceIssue, EVIDENCE_STALE_ISSUE);
  assert.equal(described.orderContract.staleEvidenceNextAction, NEXT_ACTION_RERUN_CHECKS);
  assert.deepEqual(described.orderContract.recheckTools, ['run_check']);
  assert.ok(described.stopConditions.includes('output_truncated'));
  assert.ok(described.stopConditions.includes('evidence_stale_after_repeated_submit'));
});

/* ------------------- 2. 写入成功 → 回填“证据已失效”提示 ------------------- */

test('write_files 成功后回填 note 提醒证据失效（trace 不含该文本）', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'write_files', { changes: [{ path: 'pages/home/a.wxml', content: '<view/>' }] })] },
    { content: '已改完', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({ write_files: () => ({ ok: true, data: { revision: 2 } }) });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  const toolMessage = modelChat.calls[1].messages.find((message) => message.role === 'tool');
  const body = JSON.parse(toolMessage.content);
  assert.equal(body.ok, true);
  assert.match(body.note, /既有检查证据失效/);
  assert.match(body.note, /重新派生/);
  // trace 只留结构字段，不带提示文本
  assert.ok(!JSON.stringify(result.data.toolCalls).includes('既有检查证据失效'));
});

/* ------------------- 3. AGENT_EVIDENCE_STALE 分支（核心） ------------------- */

test('提交遇 AGENT_EVIDENCE_STALE：nextAction/issue 回填给模型，再 submit 被本地拒绝', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c2', 'submit_candidate', { targetPage: 'home' })] },
    { content: '先按提示重跑检查。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    submit_candidate: () => STALE_ENVELOPE,
    run_check: () => ({ ok: true, data: { status: 'PASS' } }),
  });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '提交' } });

  assert.equal(result.ok, true);
  // 只有第一次 submit 真的到了 Coordinator，第二次被运行时闸门拦下
  assert.deepEqual(coordinator.calls.map((call) => call.tool), ['submit_candidate']);
  const traces = result.data.toolCalls;
  assert.equal(traces.length, 2);
  assert.equal(traces[0].errorCode, 'AGENT_EVIDENCE_STALE');
  assert.equal(traces[1].errorCode, 'AGENT_EVIDENCE_STALE');
  assert.equal(traces[1].note, 'blocked_by_order_contract');

  // 第一次：Coordinator 原始 envelope（含 issue/nextAction）要透给模型
  const firstBody = JSON.parse(modelChat.calls[1].messages.filter((message) => message.role === 'tool')[0].content);
  assert.equal(firstBody.error.code, 'AGENT_EVIDENCE_STALE');
  assert.equal(firstBody.error.nextAction, NEXT_ACTION_RERUN_CHECKS);
  assert.deepEqual(firstBody.issues, [{ code: EVIDENCE_STALE_ISSUE }]);

  // 第二次：本地拒绝，仍然明确 nextAction，且要求先跑 run_check
  const secondBody = JSON.parse(modelChat.calls[2].messages.filter((message) => message.role === 'tool')[1].content);
  assert.equal(secondBody.error.code, 'AGENT_EVIDENCE_STALE');
  assert.equal(secondBody.error.nextAction, NEXT_ACTION_RERUN_CHECKS);
  assert.match(secondBody.error.message, /run_check/);
});

test('先重跑检查再 submit：闸门解除，第二次 submit 真的到 Coordinator 并成功', async () => {
  let submitCount = 0;
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c2', 'run_check', { checkId: 'source.check' })] },
    { content: '', toolCalls: [toolCall('c3', 'submit_candidate', { targetPage: 'home' })] },
    { content: '重跑检查后提交成功。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    submit_candidate: () => {
      submitCount += 1;
      if (submitCount === 1) return STALE_ENVELOPE;
      return { ok: true, data: { status: 'submitted', candidateId: 'cand-1' } };
    },
    run_check: () => ({ ok: true, data: { status: 'PASS' } }),
  });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '提交' } });

  assert.equal(result.ok, true);
  assert.deepEqual(
    coordinator.calls.map((call) => call.tool),
    ['submit_candidate', 'run_check', 'submit_candidate'],
  );
  const traces = result.data.toolCalls;
  assert.deepEqual(traces.map((trace) => trace.ok), [false, true, true]);
  assert.equal(result.data.reply, '重跑检查后提交成功。');
});

test('无视 nextAction 用同一参数重复 submit → 被 loop detection 兜住（Coordinator 只收到 1 次）', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c2', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c3', 'submit_candidate', { targetPage: 'home' })] },
    { content: '不该有第 4 轮', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({ submit_candidate: () => STALE_ENVELOPE });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '提交' } });

  assert.equal(result.ok, true);
  assert.equal(result.data.stopReason, 'loop_detected');
  assert.equal(result.data.status, 'limit_reached');
  assert.equal(coordinator.calls.length, 1, '同样的 submit 只允许到 Coordinator 一次');
  assert.equal(modelChat.calls.length, 3, '判死循环后不再发起上游调用');
  // 闸门确实拦过一次（第 2 次 submit 没下发）
  const blocked = result.data.toolCalls.filter((trace) => trace.note === 'blocked_by_order_contract');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].errorCode, 'AGENT_EVIDENCE_STALE');
});

test('换参数继续重复 submit → 顺序契约闸门二次拒绝即终止（AGENT_EVIDENCE_STALE，不死循环）', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c2', 'submit_candidate', { targetPage: 'menu' })] },
    { content: '', toolCalls: [toolCall('c3', 'submit_candidate', { targetPage: 'cart' })] },
    { content: '不该有第 4 轮', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({ submit_candidate: () => STALE_ENVELOPE });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '提交' } });

  assert.equal(result.ok, false);
  assert.equal(result.code, RUNTIME_CODES.EVIDENCE_STALE);
  assert.match(result.message, /rerun-checks/);
  assert.deepEqual(result.issues, [{ code: EVIDENCE_STALE_ISSUE, nextAction: NEXT_ACTION_RERUN_CHECKS }]);
  assert.equal(result.data.status, 'failed');
  assert.equal(coordinator.calls.length, 1, '重复 submit 一律不得触达 Coordinator');
  assert.equal(modelChat.calls.length, 3, '终止后不再发起上游调用');
  assert.equal(
    result.data.toolCalls.filter((trace) => trace.note === 'blocked_by_order_contract').length,
    2,
  );
});

test('闸门只挡 submit：陈旧期间读文件/重跑检查等工具照常执行', async () => {
  const modelChat = makeModelChat([
    { content: '', toolCalls: [toolCall('c1', 'submit_candidate', { targetPage: 'home' })] },
    { content: '', toolCalls: [toolCall('c2', 'read_file', { path: 'pages/home/index.wxml' }), toolCall('c3', 'get_diff', {})] },
    { content: '先看差异，再重跑检查。', finishReason: 'stop' },
  ]);
  const coordinator = makeCoordinator({
    submit_candidate: () => STALE_ENVELOPE,
    read_file: () => ({ ok: true, data: { content: 'x' } }),
    get_diff: () => ({ ok: true, data: { changes: [] } }),
  });
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: 'x' } });

  assert.equal(result.ok, true);
  assert.deepEqual(
    coordinator.calls.map((call) => call.tool),
    ['submit_candidate', 'read_file', 'get_diff'],
  );
  assert.deepEqual(result.data.toolCalls.map((trace) => trace.ok), [false, true, true]);
});

test('工具说明里不得出现平台专用步骤 derive_source_bundle（派生归平台）', () => {
  for (const name of MODEL_TOOL_NAMES) {
    const text = toolDescription(name);
    assert.ok(!text.includes('derive_source_bundle'), name + ' 不得把平台步骤写成模型工具');
    assert.ok(!text.includes('adopt_attempt'), name + ' 不得把 adopt 写成模型工具');
  }
});
