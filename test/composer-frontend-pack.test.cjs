'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { buildProjectFiles } = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
const { validateFrontendPackManifest } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));
const { planDigest } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json'), 'utf8'));
const PACK_DIR = path.join(REPO, 'templates', 'frontend-packs', 'warm-home-menu', '1.0.0');
const PACK_MANIFEST = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
const BASE = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');

function buildGraph(plan) {
  const loaded = loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.errors));
  return resolvePlan(plan || PLAN, loaded);
}

test('FrontendPack 已登记且注册表可加载', () => {
  const loaded = loadRegistry();
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded.errors));
  const pack = loaded.byKey.get('warm-home-menu@1.0.0');
  assert.ok(pack);
  assert.strictEqual(pack.kind, 'frontend-pack');
  assert.deepStrictEqual(pack.manifest.pages, ['home', 'menu']);
});

test('FrontendPack 只覆盖视图，页面控制器保持 Base 原样', () => {
  const graph = buildGraph();
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  assert.ok(graph.frontendPack);
  assert.strictEqual(graph.frontendPack.asset.id, 'warm-home-menu');

  const result = buildProjectFiles(graph, { mode: 'development', projectName: 'fp-test' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const homeWxml = result.files.get('pages/home/index.wxml').toString('utf8');
  const menuWxml = result.files.get('pages/menu/index.wxml').toString('utf8');
  assert.ok(homeWxml.includes('fp-home__title'));
  assert.ok(menuWxml.includes('fp-menu__headline'));
  assert.ok(homeWxml.includes('<!-- @slot-fallback:home-hero -->'));
  assert.ok(menuWxml.includes('<!-- @slot-fallback:menu-aside -->'));

const baseHomeJs = fs.readFileSync(path.join(BASE, 'pages', 'home', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(result.files.get('pages/home/index.js').toString('utf8'), baseHomeJs);

  const homeJson = JSON.parse(result.files.get('pages/home/index.json').toString('utf8'));
  assert.strictEqual(homeJson.navigationBarTitleText, '扫码点餐');
  assert.ok(homeJson.usingComponents['store-header']);

  const storeConfig = result.files.get('config/store.generated.js').toString('utf8');
  assert.ok(storeConfig.includes('"frontendPackId": "warm-home-menu"'));
  assert.ok(storeConfig.includes('"frontendPackVersion": "1.0.0"'));
  assert.strictEqual(result.stats.frontendPackPages, 2);
});

test('FrontendPack 引用必须是 frontend-pack 且页面必须在 Plan 内', () => {
  const notPack = buildGraph({ ...PLAN, frontendPack: { id: 'poster-carousel', version: '1.0.0' } });
  assert.strictEqual(notPack.ok, false);
  assert.strictEqual(notPack.code, 'ASSET_KIND_MISMATCH');

  const missing = buildGraph({ ...PLAN, frontendPack: { id: 'missing-pack', version: '1.0.0' } });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'FRONTEND_PACK_MISSING');

  const extraKey = buildGraph({ ...PLAN, frontendPack: { id: 'warm-home-menu', version: '1.0.0', path: 'templates/frontend-packs/warm-home-menu/1.0.0' } });
  assert.strictEqual(extraKey.ok, false);
  assert.strictEqual(extraKey.code, 'PLAN_FIELD_FORBIDDEN');

  const pageMissing = buildGraph({
    ...PLAN,
    pages: PLAN.pages.filter((page) => page.pageId !== 'home'),
  });
  assert.strictEqual(pageMissing.ok, false);
  assert.ok(['BASE_REQUIRED_PAGE_MISSING', 'FRONTEND_PACK_PAGE_NOT_IN_PLAN'].includes(pageMissing.code));
});

test('FrontendPack Manifest 拒绝 JS、缺页面文件和错误 kind', () => {
  const withJs = {
    ...PACK_MANIFEST,
    entry: { ...PACK_MANIFEST.entry, files: [...PACK_MANIFEST.entry.files, 'pages/home/index.js'] },
  };
  assert.strictEqual(validateFrontendPackManifest(withJs).code, 'FRONTEND_PACK_SOURCE_FORBIDDEN');

  const missingJson = {
    ...PACK_MANIFEST,
    entry: {
      ...PACK_MANIFEST.entry,
      files: PACK_MANIFEST.entry.files.filter((file) => file !== 'pages/menu/index.json'),
    },
  };
  assert.strictEqual(validateFrontendPackManifest(missingJson).code, 'FRONTEND_PACK_PAGE_FILE_MISSING');

  assert.strictEqual(validateFrontendPackManifest({ ...PACK_MANIFEST, kind: 'ui-block' }).code, 'FRONTEND_PACK_MANIFEST_INVALID');
});

test('FrontendPack 目录中不存在任何 JS 文件', () => {
  const files = [];
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    });
  }
  walk(PACK_DIR);
  assert.deepStrictEqual(files.filter((file) => file.endsWith('.js')), []);
});

test('Plan 摘要纳入 frontendPack', () => {
  const without = { ...PLAN };
  delete without.frontendPack;
  assert.notStrictEqual(planDigest(PLAN), planDigest(without));
  assert.strictEqual(planDigest(PLAN), planDigest(PLAN));
});