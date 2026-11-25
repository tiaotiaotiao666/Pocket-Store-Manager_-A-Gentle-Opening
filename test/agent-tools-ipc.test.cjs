'use strict';

/**
 * B3：受控任务 RPC（agent-tools-ipc.cjs）与接线（project-ipc/composer-ipc）。
 *
 * 覆盖：19 命令面 + 进度、统一 envelope、未知命令/未知键/超限、不可信 sender、busy、
 * 版本接线（versions/adopt-version/undo/redo/reopen/get-diff/submit-candidate）、
 * checks 注入（未知 checkId、B4 前缺工具、绝不假 PASS）、取消/迟到语义、证据读取、
 * 无绝对路径/源码全文/base64、project-ipc 重开身份校验、composer-ipc 导出身份守卫。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const REPO = h.REPO;
const PROJECT_ID = 'p_b3test01';
const RUN_ID = 'frun-b3-test';
const TURN_ID = 'turn-b3';

const toolsIpc = require(path.join(REPO, 'desktop', 'agent-tools-ipc.cjs'));
const projectIpc = require(path.join(REPO, 'desktop', 'project-ipc.cjs'));
const composerIpc = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));
const workspaceMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'workspace.cjs'));
const versionsMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'versions.cjs'));

const CODES = toolsIpc.CODES;
const COMMANDS = [
  'agent:get-context', 'agent:list-files', 'agent:read-file', 'agent:search-files',
  'agent:write-files', 'agent:delete-files', 'agent:add-image-asset', 'agent:get-diff',
  'agent:run-check', 'agent:verify-wechat', 'agent:read-verification', 'agent:read-artifact',
  'agent:submit-candidate', 'agent:adopt-attempt', 'agent:versions', 'agent:adopt-version', 'agent:undo',
  'agent:redo', 'agent:reopen', 'agent:cancel-run',
];

function tempUserData(t) {
  return h.userDataWith(t, 'b3');
}

function initProject(userDataDir) {
  const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, 'initProject 失败：' + JSON.stringify(init));
  return init;
}

function createAttempt(userDataDir, attemptNumber) {
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    attempt: attemptNumber,
    source: { kind: 'version', versionId: 'v1' },
  });
  assert.strictEqual(created.ok, true, 'createAttempt 失败：' + JSON.stringify(created));
  return created.attempt;
}

function setup(t, extra) {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const created = toolsIpc.createAgentToolsIpc(Object.assign({ userDataDir }, extra));
  return { userDataDir, ipc: created };
}

function assertEnvelopeShape(envelope) {
  assert.ok(envelope && typeof envelope === 'object', '必须有 envelope');
  assert.ok(Array.isArray(envelope.issues), 'issues 必须是数组');
  assert.ok(envelope.meta && typeof envelope.meta === 'object', 'meta 必须是对象');
  assert.ok(typeof envelope.meta.durationMs === 'number');
  if (envelope.ok === false) {
    assert.strictEqual(envelope.data, null);
    assert.match(envelope.code, /^AGENT_[A-Z_]+$/, '失败码必须是 AGENT_*：' + envelope.code);
    assert.ok(typeof envelope.message === 'string' && envelope.message.length > 0 && envelope.message.length <= 240);
  } else {
    assert.strictEqual(envelope.ok, true);
  }
}

function assertNoAbsolutePath(value, needles) {
  const text = JSON.stringify(value);
  for (const needle of needles) {
    assert.ok(!text.includes(needle), '结果不得包含绝对路径：' + needle);
  }
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), '结果不得包含盘符绝对路径');
  assert.ok(!/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(text), '结果不得包含 base64 data URI');
}

test('命令面：20 个 agent:* + agent:progress，全部返回统一 envelope', async (t) => {
  assert.strictEqual(toolsIpc.PROGRESS_CHANNEL, 'agent:progress');
  assert.deepStrictEqual(toolsIpc.createAgentToolsIpc({ userDataDir: 'C:/tmp' }).commandNames, COMMANDS);

  const { ipc } = setup(t);
  const context = await ipc.invoke('agent:get-context', { projectId: PROJECT_ID });
  assertEnvelopeShape(context);
  assert.strictEqual(context.ok, true, JSON.stringify(context));
  assert.strictEqual(context.data.currentVersionId, 'v1');
  assert.deepStrictEqual(context.data.checks, [...toolsIpc.CHECK_IDS]);
  assert.strictEqual(context.data.versionState.status, 'ok');

  const versions = await ipc.invoke('agent:versions', { projectId: PROJECT_ID });
  assertEnvelopeShape(versions);
  assert.strictEqual(versions.ok, true);
  assert.deepStrictEqual(versions.data.versions.map((item) => item.versionId), ['v1']);
  assert.strictEqual(versions.data.currentVersionId, 'v1');
  assert.strictEqual(versions.data.redoVersionId, null);

  const unknown = await ipc.invoke('agent:nope', { projectId: PROJECT_ID });
  assertEnvelopeShape(unknown);
  assert.strictEqual(unknown.code, CODES.PAYLOAD_INVALID);
});

test('参数校验：未知键/绝对路径/非法 id/超限 payload 全部拒绝', async (t) => {
  const { ipc } = setup(t);

  const unknownKey = await ipc.invoke('agent:get-context', { projectId: PROJECT_ID, evil: 1 });
  assertEnvelopeShape(unknownKey);
  assert.strictEqual(unknownKey.code, CODES.PAYLOAD_INVALID);

  const absolute = await ipc.invoke('agent:read-file', { projectId: PROJECT_ID, path: 'C:/Windows/win.ini' });
  assert.strictEqual(absolute.ok, false);
  assert.ok([CODES.PAYLOAD_INVALID, CODES.PATH_INVALID].includes(absolute.code), absolute.code);

  const traversal = await ipc.invoke('agent:read-file', { projectId: PROJECT_ID, path: '../escape.txt' });
  assert.strictEqual(traversal.ok, false);

  const badProject = await ipc.invoke('agent:versions', { projectId: '../evil' });
  assert.strictEqual(badProject.code, CODES.PROJECT_INVALID);

  const huge = await ipc.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    changes: [{ path: 'notes/huge.txt', content: 'x'.repeat(3 * 1024 * 1024) }],
  });
  assertEnvelopeShape(huge);
  assert.strictEqual(huge.code, CODES.PAYLOAD_TOO_LARGE);

  const badChanges = await ipc.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    changes: [{ path: 'notes/a.txt', content: 'a', extra: 1 }],
  });
  assert.strictEqual(badChanges.code, CODES.PAYLOAD_INVALID);
});

test('sender 校验：不可信 sender 返回 AGENT_UNTRUSTED_SENDER；可信 sender 正常', async (t) => {
  const { userDataDir } = setup(t);
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  toolsIpc.registerAgentToolsIpc(ipcMain, {
    userDataDir,
    isTrustedSender: (event) => Boolean(event && event.trusted === true),
  });
  const handler = handlers.get('agent:get-context');
  const untrusted = await handler({ trusted: false }, { projectId: PROJECT_ID });
  assertEnvelopeShape(untrusted);
  assert.strictEqual(untrusted.code, CODES.UNTRUSTED_SENDER);

  const trusted = await handler({ trusted: true }, { projectId: PROJECT_ID });
  assertEnvelopeShape(trusted);
  assert.strictEqual(trusted.ok, true, JSON.stringify(trusted));
});

test('version 接线：write-files → versions/undo/redo/reopen/get-diff/submit-candidate', async (t) => {
  const { userDataDir, ipc } = setup(t);
  createAttempt(userDataDir, 1);

  const write = await ipc.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    baseVersionId: 'v1',
    changes: [{ path: 'notes/b3.txt', content: 'hello b3\n' }],
  });
  assertEnvelopeShape(write);
  assert.strictEqual(write.ok, true, JSON.stringify(write));
  assert.strictEqual(write.data.revision, 2);
  assert.ok(write.data.files.some((file) => file.path === 'notes/b3.txt' && file.status === 'added'));

  const mismatch = await ipc.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    baseVersionId: 'v9',
    changes: [{ path: 'notes/x.txt', content: 'x' }],
  });
  assert.strictEqual(mismatch.code, CODES.VERSION_CONFLICT);

  const del = await ipc.invoke('agent:delete-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    baseVersionId: 'v1',
    paths: [{ path: 'notes/b3.txt' }],
  });
  assertEnvelopeShape(del);
  assert.strictEqual(del.ok, true, JSON.stringify(del));

  // E0-W2：submit-candidate 不再自己写 submitted，必须经 Coordinator 的静态门禁；
  // 未注入 Coordinator 时明确 AGENT_RUNTIME_TOOL_MISSING（不静默降级、不伪造成功）。
  const submitted = await ipc.invoke('agent:submit-candidate', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    attemptId: 'attempt-1',
    targetPage: 'menu',
    summary: 'B3 submit',
  });
  assertEnvelopeShape(submitted);
  assert.strictEqual(submitted.ok, false, JSON.stringify(submitted));
  assert.strictEqual(submitted.code, CODES.RUNTIME_TOOL_MISSING);

  // X5：8 页枚举（SourceFacts 派生）—— checkout 现在**是**合法目标页（v1 的 home/menu 常量已废弃）。
  const checkoutAccepted = await ipc.invoke('agent:submit-candidate', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', targetPage: 'checkout',
  });
  assert.strictEqual(checkoutAccepted.code, CODES.RUNTIME_TOOL_MISSING, 'checkout 必须通过页面枚举校验');
  // 不在 8 页内的自由字符串仍然被拒。
  const badPage = await ipc.invoke('agent:submit-candidate', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', targetPage: 'settings',
  });
  assert.strictEqual(badPage.code, CODES.TARGET_PAGE_UNSUPPORTED);

  // adopt-attempt：同样的 fail-closed 口径（必须经 Coordinator + 磁盘证据 + 摘要绑定）。
  const adopted = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', targetPage: 'menu',
  });
  assertEnvelopeShape(adopted);
  assert.strictEqual(adopted.ok, false);
  assert.strictEqual(adopted.code, CODES.RUNTIME_TOOL_MISSING);

  // B2 只冻结线性指针：没有历史版本可切 → 明确 AGENT_VERSION_CONFLICT，不伪造成功。
  const historical = await ipc.invoke('agent:adopt-version', { projectId: PROJECT_ID, versionId: 'v-1' });
  assert.strictEqual(historical.ok, false);
  assert.strictEqual(historical.code, CODES.VERSION_NOT_FOUND);

  const current = await ipc.invoke('agent:adopt-version', { projectId: PROJECT_ID, versionId: 'v1' });
  assertEnvelopeShape(current);
  assert.strictEqual(current.ok, true);
  assert.strictEqual(current.data.currentVersionId, 'v1');

  const undo = await ipc.invoke('agent:undo', { projectId: PROJECT_ID });
  assert.strictEqual(undo.ok, false);
  assert.strictEqual(undo.code, CODES.UNDO_UNAVAILABLE);

  const redo = await ipc.invoke('agent:redo', { projectId: PROJECT_ID });
  assert.strictEqual(redo.ok, false);
  assert.strictEqual(redo.code, CODES.REDO_UNAVAILABLE);

  const reopened = await ipc.invoke('agent:reopen', { projectId: PROJECT_ID });
  assertEnvelopeShape(reopened);
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.data.available, true);

  const diff = await ipc.invoke('agent:get-diff', {
    projectId: PROJECT_ID,
    comparedTo: { versionId: 'v1' },
  });
  assertEnvelopeShape(diff);
  assert.strictEqual(diff.ok, true, JSON.stringify(diff));
  assert.ok(Array.isArray(diff.data.files));
  assert.strictEqual(typeof diff.data.truncated, 'boolean');

  const dual = await ipc.invoke('agent:get-diff', {
    projectId: PROJECT_ID,
    comparedTo: { versionId: 'v1', attemptId: RUN_ID + '/' + TURN_ID + '/attempt-1' },
  });
  assert.strictEqual(dual.code, CODES.PAYLOAD_INVALID);
});

test('adopt-version 邻居映射 + undo/redo 成功路径（B2 侧建 v2）', async (t) => {
  const { userDataDir, ipc } = setup(t);
  createAttempt(userDataDir, 1);
  const adopted = versionsMod.adoptAttempt({
    userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: 1,
  });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.versionId, 'v2');

  // current=v2, previous=v1：adopt-version v1 → B2 undoVersion 路径。
  const adoptUndo = await ipc.invoke('agent:adopt-version', { projectId: PROJECT_ID, versionId: 'v1' });
  assert.strictEqual(adoptUndo.ok, true, JSON.stringify(adoptUndo));
  assert.strictEqual(adoptUndo.data.currentVersionId, 'v1');

  // current=v1, redo=v2：adopt-version v2 → B2 redoVersion 路径。
  const adoptRedo = await ipc.invoke('agent:adopt-version', { projectId: PROJECT_ID, versionId: 'v2' });
  assert.strictEqual(adoptRedo.ok, true, JSON.stringify(adoptRedo));
  assert.strictEqual(adoptRedo.data.currentVersionId, 'v2');

  // 直接 undo/redo 成功路径。
  const undo = await ipc.invoke('agent:undo', { projectId: PROJECT_ID });
  assert.strictEqual(undo.ok, true, JSON.stringify(undo));
  assert.strictEqual(undo.data.currentVersionId, 'v1');
  const redo = await ipc.invoke('agent:redo', { projectId: PROJECT_ID });
  assert.strictEqual(redo.ok, true, JSON.stringify(redo));
  assert.strictEqual(redo.data.currentVersionId, 'v2');
});

test('reopen 漂移：返回 AGENT_VERSION_CONFLICT + meta.versionState=unavailable，不回退 Base', async (t) => {
  const { userDataDir, ipc } = setup(t);
  const sourceFile = path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'versions', 'v1', 'source', 'app.json');
  fs.writeFileSync(sourceFile, '{"pages":[]}');
  const reopened = await ipc.invoke('agent:reopen', { projectId: PROJECT_ID });
  assertEnvelopeShape(reopened);
  assert.strictEqual(reopened.ok, false);
  assert.strictEqual(reopened.code, CODES.VERSION_CONFLICT);
  assert.strictEqual(reopened.meta.versionState.status, 'unavailable');
  assert.strictEqual(reopened.meta.versionState.available, false);
  assert.strictEqual(reopened.meta.versionState.currentVersionId, 'v1');
});

test('读接口：list/read/search 走 B2 source，结果无绝对路径且有界', async (t) => {
  const { userDataDir, ipc } = setup(t);

  const listed = await ipc.invoke('agent:list-files', { projectId: PROJECT_ID, pathPrefix: 'pages', maxDepth: 3 });
  assertEnvelopeShape(listed);
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.data.files.length > 0);
  for (const file of listed.data.files) {
    assert.ok(!path.isAbsolute(file.path));
    assert.match(file.sha256, /^sha256:[0-9a-f]{64}$/);
  }

  const read = await ipc.invoke('agent:read-file', { projectId: PROJECT_ID, path: 'app.json', limitBytes: 10 });
  assertEnvelopeShape(read);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.data.truncated, true);
  assert.strictEqual(read.data.nextOffset, 10);
  assert.strictEqual(read.data.totalBytes, fs.statSync(path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'versions', 'v1', 'source', 'app.json')).size);
  assert.match(read.data.sha256, /^sha256:[0-9a-f]{64}$/);

  const missing = await ipc.invoke('agent:read-file', { projectId: PROJECT_ID, path: 'no/such.txt' });
  assert.strictEqual(missing.code, CODES.FILE_NOT_FOUND);

  const search = await ipc.invoke('agent:search-files', {
    projectId: PROJECT_ID, query: 'merchant-orders', mode: 'content', maxResults: 5,
  });
  assertEnvelopeShape(search);
  assert.strictEqual(search.ok, true, JSON.stringify(search));
  assert.ok(search.data.matches.some((match) => match.path === 'app.json'));

  const bounded = await ipc.invoke('agent:search-files', { projectId: PROJECT_ID, query: 'e', maxResults: 1 });
  assert.strictEqual(bounded.data.matches.length <= 1, true);
  assert.strictEqual(bounded.data.truncated, true);

  assertNoAbsolutePath([listed, read, search], [userDataDir, REPO]);
});

test('并发：写 busy → AGENT_BUSY；读并发上限 → AGENT_BUSY（注入锁/限流器）', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  createAttempt(userDataDir, 1);

  const writeBusy = toolsIpc.createAgentToolsIpc({
    userDataDir,
    locks: { acquire: () => false, release: () => {} },
  });
  const busy = await writeBusy.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    changes: [{ path: 'notes/busy.txt', content: 'x' }],
  });
  assertEnvelopeShape(busy);
  assert.strictEqual(busy.code, CODES.BUSY);

  const readBusy = toolsIpc.createAgentToolsIpc({
    userDataDir,
    reads: { acquire: () => false, release: () => {} },
  });
  const readResult = await readBusy.invoke('agent:read-file', { projectId: PROJECT_ID, path: 'app.json' });
  assert.strictEqual(readResult.code, CODES.BUSY);
});

test('cancel-run：活动 run 首次→requested，确认停止后→cancelled，未知/已结束→too-late', async (t) => {
  const { ipc } = setup(t);
  const unknown = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: 'frun-unknown-1' });
  assertEnvelopeShape(unknown);
  assert.strictEqual(unknown.ok, true, JSON.stringify(unknown));
  assert.strictEqual(unknown.data.state, 'too-late');
  assert.strictEqual(unknown.data.cancelled, false);

  // 活动 run：首次 cancel 只登记 requested，不把 requested 当场写成 cancelled。
  ipc.beginRun(PROJECT_ID, RUN_ID);
  const first = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assertEnvelopeShape(first);
  assert.strictEqual(first.data.state, 'requested');
  assert.strictEqual(first.data.cancelled, false);
  assert.match(first.data.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  const repeated = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(repeated.data.state, 'requested', '重复 cancel 保持 requested');
  assert.strictEqual(repeated.data.requestedAt, first.data.requestedAt, 'requestedAt 幂等');
  ipc.finishRun(PROJECT_ID, RUN_ID);
  const late = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(late.ok, true);
  assert.strictEqual(late.data.state, 'too-late');

  const badRun = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: 'run-1' });
  assert.strictEqual(badRun.code, CODES.ID_INVALID);
});

test('cancel-run（真实在途任务）：requested → AGENT_CANCELLED → cancelled，不误报失败', async (t) => {
  let releaseCheck = null;
  const checks = {
    runCheck: () => new Promise((resolvePromise) => { releaseCheck = resolvePromise; }),
  };
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const ipc = toolsIpc.createAgentToolsIpc({ userDataDir, checks });

  const pending = ipc.invoke('agent:run-check', {
    projectId: PROJECT_ID, runId: RUN_ID, checkId: 'source.check',
  });
  await Promise.resolve();

  const first = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(first.data.state, 'requested');
  assert.strictEqual(first.data.cancelled, false);
  assert.match(first.data.requestedAt, /^\d{4}-\d{2}-\d{2}T/);

  // 第二次在任务停止前仍是 requested（幂等）。
  const second = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(second.data.state, 'requested');
  assert.strictEqual(second.data.requestedAt, first.data.requestedAt);

  releaseCheck({ ok: true, status: 'BLOCKED', issues: [] });
  const cancelled = await pending;
  assertEnvelopeShape(cancelled);
  assert.strictEqual(cancelled.ok, false);
  assert.strictEqual(cancelled.code, CODES.CANCELLED);

  // 任务确认停止后再查询：cancelled（不是 too-late），并保留 requestedAt。
  const after = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: RUN_ID });
  assertEnvelopeShape(after);
  assert.strictEqual(after.ok, true, JSON.stringify(after));
  assert.strictEqual(after.data.state, 'cancelled');
  assert.strictEqual(after.data.cancelled, true);
  assert.strictEqual(after.data.requestedAt, first.data.requestedAt);
});

test('run-check：未知 checkId → CHECK_UNKNOWN；显式禁用 checks → RUNTIME_TOOL_MISSING；绝不假 PASS', async (t) => {
  const { userDataDir, ipc } = setup(t);
  const unknown = await ipc.invoke('agent:run-check', {
    projectId: PROJECT_ID, runId: RUN_ID, checkId: 'evil.command',
  });
  assertEnvelopeShape(unknown);
  assert.strictEqual(unknown.code, CODES.CHECK_UNKNOWN);

  // checks:false 显式禁用注册表（B3 的“无注入”口径）；默认已切到 B4 真实注册表。
  const noChecks = toolsIpc.createAgentToolsIpc({ userDataDir, checks: false });
  for (const checkId of toolsIpc.CHECK_IDS) {
    const missing = await noChecks.invoke('agent:run-check', {
      projectId: PROJECT_ID, runId: RUN_ID, checkId, params: { target: 'menu' },
    });
    assertEnvelopeShape(missing);
    assert.strictEqual(missing.ok, false, checkId + ' 不得假 PASS');
    assert.strictEqual(missing.code, CODES.RUNTIME_TOOL_MISSING, checkId);
  }

  const injected = toolsIpc.createAgentToolsIpc({
    userDataDir: tempUserData(t),
    checks: {
      runCheck: async () => ({ ok: true, status: 'BLOCKED', issues: [] }),
    },
  });
  const uninitialized = await injected.invoke('agent:run-check', {
    projectId: PROJECT_ID, runId: RUN_ID, checkId: 'source.check',
  });
  assertEnvelopeShape(uninitialized);
  assert.strictEqual(uninitialized.ok, true);
  assert.strictEqual(uninitialized.data.status, 'BLOCKED');

  const withChecks = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: {
      runCheck: async () => ({ ok: true, status: 'BLOCKED', issues: [{ code: 'CHECK_BLOCKED', severity: 'low', message: '工具缺失', source: 'check' }] }),
    },
  });
  const blocked = await withChecks.invoke('agent:run-check', {
    projectId: PROJECT_ID, runId: RUN_ID, checkId: 'wechat.verify',
  });
  assertEnvelopeShape(blocked);
  assert.strictEqual(blocked.ok, true, JSON.stringify(blocked));
  assert.strictEqual(blocked.data.status, 'BLOCKED');
  assert.notStrictEqual(blocked.data.status, 'PASS');
});

test('B4：真实 checks 注册表（fake runner，不 spawn）→ PASS/FAIL/BLOCKED 与参数白名单贯通 IPC', async (t) => {
  const checksModule = require(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'));
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const withRunner = (runner) => toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: checksModule.createCheckRegistry({ userDataDir, runner }),
  });

  const passed = await withRunner(async () => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 2 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'capabilities.check' });
  assertEnvelopeShape(passed);
  assert.strictEqual(passed.ok, true, JSON.stringify(passed));
  assert.strictEqual(passed.data.status, 'PASS');

  const failed = await withRunner(async () => ({
    ok: true,
    code: 'OK',
    stdout: JSON.stringify({ status: 'FAIL', issues: [{ code: 'SRC', message: '语法错误', file: 'pages/menu/index.wxml', line: 2 }] }),
    stderr: '',
    durationMs: 3,
  })).invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'capabilities.check' });
  assert.strictEqual(failed.data.status, 'FAIL');
  assert.strictEqual(failed.data.issues[0].file, 'pages/menu/index.wxml');

  // rev15 §14.4：IPC run-check 没有 attempt/导出树主体，attempt 级 checkId 必须 CHECK_UNKNOWN（不回落版本源码）。
  const attemptScoped = await withRunner(async () => ({ ok: true, code: 'OK', stdout: '{"status":"PASS"}', stderr: '', durationMs: 1 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'source.check' });
  assertEnvelopeShape(attemptScoped);
  assert.strictEqual(attemptScoped.ok, false, JSON.stringify(attemptScoped));
  assert.strictEqual(attemptScoped.code, CODES.CHECK_UNKNOWN);
  const exportScoped = await withRunner(async () => ({ ok: true, code: 'OK', stdout: '{"status":"PASS"}', stderr: '', durationMs: 1 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'mini.check' });
  assert.strictEqual(exportScoped.code, CODES.CHECK_UNKNOWN);

  const blocked = await withRunner(async () => ({ ok: false, code: 'EPERM', killed: false, stdout: '', stderr: 'spawn EPERM', durationMs: 1 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'catalog.check' });
  assert.strictEqual(blocked.ok, true, JSON.stringify(blocked));
  assert.strictEqual(blocked.data.status, 'BLOCKED');
  assert.notStrictEqual(blocked.data.status, 'PASS');

  // 参数白名单在 checks.cjs 内生效：command / 未知键 → AGENT_PAYLOAD_INVALID。
  const commandParam = await withRunner(async () => ({ ok: true, code: 'OK', stdout: '{"status":"PASS"}', stderr: '', durationMs: 1 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'capabilities.check', params: { command: 'rm -rf /' } });
  assert.strictEqual(commandParam.ok, false);
  assert.strictEqual(commandParam.code, CODES.PAYLOAD_INVALID);
  const unknownParam = await withRunner(async () => ({ ok: true, code: 'OK', stdout: '{"status":"PASS"}', stderr: '', durationMs: 1 }))
    .invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'capabilities.check', params: { unknown: 1 } });
  assert.strictEqual(unknownParam.code, CODES.PAYLOAD_INVALID);

  // 工具/环境不可用（同步 throw EPERM / 返回工具缺失码）→ 成功 envelope 的 data.status='BLOCKED'，不是 CHECK_FAILED。
  const throwing = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: {
      runCheck() {
        const error = new Error('spawn EPERM');
        error.code = 'EPERM';
        throw error;
      },
    },
  });
  const thrown = await throwing.invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'capabilities.check' });
  assertEnvelopeShape(thrown);
  assert.strictEqual(thrown.ok, true, JSON.stringify(thrown));
  assert.strictEqual(thrown.data.status, 'BLOCKED');
  assert.strictEqual(thrown.data.issues[0].code, 'CHECK_TOOL_MISSING');

  const missingCode = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: { runCheck: async () => ({ ok: false, code: 'CHECK_TOOL_MISSING' }) },
  });
  const missingResult = await missingCode.invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'source.check' });
  assert.strictEqual(missingResult.ok, true, JSON.stringify(missingResult));
  assert.strictEqual(missingResult.data.status, 'BLOCKED');

  const failedCode = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: { runCheck: async () => ({ ok: false, code: 'AGENT_CHECK_FAILED' }) },
  });
  const failedResult = await failedCode.invoke('agent:run-check', { projectId: PROJECT_ID, runId: RUN_ID, checkId: 'source.check' });
  assert.strictEqual(failedResult.ok, false);
  assert.strictEqual(failedResult.code, 'AGENT_CHECK_FAILED');

  // verify-wechat（B3 命令）：没有派生导出树主体 → rev15 §14.4 要求 CHECK_UNKNOWN，
  // 绝不回落到仓库 miniprogram/ 镜像去“验证”一个不存在的导出成果。
  const verify = await withRunner(async () => ({ ok: false, code: 'ENOENT', killed: false, stdout: '', stderr: 'CLI missing', durationMs: 1 }))
    .invoke('agent:verify-wechat', { projectId: PROJECT_ID, runId: RUN_ID, attemptId: 'attempt-1' });
  assertEnvelopeShape(verify);
  assert.strictEqual(verify.ok, false, JSON.stringify(verify));
  assert.strictEqual(verify.code, CODES.CHECK_UNKNOWN);

  const verifyThrown = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: {
      verifyWechat() {
        const error = new Error('spawn EPERM');
        error.code = 'EPERM';
        throw error;
      },
    },
  });
  const verifyResult = await verifyThrown.invoke('agent:verify-wechat', {
    projectId: PROJECT_ID, runId: RUN_ID, attemptId: 'attempt-1',
  });
  assertEnvelopeShape(verifyResult);
  // 注入的替身没有 definitions → 不被 subject 守卫拦截，异常被如实映射成 BLOCKED + CHECK_TOOL_MISSING。
  assert.strictEqual(verifyResult.ok, true, JSON.stringify(verifyResult));
  assert.strictEqual(verifyResult.data.status, 'BLOCKED');
  assert.strictEqual(verifyResult.data.issues[0].code, 'CHECK_TOOL_MISSING');
  assert.deepStrictEqual(verifyResult.data.screenshots, []);
});

test('adopt-attempt：转调 Coordinator（唯一执行所有者），并在 IPC 层做 8 页枚举与 payload 校验', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const calls = [];
  const fakeCoordinator = {
    adoptAttempt: (input) => {
      calls.push(input);
      return {
        ok: true,
        currentVersionId: 'v2',
        previousVersionId: 'v1',
        adoptedVersionId: 'v2',
        treeDigest: 'sha256:' + 'a'.repeat(64),
        adoption: { adoptedAt: '2026-01-01T00:00:00.000Z' },
        targetPage: input.targetPage || 'menu',
      };
    },
  };
  const ipc = toolsIpc.createAgentToolsIpc({ userDataDir, coordinator: fakeCoordinator });

  const adopted = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', targetPage: 'checkout',
    partialConfirmed: true,
  });
  assertEnvelopeShape(adopted);
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.data.currentVersionId, 'v2');
  assert.strictEqual(adopted.data.adoptedVersionId, 'v2');
  assert.strictEqual(calls.length, 1);
  // F-T5-01：Coordinator 只接受字符串 `attempt-<n>`；IPC 必须显式适配（attempt-1 → 'attempt-1'）。
  assert.strictEqual(calls[0].attemptId, 'attempt-1', 'attemptId 必须以字符串 attempt-<n> 交给 Coordinator');
  assert.strictEqual(calls[0].partialConfirmed, true);
  assert.strictEqual(calls[0].targetPage, 'checkout', 'checkout 属于 8 页枚举，必须放行到 Coordinator');

  // 非法页面 / 非法布尔 / 未知键 → 不触达 Coordinator。
  const badPage = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', targetPage: 'settings',
  });
  assert.strictEqual(badPage.code, CODES.TARGET_PAGE_UNSUPPORTED);
  const badFlag = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', partialConfirmed: 'yes',
  });
  assert.strictEqual(badFlag.code, CODES.PAYLOAD_INVALID);
  const unknownKey = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', force: true,
  });
  assert.strictEqual(unknownKey.code, CODES.PAYLOAD_INVALID);
  assert.strictEqual(calls.length, 1, '非法请求不得调用 Coordinator');

  // Coordinator 的失败码原样透出（不吞成成功）。
  const failing = toolsIpc.createAgentToolsIpc({
    userDataDir,
    coordinator: {
      adoptAttempt: () => ({
        ok: false,
        code: 'AGENT_EVIDENCE_STALE',
        message: '提交证据的 treeDigest 与当前候选不一致',
        issues: [{ code: 'STALE', severity: 'high', message: 'treeDigest 不一致', source: 'coordinator' }],
      }),
    },
  });
  const rejected = await failing.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
  });
  assertEnvelopeShape(rejected);
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, 'AGENT_EVIDENCE_STALE');
  assert.strictEqual(rejected.issues.length, 1);
});

test('verify-wechat：显式禁用 checks → RUNTIME_TOOL_MISSING；注入后如实 BLOCKED', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const noChecks = toolsIpc.createAgentToolsIpc({ userDataDir, checks: false });
  const missing = await noChecks.invoke('agent:verify-wechat', {
    projectId: PROJECT_ID, runId: RUN_ID, attemptId: 'attempt-1',
  });
  assertEnvelopeShape(missing);
  assert.strictEqual(missing.code, CODES.RUNTIME_TOOL_MISSING);
  assert.notStrictEqual(missing.data && missing.data.status, 'PASS');

  const withChecks = toolsIpc.createAgentToolsIpc({
    userDataDir,
    checks: {
      verifyWechat: async () => ({ ok: true, status: 'BLOCKED', pages: [], interactions: [], screenshots: [], evidenceRelative: 'verification/runtime' }),
    },
  });
  const blocked = await withChecks.invoke('agent:verify-wechat', {
    projectId: PROJECT_ID, runId: RUN_ID, attemptId: 'attempt-1',
  });
  assert.strictEqual(blocked.ok, true, JSON.stringify(blocked));
  assert.strictEqual(blocked.data.status, 'BLOCKED');
});

test('read-verification / read-artifact：只读证据目录、只回相对引用、无 base64', async (t) => {
  const { userDataDir, ipc } = setup(t);
  const attempt = createAttempt(userDataDir, 1);
  fs.mkdirSync(path.join(attempt.verificationDir, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(attempt.verificationDir, 'runtime', 'report.json'), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(attempt.verificationDir, 'runtime', 'screen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const verification = await ipc.invoke('agent:read-verification', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1', source: 'attempt',
  });
  assertEnvelopeShape(verification);
  assert.strictEqual(verification.ok, true, JSON.stringify(verification));
  assert.ok(Array.isArray(verification.data.screenshots));
  assertNoAbsolutePath(verification, [userDataDir, REPO]);

  const artifact = await ipc.invoke('agent:read-artifact', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    kind: 'report', ref: 'verification/runtime/report.json',
  });
  assertEnvelopeShape(artifact);
  assert.strictEqual(artifact.ok, true, JSON.stringify(artifact));
  assert.match(artifact.data.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(typeof artifact.data.mime, 'string');
  // rev7：文本 ≤64 KiB 回 content，不回 contentBytes。
  assert.strictEqual(artifact.data.content, JSON.stringify({ ok: true }));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(artifact.data, 'contentBytes'), false);

  // rev7：二进制回 contentBytes: Uint8Array（无 base64）。
  const binary = await ipc.invoke('agent:read-artifact', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    kind: 'screenshot', ref: 'verification/runtime/screen.png',
  });
  assertEnvelopeShape(binary);
  assert.strictEqual(binary.ok, true, JSON.stringify(binary));
  assert.ok(binary.data.contentBytes instanceof Uint8Array, 'contentBytes 必须是 Uint8Array');
  assert.deepStrictEqual(Array.from(binary.data.contentBytes), [0x89, 0x50, 0x4e, 0x47]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(binary.data, 'content'), false);
  assert.strictEqual(
    binary.data.sha256,
    'sha256:' + crypto.createHash('sha256').update(Buffer.from([0x89, 0x50, 0x4e, 0x47])).digest('hex'),
  );
  assert.ok(!/base64/i.test(JSON.stringify(binary)));

  // rev7：>2 MiB 证据 → AGENT_RESULT_TOO_LARGE（不是 “找不到”），且不返回字节。
  fs.writeFileSync(path.join(attempt.verificationDir, 'runtime', 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 1, 7));
  const tooLarge = await ipc.invoke('agent:read-artifact', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    kind: 'screenshot', ref: 'verification/runtime/big.png',
  });
  assertEnvelopeShape(tooLarge);
  assert.strictEqual(tooLarge.ok, false);
  assert.strictEqual(tooLarge.code, CODES.RESULT_TOO_LARGE);
  assert.strictEqual(tooLarge.data, null);

  const missing = await ipc.invoke('agent:read-artifact', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    kind: 'report', ref: 'verification/runtime/nope.json',
  });
  assert.strictEqual(missing.code, CODES.ARTIFACT_NOT_FOUND);

  const escape = await ipc.invoke('agent:read-artifact', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    kind: 'report', ref: '../project.json',
  });
  assert.strictEqual(escape.ok, false);

  // 版本 source 的 evidence 目录也支持（B2 冻结布局）。
  const versionVerification = await ipc.invoke('agent:read-verification', {
    projectId: PROJECT_ID, versionId: 'v1', source: 'version',
  });
  assertEnvelopeShape(versionVerification);
  assert.strictEqual(versionVerification.ok, true, JSON.stringify(versionVerification));
});

test('add-image-asset：未接能力 → RUNTIME_TOOL_MISSING；非法引用 → PAYLOAD_INVALID；注入后成功', async (t) => {
  const { ipc } = setup(t);
  const missing = await ipc.invoke('agent:add-image-asset', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attachmentRef: 'asset-1',
  });
  assertEnvelopeShape(missing);
  assert.strictEqual(missing.code, CODES.RUNTIME_TOOL_MISSING);

  const invalid = await ipc.invoke('agent:add-image-asset', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attachmentRef: 'C:/secret/x.png',
  });
  assert.strictEqual(invalid.code, CODES.PAYLOAD_INVALID);

  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const withAttachments = toolsIpc.createAgentToolsIpc({
    userDataDir,
    attachments: { add: async () => ({ ok: true, assetId: 'asset-9', relative: 'assets/asset-9.png', caption: '图' }) },
  });
  const added = await withAttachments.invoke('agent:add-image-asset', {
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attachmentRef: 'asset-9',
  });
  assert.strictEqual(added.ok, true, JSON.stringify(added));
  assert.strictEqual(added.data.assetId, 'asset-9');
});

test('进度通道：agent:progress 只接受白名单字段，message ≤120，非法 status 拒绝', async (t) => {
  const events = [];
  const { ipc } = setup(t, { emitProgress: (event) => events.push(event) });

  const sent = ipc.emitProgress({
    projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attemptId: 'attempt-1',
    phase: 'edit', stage: 'write', status: 'running', message: 'x'.repeat(200),
  });
  assert.strictEqual(sent.ok, true, JSON.stringify(sent));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].message.length <= 120, true);
  assert.ok(!JSON.stringify(events[0]).includes('C:'));

  const badStatus = ipc.emitProgress({ projectId: PROJECT_ID, status: 'pass' });
  assert.strictEqual(badStatus.ok, false);
  const unknownField = ipc.emitProgress({ projectId: PROJECT_ID, status: 'running', path: 'C:/x' });
  assert.strictEqual(unknownField.ok, false);
});

test('无绝对路径：所有成功结果都不含 userDataDir/仓库绝对路径/base64', async (t) => {
  const { userDataDir, ipc } = setup(t);
  createAttempt(userDataDir, 1);
  const envelopes = [
    await ipc.invoke('agent:get-context', { projectId: PROJECT_ID }),
    await ipc.invoke('agent:versions', { projectId: PROJECT_ID }),
    await ipc.invoke('agent:list-files', { projectId: PROJECT_ID }),
    await ipc.invoke('agent:read-file', { projectId: PROJECT_ID, path: 'app.json' }),
    await ipc.invoke('agent:search-files', { projectId: PROJECT_ID, query: 'pages' }),
    await ipc.invoke('agent:get-diff', { projectId: PROJECT_ID, comparedTo: { versionId: 'v1' } }),
    await ipc.invoke('agent:reopen', { projectId: PROJECT_ID }),
  ];
  for (const envelope of envelopes) {
    assertNoAbsolutePath(envelope, [userDataDir, REPO]);
  }
});

test('project-ipc：加载时版本状态 none/ok/unavailable（只读、不阻断打开）', async (t) => {
  const userDataDir = tempUserData(t);
  const none = projectIpc.inspectProjectVersionState(userDataDir, PROJECT_ID);
  assert.strictEqual(none.status, 'none');

  initProject(userDataDir);
  const ok = projectIpc.inspectProjectVersionState(userDataDir, PROJECT_ID);
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.currentVersionId, 'v1');

  fs.writeFileSync(path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'versions', 'v1', 'source', 'app.json'), '{"pages":[]}');
  const drifted = projectIpc.inspectProjectVersionState(userDataDir, PROJECT_ID);
  assert.strictEqual(drifted.status, 'unavailable');
  assert.strictEqual(drifted.code, CODES.VERSION_CONFLICT);
  assert.strictEqual(drifted.available, false);
  assert.strictEqual(drifted.currentVersionId, 'v1');

  // project:load 只把 versionState 附在结果上，不因漂移失败。
  const created = projectIpc.createProjectIpc({
    store: { userDataDir, loadProject: async () => ({ doc: { schemaVersion: 1, frontendCandidate: { status: 'none' } }, data: { x: 1 } }) },
    assets: {}, settings: {}, dialog: {}, shell: {},
  });
  const loaded = await created.handlers['project:load']({}, { projectId: PROJECT_ID });
  assert.strictEqual(loaded.ok, true);
  assert.strictEqual(loaded.data.versionState.status, 'unavailable');
  assert.strictEqual(loaded.data.versionState.code, CODES.VERSION_CONFLICT);
});

test('composer-ipc：有 agent-workspace 时导出前验身份；无 workspace 跳过；漂移中止', (t) => {
  const userDataDir = tempUserData(t);
  const skipped = composerIpc.verifyAgentWorkspaceExport({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(skipped.ok, true);
  assert.strictEqual(skipped.skipped, true);

  initProject(userDataDir);
  const ok = composerIpc.verifyAgentWorkspaceExport({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.skipped, false);
  assert.strictEqual(ok.versionId, 'v1');

  fs.writeFileSync(path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'versions', 'v1', 'source', 'app.json'), '{"pages":[]}');
  const drifted = composerIpc.verifyAgentWorkspaceExport({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(drifted.ok, false);
  assert.strictEqual(drifted.code, CODES.EXPORT_IDENTITY_MISMATCH);
});
