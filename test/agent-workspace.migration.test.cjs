'use strict';

/**
 * B2：旧 frontendCandidate 一次性迁移（冻结 §2.3）。
 *
 * 覆盖：adopted 快照 → v1(import-base)+v2(import-adopted)+migration.json；幂等；
 * 迁移失败整体回滚且旧项目仍可打开；frontend-runs 只读；迁移后导出身份同源。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const PROJECT_ID = 'p_b2migrate';
const RUN_ID = 'frun-b2-migrate';

const versionsMod = h.loadModule('versions');
const CODES = versionsMod.CODES;
const materialize = require(path.join(h.REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));

function draftFixture() {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: 'B2 迁移候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          { type: 'component', componentId: 'store-header', props: { storeName: { kind: 'data', dataPath: 'store.name' } }, events: {} },
          { type: 'slot', slotId: 'home-hero' },
          { type: 'text', textToken: 'store.address', style: { size: 'md', colorToken: 'textColor' } },
          { type: 'button', label: '开始点餐', action: 'home.goMenu' },
        ],
        styles: [],
        pageJson: { navigationBarTitleText: '扫码点餐' },
      },
    ],
  };
}

function projectPaths(userDataDir) {
  const projectDir = path.join(userDataDir, 'projects', PROJECT_ID);
  const workspaceDir = path.join(projectDir, 'agent-workspace');
  return {
    projectDir,
    workspaceDir,
    legacySnapshotFile: path.join(projectDir, 'project.json'),
    projectFile: path.join(workspaceDir, 'project.json'),
    versionsDir: path.join(workspaceDir, 'versions'),
    migrationFile: path.join(workspaceDir, 'migration.json'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hashTree(dir) {
  const map = {};
  for (const entry of h.listRelativeFiles(dir)) {
    map[entry.path] = 'sha256:' + h.sha256OfFile(path.join(dir, ...entry.path.split('/')));
  }
  return map;
}

/** 造一个真实合法的旧链 adopted 项目：materializeCandidate + adopted.json + 旧 project.json。 */
function buildLegacyAdopted(t, userDataDir, options) {
  const opts = options || {};
  const materialized = materialize.materializeCandidate({
    userDataDir,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    draft: draftFixture(),
  });
  assert.strictEqual(materialized.ok, true, 'materializeCandidate 失败：' + JSON.stringify(materialized));
  const attemptRelative = 'projects/' + PROJECT_ID + '/frontend-runs/' + RUN_ID + '/attempts/attempt-' + materialized.attempt;
  const overlayRelative = attemptRelative + '/overlay';
  const adoptedRecord = {
    schemaVersion: 'frontend-adoption.v1',
    status: 'adopted',
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attempt: materialized.attempt,
    candidateId: materialized.candidate.id,
    candidateVersion: materialized.candidate.version,
    integrity: materialized.candidate.integrity,
    staticGates: 'pass',
    runtimeStatus: 'NOT_RUN',
    partialConfirmed: true,
    evidence: { dirName: 'runtime', generatedAt: '2026-11-24T00:00:00.000Z' },
    adoptedAt: '2026-11-24T00:00:00.000Z',
    overlayRelative,
  };
  fs.writeFileSync(path.join(materialized.attemptDir, 'adopted.json'), JSON.stringify(adoptedRecord, null, 2));

  const paths = projectPaths(userDataDir);
  fs.mkdirSync(paths.projectDir, { recursive: true });
  const legacySnapshot = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    name: 'B2 迁移项目',
    phase: 'home',
    frontendCandidate: {
      status: opts.status || 'adopted',
      projectId: PROJECT_ID,
      runId: RUN_ID,
      attempt: materialized.attempt,
      candidateId: materialized.candidate.id,
      candidateVersion: materialized.candidate.version,
      integrity: materialized.candidate.integrity,
      overlayRelative,
      adoptedAt: '2026-11-24T00:00:00.000Z',
      verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0 },
      previous: null,
      verified: true,
    },
  };
  fs.writeFileSync(paths.legacySnapshotFile, JSON.stringify(legacySnapshot, null, 2) + '\n');
  return { paths, materialized, adoptedRecord, legacySnapshot, attemptRelative, overlayRelative };
}

