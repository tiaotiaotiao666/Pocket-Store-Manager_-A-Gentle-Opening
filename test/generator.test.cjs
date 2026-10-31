const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeProject, safeProjectName } = require('../scripts/generate-mini-program.cjs');

test('project name is sanitized and bounded', () => {
  assert.equal(safeProjectName('../松月 食堂'), '松月-食堂');
  assert.ok(safeProjectName('x'.repeat(80)).length <= 36);
});

test('export creates an independently importable mini-program with store configuration', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-store-export-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const output = await writeProject(parent, {
    storeName: '测试小馆',
    template: { id: 'warm-bistro' },
    features: ['table-dining'],
    generatedModules: ['table-dining'],
    pendingFeatures: ['loyalty-membership'],
    theme: { id: 'jade', colors: ['#F0F4EF', '#47745D', '#D7A24D', '#24342D'] },
    icons: [],
  });
  const requiredFiles = [
    'app.js', 'app.json', 'app.wxss', 'project.config.json', 'sitemap.json',
    'pages/home/index.js', 'pages/menu/index.wxml', 'pages/orders/index.js', 'pages/mine/index.wxml',
    'config/store.generated.js', 'README.md',
  ];
  for (const relative of requiredFiles) await fs.access(path.join(output, relative));
  const configPath = path.join(output, 'config/store.generated.js');
  t.after(() => { delete require.cache[require.resolve(configPath)]; });
  const config = require(configPath);
  await assert.rejects(fs.access(path.join(output, 'config/store.generated.json')));
  for (const relative of ['app.js', 'pages/home/index.js', 'pages/menu/index.js', 'pages/mine/index.js']) {
    const source = await fs.readFile(path.join(output, relative), 'utf8');
    assert.match(source, /require\('[^']*store\.generated'\)/);
    assert.doesNotMatch(source, /store\.generated\.json/);
  }
  assert.equal(config.store.name, '测试小馆');
  assert.equal(config.theme.id, 'jade');
  const wxss = await fs.readFile(path.join(output, 'app.wxss'), 'utf8');
  assert.match(wxss, /--store-primary:#47745D/);
  assert.equal(config.catalog[0].products[0].priceCents, 2800);
  assert.equal(config.catalog[0].products[0].priceText, '28.00');
  assert.equal(config.fulfillmentOptions.delivery, false);
  assert.deepEqual(config.capabilities.pendingImplementation, ['loyalty-membership']);
  const app = JSON.parse(await fs.readFile(path.join(output, 'app.json'), 'utf8'));
  assert.equal(app.pages.length, 4);
  const project = JSON.parse(await fs.readFile(path.join(output, 'project.config.json'), 'utf8'));
  assert.equal(project.appid, 'touristappid');
  assert.equal(project.compileType, 'miniprogram');
  const readme = await fs.readFile(path.join(output, 'README.md'), 'utf8');
  assert.match(readme, /正式开发时，请在微信开发者工具中使用店主自己的小程序账号和 AppID/);
  assert.match(readme, /不含线上订单后端/);
});
