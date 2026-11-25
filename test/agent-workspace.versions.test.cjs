'use strict';

/**
 * B2：不可变版本模型（versions.cjs）。
 *
 * 覆盖（冻结 §2.1/§2.2/§2.4）：
 * - initProject：Base → v1（version.json/source/diff/summary.json/evidence + project.json 指针）；
 * - adoptAttempt：attempt 候选树 → 新版本（parent=current、diff/evidence/adoption、redo 清空、失败原子）；
 * - undo/redo：只移指针、无父/无 redo 明确失败、分叉 redo 失败、不产生新版本目录；
 * - reopen：treeDigest 漂移/缺失 → AGENT_VERSION_CONFLICT(unavailable)，不回退 Base、幂等；
 * - 导出身份纯函数：resolveVersionSource/verifyExportIdentity 返回同源 sourceRoot、不写盘；
 * - 旧版本不可变 + 正式仓库零写入。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'proj-b2';
const RUN_ID = 'frun-20261124-b2';
const TURN_ID = 'turn-b2';

const workspaceMod = h.loadModule('workspace');
const filesMod = h.loadModule('files');
const transactionsMod = h.loadModule('transactions');
const manifestMod = h.loadModule('manifest');
const constantsMod = h.loadModule('constants');
const versionsMod = h.loadModule('versions');
const materialize = require(path.join(h.REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const CODES = versionsMod.CODES;

const FROZEN_V2_CODES = [
  'AGENT_VERSION_NOT_FOUND', 'AGENT_VERSION_CONFLICT', 'AGENT_VERSION_IMMUTABLE',
  'AGENT_UNDO_UNAVAILABLE', 'AGENT_REDO_UNAVAILABLE', 'AGENT_ADOPTION_FAILED',
  'AGENT_MIGRATION_FAILED', 'AGENT_EXPORT_IDENTITY_MISMATCH',
];

function workspaceDirOf(userDataDir) {
  return path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace');
}

function projectFileOf(userDataDir) {
  return path.join(workspaceDirOf(userDataDir), 'project.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readState(userDataDir) {
  return readJson(projectFileOf(userDataDir));
}

function hashTree(dir) {
  const files = h.listRelativeFiles(dir);
  const map = {};
  for (const entry of files) {
    map[entry.path] = 'sha256:' + h.sha256OfFile(path.join(dir, ...entry.path.split('/')));
  }
  return map;
}

function setup(t, options) {
  const userDataDir = h.userDataWith(t);
  const init = versionsMod.initProject(Object.assign({ userDataDir, projectId: PROJECT_ID }, options));
  assert.strictEqual(init.ok, true, 'initProject 失败：' + JSON.stringify(init));
  return { userDataDir, state: init.state, init };
}

function createAttempt(userDataDir, attemptNumber, source) {
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    attempt: attemptNumber,
    source: source || { kind: 'version', versionId: 'v1' },
  });
  assert.strictEqual(created.ok, true, 'createAttempt 失败：' + JSON.stringify(created));
  return created.attempt;
}

/** 按 attempt 编号造一棵有真实改动的候选树（用于 adopt）。 */
function attemptWithChanges(userDataDir, attemptNumber, suffix) {
  const attempt = createAttempt(userDataDir, attemptNumber);
  const writes = [
    { op: 'write', path: 'pages/menu/index.wxml', content: '<view class="menu">' + suffix + '</view>' },
    { op: 'write', path: 'notes/' + suffix + '.md', content: 'note ' + suffix + '\n' },
    { op: 'delete', path: 'sitemap.json' },
  ];
  const applied = h.loadModule('transactions').applyChanges(attempt, writes);
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  return { attempt, writes, digest: applied.treeDigest };
}

function adopt(userDataDir, attemptNumber, suffix) {
  const built = attemptWithChanges(userDataDir, attemptNumber, suffix);
  const adopted = versionsMod.adoptAttempt({
    userDataDir,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    attempt: attemptNumber,
  });
  assert.strictEqual(adopted.ok, true, 'adoptAttempt 失败：' + JSON.stringify(adopted));
  return { ...adopted, attempt: built.attempt, digest: built.digest };
}

