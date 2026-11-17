'use strict';

/**
 * P2-3：候选物化（materialize）与私有 Registry overlay 端到端。
 *
 * 证明三件事：
 * 1. 物化产物能被**原样 Composer**（loadRegistry + resolvePlan + buildProjectFiles）消费，
 *    页面 JS 仍来自 Base、slot 锚点完整、候选 id 写进 store 配置；
 * 2. 每次物化是一个独立 attempt，绝不覆盖上一个；失败只清理自己；
 * 3. 全程只写应用私有目录，仓库 templates/registry、templates/frontend-packs 摘要不变，
 *    attempt 元数据里不出现绝对路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BASE_ROOT = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_SRC = path.join(BASE_ROOT, 'src');
const PLAN_FILE = path.join(REPO, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json');

const { materializeCandidate, loadPageFacts, loadPackagedFacts } = require(
  path.join(REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'),
);
const { loadTrustedRegistry, verifyOverlay, overlayAssetRoots, writeOverlayFiles } = require(
  path.join(REPO, 'desktop', 'frontend-reconstruct', 'registry-overlay.cjs'),
);
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { buildProjectFiles } = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { treeSha256, registryDigest } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const { REGISTRY_VERSION } = require(path.join(REPO, 'scripts', 'composer', 'version.cjs'));

const TARGET_PAGES = ['home', 'menu'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pageJson(pageId) {
  return readJson(path.join(BASE_SRC, 'pages', pageId, 'index.json'));
}

/** 真实 P1 打包事实（单一事实源）。失败立即暴露，避免用本地假事实掩盖集成缺陷。 */
const PACKAGED = loadPackagedFacts();
if (!PACKAGED.ok) {
  throw new Error('无法加载 P1 能力快照：' + JSON.stringify(PACKAGED));
}
const FACTS = PACKAGED.facts;
const PAGE_FACTS = PACKAGED.pageFacts;

/** 只出现在 home 页面事实里的数据路径（用于页面级绑定负向测试）。 */
const HOME_ONLY_DATA_PATH = PAGE_FACTS.home.dataPaths.find(
  (item) => !PAGE_FACTS.menu.dataPaths.includes(item),
);

function buildDraft() {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          {
            type: 'component',
            componentId: 'store-header',
            props: { storeName: { kind: 'data', dataPath: 'store.name' } },
            events: {},
          },
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

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-mat-' + prefix + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return dir;
}

function materialize(base, overrides) {
  // 默认不注入 facts：验证 materialize 会自己从 P1 打包快照取事实（单一事实源）。
  return materializeCandidate({
    userDataDir: base,
    projectId: 'proj-alpha',
    runId: 'frun-20261116-abc',
    draft: buildDraft(),
    ...overrides,
  });
}

function attemptsDirOf(base) {
  return path.join(base, 'projects', 'proj-alpha', 'frontend-runs', 'frun-20261116-abc', 'attempts');
}

/** 候选计划：把真实 Recipe Plan 的 frontendPack 换成候选包。 */
function candidatePlan(candidateId, candidateVersion) {
  const plan = readJson(PLAN_FILE);
  plan.frontendPack = { id: candidateId, version: candidateVersion };
  return plan;
}

/**
 * 造一个“Base Manifest 损坏”的可信注册表：
 * 索引与摘要都自洽（能通过注册表冻结校验），但 Manifest 只有 schemaVersion，
 * 从而命中 validateBaseManifest 的失败路径。
 */