test('迁移成功：v1=import-base、v2=import-adopted、migration.json 与指针严格按 §2.3', (t) => {
  const userDataDir = h.userDataWith(t);
  const fixture = buildLegacyAdopted(t, userDataDir);
  const { paths } = fixture;
  const legacyBefore = fs.readFileSync(paths.legacySnapshotFile, 'utf8');
  const frontendRunsBefore = hashTree(path.join(paths.projectDir, 'frontend-runs'));

  const migrated = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(migrated.ok, true, '迁移失败：' + JSON.stringify(migrated));
  assert.strictEqual(migrated.created, true);
  assert.strictEqual(migrated.migrated, true);

  const state = readJson(paths.projectFile);
  assert.strictEqual(state.currentVersionId, 'v2');
  assert.strictEqual(state.previousVersionId, 'v1');
  assert.strictEqual(state.redoVersionId, null);
  assert.deepStrictEqual(state.versions.map((item) => item.versionId), ['v1', 'v2']);
  assert.strictEqual(state.versions[0].reason, 'import-base');
  assert.strictEqual(state.versions[1].reason, 'import-adopted');
  assert.strictEqual(state.versions[0].isCurrent, false);
  assert.strictEqual(state.versions[1].isCurrent, true);
  assert.ok(state.migratedFrom && state.migratedFrom.migrationId, JSON.stringify(state.migratedFrom));

  const v1 = readJson(path.join(paths.versionsDir, 'v1', 'version.json'));
  assert.strictEqual(v1.source.kind, 'base-copy');
  assert.strictEqual(v1.parentVersionId, null);
  const v2 = readJson(path.join(paths.versionsDir, 'v2', 'version.json'));
  assert.strictEqual(v2.parentVersionId, 'v1');
  assert.strictEqual(v2.source.kind, 'import-adopted');
  assert.strictEqual(v2.source.attempt.runId, RUN_ID);
  assert.strictEqual(v2.source.attempt.attempt, fixture.materialized.attempt);
  assert.strictEqual(v2.adoption.projectId, PROJECT_ID);
  assert.strictEqual(v2.adoption.runId, RUN_ID);
  assert.strictEqual(v2.adoption.attempt, fixture.materialized.attempt);
  assert.strictEqual(v2.adoption.candidateId, fixture.materialized.candidate.id);
  assert.strictEqual(v2.adoption.candidateVersion, fixture.materialized.candidate.version);
  assert.strictEqual(v2.adoption.integrity, fixture.materialized.candidate.integrity);
  assert.strictEqual(v2.adoption.registryDigest, fixture.materialized.overlay.registryDigest);
  assert.strictEqual(v2.diff.parentVersionId, 'v1');
  assert.ok(v2.diff.modified > 0, '导入的候选应与 Base 有差异：' + JSON.stringify(v2.diff));

  // v2 source 就是旧链候选的 candidate/src（同源复制）。
  assert.deepStrictEqual(
    hashTree(path.join(paths.versionsDir, 'v2', 'source')),
    hashTree(path.join(fixture.materialized.attemptDir, 'candidate', 'src')),
  );

  const migration = readJson(paths.migrationFile);
  assert.strictEqual(migration.schemaVersion, 'agent-migration.v1');
  assert.strictEqual(migration.migrations.length, 1);
  const record = migration.migrations[0];
  assert.ok(typeof record.migrationId === 'string' && record.migrationId.length > 0);
  assert.deepStrictEqual(record.createdVersions, ['v1', 'v2']);
  assert.strictEqual(record.from.frontendCandidate.candidateId, fixture.materialized.candidate.id);
  assert.strictEqual(record.from.frontendCandidate.runId, RUN_ID);
  assert.strictEqual(record.from.frontendCandidate.attempt, fixture.materialized.attempt);
  assert.strictEqual(record.from.frontendCandidate.adoptedAt, '2026-11-24T00:00:00.000Z');

  // 旧项目快照不被改写；frontend-runs 只读（本测试自身 fixture 的 adopted.json 除外）。
  assert.strictEqual(fs.readFileSync(paths.legacySnapshotFile, 'utf8'), legacyBefore);
  assert.deepStrictEqual(hashTree(path.join(paths.projectDir, 'frontend-runs')), frontendRunsBefore);
  assert.ok(hashTree(paths.projectDir)['project.json']);

  // 重复调用幂等：不新建版本、不追加 migration。
  const again = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.migrated, false);
  assert.deepStrictEqual(h.entriesOf(paths.versionsDir), ['v1', 'v2']);
  assert.strictEqual(readJson(paths.migrationFile).migrations.length, 1);
  assert.strictEqual(readJson(paths.projectFile).currentVersionId, 'v2');
});

