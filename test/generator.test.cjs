'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { compose } = require('../scripts/composer/index.cjs');
const plan = require('../templates/recipes/order-classic/1.0.0/plan.json');

function readConfig(text) {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(text, sandbox);
  return sandbox.module.exports;
}

test('Composer 生成可独立导入的小程序工程（产物契约）', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-store-export-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const result = await compose({ plan, parentDir: parent, projectName: '测试小馆', mode: 'development' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const output = result.outputPath;

  const requiredFiles = [
    'app.js', 'app.json', 'app.wxss', 'project.config.json', 'sitemap.json',
    'pages/home/index.js', 'pages/menu/index.wxml', 'pages/orders/index.js', 'pages/mine/index.wxml',
    'config/store.generated.js', 'config/env.js', 'theme.generated.wxss',
    'composition.lock.json', 'generation-report.json', 'README.md',
  ];
  for (const relative of requiredFiles) {
    await fs.access(path.join(output, relative));
  }
  await assert.rejects(fs.access(path.join(output, 'config/store.generated.json')));

  const config = readConfig(await fs.readFile(path.join(output, 'config/store.generated.js'), 'utf8'));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.store.name, '柑橘小馆');
  assert.equal(config.fulfillmentOptions.delivery, false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'priceText'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'icons'), false);
  assert.deepEqual(Object.keys(config.meta).sort(), [
    'apiContractVersion', 'catalogVersion', 'configSchemaVersion', 'generatedAt', 'generatorVersion',
    'lockDigest', 'mode', 'planDigest', 'recipeId', 'recipeVersion', 'storeConfigVersion', 'versionGaps',
  ].sort());

  const theme = await fs.readFile(path.join(output, 'theme.generated.wxss'), 'utf8');
  assert.match(theme, /--store-primary-color: #B34A0F/);
  assert.doesNotMatch(theme, /--store-primary:/);

  const app = JSON.parse(await fs.readFile(path.join(output, 'app.json'), 'utf8'));
  assert.equal(app.pages.length, 7);

  const project = JSON.parse(await fs.readFile(path.join(output, 'project.config.json'), 'utf8'));
  assert.equal(project.appid, 'touristappid');
  assert.equal(project.compileType, 'miniprogram');

  const env = await fs.readFile(path.join(output, 'config/env.js'), 'utf8');
  assert.match(env, /require\('\.\/store\.generated\.js'\)/);
  assert.doesNotMatch(env, /process\.env/);

  const readme = await fs.readFile(path.join(output, 'README.md'), 'utf8');
  assert.match(readme, /微信开发者工具/);
  assert.match(readme, /演示付款，不产生真实交易/);
});