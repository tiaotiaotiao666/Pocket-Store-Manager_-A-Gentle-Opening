'use strict';

/**
 * B3：renderer facade（src/services/workspaceAgent/index.js）。
 *
 * 覆盖：19 个语义方法映射、envelope 归一、桥缺失/超时/取消、onProgress 退订、
 * 默认单例从 window.smartStore.workspaceAgent 解析、新增 renderer 代码只有 facade 碰 window.smartStore、
 * facade 内不出现任意 channel / ipcRenderer。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const FACADE_DIR = path.join(REPO, 'src', 'services', 'workspaceAgent');
const FACADE_FILE = path.join(FACADE_DIR, 'index.js');

async function loadFacade() {
  return import(pathToFileURL(FACADE_FILE).href);
}

function fakeBridge(overrides) {
  const calls = [];
  const bridge = {
    onProgress: null,
  };
  for (const method of [
    'runTurn', 'getAttempt', 'getContext', 'listFiles', 'readFile', 'searchFiles', 'writeFiles', 'deleteFiles',
    'addImageAsset', 'getDiff', 'runCheck', 'verifyWechat', 'readVerification', 'readArtifact',
    'submitCandidate', 'adoptAttempt', 'versions', 'adoptVersion', 'undo', 'redo', 'reopen', 'cancelRun',
  ]) {
    bridge[method] = (payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true, data: { method, payload }, issues: [], meta: { durationMs: 1, truncated: false } });
    };
  }
  Object.assign(bridge, overrides || {});
  return { bridge, calls };
}

test('facade：22 个语义方法全部映射到 bridge 并归一 envelope', async () => {
  const facadeModule = await loadFacade();
  assert.deepStrictEqual([...facadeModule.WORKSPACE_AGENT_METHODS], [
    'runTurn', 'getAttempt', 'getContext', 'listFiles', 'readFile', 'searchFiles', 'writeFiles', 'deleteFiles',
    'addImageAsset', 'getDiff', 'runCheck', 'verifyWechat', 'readVerification', 'readArtifact',
    'submitCandidate', 'adoptAttempt', 'versions', 'adoptVersion', 'undo', 'redo', 'reopen', 'cancelRun',
  ]);

  const { bridge, calls } = fakeBridge();
  const facade = facadeModule.createWorkspaceAgentFacade({ getBridge: () => bridge });
  assert.strictEqual(facade.bridgeAvailable, true);
  for (const method of facadeModule.WORKSPACE_AGENT_METHODS) {
    const result = await facade[method]({ projectId: 'p_abc12345' });
    assert.strictEqual(result.ok, true, method);
    assert.strictEqual(result.data.method, method);
    assert.ok(Array.isArray(result.issues));
    assert.ok(result.meta && typeof result.meta.durationMs === 'number');
  }
  assert.strictEqual(calls.length, facadeModule.WORKSPACE_AGENT_METHODS.length);
  assert.strictEqual(Object.isFrozen(facade), true);
});

test('facade：失败 envelope 归一保留 code/message/issues/meta，不向 UI 抛异常', async () => {
  const facadeModule = await loadFacade();
  const facade = facadeModule.createWorkspaceAgentFacade({
    getBridge: () => ({
      versions: async () => ({ ok: false, code: 'AGENT_VERSION_NOT_FOUND', message: '版本不存在', data: null, issues: [{ code: 'X' }], meta: { durationMs: 2 } }),
      undo: async () => { throw new Error('boom'); },
    }),
  });
  const missing = await facade.versions({ projectId: 'p_abc12345' });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'AGENT_VERSION_NOT_FOUND');
  assert.strictEqual(missing.message, '版本不存在');
  assert.deepStrictEqual(missing.issues, [{ code: 'X' }]);
  assert.strictEqual(missing.meta.durationMs, 2);
  assert.strictEqual(missing.data, null);

  const thrown = await facade.undo({ projectId: 'p_abc12345' });
  assert.strictEqual(thrown.ok, false);
  assert.match(thrown.code, /^AGENT_/);
});

test('facade：桥缺失 → AGENT_RUNTIME_TOOL_MISSING；onProgress 退订安全', async () => {
  const facadeModule = await loadFacade();
  const facade = facadeModule.createWorkspaceAgentFacade({ getBridge: () => null });
  assert.strictEqual(facade.bridgeAvailable, false);
  for (const method of ['getContext', 'readFile', 'cancelRun']) {
    const result = await facade[method]({});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'AGENT_RUNTIME_TOOL_MISSING');
  }
  const unsubscribe = facade.onProgress(() => {});
  assert.strictEqual(typeof unsubscribe, 'function');
  unsubscribe();
  assert.strictEqual(facadeModule.resolveWorkspaceAgentBridge({}), null);
});

test('facade：超时 → AGENT_TIMEOUT；AbortSignal → AGENT_CANCELLED', async () => {
  const facadeModule = await loadFacade();
  const pendingBridge = { reopen: () => new Promise(() => {}) };
  const timeoutFacade = facadeModule.createWorkspaceAgentFacade({ getBridge: () => pendingBridge, timeoutMs: 10 });
  const timedOut = await timeoutFacade.reopen({ projectId: 'p_abc12345' });
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.code, 'AGENT_TIMEOUT');

  const { bridge } = fakeBridge();
  const facade = facadeModule.createWorkspaceAgentFacade({ getBridge: () => bridge });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await facade.reopen({ projectId: 'p_abc12345' }, { signal: controller.signal });
  assert.strictEqual(cancelled.ok, false);
  assert.strictEqual(cancelled.code, 'AGENT_CANCELLED');
});

test('facade：onProgress 订阅/退订；cancelRun 按 bridge 语义透传', async () => {
  const facadeModule = await loadFacade();
  const listeners = new Set();
  const bridge = {
    onProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelRun: async () => ({ ok: true, data: { state: 'too-late', cancelled: false }, issues: [], meta: {} }),
  };
  const facade = facadeModule.createWorkspaceAgentFacade({ getBridge: () => bridge });
  let received = 0;
  const unsubscribe = facade.onProgress(() => { received += 1; });
  assert.strictEqual(listeners.size, 1);
  for (const listener of listeners) listener({ status: 'running' });
  assert.strictEqual(received, 1);
  unsubscribe();
  assert.strictEqual(listeners.size, 0);

  const cancelled = await facade.cancelRun({ projectId: 'p_abc12345', runId: 'frun-x' });
  assert.strictEqual(cancelled.ok, true);
  assert.strictEqual(cancelled.data.state, 'too-late');
});

test('默认单例：从 window.smartStore.workspaceAgent 解析且不改写全局', async () => {
  const facadeModule = await loadFacade();
  const bridge = { versions: async () => ({ ok: true, data: { currentVersionId: 'v1' }, issues: [], meta: {} }) };
  const scope = { window: { smartStore: { workspaceAgent: bridge } } };
  assert.strictEqual(facadeModule.resolveWorkspaceAgentBridge(scope), bridge);
  assert.strictEqual(facadeModule.resolveWorkspaceAgentBridge({ window: {} }), null);
  const facade = facadeModule.createWorkspaceAgentFacade({ scope });
  const result = await facade.versions({ projectId: 'p_abc12345' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.currentVersionId, 'v1');
});

test('静态边界：新增 renderer 代码只有 facade 触碰 window.smartStore，且 facade 不含任意 channel', () => {
  const sources = fs.readdirSync(FACADE_DIR).filter((name) => name.endsWith('.js'));
  assert.deepStrictEqual(sources, ['index.js']);
  const facadeSource = fs.readFileSync(FACADE_FILE, 'utf8');
  assert.match(facadeSource, /window\.smartStore/);
  assert.match(facadeSource, /workspaceAgent/);
  assert.ok(!/ipcRenderer/.test(facadeSource), 'facade 不得直接使用 ipcRenderer');
  assert.ok(!/agent:[a-z-]+/.test(facadeSource), 'facade 不得拼接任意 agent:* channel');
  assert.ok(!/child_process|require\(|spawn|exec\(/.test(facadeSource), 'facade 不得有命令执行能力');
});
