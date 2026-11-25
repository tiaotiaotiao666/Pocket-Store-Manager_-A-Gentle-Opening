'use strict';

/** t15 复核补充探针 5：已提交后的证据绑定边界（每次用全新 run，避免状态污染）。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');

const PROJECT_ID = 'p_t15probe5';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function attemptDirOf(userDataDir, run) {
  return path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId);
}
async function greenAndSubmit(coordinator, marker) {
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  const patched = read.data.content.replace(/<\/view>\s*$/, '  <view class="t15p5">' + marker + '</view>\n</view>\n');
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  return { run, ctx, dir: attemptDirOf(coordinatorUserData, run), submitted };
}

let coordinatorUserData = '';
(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-p5-'));
  coordinatorUserData = userDataDir;
  const init = versions.initProject({ userDataDir, projectId: PROJECT_ID });
  if (!init.ok) throw new Error('init ' + JSON.stringify(init));
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime: null,
    emitProgress: () => {},
  });

  // S1：dry-run 证据文件被删 → adopt 必须 AGENT_EVIDENCE_STALE（导出树绑定不能只看 submission）
  const a = await greenAndSubmit(coordinator, 'S1');
  const dryFile = path.join(a.dir, 'verification', 'checks', 'composer.dry-run.json');
  const dryBackup = fs.readFileSync(dryFile, 'utf8');
  fs.rmSync(dryFile);
  const missingDry = coordinator.adoptAttempt({ ...a.ctx, partialConfirmed: true });
  fs.writeFileSync(dryFile, dryBackup, 'utf8');
  rec('S1-adopt-dryrun-evidence-deleted', a.submitted.ok === true && missingDry.ok === false && missingDry.code === 'AGENT_EVIDENCE_STALE',
    { submitOk: a.submitted.ok, adoptCode: missingDry.code || null, adoptOk: missingDry.ok });

  // S2：submission.json 的 exportTreeDigest 与 dry-run 证据不一致 → AGENT_EVIDENCE_STALE
  const b = await greenAndSubmit(coordinator, 'S2');
  const bSubmissionFile = path.join(b.dir, 'verification', 'submission.json');
  const bSubmissionOrig = fs.readFileSync(bSubmissionFile, 'utf8');
  const bSubmission = JSON.parse(bSubmissionOrig);
  bSubmission.exportTreeDigest = 'sha256:' + 'e'.repeat(64);
  fs.writeFileSync(bSubmissionFile, JSON.stringify(bSubmission), 'utf8');
  const mismatchAdopt = coordinator.adoptAttempt({ ...b.ctx, partialConfirmed: true });
  fs.writeFileSync(bSubmissionFile, bSubmissionOrig, 'utf8');
  rec('S2-adopt-exportdigest-mismatch', mismatchAdopt.ok === false && mismatchAdopt.code === 'AGENT_EVIDENCE_STALE',
    { adoptCode: mismatchAdopt.code || null, adoptOk: mismatchAdopt.ok });

  // S3：submission.json 缺 exportTreeDigest（旧/伪造证据）→ §14.13-1「缺 exportTreeDigest 即不可 adopt」
  const c = await greenAndSubmit(coordinator, 'S3');
  const cSubmissionFile = path.join(c.dir, 'verification', 'submission.json');
  const cSubmissionOrig = fs.readFileSync(cSubmissionFile, 'utf8');
  const cSubmission = JSON.parse(cSubmissionOrig);
  delete cSubmission.exportTreeDigest;
  fs.writeFileSync(cSubmissionFile, JSON.stringify(cSubmission), 'utf8');
  const noDigestAdopt = coordinator.adoptAttempt({ ...c.ctx, partialConfirmed: true });
  rec('S3-adopt-missing-exportdigest-rejected', noDigestAdopt.ok === false,
    { adoptOk: noDigestAdopt.ok, adoptCode: noDigestAdopt.code || null });

  // S4：submission.json 的 treeDigest 与候选不一致 → AGENT_EVIDENCE_STALE（且优先于 partial）
  const d = await greenAndSubmit(coordinator, 'S4');
  const dSubmissionFile = path.join(d.dir, 'verification', 'submission.json');
  const dSubmissionOrig = fs.readFileSync(dSubmissionFile, 'utf8');
  const dSubmission = JSON.parse(dSubmissionOrig);
  dSubmission.treeDigest = 'sha256:' + 'f'.repeat(64);
  fs.writeFileSync(dSubmissionFile, JSON.stringify(dSubmission), 'utf8');
  const staleNoConfirm = coordinator.adoptAttempt({ ...d.ctx });
  fs.writeFileSync(dSubmissionFile, dSubmissionOrig, 'utf8');
  const normalNoConfirm = coordinator.adoptAttempt({ ...d.ctx });
  rec('S4-adopt-tree-stale-before-partial', staleNoConfirm.ok === false && staleNoConfirm.code === 'AGENT_EVIDENCE_STALE'
    && staleNoConfirm.nextAction === 'rerun-checks'
    && normalNoConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED'
    && normalNoConfirm.nextAction === 'confirm-partial',
  { staleCode: staleNoConfirm.code || null, staleNext: staleNoConfirm.nextAction || null, normalCode: normalNoConfirm.code || null, normalNext: normalNoConfirm.nextAction || null });

  fs.rmSync(userDataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
})();
