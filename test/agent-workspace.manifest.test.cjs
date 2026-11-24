'use strict';

/**
 * B1：manifest.cjs 的 treeDigest 冻结算法、逐文件 manifest、两棵树 diff 与 run/attempt 元数据。
 *
 * 契约：冻结文档 §1.6（摘要与 manifest）、§1.7（错误码）。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'proj-alpha';
const RUN_ID = 'frun-20261124-b1';
const TURN_ID = 'turn-1';

const workspaceMod = h.loadModule('workspace');
const transactionsMod = h.loadModule('transactions');
const manifestMod = h.loadModule('manifest');
const CODES = workspaceMod.CODES;

function setup(t) {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'base' },
  });
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  return { userDataDir, workspace: opened.workspace, attempt: created.attempt };
}

function frozenTreeDigest(files) {
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = sorted.map((item) => item.path + '\n' + item.sha256.replace(/^sha256:/, '') + '\n').join('');
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('treeDigest 冻结算法：路径升序 + "<path>\\n<sha256hex>\\n" 再 SHA-256，空树为空串摘要', () => {
  const dir = h.tempDir('manifest');
  fs.mkdirSync(path.join(dir, 'pages', 'menu'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.json'), '{"pages":[]}');
  fs.writeFileSync(path.join(dir, 'pages', 'menu', 'index.wxml'), '<view />');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');

  const built = manifestMod.buildManifest(dir);
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  const manifest = built.manifest;
  assert.deepStrictEqual(manifest.files.map((item) => item.path), ['app.json', 'notes.txt', 'pages/menu/index.wxml']);
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(dir, ...item.path.split('/')));
    assert.strictEqual(item.sha256, 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.strictEqual(item.bytes, bytes.length);
  }
  assert.strictEqual(manifest.treeDigest, frozenTreeDigest(manifest.files));

  // 空树：sha256: + SHA-256(空串)，不是空值。
  const emptyDir = h.tempDir('manifest-empty');
  const empty = manifestMod.buildManifest(emptyDir);
  assert.strictEqual(empty.ok, true, JSON.stringify(empty));
  assert.deepStrictEqual(empty.manifest.files, []);
  assert.strictEqual(empty.manifest.treeDigest, 'sha256:' + crypto.createHash('sha256').update('', 'utf8').digest('hex'));
  assert.strictEqual(empty.manifest.treeDigest, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('manifest 确定性：同内容重复构建相同、不受写入顺序与 mtime 影响、内容变化即变化', () => {
  const first = h.tempDir('manifest-a');
  const second = h.tempDir('manifest-b');
  for (const dir of [first, second]) {
    fs.mkdirSync(path.join(dir, 'components', 'card'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.js'), 'App({})\n');
    fs.writeFileSync(path.join(dir, 'components', 'card', 'index.wxml'), '<view />');
  }
  // 改变第二个目录的 mtime，摘要必须只由内容决定。
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(second, 'app.js'), later, later);

  const a = manifestMod.buildManifest(first).manifest;
  const b = manifestMod.buildManifest(second).manifest;
  assert.deepStrictEqual(a.files, b.files);
  assert.strictEqual(a.treeDigest, b.treeDigest, '相同内容必须同摘要');

  fs.writeFileSync(path.join(second, 'app.js'), 'App({changed:true})\n');
  const changed = manifestMod.buildManifest(second).manifest;
  assert.notStrictEqual(changed.treeDigest, a.treeDigest, '内容变化必须改变摘要');
  assert.deepStrictEqual(manifestMod.buildManifest(second).manifest, changed, '重复构建必须确定');
});

test('diffManifests：added/modified/deleted/unchanged 与每文件 sha256，可截断', (t) => {
  const { attempt } = setup(t);
  const before = manifestMod.buildManifest(attempt.candidateDir).manifest;
  const applied = transactionsMod.applyChanges(attempt, [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">diff</view>' },
    { op: 'write', path: 'notes/added.txt', content: 'added\n' },
    { op: 'delete', path: 'sitemap.json' },
  ]);
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  const after = manifestMod.buildManifest(attempt.candidateDir).manifest;

  const diff = manifestMod.diffManifests(before, after);
  assert.strictEqual(diff.ok, true, JSON.stringify(diff));
  const byPath = new Map(diff.files.map((item) => [item.path, item]));
  assert.strictEqual(byPath.get('notes/added.txt').status, 'added');
  assert.strictEqual(byPath.get('pages/menu/index.wxml').status, 'modified');
  assert.strictEqual(byPath.get('sitemap.json').status, 'deleted');
  assert.strictEqual(byPath.get('app.json').status, 'unchanged');
  assert.strictEqual(byPath.get('sitemap.json').sha256, before.files.find((item) => item.path === 'sitemap.json').sha256);
  assert.strictEqual(byPath.get('notes/added.txt').sha256, 'sha256:' + h.sha256OfText('added\n'));
  assert.deepStrictEqual(diff.counts, { added: 1, modified: 1, deleted: 1, unchanged: before.files.length - 2 });
  assert.strictEqual(diff.truncated, false);

  // 相同两棵树：全部 unchanged、计数为 0 变更。
  const self = manifestMod.diffManifests(after, after);
  assert.strictEqual(self.ok, true);
  assert.deepStrictEqual(self.counts, { added: 0, modified: 0, deleted: 0, unchanged: after.files.length });
  assert.strictEqual(self.truncated, false);

  const truncated = manifestMod.diffManifests(before, after, { maxFiles: 2 });
  assert.strictEqual(truncated.ok, true);
  assert.strictEqual(truncated.truncated, true);
  assert.ok(truncated.files.length <= 2, '截断后不得超过 maxFiles');

  // 冻结的 diff 上限常量存在且为 64 / 512KiB。
  assert.strictEqual(workspaceMod.LIMITS.diffMaxFiles, 64);
  assert.strictEqual(workspaceMod.LIMITS.diffMaxBytes, 512 * 1024);
});

test('run/turn/attempt 元数据可写可读，写后重开仍一致', (t) => {
  const { userDataDir, workspace, attempt } = setup(t);

  const attemptMeta = manifestMod.readAttemptMeta(attempt);
  assert.strictEqual(attemptMeta.ok, true, JSON.stringify(attemptMeta));
  assert.deepStrictEqual(attemptMeta.meta, JSON.parse(fs.readFileSync(attempt.attemptFile, 'utf8')));

  const written = manifestMod.writeAttemptMeta(attempt, {
    status: 'submitted',
    summary: 'B1 元数据测试',
    verification: { runtime: 'NOT_RUN' },
    lastTransaction: { transactionId: 'deadbeef', relative: 'notes/x.txt' },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
  assert.strictEqual(written.meta.status, 'submitted');
  assert.strictEqual(written.meta.projectId, PROJECT_ID);
  assert.strictEqual(written.meta.treeDigest, attemptMeta.meta.treeDigest);

  const reopenedWorkspace = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const reopened = workspaceMod.openAttempt(reopenedWorkspace.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  const reread = manifestMod.readAttemptMeta(reopened.attempt);
  assert.strictEqual(reread.ok, true, JSON.stringify(reread));
  assert.strictEqual(reread.meta.status, 'submitted');
  assert.deepStrictEqual(reread.meta.lastTransaction, { transactionId: 'deadbeef', relative: 'notes/x.txt' });

  const runMeta = manifestMod.readRunMeta(workspace, RUN_ID);
  assert.strictEqual(runMeta.ok, true, JSON.stringify(runMeta));
  assert.strictEqual(runMeta.meta.schemaVersion, 'agent-run.v1');
  assert.deepStrictEqual(runMeta.meta.turns, [TURN_ID]);

  const runWritten = manifestMod.writeRunMeta(workspace, RUN_ID, { label: 'B1 run', status: 'active' });
  assert.strictEqual(runWritten.ok, true, JSON.stringify(runWritten));
  assert.strictEqual(manifestMod.readRunMeta(workspace, RUN_ID).meta.label, 'B1 run');

  const turnMeta = manifestMod.readTurnMeta(workspace, { runId: RUN_ID, turnId: TURN_ID });
  assert.strictEqual(turnMeta.ok, true, JSON.stringify(turnMeta));
  assert.strictEqual(turnMeta.meta.schemaVersion, 'agent-turn.v1');
  assert.deepStrictEqual(turnMeta.meta.attempts, ['attempt-1']);

  h.assertFailure(manifestMod.readRunMeta(workspace, 'run-other'), CODES.ID_INVALID, '非法 runId');
  h.assertFailure(manifestMod.readRunMeta(workspace, 'frun-unknown'), CODES.WORKSPACE_NOT_FOUND, '不存在 run');
  h.assertFailure(manifestMod.readAttemptMeta({ ...attempt, attemptFile: path.join(attempt.attemptDir, 'missing.json') }), CODES.WORKSPACE_NOT_FOUND, '不存在 attempt 元数据');
});

test('元数据安全：拒绝绝对路径/base64/超长正文，失败不落盘', (t) => {
  const { attempt } = setup(t);
  const before = fs.readFileSync(attempt.attemptFile, 'utf8');

  const unsafe = [
    { note: 'C:\\Users\\someone\\project' },
    { note: 'E:/智能开店app/templates/base' },
    { note: '/home/user/secret' },
    { note: 'data:image/png;base64,iVBORw0KGgo=' },
    { prompt: 'x'.repeat(9000) },
    { nested: { deep: [{ absolute: '\\\\server\\share\\x' }] } },
  ];
  for (const patch of unsafe) {
    const result = manifestMod.writeAttemptMeta(attempt, patch);
    h.assertFailure(result, CODES.WORKSPACE_INVALID, '不安全元数据：' + JSON.stringify(patch).slice(0, 80));
  }
  assert.strictEqual(fs.readFileSync(attempt.attemptFile, 'utf8'), before, '失败不得落盘');

  // 正常相对引用可以写。
  const ok = manifestMod.writeAttemptMeta(attempt, { lastTransaction: { relative: 'versions/v1/diff/summary.json' } });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.meta.lastTransaction.relative, 'versions/v1/diff/summary.json');
});
