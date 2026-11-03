import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_PATCH_CODES,
  PRESENTATION_PATCH_LIMITS,
  SLOT_DEFINITIONS,
  diffPresentationPatch,
  mergePresentationPatch,
  resolvePresentationLabel,
  validatePresentationPatch,
} from '../src/agent/presentation/presentation-patch';
import type {
  PresentationPatchContext,
  PresentationPatchResult,
} from '../src/agent/presentation/presentation-patch';

const CAROUSEL_CONTEXT: PresentationPatchContext = {
  occupiedFeatures: [{ id: 'poster-carousel', kind: 'feature-pack' }],
  hasCarousel: true,
  baseDraft: { dishes: [{ id: 'dish-1' }, { id: 'dish-2' }] },
};

const EMPTY_CONTEXT: PresentationPatchContext = {
  occupiedFeatures: [],
  hasCarousel: false,
  baseDraft: { dishes: [] },
};

function expectFailure(result: PresentationPatchResult, code: string, path?: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.details.length).toBeGreaterThan(0);
  if (path !== undefined) {
    expect(result.details.map((detail) => detail.path)).toContain(path);
  }
}

function expectOk(result: PresentationPatchResult): Extract<PresentationPatchResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

/** 4 个已占用 feature 的上下文，用于验证 slotOrder 与变更截断。 */
function fullContext(): PresentationPatchContext {
  return {
    occupiedFeatures: [
      { id: 'f-a', kind: 'feature-pack' },
      { id: 'f-b', kind: 'ui-block' },
      { id: 'f-c', kind: 'feature-pack' },
      { id: 'f-d', kind: 'ui-block' },
    ],
    hasCarousel: true,
    baseDraft: {
      dishes: [
        { id: 'd1' },
        { id: 'd2' },
        { id: 'd3' },
        { id: 'd4' },
        { id: 'd5' },
      ],
    },
  };
}

describe('validatePresentationPatch 结构与白名单', () => {
  it('接受合法补丁并把主题色统一转成大写', () => {
    const result = expectOk(
      validatePresentationPatch(
        {
          theme: { primaryColor: '#1f6f5c', accentColor: '#ABCDEF' },
          sizes: { homeHero: 'lg', productCard: 'sm' },
          copy: { storeName: '松月食堂', category: '社区餐馆', tagline: '' },
        },
        EMPTY_CONTEXT,
      ),
    );

    expect(result.patch).toEqual({
      theme: { primaryColor: '#1F6F5C', accentColor: '#ABCDEF' },
      sizes: { homeHero: 'lg', productCard: 'sm' },
      copy: { storeName: '松月食堂', category: '社区餐馆', tagline: '' },
    });
    expect(result.changes.map((item) => item.path)).toEqual([
      'theme.primaryColor',
      'theme.accentColor',
      'sizes.homeHero',
      'sizes.productCard',
      'copy.storeName',
      'copy.category',
      'copy.tagline',
    ]);
  });

  it('拒绝未知顶层键（layout / 组件增删 / URL）', () => {
    expectFailure(validatePresentationPatch({ layout: 'menu', component: {} }, EMPTY_CONTEXT), PRESENTATION_PATCH_CODES.INVALID, 'layout');
    expectFailure(
      validatePresentationPatch({ theme: { primaryColor: '#112233' }, url: 'https://evil.example' }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'url',
    );
  });

  it('拒绝 __proto__ / constructor / prototype 原型污染键', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expectFailure(validatePresentationPatch(polluted, EMPTY_CONTEXT), PRESENTATION_PATCH_CODES.INVALID, '__proto__');

    const constructorKey = JSON.parse('{"constructor":{"prototype":{"x":1}}}') as Record<string, unknown>;
    expectFailure(validatePresentationPatch(constructorKey, EMPTY_CONTEXT), PRESENTATION_PATCH_CODES.INVALID);
  });

  it('拒绝超大序列化体积（> 8192 bytes）', () => {
    const result = validatePresentationPatch(
      { theme: { primaryColor: `#${'A'.repeat(9000)}` } },
      EMPTY_CONTEXT,
    );
    expectFailure(result, PRESENTATION_PATCH_CODES.INVALID);
    if (!result.ok) {
      expect(result.details[0].message).toContain(String(PRESENTATION_PATCH_LIMITS.maxSerializedBytes));
    }
  });

  it('拒绝超深嵌套（> 4 层）', () => {
    const result = validatePresentationPatch(
      { theme: { primaryColor: { a: { b: { c: 1 } } } } },
      EMPTY_CONTEXT,
    );
    expectFailure(result, PRESENTATION_PATCH_CODES.INVALID);
    if (!result.ok) {
      expect(result.details.some((detail) => detail.message.includes('嵌套深度'))).toBe(true);
    }
  });

  it('拒绝总键数超过 64', () => {
    const dishes = Array.from({ length: 65 }, (_, index) => ({ id: `dish-${index}` }));
    const result = validatePresentationPatch({ copy: { dishes } }, EMPTY_CONTEXT);
    expectFailure(result, PRESENTATION_PATCH_CODES.INVALID);
    if (!result.ok) {
      expect(result.details.some((detail) => detail.message.includes('总键数'))).toBe(true);
    }
  });
});

