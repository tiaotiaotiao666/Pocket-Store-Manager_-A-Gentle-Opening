'use strict';

/**
 * E0-W1：WorkspaceRunCoordinator 与 attempt 生命周期（X1/X3）。
 *
 * 契约：`docs/handoff/Workspace-Agent-B阶段接口冻结.md` rev15 §14.2/§14.3/§14.9。
 * 覆盖（无 UI、纯 Node）：
 * - 冻结签名与参数校验；模型工具面 11 个 + 平台专用名拒绝；
 * - startRun 从 currentVersionId 的 `versions/<id>/source` 复制工作树；无版本 → AGENT_VERSION_NOT_FOUND 且不建目录；
 * - 工具 subject 固定 attempt；read_file 可只读 base 版本；写入永不接受 version subject；
 * - 写事务后 revision 递增并重算 treeDigest；跨项目/跨 run/跨 turn/伪造句柄拒绝且零落盘；
 * - cancelRun 三态（requested/cancelled/too-late）+ 迟到调用不落盘、不调 direct runtime；
 * - submit 静态门禁、提交后只读、重复提交、adopt 委托 B2；重开一致性；
 * - main.cjs 单例接线与“不暴露目录/不新增 fs/exec 通道”的静态断言。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const coordinatorMod = require(path.join(h.AGENT_WORKSPACE_DIR, 'run-coordinator.cjs'));
const { createRunCoordinator, CODES, MODEL_TOOL_NAMES, PLATFORM_ONLY_TOOL_NAMES, RUN_STATES } = coordinatorMod;
const workspaceMod = h.loadModule('workspace');
const versionsMod = h.loadModule('versions');
const manifestMod = h.loadModule('manifest');
const constants = h.loadModule('constants');
const composerDigest = require(path.join(h.REPO, 'scripts', 'composer', 'digest.cjs'));

const PROJECT_ID = 'proj-w1';
const OTHER_PROJECT_ID = 'proj-w1-other';
const FROZEN_METHODS = [
  'startRun', 'getRun', 'invokeTool', 'getAttemptState', 'cancelRun', 'submitAttempt', 'adoptAttempt',
];
const FROZEN_CODES = [
  'AGENT_RUN_NOT_FOUND', 'AGENT_RUN_ALREADY_SUBMITTED', 'AGENT_ATTEMPT_IMMUTABLE',
  'AGENT_STATIC_GATE_FAILED', 'AGENT_TOOL_NOT_ALLOWED', 'AGENT_EVIDENCE_STALE',
  'AGENT_PARTIAL_CONFIRM_REQUIRED', 'AGENT_CANCELLED', 'AGENT_PROJECT_MISMATCH',
  'AGENT_ATTEMPT_NOT_FOUND', 'AGENT_TARGET_PAGE_UNSUPPORTED', 'AGENT_VERSION_NOT_FOUND',
  'AGENT_ADOPTION_FAILED',
];

/* ------------------------------ 夹具 ------------------------------ */

function setup(t) {
  const userDataDir = h.userDataWith(t, 'w1');
  const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, 'initProject 失败：' + JSON.stringify(init));
  return { userDataDir, init };
}

/**
 * 测试替身：只在测试里用。**必须**与真实 B4 注册表的平台契约一致（rev15 §14.4）：
 * - 暴露 `definitions[checkId].subject`，Coordinator 据此决定 root；
 * - `composer.dry-run` 返回派生的导出根 + 导出树摘要（否则 submit 门禁会如实拒绝）；
 * - 声明 `subjectKind:'attempt'` 表示“查的是本次 attempt 树”。
 */
function fakeChecks(state) {
  const counters = state || { calls: 0, hold: null };
  const definitions = {
    'source.check': { subject: 'attempt' },
    'composer.dry-run': { subject: 'attempt' },
    'mini.check': { subject: 'export' },
    'output.consistency': { subject: 'export' },
  };
  return {
    counters,
    registry: {
      listChecks: () => Object.keys(definitions).map((checkId) => ({ checkId })),
      definitions,
      runCheck: async (request) => {
        counters.calls += 1;
        if (counters.hold) await counters.hold;
        if (request.checkId === 'composer.dry-run') {
          const exportedRoot = path.join(request.exportParentDir, 'dry-run');
          fs.mkdirSync(exportedRoot, { recursive: true });
          counters.exportTreeDigest = composerDigest.treeSha256(exportedRoot);
          return {
            ok: true,
            checkId: request.checkId,
            status: 'PASS',
            durationMs: 2,
            subjectKind: 'attempt',
            exportedRoot,
            exportTreeDigest: counters.exportTreeDigest,
            fileCount: 1,
            issues: [],
          };
        }
        return {
          ok: true,
          checkId: request.checkId,
          status: 'PASS',
          durationMs: 2,
          subjectKind: request.checkId === 'mini.check' || request.checkId === 'output.consistency' ? 'export' : 'attempt',
          ...(request.checkId === 'mini.check' || request.checkId === 'output.consistency'
            ? { exportTreeDigest: counters.exportTreeDigest }
            : {}),
          issues: [],
        };
      },
      verifyWechat: async () => ({
        ok: true,
        status: 'BLOCKED',
        durationMs: 1,
        pages: [],
        interactions: [],
        screenshots: [],
        issues: [],
      }),
    },
  };
}

async function runGateChecks(coordinator, ctx) {
  for (const checkId of ['source.check', 'composer.dry-run', 'mini.check', 'output.consistency']) {
    const result = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId } });
    assert.strictEqual(result.ok, true, checkId + ' 失败：' + JSON.stringify(result));
  }
}