/** 旧链 adopted 夹具（F2/迁移 sourceKind 用）：materializeCandidate + adopted.json + 旧 project.json。 */
function legacyDraft() {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: 'B2 legacy fixture',
    pages: [{
      pageId: 'home',
      nodes: [
        { type: 'component', componentId: 'store-header', props: { storeName: { kind: 'data', dataPath: 'store.name' } }, events: {} },
        { type: 'slot', slotId: 'home-hero' },
      ],
      styles: [],
      pageJson: { navigationBarTitleText: '扫码点餐' },
    }],
  };
}

function buildLegacyAdopted(userDataDir) {
  const materialized = materialize.materializeCandidate({
    userDataDir,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    draft: legacyDraft(),
  });
  assert.strictEqual(materialized.ok, true, 'materializeCandidate 失败：' + JSON.stringify(materialized));
  const attemptRelative = 'projects/' + PROJECT_ID + '/frontend-runs/' + RUN_ID + '/attempts/attempt-' + materialized.attempt;
  const overlayRelative = attemptRelative + '/overlay';
  const record = {
    schemaVersion: 'frontend-adoption.v1',
    status: 'adopted',
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attempt: materialized.attempt,
    candidateId: materialized.candidate.id,
    candidateVersion: materialized.candidate.version,
    integrity: materialized.candidate.integrity,
    overlayRelative,
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0 },
    adoptedAt: '2026-11-24T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(materialized.attemptDir, 'adopted.json'), JSON.stringify(record, null, 2));
  fs.mkdirSync(path.join(userDataDir, 'projects', PROJECT_ID), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'projects', PROJECT_ID, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: PROJECT_ID,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    name: 'B2 legacy fixture',
    phase: 'home',
    frontendCandidate: record,
  }, null, 2) + '\n');
  return { materialized, record };
}

test('错误码：B2 冻结 8 码齐全，且 constants 的 AGENT_* 全部在允许集合内', () => {
  const allowed = new Set([
    // §1.7（含 rev3 采纳的 5 个补充码）
    'AGENT_PROJECT_INVALID', 'AGENT_ROOT_INVALID', 'AGENT_WORKSPACE_NOT_FOUND', 'AGENT_WORKSPACE_INVALID',
    'AGENT_PATH_INVALID', 'AGENT_PATH_ESCAPE', 'AGENT_PATH_LINK', 'AGENT_PATH_PROTECTED',
    'AGENT_FILE_NOT_FOUND', 'AGENT_FILE_TOO_LARGE', 'AGENT_FILE_COUNT_EXCEEDED', 'AGENT_TREE_TOO_LARGE',
    'AGENT_DEPTH_EXCEEDED', 'AGENT_BASE_DIGEST_MISMATCH', 'AGENT_IO_FAILED', 'AGENT_TXN_ABORTED',
    'AGENT_ID_INVALID', 'AGENT_ARGUMENT_INVALID', 'AGENT_BATCH_TOO_LARGE', 'AGENT_PATCH_REJECTED',
    'AGENT_BINARY_FILE',
    // §2.2 B2 允许的 8 个新码
    ...FROZEN_V2_CODES,
  ]);
  for (const code of Object.values(constantsMod.CODES)) {
    assert.ok(allowed.has(code), '出现冻结集合外的错误码：' + code);
  }
  for (const code of FROZEN_V2_CODES) {
    assert.ok(Object.values(CODES).includes(code), 'versions.CODES 缺少冻结码：' + code);
  }
});

