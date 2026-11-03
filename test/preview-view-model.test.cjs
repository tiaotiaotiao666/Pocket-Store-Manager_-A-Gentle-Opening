'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const VALID_THEME = {
  pageBackground: '#F7F3EC',
  primaryColor: '#B34A0F',
  accentColor: '#9C2E12',
  textColor: '#232323',
  tabBarBackground: '#FFFDF9',
  tabBarColor: '#8A8178',
  tabBarSelectedColor: '#B34A0F',
};

function createPlan(overrides = {}) {
  const storeProfile = overrides.storeProfile || {};
  return {
    schemaVersion: 'composition.v1',
    themeTokens: { ...VALID_THEME, ...(overrides.themeTokens || {}) },
    storeProfile: {
      name: '松月食堂',
      category: '社区餐馆',
      businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }],
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [{ name: '宫保鸡丁', priceCents: 2800, description: '微辣' }],
      ...storeProfile,
    },
  };
}

function createSession(overrides = {}) {
  return {
    store: { name: '已确认门店', type: '已确认品类' },
    features: { selected: ['scan-order', 'product-catalog'] },
    build: { selectedId: 'warm-bistro', candidates: [{ id: 'warm-bistro', layout: 'menu' }] },
    visual: { styleId: 'warm' },
    agentDraft: {
      storeName: '草稿门店',
      category: '草稿品类',
      businessHours: '09:00-11:30，18:00-20:00',
      fulfillment: { dineIn: false, takeaway: true },
      dishes: [{ id: 'dish-local', name: '草稿菜', priceCents: 1234, description: '当日现做' }],
    },
    agent: { status: 'collecting', validation: { readyForReview: false } },
    ...overrides,
  };
}

test('完整公共形状由 Plan 投影，整数分格式化且紧凑/完整可共用同一 VM', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan(),
    layout: 'menu',
    featureIds: ['scan-order'],
    draft: { dishes: [{ id: 'dish-local', name: '宫保鸡丁', priceCents: 2800 }] },
  });

  assert.deepStrictEqual(Object.keys(viewModel), [
    'schemaVersion',
    'layout',
    'recipe',
    'blocks',
    'sizes',
    'theme',
    'store',
    'hero',
    'products',
    'menuCountText',
    'tabs',
    'order',
    'capabilities',
  ]);
  assert.strictEqual(viewModel.schemaVersion, 'preview-view-model.v1');
  assert.strictEqual(viewModel.layout, 'menu');
  assert.deepStrictEqual(viewModel.recipe, {
    id: 'order-classic',
    displayName: '经典点餐',
    version: '1.0.0',
  });
  assert.deepStrictEqual(viewModel.blocks, []);
  assert.deepStrictEqual(viewModel.store, {
    name: '松月食堂',
    initial: '松',
    category: '社区餐馆',
    businessHoursText: '10:00-14:00，17:00-21:00',
    fulfillmentText: '堂食',
    subtitle: '社区餐馆 · 堂食',
    tagline: '',
  });
  assert.deepStrictEqual(viewModel.products, [{
    key: 'dish-local',
    name: '宫保鸡丁',
    note: '微辣',
    priceCents: 2800,
    priceDisplay: '28.00',
    thumbnail: 'theme-gradient',
  }]);
  assert.strictEqual(viewModel.menuCountText, '共 1 道');
  assert.deepStrictEqual(viewModel.capabilities, [{ key: 'scan-order', label: '扫码点餐' }]);
});

test('draft 只提供本地菜品 key，任何草稿展示值都不得覆盖 Plan', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const plan = createPlan({
    storeProfile: {
      name: 'Plan 门店',
      category: 'Plan 品类',
      businessHours: [{ start: '08:00', end: '09:00' }],
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [{ name: 'Plan 菜品', priceCents: 2800, description: 'Plan 描述' }],
    },
  });
  const viewModel = buildPreviewViewModel({
    plan,
    draft: {
      storeName: '草稿门店',
      category: '草稿品类',
      businessHours: '22:00-23:00',
      fulfillment: { dineIn: false, takeaway: true },
      dishes: [{ id: 'local-only-id', name: '草稿菜品', priceCents: 1, description: '草稿描述', priceText: '0.01' }],
    },
  });

  assert.strictEqual(viewModel.store.name, 'Plan 门店');
  assert.strictEqual(viewModel.store.category, 'Plan 品类');
  assert.strictEqual(viewModel.store.businessHoursText, '08:00-09:00');
  assert.strictEqual(viewModel.store.fulfillmentText, '堂食');
  assert.strictEqual(viewModel.products[0].key, 'local-only-id');
  assert.strictEqual(viewModel.products[0].name, 'Plan 菜品');
  assert.strictEqual(viewModel.products[0].note, 'Plan 描述');
  assert.strictEqual(viewModel.products[0].priceDisplay, '28.00');
});