function ctxOf(run) {
  return {
    projectId: PROJECT_ID,
    runId: run.runId,
    turnId: run.turnId,
    attemptId: run.attemptId,
  };
}

function workspaceDirOf(userDataDir, projectId) {
  return path.join(userDataDir, 'projects', projectId || PROJECT_ID, 'agent-workspace');
}

function runDirOf(userDataDir, run, projectId) {
  return path.join(workspaceDirOf(userDataDir, projectId), 'runs', run.runId);
}

function attemptDirOf(userDataDir, run, projectId) {
  return path.join(runDirOf(userDataDir, run, projectId), 'turns', run.turnId, 'attempts', run.attemptId);
}

/** 工作树快照（相对路径 → digest 摘要 + 字节数），用于证明“零落盘”。 */
function treeSnapshot(dir) {
  const out = {};
  for (const entry of h.listRelativeFiles(dir)) {
    out[entry.path] = entry.bytes + '|' + h.sha256OfFile(path.join(dir, ...entry.path.split('/')));
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertFailureEnvelope(envelope, code, label) {
  assert.strictEqual(envelope && envelope.ok, false, (label || '') + ' 应当失败：' + JSON.stringify(envelope));
  assert.strictEqual(envelope.code, code, (label || '') + ' 错误码不符：' + JSON.stringify(envelope));
  assert.ok(typeof envelope.message === 'string' && envelope.message.length > 0 && envelope.message.length <= 240,
    (label || '') + ' message 必须有界：' + JSON.stringify(envelope));
  assert.strictEqual(envelope.data, null, (label || '') + ' 失败时 data 必须为 null');
  return envelope;
}

/* ------------------------------ 冻结签名 ------------------------------ */

test('E0-W1：createRunCoordinator 冻结签名、默认值与错误码表', () => {
  assert.throws(() => createRunCoordinator({}), TypeError, 'userDataDir 必需');
  assert.throws(() => createRunCoordinator({ userDataDir: '   ' }), TypeError, 'userDataDir 不能是空白');
  const userDataDir = h.tempDir('w1-signature');
  try {
    assert.throws(() => createRunCoordinator({ userDataDir, limits: { notALimit: 10 } }), TypeError, 'limits 未知键必须失败');
    const coordinator = createRunCoordinator({ userDataDir });
    for (const method of FROZEN_METHODS) {
      assert.strictEqual(typeof coordinator[method], 'function', '缺少冻结方法：' + method);
    }
    // 11 个模型可见工具（顺序与命名固定）。
    assert.deepStrictEqual(MODEL_TOOL_NAMES.slice(), [
      'get_context', 'list_files', 'read_file', 'search_files', 'write_files', 'delete_files',
      'get_diff', 'run_check', 'verify_wechat', 'read_verification', 'submit_candidate',
    ]);
    // 平台专用工具不得出现在模型工具列表里。
    for (const name of PLATFORM_ONLY_TOOL_NAMES) {
      assert.ok(!MODEL_TOOL_NAMES.includes(name), '平台专用工具泄漏到模型工具列表：' + name);
    }
    assert.deepStrictEqual(PLATFORM_ONLY_TOOL_NAMES.slice(), ['derive_source_bundle', 'adopt_attempt', 'attach_image_asset']);
    for (const code of FROZEN_CODES) {
      assert.ok(Object.values(CODES).includes(code), '缺少冻结错误码：' + code);
    }
    assert.deepStrictEqual(coordinator.toolCatalog().modelTools, MODEL_TOOL_NAMES.slice());
    assert.strictEqual(RUN_STATES.SUBMITTED, 'submitted');
  } finally {
    h.removeDir(userDataDir);
  }
});

/* ------------------------------ startRun ------------------------------ */

test('E0-W1：startRun 从 versions/<id>/source 复制工作树并返回冻结形状', (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir });
  const run = coordinator.startRun({
    projectId: PROJECT_ID,
    targetPage: 'menu',
    operation: 'edit-page',
    utterance: '给菜单页加一个横幅',
    imageAssetIds: [],
  });

  assert.strictEqual(run.ok, true, 'startRun 失败：' + JSON.stringify(run));
  assert.ok(constants.RUN_ID_PATTERN.test(run.runId), 'runId 必须是 frun-…：' + run.runId);
  assert.strictEqual(run.turnId, 'turn-1');
  assert.strictEqual(run.attemptId, 'attempt-1');
  assert.strictEqual(run.baseVersionId, 'v1');
  assert.strictEqual(run.revision, 1);
  assert.strictEqual(run.targetPage, 'menu');
  assert.strictEqual(run.operation, 'edit-page');
  assert.deepStrictEqual(run.subject, { kind: 'attempt', attemptId: 'attempt-1' });

  // baseTreeDigest = 该版本 source 树的摘要；attempt 工作树是它的副本。
  const versionSource = versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID, versionId: 'v1' });
  assert.strictEqual(versionSource.ok, true, JSON.stringify(versionSource));
  assert.strictEqual(run.baseTreeDigest, versionSource.treeDigest);
  const state = coordinator.getAttemptState(ctxOf(run));
  assert.strictEqual(state.ok, true, JSON.stringify(state));
  assert.strictEqual(state.treeDigest, run.baseTreeDigest);
  assert.strictEqual(state.revision, 1);
  assert.strictEqual(state.status, 'open');
  assert.strictEqual(state.runState, 'running');

  // 目录布局固定；元数据不含绝对路径。
  const attemptDir = attemptDirOf(userDataDir, run);
  assert.strictEqual(fs.existsSync(path.join(attemptDir, 'candidate')), true);
  assert.strictEqual(fs.existsSync(path.join(attemptDir, 'verification')), true);
  const attemptMeta = readJson(path.join(attemptDir, 'attempt.json'));
  assert.strictEqual(attemptMeta.status, 'open');
  assert.strictEqual(attemptMeta.revision, 1);
  assert.strictEqual(attemptMeta.baseVersionId, 'v1');
  assert.strictEqual(readJson(path.join(runDirOf(userDataDir, run), 'run.json')).state, 'running');
  h.assertNoPathLeak(run, [userDataDir]);
  h.assertNoPathLeak(attemptMeta, [userDataDir]);
  h.assertNoPathLeak(state, [userDataDir]);

  const listed = coordinator.getRun({ projectId: PROJECT_ID, runId: run.runId });
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  assert.strictEqual(listed.state, 'running');
  assert.deepStrictEqual(listed.turns.map((turn) => turn.turnId), ['turn-1']);
  assert.strictEqual(listed.attempts.length, 1);
  assert.strictEqual(listed.attempts[0].attemptId, 'attempt-1');
  h.assertNoPathLeak(listed, [userDataDir]);
});