test('initProject：Base → v1 的目录、字段与摘要严格按冻结 §2.1', (t) => {
  const { userDataDir } = setup(t);
  const state = readState(userDataDir);

  assert.strictEqual(state.schemaVersion, 'agent-workspace.v1');
  assert.strictEqual(state.projectId, PROJECT_ID);
  assert.strictEqual(state.currentVersionId, 'v1');
  assert.strictEqual(state.previousVersionId, null);
  assert.strictEqual(state.redoVersionId, null);
  assert.strictEqual(state.migratedFrom, null);
  assert.strictEqual(state.versions.length, 1);
  const index = state.versions[0];
  assert.deepStrictEqual(Object.keys(index).sort(), [
    'createdAt', 'fileCount', 'isCurrent', 'parentVersionId', 'reason', 'screenshotCount', 'treeDigest', 'verification', 'versionId',
  ]);
  assert.strictEqual(index.versionId, 'v1');
  assert.strictEqual(index.parentVersionId, null);
  assert.strictEqual(index.reason, 'import-base');
  assert.strictEqual(index.isCurrent, true);
  assert.match(index.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(index.fileCount, h.listRelativeFiles(h.BASE_SOURCE_DIR).length);

  const versionDir = path.join(workspaceDirOf(userDataDir), 'versions', 'v1');
  for (const relative of ['version.json', 'source', 'diff/summary.json', 'evidence']) {
    assert.ok(fs.existsSync(path.join(versionDir, ...relative.split('/'))), 'v1 缺少：' + relative);
  }
  const version = readJson(path.join(versionDir, 'version.json'));
  assert.strictEqual(version.schemaVersion, 'agent-version.v1');
  assert.strictEqual(version.versionId, 'v1');
  assert.strictEqual(version.parentVersionId, null);
  assert.strictEqual(version.reason, 'import-base');
  assert.match(version.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(version.treeDigest, index.treeDigest);
  assert.strictEqual(version.base.templateId, 'ordering-base');
  assert.strictEqual(version.base.version, '1.0.0');
  assert.match(version.base.treeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(version.source.kind, 'base-copy');
  assert.strictEqual(version.source.files.count, index.fileCount);
  assert.strictEqual(version.diff.parentVersionId, null);
  assert.strictEqual(version.diff.added, index.fileCount);
  assert.strictEqual(version.diff.modified, 0);
  assert.strictEqual(version.diff.deleted, 0);
  assert.strictEqual(version.diff.unchanged, 0);
  assert.strictEqual(version.diff.summaryRelative, 'diff/summary.json');
  assert.deepStrictEqual(version.verification, {
    static: 'unknown', runtime: 'NOT_RUN', repairs: 0, screenshots: 0, checkedAt: null,
  });
  assert.deepStrictEqual(version.evidence, { checks: [], dryRunRelative: null, runtimeRelative: null });
  assert.strictEqual(version.storeDraftRef, null);
  assert.strictEqual(version.presentationPatchRef, null);

  const summary = readJson(path.join(versionDir, 'diff', 'summary.json'));
  assert.strictEqual(summary.parentVersionId, null);
  assert.strictEqual(summary.counts.added, index.fileCount);
  assert.strictEqual(summary.treeDigest, version.treeDigest);

  // 工作树与 Base 真源逐文件一致；摘要与 manifest 算法一致。
  const baseFiles = h.listRelativeFiles(h.BASE_SOURCE_DIR);
  assert.deepStrictEqual(h.listRelativeFiles(path.join(versionDir, 'source')), baseFiles);
  const manifest = manifestMod.buildManifest(path.join(versionDir, 'source'));
  assert.strictEqual(manifest.ok, true, JSON.stringify(manifest));
  assert.strictEqual(version.treeDigest, manifest.manifest.treeDigest);

  // 重开幂等：不新建版本、不重写内容。
  const before = fs.readFileSync(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'version.json'), 'utf8');
  const again = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.migrated, false);
  assert.strictEqual(fs.readFileSync(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'version.json'), 'utf8'), before);
  assert.deepStrictEqual(again.state.versions.map((item) => item.versionId), ['v1']);
});

test('initProject 兼容 B1 已建 project.json：补 versions/ 与指针，不破坏既有 attempts', (t) => {
  const userDataDir = h.userDataWith(t);
  // B1 流程：先 openWorkspace（会建只有 schemaVersion/projectId 的 project.json），再建 attempt。
  const attempt = createAttempt(userDataDir, 1, { kind: 'base' });
  assert.strictEqual(readState(userDataDir).currentVersionId, undefined, 'B1 阶段不应有版本指针');
  const applied = h.loadModule('transactions').applyChanges(attempt, [
    { op: 'write', path: 'notes/b1.txt', content: 'from b1\n' },
  ]);
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));

  const upgraded = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(upgraded.ok, true, '升级失败：' + JSON.stringify(upgraded));
  assert.strictEqual(upgraded.upgraded, true);
  assert.strictEqual(upgraded.migrated, false);
  assert.strictEqual(upgraded.state.currentVersionId, 'v1');
  assert.deepStrictEqual(h.entriesOf(path.join(workspaceDirOf(userDataDir), 'versions')), ['v1']);
  assert.strictEqual(readJson(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'version.json')).reason, 'import-base');

  // 升级幂等。
  const again = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.upgraded, false);
  assert.strictEqual(again.state.currentVersionId, 'v1');

  // 既有 attempt 仍可被采用为 v2。
  const adopted = versionsMod.adoptAttempt({ userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.versionId, 'v2');
});

