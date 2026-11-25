'use strict';

/** t15 复核补充探针 4：身份一致性（§14.12-Q2）+ PASS 证据缺 exportTreeDigest 的门禁口径（t10-F4 残留）。 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const workspaceMod = load('desktop/agent-workspace/workspace.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const manifestMod = load('desktop/agent-workspace/manifest.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');

const PROJECT_ID = 'p_t15probe4';
const OTHER = 'p_t15other4';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok ? '' : ' :: ' + JSON.stringify(detail)));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function userData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-p4-'));
  for (const projectId of [PROJECT_ID, OTHER]) {
    const init = versions.initProject({ userDataDir: dir, projectId });
    if (!init.ok) throw new Error('init ' + JSON.stringify(init));
  }
  return dir;
}
function attemptDirOf(userDataDir, run, projectId) {
  return path.join(userDataDir, 'projects', projectId || PROJECT_ID, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId);
}
function candidateDigest(dir) {
  const built = manifestMod.buildManifest(path.join(dir, 'candidate'), {});
  return built.ok ? built.manifest.treeDigest : null;
}

async function greenChain(coordinator, run, marker) {
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  const patched = read.data.content.replace(/<\/view>\s*$/, '  <view class="t15p4">' + marker + '</view>\n</view>\n');
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  return { ctx };
}

(async () => {
  const userDataDir = userData();
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir }),
    directRuntime: null,
    emitProgress: () => {},
  });

  // R1：把 run 目录复制到另一个合法 projectId 下 → AGENT_PROJECT_MISMATCH 且零落盘
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const attemptDir = attemptDirOf(userDataDir, run);
  const before = candidateDigest(attemptDir);
  const otherWs = workspaceMod.openWorkspace({ userDataDir, projectId: OTHER });
  const srcRuns = workspaceMod.workspacePaths({ userDataDir, projectId: PROJECT_ID });
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(source, target);
      else if (entry.isFile()) fs.copyFileSync(source, target);
    }
  };
  fs.mkdirSync(otherWs.workspace.runsDir, { recursive: true });
  copyTree(path.join(srcRuns.runsDir, run.runId), path.join(otherWs.workspace.runsDir, run.runId));
  const mismatched = await coordinator.invokeTool({
    projectId: OTHER, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId,
    tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }] },
  });
  const hijackPage = path.join(otherWs.workspace.runsDir, run.runId, 'turns', run.turnId, 'attempts', run.attemptId, 'candidate', 'pages', 'menu', 'index.wxml');
  const hijackText = fs.existsSync(hijackPage) ? fs.readFileSync(hijackPage, 'utf8') : '';
  rec('R1-project-mismatch-zero-write', mismatched.ok === false && mismatched.code === 'AGENT_PROJECT_MISMATCH'
    && !hijackText.includes('hijack') && candidateDigest(attemptDir) === before,
  { code: mismatched.code, hijackWritten: hijackText.includes('hijack') });

  // R4：mini.check 的 PASS 证据缺 exportTreeDigest（t10-F4 残留口径）→ 独立 run，观察门禁是否把它当“一致”
  const run3 = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const green3 = await greenChain(coordinator, run3, 'R4');
  const dir3 = attemptDirOf(userDataDir, run3);
  const miniEvidenceFile = path.join(dir3, 'verification', 'checks', 'mini.check.json');
  const miniEvidence = readJson(miniEvidenceFile);
  const miniNoDigest = { ...miniEvidence };
  delete miniNoDigest.exportTreeDigest;
  fs.writeFileSync(miniEvidenceFile, JSON.stringify(miniNoDigest), 'utf8');
  const submit3 = coordinator.submitAttempt({ ...green3.ctx, targetPage: 'menu' });
  rec('R4-pass-evidence-without-export-digest', submit3.ok === false,
    { submitOk: submit3.ok, submitCode: submit3.code || null, partial: submit3.partial });

  fs.rmSync(userDataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failed.length + (failed.length ? ' [' + failed.join(',') + ']' : ''));
})();