test('readyForReview=false 的 session 仍逐字段投影五类安全草稿', async () => {
  const { buildSessionPreviewViewModels } = await import('../src/composition/previewViewModel.mjs');
  const state = createSession();
  const snapshot = JSON.stringify(state);
  const { selected } = buildSessionPreviewViewModels(state);

  assert.strictEqual(state.agent.validation.readyForReview, false);
  assert.strictEqual(selected.store.name, '草稿门店');
  assert.strictEqual(selected.store.category, '草稿品类');
  assert.strictEqual(selected.store.businessHoursText, '09:00-11:30，18:00-20:00');
  assert.strictEqual(selected.store.fulfillmentText, '到店自取');
  assert.deepStrictEqual(selected.products.map(({ key, name, priceCents, priceDisplay }) => (
    { key, name, priceCents, priceDisplay }
  )), [{ key: 'dish-local', name: '草稿菜', priceCents: 1234, priceDisplay: '12.34' }]);
  assert.strictEqual(JSON.stringify(state), snapshot);
});

test('安全部分草稿的缺名、空品类、无营业时段与无履约方式均有明确回落', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan({
      storeProfile: {
        name: '',
        category: '',
        businessHours: [],
        fulfillment: { dineIn: false, takeaway: false },
        dishes: [{ name: '', priceCents: null }],
      },
    }),
  });

  assert.strictEqual(viewModel.store.name, '我的餐馆');
  assert.strictEqual(viewModel.store.initial, '我');
  assert.strictEqual(viewModel.store.category, '品类待完善');
  assert.strictEqual(viewModel.store.businessHoursText, '营业时间待完善');
  assert.strictEqual(viewModel.store.fulfillmentText, '取餐方式待完善');
  assert.strictEqual(viewModel.store.subtitle, '品类待完善 · 取餐方式待完善');
  assert.strictEqual(viewModel.products.length, 4);
  assert.ok(viewModel.products.every((product) => product.key.startsWith('sample-dish-')));
});

test('营业时段仅保留 HH:MM-HH:MM，并以中文逗号连接', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan({
      storeProfile: {
        businessHours: [
          { start: '09:00', end: '12:00' },
          { start: '25:00', end: '13:00' },
          null,
          { start: '18:00', end: '20:30' },
        ],
      },
    }),
  });
  assert.strictEqual(viewModel.store.businessHoursText, '09:00-12:00，18:00-20:30');
});

test('fulfillmentText/subtitle 只读 Plan 履约字段，不由 features 反推', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const takeaway = buildPreviewViewModel({
    plan: createPlan({ storeProfile: { fulfillment: { dineIn: false, takeaway: true } } }),
    featureIds: ['table-dining'],
  });
  assert.strictEqual(takeaway.store.fulfillmentText, '到店自取');
  assert.strictEqual(takeaway.store.subtitle, '社区餐馆 · 到店自取');

  const dineIn = buildPreviewViewModel({
    plan: createPlan({ storeProfile: { fulfillment: { dineIn: true, takeaway: false } } }),
    featureIds: ['takeaway'],
  });
  assert.strictEqual(dineIn.store.fulfillmentText, '堂食');

  const both = buildPreviewViewModel({
    plan: createPlan({ storeProfile: { fulfillment: { dineIn: true, takeaway: true } } }),
  });
  assert.strictEqual(both.store.fulfillmentText, '堂食 · 到店自取');
});

test('菜品仅接受 1..999999 整数 priceCents，priceText 不参与金额展示', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan({
      storeProfile: {
        dishes: [
          { name: '最低价', priceCents: 1, priceText: '999.99' },
          { name: '零价', priceCents: 0 },
          { name: '负价', priceCents: -1 },
          { name: '小数分', priceCents: 1.5 },
          { name: '字符串分', priceCents: '2800' },
          { name: '超上限', priceCents: 1000000 },
          { name: '最高价', priceCents: 999999, priceText: '0.01' },
          { name: '价格文本忽略', priceCents: 2800, priceText: '999.99' },
          { name: '', priceCents: 100 },
        ],
      },
    }),
  });

  assert.deepStrictEqual(viewModel.products.map((product) => ({
    name: product.name,
    priceCents: product.priceCents,
    priceDisplay: product.priceDisplay,
  })), [
    { name: '最低价', priceCents: 1, priceDisplay: '0.01' },
    { name: '最高价', priceCents: 999999, priceDisplay: '9999.99' },
    { name: '价格文本忽略', priceCents: 2800, priceDisplay: '28.00' },
  ]);
});

