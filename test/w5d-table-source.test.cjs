'use strict';

/**
 * W5d：桌号真源统一（首页 / 菜单 / 结算共用 domain/tableOptions）与镜像身份门禁。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const BASE = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const STORE_PATH = path.join(BASE, 'services', 'store.js');
const TABLE_OPTIONS_PATH = path.join(BASE, 'domain', 'tableOptions.js');

function loadTableOptionsWith(getTables) {
  const previous = require.cache[STORE_PATH];
  require.cache[STORE_PATH] = {
    id: STORE_PATH,
    filename: STORE_PATH,
    loaded: true,
    exports: { getTables },
  };
  delete require.cache[TABLE_OPTIONS_PATH];
  const module = require(TABLE_OPTIONS_PATH);
  // 还原缓存，避免污染其它测试
  if (previous) require.cache[STORE_PATH] = previous;
  else delete require.cache[STORE_PATH];
  return module;
}

test('桌号映射：过滤非法项，名称缺失时回退到 id', () => {
  const { mapTables } = loadTableOptionsWith(async () => ({ tables: [] }));
  const mapped = mapTables({
    tables: [
      { id: 'tbl_A01', name: 'A01' },
      { id: 'tbl_B02' },
      { name: '没有 id' },
      null,
      { id: '' },
    ],
  });
  assert.deepStrictEqual(mapped, [
    { id: 'tbl_A01', name: 'A01' },
    { id: 'tbl_B02', name: 'tbl_B02' },
  ]);
});

test('桌号加载成功：返回映射后的列表，不带错误', async () => {
  const { loadTableOptions } = loadTableOptionsWith(async () => ({
    tables: [{ id: 'tbl_A01', name: 'A01' }, { id: 'tbl_A02', name: 'A02' }],
  }));
  const patch = await loadTableOptions('store-demo-001');
  assert.deepStrictEqual(patch.tableOptions, [
    { id: 'tbl_A01', name: 'A01' },
    { id: 'tbl_A02', name: 'A02' },
  ]);
  assert.strictEqual(patch.tablesLoading, false);
  assert.strictEqual(patch.tablesError, '');
});

test('桌号空列表：保持空态，不塞入任何固定桌号', async () => {
  const { loadTableOptions } = loadTableOptionsWith(async () => ({ tables: [] }));
  const patch = await loadTableOptions('store-demo-001');
  assert.deepStrictEqual(patch.tableOptions, []);
  assert.strictEqual(patch.tablesError, '');
});

test('桌号请求失败：清空列表并给出错误文案，不回退 A01/A02', async () => {
  const { loadTableOptions } = loadTableOptionsWith(async () => {
    throw new Error('network down');
  });
  const patch = await loadTableOptions('store-demo-001');
  assert.deepStrictEqual(patch.tableOptions, []);
  assert.strictEqual(patch.tablesLoading, false);
  assert.ok(typeof patch.tablesError === 'string' && patch.tablesError.length > 0);
  assert.ok(!patch.tableOptions.some((item) => item.id === 'tbl_A01' || item.name === 'A01'));
});

test('缺少门店标识：直接进入错误态，不发起请求', async () => {
  let called = 0;
  const { loadTableOptions } = loadTableOptionsWith(async () => {
    called += 1;
    return { tables: [] };
  });
  const patch = await loadTableOptions('');
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(patch.tableOptions, []);
  assert.ok(patch.tablesError.includes('缺少门店标识'));
});

test('扫码只带 tableId 时用后端列表翻译桌号名称', () => {
  const { nameOfTable } = loadTableOptionsWith(async () => ({ tables: [] }));
  const list = [{ id: 'tbl_A01', name: 'A01' }, { id: 'tbl_B02', name: 'B02' }];
  assert.strictEqual(nameOfTable(list, 'tbl_A01'), 'A01');
  assert.strictEqual(nameOfTable(list, 'tbl_unknown'), '');
  assert.strictEqual(nameOfTable(list, ''), '');
  assert.strictEqual(nameOfTable(null, 'tbl_A01'), '');
});

test('三个页面共用同一桌号实现，且源码里不再有 DEMO_TABLES', () => {
  const pages = ['home', 'menu', 'checkout'];
  pages.forEach((name) => {
    const js = fs.readFileSync(path.join(BASE, 'pages', name, 'index.js'), 'utf8');
    assert.ok(!/DEMO_TABLES/.test(js), name + ' 页面仍引用 DEMO_TABLES');
    assert.match(js, /tableOptionsDomain\.loadTableOptions/, name + ' 未复用 domain/tableOptions');
    assert.match(js, /tablesLoading/, name + ' 缺少 tablesLoading 状态');
    assert.match(js, /tablesError/, name + ' 缺少 tablesError 状态');
    assert.match(js, /onRetryTables/, name + ' 缺少重试入口');

    const wxml = fs.readFileSync(path.join(BASE, 'pages', name, 'index.wxml'), 'utf8');
    assert.match(wxml, /tablesLoading/, name + ' 模板未渲染加载中');
    assert.match(wxml, /tablesError/, name + ' 模板未渲染失败态');
    assert.match(wxml, /onRetryTables/, name + ' 模板未渲染重试按钮');
    assert.match(wxml, /还没有可用桌号/, name + ' 模板未渲染空列表文案');
  });
});

test('环境配置不再导出 DEMO_TABLES，版本守卫不再提供桌号兜底', () => {
  const env = require(path.join(BASE, 'config', 'env.js'));
  assert.strictEqual(env.DEMO_TABLES, undefined);
  const guard = require(path.join(BASE, 'domain', 'versionGuard.js'));
  assert.strictEqual(guard.resolveTables, undefined);
});

test('visit-store 不再按固定桌号翻译名称', () => {
  const visitStore = require(path.join(BASE, 'state', 'visit-store.js'));
  assert.strictEqual(visitStore.resolveTableName('tbl_A01'), '');
  visitStore.setTable('tbl_A01', 'A01');
  assert.strictEqual(visitStore.load().tableName, 'A01');
  visitStore.setTable('', '');
});

test('miniprogram/ 是受控镜像：清单存在、声明非交付物、摘要与内容一致', () => {
  const mirror = require(path.join(REPO, 'scripts', 'sync-miniprogram-mirror.cjs'));
  const manifest = mirror.readManifest();
  assert.ok(manifest, '缺少 miniprogram/MIRROR.json');
  assert.strictEqual(manifest.role, 'mirror');
  assert.strictEqual(manifest.deliverable, false);
  assert.strictEqual(manifest.sourceOfTruth, 'templates/base/ordering-base/1.0.0/src');
  const verdict = mirror.verifyMirrorManifest();
  assert.strictEqual(verdict.ok, true, verdict.error);
});
