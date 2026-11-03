'use strict';

/**
 * `agent-presentation-patch.v1` 契约验收测试。
 * 覆盖 plan.md 2.2.4 的 10 条校验规则、合并语义与变更计算。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadPatch() {
  return import('../src/domain/presentationPatch.mjs');
}

async function loadSizes() {
  return import('../src/domain/previewSizeTokens.mjs');
}

const FEATURE_CTX = {
  occupiedFeatures: [{ id: 'poster-carousel', kind: 'feature-pack' }],
  hasCarousel: true,
  baseDraft: { dishes: [{ id: 'dish-a' }, { id: 'dish-b' }] },
};

const CLASSIC_CTX = {
  occupiedFeatures: [],
  hasCarousel: false,
  baseDraft: { dishes: [{ id: 'dish-a' }] },
};

test('合法补丁：主题色转大写、文案去首尾空白、落位到 menu-hero', async () => {
  const { validatePresentationPatch } = await loadPatch();
  const result = validatePresentationPatch(
    {
      theme: { primaryColor: '#1f6f5c' },
      sizes: { homeHero: 'lg', productCard: 'sm', carousel: 'md' },
      slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
      copy: {
        storeName: '  松月食堂  ',
        tagline: '一碗人间烟火',
        dishes: [{ id: 'dish-a', name: '招牌面', description: '每日现熬' }],
      },
    },
    FEATURE_CTX,
  );

  assert.equal(result.ok, true);
  assert.equal(result.patch.theme.primaryColor, '#1F6F5C');
  assert.equal(result.patch.copy.storeName, '松月食堂');
  assert.equal(result.patch.slotOrder[0].pageId, 'menu');
  assert.equal(result.patch.slotOrder[0].slotId, 'menu-hero');
  assert.ok(Array.isArray(result.changes) && result.changes.length > 0);
});

test('空补丁合法且不产生变更', async () => {
  const { validatePresentationPatch } = await loadPatch();
  const result = validatePresentationPatch({}, FEATURE_CTX);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, {});
  assert.deepEqual(result.changes, []);
});

test('规则1：未知顶层键整包失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ layout: 'editorial' }, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
  assert.equal(result.details[0].path, 'layout');
});

test('规则2：__proto__ 键整包失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const polluted = JSON.parse('{"theme":{"__proto__":{"polluted":true}}}');
  const result = validatePresentationPatch(polluted, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则5：非法颜色返回 PATCH_THEME_COLOR_INVALID', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ theme: { primaryColor: 'red' } }, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID);
  assert.equal(result.details[0].path, 'theme.primaryColor');
});

test('规则5：未知主题 token 整包失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ theme: { brandColor: '#112233' } }, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则4：危险字符串整包失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { copy: { tagline: 'javascript:alert(1)' } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则9：店名超过 48 码点失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { copy: { storeName: '店'.repeat(49) } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
  assert.equal(result.details[0].path, 'copy.storeName');
});

test('规则6：无轮播模板修改 carousel 返回 PATCH_SIZE_UNSUPPORTED', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ sizes: { carousel: 'lg' } }, CLASSIC_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.SIZE_UNSUPPORTED);
});

test('规则6：非法尺寸档位失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ sizes: { homeHero: 'xl' } }, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则7：slotOrder 不是完整排列时失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch({ slotOrder: [] }, FEATURE_CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED);
});

test('规则7：featureId 不属于当前模板时失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }] },
    CLASSIC_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED);
});

test('规则7：空模板只能提交空 slotOrder', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const okResult = validatePresentationPatch({ slotOrder: [] }, CLASSIC_CTX);
  assert.equal(okResult.ok, true);
  assert.deepEqual(okResult.patch.slotOrder, []);

  const failResult = validatePresentationPatch(
    { slotOrder: [{ featureId: 'ghost', pageId: 'home', slotId: 'home-hero' }] },
    CLASSIC_CTX,
  );
  assert.equal(failResult.ok, false);
  assert.equal(failResult.code, PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED);
});

test('规则7：目标插槽不接受该 kind 时返回 PATCH_SLOT_TARGET_INVALID', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  // menu-aside 只接受 ui-block，poster-carousel 是 feature-pack
  const result = validatePresentationPatch(
    { slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-aside' }] },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.SLOT_TARGET_INVALID);
});

test('规则7：pageId 与 slotId 不配对时返回 PATCH_SLOT_TARGET_INVALID', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'menu-hero' }] },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.SLOT_TARGET_INVALID);
});

test('规则8：不存在的菜品 id 返回 PATCH_COPY_DISH_UNKNOWN', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { copy: { dishes: [{ id: 'ghost', name: 'x' }] } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.COPY_DISH_UNKNOWN);
});

test('规则8：菜品补丁不允许出现价格字段', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { copy: { dishes: [{ id: 'dish-a', name: 'x', priceCents: 100 }] } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则8：菜品 id 重复失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = validatePresentationPatch(
    { copy: { dishes: [{ id: 'dish-a', name: 'a' }, { id: 'dish-a', name: 'b' }] } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.INVALID);
});

test('规则3：结构体检（超长文案、总键数超限）整包失败', async () => {
  const { validatePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();

  // 边界内合法：店名 48 码点 + 口号 40 码点 + 单菜描述 60 码点
  const withinLimit = validatePresentationPatch(
    {
      copy: {
        storeName: 'a'.repeat(48),
        tagline: 'b'.repeat(40),
        dishes: [{ id: 'dish-a', description: '字'.repeat(60) }],
      },
    },
    FEATURE_CTX,
  );
  assert.equal(withinLimit.ok, true);

  // 口号 41 码点 → 超限
  const overTagline = validatePresentationPatch({ copy: { tagline: '甲'.repeat(41) } }, FEATURE_CTX);
  assert.equal(overTagline.ok, false);
  assert.equal(overTagline.code, PRESENTATION_PATCH_CODES.INVALID);

  // 总键数 70 > 64 → 结构体检直接拒绝
  const manyKeys = {};
  for (let index = 0; index < 70; index += 1) manyKeys[`k${index}`] = 'v';
  const overflow = validatePresentationPatch(manyKeys, FEATURE_CTX);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, PRESENTATION_PATCH_CODES.INVALID);
  assert.match(overflow.details[0].message, /键数/);
});

test('合并语义：theme/sizes 浅合并、slotOrder 整体替换、dishes 按 id 合并', async () => {
  const { mergePresentationPatch } = await loadPatch();
  const base = {
    theme: { primaryColor: '#111111', accentColor: '#222222' },
    sizes: { homeHero: 'sm' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }],
    copy: { storeName: '老店', dishes: [{ id: 'dish-a', name: '旧A', description: '旧描述' }] },
  };
  const next = {
    theme: { primaryColor: '#333333' },
    sizes: { productCard: 'lg' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
    copy: { tagline: '新口号', dishes: [{ id: 'dish-a', name: '新A' }] },
  };

  const result = mergePresentationPatch(base, next, FEATURE_CTX);
  assert.equal(result.ok, true);
  assert.equal(result.patch.theme.primaryColor, '#333333');
  assert.equal(result.patch.theme.accentColor, '#222222');
  assert.equal(result.patch.sizes.homeHero, 'sm');
  assert.equal(result.patch.sizes.productCard, 'lg');
  assert.equal(result.patch.slotOrder[0].pageId, 'menu');
  assert.equal(result.patch.copy.storeName, '老店');
  assert.equal(result.patch.copy.tagline, '新口号');
  assert.equal(result.patch.copy.dishes[0].name, '新A');
  assert.equal(result.patch.copy.dishes[0].description, '旧描述');
});

test('合并语义：非法新补丁不产生部分结果', async () => {
  const { mergePresentationPatch, PRESENTATION_PATCH_CODES } = await loadPatch();
  const result = mergePresentationPatch(
    {},
    { theme: { primaryColor: '#112233', accentColor: 'red' } },
    FEATURE_CTX,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID);
  assert.equal(result.patch, undefined);
});

test('变更计算：固定顺序与中文 label', async () => {
  const { diffPresentationPatch } = await loadPatch();
  const base = {
    theme: { primaryColor: '#111111' },
    sizes: { homeHero: 'sm' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'home-hero' }],
    copy: { storeName: '老店', dishes: [{ id: 'dish-a', name: '旧A' }] },
  };
  const next = {
    theme: { primaryColor: '#222222' },
    sizes: { homeHero: 'lg' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
    copy: { storeName: '新店', dishes: [{ id: 'dish-a', name: '新A' }] },
  };

  const items = diffPresentationPatch(base, next, FEATURE_CTX);
  assert.deepEqual(
    items.map((item) => item.path),
    ['theme.primaryColor', 'sizes.homeHero', 'slotOrder.poster-carousel', 'copy.storeName', 'copy.dishes[0].name'],
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ['主色', '首屏主视觉尺寸', '区块位置', '店名', '菜品名称'],
  );
  assert.equal(items[2].before, 'home/home-hero');
  assert.equal(items[2].after, 'menu/menu-hero');
  assert.equal(items[0].before, '#111111');
  assert.equal(items[0].after, '#222222');
});

test('变更计算：超过 20 条时截断并追加“…等 N 项”', async () => {
  const { diffPresentationPatch } = await loadPatch();
  const fiveDishes = ['dish-a', 'dish-b', 'dish-c', 'dish-d', 'dish-e'];
  const ctx = {
    occupiedFeatures: [{ id: 'poster-carousel', kind: 'feature-pack' }],
    hasCarousel: true,
    baseDraft: { dishes: fiveDishes.map((id) => ({ id })) },
  };
  const next = {
    theme: Object.fromEntries(
      ['pageBackground', 'primaryColor', 'accentColor', 'textColor', 'tabBarBackground', 'tabBarColor', 'tabBarSelectedColor']
        .map((key, index) => [key, `#11111${index}`]),
    ),
    sizes: { homeHero: 'lg', productCard: 'lg', carousel: 'lg' },
    slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }],
    copy: {
      storeName: '新店',
      category: '面馆',
      tagline: '好味道',
      dishes: fiveDishes.map((id, index) => ({ id, name: `菜${index}`, description: `描述${index}` })),
    },
  };

  const items = diffPresentationPatch({}, next, ctx);
  assert.equal(items.length, 20);
  const last = items[19];
  assert.equal(last.path, '...');
  assert.equal(last.label, '…等 24 项');
  assert.equal(last.before, null);
  assert.equal(last.after, null);
});

test('确定性：同一输入两次校验结果深度相等', async () => {
  const { validatePresentationPatch } = await loadPatch();
  const input = {
    theme: { textColor: '#ABCDEF' },
    sizes: { productCard: 'sm' },
    copy: { category: '面包店' },
  };
  const first = validatePresentationPatch(input, FEATURE_CTX);
  const second = validatePresentationPatch(input, FEATURE_CTX);
  assert.deepEqual(first, second);
});

test('尺寸表契约：三组三档、默认 md、rpx 与 px 分离', async () => {
  const { SIZE_TOKEN_TABLE, DEFAULT_SIZE_TOKENS, resolveSizeToken, toRpx, toPx } = await loadSizes();
  assert.deepEqual(Object.keys(SIZE_TOKEN_TABLE), ['homeHero', 'productCard', 'carousel']);
  assert.deepEqual(DEFAULT_SIZE_TOKENS, { homeHero: 'md', productCard: 'md', carousel: 'md' });
  assert.equal(SIZE_TOKEN_TABLE.homeHero.lg.rpx, 250);
  assert.equal(SIZE_TOKEN_TABLE.homeHero.lg.px, 120);
  assert.equal(toRpx('homeHero', 'lg'), 250);
  assert.equal(toPx('homeHero', 'lg'), 120);

  const fallback = resolveSizeToken('unknown', 'xl');
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.group, 'homeHero');
  assert.equal(fallback.step, 'md');
  assert.equal(fallback.rpx, 190);
});