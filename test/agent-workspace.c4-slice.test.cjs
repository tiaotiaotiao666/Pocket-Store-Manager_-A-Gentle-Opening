'use strict';

/**
 * C4：人工 menu + product-card 垂直切片。
 *
 * 全链（不接模型、不生成图片）：
 *   人工 fixture → B1 attempt 事务写入 → B2 adoptAttempt(v2) → 版本 source
 *   → C3 frontend-source-bundle overlay → Composer 导出 → 静态/安全/组件检查
 *   → inspectOutput / runChecks / C1 page-contract / C2 source-check
 *   → undo/redo/reopen/verifyExportIdentity → 重复导出确定性 → 缺 overlay/漂移失败。
 *
 * 所有写入都在 os.tmpdir() 的临时 userData / parentDir；正式 templates/miniprogram 零写入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const h = require('./agent-workspace.helpers.cjs');

const REPO = h.REPO;
const PROJECT_ID = 'p_c4slice01';
const RUN_ID = 'frun-c4-slice-001';
const TURN_ID = 'fturn-c4-slice-001';
const ATTEMPT = 1;
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'workspace-agent', 'c4-manual-slice');
const BASE_SRC = h.BASE_SOURCE_DIR;
const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

const workspaceMod = h.loadModule('workspace');
const transactionsMod = h.loadModule('transactions');
const versionsMod = h.loadModule('versions');
const composer = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { inspectOutput } = require(path.join(REPO, 'desktop', 'output-consistency.cjs'));
const { runChecks: runMiniChecks } = require(path.join(REPO, 'scripts', 'validate-miniprogram.cjs'));
const { checkProject, loadFacts } = require(path.join(REPO, 'scripts', 'frontend-source', 'check.cjs'));
const sourceFacts = require(path.join(REPO, 'scripts', 'agent-source-facts.cjs'));

const OVERLAY_FILES = [
  'pages/menu/index.wxml',
  'pages/menu/index.wxss',
  'components/product-card/index.wxml',
  'components/product-card/index.wxss',
];

function sha256File(file) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listSourceFiles(root, options) {
  const opts = options || {};
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(js|json|wxml|wxss)$/.test(relative)) {
        if (opts.skip && opts.skip.includes(relative)) continue;
        out.push({ path: relative, content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function setup(t) {
  const userDataDir = h.userDataWith(t, 'c4');
  const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, 'initProject 失败：' + JSON.stringify(init));
  return { userDataDir, init };
}

function createAttemptWithFixture(userDataDir) {
  const opened = workspaceMod.openWorkspace({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(opened.ok, true, JSON.stringify(opened));
  const created = workspaceMod.createAttempt(opened.workspace, {
    runId: RUN_ID,
    turnId: TURN_ID,
    attempt: ATTEMPT,
    source: { kind: 'version', versionId: 'v1' },
  });
  assert.strictEqual(created.ok, true, 'createAttempt 失败：' + JSON.stringify(created));

  const writes = [];
  for (const relative of OVERLAY_FILES) {
    writes.push({ op: 'write', path: relative, content: fs.readFileSync(path.join(FIXTURE, relative), 'utf8') });
  }
  writes.push({ op: 'write', path: 'source-bundle.json', content: fs.readFileSync(path.join(FIXTURE, 'source-bundle.json'), 'utf8') });
  const applied = transactionsMod.applyChanges(created.attempt, writes);
  assert.strictEqual(applied.ok, true, 'applyChanges 失败：' + JSON.stringify(applied));
  return { attempt: created.attempt, writes, treeDigest: applied.treeDigest };
}

function outputOf(parent) {
  return path.join(parent, 'demo-store');
}

test('C4 人工切片：B1 attempt → B2 版本 → C3 overlay 导出，页面/组件逐字节一致且检查通过', async (t) => {
  const { userDataDir } = setup(t);
  const attemptBuild = createAttemptWithFixture(userDataDir);

  const adopted = versionsMod.adoptAttempt({
    userDataDir, projectId: PROJECT_ID, runId: RUN_ID, turnId: TURN_ID, attempt: ATTEMPT,
  });
  assert.strictEqual(adopted.ok, true, 'adoptAttempt 失败：' + JSON.stringify(adopted));
  assert.strictEqual(adopted.currentVersionId, 'v2');
  assert.strictEqual(adopted.version.adoption.sourceKind, 'agent-edit');
  const versionId = adopted.currentVersionId;
  const versionTreeDigest = adopted.treeDigest;

  const resolved = versionsMod.resolveVersionSource({ userDataDir, projectId: PROJECT_ID, versionId });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  assert.strictEqual(resolved.versionId, versionId);
  assert.strictEqual(resolved.treeDigest, versionTreeDigest);
  const versionSource = resolved.sourceRoot;
  assert.ok(fs.existsSync(path.join(versionSource, 'source-bundle.json')), '版本 source 必须保留 overlay manifest');
  for (const relative of OVERLAY_FILES) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(versionSource, relative)),
      fs.readFileSync(path.join(FIXTURE, relative)),
      relative + ' 版本 source 与 fixture 不一致',
    );
  }

  const parentDir = h.tempDir('c4-export');
  const exported = await composer.compose({
    plan: PLAN,
    parentDir,
    projectName: 'demo-store',
    mode: 'development',
    generatedAt: '2026-11-24T00:00:00Z',
    sourceOverlay: versionSource,
  });
  assert.strictEqual(exported.ok, true, 'compose 失败：' + JSON.stringify(exported));
  const out = outputOf(parentDir);
  assert.strictEqual(exported.sourceOverlay.digest.startsWith('sha256:'), true);

  // 1) 页面与 page-scoped 变体逐字节等于人工源树。
  for (const relative of ['pages/menu/index.wxml', 'pages/menu/index.wxss']) {
    assert.deepStrictEqual(fs.readFileSync(path.join(out, relative)), fs.readFileSync(path.join(FIXTURE, relative)), relative);
  }
  const variantDir = path.join(out, 'components', 'product-card--menu');
  for (const name of ['index.wxml', 'index.wxss', 'index.js', 'index.json']) {
    assert.ok(fs.existsSync(path.join(variantDir, name)), '缺少变体文件 ' + name);
  }
  assert.deepStrictEqual(fs.readFileSync(path.join(variantDir, 'index.wxml')), fs.readFileSync(path.join(FIXTURE, 'components/product-card/index.wxml')));
  assert.deepStrictEqual(fs.readFileSync(path.join(variantDir, 'index.wxss')), fs.readFileSync(path.join(FIXTURE, 'components/product-card/index.wxss')));
  const menuJson = JSON.parse(fs.readFileSync(path.join(out, 'pages/menu/index.json'), 'utf8'));
  assert.strictEqual(menuJson.usingComponents['product-card'], '/components/product-card--menu/index');
  const baseHomeJson = JSON.parse(fs.readFileSync(path.join(out, 'pages/home/index.json'), 'utf8'));
  if (baseHomeJson.usingComponents['product-card']) {
    assert.strictEqual(baseHomeJson.usingComponents['product-card'], '/components/product-card/index');
  }

  // 2) source-changes：menu.* modified、product-card 变体 added（page scope 不污染共享 Base）。
  const changes = JSON.parse(fs.readFileSync(path.join(out, 'source-changes.json'), 'utf8'));
  const entry = (relative) => changes.files.find((item) => item.path === relative);
  assert.strictEqual(entry('pages/menu/index.wxml').status, 'modified');
  assert.strictEqual(entry('pages/menu/index.wxml').sha256, sha256File(path.join(FIXTURE, 'pages/menu/index.wxml')));
  assert.strictEqual(entry('pages/menu/index.wxss').status, 'modified');
  assert.strictEqual(entry('pages/menu/index.wxss').sha256, sha256File(path.join(FIXTURE, 'pages/menu/index.wxss')));
  assert.strictEqual(entry('components/product-card--menu/index.wxml').status, 'added');
  assert.strictEqual(entry('components/product-card--menu/index.wxml').sha256, sha256File(path.join(FIXTURE, 'components/product-card/index.wxml')));
  assert.strictEqual(entry('components/product-card--menu/index.wxss').status, 'added');
  assert.strictEqual(entry('components/product-card/index.wxml'), undefined, 'page-scoped 不得改写共享 Base 组件');
  assert.strictEqual(changes.overlay.components.find((item) => item.componentId === 'product-card').scope, 'page');
  assert.deepStrictEqual(changes.overlay.components.find((item) => item.componentId === 'product-card').pages, ['menu']);

  // 3) 产物检查：composer 内部 verify 已跑；inspectOutput / runChecks（mini:check 同实现）通过。
  const consistency = inspectOutput(out);
  assert.strictEqual(consistency.ok, true, JSON.stringify(consistency.problems.slice(0, 5)));
  const mini = runMiniChecks(out);
  assert.strictEqual(mini.ok, true, JSON.stringify((mini.errors || []).slice(0, 5)));

  // 4) C2 source-check：对修改后的版本 source 无新增 issue；C1 page-contract 保留。
  const facts = loadFacts();
  const baseFiles = listSourceFiles(BASE_SRC);
  const baseBaseline = Object.fromEntries(baseFiles.map((item) => [item.path, item.content]));
  const baseResult = checkProject({ files: baseFiles, facts, contracts: {}, baseline: baseBaseline });
  const sourceFiles = listSourceFiles(versionSource, { skip: ['source-bundle.json'] });
  const changedResult = checkProject({ files: sourceFiles, facts, contracts: {}, baseline: baseBaseline });
  const issueKey = (issue) => issue.file + '|' + issue.code + '|' + issue.message;
  const baseKeys = new Set(baseResult.issues.map(issueKey));
  const newIssues = changedResult.issues.filter((issue) => !baseKeys.has(issueKey(issue)));
  assert.deepStrictEqual(newIssues, [], '修改后的 menu/product-card 不得新增 source-check issue');
  const contract = sourceFacts.PAGE_CONTRACTS.menu;
  const menuJs = fs.readFileSync(path.join(versionSource, 'pages/menu/index.js'), 'utf8');
  const menuWxml = fs.readFileSync(path.join(versionSource, 'pages/menu/index.wxml'), 'utf8');
  for (const handler of contract.requiredHandlers) {
    assert.ok(new RegExp('(^|[^A-Za-z0-9_$])' + handler + '\\s*\\(').test(menuJs), 'page-contract 缺少 handler：' + handler);
  }
  for (const event of contract.requiredComponentEvents) {
    assert.ok(menuWxml.includes('bind:' + event.event + '="' + event.handler + '"'), 'page-contract 缺少事件：' + event.event);
  }
  assert.strictEqual(sourceFacts.checkSnapshot().ok, true, 'C1 SourceFacts 快照必须与真源一致');

  // 5) 版本链：undo → redo → reopen 后 current/treeDigest 不变；导出身份一致。
  const undone = versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(undone.ok, true, JSON.stringify(undone));
  assert.strictEqual(undone.currentVersionId, 'v1');
  const redone = versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(redone.ok, true, JSON.stringify(redone));
  assert.strictEqual(redone.currentVersionId, versionId);
  const reopened = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.currentVersionId, versionId);
  assert.strictEqual(reopened.treeDigest, versionTreeDigest);
  const identity = versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(identity.ok, true, JSON.stringify(identity));
  assert.strictEqual(identity.treeDigest, versionTreeDigest);

  // 6) 重复导出确定性（同一版本 source + 固定 generatedAt）。
  const parentDirB = h.tempDir('c4-export-b');
  const exportedB = await composer.compose({
    plan: PLAN,
    parentDir: parentDirB,
    projectName: 'demo-store',
    mode: 'development',
    generatedAt: '2026-11-25T00:00:00Z',
    sourceOverlay: versionSource,
  });
  assert.strictEqual(exportedB.ok, true, JSON.stringify(exportedB));
  assert.strictEqual(exported.treeSha256, exportedB.treeSha256);
  assert.strictEqual(exported.lockDigest, exportedB.lockDigest);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(out, 'source-changes.json')),
    fs.readFileSync(path.join(outputOf(parentDirB), 'source-changes.json')),
  );

  // 7) 缺 overlay / 漂移：明确失败，绝不静默回退 Base。
  const missingParent = h.tempDir('c4-missing');
  const missing = await composer.compose({
    plan: PLAN, parentDir: missingParent, projectName: 'demo-store', mode: 'development',
    sourceOverlay: path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'versions', 'v2', 'no-such-overlay'),
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'SOURCE_OVERLAY_MISSING');
  assert.ok(!fs.existsSync(outputOf(missingParent)), '缺 overlay 不得回退 Base 导出');

  // 漂移：篡改版本 source 后 manifest sha 不再匹配；导出与身份校验都必须失败。
  fs.appendFileSync(path.join(versionSource, 'pages/menu/index.wxml'), '\n<!-- drift -->\n');
  const driftParent = h.tempDir('c4-drift');
  const drifted = await composer.compose({
    plan: PLAN, parentDir: driftParent, projectName: 'demo-store', mode: 'development', sourceOverlay: versionSource,
  });
  assert.strictEqual(drifted.ok, false);
  assert.strictEqual(drifted.code, 'SOURCE_BUNDLE_FILE_HASH_MISMATCH');
  assert.ok(!fs.existsSync(outputOf(driftParent)), '漂移不得回退 Base 导出');
  const driftIdentity = versionsMod.verifyExportIdentity({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(driftIdentity.ok, false);
  assert.ok(
    ['AGENT_VERSION_CONFLICT', 'AGENT_EXPORT_IDENTITY_MISMATCH'].includes(driftIdentity.code),
    '漂移身份校验必须明确失败：' + JSON.stringify(driftIdentity),
  );

  // attempt 候选树仍保留 B1 事务结果（adopt 不移动/改写在途候选）。
  assert.ok(fs.existsSync(attemptBuild.attempt.candidateDir));
  assert.ok(attemptBuild.treeDigest.startsWith('sha256:'));
});
