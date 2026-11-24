'use strict';

/**
 * C3：Composer 私有 workspace/source overlay（frontend-source-bundle.v1）。
 *
 * 覆盖：页面/组件最终文件直接覆盖（无 WXML 替换/WXSS 追加/styleMode）、page-scoped 变体、
 * shared 受影响页面、新增组件四件套/页面 JS/本地资产、usingComponents 重算、插槽缺失阻断、
 * source-changes.json 摘要与确定性、dry-run/export 同源、entry.assets 修复、正式 templates 零写入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const composer = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const emit = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { treeSha256, listTree, fileSha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const { validatePlan } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
const { inspectOutput } = require(path.join(REPO, 'desktop', 'output-consistency.cjs'));
const { runChecks: runMiniChecks } = require(path.join(REPO, 'scripts', 'validate-miniprogram.cjs'));

const BASE_SRC = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const BASE_TREE = treeSha256(BASE_SRC);
const CLASSIC = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));
const POSTER = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-poster', '1.0.0', 'plan.json'), 'utf8'));
const WARM = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json'), 'utf8'));

function sha(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'c3-' + prefix + '-'));
}

/** 递归复制（不用 fs.cpSync：Node 24 Windows 在本机对深树会触发栈溢出）。 */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function readBase(relative) {
  return fs.readFileSync(path.join(BASE_SRC, relative));
}

function writeOverlayFile(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { path: relative, sha256: sha(fs.readFileSync(target)) };
}

function buildGraph(plan) {
  const loaded = loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.errors));
  const graph = resolvePlan(plan, loaded);
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  return graph;
}

/**
 * 构造一个基于 Base 的 overlay（整树复制后改文件），manifest 只列变更/新增文件。
 */
