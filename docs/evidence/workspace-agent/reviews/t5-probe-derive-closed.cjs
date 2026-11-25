'use strict';

/** t15 复核补充探针 6：X6 派生 fail-closed 三条 + 状态四态归一（不自证）。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');

const PROJECT_ID = 'p_t15probe6';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-p6-'));
  const init = versions.initProject({ userDataDir, projectId: PROJECT_ID });
  if (!init.ok) throw new Error('init ' + JSON.stringify(init));
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime: null,
    emitProgress: () => {},
  });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  const patched = read.data.content.replace(/<\/view>\s*$/, '  <view class="t15p6">P6</view>\n</view>\n');
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] } });

  const issueCodes = (result) => (result && (result.issues || (result.data && result.data.issues)) || []).map((i) => i.code);

  // T1：写 overlay 之外的目录 → 派生 fail-closed（SOURCE_BUNDLE_PATH_FORBIDDEN）
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'services/evil.js', content: 'module.exports = 1;\n' }] } });
  const forbiddenPath = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  rec('T1-overlay-path-forbidden', forbiddenPath.ok === false && forbiddenPath.code === 'AGENT_STATIC_GATE_FAILED'
    && issueCodes(forbiddenPath).includes('SOURCE_BUNDLE_PATH_FORBIDDEN'),
  { code: forbiddenPath.code, issues: issueCodes(forbiddenPath), message: forbiddenPath.message });
  await coordinator.invokeTool({ ...ctx, tool: 'delete_files', args: { paths: [{ path: 'services/evil.js' }] } });

  // T2：删页面文件 → SOURCE_BUNDLE_DELETE_FORBIDDEN（只允许删 assets/**）
  const deleted = await coordinator.invokeTool({ ...ctx, tool: 'delete_files', args: { paths: [{ path: 'pages/mine/index.wxml' }] } });
  const forbiddenDelete = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  rec('T2-delete-page-forbidden', deleted.ok === true && forbiddenDelete.ok === false
    && issueCodes(forbiddenDelete).includes('SOURCE_BUNDLE_DELETE_FORBIDDEN'),
  { deleteOk: deleted.ok, code: forbiddenDelete.code, issues: issueCodes(forbiddenDelete) });

  // 恢复被删页面，保证后续用例从干净候选继续
  const minePage = fs.readFileSync(path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src', 'pages', 'mine', 'index.wxml'), 'utf8');
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/mine/index.wxml', content: minePage }] } });

  // T3：假图（扩展名 png、内容不是 PNG）→ SOURCE_BUNDLE_ASSET_TYPE_INVALID
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'assets/evil.png', content: 'not-a-real-png' }] } });
  const fakeAsset = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  rec('T3-fake-asset-forbidden', fakeAsset.ok === false && issueCodes(fakeAsset).includes('SOURCE_BUNDLE_ASSET_TYPE_INVALID'),
    { code: fakeAsset.code, issues: issueCodes(fakeAsset) });

  // T4：状态四态归一（未知 → NOT_RUN + CHECK_STATUS_UNKNOWN；EPERM → BLOCKED + CHECK_TOOL_MISSING）
  const unknownRegistry = checksMod.createCheckRegistry({
    userDataDir,
    runner: async () => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'WHATEVER' }), stderr: '', durationMs: 1 }),
  });
  const unknownResult = await unknownRegistry.runCheck({ checkId: 'capabilities.check' });
  const blockedRegistry = checksMod.createCheckRegistry({
    userDataDir,
    runner: async () => ({ ok: false, code: 'EPERM', killed: false, stdout: '', stderr: 'spawn EPERM', durationMs: 1 }),
  });
  const blockedResult = await blockedRegistry.runCheck({ checkId: 'capabilities.check' });
  rec('T4-status-four-states', unknownResult.status === 'NOT_RUN'
    && (unknownResult.issues || []).some((i) => i.code === 'CHECK_STATUS_UNKNOWN')
    && blockedResult.status === 'BLOCKED'
    && (blockedResult.issues || []).some((i) => i.code === 'CHECK_TOOL_MISSING'),
  { unknown: unknownResult.status, unknownIssues: (unknownResult.issues || []).map((i) => i.code), blocked: blockedResult.status, blockedIssues: (blockedResult.issues || []).map((i) => i.code) });

  fs.rmSync(userDataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
})();
