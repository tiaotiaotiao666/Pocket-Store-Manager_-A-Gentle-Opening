'use strict';

/**
 * P2-2：应用私有候选工作区与路径安全。
 *
 * 覆盖：固定布局、id/字符集校验、仓库根拒绝、symlink/junction 拒绝、路径穿越、
 * attempt 独占分配与保留、失败清理边界（只能删本工作区自己的 attempt/staging）。
 * 所有临时目录都在 os.tmpdir() 下用唯一名字，测试结束即删除。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const workspace = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'workspace.cjs'));

const PROJECT_ID = 'proj-alpha';
const RUN_ID = 'frun-20261116-abc';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ws-' + prefix + '-'));
}

function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    /* 测试清理失败不掩盖断言结果 */
  }
}

function createJunction(linkPath, targetPath) {
  fs.symlinkSync(targetPath, linkPath, 'junction');
}

function withBase(t) {
  const base = tempDir('base');
  t.after(() => removeDir(base));
  return base;
}

test('固定布局：projects/<projectId>/frontend-runs/<runId>/ 与 attempts 目录', (t) => {
  const base = withBase(t);
  const result = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const expectedRunDir = path.join(base, 'projects', PROJECT_ID, 'frontend-runs', RUN_ID);
  assert.strictEqual(result.runDir, expectedRunDir);
  assert.strictEqual(result.attemptsDir, path.join(expectedRunDir, 'attempts'));
  assert.ok(fs.existsSync(result.attemptsDir));
  assert.ok(fs.existsSync(result.runFile));

  const run = JSON.parse(fs.readFileSync(result.runFile, 'utf8'));
  assert.deepStrictEqual(run, {
    schemaVersion: 'frontend-run.v1',
    projectId: PROJECT_ID,
    runId: RUN_ID,
    createdAt: run.createdAt,
    attempts: [],
  });
  assert.match(run.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  // 再次打开是幂等的，不会重置 attempts。
  run.attempts.push({ attempt: 1, createdAt: run.createdAt, candidateId: 'fr-aaaaaaaaaaaa' });
  fs.writeFileSync(result.runFile, JSON.stringify(run, null, 2));
  const reopened = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(reopened.ok, true);
  assert.deepStrictEqual(reopened.run.attempts.map((item) => item.attempt), [1]);
});

test('拒绝非法 projectId / runId（分隔符、穿越、盘符、控制字符）', (t) => {
  const base = withBase(t);
  for (const projectId of ['../evil', 'a/b', 'a\\b', 'C:', '..', '', 'proj name', 'proj\n1', 'x'.repeat(65)]) {
    const result = workspace.workspacePaths({ userDataDir: base, projectId, runId: RUN_ID });
    assert.strictEqual(result.ok, false, 'projectId 应被拒绝：' + JSON.stringify(projectId));
    assert.ok(
      ['WORKSPACE_PROJECT_ID_INVALID', 'WORKSPACE_PATH_REJECTED', 'WORKSPACE_ROOT_INVALID'].includes(result.code),
      result.code,
    );
  }
  for (const runId of ['abc', 'frun-../x', 'frun-a/b', 'frun-a\\b', 'frun-', '']) {
    const result = workspace.workspacePaths({ userDataDir: base, projectId: PROJECT_ID, runId });
    assert.strictEqual(result.ok, false, 'runId 应被拒绝：' + JSON.stringify(runId));
    assert.ok(
      ['WORKSPACE_RUN_ID_INVALID', 'WORKSPACE_PATH_REJECTED', 'WORKSPACE_ROOT_INVALID'].includes(result.code),
      result.code,
    );
  }
});

test('拒绝非绝对/仓库内/盘符根的私有数据目录', () => {
  const relative = workspace.resolvePrivateRoot('relative/path');
  assert.strictEqual(relative.code, 'WORKSPACE_ROOT_INVALID');

  const empty = workspace.resolvePrivateRoot('');
  assert.strictEqual(empty.code, 'WORKSPACE_ROOT_INVALID');

  const repoRoot = workspace.resolvePrivateRoot(REPO);
  assert.strictEqual(repoRoot.ok, false);
  assert.strictEqual(repoRoot.code, 'WORKSPACE_PATH_REJECTED');

  for (const sub of ['templates', 'templates/registry', 'templates/frontend-packs', 'miniprogram', 'src', 'server']) {
    const rejected = workspace.resolvePrivateRoot(path.join(REPO, sub));
    assert.strictEqual(rejected.ok, false, '仓库内目录必须拒绝：' + sub);
    assert.strictEqual(rejected.code, 'WORKSPACE_PATH_REJECTED');
  }

  const driveRoot = workspace.resolvePrivateRoot(path.parse(REPO).root);
  assert.strictEqual(driveRoot.code, 'WORKSPACE_ROOT_INVALID');
});

test('拒绝 projects/<projectId> 处的 junction（真实路径逃逸）', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  createJunction(path.join(base, 'projects', PROJECT_ID), escape);

  const result = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  // 逃逸目标不得被写入任何东西。
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('拒绝 frontend-runs/<runId> 处的 symlink/junction', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  const projectDir = path.join(base, 'projects', PROJECT_ID);
  fs.mkdirSync(path.join(projectDir, 'frontend-runs'), { recursive: true });
  createJunction(path.join(projectDir, 'frontend-runs', RUN_ID), escape);

  const result = workspace.workspacePaths({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('已打开的工作区里 attempts 被换成 junction 后再次访问必须拒绝', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(created.ok, true);

  fs.rmSync(created.attemptsDir, { recursive: true, force: true });
  createJunction(created.attemptsDir, escape);

  const again = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'WORKSPACE_PATH_REJECTED');

  const attempt = workspace.beginAttempt(created);
  // beginAttempt 直接使用已打开的句柄：staging 会落在 junction 目标之外仍必须被拒绝，
  // 或至少不能写入 escape 目录。
  if (attempt.ok) {
    workspace.removeAttempt(attempt.attemptDir, attempt.attemptsDir);
  }
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('路径穿越与绝对路径一律拒绝', () => {
  const cases = [
    '../x',
    'a/../../x',
    '/abs/path',
    'C:/windows',
    'a\\b',
    'a//b',
    './a',
    'a/./b',
    '',
    ' page.wxml',
    'page.wxml ',
    'a\u0000b',
  ];
  for (const relative of cases) {
    const safe = workspace.assertSafeRelativePath(relative);
    assert.strictEqual(safe.ok, false, '应拒绝：' + JSON.stringify(relative));
    assert.strictEqual(safe.code, 'WORKSPACE_PATH_REJECTED');
  }

  const base = tempDir('inside');
  try {
    assert.strictEqual(workspace.resolveInside(base, 'pages/home/index.wxml').ok, true);
    assert.strictEqual(workspace.resolveInside(base, '../escape.json').ok, false);
  } finally {
    removeDir(base);
  }
});

test('beginAttempt 独占分配：不覆盖上一 attempt，编号单调递增', (t) => {
  const base = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(created.ok, true);

  const first = workspace.beginAttempt(created);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.attempt, 1);
  fs.writeFileSync(path.join(first.attemptDir, 'marker.txt'), 'first', 'utf8');

  const second = workspace.beginAttempt(created);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.attempt, 2);
  assert.notStrictEqual(second.attemptDir, first.attemptDir);
  assert.strictEqual(fs.readFileSync(path.join(first.attemptDir, 'marker.txt'), 'utf8'), 'first');
  assert.deepStrictEqual(workspace.listAttempts(created), [1, 2]);

  // staging 目录就在各自 attempt 内。
  assert.strictEqual(path.dirname(first.stagingDir), first.attemptDir);
  assert.ok(fs.existsSync(first.stagingDir));

  // 清理只删自己的 attempt。
  assert.strictEqual(workspace.removeAttempt(first.attemptDir, created.attemptsDir), true);
  assert.deepStrictEqual(workspace.listAttempts(created), [2]);
});

test('listAttempts 忽略非 attempt-N 目录与文件', (t) => {
  const base = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  fs.mkdirSync(path.join(created.attemptsDir, 'attempt-0'));
  fs.mkdirSync(path.join(created.attemptsDir, 'attempt-x'));
  fs.mkdirSync(path.join(created.attemptsDir, 'junk'));
  fs.writeFileSync(path.join(created.attemptsDir, 'attempt-7'), 'not a dir');
  fs.mkdirSync(path.join(created.attemptsDir, 'attempt-3'));
  assert.deepStrictEqual(workspace.listAttempts(created), [3]);
  assert.strictEqual(workspace.beginAttempt(created).attempt, 4);
});

test('removeAttempt / removeStaging 拒绝越界目标', (t) => {
  const base = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  const attempt = workspace.beginAttempt(created);

  assert.strictEqual(workspace.removeAttempt(base, created.attemptsDir), false, '不得删除工作区根');
  assert.strictEqual(workspace.removeAttempt(created.attemptsDir, created.attemptsDir), false);
  assert.strictEqual(workspace.removeAttempt(attempt.attemptDir, base), false, '父目录不匹配时必须拒绝');
  assert.ok(fs.existsSync(attempt.attemptDir), '误调用不得删除真实 attempt');

  assert.strictEqual(workspace.removeStaging(attempt.stagingDir, created.attemptsDir), false);
  assert.strictEqual(workspace.removeStaging(attempt.attemptDir, attempt.attemptDir), false);
  assert.ok(fs.existsSync(attempt.stagingDir));

  fs.mkdirSync(path.join(attempt.attemptDir, 'not-staging'));
  assert.strictEqual(workspace.removeStaging(path.join(attempt.attemptDir, 'not-staging'), attempt.attemptDir), false);
  assert.ok(fs.existsSync(path.join(attempt.attemptDir, 'not-staging')));

  assert.strictEqual(workspace.removeStaging(attempt.stagingDir, attempt.attemptDir), true);
  assert.ok(!fs.existsSync(attempt.stagingDir));
});

test('writeJsonAtomic 不残留临时文件', (t) => {
  const base = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  const file = path.join(created.runDir, 'probe.json');
  const result = workspace.writeJsonAtomic(file, { hello: 'world' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' });
  assert.deepStrictEqual(
    fs.readdirSync(created.runDir).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('工作区外仍未被写入（候选链天然不触达仓库 templates/miniprogram）', (t) => {
  const base = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  const attempt = workspace.beginAttempt(created);
  assert.strictEqual(workspace.isInside(base, attempt.attemptDir), true);
  assert.strictEqual(workspace.isInside(REPO, attempt.attemptDir), false);
  for (const protectedDir of ['templates', 'miniprogram']) {
    assert.strictEqual(workspace.isInside(path.join(REPO, protectedDir), attempt.attemptDir), false);
  }
});

test('私有根本身是 junction：拒绝且真实目标目录保持为空', (t) => {
  const escape = withBase(t);
  const parent = withBase(t);
  const link = path.join(parent, 'userdata-link');
  createJunction(link, escape);

  const result = workspace.createWorkspace({ userDataDir: link, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), [], 'junction 目标目录必须保持为空');

  const resolved = workspace.resolvePrivateRoot(link);
  assert.strictEqual(resolved.ok, false);
  assert.strictEqual(resolved.code, 'WORKSPACE_PATH_REJECTED');
});

test('projects / frontend-runs 段被换成 junction：创建前失败且目标为空', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  createJunction(path.join(base, 'projects'), escape);
  const projectsResult = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(projectsResult.ok, false);
  assert.strictEqual(projectsResult.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);

  const base2 = withBase(t);
  const escape2 = withBase(t);
  fs.mkdirSync(path.join(base2, 'projects', PROJECT_ID), { recursive: true });
  createJunction(path.join(base2, 'projects', PROJECT_ID, 'frontend-runs'), escape2);
  const runsResult = workspace.createWorkspace({ userDataDir: base2, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(runsResult.ok, false);
  assert.strictEqual(runsResult.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape2), []);
});

test('assertCanonicalDir：真实目录通过，junction 拒绝', (t) => {
  const real = withBase(t);
  const escape = withBase(t);
  const okResult = workspace.assertCanonicalDir(real);
  assert.strictEqual(okResult.ok, true);
  assert.strictEqual(okResult.realDir, workspace.realpathOf(real));

  const link = path.join(real, 'link');
  createJunction(link, escape);
  const rejected = workspace.assertCanonicalDir(link);
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('beginAttempt 跳过已存在的 junction attempt 名，不写入链接目标', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(created.ok, true);
  createJunction(path.join(created.attemptsDir, 'attempt-1'), escape);

  const attempt = workspace.beginAttempt(created);
  assert.strictEqual(attempt.ok, true, JSON.stringify(attempt));
  assert.notStrictEqual(attempt.attempt, 1);
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('removeAttempt 拒绝 junction 目标，且不删除链接之外的内容', (t) => {
  const base = withBase(t);
  const escape = withBase(t);
  const created = workspace.createWorkspace({ userDataDir: base, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(created.ok, true);
  fs.writeFileSync(path.join(escape, 'keep.txt'), 'keep', 'utf8');

  const attemptDir = path.join(created.attemptsDir, 'attempt-1');
  createJunction(attemptDir, escape);
  assert.strictEqual(workspace.removeAttempt(attemptDir, created.attemptsDir), false);
  assert.deepStrictEqual(fs.readdirSync(escape), ['keep.txt']);
  assert.ok(fs.existsSync(path.join(escape, 'keep.txt')));
});

test('removeTreeSafely 删除含 junction 的目录时不跟随链接（目标目录原样保留）', (t) => {
  const dir = withBase(t);
  const escape = withBase(t);
  fs.writeFileSync(path.join(escape, 'keep.txt'), 'keep', 'utf8');
  fs.mkdirSync(path.join(dir, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'inner', 'file.txt'), 'x', 'utf8');
  createJunction(path.join(dir, 'inner', 'link'), escape);

  assert.strictEqual(workspace.removeTreeSafely(dir), true);
  assert.ok(!fs.existsSync(dir));
  assert.deepStrictEqual(fs.readdirSync(escape), ['keep.txt']);
});

test('祖先 junction + 缺失根：resolvePrivateRoot/createWorkspace 在 mkdir 前拒绝', (t) => {
  const escape = withBase(t);
  const parent = withBase(t);
  const link = path.join(parent, 'userdata-link');
  createJunction(link, escape);

  // `${junction}/newroot` 不存在：旧实现会先在 escape 里建 newroot 再拒绝。
  const missingRoot = path.join(link, 'newroot');
  const resolved = workspace.resolvePrivateRoot(missingRoot);
  assert.strictEqual(resolved.ok, false);
  assert.strictEqual(resolved.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), [], 'junction 目标目录不得新增任何目录');

  const created = workspace.createWorkspace({ userDataDir: missingRoot, projectId: PROJECT_ID, runId: RUN_ID });
  assert.strictEqual(created.ok, false);
  assert.strictEqual(created.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), [], 'createWorkspace 也不得在链接目标留下目录');
});

test('ensureCanonicalDirectory：多级缺失目录逐段创建；祖先 junction 时拒绝且目标为空', (t) => {
  const root = withBase(t);
  const nested = path.join(root, 'a', 'b', 'c');
  const ensured = workspace.ensureCanonicalDirectory(nested);
  assert.strictEqual(ensured.ok, true, JSON.stringify(ensured));
  assert.strictEqual(ensured.realDir, workspace.realpathOf(nested));
  assert.ok(fs.existsSync(nested));

  const escape = withBase(t);
  const parent = withBase(t);
  const link = path.join(parent, 'link');
  createJunction(link, escape);
  const rejected = workspace.ensureCanonicalDirectory(path.join(link, 'deep', 'target'));
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('祖先 junction + 缺失 overlayRoot：writeOverlayFiles 在 mkdir 前拒绝，目标为空', (t) => {
  const attempt = withBase(t);
  const escape = withBase(t);
  const link = path.join(attempt, 'link');
  createJunction(link, escape);
  const overlay = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'registry-overlay.cjs'));

  const result = overlay.writeOverlayFiles(
    path.join(link, 'new-overlay'),
    new Map([['registry.v1.json', '{}']]),
    { expectedPrivateRoot: attempt },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'OVERLAY_WRITE_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), [], '祖先 junction 目标不得新增目录');
});