function makeOverlay(options) {
  const opts = options || {};
  const root = tempDir(opts.prefix || 'overlay');
  copyTree(BASE_SRC, root);
  const files = [];
  const components = [
    { componentId: 'product-card', scope: 'page', pages: ['menu'] },
    { componentId: 'store-header', scope: 'shared' },
    { componentId: 'c3-badge', scope: 'shared' },
  ];
  const deleted = [];

  // 页面：最终完整文件直接覆盖（WXSS 不再追加 marker）。
  if (opts.page !== false) {
    const menuWxml = readBase('pages/menu/index.wxml').toString('utf8')
      + '\n<!-- c3-overlay:menu -->\n<c3-badge text="C3 徽标" />\n';
    files.push(writeOverlayFile(root, 'pages/menu/index.wxml', menuWxml));
    files.push(writeOverlayFile(root, 'pages/menu/index.wxss', readBase('pages/menu/index.wxss').toString('utf8') + '\n.c3-menu { color: #A84312; }\n'));
    files.push(writeOverlayFile(root, 'pages/menu/index.js', readBase('pages/menu/index.js').toString('utf8') + '\n// c3 overlay page js\n'));
  }

  // 页面内组件：product-card 只影响 menu（page-scoped 变体）。
  files.push(writeOverlayFile(root, 'components/product-card/index.wxml', readBase('components/product-card/index.wxml').toString('utf8') + '\n<!-- c3 product-card -->\n'));
  files.push(writeOverlayFile(root, 'components/product-card/index.wxss', readBase('components/product-card/index.wxss').toString('utf8') + '\n.c3-product-card { border-radius: 24rpx; }\n'));

  // shared 组件：store-header 影响所有使用页面。
  files.push(writeOverlayFile(root, 'components/store-header/index.wxml', readBase('components/store-header/index.wxml').toString('utf8') + '\n<!-- c3 shared header -->\n'));

  // 新增共享组件四件套。
  files.push(writeOverlayFile(root, 'components/c3-badge/index.js', 'Component({\n  properties: { text: { type: String, value: \'\' } },\n});\n'));
  files.push(writeOverlayFile(root, 'components/c3-badge/index.json', JSON.stringify({ component: true }, null, 2) + '\n'));
  files.push(writeOverlayFile(root, 'components/c3-badge/index.wxml', '<view class="c3-badge">{{text}}</view>\n'));
  files.push(writeOverlayFile(root, 'components/c3-badge/index.wxss', '.c3-badge { padding: 8rpx 16rpx; }\n'));

  // 本地资产：真实 PNG 魔数；删除一个 Base 资产用于 deleted 分支。
  const image = readBase('assets/tabbar/home.png');
  files.push(writeOverlayFile(root, 'assets/frontend-source/menu-hero.png', image));
  deleted.push('assets/tabbar/home.png');

  if (opts.extraFiles) {
    for (const [relative, content] of opts.extraFiles) {
      const entry = writeOverlayFile(root, relative, content);
      const existing = files.findIndex((item) => item.path === entry.path);
      if (existing >= 0) files[existing] = entry;
      else files.push(entry);
    }
  }

  const manifest = {
    schemaVersion: 'frontend-source-bundle.v1',
    base: { id: 'ordering-base', version: '1.0.0', treeSha256: BASE_TREE },
    targetPages: ['menu'],
    files,
    deleted,
    components,
    assets: ['assets/frontend-source/menu-hero.png'],
    ...(opts.manifest || {}),
  };
  fs.writeFileSync(path.join(root, 'source-bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { root, manifest };
}

function outputOf(parent) {
  return path.join(parent, 'demo-store');
}

function snapshotTemplates() {
  return treeSha256(path.join(REPO, 'templates'));
}

test('C3 overlay：页面/组件最终文件字节覆盖、page-scoped 变体与 shared 影响面', async () => {
  const overlay = makeOverlay();
  const parent = tempDir('compose');
  const templatesBefore = snapshotTemplates();

  const result = await composer.compose({
    plan: CLASSIC,
    parentDir: parent,
    projectName: 'demo-store',
    mode: 'development',
    generatedAt: '2026-11-24T00:00:00Z',
    sourceOverlay: overlay.root,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(snapshotTemplates(), templatesBefore, '正式 templates 必须零写入');

  const out = outputOf(parent);
  // 页面最终文件逐字节一致（没有任何追加 marker）。
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'pages/menu/index.wxml')), fs.readFileSync(path.join(overlay.root, 'pages/menu/index.wxml')));
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'pages/menu/index.wxss')), fs.readFileSync(path.join(overlay.root, 'pages/menu/index.wxss')));
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'pages/menu/index.js')), fs.readFileSync(path.join(overlay.root, 'pages/menu/index.js')));
  assert.ok(!fs.readFileSync(path.join(out, 'pages/menu/index.wxss'), 'utf8').includes('FrontendPack'));

  // page-scoped：menu 使用确定性变体；变体 = Base 四件套 + overlay 覆盖。
  const variant = path.join(out, 'components', 'product-card--menu');
  assert.ok(fs.existsSync(path.join(variant, 'index.js')));
  assert.ok(fs.existsSync(path.join(variant, 'index.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(variant, 'index.wxml')), fs.readFileSync(path.join(overlay.root, 'components/product-card/index.wxml')));
  const menuJson = JSON.parse(fs.readFileSync(path.join(out, 'pages/menu/index.json'), 'utf8'));
  assert.strictEqual(menuJson.usingComponents['product-card'], '/components/product-card--menu/index');
  assert.strictEqual(menuJson.usingComponents['c3-badge'], '/components/c3-badge/index');
  // 未修改页面仍用 Base 路径（若该页实际使用 product-card）。
  const homeJson = JSON.parse(fs.readFileSync(path.join(out, 'pages/home/index.json'), 'utf8'));
  if (homeJson.usingComponents['product-card']) {
    assert.strictEqual(homeJson.usingComponents['product-card'], '/components/product-card/index');
  }

  // shared：直接覆盖共享组件，并列出所有受影响页面。
  const header = fs.readFileSync(path.join(out, 'components/store-header/index.wxml'), 'utf8');
  assert.ok(header.includes('c3 shared header'));
  const shared = result.sourceOverlay.componentScopes.find((item) => item.componentId === 'store-header');
  assert.deepStrictEqual(shared.pages, ['home', 'menu']);
  assert.deepStrictEqual(result.sourceOverlay.sharedImpacts.find((item) => item.componentId === 'store-header').pages, ['home', 'menu']);

  // 本地资产复制 + 删除 Base 资产。
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'assets/frontend-source/menu-hero.png')), fs.readFileSync(path.join(overlay.root, 'assets/frontend-source/menu-hero.png')));
  assert.ok(!fs.existsSync(path.join(out, 'assets/tabbar/home.png')));

  // source-changes.json：逐文件状态 + sha256 + Base/Plan/Lock 关系。
  const changes = JSON.parse(fs.readFileSync(path.join(out, 'source-changes.json'), 'utf8'));
  assert.strictEqual(changes.schemaVersion, 'source-changes.v1');
  assert.strictEqual(changes.base.treeSha256, BASE_TREE);
  assert.strictEqual(changes.base.id, 'ordering-base');
  assert.strictEqual(changes.plan.digest, result.planDigest);
  assert.strictEqual(changes.lock.path, 'composition.lock.json');
  assert.strictEqual(changes.overlay.digest, result.sourceOverlay.digest);
  assert.ok(changes.summary.added > 0);
  assert.ok(changes.summary.modified > 0);
  assert.strictEqual(changes.summary.deleted, 1);
  const entryFor = (relative) => changes.files.find((item) => item.path === relative);
  assert.strictEqual(entryFor('pages/menu/index.wxml').status, 'modified');
  assert.strictEqual(entryFor('pages/menu/index.wxml').sha256, sha(fs.readFileSync(path.join(out, 'pages/menu/index.wxml'))));
  assert.strictEqual(entryFor('components/product-card--menu/index.wxml').status, 'added');
  assert.strictEqual(entryFor('assets/tabbar/home.png').status, 'deleted');
  assert.strictEqual(entryFor('assets/tabbar/home.png').sha256, null);
  assert.ok(!JSON.stringify(changes).includes(os.tmpdir()), 'source-changes 不得含绝对路径');

  // 产物一致性（与 mini:check/output.consistency 共用只读实现）必须通过。
  const consistency = inspectOutput(out);
  assert.strictEqual(consistency.ok, true, JSON.stringify(consistency.problems.slice(0, 5)));
  const mini = runMiniChecks(out);
  assert.strictEqual(mini.ok, true, JSON.stringify((mini.errors || []).slice(0, 5)));
});