test('adoptAttempt：候选树 → v2（parent=v1、diff/evidence/adoption、redo 清空、旧版本不变）', (t) => {
  const { userDataDir } = setup(t);
  const v1Before = hashTree(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'source'));
  const v1VersionBefore = fs.readFileSync(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'version.json'), 'utf8');

  const built = attemptWithChanges(userDataDir, 1, 'adopt1');
  const adopted = versionsMod.adoptAttempt({
    userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: 1,
  });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.versionId, 'v2');
  assert.strictEqual(adopted.previousVersionId, 'v1');
  assert.strictEqual(adopted.currentVersionId, 'v2');

  const state = readState(userDataDir);
  assert.strictEqual(state.currentVersionId, 'v2');
  assert.strictEqual(state.previousVersionId, 'v1');
  assert.strictEqual(state.redoVersionId, null);
  assert.deepStrictEqual(state.versions.map((item) => item.versionId), ['v1', 'v2']);
  assert.strictEqual(state.versions[0].isCurrent, false);
  assert.strictEqual(state.versions[1].isCurrent, true);
  assert.strictEqual(state.versions[1].treeDigest, built.digest);

  const versionDir = path.join(workspaceDirOf(userDataDir), 'versions', 'v2');
  const version = readJson(path.join(versionDir, 'version.json'));
  assert.strictEqual(version.parentVersionId, 'v1');
  assert.strictEqual(version.reason, 'agent-edit');
  assert.strictEqual(version.source.kind, 'agent-edit');
  assert.strictEqual(version.source.attempt.runId, RUN_ID);
  assert.strictEqual(version.source.attempt.turnId, TURN_ID);
  assert.strictEqual(version.source.attempt.attempt, 1);
  assert.strictEqual(version.adoption.projectId, PROJECT_ID);
  assert.strictEqual(version.adoption.runId, RUN_ID);
  assert.strictEqual(version.adoption.attempt, 1);
  assert.strictEqual(version.adoption.integrity, built.digest);
  assert.strictEqual(version.adoption.sourceKind, 'agent-edit', 'rev4 §2.6②：adoption.sourceKind=agent-edit');
  assert.strictEqual(version.diff.parentVersionId, 'v1');
  assert.strictEqual(version.diff.modified, 1);
  assert.strictEqual(version.diff.added, 1);
  assert.strictEqual(version.diff.deleted, 1);
  assert.ok(version.diff.unchanged > 0);
  assert.strictEqual(version.treeDigest, built.digest);
  assert.strictEqual(version.treeDigest, manifestMod.buildManifest(path.join(versionDir, 'source')).manifest.treeDigest);

  // v2 工作树就是 attempt 候选树（同源）。
  assert.deepStrictEqual(h.listRelativeFiles(path.join(versionDir, 'source')), h.listRelativeFiles(built.attempt.candidateDir));

  // 旧版本不可变。
  assert.deepStrictEqual(hashTree(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'source')), v1Before);
  assert.strictEqual(fs.readFileSync(path.join(workspaceDirOf(userDataDir), 'versions', 'v1', 'version.json'), 'utf8'), v1VersionBefore);

  // 再采用一次 → v3。
  const adopted3 = adopt(userDataDir, 2, 'adopt2');
  assert.strictEqual(adopted3.versionId, 'v3');
  assert.deepStrictEqual(readState(userDataDir).versions.map((item) => item.versionId), ['v1', 'v2', 'v3']);
});

