'use strict';

/** t15 复核补充探针 2：IPC → 真实 Coordinator 端到端（t5 只用 stub 覆盖过） + F4 优先级（修正版）。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const manifestMod = load('desktop/agent-workspace/manifest.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');
const ipcMod = load('desktop/agent-tools-ipc.cjs');

const PROJECT_ID = 'p_t15probe2';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function userData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-p2-'));
  const init = versions.initProject({ userDataDir: dir, projectId: PROJECT_ID });
  if (!init.ok) throw new Error('init ' + JSON.stringify(init));
  return dir;
}
function attemptDirOf(userDataDir, run) {
  return path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId);
}
function candidateDigest(dir) {
  const built = manifestMod.buildManifest(path.join(dir, 'candidate'), {});
  return built.ok ? built.manifest.treeDigest : null;
}

async function chainToGreen(coordinator, run, marker) {
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  const patched = read.data.content.replace(/<\/view>\s*$/, '  <view class="t15p2">' + marker + '</view>\n</view>\n');
  await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] },
  });
  const source = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  const dry = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  const mini = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  return { ctx, patched, statuses: { source: source.data && source.data.status, dry: dry.data && dry.data.status, mini: mini.data && mini.data.status } };
}

(async () => {
  const userDataDir = userData();
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime: null,
    emitProgress: () => {},
  });
  const ipc = ipcMod.createAgentToolsIpc({ userDataDir, coordinator, emitProgress: () => {} });

  // P1：真实链路（Coordinator 自己跑）到这里应为绿
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const green = await chainToGreen(coordinator, run, 'P1');
  rec('P1-chain-green', green.statuses.source === 'PASS' && green.statuses.dry === 'PASS' && green.statuses.mini === 'PASS', green.statuses);

  // P2：真实 Coordinator 收到 IPC 透传的“数字 attemptId”时如何表现（这是 IPC 适配层的实际输入）
  const numeric = coordinator.submitAttempt({
    projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: 1, targetPage: 'menu',
  });
  rec('P2-coordinator-numeric-attemptId-rejected', numeric.ok === false && numeric.code === 'AGENT_ATTEMPT_NOT_FOUND',
    { code: numeric.code, message: numeric.message });

  // P3：经由 IPC 的真实 submit（端到端）：attemptId 字符串 'attempt-1' 由 IPC 自己解析
  const ipcSubmit = await ipc.invoke('agent:submit-candidate', {
    projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId, targetPage: 'menu',
  });
  rec('P3-ipc-submit-real-coordinator', ipcSubmit.ok === true, { ok: ipcSubmit.ok, code: ipcSubmit.code || null, message: ipcSubmit.message || null });

  // P4：如果 P3 失败，再验证直接调用 Coordinator（字符串 attemptId）是成功的——证明失败来自适配层
  const directSubmit = coordinator.submitAttempt({
    projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId, targetPage: 'menu',
  });
  rec('P4-coordinator-string-attemptId-ok', directSubmit.ok === true,
    directSubmit.ok ? { exportRelative: directSubmit.exportRelative } : { code: directSubmit.code, message: directSubmit.message });

  // P5：经 IPC 的真实 adopt（端到端）
  const ipcAdopt = await ipc.invoke('agent:adopt-attempt', {
    projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId, targetPage: 'menu', partialConfirmed: true,
  });
  rec('P5-ipc-adopt-real-coordinator', ipcAdopt.ok === true, { ok: ipcAdopt.ok, code: ipcAdopt.code || null, message: ipcAdopt.message || null });

  // P6：直接 Coordinator adopt（字符串 attemptId）作为对照
  const directAdopt = coordinator.adoptAttempt({
    projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId, targetPage: 'menu', partialConfirmed: true,
  });
  rec('P6-coordinator-string-adopt-ok', directAdopt.ok === true, directAdopt.ok ? { version: directAdopt.adoptedVersionId } : { code: directAdopt.code, message: directAdopt.message });

  // P7：F4 优先级（修正：保留原页面内容再追加，保证 source.check PASS）
  const userDataDir2 = userData();
  const coordinator2 = createRunCoordinator({
    userDataDir: userDataDir2,
    checks: checksMod.createCheckRegistry({ userDataDir: userDataDir2 }),
    directRuntime: null,
    emitProgress: () => {},
  });
  const run2 = coordinator2.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const green2 = await chainToGreen(coordinator2, run2, 'P7');
  const ctx2 = green2.ctx;
  const dir2 = attemptDirOf(userDataDir2, run2);
  const submitted2 = coordinator2.submitAttempt({ ...ctx2, targetPage: 'menu' });
  rec('P7a-submit-partial', submitted2.ok === true && submitted2.partial === true,
    submitted2.ok ? { partial: submitted2.partial, exportRelative: submitted2.exportRelative } : { code: submitted2.code, message: submitted2.message, statuses: green2.statuses });
  if (submitted2.ok) {
    const submissionFile = path.join(dir2, 'verification', 'submission.json');
    const orig = fs.readFileSync(submissionFile, 'utf8');
    const tampered = JSON.parse(orig);
    tampered.treeDigest = 'sha256:' + '0'.repeat(64);
    fs.writeFileSync(submissionFile, JSON.stringify(tampered), 'utf8');
    const staleNoConfirm = coordinator2.adoptAttempt({ ...ctx2 });
    fs.writeFileSync(submissionFile, orig, 'utf8');
    const dryFile = path.join(dir2, 'verification', 'checks', 'composer.dry-run.json');
    const dryOrig = fs.readFileSync(dryFile, 'utf8');
    const dryTampered = JSON.parse(dryOrig);
    dryTampered.exportTreeDigest = 'sha256:' + 'b'.repeat(64);
    fs.writeFileSync(dryFile, JSON.stringify(dryTampered), 'utf8');
    const staleExportNoConfirm = coordinator2.adoptAttempt({ ...ctx2 });
    fs.writeFileSync(dryFile, dryOrig, 'utf8');
    const noConfirm = coordinator2.adoptAttempt({ ...ctx2 });
    const confirmed = coordinator2.adoptAttempt({ ...ctx2, partialConfirmed: true });
    rec('P7b-adopt-stale-before-partial',
      staleNoConfirm.code === 'AGENT_EVIDENCE_STALE'
      && staleNoConfirm.nextAction === 'rerun-checks'
      && staleExportNoConfirm.code === 'AGENT_EVIDENCE_STALE'
      && noConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED'
      && noConfirm.nextAction === 'confirm-partial'
      && confirmed.ok === true,
    {
      staleTree: staleNoConfirm.code, staleTreeNext: staleNoConfirm.nextAction,
      staleExport: staleExportNoConfirm.code, noConfirm: noConfirm.code, confirmed: confirmed.ok,
    });
  }

  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(userDataDir2, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
  fs.writeFileSync(path.join(__dirname, 'probe2-result.json'), JSON.stringify(results, null, 2), 'utf8');
})();
