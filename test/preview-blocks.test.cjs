'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const THEME = {
  pageBackground: '#F7F3EC',
  primaryColor: '#B34A0F',
  accentColor: '#9C2E12',
  textColor: '#232323',
};

function basePlan(overrides = {}) {
  return {
    schemaVersion: 'composition.v1',
    planId: 'order-classic',
    planVersion: '1.0.0',
    themeTokens: THEME,
    storeProfile: {
      name: '松月食堂',
      category: '社区餐馆',
      businessHours: [{ start: '10:00', end: '21:00' }],
      fulfillment: { dineIn: true, takeaway: true },
      dishes: [{ name: '宫保鸡丁', priceCents: 2800, description: '微辣' }],
    },
    features: [],
    components: [],
    ...overrides,
  };
}

function posterPlan(props) {
  return basePlan({
    planId: 'order-poster',
    features: [{
      id: 'poster-carousel',
      version: '1.0.0',
      slots: [{ slotId: 'home-hero', pageId: 'home', dataKey: 'homeHero', props }],
    }],
  });
}

test('无 features 的 Plan 不产生任何预览块，recipe 回落到经典点餐', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({ plan: basePlan() });

  assert.deepStrictEqual(viewModel.blocks, []);
  assert.strictEqual(viewModel.recipe.id, 'order-classic');
});

test('order-poster 的 home-hero 插槽投影成一个 poster-carousel 块', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: posterPlan({
      items: [
        { id: 'a', title: '秋日暖锅上新', subtitle: '两人份', tone: 'warm' },
        { id: 'b', title: '午后茶点', subtitle: '', tone: 'green' },
      ],
      autoplay: true,
      interval: 4000,
      showIndicator: true,
    }),
  });

  assert.strictEqual(viewModel.recipe.id, 'order-poster');
  assert.strictEqual(viewModel.recipe.displayName, '海报点餐');
  assert.deepStrictEqual(viewModel.blocks, [{
    id: 'poster-carousel',
    pageId: 'home',
    slotId: 'home-hero',
    dataKey: 'homeHero',
    size: 'md',
    props: {
      items: [
        { id: 'a', title: '秋日暖锅上新', subtitle: '两人份', tone: 'warm' },
        { id: 'b', title: '午后茶点', subtitle: '', tone: 'green' },
      ],
      autoplay: true,
      interval: 4000,
      showIndicator: true,
    },
  }]);
});

test('未登记的 Feature、错位插槽与缺 dataKey 都不会生成假块', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');

  const unknownFeature = buildPreviewViewModel({
    plan: basePlan({
      features: [{ id: 'coupon-card', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: 'homeHero', props: { items: [] } }] }],
    }),
  });
  assert.deepStrictEqual(unknownFeature.blocks, []);

  const wrongSlot = buildPreviewViewModel({
    plan: basePlan({
      features: [{ id: 'poster-carousel', version: '1.0.0', slots: [{ slotId: 'menu-aside', dataKey: 'menuAside', props: { items: [] } }] }],
    }),
  });
  assert.deepStrictEqual(wrongSlot.blocks, []);

  const missingDataKey = buildPreviewViewModel({
    plan: basePlan({
      features: [{ id: 'poster-carousel', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: '', props: { items: [] } }] }],
    }),
  });
  assert.deepStrictEqual(missingDataKey.blocks, []);
});

test('海报 props 按 manifest 契约清洗：非法语气、空标题、超长文本与 item 上限', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const longTitle = '超'.repeat(60);
  const longSubtitle = '述'.repeat(90);
  const items = [
    { id: 'ok', title: '  正常标题  ', subtitle: longSubtitle, tone: 'green' },
    { id: 'bad-tone', title: '非法语气', subtitle: '', tone: 'rainbow' },
    { id: '', title: '', subtitle: '无标题应被丢弃', tone: 'warm' },
    { id: '', title: '缺id补位', subtitle: '', tone: 'ink' },
    { id: 'long', title: longTitle, subtitle: '', tone: 'ink' },
    { id: 'i5', title: '第五张', subtitle: '', tone: 'warm' },
    { id: 'i6', title: '第六张', subtitle: '', tone: 'warm' },
    { id: 'i7', title: '第七张', subtitle: '', tone: 'warm' },
  ];
  const viewModel = buildPreviewViewModel({
    plan: posterPlan({ items, autoplay: false, interval: 4000, showIndicator: true }),
  });

  const props = viewModel.blocks[0].props;
  assert.strictEqual(props.items.length, 6, '过滤掉无标题项后仍最多保留 6 张');
  assert.deepStrictEqual(props.items[0], {
    id: 'ok',
    title: '正常标题',
    subtitle: longSubtitle.slice(0, 40),
    tone: 'green',
  });
  assert.strictEqual(props.items[1].tone, 'warm', '非法语气回落 warm');
  assert.strictEqual(props.items[2].id, 'poster-4', '缺失 id 时按 Plan 内原始序号补位，过滤不影响其它 item 的 id');
  assert.strictEqual(props.items[3].title, longTitle.slice(0, 24));
  assert.deepStrictEqual(
    props.items.map((item) => item.title),
    ['正常标题', '非法语气', '缺id补位', longTitle.slice(0, 24), '第五张', '第六张'],
  );
});