test('adoptAttempt 失败原子：attempt 不存在/摘要不符时指针不变且无半套版本目录', (t) => {
  const { userDataDir } = setup(t);
  const beforeState = readState(userDataDir);
  const versionsDir = path.join(workspaceDirOf(userDataDir), 'versions');
  const beforeDirs = h.entriesOf(versionsDir);

  const missing = versionsMod.adoptAttempt({
    userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: 99,
  });
  h.assertFailure(missing, CODES.WORKSPACE_NOT_FOUND, '不存在的 attempt');
  assert.deepStrictEqual(readState(userDataDir), beforeState, '失败不得改指针');
  assert.deepStrictEqual(h.entriesOf(versionsDir), beforeDirs, '失败不得留半套版本目录');

  // 候选树被篡改（摘要漂移）→ 采用失败，不落版本。
  const built = attemptWithChanges(userDataDir, 1, 'tamper');
  fs.writeFileSync(path.join(built.attempt.candidateDir, 'app.json'), '{"pages":[]}');
  const tampered = versionsMod.adoptAttempt({
    userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: 1,
  });
  assert.strictEqual(tampered.ok, false, '篡改后应失败：' + JSON.stringify(tampered));
  assert.match(tampered.code, /^AGENT_/);
  assert.deepStrictEqual(readState(userDataDir), beforeState);
  assert.deepStrictEqual(h.entriesOf(versionsDir), beforeDirs);
});

test('undo/redo：只移指针、无父/无 redo/分叉明确失败、不产生新版本目录', (t) => {
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'u1'); // v2
  adopt(userDataDir, 2, 'u2'); // v3
  const versionsDir = path.join(workspaceDirOf(userDataDir), 'versions');
  const dirsBefore = h.entriesOf(versionsDir);
  assert.deepStrictEqual(dirsBefore, ['v1', 'v2', 'v3']);

  const undo1 = versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(undo1.ok, true, JSON.stringify(undo1));
  assert.strictEqual(undo1.currentVersionId, 'v2');
  assert.strictEqual(undo1.previousVersionId, 'v1');
  assert.strictEqual(undo1.redoVersionId, 'v3');
  assert.deepStrictEqual(h.entriesOf(versionsDir), dirsBefore, 'undo 不得新建版本目录');

  const redo1 = versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(redo1.ok, true, JSON.stringify(redo1));
  assert.strictEqual(redo1.currentVersionId, 'v3');
  assert.strictEqual(redo1.previousVersionId, 'v2');
  assert.strictEqual(redo1.redoVersionId, null);
  assert.deepStrictEqual(h.entriesOf(versionsDir), dirsBefore, 'redo 不得新建版本目录');

  h.assertFailure(versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID }), CODES.REDO_UNAVAILABLE, '无 redo');

  // 一路 undo 到 v1，再 undo → 无父。
  assert.strictEqual(versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID }).currentVersionId, 'v2');
  const toV1 = versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(toV1.currentVersionId, 'v1');
  assert.strictEqual(toV1.previousVersionId, null);
  h.assertFailure(versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID }), CODES.UNDO_UNAVAILABLE, '无父版本');

  // 分叉：当前 v1 再采用一次，得到 parent=v1 的 v4；此时 v1 有 v2、v4 两个子版本，
  // 把 redo 指回 v2 → redo 必须明确失败（VERSION_CONFLICT），不得自动合并。
  const forkedAdopt = adopt(userDataDir, 3, 'fork');
  assert.strictEqual(forkedAdopt.versionId, 'v4');
  const forked = readState(userDataDir);
  forked.currentVersionId = 'v1';
  forked.previousVersionId = null;
  forked.redoVersionId = 'v2';
  forked.versions = forked.versions.map((item) => ({ ...item, isCurrent: item.versionId === 'v1' }));
  fs.writeFileSync(projectFileOf(userDataDir), JSON.stringify(forked, null, 2) + '\n');
  h.assertFailure(versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID }), CODES.VERSION_CONFLICT, '分叉 redo');
  assert.strictEqual(readState(userDataDir).currentVersionId, 'v1', '失败不得移动指针');
});