test('E0-W1：startRun 无 currentVersionId → AGENT_VERSION_NOT_FOUND 且不建目录（不回落 Base）', (t) => {
  // ① 完全没有工作区的项目根：连 projects/ 都不该出现。
  const emptyRoot = h.userDataWith(t, 'w1-noversion');
  const coordinator = createRunCoordinator({ userDataDir: emptyRoot });
  const missing = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  assert.strictEqual(missing.ok, false, JSON.stringify(missing));
  assert.strictEqual(missing.code, CODES.VERSION_NOT_FOUND);
  assert.strictEqual(fs.existsSync(path.join(emptyRoot, 'projects')), false, '无版本时不得创建任何目录');

  // ② 有工作区但还没有任何版本（openWorkspace 只建 project.json）。
  const bareRoot = h.userDataWith(t, 'w1-bare');
  const opened = workspaceMod.openWorkspace({ userDataDir: bareRoot, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const bare = createRunCoordinator({ userDataDir: bareRoot });
  const noVersion = bare.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  assert.strictEqual(noVersion.code, CODES.VERSION_NOT_FOUND);
  assert.strictEqual(fs.existsSync(path.join(workspaceDirOf(bareRoot), 'runs')), false, '不得创建 run 目录');

  // ③ 指定了不存在的 baseVersionId：同样不建 run 目录，不回落 Base 冒充。
  const { userDataDir } = setup(t);
  const withVersion = createRunCoordinator({ userDataDir });
  const unknown = withVersion.startRun({
    projectId: PROJECT_ID, baseVersionId: 'v9', targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  assert.strictEqual(unknown.code, CODES.VERSION_NOT_FOUND);
  assert.strictEqual(fs.existsSync(path.join(workspaceDirOf(userDataDir), 'runs')), false, '不得创建 run 目录');
});

test('E0-W1：startRun 拒绝非法 targetPage / operation / utterance / imageAssetIds', (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir });
  const base = { projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' };

  const badPage = coordinator.startRun({ ...base, targetPage: 'Menu Page' });
  assert.strictEqual(badPage.code, CODES.TARGET_PAGE_UNSUPPORTED, JSON.stringify(badPage));

  const badOperation = coordinator.startRun({ ...base, operation: 'edit page' });
  assert.strictEqual(badOperation.code, CODES.PAYLOAD_INVALID, JSON.stringify(badOperation));

  const badUtterance = coordinator.startRun({ ...base, utterance: '  ' });
  assert.strictEqual(badUtterance.code, CODES.PAYLOAD_INVALID, JSON.stringify(badUtterance));

  const badAsset = coordinator.startRun({ ...base, imageAssetIds: ['../../etc/passwd'] });
  assert.strictEqual(badAsset.code, CODES.PAYLOAD_INVALID, JSON.stringify(badAsset));

  assert.strictEqual(fs.existsSync(path.join(workspaceDirOf(userDataDir), 'runs')), false, '非法输入不得建目录');
});

/* ------------------------------ subject ------------------------------ */

test('E0-W1：工具 subject 固定 attempt；read_file 可只读 base 版本；写入永不接受 version', async (t) => {
  const { userDataDir } = setup(t);
  const checkStub = fakeChecks();
  const coordinator = createRunCoordinator({ userDataDir, checks: checkStub.registry });
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  const ctx = ctxOf(run);

  const readAttemptFile = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'app.json' } });
  assert.strictEqual(readAttemptFile.ok, true, JSON.stringify(readAttemptFile));
  assert.deepStrictEqual(readAttemptFile.data.subject, { kind: 'attempt', attemptId: 'attempt-1' });
  assert.ok(readAttemptFile.data.content.length > 0);
  assert.strictEqual(readAttemptFile.meta.attemptId, 'attempt-1');
  h.assertNoPathLeak(readAttemptFile, [userDataDir, attemptDirOf(userDataDir, run)]);

  const readVersionFile = await coordinator.invokeTool({
    ...ctx,
    tool: 'read_file',
    args: { path: 'app.json', subjectOverride: { kind: 'version', versionId: 'v1' } },
  });
  assert.strictEqual(readVersionFile.ok, true, JSON.stringify(readVersionFile));
  assert.deepStrictEqual(readVersionFile.data.subject, { kind: 'version', versionId: 'v1' });
  assert.strictEqual(readVersionFile.data.content, readAttemptFile.data.content);
  assert.strictEqual(readVersionFile.data.sha256, readAttemptFile.data.sha256);

  // subjectOverride 只接受 version；attempt 覆盖/坏版本一律拒绝。
  const attemptOverride = await coordinator.invokeTool({
    ...ctx, tool: 'read_file', args: { path: 'app.json', subjectOverride: { kind: 'attempt', attemptId: 'attempt-1' } },
  });
  assert.strictEqual(attemptOverride.code, CODES.PAYLOAD_INVALID, JSON.stringify(attemptOverride));

  const missingVersion = await coordinator.invokeTool({
    ...ctx, tool: 'read_file', args: { path: 'app.json', subjectOverride: { kind: 'version', versionId: 'v9' } },
  });
  assert.strictEqual(missingVersion.code, CODES.VERSION_NOT_FOUND, JSON.stringify(missingVersion));

  const escapeVersionPath = await coordinator.invokeTool({
    ...ctx, tool: 'read_file', args: { path: '../project.json', subjectOverride: { kind: 'version', versionId: 'v1' } },
  });
  assert.ok([CODES.PATH_INVALID, CODES.PATH_ESCAPE].includes(escapeVersionPath.code),
    '版本只读也必须拒绝路径逃逸：' + JSON.stringify(escapeVersionPath));

  // 写入永不接受 version subject。
  const writeWithVersion = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'a.txt', content: 'x' }], subjectOverride: { kind: 'version', versionId: 'v1' } },
  });
  assert.strictEqual(writeWithVersion.code, CODES.PAYLOAD_INVALID, JSON.stringify(writeWithVersion));

  const writeUnknownKey = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'a.txt', content: 'x', versionId: 'v1' }] },
  });
  assert.strictEqual(writeUnknownKey.code, CODES.PAYLOAD_INVALID, JSON.stringify(writeUnknownKey));

  const ctxTool = await coordinator.invokeTool({ ...ctx, tool: 'get_context', args: {} });
  assert.strictEqual(ctxTool.ok, true, JSON.stringify(ctxTool));
  assert.deepStrictEqual(ctxTool.data.subject, { kind: 'attempt', attemptId: 'attempt-1' });
  assert.strictEqual(ctxTool.data.tools.length, 11);
  assert.ok(!ctxTool.data.tools.includes('derive_source_bundle'));
  h.assertNoPathLeak(ctxTool, [userDataDir]);
});

