'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { buildProjectFiles, buildReadme } = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
const { validateStoreConfig } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

function graph() {
  const loaded = loadRegistry();
  const resolved = resolvePlan(PLAN, loaded);
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  return resolved;
}

function readConfig(text) {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(text, sandbox);
  return JSON.parse(JSON.stringify(sandbox.module.exports));
}

test('store.generated v2：12 项 meta、白名单、delivery=false 与版本缺口', () => {
  const result = buildProjectFiles(graph(), { mode: 'development', projectName: 'cfg' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const config = readConfig(result.files.get('config/store.generated.js').toString('utf8'));
  assert.strictEqual(config.schemaVersion, 2);
  assert.deepStrictEqual(Object.keys(config.meta).sort(), [
    'apiContractVersion', 'catalogVersion', 'configSchemaVersion', 'generatedAt', 'generatorVersion',
    'lockDigest', 'mode', 'planDigest', 'recipeId', 'recipeVersion', 'storeConfigVersion', 'versionGaps',
  ].sort());
  assert.strictEqual(config.meta.mode, 'development');
  assert.strictEqual(config.meta.storeConfigVersion, null);
  assert.deepStrictEqual(config.meta.versionGaps, { storeConfigVersion: null, catalogVersion: null });
  assert.strictEqual(config.fulfillmentOptions.delivery, false);
  assert.strictEqual(config.meta.generatedAt, '1970-01-01T00:00:00Z');
  assert.ok(!('priceText' in config));
  assert.strictEqual(validateStoreConfig(config).ok, true);
});

test('production：必须 HTTPS 且必须提供后端版本', () => {
  const missingUrl = buildProjectFiles(graph(), { mode: 'production', projectName: 'cfg' });
  assert.strictEqual(missingUrl.ok, false);

  const withUrl = JSON.parse(JSON.stringify(PLAN));
  withUrl.apiBinding.baseUrl = 'https://api.example.com';
  const productionGraph = resolvePlan(withUrl, loadRegistry());
  const missingVersions = buildProjectFiles(productionGraph, { mode: 'production', projectName: 'cfg' });
  assert.strictEqual(missingVersions.ok, false);
  assert.strictEqual(missingVersions.code, 'VERSION_GAP_REQUIRED');

  const withVersions = buildProjectFiles(productionGraph, {
    mode: 'production',
    projectName: 'cfg',
    backendVersions: { storeConfigVersion: 3, catalogVersion: 7 },
  });
  assert.strictEqual(withVersions.ok, true, JSON.stringify(withVersions));
  const config = readConfig(withVersions.files.get('config/store.generated.js').toString('utf8'));
  assert.strictEqual(config.meta.storeConfigVersion, 3);
  assert.strictEqual(config.meta.catalogVersion, 7);
  assert.strictEqual(config.meta.mode, 'production');
  assert.match(config.api.baseUrl, /^https:\/\//);
});

test('旧 v1 配置与 capabilities 交集被拒绝', () => {
  const v1 = {
    schemaVersion: 1,
    store: { name: '旧门店' },
    api: { baseUrl: 'https://api.example.com' },
    fulfillmentOptions: { delivery: false },
  };
  assert.strictEqual(validateStoreConfig(v1).code, 'STORE_CONFIG_SCHEMA_UNSUPPORTED');

  const current = readConfig(buildProjectFiles(graph(), { mode: 'development', projectName: 'cfg' }).files.get('config/store.generated.js').toString('utf8'));
  current.capabilities = { onlineReady: ['poster-carousel'], previewOnly: ['poster-carousel'] };
  assert.strictEqual(validateStoreConfig(current).code, 'CAPABILITY_INTERSECTION');
});

test('preview-only 在 README 与 capabilities 中呈现', () => {
  const g = graph();
  const previewGraph = { ...g, previewOnly: ['poster-carousel'], onlineReady: [] };
  const readme = buildReadme(previewGraph, { mode: 'development' });
  assert.match(readme, /仅预览资产/);
  assert.match(readme, /poster-carousel/);

  const result = buildProjectFiles(previewGraph, { mode: 'development', projectName: 'cfg' });
  const config = readConfig(result.files.get('config/store.generated.js').toString('utf8'));
  assert.deepStrictEqual(config.capabilities.previewOnly, ['poster-carousel']);
  assert.deepStrictEqual(config.capabilities.onlineReady, []);
});

test('导出工程不含第二份金额事实与秘密', () => {
  const result = buildProjectFiles(graph(), { mode: 'development', projectName: 'cfg' });
  for (const [file, content] of result.files.entries()) {
    if (!/\.(js|json)$/.test(file) || file === 'project.config.json') continue;
    const text = content.toString('utf8');
    assert.ok(!text.includes('priceText'), file + ' 含 priceText');
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(text), file + ' 含疑似密钥');
    assert.ok(!text.includes('AppSecret'), file + ' 含 AppSecret');
    if (file === 'config/store.generated.js') {
      assert.ok(!text.includes('totalCents'), file + ' 含 totalCents（配置不得携带总价，金额唯一事实为领域层计算）');
    }
  }
});