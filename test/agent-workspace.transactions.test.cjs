'use strict';

/**
 * B1：transactions.cjs 的事务、冲突检测、整批回滚、暂存清理与确定性。
 *
 * 契约：冻结文档 §1.5（路径与事务不变量）、§1.6（摘要）、§1.7（错误码）、§1.4（批量上限）。
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
const CODES = workspaceMod.CODES;

function setup(t, options) {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, Object.assign({
    runId: RUN_ID,
    turnId: TURN_ID,
    source: { kind: 'base' },
  }, options));
  assert.strictEqual(created.ok, true, 'createAttempt 失败：' + JSON.stringify(created));
  return { userDataDir, workspace: opened.workspace, attempt: created.attempt };
}

function digestOf(attempt) {
  const manifest = manifestMod.buildManifest(attempt.candidateDir);
  assert.strictEqual(manifest.ok, true, JSON.stringify(manifest));
  return manifest.manifest.treeDigest;
}

function stagingDirs(attempt) {
  return h.entriesOf(attempt.attemptDir).filter((name) => /^\.staging-[0-9a-f]{8}$/.test(name));
}

function metaOf(attempt) {
  return JSON.parse(fs.readFileSync(attempt.attemptFile, 'utf8'));
}

test('beginChanges：只暂存不落盘，discardChanges 清理暂存且工作树原样', (t) => {
  const { attempt } = setup(t);
  const beforeDigest = digestOf(attempt);
  const beforeFiles = h.listRelativeFiles(attempt.candidateDir);

  const begun = transactionsMod.beginChanges(attempt, [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">changed</view>' },
    { op: 'delete', path: 'sitemap.json' },
  ]);
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  assert.match(begun.transactionId, /^[0-9a-f]{8}$/);
  assert.strictEqual(stagingDirs(attempt).length, 1, '应当有一个 .staging-<8hex> 暂存目录');
  assert.ok(fs.existsSync(path.join(attempt.attemptDir, '.staging-' + begun.transactionId)));

  // 暂存阶段工作树完全不变。
  assert.strictEqual(digestOf(attempt), beforeDigest);
  assert.deepStrictEqual(h.listRelativeFiles(attempt.candidateDir), beforeFiles);

  const discarded = transactionsMod.discardChanges(attempt, begun.transactionId);
  assert.strictEqual(discarded.ok, true, JSON.stringify(discarded));
  assert.strictEqual(stagingDirs(attempt).length, 0, '丢弃后不得残留暂存');
  assert.strictEqual(digestOf(attempt), beforeDigest);
});

test('commitChanges：原子提交后文件生效、暂存清除、revision 与 treeDigest 更新', (t) => {
  const { userDataDir, attempt } = setup(t);
  const beforeMeta = metaOf(attempt);
  const beforeDigest = digestOf(attempt);

  const begun = transactionsMod.beginChanges(attempt, [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">v2</view>' },
    { op: 'write', path: 'notes/new-file.md', content: 'hello\n' },
  ]);
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));

  const committed = transactionsMod.commitChanges(attempt, begun.transactionId);
  assert.strictEqual(committed.ok, true, JSON.stringify(committed));
  assert.strictEqual(fs.readFileSync(path.join(attempt.candidateDir, 'pages', 'menu', 'index.wxml'), 'utf8'), '<view class="menu">v2</view>');
  assert.strictEqual(fs.readFileSync(path.join(attempt.candidateDir, 'notes', 'new-file.md'), 'utf8'), 'hello\n');
  assert.strictEqual(stagingDirs(attempt).length, 0, '提交后不得残留暂存');

  const afterMeta = metaOf(attempt);
  assert.strictEqual(afterMeta.revision, beforeMeta.revision + 1);
  assert.strictEqual(afterMeta.treeDigest, digestOf(attempt));
  assert.notStrictEqual(afterMeta.treeDigest, beforeDigest);
  assert.match(afterMeta.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(afterMeta.updatedAt >= beforeMeta.updatedAt, true);

  // 后续读取（新实例）与提交结果一致。
  const reopenedWorkspace = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopenedWorkspace.ok, true, JSON.stringify(reopenedWorkspace));
  const reopened = workspaceMod.openAttempt(reopenedWorkspace.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.attempt.treeDigest, afterMeta.treeDigest);
});

test('一批变更产出完整 diff：added/modified/deleted/unchanged 与每文件摘要', (t) => {
  const { attempt } = setup(t);
  const baseManifest = manifestMod.buildManifest(attempt.candidateDir).manifest;

  const applied = transactionsMod.applyChanges(attempt, [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">diff</view>' },
    { op: 'write', path: 'notes/added.txt', content: 'added\n' },
    { op: 'delete', path: 'sitemap.json' },
  ]);
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  assert.ok(Array.isArray(applied.diff.files));

  const byPath = new Map(applied.diff.files.map((item) => [item.path, item]));
  assert.strictEqual(byPath.get('notes/added.txt').status, 'added');
  assert.strictEqual(byPath.get('pages/menu/index.wxml').status, 'modified');
  assert.strictEqual(byPath.get('sitemap.json').status, 'deleted');
  assert.strictEqual(byPath.get('app.json').status, 'unchanged');

  for (const item of applied.diff.files) {
    assert.deepStrictEqual(Object.keys(item).sort(), ['bytes', 'path', 'sha256', 'status']);
    assert.match(item.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(item.bytes) && item.bytes >= 0);
  }
  assert.strictEqual(byPath.get('pages/menu/index.wxml').sha256, 'sha256:' + h.sha256OfText('<view class="menu">diff</view>'));
  assert.strictEqual(byPath.get('sitemap.json').sha256, baseManifest.files.find((item) => item.path === 'sitemap.json').sha256);
  assert.deepStrictEqual(applied.diff.counts, { added: 1, modified: 1, deleted: 1, unchanged: baseManifest.files.length - 2 });
  assert.strictEqual(applied.treeDigest, digestOf(attempt));
});

test('expectedBaseSha256 冲突：明确冲突码、不落盘、无暂存残留', (t) => {
  const { attempt } = setup(t);
  const beforeDigest = digestOf(attempt);
  const appJsonDigest = filesMod.readFile(attempt, { path: 'app.json' }).sha256;
  const wrongDigest = 'sha256:' + '0'.repeat(64);

  const conflictWrite = transactionsMod.applyChanges(attempt, [
    { op: 'write', path: 'app.json', content: '{}', expectedBaseSha256: wrongDigest },
  ]);
  h.assertFailure(conflictWrite, CODES.BASE_DIGEST_MISMATCH, '写冲突');
  assert.strictEqual(digestOf(attempt), beforeDigest);
  assert.strictEqual(stagingDirs(attempt).length, 0);
  assert.strictEqual(filesMod.readFile(attempt, { path: 'app.json' }).sha256, appJsonDigest);

  // expectedBaseSha256: null 表示“期望文件不存在”。
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'app.json', content: '{}', expectedBaseSha256: null }]),
    CODES.BASE_DIGEST_MISMATCH,
    '期望不存在但实际存在',
  );
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'brand-new.txt', content: 'x', expectedBaseSha256: appJsonDigest }]),
    CODES.BASE_DIGEST_MISMATCH,
    '期望存在但实际不存在',
  );

  // 正确摘要可以写。
  const ok = transactionsMod.applyChanges(attempt, [
    { op: 'write', path: 'app.json', content: '{}', expectedBaseSha256: appJsonDigest },
  ]);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(filesMod.readFile(attempt, { path: 'app.json' }).content, '{}');

  // 删除同样支持冲突检测。
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'delete', path: 'sitemap.json', expectedBaseSha256: wrongDigest }]),
    CODES.BASE_DIGEST_MISMATCH,
    '删除冲突',
  );
  assert.ok(filesMod.readFile(attempt, { path: 'sitemap.json' }).ok);
});

test('delete_file：显式删除、重复删除明确报错、空字符串/通配/目录不得隐式删除', (t) => {
  const { attempt } = setup(t);

  const deleted = filesMod.deleteFile(attempt, { path: 'sitemap.json' });
  assert.strictEqual(deleted.ok, true, JSON.stringify(deleted));
  h.assertFailure(filesMod.readFile(attempt, { path: 'sitemap.json' }), CODES.FILE_NOT_FOUND, '删除后读取');
  assert.ok(!h.listRelativeFiles(attempt.candidateDir).some((item) => item.path === 'sitemap.json'));

  h.assertFailure(filesMod.deleteFile(attempt, { path: 'sitemap.json' }), CODES.FILE_NOT_FOUND, '重复删除');
  h.assertFailure(filesMod.deleteFile(attempt, { path: '' }), CODES.PATH_INVALID, '空字符串隐式删除');
  h.assertFailure(filesMod.deleteFile(attempt, { path: '.' }), CODES.PATH_INVALID, '点路径');
  h.assertFailure(filesMod.deleteFile(attempt, { path: 'pages' }), CODES.ARGUMENT_INVALID, '目录不是文件');
  h.assertFailure(filesMod.deleteFile(attempt, { path: '*.json' }), CODES.FILE_NOT_FOUND, '通配符不是文件');

  // 空字符串内容不是删除，而是 0 字节文件。
  const emptyWrite = filesMod.writeFile(attempt, { path: 'notes/empty.txt', content: '' });
  assert.strictEqual(emptyWrite.ok, true, JSON.stringify(emptyWrite));
  const listed = filesMod.listFiles(attempt, { dir: 'notes' });
  assert.ok(listed.files.some((item) => item.path === 'notes/empty.txt' && item.bytes === 0));
  const readEmpty = filesMod.readFile(attempt, { path: 'notes/empty.txt' });
  assert.strictEqual(readEmpty.ok, true);
  assert.strictEqual(readEmpty.content, '');
});

test('部分失败：整批不提交、不落盘、清理暂存（含冲突/穿越/超限/不存在）', (t) => {
  const { attempt } = setup(t);
  const beforeDigest = digestOf(attempt);
  const wrongDigest = 'sha256:' + 'f'.repeat(64);

  const batches = [
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'write', path: 'notes/second.txt', content: 'second', expectedBaseSha256: wrongDigest },
    ],
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'delete', path: 'notes/never-existed.txt' },
    ],
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'write', path: '../escape.txt', content: 'x' },
    ],
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'write', path: 'notes/too-big.txt', content: 'x'.repeat(1024 * 1024 + 1) },
    ],
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'write', path: 'notes/first.txt', content: 'duplicate' },
    ],
    [
      { op: 'write', path: 'notes/first.txt', content: 'first' },
      { op: 'rename', path: 'notes/first.txt', to: 'notes/other.txt' },
    ],
  ];

  for (const changes of batches) {
    const result = transactionsMod.applyChanges(attempt, changes);
    assert.strictEqual(result.ok, false, '批量必须失败：' + JSON.stringify(changes.map((c) => c.path)));
    assert.match(result.code, /^AGENT_/);
    assert.strictEqual(stagingDirs(attempt).length, 0, '失败后不得残留暂存：' + result.code);
    assert.strictEqual(digestOf(attempt), beforeDigest, '失败后工作树必须原样：' + result.code);
    assert.ok(!fs.existsSync(path.join(attempt.candidateDir, 'notes', 'first.txt')), '不得写入半批：' + result.code);
  }
});

test('批量上限与参数校验：文件数/总字节/空批/非字符串内容/统一 diff', (t) => {
  const { attempt } = setup(t);
  const beforeDigest = digestOf(attempt);

  const tooMany = Array.from({ length: 33 }, (_, index) => ({ op: 'write', path: 'notes/batch-' + index + '.txt', content: 'x' }));
  h.assertFailure(transactionsMod.applyChanges(attempt, tooMany), CODES.BATCH_TOO_LARGE, '单批文件数超限');

  const chunk = 'y'.repeat(800 * 1024);
  const tooBig = [1, 2, 3].map((index) => ({ op: 'write', path: 'notes/chunk-' + index + '.txt', content: chunk }));
  h.assertFailure(transactionsMod.applyChanges(attempt, tooBig), CODES.BATCH_TOO_LARGE, '单批总字节超限');

  h.assertFailure(transactionsMod.applyChanges(attempt, []), CODES.ARGUMENT_INVALID, '空批量');
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'notes/x.txt', content: Buffer.from('x') }]),
    CODES.ARGUMENT_INVALID,
    '非字符串内容',
  );
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'notes/x.txt', content: '--- a/x\n+++ b/x\n' }]),
    CODES.PATCH_REJECTED,
    'unified diff 内容',
  );
  h.assertFailure(
    transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'notes/x.txt', content: 'x', format: 'patch' }]),
    CODES.PATCH_REJECTED,
    '显式 patch 格式',
  );
  h.assertFailure(transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'notes/x.txt' }]), CODES.ARGUMENT_INVALID, '缺少 content');
  h.assertFailure(transactionsMod.applyChanges(attempt, 'not-an-array'), CODES.ARGUMENT_INVALID, 'changes 非数组');

  assert.strictEqual(digestOf(attempt), beforeDigest);
  assert.strictEqual(stagingDirs(attempt).length, 0);
});

test('提交失败可回滚：暂存候选缺失时 AGENT_TXN_ABORTED，原工作树不变', (t) => {
  const { attempt } = setup(t);
  const beforeDigest = digestOf(attempt);

  const begun = transactionsMod.beginChanges(attempt, [{ op: 'write', path: 'notes/x.txt', content: 'x' }]);
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  fs.rmSync(path.join(attempt.attemptDir, '.staging-' + begun.transactionId, 'candidate'), { recursive: true, force: true });

  const committed = transactionsMod.commitChanges(attempt, begun.transactionId);
  h.assertFailure(committed, CODES.TXN_ABORTED, '暂存候选缺失');
  assert.strictEqual(digestOf(attempt), beforeDigest, '提交失败后原工作树必须不变');
  assert.ok(filesMod.readFile(attempt, { path: 'app.json' }).ok);

  h.assertFailure(transactionsMod.commitChanges(attempt, 'deadbeef'), CODES.TXN_ABORTED, '不存在的 transactionId');
  const cleaned = transactionsMod.cleanupStagedTransactions(attempt);
  assert.strictEqual(cleaned.ok, true, JSON.stringify(cleaned));
  assert.strictEqual(cleaned.removed, 1);
  assert.strictEqual(stagingDirs(attempt).length, 0);
});

test('重开：遗留暂存被安全清理，读回状态与提交结果一致', (t) => {
  const userDataDir = h.userDataWith(t);
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const created = workspaceMod.createAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, source: { kind: 'base' } });
  const attempt = created.attempt;

  const committed = transactionsMod.applyChanges(attempt, [{ op: 'write', path: 'notes/kept.txt', content: 'kept' }]);
  assert.strictEqual(committed.ok, true, JSON.stringify(committed));
  const expectedDigest = digestOf(attempt);

  // 模拟崩溃：起了一个事务但没有提交。
  const orphan = transactionsMod.beginChanges(attempt, [{ op: 'write', path: 'notes/orphan.txt', content: 'orphan' }]);
  assert.strictEqual(orphan.ok, true, JSON.stringify(orphan));
  assert.strictEqual(stagingDirs(attempt).length, 1);

  const reopenedWorkspace = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopenedWorkspace.ok, true, JSON.stringify(reopenedWorkspace));
  const reopened = workspaceMod.openAttempt(reopenedWorkspace.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.attempt.treeDigest, expectedDigest, '重开后摘要必须一致');
  assert.strictEqual(fs.readFileSync(path.join(reopened.attempt.candidateDir, 'notes', 'kept.txt'), 'utf8'), 'kept');
  assert.strictEqual(stagingDirs(reopened.attempt).length, 0, '重开必须清理遗留暂存');
  assert.strictEqual(fs.existsSync(path.join(reopened.attempt.candidateDir, 'notes', 'orphan.txt')), false, '未提交事务不得生效');
});

test('确定性：相同输入重复执行 treeDigest 相同，内容未变时为 unchanged', (t) => {
  const first = setup(t);
  const second = setup(t);

  assert.strictEqual(digestOf(first.attempt), digestOf(second.attempt), '同一 Base 初始摘要必须相同');
  assert.strictEqual(first.attempt.treeDigest, second.attempt.treeDigest);

  const changes = [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">same</view>' },
    { op: 'write', path: 'notes/same.txt', content: 'same\n' },
    { op: 'delete', path: 'sitemap.json' },
  ];
  const appliedFirst = transactionsMod.applyChanges(first.attempt, changes.map((item) => ({ ...item })));
  const appliedSecond = transactionsMod.applyChanges(second.attempt, changes.map((item) => ({ ...item })));
  assert.strictEqual(appliedFirst.ok, true, JSON.stringify(appliedFirst));
  assert.strictEqual(appliedSecond.ok, true, JSON.stringify(appliedSecond));
  assert.strictEqual(appliedFirst.treeDigest, appliedSecond.treeDigest, '相同输入必须同摘要');
  assert.strictEqual(digestOf(first.attempt), digestOf(second.attempt));

  const repeated = transactionsMod.applyChanges(first.attempt, [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">same</view>' },
    { op: 'write', path: 'notes/same.txt', content: 'same\n' },
  ]);
  assert.strictEqual(repeated.ok, true, JSON.stringify(repeated));
  assert.strictEqual(repeated.treeDigest, appliedFirst.treeDigest, '幂等重写不得改变摘要');
  const statuses = new Map(repeated.diff.files.map((item) => [item.path, item.status]));
  assert.strictEqual(statuses.get('pages/menu/index.wxml'), 'unchanged');
  assert.strictEqual(statuses.get('notes/same.txt'), 'unchanged');

  // 摘要对路径顺序不敏感（写顺序不同，结果相同）。
  const ordered = transactionsMod.applyChanges(first.attempt, [
    { op: 'write', path: 'notes/order-b.txt', content: 'b' },
    { op: 'write', path: 'notes/order-a.txt', content: 'a' },
  ]);
  const reversed = transactionsMod.applyChanges(first.attempt, [
    { op: 'write', path: 'notes/order-a.txt', content: 'a' },
    { op: 'write', path: 'notes/order-b.txt', content: 'b' },
  ]);
  assert.strictEqual(ordered.ok && reversed.ok, true);
  assert.strictEqual(ordered.treeDigest, reversed.treeDigest, '写入顺序不得影响摘要');
});