/* ------------------------------ revision/treeDigest ------------------------------ */

test('E0-W1：每次写事务后 revision 递增并重算 treeDigest', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  const ctx = ctxOf(run);
  const candidateDir = path.join(attemptDirOf(userDataDir, run), 'candidate');

  const first = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>one</view>' }] },
  });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.data.revision, 2, '写一次后 revision 必须 +1');
  assert.notStrictEqual(first.data.treeDigest, run.baseTreeDigest, '写事务后 treeDigest 必须变化');
  const manifestAfterFirst = manifestMod.buildManifest(candidateDir, { limits: constants.LIMITS });
  assert.strictEqual(first.data.treeDigest, manifestAfterFirst.manifest.treeDigest);
  assert.strictEqual(readJson(path.join(attemptDirOf(userDataDir, run), 'attempt.json')).revision, 2);

  const second = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>two</view>' }] },
  });
  assert.strictEqual(second.data.revision, 3);
  assert.notStrictEqual(second.data.treeDigest, first.data.treeDigest);

  const deleted = await coordinator.invokeTool({ ...ctx, tool: 'delete_files', args: { paths: [{ path: 'sitemap.json' }] } });
  assert.strictEqual(deleted.ok, true, JSON.stringify(deleted));
  assert.strictEqual(deleted.data.revision, 4);

  const state = coordinator.getAttemptState(ctx);
  assert.strictEqual(state.revision, 4);
  assert.strictEqual(state.treeDigest, deleted.data.treeDigest);

  const diff = await coordinator.invokeTool({ ...ctx, tool: 'get_diff', args: {} });
  assert.strictEqual(diff.ok, true, JSON.stringify(diff));
  assert.strictEqual(diff.data.baseVersionId, 'v1');
  assert.ok(diff.data.counts.modified >= 1, 'diff 必须反映本次修改：' + JSON.stringify(diff.data.counts));
  assert.ok(diff.data.counts.deleted >= 1, 'diff 必须反映删除：' + JSON.stringify(diff.data.counts));
  h.assertNoPathLeak(diff, [userDataDir, candidateDir]);
});

/* ------------------------------ 句柄攻击 ------------------------------ */

