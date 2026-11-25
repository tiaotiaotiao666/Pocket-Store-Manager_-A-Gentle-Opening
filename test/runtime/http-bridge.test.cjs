'use strict';

/**
 * E0-R1：HTTP 可选桥（rev15 §14.7 末条）。
 *
 * 判据只有两条：
 * 1. 未连接 RPC channel 时**明确 unavailable**（稳定 reason + 可读 message），不得伪造可用；
 * 2. HTTP 不可用**不影响** direct —— direct 回合照常跑完。
 */

const test = require('node:test');
const assert = require('node:assert');

const runtime = require('../../desktop/agent-runtime');
const {
  createHttpBridge,
  createDirectWorkspaceRuntime,
  HTTP_BRIDGE_UNAVAILABLE_REASON,
} = runtime;

const BINDING = Object.freeze({ projectId: 'proj-r1', runId: 'frun-1' });

function fakeCoordinator() {
  const calls = [];
  return {
    calls,
    invokeTool: async (input) => {
      calls.push(input);
      return { ok: true, data: {} };
    },
    assertRunActive: () => ({ ok: true }),
  };
}

test('未连接 channel → available:false + 稳定 reason（不伪造可用）', () => {
  const bridge = createHttpBridge({});
  const status = bridge.status(BINDING);
  assert.equal(status.transport, 'http');
  assert.equal(status.available, false);
  assert.equal(status.reason, HTTP_BRIDGE_UNAVAILABLE_REASON);
  assert.match(status.message, /未连接/);
  assert.equal(bridge.describe().available, false);

  // resolveChannel 抛错也算未连接，不得冒泡成“可用”。
  const broken = createHttpBridge({ resolveChannel: () => { throw new Error('boom'); } });
  assert.equal(broken.status(BINDING).available, false);
});

test('未连接时 send 明确失败，不带任何 data（不得伪造响应）', async () => {
  const bridge = createHttpBridge({});
  const result = await bridge.send({ ...BINDING, request: { messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, HTTP_BRIDGE_UNAVAILABLE_REASON);
  assert.equal(result.data, null);
});

test('别的 run 的 channel 不算连接（项目/run 绑定校验）', () => {
  const otherRun = { channelId: 'ch-1', runId: 'frun-OTHER', projectId: BINDING.projectId, send: async () => ({}) };
  const bridge = createHttpBridge({ resolveChannel: () => otherRun });
  assert.equal(bridge.status(BINDING).available, false);

  // 缺 runId/projectId 的调用同样不认。
  assert.equal(bridge.status({}).available, false);
  assert.equal(bridge.status({ projectId: BINDING.projectId }).available, false);
});

test('真注册了本 run 的 channel 才算 available，并能取回结果', async () => {
  const channel = { channelId: 'ch-ok', runId: BINDING.runId, projectId: BINDING.projectId, send: async () => ({ 从: '服务端' }) };
  const bridge = createHttpBridge({ resolveChannel: () => channel });
  const status = bridge.status(BINDING);
  assert.equal(status.available, true);
  assert.equal(status.channelId, 'ch-ok');

  const result = await bridge.send({ ...BINDING, request: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { 从: '服务端' });
});

test('HTTP 未连接不影响 direct：同一进程里 direct 回合照常跑完', async () => {
  const bridge = createHttpBridge({});
  assert.equal(bridge.status(BINDING).available, false);

  const coordinator = fakeCoordinator();
  const modelChat = {
    calls: [],
    chat: async (payload) => {
      modelChat.calls.push(payload);
      return { model: 'fake', content: 'direct 正常', toolCalls: [], usage: null, finishReason: 'stop', truncated: false };
    },
  };
  const direct = createDirectWorkspaceRuntime({ coordinator, modelChat });
  const result = await direct.invoke({
    context: { ...BINDING, turnId: 'fturn-1', attemptId: 'att-1' },
    request: { utterance: '改首页' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.reply, 'direct 正常');
  assert.equal(result.data.stopReason, 'final_answer');
  assert.equal(direct.describe().transport, 'direct');
  assert.equal(direct.describe().available, true);
});