function buildBrokenBaseRegistry(root) {
  const assetDir = path.join(root, 'base-broken');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(
    path.join(assetDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 'base.manifest.v1' }, null, 2) + '\n',
    'utf8',
  );
  const index = {
    schemaVersion: 'registry.v1',
    registryVersion: REGISTRY_VERSION,
    frozen: true,
    assets: [
      {
        id: 'ordering-base',
        version: '1.0.0',
        kind: 'base',
        path: 'base-broken',
        integrity: treeSha256(assetDir),
      },
    ],
  };
  const registryRoot = path.join(root, 'registry');
  fs.mkdirSync(registryRoot, { recursive: true });
  fs.writeFileSync(path.join(registryRoot, 'registry.v1.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(registryRoot, 'registry.lock.json'),
    JSON.stringify(
      {
        lockVersion: 'lock.v1',
        registryVersion: REGISTRY_VERSION,
        contentDigest: registryDigest(index),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return { registryRoot, assetRoot: root, assetDir };
}

test('物化成功：私有目录布局、文件清单、attempt 元数据与 run 记录', (t) => {
  const base = tempDir(t, 'ok');
  const stages = [];
  const result = materialize(base, { onStage: (stage) => stages.push(stage), createdAt: '2026-11-16T00:00:00.000Z' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(stages, ['validate', 'render', 'workspace', 'write', 'verify', 'commit']);
  assert.strictEqual(result.attempt, 1);

  const runDir = path.join(base, 'projects', 'proj-alpha', 'frontend-runs', 'frun-20261116-abc');
  assert.strictEqual(result.attemptDir, path.join(runDir, 'attempts', 'attempt-1'));
  assert.strictEqual(result.candidateDir, path.join(result.attemptDir, 'candidate'));
  assert.strictEqual(result.overlayDir, path.join(result.attemptDir, 'overlay'));
  assert.deepStrictEqual(result.assetRoots, overlayAssetRoots(result.overlayDir));

  assert.deepStrictEqual(result.files, [
    'manifest.json',
    'preview/empty.json',
    'preview/error.json',
    'preview/long.json',
    'preview/normal.json',
    'src/pages/home/index.json',
    'src/pages/home/index.wxml',
    'src/pages/home/index.wxss',
  ]);
  for (const relative of result.files) {
    assert.ok(fs.existsSync(path.join(result.candidateDir, relative)), '候选文件必须存在：' + relative);
  }
  assert.match(result.candidate.integrity, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(treeSha256(result.candidateDir), result.candidate.integrity);
  assert.strictEqual(result.candidate.pages.length, 1);
  assert.strictEqual(result.candidate.pages[0], 'home');
  assert.deepStrictEqual(result.candidate.requiresSlots, ['home-hero']);
  assert.match(result.registryDigest, /^sha256:[0-9a-f]{64}$/);
  // 默认（不注入 facts）必须消费 P1 打包快照，并如实回传来源。
  assert.deepStrictEqual(result.factsSource, {
    facts: 'capabilities.snapshot.json',
    pages: 'capabilities.snapshot.json#pages',
  });

  const attemptMeta = readJson(path.join(result.attemptDir, 'attempt.json'));
  assert.strictEqual(attemptMeta.schemaVersion, 'frontend-attempt.v1');
  assert.strictEqual(attemptMeta.status, 'committed');
  assert.strictEqual(attemptMeta.attempt, 1);
  assert.strictEqual(attemptMeta.createdAt, '2026-11-16T00:00:00.000Z');
  assert.strictEqual(attemptMeta.candidate.id, result.candidate.id);
  assert.strictEqual(attemptMeta.candidate.integrity, result.candidate.integrity);
  assert.strictEqual(attemptMeta.overlay.path, 'overlay');
  assert.strictEqual(attemptMeta.overlay.registryDigest, result.registryDigest);
  assert.deepStrictEqual(attemptMeta.files, result.files);

  // attempt 元数据与 run.json 都不得持久化绝对路径（应用私有临时目录）。
  for (const file of [path.join(result.attemptDir, 'attempt.json'), path.join(runDir, 'run.json')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(base), '不得持久化私有根绝对路径：' + file);
    assert.ok(!/[A-Za-z]:\\\\/.test(text), '不得持久化盘符路径：' + file);
  }

  const run = readJson(path.join(runDir, 'run.json'));
  assert.deepStrictEqual(run.attempts.map((item) => item.attempt), [1]);
  assert.strictEqual(run.latestAttempt, 1);
  assert.strictEqual(run.attempts[0].integrity, result.candidate.integrity);
});

test('overlay 可被 Composer 原样加载：候选 + 可信条目完整性都在', (t) => {
  const base = tempDir(t, 'registry');
  const result = materialize(base);
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const verified = verifyOverlay({ overlayRoot: result.overlayDir });
  assert.strictEqual(verified.ok, true, JSON.stringify(verified));
  assert.strictEqual(verified.registryDigest, result.registryDigest);

  const loaded = loadRegistry({
    verifyFreeze: true,
    registryRoot: result.overlayRegistryRoot,
    assetRoots: result.assetRoots,
  });
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded && loaded.errors));

  const candidate = loaded.byKey.get(result.candidate.id + '@' + result.candidate.version);
  assert.ok(candidate);
  assert.strictEqual(candidate.kind, 'frontend-pack');
  assert.strictEqual(candidate.integrity, result.candidate.integrity);
  assert.deepStrictEqual(candidate.manifest.pages, ['home']);

  // 可信条目仍然按全局冻结摘要解析（只读），Base 依旧可用。
  const trusted = loadRegistry({ verifyFreeze: true });
  assert.strictEqual(trusted.ok, true);
  assert.strictEqual(loaded.assets.length, trusted.assets.length + 1);
  const baseAsset = loaded.assets.find((asset) => asset.id === 'ordering-base');
  assert.ok(baseAsset);
  assert.ok(baseAsset.dir.startsWith(path.join(REPO, 'templates', 'base')), 'Base 仍从可信仓库读取');

  const overlayIndex = readJson(path.join(result.overlayDir, 'registry.v1.json'));
  assert.strictEqual(overlayIndex.frozen, true);
  assert.strictEqual(overlayIndex.registryVersion, trusted.registry.registryVersion);
  assert.ok(overlayIndex.assets.every((entry) => typeof entry.integrity === 'string' && entry.path.length > 0));
});

test('overlay 注册表被篡改（lock 摘要漂移）后必须校验失败', (t) => {
  const base = tempDir(t, 'tamper');
  const result = materialize(base);
  assert.strictEqual(result.ok, true);

  const indexFile = path.join(result.overlayDir, 'registry.v1.json');
  const index = readJson(indexFile);
  index.assets[0].integrity = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');

  const verified = verifyOverlay({ overlayRoot: result.overlayDir });
  assert.strictEqual(verified.ok, false);
  assert.strictEqual(verified.code, 'REGISTRY_DRIFT');
});

test('同一 DSL 重复物化：attempt 递增且互不覆盖，候选摘要一致', (t) => {
  const base = tempDir(t, 'attempts');
  const first = materialize(base);
  const second = materialize(base);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));

  assert.strictEqual(first.attempt, 1);
  assert.strictEqual(second.attempt, 2);
  assert.notStrictEqual(first.attemptDir, second.attemptDir);
  assert.deepStrictEqual(fs.readdirSync(attemptsDirOf(base)).sort(), ['attempt-1', 'attempt-2']);

  // 第二次不得改写第一次的候选与元数据。
  assert.strictEqual(treeSha256(first.candidateDir), first.candidate.integrity);
  assert.strictEqual(readJson(path.join(first.attemptDir, 'attempt.json')).attempt, 1);
  assert.strictEqual(treeSha256(second.candidateDir), second.candidate.integrity);
  assert.strictEqual(first.candidate.integrity, second.candidate.integrity);

  const run = readJson(path.join(base, 'projects', 'proj-alpha', 'frontend-runs', 'frun-20261116-abc', 'run.json'));
  assert.deepStrictEqual(run.attempts.map((item) => item.attempt), [1, 2]);
  assert.strictEqual(run.latestAttempt, 2);
});

test('渲染/写盘阶段失败：只清理本次 attempt，之前 attempt 原样保留', (t) => {
  const base = tempDir(t, 'cleanup');
  const keep = materialize(base);
  assert.strictEqual(keep.ok, true);
  const keepDigest = treeSha256(keep.candidateDir);

  const aborted = materialize(base, {
    onStage: (stage) => {
      if (stage === 'verify') throw new Error('listener-aborted');
    },
  });
  assert.strictEqual(aborted.ok, false);
  assert.strictEqual(aborted.code, 'MATERIALIZE_FAILED');
  assert.deepStrictEqual(fs.readdirSync(attemptsDirOf(base)).sort(), ['attempt-1']);
  assert.strictEqual(treeSha256(keep.candidateDir), keepDigest);

  // 非法 Draft 在写盘前就被拒绝：不分配新 attempt。
  const badDraft = buildDraft();
  badDraft.pages[0].nodes[0].componentId = 'not-a-component';
  const invalid = materialize(base, { draft: badDraft });
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.code, 'MATERIALIZE_DRAFT_INVALID');
  assert.strictEqual(invalid.details.draftCode, 'DRAFT_UNKNOWN_COMPONENT');
  assert.match(invalid.path, /^\$\./);
  assert.deepStrictEqual(fs.readdirSync(attemptsDirOf(base)).sort(), ['attempt-1']);

  // 非法能力事实同样在写盘前拒绝（连工作区都不创建）。
  const badFactsBase = tempDir(t, 'badfacts');
  const badFacts = { ...FACTS, version: 'frontend-facts.v9' };
  const noFacts = materialize(badFactsBase, { facts: badFacts });
  assert.strictEqual(noFacts.ok, false);
  assert.strictEqual(noFacts.code, 'DRAFT_SCHEMA_INVALID');
  assert.ok(!fs.existsSync(path.join(badFactsBase, 'projects')));
});

test('物化产物可被 Composer 消费：候选包解析、emit、页面 JS 仍来自 Base', (t) => {
  const base = tempDir(t, 'compose');
  const result = materialize(base);
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const loaded = loadRegistry({
    verifyFreeze: true,
    registryRoot: result.overlayRegistryRoot,
    assetRoots: result.assetRoots,
  });
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded && loaded.errors));

  const graph = resolvePlan(candidatePlan(result.candidate.id, result.candidate.version), loaded);
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  assert.strictEqual(graph.frontendPack.asset.id, result.candidate.id);

  const emitted = buildProjectFiles(graph, { mode: 'development', projectName: 'candidate-project' });
  assert.strictEqual(emitted.ok, true, JSON.stringify(emitted));

  const homeWxml = emitted.files.get('pages/home/index.wxml').toString('utf8');
  assert.ok(homeWxml.includes('fp-cand-page--home'));
  assert.ok(homeWxml.includes('<!-- @slot-fallback:home-hero -->'));
  assert.ok(homeWxml.includes('bind:tap="goMenu"'));
  assert.ok(homeWxml.includes('store-name="{{store.name}}"'));

  // 页面 JS / 控制器来自 Base，候选包没有写入任何 JS。
  const baseHomeJs = fs.readFileSync(path.join(BASE_SRC, 'pages', 'home', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(emitted.files.get('pages/home/index.js').toString('utf8'), baseHomeJs);
  const candidateFiles = fs.readdirSync(result.candidateDir, { recursive: true });
  assert.deepStrictEqual(
    candidateFiles.filter((file) => String(file).endsWith('.js')),
    [],
  );

  const storeConfig = emitted.files.get('config/store.generated.js').toString('utf8');
  assert.ok(storeConfig.includes('"frontendPackId": "' + result.candidate.id + '"'));
  assert.ok(storeConfig.includes('"frontendPackVersion": "1.0.0"'));

  // emit 输出里没有任何候选私有绝对路径。
  for (const [relative, content] of emitted.files) {
    if (!/\.(json|wxml|wxss|js|md)$/.test(relative)) continue;
    assert.ok(!content.toString('utf8').includes(base), '产物不得泄漏私有路径：' + relative);
  }
});

test('可选候选 Recipe 进入 overlay 且可被 Composer 列出', (t) => {
  const base = tempDir(t, 'recipe');
  const plan = readJson(PLAN_FILE);
  const recipe = { id: 'fr-candidate-home', version: '1.0.0', plan };
  const result = materialize(base, { candidateRecipe: recipe });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const loaded = loadRegistry({
    verifyFreeze: true,
    registryRoot: result.overlayRegistryRoot,
    assetRoots: result.assetRoots,
  });
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded && loaded.errors));

  const found = loaded.assets.find((asset) => asset.id === 'fr-candidate-home');
  assert.ok(found, 'overlay 必须包含候选 Recipe');
  assert.strictEqual(found.kind, 'recipe');
  assert.deepStrictEqual(found.recipe, plan);
  assert.strictEqual(
    treeSha256(found.dir),
    JSON.parse(fs.readFileSync(path.join(result.overlayDir, 'registry.v1.json'), 'utf8'))
      .assets.find((entry) => entry.id === 'fr-candidate-home').integrity,
  );

  const invalid = materialize(base, { candidateRecipe: { id: 'Bad Id', version: '1.0.0', plan } });
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.code, 'OVERLAY_RECIPE_INVALID');
  assert.deepStrictEqual(fs.readdirSync(attemptsDirOf(base)), ['attempt-1']);
});