test('迁移后导出身份：overlay/Registry 摘要一致才通过，不一致 AGENT_EXPORT_IDENTITY_MISMATCH', (t) => {
  const userDataDir = h.userDataWith(t);
  const fixture = buildLegacyAdopted(t, userDataDir);
  const migrated = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(migrated.ok, true, JSON.stringify(migrated));

  const ok = versionsMod.verifyExportIdentity({
    userDataDir,
    projectId: PROJECT_ID,
    overlayDigest: fixture.materialized.candidate.integrity,
    registryDigest: fixture.materialized.overlay.registryDigest,
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.sourceRoot, path.join(fixture.paths.versionsDir, 'v2', 'source'));
  assert.strictEqual(ok.versionId, 'v2');

  h.assertFailure(versionsMod.verifyExportIdentity({
    userDataDir, projectId: PROJECT_ID, overlayDigest: 'sha256:' + '2'.repeat(64),
  }), CODES.EXPORT_IDENTITY_MISMATCH, 'overlay 摘要不一致');
  h.assertFailure(versionsMod.verifyExportIdentity({
    userDataDir, projectId: PROJECT_ID, registryDigest: 'sha256:' + '3'.repeat(64),
  }), CODES.EXPORT_IDENTITY_MISMATCH, 'Registry 摘要不一致');

  const resolved = versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  assert.strictEqual(resolved.sourceRoot, path.join(fixture.paths.versionsDir, 'v2', 'source'));

  // reopen 校验通过且不回退 Base。
  const reopened = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.currentVersionId, 'v2');
});

test('迁移失败整体回滚：旧项目仍可打开、无半套 agent-workspace；无 adopted 时只建 v1', (t) => {
  const userDataDir = h.userDataWith(t);
  const fixture = buildLegacyAdopted(t, userDataDir);
  // 破坏 overlay：迁移必须整体失败。
  fs.rmSync(path.join(fixture.materialized.attemptDir, 'overlay'), { recursive: true, force: true });
  const legacyBefore = fs.readFileSync(fixture.paths.legacySnapshotFile, 'utf8');

  const failed = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  h.assertFailure(failed, CODES.MIGRATION_FAILED, 'overlay 缺失');
  assert.strictEqual(fs.existsSync(fixture.paths.workspaceDir), false, '迁移失败不得留下半套 agent-workspace');
  assert.strictEqual(fs.readFileSync(fixture.paths.legacySnapshotFile, 'utf8'), legacyBefore, '旧项目不得被改写');
  assert.strictEqual(readJson(fixture.paths.legacySnapshotFile).frontendCandidate.candidateId, fixture.materialized.candidate.id);

  // 旧项目改为“未采用”后，再次初始化只建立 Base v1（不读迁移）。
  const legacy = readJson(fixture.paths.legacySnapshotFile);
  legacy.frontendCandidate = { status: 'none' };
  fs.writeFileSync(fixture.paths.legacySnapshotFile, JSON.stringify(legacy, null, 2) + '\n');
  const fresh = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(fresh.ok, true, JSON.stringify(fresh));
  assert.strictEqual(fresh.migrated, false);
  assert.deepStrictEqual(h.entriesOf(fixture.paths.versionsDir), ['v1']);
  const state = readJson(fixture.paths.projectFile);
  assert.strictEqual(state.currentVersionId, 'v1');
  assert.deepStrictEqual(state.versions.map((item) => item.reason), ['import-base']);

  // 未采纳旧项目：只建 v1，不生成 migration.json。
  const userDataDir2 = h.userDataWith(t);
  const fixture2 = buildLegacyAdopted(t, userDataDir2, { status: 'none' });
  const init2 = versionsMod.initProject({ userDataDir: userDataDir2, projectId: PROJECT_ID });
  assert.strictEqual(init2.ok, true, JSON.stringify(init2));
  assert.strictEqual(init2.migrated, false);
  assert.strictEqual(fs.existsSync(fixture2.paths.migrationFile), false);
  assert.strictEqual(readJson(fixture2.paths.projectFile).currentVersionId, 'v1');
});