test('E0-W1：跨项目/跨 run/跨 turn/伪造句柄一律拒绝且零落盘', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const runA = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'A',
  });
  const runB = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'B',
  });
  await coordinator.invokeTool({
    ...ctxOf(runA), tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>A</view>' }] },
  });
  const attemptDir = attemptDirOf(userDataDir, runA);
  const before = treeSnapshot(attemptDir);
  const runDirBefore = Object.keys(treeSnapshot(runDirOf(userDataDir, runA))).sort();

  // ① 跨 run：把 runA 的 attempt 目录整份搬进 runB 的 turn 下（attempt.json.runId 仍是 runA）。
  const runBRunsDir = path.join(runDirOf(userDataDir, runB), 'turns', runB.turnId, 'attempts');
  fs.mkdirSync(runBRunsDir, { recursive: true });
  const movedAttempt = path.join(runBRunsDir, 'attempt-2');
  fs.cpSync(attemptDir, movedAttempt, { recursive: true });
  const movedAttemptBefore = treeSnapshot(movedAttempt);
  const crossRun = await coordinator.invokeTool({
    projectId: PROJECT_ID, runId: runB.runId, turnId: runB.turnId, attemptId: 'attempt-2',
    tool: 'get_context', args: {},
  });
  assertFailureEnvelope(crossRun, CODES.ATTEMPT_NOT_FOUND, '跨 run');
  assert.deepStrictEqual(treeSnapshot(movedAttempt), movedAttemptBefore, '跨 run 拒绝后不得落盘');
  h.removeDir(movedAttempt);

  // ② 跨 turn。
  const crossTurn = await coordinator.invokeTool({
    projectId: PROJECT_ID, runId: runA.runId, turnId: 'turn-9', attemptId: runA.attemptId,
    tool: 'write_files', args: { changes: [{ path: 'evil.txt', content: 'x' }] },
  });
  assertFailureEnvelope(crossTurn, CODES.ATTEMPT_NOT_FOUND, '跨 turn');

  // ③ 伪造 attemptId（不存在的编号 / 路径注入）。
  const forgedNumber = await coordinator.invokeTool({
    ...ctxOf(runA), attemptId: 'attempt-9999', tool: 'write_files', args: { changes: [{ path: 'evil.txt', content: 'x' }] },
  });
  assertFailureEnvelope(forgedNumber, CODES.ATTEMPT_NOT_FOUND, '伪造 attempt-9999');
  const forgedPath = await coordinator.invokeTool({
    ...ctxOf(runA), attemptId: 'attempt-../../x', tool: 'get_context', args: {},
  });
  assertFailureEnvelope(forgedPath, CODES.ATTEMPT_NOT_FOUND, '路径注入 attemptId');
  const forgedRun = await coordinator.invokeTool({
    ...ctxOf(runA), runId: 'frun-does-not-exist', tool: 'get_context', args: {},
  });
  assertFailureEnvelope(forgedRun, CODES.RUN_NOT_FOUND, '伪造 runId');

  // ④ 跨项目（目标项目完全没有工作区）。
  const crossProjectMissing = await coordinator.invokeTool({
    projectId: OTHER_PROJECT_ID, runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
    tool: 'write_files', args: { changes: [{ path: 'evil.txt', content: 'x' }] },
  });
  assert.ok([CODES.RUN_NOT_FOUND, CODES.PROJECT_MISMATCH].includes(crossProjectMissing.code),
    '跨项目必须拒绝：' + JSON.stringify(crossProjectMissing));
  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'projects', OTHER_PROJECT_ID)), false, '跨项目不得创建目录');

  // ⑤ 跨项目伪造：把 A 的 run 目录整份搬进 B 的工作区（run.json.projectId 仍是 A）。
  const otherOpened = workspaceMod.openWorkspace({ userDataDir, projectId: OTHER_PROJECT_ID });
  assert.strictEqual(otherOpened.ok, true, JSON.stringify(otherOpened));
  const otherRunsDir = path.join(workspaceDirOf(userDataDir, OTHER_PROJECT_ID), 'runs');
  fs.mkdirSync(otherRunsDir, { recursive: true });
  fs.cpSync(runDirOf(userDataDir, runA), path.join(otherRunsDir, runA.runId), { recursive: true });
  const movedSnapshot = treeSnapshot(runDirOf(userDataDir, runA, OTHER_PROJECT_ID));
  const crossProjectForged = await coordinator.invokeTool({
    projectId: OTHER_PROJECT_ID, runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
    tool: 'get_context', args: {},
  });
  assertFailureEnvelope(crossProjectForged, CODES.PROJECT_MISMATCH, '跨项目伪造');
  const movedAfter = treeSnapshot(runDirOf(userDataDir, runA, OTHER_PROJECT_ID));
  assert.deepStrictEqual(movedAfter, movedSnapshot, '跨项目拒绝后不得落盘');

  // ⑥ 原 attempt 一字未改（零落盘）。
  const after = treeSnapshot(attemptDir);
  assert.deepStrictEqual(after, before, '被拒绝的调用不得改动 attempt 目录');
  assert.deepStrictEqual(Object.keys(treeSnapshot(runDirOf(userDataDir, runA))).sort(), runDirBefore);
  assert.strictEqual(fs.existsSync(path.join(attemptDir, 'candidate', 'evil.txt')), false);
});

/* ------------------------------ 工具面 ------------------------------ */