test('候选不写全局 templates/registry 与 templates/frontend-packs', (t) => {
  const registryDir = path.join(REPO, 'templates', 'registry');
  const packsDir = path.join(REPO, 'templates', 'frontend-packs');
  const beforeRegistry = treeSha256(registryDir);
  const beforePacks = treeSha256(packsDir);

  const base = tempDir(t, 'global');
  const result = materialize(base);
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  assert.strictEqual(treeSha256(registryDir), beforeRegistry);
  assert.strictEqual(treeSha256(packsDir), beforePacks);
  assert.ok(fs.existsSync(path.join(packsDir, 'warm-home-menu', '1.0.0', 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(packsDir, result.candidate.id)));
});

test('拒绝把私有工作区放进仓库（templates/miniprogram/src）', () => {
  for (const sub of [['templates'], ['templates', 'registry'], ['templates', 'frontend-packs'], ['miniprogram'], ['src']]) {
    const result = materialize(path.join(REPO, ...sub));
    assert.strictEqual(result.ok, false, '必须拒绝：' + sub.join('/'));
    assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  }
});

test('Composer 显式 registryRoot/assetRoots 可消费私有 overlay，且默认调用不会静默回落 Base', async (t) => {
  const base = tempDir(t, 'compose-cli');
  const result = materialize(base);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const plan = candidatePlan(result.candidate.id, result.candidate.version);

  const parent = tempDir(t, 'export');
  const composed = await compose({
    plan,
    parentDir: parent,
    projectName: 'fr-candidate',
    mode: 'development',
    registryRoot: result.overlayRegistryRoot,
    assetRoots: result.assetRoots,
  });
  assert.strictEqual(composed.ok, true, JSON.stringify(composed));
  assert.ok(fs.existsSync(composed.outputPath));
  assert.strictEqual(composed.lock.outputDigest.tree, composed.treeSha256);
  assert.match(composed.lock.registryDigest, /^sha256:[0-9a-f]{64}$/);

  const storeConfig = fs.readFileSync(path.join(composed.outputPath, 'config', 'store.generated.js'), 'utf8');
  assert.ok(storeConfig.includes('"frontendPackId": "' + result.candidate.id + '"'));
  const outputWxml = fs.readFileSync(path.join(composed.outputPath, 'pages', 'home', 'index.wxml'), 'utf8');
  assert.ok(outputWxml.includes('<!-- @slot-fallback:home-hero -->'));

  // 默认调用（全局 Registry）里没有这个候选：必须明确失败，不能悄悄回落到 Base。
  const globalParent = tempDir(t, 'export-global');
  const fallback = await compose({ plan, parentDir: globalParent, projectName: 'fr-candidate', mode: 'development' });
  assert.strictEqual(fallback.ok, false);
  assert.strictEqual(fallback.code, 'FRONTEND_PACK_MISSING');
  assert.deepStrictEqual(fs.readdirSync(globalParent), []);
});

test('overlay 写入守卫：拒绝全局模板/镜像前缀与路径穿越', (t) => {
  const dir = tempDir(t, 'guard');
  for (const relative of [
    'templates/registry/registry.v1.json',
    'templates/frontend-packs/x/1.0.0/manifest.json',
    'miniprogram/app.js',
    '../escape.json',
    '/absolute.json',
    'C:/windows.json',
  ]) {
    const result = writeOverlayFiles(dir, new Map([[relative, 'x']]));
    assert.strictEqual(result.ok, false, '应拒绝：' + relative);
    assert.strictEqual(result.code, 'OVERLAY_WRITE_REJECTED');
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('loadPageFacts 消费 P1 快照页面事实（规范命名空间、按页面隔离、与 Base 同源）', () => {
  const trusted = loadTrustedRegistry({});
  assert.strictEqual(trusted.ok, true, JSON.stringify(trusted));
  const pageFacts = loadPageFacts(trusted.loaded, { pageIds: ['home', 'menu'] });
  assert.strictEqual(pageFacts.ok, true, JSON.stringify(pageFacts));
  assert.deepStrictEqual(pageFacts.sources, {
    facts: 'capabilities.snapshot.json',
    pages: 'capabilities.snapshot.json#pages',
  });
  assert.deepStrictEqual(pageFacts.pageFacts.home.slots, ['home-hero', 'home-marketing']);
  assert.deepStrictEqual(pageFacts.pageFacts.menu.slots, ['menu-aside', 'menu-hero']);
  // 组件来自页面 usingComponents（含 declared-only 的 poster-carousel），与快照口径一致。
  assert.deepStrictEqual(
    pageFacts.pageFacts.home.components,
    Object.keys(pageJson('home').usingComponents).sort(),
  );

  // dataPaths 是 P1 的规范命名空间（cart.* / <pageId>.<key> / store.*），按页面隔离。
  assert.ok(pageFacts.pageFacts.home.dataPaths.includes('home.mode'));
  assert.ok(pageFacts.pageFacts.menu.dataPaths.includes('menu.products'));
  assert.ok(pageFacts.pageFacts.menu.dataPaths.includes('menu.categories'));
  assert.ok(pageFacts.pageFacts.menu.dataPaths.includes('cart.totalCents'));
  assert.ok(pageFacts.pageFacts.menu.dataPaths.includes('cart.count'));
  assert.ok(pageFacts.pageFacts.home.dataPaths.includes('store.name'));
  assert.ok(pageFacts.pageFacts.menu.dataPaths.includes('store.name'));
  assert.ok(HOME_ONLY_DATA_PATH, 'home 页面应存在独占数据路径');
  assert.ok(pageFacts.pageFacts.home.dataPaths.includes(HOME_ONLY_DATA_PATH));
  assert.ok(!pageFacts.pageFacts.menu.dataPaths.includes(HOME_ONLY_DATA_PATH));
  assert.deepStrictEqual(pageFacts.pageFacts.home.dataPaths, [...pageFacts.pageFacts.home.dataPaths].sort());
  // 原始 WXML token / wx:for 别名不得进入页面事实。
  for (const pageId of TARGET_PAGES) {
    for (const rawToken of ['cartSummary.totalCents', 'cartSummary.items', 'products.length', 'item.name']) {
      assert.ok(!pageFacts.pageFacts[pageId].dataPaths.includes(rawToken), pageId + ' 不得含原始 token：' + rawToken);
    }
  }
  assert.strictEqual(pageFacts.base.version, '1.0.0');

  const missingBase = loadPageFacts(trusted.loaded, { pageIds: ['home'], baseId: 'missing-base' });
  assert.strictEqual(missingBase.ok, false);
  assert.strictEqual(missingBase.code, 'MATERIALIZE_BASE_INVALID');
});

test('loadPageFacts 对快照缺页/缺文件明确报 MATERIALIZE_FACTS_INVALID（不退回 WXML）', (t) => {
  const trusted = loadTrustedRegistry({});
  assert.strictEqual(trusted.ok, true);

  // 缺页：pageFacts 只有 home，却请求 menu。
  const onlyHome = {
    ok: true,
    source: 'capabilities.snapshot.json',
    pagesSource: 'capabilities.snapshot.json#pages',
    facts: FACTS,
    pageFacts: { home: PAGE_FACTS.home },
  };
  const missingPage = loadPageFacts(trusted.loaded, {
    pageIds: ['home', 'menu'],
    packagedFacts: onlyHome,
  });
  assert.strictEqual(missingPage.ok, false);
  assert.strictEqual(missingPage.code, 'MATERIALIZE_FACTS_INVALID');
  assert.ok(String(missingPage.path).includes('menu'));

  // 快照目录完全缺失：loadPackagedFacts / materialize 都必须明确失败。
  const emptySnapshot = tempDir(t, 'empty-snapshot');
  const noSnapshot = loadPackagedFacts({ snapshotDir: emptySnapshot });
  assert.strictEqual(noSnapshot.ok, false);
  assert.strictEqual(noSnapshot.code, 'MATERIALIZE_FACTS_INVALID');
  assert.strictEqual(noSnapshot.path, 'capabilities.snapshot.json');

  const base = tempDir(t, 'missing-snapshot-user');
  const result = materialize(base, { snapshotDir: emptySnapshot });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MATERIALIZE_FACTS_INVALID');
  assert.ok(!fs.existsSync(path.join(base, 'projects')), '快照缺失时不得创建任何工作区目录');
});

test('loadPageFacts 对损坏 Base Manifest 结构返回 MATERIALIZE_BASE_INVALID（不抛异常）', () => {
  const baseAsset = {
    kind: 'base',
    id: 'ordering-base',
    version: '1.0.0',
    dir: BASE_ROOT,
  };
  const cases = [
    { label: '缺少 identity', manifest: { entry: { root: 'src' }, slots: [] } },
    { label: '缺少 entry.root', manifest: { identity: { version: '1.0.0' }, entry: {}, slots: [] } },
    { label: '缺少 slots', manifest: { identity: { version: '1.0.0' }, entry: { root: 'src' } } },
    { label: 'slots 元素损坏', manifest: { identity: { version: '1.0.0' }, entry: { root: 'src' }, slots: [null] } },
    { label: 'manifest 非对象', manifest: null },
  ];
  for (const item of cases) {
    const loaded = { assets: [{ ...baseAsset, manifest: item.manifest }] };
    let result;
    assert.doesNotThrow(() => {
      result = loadPageFacts(loaded, { pageIds: ['home'] });
    }, item.label);
    assert.strictEqual(result.ok, false, item.label);
    assert.strictEqual(result.code, 'MATERIALIZE_BASE_INVALID', item.label);
  }
  const emptyLoaded = loadPageFacts({ assets: [] }, { pageIds: ['home'] });
  assert.strictEqual(emptyLoaded.code, 'MATERIALIZE_BASE_INVALID');
  const nullLoaded = loadPageFacts(null, { pageIds: ['home'] });
  assert.strictEqual(nullLoaded.code, 'MATERIALIZE_BASE_INVALID');
});

test('损坏 Base Manifest 的可信注册表：materialize 失败且不创建工作区', (t) => {
  const registryRootParent = tempDir(t, 'broken-registry');
  const broken = buildBrokenBaseRegistry(registryRootParent);
  const base = tempDir(t, 'broken-registry-user');

  const result = materialize(base, {
    trustedRegistryRoot: broken.registryRoot,
    trustedAssetRoots: [broken.assetRoot],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MATERIALIZE_BASE_INVALID');
  assert.strictEqual(typeof result.details.trustedCode, 'string');
  assert.ok(!result.details.trustedCode.startsWith('MATERIALIZE_'));

  // Base 不合法时连工作区都不创建（渲染前就失败）。
  assert.ok(!fs.existsSync(path.join(base, 'projects')));
  // 损坏的 manifest 原样留在测试临时目录，未被任何清理逻辑误删/改写。
  assert.deepStrictEqual(
    readJson(path.join(broken.assetDir, 'manifest.json')),
    { schemaVersion: 'base.manifest.v1' },
  );
});

test('overlayRoot 为 junction / 越出 attemptDir 时拒绝写入，目标目录保持为空', (t) => {
  const attemptDir = tempDir(t, 'attempt-root');
  const escape = tempDir(t, 'overlay-escape');
  const outside = tempDir(t, 'overlay-outside');
  const files = new Map([['registry.v1.json', '{}']]);

  // 1) overlayRoot 本身是 junction → 拒绝，且 escape 目录零写入。
  const junctionRoot = path.join(attemptDir, 'overlay');
  fs.symlinkSync(escape, junctionRoot, 'junction');
  const junctionResult = writeOverlayFiles(junctionRoot, files, { expectedPrivateRoot: attemptDir });
  assert.strictEqual(junctionResult.ok, false);
  assert.strictEqual(junctionResult.code, 'OVERLAY_WRITE_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);

  // 2) overlayRoot 不在本次 attemptDir 内 → 拒绝。
  const outsideResult = writeOverlayFiles(outside, files, { expectedPrivateRoot: attemptDir });
  assert.strictEqual(outsideResult.ok, false);
  assert.strictEqual(outsideResult.code, 'OVERLAY_WRITE_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(outside), []);

  // 3) overlay 内部的父目录被换成 junction → 逐段 audit 拒绝，escape 仍为空。
  const nestedRoot = path.join(attemptDir, 'overlay-nested');
  fs.mkdirSync(nestedRoot);
  fs.symlinkSync(escape, path.join(nestedRoot, 'assets'), 'junction');
  const nestedResult = writeOverlayFiles(
    nestedRoot,
    new Map([['assets/frontend-packs/x/1.0.0/manifest.json', '{}']]),
    { expectedPrivateRoot: attemptDir },
  );
  assert.strictEqual(nestedResult.ok, false);
  assert.notStrictEqual(nestedResult.code, undefined);
  assert.deepStrictEqual(fs.readdirSync(escape), []);
});

test('staging 被替换成 junction：materialize 拒绝且目标目录为空、attempt 被清理', (t) => {
  const base = tempDir(t, 'staging-swap');
  const escape = tempDir(t, 'staging-escape');
  const runDir = path.join(base, 'projects', 'proj-alpha', 'frontend-runs', 'frun-20261116-abc');
  let replaced = false;

  const result = materialize(base, {
    onStage: (stage) => {
      if (stage !== 'write' || replaced) return;
      replaced = true;
      const attemptsDir = path.join(runDir, 'attempts');
      const attemptDir = path.join(attemptsDir, fs.readdirSync(attemptsDir)[0]);
      const stagingName = fs.readdirSync(attemptDir).find((name) => name.startsWith('.staging-'));
      assert.ok(stagingName, 'staging 目录应在 write 阶段前创建');
      const staging = path.join(attemptDir, stagingName);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.symlinkSync(escape, staging, 'junction');
    },
  });

  assert.strictEqual(replaced, true);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(runDir, 'attempts')), []);
});

test('candidate staging 被替换成 junction：materialize 拒绝且目标目录为空', (t) => {
  const base = tempDir(t, 'candidate-swap');
  const escape = tempDir(t, 'candidate-escape');
  const runDir = path.join(base, 'projects', 'proj-alpha', 'frontend-runs', 'frun-20261116-abc');
  let replaced = false;

  const result = materialize(base, {
    onStage: (stage) => {
      if (stage !== 'write' || replaced) return;
      replaced = true;
      const attemptsDir = path.join(runDir, 'attempts');
      const attemptDir = path.join(attemptsDir, fs.readdirSync(attemptsDir)[0]);
      const stagingName = fs.readdirSync(attemptDir).find((name) => name.startsWith('.staging-'));
      const staging = path.join(attemptDir, stagingName);
      fs.symlinkSync(escape, path.join(staging, 'candidate'), 'junction');
    },
  });

  assert.strictEqual(replaced, true);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WORKSPACE_PATH_REJECTED');
  assert.deepStrictEqual(fs.readdirSync(escape), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(runDir, 'attempts')), []);
});

test('renderer 意外异常收敛为 MATERIALIZE_FAILED，且不泄漏私有路径/不建工作区', (t) => {
  const base = tempDir(t, 'render-crash');
  const hostileDraft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '崩溃候选',
    get pages() {
      throw new Error('boom');
    },
  };
  const result = materialize(base, { draft: hostileDraft });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MATERIALIZE_FAILED');
  assert.ok(!String(result.message).includes(base));
  assert.ok(!fs.existsSync(path.join(base, 'projects')));
});

test('home 专属 dataPath 用在 menu 页 / 原始 WXML token：页面事实在 materialize 阶段拦截', (t) => {
  const base = tempDir(t, 'cross-binding');
  assert.ok(HOME_ONLY_DATA_PATH);
  const menuDraft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '错页绑定候选',
    pages: [
      {
        pageId: 'menu',
        nodes: [{ type: 'text', textToken: HOME_ONLY_DATA_PATH }],
        styles: [],
        pageJson: {},
      },
    ],
  };
  const result = materialize(base, { draft: menuDraft });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'MATERIALIZE_DRAFT_INVALID');
  assert.strictEqual(result.details.draftCode, 'DRAFT_UNKNOWN_DATA_PATH');
  assert.strictEqual(result.path, '$.pages[0].nodes[0].textToken');
  assert.ok(!fs.existsSync(path.join(base, 'projects')));

  // 原始 WXML token（cartSummary.*）与 wx:for 别名（item.*）都不是规范事实：同样拒绝。
  for (const rawToken of ['cartSummary.totalCents', 'item.name']) {
    const rawDraft = {
      schemaVersion: 'frontend-pack-draft.v1',
      displayName: '原始 token 候选',
      pages: [
        {
          pageId: 'home',
          nodes: [{ type: 'text', textToken: rawToken }],
          styles: [],
          pageJson: {},
        },
      ],
    };
    const rawResult = materialize(base, { draft: rawDraft });
    assert.strictEqual(rawResult.ok, false, rawToken);
    assert.strictEqual(rawResult.code, 'MATERIALIZE_DRAFT_INVALID', rawToken);
    assert.strictEqual(rawResult.details.draftCode, 'DRAFT_UNKNOWN_DATA_PATH', rawToken);
  }
});

test('writeOverlayFiles：规范化 staging 下的多级缺失目录可逐段创建', (t) => {
  const attempt = tempDir(t, 'nested-overlay');
  const nestedRoot = path.join(attempt, 'a', 'b', 'overlay');
  const result = writeOverlayFiles(nestedRoot, new Map([['registry.v1.json', '{}\n']]), {
    expectedPrivateRoot: attempt,
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(nestedRoot, 'registry.v1.json')));
});

test('P1 snapshot 集成：home.mode + menu.products/categories + cart.totalCents/count 可物化并被 Composer 消费', (t) => {
  const base = tempDir(t, 'snapshot-integration');
  const draft = {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '按图重构候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          { type: 'slot', slotId: 'home-hero' },
          { type: 'text', textToken: 'home.mode', style: { size: 'lg', weight: 600, colorToken: 'textColor' } },
          { type: 'text', textToken: 'store.name' },
          { type: 'button', label: '开始点餐', action: 'home.goMenu' },
        ],
        styles: [],
        pageJson: { navigationBarTitleText: '扫码点餐' },
      },
      {
        pageId: 'menu',
        nodes: [
          { type: 'slot', slotId: 'menu-aside' },
          { type: 'text', textToken: 'menu.products' },
          { type: 'text', textToken: 'menu.categories' },
          { type: 'text', textToken: 'cart.totalCents' },
          { type: 'text', textToken: 'cart.count' },
          {
            type: 'component',
            componentId: 'category-nav',
            props: { categories: { kind: 'data', dataPath: 'menu.categories' } },
            events: { select: 'menu.onSelectCategory' },
          },
          { type: 'button', label: '去结算', action: 'menu.onCheckout' },
        ],
        styles: [],
        pageJson: { navigationBarTitleText: '菜单' },
      },
    ],
  };

  const result = materialize(base, { draft });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(result.factsSource, {
    facts: 'capabilities.snapshot.json',
    pages: 'capabilities.snapshot.json#pages',
  });
  assert.deepStrictEqual(result.candidate.pages, ['home', 'menu']);
  assert.deepStrictEqual(result.candidate.requiresSlots, ['home-hero', 'menu-aside']);

  const homeWxml = fs.readFileSync(path.join(result.candidateDir, 'src/pages/home/index.wxml'), 'utf8');
  const menuWxml = fs.readFileSync(path.join(result.candidateDir, 'src/pages/menu/index.wxml'), 'utf8');
  // 规范 token 必须被映射成 Base 真实 WXML 表达式（repair-4）。
  assert.ok(homeWxml.includes('{{mode}}'), 'home.mode 应映射为 {{mode}}');
  assert.ok(menuWxml.includes('{{products}}'), 'menu.products 应映射为 {{products}}');
  assert.ok(menuWxml.includes('{{categories}}'), 'menu.categories 应映射为 {{categories}}');
  assert.ok(menuWxml.includes('{{cartSummary.totalCents}}'), 'cart.totalCents 应映射为 {{cartSummary.totalCents}}');
  assert.ok(menuWxml.includes('{{cartSummary.totalQuantity}}'), 'cart.count 应映射为 {{cartSummary.totalQuantity}}');
  assert.ok(menuWxml.includes('categories="{{categories}}"'), 'component prop 也要映射');
  assert.ok(menuWxml.includes('bind:select="onSelectCategory"'), '事件仍绑定真实控制器方法');
  for (const [label, wxml] of [['home', homeWxml], ['menu', menuWxml]]) {
    for (const canonical of ['{{home.', '{{menu.', '{{cart.']) {
      assert.ok(!wxml.includes(canonical), label + ' 候选 WXML 不得残留规范 token：' + canonical);
    }
  }

  // 同一 overlay 交给 Composer：解析 + emit 全绿，候选 id 进入 store 配置。
  const loaded = loadRegistry({
    verifyFreeze: true,
    registryRoot: result.overlayRegistryRoot,
    assetRoots: result.assetRoots,
  });
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded && loaded.errors));
  const graph = resolvePlan(candidatePlan(result.candidate.id, result.candidate.version), loaded);
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  const emitted = buildProjectFiles(graph, { mode: 'development', projectName: 'snapshot-integration' });
  assert.strictEqual(emitted.ok, true, JSON.stringify(emitted));
  const storeConfig = emitted.files.get('config/store.generated.js').toString('utf8');
  assert.ok(storeConfig.includes('"frontendPackId": "' + result.candidate.id + '"'));
  assert.ok(emitted.files.get('pages/menu/index.wxml').toString('utf8').includes('{{cartSummary.totalCents}}'));
  assert.ok(emitted.files.get('pages/home/index.wxml').toString('utf8').includes('{{mode}}'));
});