test('无合法 Plan 菜品时使用四个既有示例商品及固定 sample key', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan({ storeProfile: { dishes: [{ name: '非法', priceCents: 0 }] } }),
    draft: { dishes: [{ id: 'must-not-leak', name: '草稿商品', priceCents: 100 }] },
  });

  assert.deepStrictEqual(viewModel.products, [
    { key: 'sample-dish-1', name: '门店招牌饭', note: '现点现做', priceCents: 2800, priceDisplay: '28.00', thumbnail: 'theme-gradient' },
    { key: 'sample-dish-2', name: '时令小食拼盘', note: '清爽分享', priceCents: 1600, priceDisplay: '16.00', thumbnail: 'theme-gradient' },
    { key: 'sample-dish-3', name: '自选鲜泡茶', note: '每日现泡', priceCents: 1000, priceDisplay: '10.00', thumbnail: 'theme-gradient' },
    { key: 'sample-dish-4', name: '今日限定', note: '售完即止', priceCents: 2200, priceDisplay: '22.00', thumbnail: 'theme-gradient' },
  ]);
  assert.strictEqual(viewModel.menuCountText, '共 4 道');
});

test('商品 key 优先本地 ID、稳定去重，缺失时回退且不使用数组下标', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const dishes = [
    { name: '招牌饭', priceCents: 2800 },
    { name: '招牌饭', priceCents: 2800 },
    { name: '同名菜', priceCents: 100 },
    { name: '无本地 ID', priceCents: 200 },
  ];
  const draft = {
    dishes: [
      { id: 'dish-local', name: '招牌饭', priceCents: 2800 },
      { id: 'dish-local', name: '招牌饭', priceCents: 2800 },
      { id: '', name: '同名菜', priceCents: 100 },
      { name: '无本地 ID', priceCents: 200 },
    ],
  };
  const options = { plan: createPlan({ storeProfile: { dishes } }), draft };
  const first = buildPreviewViewModel(options);
  const second = buildPreviewViewModel(options);
  const keys = first.products.map((product) => product.key);

  assert.deepStrictEqual(keys, [
    'dish-local',
    'dish-local#2',
    'dish:同名菜:100',
    'dish:无本地 ID:200',
  ]);
  assert.strictEqual(new Set(keys).size, dishes.length);
  assert.ok(keys.every((key) => !['0', '1', '2', '3'].includes(key)));
  assert.deepStrictEqual(first, second);
});

test('非法 Plan 菜品被过滤后仍与正确的草稿本地 ID 对齐', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan({
      storeProfile: {
        dishes: [
          { name: '零价过滤', priceCents: 0 },
          { name: '保留菜', priceCents: 100 },
        ],
      },
    }),
    draft: {
      dishes: [
        { id: 'invalid-id', name: '零价过滤', priceCents: 0 },
        { id: 'valid-id', name: '保留菜', priceCents: 100 },
      ],
    },
  });
  assert.strictEqual(viewModel.products.length, 1);
  assert.strictEqual(viewModel.products[0].key, 'valid-id');
});

test('三种布局与未知布局共用同一白名单 hero 投影', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const menu = buildPreviewViewModel({ plan: createPlan(), layout: 'menu' });
  const catalog = buildPreviewViewModel({ plan: createPlan(), layout: 'catalog' });
  const editorial = buildPreviewViewModel({ plan: createPlan(), layout: 'editorial' });
  const unknown = buildPreviewViewModel({ plan: createPlan(), layout: 'unknown' });

  assert.strictEqual(menu.hero.sectionTitle, '本店推荐');
  assert.strictEqual(menu.hero.story, null);
  assert.strictEqual(catalog.hero.sectionTitle, '今日精选');
  assert.strictEqual(catalog.hero.title, '从一杯开始');
  assert.strictEqual(editorial.hero.sectionTitle, '主厨故事');
  assert.strictEqual(editorial.hero.story, '从清晨备料到晚间收档，这家店只做当天的新鲜。');
  assert.strictEqual(unknown.layout, 'menu');
  assert.deepStrictEqual(unknown.hero, menu.hero);
});

test('tabs 固定四种及顺序，演示订单步骤具有稳定 key 和状态', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({ plan: createPlan() });
  assert.deepStrictEqual(viewModel.tabs, [
    { id: 'home', label: '首页', icon: 'home' },
    { id: 'menu', label: '菜单', icon: 'menu' },
    { id: 'orders', label: '订单', icon: 'orders' },
    { id: 'mine', label: '我的', icon: 'mine' },
  ]);
  assert.deepStrictEqual(viewModel.order, {
    number: '#20261031',
    context: '堂食 · 3 号桌',
    status: '制作中',
    estimate: '预计 20 分钟后可取餐',
    steps: [
      { key: 'order-placed', label: '已下单', state: 'done' },
      { key: 'order-preparing', label: '制作中', state: 'current' },
      { key: 'order-ready', label: '可取餐', state: 'pending' },
    ],
  });
});