test('reopen：摘要漂移/版本缺失 → AGENT_VERSION_CONFLICT(unavailable)，不回退 Base、幂等', (t) => {
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'reopen');
  const stateBefore = readState(userDataDir);
  const reopened = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.currentVersionId, 'v2');
  assert.strictEqual(reopened.available, true);
  assert.deepStrictEqual(reopened.versions.map((item) => item.versionId), ['v1', 'v2']);

  // 幂等：连续两次重开不写盘。
  const rawBefore = fs.readFileSync(projectFileOf(userDataDir), 'utf8');
  const again = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.strictEqual(fs.readFileSync(projectFileOf(userDataDir), 'utf8'), rawBefore);

  // 漂移：改一个字节。
  const sourceFile = path.join(workspaceDirOf(userDataDir), 'versions', 'v2', 'source', 'app.json');
  fs.writeFileSync(sourceFile, '{"pages":[]}');
  const drifted = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  h.assertFailure(drifted, CODES.VERSION_CONFLICT, '摘要漂移');
  assert.strictEqual(drifted.state.unavailable, true);
  assert.strictEqual(drifted.state.currentVersionId, 'v2');
  assert.strictEqual(readState(userDataDir).currentVersionId, 'v2', '不得回退 Base');
  assert.deepStrictEqual(readState(userDataDir), stateBefore, '重开失败不得改 project.json');

  // 版本目录缺失。
  fs.rmSync(path.join(workspaceDirOf(userDataDir), 'versions', 'v2'), { recursive: true, force: true });
  const missing = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  h.assertFailure(missing, CODES.VERSION_CONFLICT, '版本目录缺失');
  assert.strictEqual(missing.state.unavailable, true);
  assert.strictEqual(missing.state.reason, 'missing');
});

test('导出身份纯函数：同源 sourceRoot、指针/摘要/adoption 摘要校验、不写盘', (t) => {
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'export');
  const version = readJson(path.join(workspaceDirOf(userDataDir), 'versions', 'v2', 'version.json'));
  const sourceRoot = path.join(workspaceDirOf(userDataDir), 'versions', 'v2', 'source');
  const rawBefore = fs.readFileSync(projectFileOf(userDataDir), 'utf8');
  const treeBefore = hashTree(sourceRoot);

  const resolved = versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  assert.strictEqual(resolved.versionId, 'v2');
  assert.strictEqual(resolved.sourceRoot, sourceRoot);
  assert.strictEqual(resolved.treeDigest, version.treeDigest);
  assert.strictEqual(resolved.fileCount, version.source.files.count);

  const verified = versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(verified.ok, true, JSON.stringify(verified));
  assert.strictEqual(verified.sourceRoot, sourceRoot);
  assert.strictEqual(verified.treeDigest, version.treeDigest);
  assert.strictEqual(verified.base.templateId, 'ordering-base');

  const withOverlay = versionsMod.verifyExportIdentity({
    userDataDir, projectId: PROJECT_ID, overlayDigest: version.adoption.integrity,
  });
  assert.strictEqual(withOverlay.ok, true, JSON.stringify(withOverlay));
  assert.deepStrictEqual(treeBefore, hashTree(sourceRoot), '导出身份检查不得改源码树');
  h.assertFailure(
    versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID, overlayDigest: 'sha256:' + '1'.repeat(64) }),
    CODES.EXPORT_IDENTITY_MISMATCH,
    'overlay 摘要不一致',
  );

  // 指针漂移：previousVersionId 必须等于当前版本父版本。
  const tamperedPointer = readState(userDataDir);
  tamperedPointer.previousVersionId = 'v1';
  tamperedPointer.versions = tamperedPointer.versions.map((item) => (item.versionId === 'v2'
    ? { ...item, parentVersionId: 'v9' }
    : item));
  fs.writeFileSync(projectFileOf(userDataDir), JSON.stringify(tamperedPointer, null, 2) + '\n');
  h.assertFailure(versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID }), CODES.EXPORT_IDENTITY_MISMATCH, '指针漂移');
  fs.writeFileSync(projectFileOf(userDataDir), rawBefore);

  // 源码树漂移 → 导出身份不一致（不是回退 Base）。
  fs.writeFileSync(path.join(sourceRoot, 'app.json'), '{"pages":[]}');
  h.assertFailure(versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID }), CODES.EXPORT_IDENTITY_MISMATCH, '源码漂移');
  assert.strictEqual(fs.readFileSync(projectFileOf(userDataDir), 'utf8'), rawBefore, '导出身份检查不得写 project.json');

  // listVersions 只读。
  const listed = versionsMod.listVersions({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(listed.ok, true, JSON.stringify(listed));
  assert.strictEqual(listed.currentVersionId, 'v2');
  assert.deepStrictEqual(listed.versions.map((item) => item.versionId), ['v1', 'v2']);
});