test('E0-W1：模型工具面 11 个；平台专用/未知工具一律 AGENT_TOOL_NOT_ALLOWED', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x',
  });
  const ctx = ctxOf(run);

  for (const tool of PLATFORM_ONLY_TOOL_NAMES) {
    const result = await coordinator.invokeTool({ ...ctx, tool, args: {} });
    assertFailureEnvelope(result, CODES.TOOL_NOT_ALLOWED, '平台专用工具 ' + tool);
  }
  for (const tool of ['shell_exec', 'exec', 'read_artifact', '']) {
    const result = await coordinator.invokeTool({ ...ctx, tool, args: {} });
    assertFailureEnvelope(result, CODES.TOOL_NOT_ALLOWED, '未知工具 ' + tool);
  }

  // 平台字段（root/attempt/versionId/命令）不得由模型给。
  const forbiddenRoot = await coordinator.invokeTool({
    ...ctx, tool: 'run_check', args: { checkId: 'source.check', params: { root: 'C:/tmp/x' } },
  });
  assertFailureEnvelope(forbiddenRoot, CODES.PAYLOAD_INVALID, 'run_check root');
  const forbiddenCommand = await coordinator.invokeTool({
    ...ctx, tool: 'run_check', args: { checkId: 'unit.full', params: { command: 'rm -rf /' } },
  });
  assertFailureEnvelope(forbiddenCommand, CODES.PAYLOAD_INVALID, 'run_check command');

  // 工具 args 白名单：多给键即拒绝（不猜测、不静默忽略）。
  const unknownArg = await coordinator.invokeTool({ ...ctx, tool: 'list_files', args: { dir: '', root: '/tmp' } });
  assertFailureEnvelope(unknownArg, CODES.PAYLOAD_INVALID, 'list_files 多余键');

  const listed = await coordinator.invokeTool({ ...ctx, tool: 'list_files', args: { dir: '' } });
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.data.files.length > 0);
  assert.ok(listed.data.files.every((file) => typeof file.path === 'string' && !path.isAbsolute(file.path)));
  h.assertNoPathLeak(listed, [userDataDir]);

  const searched = await coordinator.invokeTool({ ...ctx, tool: 'search_files', args: { query: 'component' } });
  assert.strictEqual(searched.ok, true, JSON.stringify(searched));
  h.assertNoPathLeak(searched, [userDataDir]);
});

/* ------------------------------ 取消 ------------------------------ */

test('E0-W1：cancelRun 三态；取消后迟到调用不落盘、不调模型/direct runtime', async (t) => {
  const { userDataDir } = setup(t);
  const counters = { calls: 0, hold: null };
  const directCalls = { count: 0, lastContext: null };
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: fakeChecks(counters).registry,
    directRuntime: {
      invoke: async (request) => {
        directCalls.count += 1;
        directCalls.lastContext = request.context;
        return { ok: true, data: { text: 'ok' } };
      },
    },
  });

  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);
  const candidateDir = path.join(attemptDirOf(userDataDir, run), 'candidate');

  // direct 通道：取消前可用，且上下文里带 subject。
  const directOk = await coordinator.invokeDirect({ ...ctx, request: { messages: [] } });
  assert.strictEqual(directOk.ok, true, JSON.stringify(directOk));
  assert.strictEqual(directCalls.count, 1);
  assert.deepStrictEqual(directCalls.lastContext.subject, { kind: 'attempt', attemptId: 'attempt-1' });

  // 在途调用期间取消 → requested；迟到结果丢弃且不落证据。
  let release;
  counters.hold = new Promise((resolve) => { release = resolve; });
  const pending = coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const requested = coordinator.cancelRun({ projectId: PROJECT_ID, runId: run.runId });
  assert.strictEqual(requested.state, 'requested', '在途取消必须是 requested：' + JSON.stringify(requested));
  assert.strictEqual(requested.cancelled, false);
  release();
  counters.hold = null;
  const late = await pending;
  assert.strictEqual(late.ok, false, '迟到结果必须丢弃：' + JSON.stringify(late));
  assert.strictEqual(late.code, CODES.CANCELLED);
  assert.strictEqual(
    fs.existsSync(path.join(attemptDirOf(userDataDir, run), 'verification', 'checks')),
    false,
    '取消后不得落检查证据',
  );
  const settled = coordinator.getRun({ projectId: PROJECT_ID, runId: run.runId });
  assert.strictEqual(settled.state, 'cancelled', '在途结束后 run 必须落成 cancelled：' + JSON.stringify(settled.state));

  // 取消后的迟到工具调用：不落盘、不再调注册表/direct。
  const before = treeSnapshot(candidateDir);
  const callsBefore = counters.calls;
  const lateWrite = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'late.txt', content: 'x' }] },
  });
  assertFailureEnvelope(lateWrite, CODES.CANCELLED, '取消后写');
  const lateCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assertFailureEnvelope(lateCheck, CODES.CANCELLED, '取消后检查');
  assert.strictEqual(counters.calls, callsBefore, '取消后不得再调用检查注册表');
  assert.deepStrictEqual(treeSnapshot(candidateDir), before, '取消后不得落盘');
  assert.strictEqual(fs.existsSync(path.join(candidateDir, 'late.txt')), false);

  const lateDirect = await coordinator.invokeDirect({ ...ctx, request: { messages: [] } });
  assert.strictEqual(lateDirect.code, CODES.CANCELLED, JSON.stringify(lateDirect));
  assert.strictEqual(directCalls.count, 1, '取消后不得再调 direct runtime');
  assert.strictEqual(coordinator.assertRunActive({ projectId: PROJECT_ID, runId: run.runId }).code, CODES.CANCELLED);

  // 幂等：再取消返回 cancelled。
  const again = coordinator.cancelRun({ projectId: PROJECT_ID, runId: run.runId });
  assert.strictEqual(again.state, 'cancelled');
  assert.strictEqual(again.cancelled, true);
});

test('E0-W1：提交后取消 → too-late；取消不存在的 run → AGENT_RUN_NOT_FOUND', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>s</view>' }] } });
  await runGateChecks(coordinator, ctx);
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));

  const tooLate = coordinator.cancelRun({ projectId: PROJECT_ID, runId: run.runId });
  assert.strictEqual(tooLate.state, 'too-late', JSON.stringify(tooLate));
  assert.strictEqual(tooLate.cancelled, false);

  const missing = coordinator.cancelRun({ projectId: PROJECT_ID, runId: 'frun-nope' });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, CODES.RUN_NOT_FOUND);
});

/* ------------------------------ 提交/采用 ------------------------------ */

