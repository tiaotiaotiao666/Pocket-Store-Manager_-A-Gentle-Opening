'use strict';

/**
 * Review-t1 independent probe (t14).
 *
 * Purpose: independently re-execute the acceptance facts of t1 / E0-W1
 * (WorkspaceRunCoordinator + attempt lifecycle) against the *current disk bytes*,
 * without copying implementation logic and without modifying the reviewed code.
 *
 * - Uses only public Coordinator APIs + B1/B2 modules; injected `checks` is an explicit
 *   test double (labeled fake) so lifecycle/gate semantics can be exercised offline.
 * - All temp state lives under os.tmpdir(); the repository is never written.
 * - Exit code 0 == every t1 acceptance probe below holds.
 *
 * Observations (OBS-*) are printed separately and do NOT affect the exit code:
 * they are outside t1 acceptance (routed to t5/t15 or E0-V1 by the review document).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const mod = require(path.join(REPO, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));
const versions = require(path.join(REPO, 'desktop', 'agent-workspace', 'versions.cjs'));
const workspace = require(path.join(REPO, 'desktop', 'agent-workspace', 'workspace.cjs'));
const manifest = require(path.join(REPO, 'desktop', 'agent-workspace', 'manifest.cjs'));
const agentIpc = require(path.join(REPO, 'desktop', 'agent-tools-ipc.cjs'));

const PROJECT = 'p_revprobe01';
const OTHER = 'p_revprobe02';

let failures = 0;
let checks = 0;

function rec(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' | ' + String(detail).slice(0, 220));
}

function obs(name, detail) {
  console.log('OBS  ' + name + ' | ' + String(detail).slice(0, 220));
}

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-t14-' + label + '-'));
}

function digestOf(dir) {
  const built = manifest.buildManifest(dir, { limits: undefined });
  return built.ok ? built.manifest.treeDigest : 'ERR:' + built.message;
}

function snapshot(dir) {
  const out = {};
  const walk = (current, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        out[relative] = fs.statSync(full).size + '|'
          + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Explicit test double (NOT product evidence): mirrors the B4 platform contract used by
 * E0-W2 checks (definitions[checkId].subject + composer.dry-run exportedRoot/exportTreeDigest).
 */
function fakeChecks(counter) {
  const definitions = {
    'source.check': { subject: 'attempt' },
    'composer.dry-run': { subject: 'attempt' },
    'mini.check': { subject: 'export' },
    'output.consistency': { subject: 'export' },
  };
  return {
    definitions,
    listChecks: () => Object.keys(definitions).map((checkId) => ({ checkId })),
    runCheck: async (request) => {
      counter.calls += 1;
      if (counter.hold) await counter.hold;
      if (request.checkId === 'composer.dry-run') {
        const exportedRoot = path.join(request.exportParentDir, 'dry-run');
        fs.mkdirSync(exportedRoot, { recursive: true });
        counter.exportTreeDigest = 'sha256:' + 'e'.repeat(64);
        return {
          ok: true,
          checkId: request.checkId,
          status: 'PASS',
          durationMs: 1,
          subjectKind: 'attempt',
          exportedRoot,
          exportTreeDigest: counter.exportTreeDigest,
          issues: [],
        };
      }
      return {
        ok: true,
        checkId: request.checkId,
        status: 'PASS',
        durationMs: 1,
        subjectKind: (request.checkId === 'mini.check' || request.checkId === 'output.consistency')
          ? 'version' : 'attempt',
        ...((request.checkId === 'mini.check' || request.checkId === 'output.consistency')
          ? { exportTreeDigest: counter.exportTreeDigest } : {}),
        issues: [],
      };
    },
    verifyWechat: async () => ({ ok: true, status: 'BLOCKED', durationMs: 1, issues: [] }),
  };
}