test('F1 归属校验：伪造句柄指向 versions 树/project.json 时 files 与 transactions 全部拒绝且零落盘', (t) => {
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'forge-a'); // 产生 v2
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const real = workspaceMod.openAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(real.ok, true, JSON.stringify(real));

  const wsDir = workspaceDirOf(userDataDir);
  const versionDir = path.join(wsDir, 'versions', 'v2');
  const versionSource = path.join(versionDir, 'source');
  const legitAttemptDir = path.join(wsDir, 'runs', RUN_ID, 'turns', TURN_ID, 'attempts', 'attempt-1');
  const forged = [
    // 布局完全不像 attempt：attemptDir 直接指向版本目录。
    { ...real.attempt, attemptDir: versionDir, candidateDir: versionSource, attemptFile: path.join(versionDir, 'version.json') },
    // 布局像 attempt，但 candidateDir 指向版本 source（最危险的一种：能通过“字段是字符串”的旧校验）。
    { ...real.attempt, attemptDir: legitAttemptDir, candidateDir: versionSource, attemptFile: path.join(versionDir, 'version.json') },
    // candidateDir 指向 project.json。
    { ...real.attempt, attemptDir: legitAttemptDir, candidateDir: path.join(wsDir, 'project.json'), attemptFile: path.join(wsDir, 'project.json') },
  ];

  const before = hashTree(versionSource);
  const projectBefore = fs.readFileSync(path.join(wsDir, 'project.json'), 'utf8');
  const allowedCodes = [CODES.PATH_ESCAPE, CODES.WORKSPACE_INVALID, CODES.PATH_PROTECTED, CODES.PATH_LINK];
  for (const fake of forged) {
    const calls = [
      () => filesMod.writeFile(fake, { path: 'evil.txt', content: 'evil' }),
      () => filesMod.readFile(fake, { path: 'app.json' }),
      () => filesMod.listFiles(fake),
      () => transactionsMod.applyChanges(fake, [{ op: 'write', path: 'evil.txt', content: 'evil' }]),
      () => transactionsMod.beginChanges(fake, [{ op: 'delete', path: 'app.json' }]),
      () => transactionsMod.assertAttemptHandle(fake),
    ];
    for (const call of calls) {
      const result = call();
      assert.strictEqual(result.ok, false, '伪造句柄必须失败：' + JSON.stringify(result));
      assert.ok(allowedCodes.includes(result.code), '错误码必须是 PATH_ESCAPE/WORKSPACE_INVALID：' + result.code);
    }
  }
  assert.deepStrictEqual(hashTree(versionSource), before, '版本 source 树不得被伪造句柄改写');
  assert.strictEqual(fs.readFileSync(path.join(wsDir, 'project.json'), 'utf8'), projectBefore, 'project.json 不得被改写');
  assert.strictEqual(fs.existsSync(path.join(versionSource, 'evil.txt')), false);
});