test('E0-W1：submit 静态门禁、提交后只读、重复提交、adopt 委托 B2', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);
  const candidateDir = path.join(attemptDirOf(userDataDir, run), 'candidate');

  // 没有检查证据 → 静态门禁拒绝，状态仍 open。
  const noEvidence = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(noEvidence.ok, false);
  assert.strictEqual(noEvidence.code, CODES.STATIC_GATE_FAILED, JSON.stringify(noEvidence));
  assert.strictEqual(coordinator.getAttemptState(ctx).status, 'open');

  // 写入 + 两项必需检查。
  const written = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>c</view>' }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));

  // 证据绑定了旧 treeDigest：再写一次后旧证据必须失效。
  await runGateChecks(coordinator, ctx);
  await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>c2</view>' }] },
  });
  const stale = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  // F3（合同 rev2）：陈旧证据的唯一诚实结论是 AGENT_EVIDENCE_STALE + rerun-checks，且平台不自动补派生。
  assert.strictEqual(stale.code, CODES.EVIDENCE_STALE, '旧 treeDigest 的证据不得通过门禁：' + JSON.stringify(stale));
  assert.strictEqual(stale.nextAction, 'rerun-checks');
  assert.ok(stale.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'), JSON.stringify(stale.issues));

  // 重跑四项静态检查（绑定当前 treeDigest）→ 通过；wechat 未跑 → partial。
  await runGateChecks(coordinator, ctx);
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu', summary: '菜单横幅' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  assert.strictEqual(submitted.status, 'submitted');
  assert.strictEqual(submitted.partial, true, '未跑 wechat.verify 必须记 partial');
  assert.strictEqual(submitted.candidateId, 'attempt-1');
  assert.strictEqual(readJson(path.join(attemptDirOf(userDataDir, run), 'attempt.json')).status, 'submitted');
  assert.strictEqual(coordinator.getRun({ projectId: PROJECT_ID, runId: run.runId }).state, 'submitted');

  // 重复提交 + 提交后只读（repair 必须新开 attempt）。
  const repeat = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(repeat.code, CODES.RUN_ALREADY_SUBMITTED, JSON.stringify(repeat));
  const before = treeSnapshot(candidateDir);
  const blocked = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>nope</view>' }] },
  });
  assertFailureEnvelope(blocked, CODES.ATTEMPT_IMMUTABLE, '提交后写');
  const blockedDelete = await coordinator.invokeTool({ ...ctx, tool: 'delete_files', args: { paths: [{ path: 'sitemap.json' }] } });
  assertFailureEnvelope(blockedDelete, CODES.ATTEMPT_IMMUTABLE, '提交后删除');
  assert.deepStrictEqual(treeSnapshot(candidateDir), before, '提交后不得改动候选树');
  // 读操作仍然允许。
  const stillReadable = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'app.json' } });
  assert.strictEqual(stillReadable.ok, true, JSON.stringify(stillReadable));

  // adopt：partial 必须显式确认；确认后委托 B2 生成新版本。
  const partialMissing = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(partialMissing.code, CODES.PARTIAL_CONFIRM_REQUIRED, JSON.stringify(partialMissing));
  const adopted = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.adoptedVersionId, 'v2');
  assert.strictEqual(adopted.currentVersionId, 'v2');
  assert.strictEqual(coordinator.getAttemptState(ctx).status, 'adopted');
  const repeatAdopt = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
  // rev15 §14.12-Q1：状态 ≠ submitted（此处已 adopted）→ AGENT_ADOPTION_FAILED + issue NOT_SUBMITTED。
  assert.strictEqual(repeatAdopt.code, CODES.ADOPTION_FAILED, JSON.stringify(repeatAdopt));
  assert.strictEqual(repeatAdopt.issues[0].code, 'NOT_SUBMITTED', JSON.stringify(repeatAdopt.issues));

  // 提交证据/采用后 run 状态。
  assert.strictEqual(coordinator.getRun({ projectId: PROJECT_ID, runId: run.runId }).state, 'adopted');
});

test('E0-W1：adopt 拒绝未提交候选（AGENT_ADOPTION_FAILED/NOT_SUBMITTED）与陈旧证据', async (t) => {
  const { userDataDir } = setup(t);
  const coordinator = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);

  const notSubmitted = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(notSubmitted.code, CODES.ADOPTION_FAILED, JSON.stringify(notSubmitted));
  assert.strictEqual(notSubmitted.issues[0].code, 'NOT_SUBMITTED', JSON.stringify(notSubmitted.issues));

  // 手工制造“已提交但证据 treeDigest 与候选不一致”的陈旧状态（模拟盘上被改）。
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>z</view>' }] } });
  await runGateChecks(coordinator, ctx);
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));

  const submissionFile = path.join(attemptDirOf(userDataDir, run), 'verification', 'submission.json');
  const submission = readJson(submissionFile);
  submission.treeDigest = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(submissionFile, JSON.stringify(submission), 'utf8');

  const stale = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
  assert.strictEqual(stale.code, CODES.EVIDENCE_STALE, JSON.stringify(stale));
});

/* ------------------------------ 重开一致性 ------------------------------ */

