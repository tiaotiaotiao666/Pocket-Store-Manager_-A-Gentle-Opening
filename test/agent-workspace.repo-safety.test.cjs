'use strict';

/**
 * B1：正式仓库零写入、模块纯度（纯 CJS / 无 Electron / 无 child_process）与共享路径实现复用。
 *
 * 这一组是“边界证据”，不是功能测试：证明 B1 没有把写入落到正式仓库，
 * 也没有复制第二份安全路径实现。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'proj-alpha';
const RUN_ID = 'frun-20261124-b1';
const TURN_ID = 'turn-1';

const workspaceMod = h.loadModule('workspace');
const filesMod = h.loadModule('files');
const transactionsMod = h.loadModule('transactions');
const manifestMod = h.loadModule('manifest');
const pathsMod = h.loadModule('paths');
const frWorkspace = require(path.join(h.FRONTEND_RECONSTRUCT_DIR, 'workspace.cjs'));

const MODULE_FILES = ['paths.cjs', 'workspace.cjs', 'files.cjs', 'transactions.cjs', 'manifest.cjs'];

function sourceOf(name) {
  return fs.readFileSync(path.join(h.AGENT_WORKSPACE_DIR, name), 'utf8');
}

test('模块纯度：纯 CJS 可 require，无 Electron / child_process / shell 执行入口', () => {
  for (const name of MODULE_FILES) {
    const source = sourceOf(name);
    assert.ok(fs.existsSync(path.join(h.AGENT_WORKSPACE_DIR, name)), '缺少模块：' + name);
    assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(source), name + ' 不得依赖 Electron');
    assert.ok(!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(source), name + ' 不得 require child_process');
    // 注意 regex.exec(.test( 是正则方法，不算 shell 入口；这里只拦真正的进程/命令执行。
    assert.ok(!/(^|[^.\w])(execSync|spawnSync|execFileSync|spawn|fork|execFile)\s*\(/.test(source),
      name + ' 不得有通用 shell/进程执行入口');
    assert.ok(!/require\(\s*['"](node:)?(http|https|net)['"]\s*\)/.test(source), name + ' 不得开网络通道');
  }
  const readme = fs.readFileSync(path.join(h.AGENT_WORKSPACE_DIR, 'README.md'), 'utf8');
  assert.ok(readme.length > 500, 'README 需要解释布局/不变量/上限/错误码/复用关系');
  for (const keyword of ['treeDigest', 'AGENT_', '事务', '上限', 'frontend-reconstruct']) {
    assert.ok(readme.includes(keyword), 'README 缺少关键说明：' + keyword);
  }

  // 对外签名（B1 报告与 rev2 复核依据）。
  const expected = {
    workspace: ['openWorkspace', 'createAttempt', 'openAttempt', 'listAttempts', 'removeAttempt',
      'workspacePaths', 'attemptPaths', 'assertOwnership', 'readProjectFile', 'CODES', 'LIMITS'],
    files: ['listFiles', 'readFile', 'searchFiles', 'writeFile', 'deleteFile', 'normalizeRelativePath'],
    transactions: ['beginChanges', 'commitChanges', 'discardChanges', 'applyChanges', 'cleanupStagedTransactions',
      'listStagedTransactions'],
    manifest: ['buildManifest', 'diffManifests', 'digestOfContent', 'readAttemptMeta', 'writeAttemptMeta',
      'readRunMeta', 'writeRunMeta', 'readTurnMeta'],
  };
  const modules = { workspace: workspaceMod, files: filesMod, transactions: transactionsMod, manifest: manifestMod };
  for (const [name, keys] of Object.entries(expected)) {
    for (const key of keys) {
      assert.ok(modules[name][key] !== undefined, name + '.cjs 缺少导出：' + key);
    }
  }
});

test('共享复用：frontend-reconstruct/workspace.cjs 直接调用 agent-workspace/paths.cjs，无第二份实现', () => {
  const frSource = fs.readFileSync(path.join(h.FRONTEND_RECONSTRUCT_DIR, 'workspace.cjs'), 'utf8');
  assert.match(frSource, /require\(\s*['"]\.\.\/agent-workspace\/paths\.cjs['"]\s*\)/,
    '旧 workspace.cjs 必须 require ../agent-workspace/paths.cjs');
  assert.ok(!/function\s+(isLinkLike|realpathOf|samePath|isInside|isInsideOrEqual|isProtectedRepoDir|removeTreeSafely|resolvePrivateRoot|auditPath|ensureDirectory|ensureCanonicalDirectory|assertCanonicalDir|assertSafeRelativePath|resolveInside)\s*\(/.test(frSource),
    '旧 workspace.cjs 不得保留重复的安全路径实现');

  // 函数引用必须严格相同：证明是同一份实现，而不是“行为相似的第二份”。
  const shared = ['samePath', 'realpathOf', 'isInside', 'isInsideOrEqual', 'isProtectedRepoDir', 'isLinkLike',
    'removeTreeSafely', 'resolvePrivateRoot', 'auditPath', 'ensureDirectory', 'ensureCanonicalDirectory',
    'assertCanonicalDir', 'assertSafeRelativePath', 'resolveInside', 'writeJsonAtomic', 'assertId', 'randomSuffix'];
  for (const key of shared) {
    assert.strictEqual(typeof pathsMod[key], 'function', 'paths.cjs 缺少共享函数：' + key);
    assert.strictEqual(frWorkspace[key], pathsMod[key], '旧模块必须复用 paths.cjs 的同一函数：' + key);
  }
  assert.deepStrictEqual(frWorkspace.CODES, pathsMod.LEGACY_CODES, '旧 CODES 必须映射到共享 profile');
  assert.strictEqual(frWorkspace.CODES.PATH_REJECTED, 'WORKSPACE_PATH_REJECTED', '旧错误码字符串不得变化');
  for (const code of Object.values(pathsMod.AGENT_CODES)) {
    assert.match(code, /^AGENT_[A-Z_]+$/);
  }
  assert.notStrictEqual(pathsMod.AGENT_CODES.PATH_LINK, pathsMod.LEGACY_CODES.PATH_LINK, '两套错误码命名空间必须分开');
});

test('契约常量单一来源：RUN_ID_PATTERN 与生成契约同一对象，agent 域模式注明来源', () => {
  const constantsMod = h.loadModule('constants');
  const generated = require(path.join(h.FRONTEND_RECONSTRUCT_DIR, 'contract.generated.cjs'));
  const frSource = fs.readFileSync(path.join(h.FRONTEND_RECONSTRUCT_DIR, 'workspace.cjs'), 'utf8');

  // RUN_ID/PROJECT_ID 只能来自 frontend 生成契约，不得在 agent 域留第二份字面量。
  assert.strictEqual(pathsMod.RUN_ID_PATTERN, generated.RUN_ID_PATTERN, 'paths 必须从生成契约取 RUN_ID_PATTERN');
  assert.strictEqual(constantsMod.RUN_ID_PATTERN, generated.RUN_ID_PATTERN,
    'constants.RUN_ID_PATTERN 必须与生成契约同一对象（重导出，不是副本）');
  assert.strictEqual(frWorkspace.RUN_ID_PATTERN, generated.RUN_ID_PATTERN,
    '旧 workspace 必须直接从生成契约取 RUN_ID_PATTERN');
  assert.strictEqual(frWorkspace.PROJECT_ID_PATTERN, generated.PROJECT_ID_PATTERN);
  assert.strictEqual(constantsMod.RUN_ID_PATTERN, pathsMod.RUN_ID_PATTERN, 'constants 与 paths 必须同源');

  // 旧 workspace.cjs 必须保留对生成契约的直接 require（契约守卫 test/frontend-contract.test.cjs 的口径）。
  assert.match(frSource, /require\(\s*['"]\.\/contract\.generated\.cjs['"]\s*\)/,
    '旧 workspace.cjs 必须直接 require ./contract.generated.cjs');
  assert.ok(!/const\s+RUN_ID_PATTERN\s*=\s*\/\^frun-/.test(frSource), '旧 workspace.cjs 不得本地声明 RUN_ID_PATTERN');
  assert.ok(!/const\s+RUN_ID_PATTERN\s*=\s*\/\^frun-/.test(fs.readFileSync(path.join(h.AGENT_WORKSPACE_DIR, 'constants.cjs'), 'utf8')),
    'constants.cjs 不得本地声明 RUN_ID_PATTERN');

  // agent 域自有模式（冻结 §1.3/§2.1 + rev3 §1.10）：不是 frontend 契约的复制，保留在 constants。
  for (const key of ['TURN_ID_PATTERN', 'ATTEMPT_ID_PATTERN', 'VERSION_ID_PATTERN', 'TRANSACTION_ID_PATTERN']) {
    assert.ok(constantsMod[key] instanceof RegExp, 'constants 缺少 agent 域模式：' + key);
  }
  assert.strictEqual(constantsMod.ATTEMPT_ID_PATTERN, pathsMod.ATTEMPT_DIR_PATTERN, 'attempt 模式必须复用旧链同一正则');
  assert.strictEqual(constantsMod.TURN_ID_PATTERN.test('turn-1'), true);
  assert.strictEqual(constantsMod.VERSION_ID_PATTERN.test('v1'), true);
});

test('正式仓库零写入：完整 B1 流程前后，templates/miniprogram/src/desktop/scripts/contracts 指纹不变', (t) => {
  const watchDirs = ['templates', 'miniprogram', 'src', 'desktop', 'scripts', 'contracts'];
  const before = h.repoFingerprint(watchDirs);
  const userDataDir = h.userDataWith(t);

  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const attempt = created.attempt;

  const written = filesMod.writeFile(attempt, { path: 'pages/menu/index.wxml', content: '<view class="menu">flow</view>' });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'app.json', content: '{}', expectedBaseSha256: 'sha256:' + '1'.repeat(64) }]),
    workspaceMod.CODES.BASE_DIGEST_MISMATCH,
    '冲突写入',
  );
  assert.strictEqual(filesMod.deleteFile(attempt, { path: 'sitemap.json' }).ok, true);

  const begun = transactionsMod.beginChanges(attempt, [{ op: 'write', path: 'notes/discard.txt', content: 'x' }]);
  assert.strictEqual(begun.ok, true);
  assert.strictEqual(transactionsMod.discardChanges(attempt, begun.transactionId).ok, true);

  assert.strictEqual(manifestMod.writeAttemptMeta(attempt, { status: 'submitted' }).ok, true);
  assert.strictEqual(manifestMod.writeRunMeta(opened.workspace, RUN_ID, { label: 'flow' }).ok, true);

  const reopenedWorkspace = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const reopened = workspaceMod.openAttempt(reopenedWorkspace.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));

  const after = h.repoFingerprint(watchDirs);
  assert.strictEqual(after, before, '正式仓库目录在 B1 流程后必须指纹不变（零写入）');
});

test('写入收敛：所有产物都在 <userData>/projects/<projectId>/agent-workspace 下且布局合法', (t) => {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const created = workspaceMod.createAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  const attempt = created.attempt;
  assert.strictEqual(filesMod.writeFile(attempt, { path: 'notes/inner.txt', content: 'x' }).ok, true);
  const second = workspaceMod.createAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 2, source: { kind: 'base' } });
  assert.strictEqual(second.ok, true, JSON.stringify(second));

  const prefix = path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace');
  for (const entry of h.listRelativeFiles(userDataDir)) {
    const abs = path.join(userDataDir, ...entry.path.split('/'));
    assert.ok(abs.toLowerCase().startsWith(prefix.toLowerCase()), '越出私有工作区：' + abs);
  }

  const attemptRelative = path.relative(prefix, attempt.attemptDir).split(path.sep).join('/');
  assert.strictEqual(attemptRelative, 'runs/' + RUN_ID + '/turns/' + TURN_ID + '/attempts/attempt-1');
  assert.ok(fs.existsSync(path.join(prefix, 'project.json')));
  assert.ok(fs.existsSync(path.join(attempt.attemptDir, 'attempt.json')));
  assert.ok(fs.existsSync(path.join(attempt.attemptDir, 'candidate')));
  assert.ok(fs.existsSync(path.join(attempt.attemptDir, 'verification')));
  assert.ok(fs.existsSync(path.join(attempt.turnDir, 'turn.json')));
  assert.ok(fs.existsSync(path.join(attempt.runDir, 'run.json')));
});