test('C3 插槽：Plan 已分配功能插槽时，overlay 删除锚点必须阻断', async () => {
  const root = tempDir('slot');
  copyTree(BASE_SRC, root);
  let homeWxml = readBase('pages/home/index.wxml').toString('utf8');
  for (const marker of [
    '<!-- @slot:home-hero -->', '<!-- @slot-fallback:home-hero -->',
    '<!-- @slot-fallback:home-hero:end -->', '<!-- @slot:home-hero:end -->',
  ]) homeWxml = homeWxml.split(marker).join('');
  const files = [writeOverlayFile(root, 'pages/home/index.wxml', homeWxml)];
  fs.writeFileSync(path.join(root, 'source-bundle.json'), JSON.stringify({
    schemaVersion: 'frontend-source-bundle.v1',
    base: { id: 'ordering-base', version: '1.0.0', treeSha256: BASE_TREE },
    targetPages: ['home'],
    files,
  }, null, 2) + '\n');

  const parent = tempDir('slot-out');
  const result = await composer.compose({
    plan: POSTER, parentDir: parent, projectName: 'demo-store', mode: 'development', sourceOverlay: root,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'SLOT_REQUIRED_BY_PLAN');
});

test('C3 校验：Base 摘要/文件 sha/路径/未知组件/与 FrontendPack 互斥', async () => {
  const parent = tempDir('invalid-out');
  const call = (overlay, plan) => composer.compose({
    plan: plan || CLASSIC, parentDir: parent, projectName: 'demo-store', mode: 'development', sourceOverlay: overlay,
  });

  const badBase = makeOverlay({ prefix: 'badbase', manifest: { base: { id: 'ordering-base', version: '1.0.0', treeSha256: 'sha256:deadbeef' } } });
  const baseResult = await call(badBase.root);
  assert.strictEqual(baseResult.ok, false);
  assert.strictEqual(baseResult.code, 'SOURCE_BUNDLE_BASE_MISMATCH');

  const shaOverlay = makeOverlay({ prefix: 'badsha' });
  const manifestPath = path.join(shaOverlay.root, 'source-bundle.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files[0] = { ...manifest.files[0], sha256: 'sha256:deadbeef' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const shaResult = await call(shaOverlay.root);
  assert.strictEqual(shaResult.ok, false);
  assert.strictEqual(shaResult.code, 'SOURCE_BUNDLE_FILE_HASH_MISMATCH');

  const traversal = makeOverlay({ prefix: 'traversal' });
  const traversalManifestPath = path.join(traversal.root, 'source-bundle.json');
  const traversalManifest = JSON.parse(fs.readFileSync(traversalManifestPath, 'utf8'));
  traversalManifest.files[0] = { path: '../evil.wxml', sha256: 'sha256:00' };
  fs.writeFileSync(traversalManifestPath, JSON.stringify(traversalManifest, null, 2) + '\n');
  const traversalResult = await call(traversal.root);
  assert.strictEqual(traversalResult.ok, false);
  assert.strictEqual(traversalResult.code, 'SOURCE_BUNDLE_PATH_INVALID');

  const unknown = makeOverlay({
    prefix: 'unknown',
    extraFiles: [['pages/menu/index.wxml', readBase('pages/menu/index.wxml').toString('utf8') + '\n<evil-comp />\n']],
  });
  const unknownResult = await call(unknown.root);
  assert.strictEqual(unknownResult.ok, false);
  assert.strictEqual(unknownResult.code, 'SOURCE_OVERLAY_COMPONENT_UNKNOWN');

  const conflict = makeOverlay({ prefix: 'conflict' });
  const conflictResult = await call(conflict.root, WARM);
  assert.strictEqual(conflictResult.ok, false);
  assert.strictEqual(conflictResult.code, 'SOURCE_OVERLAY_CONFLICT');
});

test('C3 同源：dry-run/重复导出/重开用同一实现，source-changes 与产物确定性一致', async () => {
  const overlay = makeOverlay({ prefix: 'stable' });
  const parentA = tempDir('same-a');
  const parentB = tempDir('same-b');
  const baseOpts = {
    plan: CLASSIC,
    projectName: 'demo-store',
    mode: 'development',
    generatedAt: '2026-11-24T00:00:00Z',
    sourceOverlay: overlay.root,
  };
  const first = await composer.compose({ ...baseOpts, parentDir: parentA });
  const second = await composer.compose({ ...baseOpts, parentDir: parentB, generatedAt: '2026-11-25T00:00:00Z' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(first.treeSha256, second.treeSha256);
  assert.strictEqual(first.lockDigest, second.lockDigest);

  const outA = outputOf(parentA);
  const outB = outputOf(parentB);
  for (const relative of listTree(outA)) {
    if (relative === 'generation-report.json' || relative === '生成报告.md' || relative === 'composition.lock.json') continue;
    assert.deepStrictEqual(fs.readFileSync(path.join(outA, relative)), fs.readFileSync(path.join(outB, relative)), relative);
  }

  // 直接 buildProjectFiles（dry-run 路径）与正式导出同源。
  const loaded = loadRegistry();
  const graph = resolvePlan(CLASSIC, loaded);
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  // compose 在 emit 时用的是 finalize 前的 lockDigest；从产物回读，保证同一输入。
  const storeSource = fs.readFileSync(path.join(outA, 'config/store.generated.js'), 'utf8');
  const embeddedLock = /"lockDigest":\s*"([^"]+)"/.exec(storeSource);
  assert.ok(embeddedLock, 'store.generated.js 必须包含 lockDigest');
  const direct = emit.buildProjectFiles(graph, {
    mode: 'development',
    projectName: 'demo-store',
    sourceOverlay: overlay.root,
    planDigest: first.planDigest,
    lockDigest: embeddedLock[1],
    registryDigest: loaded.registryDigest,
  });
  assert.strictEqual(direct.ok, true, JSON.stringify(direct));
  const outMenu = fs.readFileSync(path.join(outA, 'pages/menu/index.wxml'));
  assert.deepStrictEqual(direct.files.get('pages/menu/index.wxml'), outMenu);
  const diskChanges = JSON.parse(fs.readFileSync(path.join(outA, 'source-changes.json'), 'utf8'));
  const directChanges = JSON.parse(direct.files.get('source-changes.json').toString('utf8'));
  const differing = [];
  const directByPath = new Map(directChanges.files.map((entry) => [entry.path, entry]));
  for (const entry of diskChanges.files) {
    const directEntry = directByPath.get(entry.path);
    if (!directEntry || directEntry.sha256 !== entry.sha256 || directEntry.status !== entry.status) {
      differing.push({ path: entry.path, disk: entry.sha256, direct: directEntry && directEntry.sha256 });
    }
  }
  assert.deepStrictEqual(differing, []);
  assert.deepStrictEqual(directChanges.summary, diskChanges.summary);
  assert.deepStrictEqual(directChanges.overlay, diskChanges.overlay);
  assert.deepStrictEqual(directChanges.base, diskChanges.base);
  assert.deepStrictEqual(directChanges.plan, diskChanges.plan);
  assert.deepStrictEqual(directChanges.lock, diskChanges.lock);

  // 重开：从磁盘重新加载 overlay，摘要与组件范围一致。
  const reopened = emit.loadSourceOverlay(graph, overlay.root);
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.bundle.digest, first.sourceOverlay.digest);
  assert.deepStrictEqual(reopened.bundle.targetPages, ['menu']);
});

test('C3 entry.assets：相对 pack 根读取并保留相对子路径；缺失即报错', () => {
  const pack = tempDir('pack');
  fs.mkdirSync(path.join(pack, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pack, 'assets', 'poster'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'assets', 'poster', 'a.png'), readBase('assets/tabbar/home.png'));
  const files = new Map();
  const asset = {
    id: 'poster-carousel', dir: pack,
    manifest: { entry: { path: 'src', assets: ['assets/poster/a.png'] } },
  };
  const copied = emit.copyEntryAssets(asset, files);
  assert.strictEqual(copied.ok, true, JSON.stringify(copied));
  assert.ok(files.has('assets/poster-carousel/poster/a.png'), [...files.keys()].join(','));
  assert.deepStrictEqual(files.get('assets/poster-carousel/poster/a.png'), readBase('assets/tabbar/home.png'));

  const missing = emit.copyEntryAssets({ id: 'x', dir: pack, manifest: { entry: { path: 'src', assets: ['assets/none.png'] } } }, new Map());
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'FEATURE_ASSET_MISSING');
});