test('interval 越界钳制到 3000–8000ms，非数值回落 4000，autoplay 只接受布尔 true', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const read = (props) => buildPreviewViewModel({
    plan: posterPlan({ items: [{ id: 'a', title: 'A', subtitle: '', tone: 'warm' }], ...props }),
  }).blocks[0].props;

  assert.strictEqual(read({ interval: 100 }).interval, 3000);
  assert.strictEqual(read({ interval: 99999 }).interval, 8000);
  assert.strictEqual(read({ interval: 4999.6 }).interval, 5000);
  assert.strictEqual(read({ interval: 'fast' }).interval, 4000);
  assert.strictEqual(read({ interval: null }).interval, 4000);
  assert.strictEqual(read({ autoplay: true }).autoplay, true);
  assert.strictEqual(read({ autoplay: false }).autoplay, false);
  assert.strictEqual(read({ autoplay: 'yes' }).autoplay, false);
  assert.strictEqual(read({ autoplay: 1 }).autoplay, false);
  assert.strictEqual(read({ showIndicator: 'yes' }).showIndicator, false);
});

test('海报 props 不投影 image，避免把 Plan 里的未校验资源地址渲染出去', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const viewModel = buildPreviewViewModel({
    plan: posterPlan({
      items: [{ id: 'a', title: '有图', subtitle: '', tone: 'warm', image: 'https://evil.example/x.png' }],
      showIndicator: false,
    }),
  });

  const item = viewModel.blocks[0].props.items[0];
  assert.deepStrictEqual(Object.keys(item).sort(), ['id', 'subtitle', 'title', 'tone']);
  assert.strictEqual(Object.hasOwn(item, 'image'), false);
});

test('空 items 保留空数组，交给渲染层走 POSTER 占位分支', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const empty = buildPreviewViewModel({ plan: posterPlan({ items: [], autoplay: true }) });
  assert.deepStrictEqual(empty.blocks[0].props.items, []);
  assert.strictEqual(empty.blocks[0].props.autoplay, true);

  const missing = buildPreviewViewModel({ plan: basePlan({
    features: [{ id: 'poster-carousel', version: '1.0.0', slots: [{ slotId: 'home-hero', dataKey: 'homeHero' }] }],
  }) });
  assert.deepStrictEqual(missing.blocks[0].props.items, []);
});

test('session 级 selector：不同模板产出不同 blocks，且 selected 与候选表引用一致', async () => {
  const { buildSessionPreviewViewModels } = await import('../src/composition/previewViewModel.mjs');
  const session = {
    store: {},
    features: { selected: [] },
    build: {
      selectedId: 'signature-kitchen',
      candidates: [
        { id: 'warm-bistro', layout: 'menu' },
        { id: 'signature-kitchen', layout: 'editorial' },
      ],
    },
    visual: { styleId: 'warm' },
    agentDraft: { storeName: '松月食堂', dishes: [] },
  };

  const { selected, byTemplateId } = buildSessionPreviewViewModels(session);
  assert.strictEqual(selected, byTemplateId['signature-kitchen']);
  assert.strictEqual(selected.recipe.id, 'order-poster');
  assert.strictEqual(selected.blocks.length, 1);
  assert.strictEqual(byTemplateId['warm-bistro'].recipe.id, 'order-classic');
  assert.deepStrictEqual(byTemplateId['warm-bistro'].blocks, []);
});