describe('validatePresentationPatch 主题 / 尺寸', () => {
  it('颜色不是 #RRGGBB 时返回 PATCH_THEME_COLOR_INVALID', () => {
    expectFailure(
      validatePresentationPatch({ theme: { primaryColor: 'red' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID,
      'theme.primaryColor',
    );
    expectFailure(
      validatePresentationPatch({ theme: { primaryColor: '#123' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID,
      'theme.primaryColor',
    );
  });

  it('未知主题 token 返回 PRESENTATION_PATCH_INVALID', () => {
    expectFailure(
      validatePresentationPatch({ theme: { brandColor: '#112233' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'theme.brandColor',
    );
  });

  it('sizes 只接受 sm/md/lg', () => {
    expectFailure(
      validatePresentationPatch({ sizes: { homeHero: 'xl' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'sizes.homeHero',
    );
  });

  it('当前模板没有轮播时修改 carousel 返回 PATCH_SIZE_UNSUPPORTED', () => {
    expectFailure(
      validatePresentationPatch({ sizes: { carousel: 'lg' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.SIZE_UNSUPPORTED,
      'sizes.carousel',
    );
    expectOk(validatePresentationPatch({ sizes: { carousel: 'lg' } }, CAROUSEL_CONTEXT));
  });
});

describe('validatePresentationPatch slotOrder', () => {
  it('受控目标表包含 home-hero / home-marketing / menu-aside / menu-hero，menu-hero 属于 menu 页', () => {
    expect(SLOT_DEFINITIONS['home-hero'].pageId).toBe('home');
    expect(SLOT_DEFINITIONS['home-marketing'].pageId).toBe('home');
    expect(SLOT_DEFINITIONS['menu-aside'].pageId).toBe('menu');
    expect(SLOT_DEFINITIONS['menu-hero'].pageId).toBe('menu');
    expect([...SLOT_DEFINITIONS['menu-hero'].accepts]).toEqual(['feature-pack', 'ui-block']);
    expect([...SLOT_DEFINITIONS['menu-aside'].accepts]).toEqual(['ui-block']);
  });

  it('完整排列且目标匹配时接受', () => {
    const result = expectOk(
      validatePresentationPatch(
        { slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }] },
        CAROUSEL_CONTEXT,
      ),
    );
    expect(result.patch.slotOrder).toEqual([
      { featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' },
    ]);
  });

  it('menu-aside 不接受 feature-pack，返回 PATCH_SLOT_TARGET_INVALID', () => {
    expectFailure(
      validatePresentationPatch(
        { slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-aside' }] },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.SLOT_TARGET_INVALID,
      'slotOrder[0].slotId',
    );
  });

  it('页面与插槽不匹配返回 PATCH_SLOT_TARGET_INVALID', () => {
    expectFailure(
      validatePresentationPatch(
        { slotOrder: [{ featureId: 'poster-carousel', pageId: 'home', slotId: 'menu-hero' }] },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.SLOT_TARGET_INVALID,
      'slotOrder[0].slotId',
    );
  });

  it('同一目标插槽重复落位返回 PATCH_SLOT_TARGET_INVALID', () => {
    const context: PresentationPatchContext = {
      occupiedFeatures: [
        { id: 'f-a', kind: 'feature-pack' },
        { id: 'f-b', kind: 'feature-pack' },
      ],
      hasCarousel: false,
      baseDraft: { dishes: [] },
    };
    expectFailure(
      validatePresentationPatch(
        {
          slotOrder: [
            { featureId: 'f-a', pageId: 'home', slotId: 'home-hero' },
            { featureId: 'f-b', pageId: 'home', slotId: 'home-hero' },
          ],
        },
        context,
      ),
      PRESENTATION_PATCH_CODES.SLOT_TARGET_INVALID,
      'slotOrder[1].slotId',
    );
  });

  it('不是完整排列 / featureId 不属于当前模板时返回 PATCH_SLOT_ORDER_UNSUPPORTED', () => {
    expectFailure(
      validatePresentationPatch(
        { slotOrder: [{ featureId: 'poster-carousel', pageId: 'menu', slotId: 'menu-hero' }] },
        EMPTY_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED,
      'slotOrder',
    );
    expectFailure(
      validatePresentationPatch({ slotOrder: [] }, CAROUSEL_CONTEXT),
      PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED,
      'slotOrder',
    );
    expectFailure(
      validatePresentationPatch(
        { slotOrder: [{ featureId: 'ghost', pageId: 'home', slotId: 'home-hero' }] },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.SLOT_ORDER_UNSUPPORTED,
      'slotOrder[0].featureId',
    );
  });

  it('无 feature 时 slotOrder 只能为空数组', () => {
    expectOk(validatePresentationPatch({ slotOrder: [] }, EMPTY_CONTEXT));
  });
});

describe('validatePresentationPatch copy', () => {
  it('菜品 id 必须存在于 baseDraft，否则 PATCH_COPY_DISH_UNKNOWN', () => {
    expectFailure(
      validatePresentationPatch({ copy: { dishes: [{ id: 'ghost', name: 'x' }] } }, CAROUSEL_CONTEXT),
      PRESENTATION_PATCH_CODES.COPY_DISH_UNKNOWN,
      'copy.dishes[0].id',
    );
  });

  it('菜品补丁禁止写价格字段', () => {
    expectFailure(
      validatePresentationPatch(
        { copy: { dishes: [{ id: 'dish-1', priceCents: 100 }] } },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.dishes[0].priceCents',
    );
    expectFailure(
      validatePresentationPatch(
        { copy: { dishes: [{ id: 'dish-1', priceText: '10元' }] } },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.dishes[0].priceText',
    );
  });

  it('菜品 id 重复返回 PRESENTATION_PATCH_INVALID', () => {
    expectFailure(
      validatePresentationPatch(
        { copy: { dishes: [{ id: 'dish-1', name: 'a' }, { id: 'dish-1', name: 'b' }] } },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.dishes[1].id',
    );
  });

  it('按下标报告菜品文案长度错误', () => {
    expectFailure(
      validatePresentationPatch(
        { copy: { dishes: [{ id: 'dish-2', name: '菜'.repeat(25) }] } },
        CAROUSEL_CONTEXT,
      ),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.dishes[0].name',
    );
  });

  it('storeName 48 / category 24 / tagline 40 码点上限', () => {
    expectFailure(
      validatePresentationPatch({ copy: { storeName: '店'.repeat(49) } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.storeName',
    );
    expectFailure(
      validatePresentationPatch({ copy: { category: '菜'.repeat(25) } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.category',
    );
    expectOk(validatePresentationPatch({ copy: { tagline: '口'.repeat(40) } }, EMPTY_CONTEXT));
    expectFailure(
      validatePresentationPatch({ copy: { tagline: '口'.repeat(41) } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.tagline',
    );
  });

  it('文案做 NFC 规范化与去首尾空白', () => {
    const result = expectOk(
      validatePresentationPatch({ copy: { storeName: '  Cafe\u0301  ' } }, EMPTY_CONTEXT),
    );
    expect(result.patch.copy?.storeName).toBe('Caf\u00e9');
  });

  it('拒绝控制字符与脚本 / 链接 / HTML 片段', () => {
    expectFailure(
      validatePresentationPatch({ copy: { storeName: '松月\u0000食堂' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.storeName',
    );
    expectFailure(
      validatePresentationPatch({ copy: { tagline: '<script>alert(1)</script>' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.tagline',
    );
    expectFailure(
      validatePresentationPatch({ copy: { tagline: 'javascript:alert(1)' } }, EMPTY_CONTEXT),
      PRESENTATION_PATCH_CODES.INVALID,
      'copy.tagline',
    );
  });
});

describe('mergePresentationPatch / diffPresentationPatch', () => {
  it('theme / sizes 浅合并，slotOrder 整体替换，copy.dishes 按 id 合并', () => {
    const context = fullContext();
    const base = {
      theme: { primaryColor: '#111111' },
      sizes: { homeHero: 'md' as const },
      slotOrder: [
        { featureId: 'f-a', pageId: 'home' as const, slotId: 'home-hero' as const },
        { featureId: 'f-b', pageId: 'menu' as const, slotId: 'menu-hero' as const },
        { featureId: 'f-c', pageId: 'home' as const, slotId: 'home-marketing' as const },
        { featureId: 'f-d', pageId: 'menu' as const, slotId: 'menu-aside' as const },
      ],
      copy: { storeName: '旧店名', dishes: [{ id: 'd1', name: '旧菜名', description: '旧描述' }] },
    };
    const next = {
      theme: { accentColor: '#222222' },
      slotOrder: [
        { featureId: 'f-a', pageId: 'menu' as const, slotId: 'menu-hero' as const },
        { featureId: 'f-b', pageId: 'home' as const, slotId: 'home-hero' as const },
        { featureId: 'f-c', pageId: 'home' as const, slotId: 'home-marketing' as const },
        { featureId: 'f-d', pageId: 'menu' as const, slotId: 'menu-aside' as const },
      ],
      copy: { dishes: [{ id: 'd1', name: '新菜名' }] },
    };

    // f-a 是 feature-pack，menu-hero 接受 feature-pack；f-c 也是 feature-pack，home-hero 接受。
    const merged = expectOk(mergePresentationPatch(base, next, context));

    expect(merged.patch.theme).toEqual({ primaryColor: '#111111', accentColor: '#222222' });
    expect(merged.patch.sizes).toEqual({ homeHero: 'md' });
    expect(merged.patch.slotOrder).toEqual(next.slotOrder);
    expect(merged.patch.copy).toEqual({
      storeName: '旧店名',
      dishes: [{ id: 'd1', name: '新菜名', description: '旧描述' }],
    });

    const paths = merged.changes.map((item) => item.path);
    expect(paths).toContain('theme.accentColor');
    expect(paths).toContain('slotOrder.f-a');
    expect(paths).toContain('copy.dishes[0].name');
    expect(paths).not.toContain('copy.dishes[0].description');
    expect(paths).not.toContain('copy.storeName');

    const accent = merged.changes.find((item) => item.path === 'theme.accentColor');
    expect(accent).toMatchObject({ label: '强调色', before: null, after: '#222222' });
    const placement = merged.changes.find((item) => item.path === 'slotOrder.f-a');
    expect(placement).toMatchObject({ label: '区块位置', before: 'home/home-hero', after: 'menu/menu-hero' });
  });

  it('合并结果不合法时整包失败（无部分应用）', () => {
    const result = mergePresentationPatch(
      { theme: { primaryColor: '#111111' } },
      { theme: { primaryColor: '#123' } },
      EMPTY_CONTEXT,
    );
    expectFailure(result, PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID, 'theme.primaryColor');
  });

  it('基准补丁不合法时直接失败', () => {
    const result = mergePresentationPatch(
      { theme: { primaryColor: 'red' } },
      { theme: { primaryColor: '#111111' } },
      EMPTY_CONTEXT,
    );
    expectFailure(result, PRESENTATION_PATCH_CODES.THEME_COLOR_INVALID, 'theme.primaryColor');
  });

  it('变更清单超过 20 条时截断，最后一条为“…等 N 项”', () => {
    const context = fullContext();
    const next = {
      theme: {
        pageBackground: '#000001',
        primaryColor: '#000002',
        accentColor: '#000003',
        textColor: '#000004',
        tabBarBackground: '#000005',
        tabBarColor: '#000006',
        tabBarSelectedColor: '#000007',
      },
      sizes: { homeHero: 'lg' as const, productCard: 'lg' as const, carousel: 'lg' as const },
      slotOrder: [
        { featureId: 'f-a', pageId: 'home' as const, slotId: 'home-hero' as const },
        { featureId: 'f-b', pageId: 'menu' as const, slotId: 'menu-hero' as const },
        { featureId: 'f-c', pageId: 'home' as const, slotId: 'home-marketing' as const },
        { featureId: 'f-d', pageId: 'menu' as const, slotId: 'menu-aside' as const },
      ],
      copy: {
        storeName: '新店名',
        category: '新品类',
        tagline: '新口号',
        dishes: context.baseDraft?.dishes?.map((dish) => ({
          id: dish.id,
          name: `${dish.id}-name`,
          description: `${dish.id}-description`,
        })),
      },
    };
    // 4 个 feature 落位到 4 个不同目标插槽，满足完整排列与目标 kind 校验。
    const merged = expectOk(mergePresentationPatch({}, next, context));
    expect(merged.changes.length).toBe(20);
    expect(merged.changes[19]).toEqual({
      path: '...',
      label: expect.stringContaining('…等'),
      before: null,
      after: null,
    });
  });

  it('固定 label 映射覆盖全部契约路径', () => {
    expect(resolvePresentationLabel('theme.pageBackground')).toBe('页面背景色');
    expect(resolvePresentationLabel('theme.tabBarSelectedColor')).toBe('底栏选中色');
    expect(resolvePresentationLabel('sizes.carousel')).toBe('轮播区尺寸');
    expect(resolvePresentationLabel('slotOrder.poster-carousel')).toBe('区块位置');
    expect(resolvePresentationLabel('copy.dishes[3].description')).toBe('菜品描述');
  });
});