test('E0-W1：重开一致性（新实例读回同一 revision/treeDigest 并可继续编辑）', async (t) => {
  const { userDataDir } = setup(t);
  const first = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const run = first.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);
  const written = await first.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>reopen</view>' }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));

  // 同一 userDataDir 上的第二个实例（模拟主进程重启）。
  const second = createRunCoordinator({ userDataDir, checks: fakeChecks().registry });
  const state = second.getAttemptState(ctx);
  assert.strictEqual(state.ok, true, JSON.stringify(state));
  assert.strictEqual(state.revision, written.data.revision);
  assert.strictEqual(state.treeDigest, written.data.treeDigest);
  assert.strictEqual(second.getRun({ projectId: PROJECT_ID, runId: run.runId }).state, 'running');

  const readBack = await second.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  assert.strictEqual(readBack.ok, true, JSON.stringify(readBack));
  assert.strictEqual(readBack.data.content, '<view>reopen</view>');

  const continued = await second.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>reopen2</view>' }] },
  });
  assert.strictEqual(continued.data.revision, written.data.revision + 1);

  // 重开也不会泄漏路径。
  h.assertNoPathLeak(state, [userDataDir]);
  h.assertNoPathLeak(continued, [userDataDir]);
});

/* ------------------------------ 进度 ------------------------------ */

test('E0-W1：进度事件只用白名单 stage 且不含路径/源码/base64', async (t) => {
  const { userDataDir } = setup(t);
  const events = [];
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: fakeChecks().registry,
    emitProgress: (event) => events.push(event),
  });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-page', utterance: 'x' });
  const ctx = ctxOf(run);
  await coordinator.invokeTool({ ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>p</view>' }] } });
  await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });

  assert.ok(events.length >= 3, '至少要有 workspace/write/validate 进度：' + JSON.stringify(events));
  const allowedKeys = ['projectId', 'runId', 'turnId', 'attemptId', 'phase', 'stage', 'status', 'at', 'message'];
  for (const event of events) {
    for (const key of Object.keys(event)) {
      assert.ok(allowedKeys.includes(key), '进度事件出现未冻结字段：' + key);
    }
    assert.ok(coordinatorMod.PROGRESS_STAGES.has(event.stage), '未知 stage：' + event.stage);
    assert.ok(['running', 'succeeded', 'failed', 'cancelled'].includes(event.status), '未知 status：' + event.status);
    assert.ok(typeof event.message === 'string' && event.message.length <= 120);
  }
  assert.ok(events.some((event) => event.stage === 'write'));
  assert.ok(events.some((event) => event.stage === 'validate'));
  h.assertNoPathLeak(events, [userDataDir]);
});

/* ------------------------------ main.cjs 接线 ------------------------------ */

test('E0-W1：main.cjs 以单例接线 Coordinator（不暴露目录、不新增 fs/exec 通道）', () => {
  const mainSource = fs.readFileSync(path.join(h.REPO, 'desktop', 'main.cjs'), 'utf8');
  const coordinatorSource = fs.readFileSync(path.join(h.AGENT_WORKSPACE_DIR, 'run-coordinator.cjs'), 'utf8');

  // 单例：只 require 一次、只实例化一次，并作为模块级常量持有。
  assert.strictEqual(
    (mainSource.match(/require\('\.\/agent-workspace\/run-coordinator\.cjs'\)/g) || []).length,
    1,
    'main.cjs 必须只引入一次 run-coordinator',
  );
  assert.strictEqual((mainSource.match(/createRunCoordinator\(/g) || []).length, 1, 'main.cjs 只能创建一个 Coordinator 单例');
  assert.match(mainSource, /const workspaceRunCoordinator = createRunCoordinator\(\{/, '必须以模块级单例接线');
  assert.match(mainSource, /createRunCoordinator\(\{\s*\n\s*userDataDir,/, '必须传入主进程 userDataDir');
  assert.match(mainSource, /checks: createCheckRegistry\(\{ userDataDir \}\)/, '必须注入 B4 真实 checks 注册表');
  // E0-W2（交付锁）：direct 通道改为惰性装配（E0-R1 的传输由 credential.chat 承接），
  // 未接线/未配置时 invokeDirect 仍显式返回 AGENT_RUNTIME_TOOL_MISSING（见 direct-runtime 测试）。
  assert.match(mainSource, /directRuntime: createDirectWorkspaceRuntime\(\{/, 'direct 通道必须惰性装配');
  assert.match(mainSource, /coordinator: \(\) => workspaceRunCoordinator/, 'coordinator 必须惰性解析，避免单例顺序问题');
  assert.match(mainSource, /credentials: modelCredentials/, '凭据只取自主进程唯一实例');
  assert.ok(!/directRuntime:\s*null/.test(mainSource), '不得再写死 directRuntime: null（接线锁已交付）');
  assert.match(mainSource, /emitProgress: broadcastAgentProgress/, '进度必须走单一广播出口');

  // 不新增通用 fs/exec 通道，不把目录交给 renderer。
  assert.ok(!/ipcMain\.handle\('agent:[^']*(dir|path|shell|exec)/i.test(mainSource), '不得新增目录/命令类 agent 通道');
  assert.ok(!/workspaceRunCoordinator\.[a-zA-Z]+\(\{[^}]*userDataDir/s.test(mainSource), '不得把私有根传给 renderer 请求');
  assert.ok(/broadcastAgentProgress/.test(mainSource));

  // Coordinator 本身纯 CJS：不依赖 Electron、不开子进程、不暴露目录。
  assert.ok(!/require\('electron'\)/.test(coordinatorSource), 'run-coordinator 不得依赖 Electron');
  assert.ok(!/require\('(node:)?child_process'\)/.test(coordinatorSource), 'run-coordinator 不得开子进程');
  assert.ok(!/execFileSync|\bexecSync\b|\bspawnSync\b|\bspawn\(/.test(coordinatorSource), 'run-coordinator 不得有命令执行入口');
  assert.ok(!/module\.exports\s*=\s*\{[\s\S]*userDataDir\s*:/.test(coordinatorSource), '不得导出私有根');
});