function ctxOf(run) {
  return { projectId: PROJECT, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
}

function attemptDirOf(userDataDir, run, projectId) {
  return path.join(
    userDataDir, 'projects', projectId || PROJECT, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId,
  );
}

async function main() {
  /* P1: no currentVersionId -> AGENT_VERSION_NOT_FOUND and zero directories created. */
  const root1 = tmp('p1');
  try {
    const coordinator = mod.createRunCoordinator({ userDataDir: root1 });
    const result = coordinator.startRun({
      projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
    });
    rec('P1 no-version startRun -> AGENT_VERSION_NOT_FOUND',
      result.ok === false && result.code === 'AGENT_VERSION_NOT_FOUND', result.code);
    rec('P1 no-version creates zero directories',
      !fs.existsSync(path.join(root1, 'projects')), 'projects exists=' + fs.existsSync(path.join(root1, 'projects')));
  } finally { fs.rmSync(root1, { recursive: true, force: true }); }

  /* P2/P4: copy from currentVersionId, revision/treeDigest, subject rules, submit/adopt codes. */
  const root2 = tmp('p2');
  try {
    const init = versions.initProject({ userDataDir: root2, projectId: PROJECT });
    rec('P2 initProject v1', init.ok === true, init.code || 'ok');
    const counter = { calls: 0, hold: null };
    const coordinator = mod.createRunCoordinator({ userDataDir: root2, checks: fakeChecks(counter) });
    const utteranceMarker = 'rev-probe-utterance-marker-9f2c';
    const run = coordinator.startRun({
      projectId: PROJECT, targetPage: 'menu', operation: 'edit-page',
      utterance: utteranceMarker, imageAssetIds: [],
    });
    rec('P2 startRun ok', run.ok === true, run.code || 'ok');
    const versionSource = versions.resolveVersionSource({ userDataDir: root2, projectId: PROJECT, versionId: 'v1' });
    rec('P2 attempt tree copied from versions/v1/source',
      versionSource.ok === true && run.baseTreeDigest === versionSource.treeDigest,
      run.baseTreeDigest + ' vs ' + versionSource.treeDigest);

    const ctx = ctxOf(run);
    const attemptDir = attemptDirOf(root2, run);
    const candidateDir = path.join(attemptDir, 'candidate');
    const runJson = JSON.parse(fs.readFileSync(path.join(root2, 'projects', PROJECT, 'agent-workspace', 'runs', run.runId, 'run.json'), 'utf8'));
    const attemptJson = JSON.parse(fs.readFileSync(path.join(attemptDir, 'attempt.json'), 'utf8'));
    const metaText = JSON.stringify(runJson) + JSON.stringify(attemptJson);
    rec('P2 run/attempt metadata stores only utteranceChars (no prompt text)',
      metaText.includes(utteranceMarker) === false, 'utteranceChars=' + runJson.utteranceChars);
    rec('P2 run/attempt metadata has no image data URL',
      /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(metaText) === false, 'metadata bytes=' + metaText.length);

    const readAttempt = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'app.json' } });
    rec('P2 subject fixed to attempt',
      readAttempt.ok === true && readAttempt.data.subject.kind === 'attempt'
        && readAttempt.data.subject.attemptId === run.attemptId,
      JSON.stringify(readAttempt.data && readAttempt.data.subject));
    const readVersion = await coordinator.invokeTool({
      ...ctx, tool: 'read_file', args: { path: 'app.json', subjectOverride: { kind: 'version', versionId: 'v1' } },
    });
    rec('P2 read_file subjectOverride version is read-only',
      readVersion.ok === true && readVersion.data.subject.kind === 'version',
      JSON.stringify(readVersion.data && readVersion.data.subject));
    const writeVersion = await coordinator.invokeTool({
      ...ctx, tool: 'write_files',
      args: { changes: [{ path: 'a.txt', content: 'x' }], subjectOverride: { kind: 'version', versionId: 'v1' } },
    });
    rec('P2 write_files rejects version subject',
      writeVersion.ok === false && writeVersion.code === 'AGENT_PAYLOAD_INVALID', writeVersion.code);
    const writeEscape = await coordinator.invokeTool({
      ...ctx, tool: 'read_file', args: { path: '../project.json', subjectOverride: { kind: 'version', versionId: 'v1' } },
    });
    rec('P2 version read rejects path escape',
      writeEscape.ok === false, writeEscape.code);

    const write1 = await coordinator.invokeTool({
      ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>rev</view>' }] },
    });
    const candidateDigest = digestOf(candidateDir);
    rec('P2 write bumps revision to 2 and recomputes treeDigest',
      write1.ok === true && write1.data.revision === 2 && write1.data.treeDigest === candidateDigest,
      'revision=' + (write1.data && write1.data.revision) + ' digestMatches=' + (write1.data && write1.data.treeDigest === candidateDigest));

    const adoptBefore = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
    rec('P4 adopt unsubmitted -> AGENT_ADOPTION_FAILED + issue NOT_SUBMITTED',
      adoptBefore.ok === false && adoptBefore.code === 'AGENT_ADOPTION_FAILED'
        && adoptBefore.issues[0] && adoptBefore.issues[0].code === 'NOT_SUBMITTED',
      adoptBefore.code + '/' + (adoptBefore.issues[0] && adoptBefore.issues[0].code));

    await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
    await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
    const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
    rec('P2 submit ok with partial + F1 fields',
      submitted.ok === true && submitted.status === 'submitted' && submitted.partial === true
        && typeof submitted.exportRelative === 'string' && path.isAbsolute(submitted.exportRelative) === false
        && typeof submitted.exportTreeDigest === 'string',
      'partial=' + submitted.partial + ' exportRelative=' + submitted.exportRelative);
    const immutableDigest = digestOf(candidateDir);
    const blockedWrite = await coordinator.invokeTool({
      ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>nope</view>' }] },
    });
    const blockedDelete = await coordinator.invokeTool({
      ...ctx, tool: 'delete_files', args: { paths: [{ path: 'sitemap.json' }] },
    });
    rec('P2 post-submit write/delete -> AGENT_ATTEMPT_IMMUTABLE and tree unchanged',
      blockedWrite.ok === false && blockedWrite.code === 'AGENT_ATTEMPT_IMMUTABLE'
        && blockedDelete.ok === false && blockedDelete.code === 'AGENT_ATTEMPT_IMMUTABLE'
        && digestOf(candidateDir) === immutableDigest,
      blockedWrite.code + '/' + blockedDelete.code);
    const repeatSubmit = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
    rec('P2 repeat submit -> AGENT_RUN_ALREADY_SUBMITTED',
      repeatSubmit.ok === false && repeatSubmit.code === 'AGENT_RUN_ALREADY_SUBMITTED', repeatSubmit.code);

    const submissionFile = path.join(attemptDir, 'verification', 'submission.json');
    const originalSubmission = fs.readFileSync(submissionFile, 'utf8');
    const tampered = JSON.parse(originalSubmission);
    tampered.treeDigest = 'sha256:' + '0'.repeat(64);
    fs.writeFileSync(submissionFile, JSON.stringify(tampered), 'utf8');
    const staleNoConfirm = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
    rec('P4 stale evidence is judged before partial (F4)',
      staleNoConfirm.ok === false && staleNoConfirm.code === 'AGENT_EVIDENCE_STALE'
        && staleNoConfirm.nextAction === 'rerun-checks',
      staleNoConfirm.code + '/' + staleNoConfirm.nextAction);
    fs.writeFileSync(submissionFile, originalSubmission, 'utf8');
    const partialNoConfirm = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
    rec('P4 partial evidence requires explicit confirm',
      partialNoConfirm.ok === false && partialNoConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED'
        && partialNoConfirm.nextAction === 'confirm-partial',
      partialNoConfirm.code + '/' + partialNoConfirm.nextAction);
    const adopted = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
    rec('P2 adopt delegates to B2 and produces v2',
      adopted.ok === true && /^v/.test(String(adopted.adoptedVersionId)),
      adopted.code || ('adopted=' + adopted.adoptedVersionId));
    const repeatAdopt = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
    rec('P4 repeat adopt (status adopted) -> AGENT_ADOPTION_FAILED + NOT_SUBMITTED',
      repeatAdopt.ok === false && repeatAdopt.code === 'AGENT_ADOPTION_FAILED'
        && repeatAdopt.issues[0] && repeatAdopt.issues[0].code === 'NOT_SUBMITTED',
      repeatAdopt.code);
    const tooLate = coordinator.cancelRun({ projectId: PROJECT, runId: run.runId });
    rec('P4 cancel after adopt -> too-late',
      tooLate.state === 'too-late' && tooLate.cancelled === false, JSON.stringify(tooLate));

    /* OBS-3: read_file subjectOverride accepts non-base versions (read-only). */
    const nonBaseVersion = adopted.ok ? adopted.adoptedVersionId : null;
    if (nonBaseVersion) {
      const readNonBase = await coordinator.invokeTool({
        ...ctx, tool: 'read_file', args: { path: 'app.json', subjectOverride: { kind: 'version', versionId: nonBaseVersion } },
      });
      obs('OBS-3 read_file subjectOverride non-base version', 'versionId=' + nonBaseVersion
        + ' ok=' + readNonBase.ok + ' code=' + (readNonBase.code || 'none')
        + ' (frozen text says "base version"; read-only, zero writes)');
    }
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }

  /* P5: requested -> cancelled, late tools zero writes, no direct call after cancel. */
  const root3 = tmp('p5');
  try {
    versions.initProject({ userDataDir: root3, projectId: PROJECT });
    const counter = { calls: 0, hold: null };
    const direct = { calls: 0 };
    const coordinator = mod.createRunCoordinator({
      userDataDir: root3,
      checks: fakeChecks(counter),
      directRuntime: {
        invoke: async () => { direct.calls += 1; return { ok: true, data: { text: 'ok' } }; },
      },
    });
    const run = coordinator.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
    const ctx = ctxOf(run);
    await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>c</view>' }] } });
    let release;
    counter.hold = new Promise((resolve) => { release = resolve; });
    const pending = coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const requested = coordinator.cancelRun({ projectId: PROJECT, runId: run.runId });
    rec('P5 in-flight cancel -> requested (not yet cancelled)',
      requested.state === 'requested' && requested.cancelled === false, JSON.stringify(requested));
    release();
    counter.hold = null;
    const late = await pending;
    rec('P5 late async check result discarded (AGENT_CANCELLED)', late.ok === false && late.code === 'AGENT_CANCELLED', late.code);
    const settled = coordinator.getRun({ projectId: PROJECT, runId: run.runId });
    rec('P5 run settles to cancelled after in-flight call', settled.state === 'cancelled', settled.state);
    const candidateDir = path.join(attemptDirOf(root3, run), 'candidate');
    const before = snapshot(candidateDir);
    const lateWrite = await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'late.txt', content: 'x' }] } });
    const lateDirect = await coordinator.invokeDirect({ ...ctx, request: { messages: [] } });
    const after = snapshot(candidateDir);
    rec('P5 late write rejected with zero writes',
      lateWrite.ok === false && lateWrite.code === 'AGENT_CANCELLED'
        && JSON.stringify(before) === JSON.stringify(after), lateWrite.code);
    rec('P5 late direct call rejected without any upstream call',
      lateDirect.ok === false && lateDirect.code === 'AGENT_CANCELLED' && direct.calls === 0,
      lateDirect.code + ' directCalls=' + direct.calls);
    const again = coordinator.cancelRun({ projectId: PROJECT, runId: run.runId });
    rec('P5 repeated cancel is idempotent cancelled', again.state === 'cancelled' && again.cancelled === true, JSON.stringify(again));

    /* OBS-1: cancel during in-flight invokeDirect: the internal helper returns the raw result. */
    const directRoot = tmp('obs1');
    try {
      versions.initProject({ userDataDir: directRoot, projectId: PROJECT });
      let releaseDirect;
      const gate = new Promise((resolve) => { releaseDirect = resolve; });
      const directCalls = { count: 0 };
      const c2 = mod.createRunCoordinator({
        userDataDir: directRoot,
        directRuntime: {
          invoke: async () => { directCalls.count += 1; await gate; return { ok: true, data: { text: 'late-model-output' } }; },
        },
      });
      const run2 = c2.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
      const ctx2 = ctxOf(run2);
      const inflight = c2.invokeDirect({ ...ctx2, request: { messages: [] } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancel2 = c2.cancelRun({ projectId: PROJECT, runId: run2.runId });
      releaseDirect();
      const inflightResult = await inflight;
      const afterState = c2.getRun({ projectId: PROJECT, runId: run2.runId });
      obs('OBS-1 cancel during in-flight invokeDirect',
        'cancel=' + cancel2.state + ' returnedOk=' + inflightResult.ok
        + ' runState=' + afterState.state
        + ' (comment at run-coordinator.cjs:1121-1123 claims the late result is dropped;'
        + ' direct runtime layer re-checks assertRunActive, no disk write here)');
    } finally { fs.rmSync(directRoot, { recursive: true, force: true }); }

    /* OBS-2: adopt when submission.json lacks exportTreeDigest (F1 strictness, t5 scope). */
    const f1Root = tmp('obs2');
    try {
      versions.initProject({ userDataDir: f1Root, projectId: PROJECT });
      const f1Checks = fakeChecks({ calls: 0, hold: null });
      delete f1Checks.definitions['mini.check'];
      delete f1Checks.definitions['output.consistency'];
      f1Checks.listChecks = () => Object.keys(f1Checks.definitions).map((checkId) => ({ checkId }));
      const c3 = mod.createRunCoordinator({ userDataDir: f1Root, checks: f1Checks });
      const run3 = c3.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
      const ctx3 = ctxOf(run3);
      await c3.invokeTool({ ...ctx3, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>f1</view>' }] } });
      await c3.invokeTool({ ...ctx3, tool: 'run_check', args: { checkId: 'source.check' } });
      await c3.invokeTool({ ...ctx3, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      c3.submitAttempt({ ...ctx3, targetPage: 'menu' });
      const f1Submission = path.join(attemptDirOf(f1Root, run3), 'verification', 'submission.json');
      const parsed = JSON.parse(fs.readFileSync(f1Submission, 'utf8'));
      const hadDigest = typeof parsed.exportTreeDigest === 'string';
      delete parsed.exportTreeDigest;
      delete parsed.exportRelative;
      fs.writeFileSync(f1Submission, JSON.stringify(parsed), 'utf8');
      const adoptedNoDigest = c3.adoptAttempt({ ...ctx3, targetPage: 'menu', partialConfirmed: true });
      obs('OBS-2 adopt without exportTreeDigest',
        'submitHadDigest=' + hadDigest + ' adoptOk=' + adoptedNoDigest.ok
        + ' code=' + (adoptedNoDigest.code || 'none')
        + ' (rev15 14.13-1: "missing exportTreeDigest => must not adopt"; t5/t15 scope)');
    } finally { fs.rmSync(f1Root, { recursive: true, force: true }); }
  } finally { fs.rmSync(root3, { recursive: true, force: true }); }

  /* P3: attempt dir replaced by a junction -> rejected, link target receives zero writes. */
  const root4 = tmp('p3');
  try {
    versions.initProject({ userDataDir: root4, projectId: PROJECT });
    const coordinator = mod.createRunCoordinator({ userDataDir: root4 });
    const run = coordinator.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
    const ctx = ctxOf(run);
    const attemptDir = attemptDirOf(root4, run);
    const target = path.join(root4, 'junction-target');
    fs.cpSync(attemptDir, target, { recursive: true });
    fs.rmSync(attemptDir, { recursive: true, force: true });
    fs.symlinkSync(target, attemptDir, 'junction');
    const targetDigestBefore = digestOf(path.join(target, 'candidate'));
    const rejected = await coordinator.invokeTool({
      ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }] },
    });
    const targetDigestAfter = digestOf(path.join(target, 'candidate'));
    rec('P3 junction attempt dir rejected',
      rejected.ok === false && ['AGENT_PATH_LINK', 'AGENT_ATTEMPT_NOT_FOUND', 'AGENT_WORKSPACE_NOT_FOUND'].includes(rejected.code),
      rejected.code);
    rec('P3 junction link target receives zero writes', targetDigestBefore === targetDigestAfter,
      'digestStable=' + (targetDigestBefore === targetDigestAfter));
  } finally { fs.rmSync(root4, { recursive: true, force: true }); }

  /* P6: copied run dir under another project -> AGENT_PROJECT_MISMATCH, zero writes. */
  const root5 = tmp('p6');
  try {
    versions.initProject({ userDataDir: root5, projectId: PROJECT });
    versions.initProject({ userDataDir: root5, projectId: OTHER });
    const coordinator = mod.createRunCoordinator({ userDataDir: root5 });
    const run = coordinator.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
    const sourceRunDir = path.join(root5, 'projects', PROJECT, 'agent-workspace', 'runs', run.runId);
    const otherOpened = workspace.openWorkspace({ userDataDir: root5, projectId: OTHER });
    const otherRunsDir = otherOpened.workspace.runsDir;
    fs.mkdirSync(otherRunsDir, { recursive: true });
    const copiedRunDir = path.join(otherRunsDir, run.runId);
    fs.cpSync(sourceRunDir, copiedRunDir, { recursive: true });
    const before = snapshot(copiedRunDir);
    const mismatched = await coordinator.invokeTool({
      ...ctxOf(run), projectId: OTHER, tool: 'write_files',
      args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }] },
    });
    const after = snapshot(copiedRunDir);
    rec('P6 forged projectId handle -> AGENT_PROJECT_MISMATCH',
      mismatched.ok === false && mismatched.code === 'AGENT_PROJECT_MISMATCH', mismatched.code);
    rec('P6 forged run copy receives zero writes',
      JSON.stringify(before) === JSON.stringify(after), 'stable=' + (JSON.stringify(before) === JSON.stringify(after)));
    const badRun = await coordinator.invokeTool({ ...ctxOf(run), runId: 'frun-does-not-exist', tool: 'get_context', args: {} });
    const badTurn = await coordinator.invokeTool({ ...ctxOf(run), turnId: 'turn-9', tool: 'get_context', args: {} });
    const badAttempt = await coordinator.invokeTool({ ...ctxOf(run), attemptId: 'attempt-7', tool: 'get_context', args: {} });
    rec('P6 run/turn/attempt lookup failures use frozen codes (§14.13-5)',
      badRun.code === 'AGENT_RUN_NOT_FOUND' && badTurn.code === 'AGENT_ATTEMPT_NOT_FOUND'
        && badAttempt.code === 'AGENT_ATTEMPT_NOT_FOUND',
      badRun.code + '/' + badTurn.code + '/' + badAttempt.code);
  } finally { fs.rmSync(root5, { recursive: true, force: true }); }

  /* OBS-4: legacy B3 IPC is a second write path to a submitted attempt (t1 report deferred
   * "agent:* unified onto Coordinator" to W2; final bytes only route submit/adopt). */
  const b3Root = tmp('obs4');
  try {
    versions.initProject({ userDataDir: b3Root, projectId: PROJECT });
    const counter = { calls: 0, hold: null };
    const coordinator = mod.createRunCoordinator({ userDataDir: b3Root, checks: fakeChecks(counter) });
    const run = coordinator.startRun({ projectId: PROJECT, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
    const ctx = ctxOf(run);
    await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>b3</view>' }] } });
    await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
    await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
    const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
    const ipc = agentIpc.createAgentToolsIpc({ userDataDir: b3Root, checks: false, coordinator });
    const viaB3 = await ipc.invoke('agent:write-files', {
      projectId: PROJECT, runId: run.runId, turnId: run.turnId,
      changes: [{ path: 'pages/menu/index.wxml', content: '<view>written-after-submit</view>' }],
    });
    const state = coordinator.getAttemptState(ctx);
    const page = fs.readFileSync(path.join(attemptDirOf(b3Root, run), 'candidate', 'pages', 'menu', 'index.wxml'), 'utf8');
    const cancelViaB3 = await ipc.invoke('agent:cancel-run', { projectId: PROJECT, runId: run.runId });
    const coordinatorRunState = coordinator.getRun({ projectId: PROJECT, runId: run.runId }).state;
    obs('OBS-4 legacy B3 IPC bypasses Coordinator post-submit read-only',
      'submitOk=' + submitted.ok + ' b3WriteOk=' + viaB3.ok + ' b3Revision=' + (viaB3.data && viaB3.data.revision)
      + ' attemptStatus=' + state.status + ' candidateChanged=' + page.includes('written-after-submit')
      + ' b3Cancel=' + (cancelViaB3.data && cancelViaB3.data.state) + ' coordinatorRunState=' + coordinatorRunState
      + ' (t1 report 6-4 deferred agent:* unification to W2; final bytes only route submit/adopt)');
  } finally { fs.rmSync(b3Root, { recursive: true, force: true }); }

  /* P7: main.cjs / preload / coordinator static surface. */
  const mainSource = fs.readFileSync(path.join(REPO, 'desktop', 'main.cjs'), 'utf8');
  const coordinatorSource = fs.readFileSync(path.join(REPO, 'desktop', 'agent-workspace', 'run-coordinator.cjs'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const requireMatches = mainSource.match(/require\('\.\/agent-workspace\/run-coordinator\.cjs'\)/g) || [];
  const createMatches = mainSource.match(/createRunCoordinator\(/g) || [];
  rec('P7 main.cjs requires coordinator exactly once', requireMatches.length === 1, 'count=' + requireMatches.length);
  rec('P7 main.cjs instantiates coordinator exactly once', createMatches.length === 1, 'count=' + createMatches.length);
  rec('P7 main.cjs has no generic agent dir/path/shell/exec channel',
    /ipcMain\.handle\('agent:[^']*(dir|path|shell|exec)/i.test(mainSource) === false, 'regex');
  rec('P7 coordinator has no electron/child_process entry',
    /require\('electron'\)/.test(coordinatorSource) === false
      && /require\('(node:)?child_process'\)/.test(coordinatorSource) === false,
    'static');
  const agentChannels = Array.from(preloadSource.matchAll(/ipcRenderer\.invoke\('(agent:[^']+)'/g)).map((match) => match[1]);
  rec('P7 preload agent channels are semantic only (no dir/path/fs/shell/exec)',
    agentChannels.length === 20 && agentChannels.some((name) => /(dir|path|shell|exec|fs)/i.test(name)) === false,
    agentChannels.length + ' channels');

  console.log('SUMMARY checks=' + checks + ' failures=' + failures);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('PROBE_CRASH', error && error.stack ? error.stack : error);
  process.exitCode = 2;
});
