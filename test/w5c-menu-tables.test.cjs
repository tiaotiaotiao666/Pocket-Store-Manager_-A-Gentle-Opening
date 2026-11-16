const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// W5c：菜单页桌号必须来自真实后端 /stores/:id/tables，
// 加载中 / 空列表 / 请求失败 / 重试四种状态都要可断言，且绝不回退固定演示桌号。
const SRC = path.join(__dirname, '..', 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const STORE_SERVICE = path.join(SRC, 'services', 'store.js');
const MENU_JS = path.join(SRC, 'pages', 'menu', 'index.js');
const MENU_WXML = path.join(SRC, 'pages', 'menu', 'index.wxml');

function loadMenuPage(getTables) {
  const storeServicePath = require.resolve(STORE_SERVICE);
  const original = require.cache[storeServicePath];
  require.cache[storeServicePath] = {
    id: storeServicePath,
    filename: storeServicePath,
    loaded: true,
    exports: {
      getTables,
      getStore: async () => ({ id: 'store-demo-001', name: '柑橘小馆' }),
      getCatalog: async () => ({ categories: [] }),
    },
  };
  delete require.cache[require.resolve(MENU_JS)];
  let captured = null;
  const previousPage = global.Page;
  global.Page = (definition) => {
    captured = definition;
  };
  try {
    require(MENU_JS);
  } finally {
    global.Page = previousPage;
    if (original) {
      require.cache[storeServicePath] = original;
    } else {
      delete require.cache[storeServicePath];
    }
  }
  return captured;
}

function makeInstance(definition) {
  const instance = Object.assign({}, definition);
  instance.data = JSON.parse(JSON.stringify(definition.data));
  instance.setData = (patch) => Object.assign(instance.data, patch);
  return instance;
}

test('W5c 桌号：成功时把后端 tables 映射成桌号选项', async () => {
  const definition = loadMenuPage(async () => ({
    storeId: 'store-demo-001',
    tables: [{ id: 'tbl_A01', name: 'A01' }, { id: 'tbl_B02' }],
  }));
  const page = makeInstance(definition);
  await definition.loadTables.call(page, 'store-demo-001');
  assert.deepEqual(page.data.tableOptions, [
    { id: 'tbl_A01', name: 'A01' },
    { id: 'tbl_B02', name: 'tbl_B02' },
  ]);
  assert.equal(page.data.tablesLoading, false);
  assert.equal(page.data.tablesError, '');
});

test('W5c 桌号：后端返回空列表时保持空态，不塞演示桌号', async () => {
  const definition = loadMenuPage(async () => ({ storeId: 'store-demo-001', tables: [] }));
  const page = makeInstance(definition);
  await definition.loadTables.call(page, 'store-demo-001');
  assert.deepEqual(page.data.tableOptions, []);
  assert.equal(page.data.tablesLoading, false);
  assert.equal(page.data.tablesError, '');
});

test('W5c 桌号：请求失败时进入错误态并清空列表，不回退 A01/A02', async () => {
  const definition = loadMenuPage(async () => {
    throw new Error('网络不可用');
  });
  const page = makeInstance(definition);
  await definition.loadTables.call(page, 'store-demo-001');
  assert.deepEqual(page.data.tableOptions, []);
  assert.equal(page.data.tablesLoading, false);
  assert.ok(page.data.tablesError.length > 0, '必须给出可展示的失败文案');
});

test('W5c 桌号：失败后重试可恢复真实数据', async () => {
  let attempt = 0;
  const definition = loadMenuPage(async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('网络不可用');
    }
    return { storeId: 'store-demo-001', tables: [{ id: 'tbl_A01', name: 'A01' }] };
  });
  const page = makeInstance(definition);
  await definition.loadTables.call(page, 'store-demo-001');
  assert.ok(page.data.tablesError.length > 0);
  definition.onRetryTables.call(page);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.tablesError, '');
  assert.deepEqual(page.data.tableOptions, [{ id: 'tbl_A01', name: 'A01' }]);
});

test('W5c 桌号：页面不再引用 DEMO_TABLES，模板覆盖加载/空/失败/重试四态', () => {
  const js = fs.readFileSync(MENU_JS, 'utf8');
  const wxml = fs.readFileSync(MENU_WXML, 'utf8');
  assert.equal(/DEMO_TABLES/.test(js), false, '菜单页不得把演示桌号当业务数据源');
  assert.ok(wxml.includes('tablesLoading'), '缺加载中状态');
  assert.ok(wxml.includes('tablesError'), '缺失败状态');
  assert.ok(wxml.includes('onRetryTables'), '缺重试入口');
  assert.ok(wxml.includes('当前门店还没有可用桌号'), '缺空列表状态');
  // 组件宿主锚点（W5c 交互补验依赖）
  assert.ok(wxml.includes('id="menu-category-nav"'), '缺分类组件宿主锚点');
  assert.ok(wxml.includes('id="menu-product-{{item.id}}"'), '缺菜品组件宿主锚点');
  assert.ok(wxml.includes('id="menu-cart-bar"'), '缺购物车组件宿主锚点');
});