test('主题颜色逐项校验 #RRGGBB，缺失或非法项回落 warm-orange', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const invalid = buildPreviewViewModel({
    plan: createPlan({
      themeTokens: {
        pageBackground: '#FFF',
        primaryColor: 'orange',
        accentColor: '#GG0000',
        textColor: '',
        tabBarBackground: null,
        tabBarColor: '#12345',
        tabBarSelectedColor: '123456',
      },
    }),
  });
  assert.deepStrictEqual(invalid.theme, VALID_THEME);

  const mixed = buildPreviewViewModel({
    plan: createPlan({ themeTokens: { pageBackground: '#aBcDeF', primaryColor: 'invalid' } }),
  });
  assert.strictEqual(mixed.theme.pageBackground, '#aBcDeF');
  assert.strictEqual(mixed.theme.primaryColor, VALID_THEME.primaryColor);
  assert.strictEqual(mixed.theme.accentColor, VALID_THEME.accentColor);
});

test('capabilities 使用 catalog label、去重且最多四项', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: createPlan(),
    featureIds: [
      'scan-order',
      'loyalty-membership',
      'scan-order',
      'not-in-catalog',
      'product-catalog',
      'cart-checkout',
    ],
  });
  assert.deepStrictEqual(viewModel.capabilities, [
    { key: 'scan-order', label: '扫码点餐' },
    { key: 'loyalty-membership', label: '会员积分' },
    { key: 'not-in-catalog', label: 'not-in-catalog' },
    { key: 'product-catalog', label: '商品与菜单' },
  ]);
});

test('session selector 的 selected 与选中模板 VM 引用相等，重复 ID 取首个', async () => {
  const { buildSessionPreviewViewModels } = await import('../src/composition/previewViewModel.mjs');
  const state = createSession({
    build: {
      selectedId: 'duplicate',
      candidates: [
        { id: 'duplicate', layout: 'catalog' },
        { id: 'duplicate', layout: 'editorial' },
        { id: 'other', layout: 'unknown-layout' },
      ],
    },
  });
  const result = buildSessionPreviewViewModels(state);

  assert.deepStrictEqual(Object.keys(result.byTemplateId), ['duplicate', 'other']);
  assert.strictEqual(result.selected, result.byTemplateId.duplicate);
  assert.strictEqual(result.selected.layout, 'catalog');
  assert.strictEqual(result.byTemplateId.other.layout, 'menu');
});

test('无候选时 selected.layout=menu；未知 selectedId 回落首个候选', async () => {
  const { buildSessionPreviewViewModels } = await import('../src/composition/previewViewModel.mjs');
  const empty = buildSessionPreviewViewModels(createSession({
    build: { selectedId: null, candidates: [] },
  }));
  assert.strictEqual(empty.selected.layout, 'menu');
  assert.deepStrictEqual(empty.byTemplateId, {});

  const fallback = buildSessionPreviewViewModels(createSession({
    build: {
      selectedId: 'missing',
      candidates: [{ id: 'first', layout: 'editorial' }, { id: 'second', layout: 'catalog' }],
    },
  }));
  assert.strictEqual(fallback.selected, fallback.byTemplateId.first);
  assert.strictEqual(fallback.selected.layout, 'editorial');
});

test('builder 与 selector 对同一输入深相等且不修改嵌套输入，异常形状安全回落', async () => {
  const { buildPreviewViewModel, buildSessionPreviewViewModels } = await import('../src/composition/previewViewModel.mjs');
  const options = {
    plan: createPlan(),
    layout: 'editorial',
    featureIds: ['scan-order'],
    draft: { dishes: [{ id: 'local', name: '宫保鸡丁', priceCents: 2800 }] },
  };
  const optionsSnapshot = JSON.stringify(options);
  assert.deepStrictEqual(buildPreviewViewModel(options), buildPreviewViewModel(options));
  assert.strictEqual(JSON.stringify(options), optionsSnapshot);

  const state = createSession();
  const stateSnapshot = JSON.stringify(state);
  assert.deepStrictEqual(buildSessionPreviewViewModels(state), buildSessionPreviewViewModels(state));
  assert.strictEqual(JSON.stringify(state), stateSnapshot);

  const fallback = buildPreviewViewModel(null);
  assert.strictEqual(fallback.schemaVersion, 'preview-view-model.v1');
  assert.strictEqual(fallback.layout, 'menu');
  assert.strictEqual(fallback.products.length, 4);
  const emptySession = buildSessionPreviewViewModels(null);
  assert.strictEqual(emptySession.selected.layout, 'menu');
});