test('C3 overlay 安全：拒绝 junction 根与嵌套 junction，不读入外部内容', async () => {
  const graph = buildGraph(CLASSIC);

  // 1) overlay 根本身是 junction（lstat 仍是普通目录，必须 realpath 与词法根比较）。
  const overlay = makeOverlay({ prefix: 'jroot' });
  const linkParent = tempDir('jroot-link');
  const link = path.join(linkParent, 'overlay-link');
  fs.symlinkSync(overlay.root, link, 'junction');
  const rootResult = emit.loadSourceOverlay(graph, link);
  assert.strictEqual(rootResult.ok, false);
  assert.strictEqual(rootResult.code, 'SOURCE_OVERLAY_ROOT_INVALID');

  const rootParent = tempDir('jroot-out');
  const rootCompose = await composer.compose({
    plan: CLASSIC, parentDir: rootParent, projectName: 'demo-store', mode: 'development', sourceOverlay: link,
  });
  assert.strictEqual(rootCompose.ok, false);
  assert.strictEqual(rootCompose.code, 'SOURCE_OVERLAY_ROOT_INVALID');
  assert.ok(!fs.existsSync(outputOf(rootParent)), 'junction 根不得产生任何导出');

  // 2) overlay 内 pages/menu 是指向外部目录的 junction：中间路径段也必须拒绝。
  const nested = makeOverlay({ prefix: 'jnested' });
  const external = tempDir('jnested-external');
  const evil = '<view>EVIL-EXTERNAL-CONTENT</view>\n';
  fs.writeFileSync(path.join(external, 'index.wxml'), evil);
  const menuDir = path.join(nested.root, 'pages', 'menu');
  fs.rmSync(menuDir, { recursive: true, force: true });
  fs.symlinkSync(external, menuDir, 'junction');

  const nestedResult = emit.loadSourceOverlay(graph, nested.root);
  assert.strictEqual(nestedResult.ok, false);
  assert.strictEqual(nestedResult.code, 'SOURCE_OVERLAY_PATH_INVALID');

  const nestedParent = tempDir('jnested-out');
  const nestedCompose = await composer.compose({
    plan: CLASSIC, parentDir: nestedParent, projectName: 'demo-store', mode: 'development', sourceOverlay: nested.root,
  });
  assert.strictEqual(nestedCompose.ok, false);
  assert.strictEqual(nestedCompose.code, 'SOURCE_OVERLAY_PATH_INVALID');
  assert.ok(!fs.existsSync(path.join(outputOf(nestedParent), 'pages', 'menu', 'index.wxml')), '不得把 junction 外部文件写入导出');
  assert.strictEqual(fs.readFileSync(path.join(external, 'index.wxml'), 'utf8'), evil, '外部文件不得被改写');
});

test('C3：Plan 校验仍接受 source overlay 之外的标准 Plan；validateComposition 可只校验 overlay', () => {
  assert.strictEqual(validatePlan(CLASSIC).ok, true);
  const overlay = makeOverlay({ prefix: 'validate' });
  const result = composer.validateComposition(CLASSIC, { sourceOverlay: overlay.root });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(result.sourceOverlay.digest.startsWith('sha256:'));
  assert.deepStrictEqual(result.sourceOverlay.targetPages, ['menu']);
});
