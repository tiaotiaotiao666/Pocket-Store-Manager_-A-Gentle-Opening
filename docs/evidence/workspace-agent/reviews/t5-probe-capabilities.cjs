'use strict';

/** t15 复核补充探针 3：submit 前缺 bundle 不得派生（F3/X6 负例）+ capabilities.check 独立/别名。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const manifestMod = load('desktop/agent-workspace/manifest.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');

const PROJECT_ID = 'p_t15probe3';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function userData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-p3-'));
  const init = versions.initProject({ userDataDir: dir, projectId: PROJECT_ID });
  if (!init.ok) throw new Error('init ' + JSON.stringify(init));
  return dir;
}
function attemptDirOf(userDataDir, run) {
  return path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId);
}

(async () => {
  const userDataDir = userData();
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime: null,
    emitProgress: () => {},
  });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  const dir = attemptDirOf(userDataDir, run);

  // Q1：写一行（保留原内容）但**不跑任何检查** → submit 必须 STATIC_GATE_FAILED，且不派生 bundle
  const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  const patched = read.data.content.replace(/<\/view>\s*$/, '  <view class="t15p3">Q1</view>\n</view>\n');
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] } });
  const bundleFile = path.join(dir, 'candidate', 'source-bundle.json');
  const bundleAbsentBefore = !fs.existsSync(bundleFile);
  const revisionBefore = readJson(path.join(dir, 'attempt.json')).revision;
  const submitNoChecks = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  const bundleAbsentAfter = !fs.existsSync(bundleFile);
  const revisionAfter = readJson(path.join(dir, 'attempt.json')).revision;
  rec('Q1-submit-missing-bundle-no-derive',
    submitNoChecks.ok === false
    && (submitNoChecks.code === 'AGENT_STATIC_GATE_FAILED' || submitNoChecks.code === 'AGENT_EVIDENCE_STALE')
    && bundleAbsentBefore && bundleAbsentAfter && revisionBefore === revisionAfter,
    { code: submitNoChecks.code, bundleAbsentBefore, bundleAbsentAfter, revisionBefore, revisionAfter, message: submitNoChecks.message });

  // Q2：证据主体表（动态读注册表，而不是只看测试里的常量表）
  const subjects = {};
  for (const checkId of checksMod.CHECK_IDS) subjects[checkId] = checksMod.CHECK_DEFINITIONS[checkId].subject;
  rec('Q2-subject-table', subjects['source.check'] === 'attempt'
    && subjects['composer.dry-run'] === 'attempt'
    && subjects['mini.check'] === 'export'
    && subjects['output.consistency'] === 'export'
    && subjects['wechat.verify'] === 'export'
    && subjects['capabilities.check'] === 'repo',
  subjects);

  // Q3：capabilities.check 是独立仓库级检查（不需要 attempt/export 根），alias 归一到 canonical 并写同一份证据
  const repoCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'capabilities.check' } });
  rec('Q3-capabilities-check-independent',
    repoCheck.ok === true && repoCheck.data.checkId === 'capabilities.check'
    && repoCheck.data.subjectKind === 'repo'
    && ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(repoCheck.data.status),
  repoCheck.ok ? { checkId: repoCheck.data.checkId, status: repoCheck.data.status, subjectKind: repoCheck.data.subjectKind } : { code: repoCheck.code, message: repoCheck.message });

  const aliasCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'capabilities.source-facts' } });
  const capabilityEvidence = path.join(dir, 'verification', 'checks', 'capabilities.check.json');
  rec('Q4-alias-canonical-evidence',
    aliasCheck.ok === true && aliasCheck.data.checkId === 'capabilities.check'
    && fs.existsSync(capabilityEvidence)
    && readJson(capabilityEvidence).checkId === 'capabilities.check',
  aliasCheck.ok ? { checkId: aliasCheck.data.checkId, evidenceExists: fs.existsSync(capabilityEvidence) } : { code: aliasCheck.code, message: aliasCheck.message });

  fs.rmSync(userDataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
})();
