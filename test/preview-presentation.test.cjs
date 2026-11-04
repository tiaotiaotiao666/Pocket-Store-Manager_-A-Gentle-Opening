'use strict';

/**
 * T2：Plan 展示投影与 React 预览消费 presentation 的回归测试。
 *
 * 覆盖 plan.md 2.2.2（C-PLAN-PRESENTATION@1）与 2.2.1（尺寸 token）：
 * - 无 presentation 时 Plan 与旧版本完全一致（向后兼容）；
 * - 主题覆盖、presentationTokens、slotOrder 落位、carousel props.size；
 * - copy 不由 planFromSession 重复应用（以 store 为准）；
 * - previewViewModel 的 pageId/size/sizes/tagline；
 * - 预览组件按 pageId 归属、按 sizes 渲染、按 block.size 取海报高度。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function sessionState(overrides = {}) {
  return {
    store: {
      name: '松月食堂',
      type: '社区餐馆',
      notes: '社区家常菜',
    },
    features: { selected: ['scan-order', 'product-catalog'] },
    build: { selectedId: 'signature-kitchen' },
    visual: { styleId: 'warm' },
    agentDraft: {
      storeName: '草稿食堂',
      category: '简餐',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [{ id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, description: '微辣' }],
    },
    ...overrides,
  };
}

function withPresentation(patch, overrides = {}) {
  return sessionState({
    presentation: {
      templateId: 'signature-kitchen',
      patch,
      changes: [],
      status: 'idle',
      requestId: null,
      lastUtterance: '',
      error: null,
    },
    ...overrides,
  });
}

test('无 presentation 时 Plan 不新增字段，features 与主题保持 Recipe 原值', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const legacy = buildPlanFromSession(sessionState());
  const legacyAgain = buildPlanFromSession(sessionState());

  assert.strictEqual(Object.hasOwn(legacy.plan, 'presentationTokens'), false);
  assert.strictEqual(Object.hasOwn(legacy.plan, 'slotOrder'), false);
  assert.deepStrictEqual(legacy, legacyAgain, '纯函数：同 state 两次调用深相等');
  assert.deepStrictEqual(
    legacy.plan.features[0].slots.map((slot) => slot.slotId),
    ['home-hero'],
  );
  // C-PLAN-PRESENTATION@1（2.2.2）：order-poster Recipe 自带默认 props.size="md"，
  // 预览与导出必须同源；Plan 层不新增字段指的是 presentationTokens/slotOrder。
  assert.strictEqual(legacy.plan.features[0].slots[0].props.size, 'md');
  assert.strictEqual(legacy.plan.themeTokens.pageBackground, '#F7F3EC');
});

test('主题 = 预设主题 + 补丁浅合并：只接受 7 个白名单 token 的 #RRGGBB', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(withPresentation({
    theme: {
      pageBackground: '#0a0F14',
      primaryColor: '#123abc',
      unknownToken: '#FFFFFF',
      accentColor: '#FFF',
      textColor: '#101010',
    },
  }));
  const tokens = result.plan.themeTokens;

  assert.strictEqual(tokens.pageBackground, '#0A0F14', '小写输入统一为大写');
  assert.strictEqual(tokens.primaryColor, '#123ABC');
  assert.strictEqual(tokens.textColor, '#101010');
  assert.strictEqual(tokens.accentColor, '#9C2E12', '非法值回落预设主题');
  assert.strictEqual(Object.hasOwn(tokens, 'unknownToken'), false);
  assert.deepStrictEqual(Object.keys(tokens), [
    'pageBackground',
    'primaryColor',
    'accentColor',
    'textColor',
    'tabBarBackground',
    'tabBarColor',
    'tabBarSelectedColor',
  ]);
});

test('presentationTokens 只有两组尺寸，carousel 档位写入海报 slot 的 props.size', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const { toPx } = await import('../src/domain/previewSizeTokens.mjs');
  const legacy = buildPlanFromSession(sessionState());
  const result = buildPlanFromSession(withPresentation({
    sizes: { homeHero: 'lg', productCard: 'sm', carousel: 'lg' },
  }));
  const plan = result.plan;

  assert.deepStrictEqual(plan.presentationTokens, { homeHeroSize: 'lg', productCardSize: 'sm' });
  assert.strictEqual(Object.hasOwn(plan.presentationTokens, 'carouselSize'), false);
  assert.strictEqual(Object.hasOwn(plan.presentationTokens, 'carousel'), false);
  assert.strictEqual(plan.features[0].slots[0].props.size, 'lg');
  assert.strictEqual(plan.features[0].slots[0].props.items.length, 3, 'props 其余内容不变');
  assert.strictEqual(plan.features.length, legacy.plan.features.length, '组件数量不变');
  assert.deepStrictEqual(
    plan.features.map((feature) => feature.id),
    legacy.plan.features.map((feature) => feature.id),
    '组件类型与顺序不变',
  );
  assert.strictEqual(toPx('homeHero', 'lg'), 120);
});

test('presentationTokens 缺项按 md 兜底；未知档位不写入 props.size', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(withPresentation({
    sizes: { homeHero: 'huge', carousel: 'xl' },
  }));

  assert.deepStrictEqual(result.plan.presentationTokens, {
    homeHeroSize: 'md',
    productCardSize: 'md',
  });
  // 非法档位不写入补丁值；海报仍保留 Recipe 自带的默认 size="md"。
  assert.strictEqual(result.plan.features[0].slots[0].props.size, 'md');
});

test('slotOrder 只写在 Plan 顶层，features[].slots[] 保持 Recipe 原样', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const legacy = buildPlanFromSession(sessionState());
  const result = buildPlanFromSession(withPresentation({
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
  }));
  const plan = result.plan;
  const slot = plan.features[0].slots[0];

  assert.strictEqual(plan.features.length, 1);
  assert.strictEqual(plan.features[0].slots.length, legacy.plan.features[0].slots.length);
  assert.strictEqual(plan.features[0].id, 'poster-carousel');
  // 关键：不改写 slots，否则 Composer 的 requiresSlots=['home-hero'] 会报 SLOT_REQUIRED_MISSING。
  assert.strictEqual(slot.pageId, 'home');
  assert.strictEqual(slot.slotId, 'home-hero');
  assert.strictEqual(slot.dataKey, 'homeHero');
  assert.deepStrictEqual(plan.slotOrder, [
    { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' },
  ]);
});

test('非法落位（页面与插槽矛盾、未知插槽）被忽略，保持 Recipe 原落位', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(withPresentation({
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'menu-hero' }],
  }));

  assert.strictEqual(result.plan.features[0].slots[0].slotId, 'home-hero');
  assert.strictEqual(result.plan.features[0].slots[0].pageId, 'home');
  assert.deepStrictEqual(result.plan.slotOrder, [
    { featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' },
  ]);
});

test('copy 不由 planFromSession 重复应用：店名/品类以 store 为准，口号映射 notes', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const result = buildPlanFromSession(withPresentation({
    copy: {
      storeName: '补丁店名',
      category: '补丁品类',
      tagline: '补丁口号',
      dishes: [{ id: 'dish-1', name: '补丁菜名' }],
    },
  }));

  assert.strictEqual(result.plan.storeProfile.name, '松月食堂', 'store 优先于 agentDraft 与补丁 copy');
  assert.strictEqual(result.plan.storeProfile.category, '简餐', '品类沿用现有 draft 优先语义');
  assert.notStrictEqual(result.plan.storeProfile.category, '补丁品类', '补丁 copy 不重复应用');
  assert.strictEqual(result.plan.storeProfile.notes, '社区家常菜', 'tagline 由状态机写入 store.notes');
  assert.notStrictEqual(result.plan.storeProfile.notes, '补丁口号');
  assert.strictEqual(result.plan.storeProfile.dishes[0].name, '宫保鸡丁');
});

test('状态机已写好的 store.notes 与菜品进入 Plan，并投影为 preview 的 tagline', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');

  const state = withPresentation({ tagline: '补丁口号' }, {
    store: { name: '松月食堂', type: '社区餐馆', notes: '现磨咖啡 · 手作烘焙' },
    agentDraft: {
      ...sessionState().agentDraft,
      dishes: [{ id: 'dish-1', name: '手冲耶加', priceCents: 2200, description: '浅烘' }],
    },
  });
  const { plan } = buildPlanFromSession(state);
  const viewModel = buildPreviewViewModel({ plan, layout: 'menu' });

  assert.strictEqual(plan.storeProfile.notes, '现磨咖啡 · 手作烘焙');
  assert.strictEqual(viewModel.store.tagline, '现磨咖啡 · 手作烘焙');
  assert.strictEqual(viewModel.store.subtitle, '简餐 · 堂食');
  assert.strictEqual(viewModel.products[0].name, '手冲耶加');
});

test('previewViewModel 按 Plan 落位输出 pageId 与 size，并暴露 px 尺寸', async () => {
  const { buildPlanFromSession } = await import('../src/composition/planFromSession.mjs');
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const { toPx } = await import('../src/domain/previewSizeTokens.mjs');

  const { plan } = buildPlanFromSession(withPresentation({
    sizes: { homeHero: 'lg', productCard: 'lg', carousel: 'sm' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
  }));
  const viewModel = buildPreviewViewModel({ plan });

  assert.strictEqual(viewModel.blocks.length, 1);
  assert.strictEqual(viewModel.blocks[0].pageId, 'menu');
  assert.strictEqual(viewModel.blocks[0].slotId, 'menu-hero');
  assert.strictEqual(viewModel.blocks[0].size, 'sm');
  assert.deepStrictEqual(viewModel.sizes, {
    homeHeroPx: toPx('homeHero', 'lg'),
    productCardPx: toPx('productCard', 'lg'),
  });
  assert.strictEqual(viewModel.sizes.homeHeroPx, 120);
  assert.strictEqual(viewModel.sizes.productCardPx, 88);
});

test('旧 Plan 无 presentationTokens 时 sizes 回落 md；无 pageId 的旧块归首页', async () => {
  const { buildPreviewViewModel } = await import('../src/composition/previewViewModel.mjs');
  const { toPx } = await import('../src/domain/previewSizeTokens.mjs');
  const viewModel = buildPreviewViewModel({
    plan: {
      planId: 'order-poster',
      themeTokens: {},
      storeProfile: { name: '旧门店', notes: '' },
      features: [{
        id: 'poster-carousel',
        version: '1.0.0',
        slots: [{
          slotId: 'home-hero',
          dataKey: 'homeHero',
          props: { items: [{ id: 'a', title: 'A', subtitle: '', tone: 'warm' }] },
        }],
      }],
    },
  });

  assert.deepStrictEqual(viewModel.sizes, {
    homeHeroPx: toPx('homeHero', 'md'),
    productCardPx: toPx('productCard', 'md'),
  });
  assert.strictEqual(viewModel.blocks[0].pageId, 'home');
  assert.strictEqual(viewModel.blocks[0].size, 'md');
  assert.strictEqual(viewModel.store.tagline, '');
});

test('预览组件按 pageId 归属页面、消费 sizes/tagline，并按 block.size 取海报高度', () => {
  const read = (relativePath) => fs.readFileSync(path.join(REPO, relativePath), 'utf8');
  const mini = read('src/components/preview/MiniProgramPreview.jsx');
  const tabs = read('src/components/preview/PreviewTabs.jsx');
  const shared = read('src/components/preview/PreviewShared.jsx');
  const poster = read('src/components/preview/PosterCarouselBlock.jsx');
  const css = read('src/styles/preview.css');

  assert.match(mini, /findHeroBlock\(blocks, pageId = 'home'\)/);
  assert.match(mini, /\(block\.pageId \|\| 'home'\) === pageId/);
  assert.match(tabs, /findPageBlocks\(blocks, 'menu'\)/);
  assert.match(tabs, /\(block\.pageId \|\| 'home'\) === pageId/);
  assert.match(tabs, /MenuPlanBlock/);
  assert.match(shared, /store\.tagline/);
  assert.match(shared, /mini-tagline/);
  assert.match(shared, /minHeight: `\$\{heightPx\}px`/);
  assert.match(tabs, /thumbPx=\{sizes\?\.productCardPx\}/);
  assert.match(poster, /SIZE_STEPS\.includes\(block && block\.size\)/);
  assert.match(poster, /toPx\('carousel', sizeStep\)/);
  assert.match(css, /\.mini-tagline/);
});