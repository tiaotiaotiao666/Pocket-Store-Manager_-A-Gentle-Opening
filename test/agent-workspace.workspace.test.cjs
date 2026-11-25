'use strict';

/**
 * B1：私有工作区根、目录推导、attempt 创建/重开与归属断言。
 *
 * 契约来源：docs/handoff/Workspace-Agent-B阶段接口冻结.md §1.3/§1.4/§1.5/§1.7。
 * 只写 os.tmpdir() 下的临时 userData 根，正式仓库零写入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'proj-alpha';
const RUN_ID = 'frun-20261124-b1';
const TURN_ID = 'turn-1';

function load() {
  return h.loadModule('workspace');
}

function open(userDataDir, extra) {
  const result = load().openWorkspace(Object.assign({ userDataDir, projectId: PROJECT_ID }, extra));
  assert.strictEqual(result.ok, true, 'openWorkspace 应当成功：' + JSON.stringify(result));
  return result.workspace;
}

function create(userDataDir, extra) {
  const workspace = open(userDataDir);
  const result = load().createAttempt(workspace, Object.assign({
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'base' },
  }, extra));
  assert.strictEqual(result.ok, true, 'createAttempt 应当成功：' + JSON.stringify(result));
  return { workspace, attempt: result.attempt };
}

test('冻结上限：LIMITS 与 §1.4 完全一致，错误码使用 AGENT_ 命名空间', () => {
  const workspaceMod = load();
  assert.deepStrictEqual(workspaceMod.LIMITS, {
    maxFiles: 4000,
    maxFileBytes: 1024 * 1024,
    maxTreeBytes: 64 * 1024 * 1024,
    maxDepth: 24,
    readDefaultBytes: 64 * 1024,
    readMaxBytes: 256 * 1024,
    readMaxLines: 4000,
    maxSearchResults: 50,
    batchMaxFiles: 32,
    batchMaxBytes: 2 * 1024 * 1024,
    diffMaxFiles: 64,
    diffMaxBytes: 512 * 1024,
    maxPathLength: 240,
  });
  for (const code of Object.values(workspaceMod.CODES)) {
    assert.match(code, /^AGENT_[A-Z_]+$/, '错误码必须在 AGENT_ 命名空间：' + code);
  }
});

test('openWorkspace：固定布局 projects/<projectId>/agent-workspace 与 project.json', (t) => {
  const userDataDir = h.userDataWith(t);
  const workspace = open(userDataDir);

  const expectedWorkspaceDir = path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace');
  assert.strictEqual(workspace.workspaceDir, expectedWorkspaceDir);
  assert.strictEqual(workspace.projectFile, path.join(expectedWorkspaceDir, 'project.json'));
  assert.strictEqual(workspace.versionsDir, path.join(expectedWorkspaceDir, 'versions'));
  assert.strictEqual(workspace.runsDir, path.join(expectedWorkspaceDir, 'runs'));
  assert.ok(fs.existsSync(workspace.projectFile), 'project.json 应当被创建');

  const project = JSON.parse(fs.readFileSync(workspace.projectFile, 'utf8'));
  assert.strictEqual(project.schemaVersion, 'agent-workspace.v1');
  assert.strictEqual(project.projectId, PROJECT_ID);
  assert.match(project.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  // B1 不写版本指针，留给 B2。
  assert.strictEqual('currentVersionId' in project, false);
  assert.strictEqual('versions' in project, false);

  const raw = fs.readFileSync(workspace.projectFile, 'utf8');
  assert.ok(!raw.includes(userDataDir), 'project.json 不得含本机绝对路径');
  assert.ok(!/[A-Za-z]:[\\/]/.test(raw), 'project.json 不得含盘符路径');

  // 重复打开幂等，不重置 project.json。
  const reopened = open(userDataDir);
  assert.deepStrictEqual(reopened.project, workspace.project);
});

test('createAttempt：从 Base 复制完整工作树，写入全部落在私有根内', (t) => {
  const userDataDir = h.userDataWith(t);
  const { workspace, attempt } = create(userDataDir);

  const expectedAttemptDir = path.join(workspace.runsDir, RUN_ID, 'turns', TURN_ID, 'attempts', 'attempt-1');
  assert.strictEqual(attempt.attemptDir, expectedAttemptDir);
  assert.strictEqual(attempt.attemptId, 'attempt-1');
  assert.strictEqual(attempt.attempt, 1);
  assert.strictEqual(attempt.candidateDir, path.join(expectedAttemptDir, 'candidate'));
  assert.strictEqual(attempt.verificationDir, path.join(expectedAttemptDir, 'verification'));

  for (const created of [attempt.candidateDir, attempt.verificationDir, attempt.attemptFile,
    path.join(attempt.runDir, 'run.json'), path.join(attempt.turnDir, 'turn.json')]) {
    assert.ok(fs.existsSync(created), '应当创建：' + created);
  }

  // 工作树内容与真实 Base 完全一致（逐文件路径与摘要）。
  const baseFiles = h.listRelativeFiles(h.BASE_SOURCE_DIR);
  const copiedFiles = h.listRelativeFiles(attempt.candidateDir);
  assert.deepStrictEqual(copiedFiles, baseFiles, 'Base 工作树必须逐文件一致');
  for (const file of baseFiles) {
    assert.strictEqual(
      h.sha256OfFile(path.join(attempt.candidateDir, ...file.path.split('/'))),
      h.sha256OfFile(path.join(h.BASE_SOURCE_DIR, ...file.path.split('/'))),
      '文件摘要不一致：' + file.path,
    );
  }

  const meta = JSON.parse(fs.readFileSync(attempt.attemptFile, 'utf8'));
  assert.strictEqual(meta.schemaVersion, 'agent-attempt.v1');
  assert.strictEqual(meta.projectId, PROJECT_ID);
  assert.strictEqual(meta.runId, RUN_ID);
  assert.strictEqual(meta.turnId, TURN_ID);
  assert.strictEqual(meta.attemptId, 'attempt-1');
  assert.strictEqual(meta.source.kind, 'base');
  assert.match(meta.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(meta.fileCount, baseFiles.length);
  assert.strictEqual(meta.totalBytes, baseFiles.reduce((sum, item) => sum + item.bytes, 0));

  for (const file of [attempt.attemptFile, path.join(attempt.runDir, 'run.json'), path.join(attempt.turnDir, 'turn.json')]) {
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(userDataDir), '元数据不得含绝对路径：' + file);
    assert.ok(!/[A-Za-z]:[\\/]/.test(raw), '元数据不得含盘符路径：' + file);
    assert.ok(!/data:[^"']*;base64,/i.test(raw), '元数据不得含 base64：' + file);
  }

  // 所有写入都在 userData 私有根内。
  for (const entry of h.listRelativeFiles(userDataDir)) {
    const abs = path.join(userDataDir, ...entry.path.split('/'));
    assert.ok(abs.toLowerCase().startsWith(userDataDir.toLowerCase()), '越出私有根：' + abs);
  }
});

test('createAttempt：可从已采用版本目录（versions/<versionId>/source）创建工作树且不写来源', (t) => {
  const userDataDir = h.userDataWith(t);
  const workspace = open(userDataDir);

  // B2 的版本目录由 B2 负责创建；这里作为夹具直接铺一份。
  const versionSourceDir = path.join(workspace.versionsDir, 'v1', 'source');
  fs.mkdirSync(path.join(versionSourceDir, 'pages', 'menu'), { recursive: true });
  fs.writeFileSync(path.join(versionSourceDir, 'app.json'), JSON.stringify({ pages: ['pages/menu/index'] }));
  fs.writeFileSync(path.join(versionSourceDir, 'pages', 'menu', 'index.wxml'), '<view class="menu">v1</view>');
  const sourceFingerprint = h.listRelativeFiles(versionSourceDir).map((item) => ({ ...item, sha256: h.sha256OfFile(path.join(versionSourceDir, ...item.path.split('/'))) }));

  const created = load().createAttempt(workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'version', versionId: 'v1', reason: 'import-adopted' },
  });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const attempt = created.attempt;

  assert.deepStrictEqual(h.listRelativeFiles(attempt.candidateDir), sourceFingerprint.map(({ path: p, bytes }) => ({ path: p, bytes })));
  assert.strictEqual(
    fs.readFileSync(path.join(attempt.candidateDir, 'pages', 'menu', 'index.wxml'), 'utf8'),
    '<view class="menu">v1</view>',
  );
  const meta = JSON.parse(fs.readFileSync(attempt.attemptFile, 'utf8'));
  assert.strictEqual(meta.source.kind, 'version');
  assert.strictEqual(meta.source.versionId, 'v1');

  // 来源目录未被写入。
  assert.deepStrictEqual(
    h.listRelativeFiles(versionSourceDir).map((item) => ({ ...item, sha256: h.sha256OfFile(path.join(versionSourceDir, ...item.path.split('/'))) })),
    sourceFingerprint,
  );
});

test('createAttempt：attempt 编号独占递增，重复编号失败；listAttempts/openAttempt 一致', (t) => {
  const userDataDir = h.userDataWith(t);
  const workspace = open(userDataDir);

  const first = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.attempt.attempt, 1);

  const second = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  assert.strictEqual(second.attempt.attempt, 2);

  const explicit = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 3, source: { kind: 'base' } });
  assert.strictEqual(explicit.ok, true);
  assert.strictEqual(explicit.attempt.attempt, 3);

  const duplicate = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1, source: { kind: 'base' } });
  h.assertFailure(duplicate, load().CODES.WORKSPACE_INVALID, '重复 attempt 编号');

  const listed = load().listAttempts(workspace, { runId: RUN_ID, turnId: TURN_ID });
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  assert.deepStrictEqual(listed.attempts, [1, 2, 3]);

  const opened = load().openAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 2 });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  assert.strictEqual(opened.attempt.candidateDir, second.attempt.candidateDir);
  assert.deepStrictEqual(opened.attempt.project, second.attempt.project);

  const missing = load().openAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 9 });
  h.assertFailure(missing, load().CODES.WORKSPACE_NOT_FOUND, '打开不存在的 attempt');
  assert.deepStrictEqual(load().listAttempts(workspace, { runId: RUN_ID, turnId: TURN_ID }).attempts, [1, 2, 3]);
});

test('projectId / runId / turnId / attempt 非法标识一律拒绝且码稳定', (t) => {
  const workspaceMod = load();
  const userDataDir = h.userDataWith(t);
  const codes = workspaceMod.CODES;

  for (const projectId of ['../evil', 'a/b', 'a\\b', 'C:', '..', '', 'proj name', 'proj\n1', 'x'.repeat(65), '.hidden']) {
    const result = workspaceMod.workspacePaths({ userDataDir, projectId });
    h.assertFailure(result, codes.PROJECT_ID_INVALID, 'projectId=' + JSON.stringify(projectId));
  }

  for (const runId of ['run-1', 'frun-', 'frun-../x', 'frun-a/b', 'frun-a\\b', 'frun-a\n', 'frun-' + 'x'.repeat(62)]) {
    const result = workspaceMod.attemptPaths({ userDataDir, projectId: PROJECT_ID, runId, turnId: TURN_ID, attempt: 1 });
    h.assertFailure(result, codes.ID_INVALID, 'runId=' + JSON.stringify(runId));
  }

  for (const turnId of ['../turn', 'turn/1', 'turn\\1', 'C:', '', '.', '..', 'turn name']) {
    const result = workspaceMod.attemptPaths({ userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId, attempt: 1 });
    h.assertFailure(result, codes.ID_INVALID, 'turnId=' + JSON.stringify(turnId));
  }

  for (const attempt of [0, -1, 1.5, '1', 'attempt-01', 'attempt-10000', 10000, null, undefined]) {
    const result = workspaceMod.attemptPaths({ userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt });
    h.assertFailure(result, codes.ID_INVALID, 'attempt=' + JSON.stringify(attempt));
  }

  h.assertNoPathLeak(
    workspaceMod.workspacePaths({ userDataDir, projectId: '../evil' }),
    [userDataDir, h.REPO],
  );
});

test('私有根本身：拒绝相对路径/盘符根/仓库内目录，失败体不含绝对路径', (t) => {
  const workspaceMod = load();
  const codes = workspaceMod.CODES;

  h.assertFailure(workspaceMod.openWorkspace({ userDataDir: 'relative/dir', projectId: PROJECT_ID }), codes.ROOT_INVALID, '相对根');
  h.assertFailure(workspaceMod.openWorkspace({ userDataDir: '', projectId: PROJECT_ID }), codes.ROOT_INVALID, '空根');
  h.assertFailure(
    workspaceMod.openWorkspace({ userDataDir: path.parse(h.REPO).root, projectId: PROJECT_ID }),
    codes.ROOT_INVALID,
    '盘符根',
  );
  for (const sub of ['', 'templates', 'templates/base', 'miniprogram', 'src', 'server', 'desktop']) {
    const target = sub ? path.join(h.REPO, sub) : h.REPO;
    const result = workspaceMod.openWorkspace({ userDataDir: target, projectId: PROJECT_ID });
    h.assertFailure(result, codes.PATH_PROTECTED, '仓库内根：' + (sub || '<repo>'));
    h.assertNoPathLeak(result, [h.REPO]);
  }
});

test('projects/<projectId> 或 agent-workspace 段被换成 junction：拒绝且不写入链接目标', (t) => {
  const workspaceMod = load();
  const userDataDir = h.userDataWith(t);
  const escapeDir = h.userDataWith(t);

  fs.mkdirSync(path.join(userDataDir, 'projects'), { recursive: true });
  h.createJunction(path.join(userDataDir, 'projects', PROJECT_ID), escapeDir);
  const result = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  h.assertFailure(result, workspaceMod.CODES.PATH_LINK, 'projects 段 junction');
  assert.deepStrictEqual(h.entriesOf(escapeDir), [], '链接目标不得被写入');

  // 已打开的工作区里 agent-workspace 被换成 junction：再次访问必须拒绝。
  const okUserData = h.userDataWith(t);
  const opened = open(okUserData);
  const moved = opened.workspaceDir + '-moved';
  fs.renameSync(opened.workspaceDir, moved);
  h.createJunction(opened.workspaceDir, escapeDir);
  const reopened = workspaceMod.openWorkspace({ userDataDir: okUserData, projectId: PROJECT_ID });
  h.assertFailure(reopened, workspaceMod.CODES.PATH_LINK, 'agent-workspace 段 junction');
  assert.deepStrictEqual(h.entriesOf(escapeDir), [], '链接目标不得被写入');
});

test('assertOwnership：只认本次 attempt 工作树，库外/链接目标一律拒绝', (t) => {
  const userDataDir = h.userDataWith(t);
  const { attempt } = create(userDataDir);
  const workspaceMod = load();

  const inside = workspaceMod.assertOwnership(attempt, path.join(attempt.candidateDir, 'app.json'));
  assert.strictEqual(inside.ok, true, JSON.stringify(inside));

  h.assertFailure(workspaceMod.assertOwnership(attempt, path.join(userDataDir, 'outside.txt')), workspaceMod.CODES.PATH_ESCAPE, '库外文件');

  const escapeDir = h.userDataWith(t);
  h.createJunction(path.join(attempt.candidateDir, 'escape'), escapeDir);
  h.assertFailure(workspaceMod.assertOwnership(attempt, path.join(attempt.candidateDir, 'escape', 'x.txt')), workspaceMod.CODES.PATH_LINK, '链接目标');
});

test('removeAttempt：安全删除指定 attempt，其他 attempt 保留', (t) => {
  const userDataDir = h.userDataWith(t);
  const workspace = open(userDataDir);
  const first = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  const second = load().createAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });

  const removed = load().removeAttempt(workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(removed.ok, true, JSON.stringify(removed));
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(fs.existsSync(first.attempt.attemptDir), false);
  assert.strictEqual(fs.existsSync(second.attempt.candidateDir), true);
  assert.deepStrictEqual(load().listAttempts(workspace, { runId: RUN_ID, turnId: TURN_ID }).attempts, [2]);
});