test('F1 归属校验：伪造句柄指向仓库/异常布局被拒；正常 openAttempt 句柄行为不变', (t) => {
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'forge-b');
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  const real = workspaceMod.openAttempt(opened.workspace, { runId: RUN_ID, turnId: TURN_ID, attempt: 1 });
  assert.strictEqual(real.ok, true, JSON.stringify(real));

  const forgedRepo = {
    ...real.attempt,
    attemptDir: h.REPO,
    candidateDir: path.join(h.REPO, 'desktop'),
    attemptFile: path.join(h.REPO, 'package.json'),
  };
  const repoWrite = transactionsMod.applyChanges(forgedRepo, [{ op: 'write', path: 'evil.txt', content: 'evil' }]);
  assert.strictEqual(repoWrite.ok, false, JSON.stringify(repoWrite));
  assert.ok([CODES.PATH_ESCAPE, CODES.WORKSPACE_INVALID, CODES.PATH_PROTECTED].includes(repoWrite.code), repoWrite.code);
  assert.strictEqual(fs.existsSync(path.join(h.REPO, 'desktop', 'evil.txt')), false);

  // 正常句柄不受影响：写、读、事务都照旧。
  const write = filesMod.writeFile(real.attempt, { path: 'notes/ownership-ok.txt', content: 'ok' });
  assert.strictEqual(write.ok, true, JSON.stringify(write));
  assert.strictEqual(filesMod.readFile(real.attempt, { path: 'notes/ownership-ok.txt' }).content, 'ok');
  const txn = transactionsMod.applyChanges(real.attempt, [{ op: 'write', path: 'notes/ownership-txn.txt', content: 'txn' }]);
  assert.strictEqual(txn.ok, true, JSON.stringify(txn));
  assert.strictEqual(workspaceMod.assertOwnership(real.attempt, path.join(real.attempt.candidateDir, 'app.json')).ok, true);
});

test('F2 adoption.sourceKind：agent-edit 与 legacy-migration 两类版本可区分（rev4 §2.6②）', (t) => {
  // ① agent-edit：adoptAttempt 产生的版本。
  const agent = setup(t);
  const adopted = adopt(agent.userDataDir, 1, 'srckind');
  assert.strictEqual(adopted.version.adoption.sourceKind, 'agent-edit');
  const agentVersion = readJson(path.join(workspaceDirOf(agent.userDataDir), 'versions', 'v2', 'version.json'));
  assert.strictEqual(agentVersion.adoption.sourceKind, 'agent-edit');
  assert.strictEqual(agentVersion.source.kind, 'agent-edit');

  // ② legacy-migration：旧 frontendCandidate 迁移产生的 v2。
  const userDataDir = h.userDataWith(t);
  buildLegacyAdopted(userDataDir);
  const migrated = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(migrated.ok, true, '迁移失败：' + JSON.stringify(migrated));
  assert.strictEqual(migrated.migrated, true);
  const legacyVersion = readJson(path.join(workspaceDirOf(userDataDir), 'versions', 'v2', 'version.json'));
  assert.strictEqual(legacyVersion.reason, 'import-adopted');
  assert.strictEqual(legacyVersion.source.kind, 'import-adopted');
  assert.strictEqual(legacyVersion.adoption.sourceKind, 'legacy-migration');
});

test('正式仓库零写入：Base→v1→v2→undo→redo→reopen→导出身份全流程前后指纹不变', (t) => {
  const watchDirs = ['templates', 'miniprogram', 'src', 'desktop', 'scripts', 'contracts'];
  const before = h.repoFingerprint(watchDirs);
  const { userDataDir } = setup(t);
  adopt(userDataDir, 1, 'flow');
  versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
  versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID });
  versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID });
  versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(h.repoFingerprint(watchDirs), before, '正式仓库目录必须零写入');
  // 所有产物都在 userData 私有根内。
  for (const entry of h.listRelativeFiles(userDataDir)) {
    const abs = path.join(userDataDir, ...entry.path.split('/'));
    assert.ok(abs.toLowerCase().startsWith(userDataDir.toLowerCase()), '越出私有根：' + abs);
  }
});

test('未知项目/非法 projectId：只读接口 fail closed 且不创建任何目录', (t) => {
  const userDataDir = h.userDataWith(t);
  h.assertFailure(versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID }), CODES.WORKSPACE_NOT_FOUND, '未初始化');
  h.assertFailure(versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID }), CODES.WORKSPACE_NOT_FOUND, '未初始化');
  h.assertFailure(versionsMod.listVersions({ userDataDir, projectId: '../evil' }), CODES.PROJECT_ID_INVALID, '非法 projectId');
  const repoRoot = h.REPO;
  const repoResult = versionsMod.initProject({ userDataDir: repoRoot, projectId: PROJECT_ID });
  h.assertFailure(repoResult, CODES.PATH_PROTECTED, '仓库内根');
  h.assertNoPathLeak(repoResult, [repoRoot]);
});
