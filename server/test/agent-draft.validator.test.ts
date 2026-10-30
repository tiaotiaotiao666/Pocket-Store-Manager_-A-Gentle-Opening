import { describe, expect, it } from 'vitest';
import {
  applyDraftPatch,
  buildNextQuestion,
  normalizeBusinessHoursText,
  normalizeInternalDraft,
  projectContractDraft,
  validateInternalDraft,
} from '../src/agent/agent-draft.validator';
import type { InternalDraft } from '../src/agent/agent.types';

function draft(overrides: Partial<InternalDraft> = {}): InternalDraft {
  return {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-21:00',
    fulfillment: { dineIn: true, takeaway: true },
    dishes: [
      { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, description: '' },
      { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, description: '' },
      { id: 'dish-3', name: '米饭', priceCents: 300, description: '' },
    ],
    ...overrides,
  };
}

function codes(draftValue: InternalDraft): string[] {
  return validateInternalDraft(draftValue).errors.map((error) => error.code);
}

function missingFields(draftValue: InternalDraft): string[] {
  return validateInternalDraft(draftValue).missingFields.map((item) => item.field);
}

describe('营业时间归一化与校验', () => {
  it('全角、中文标点、点/半均可归一化', () => {
    expect(normalizeBusinessHoursText('１０：００－２１：００')).toBe('10:00-21:00');
    expect(normalizeBusinessHoursText('10点到21点')).toBe('10:00-21:00');
    expect(normalizeBusinessHoursText('10点半到21点')).toBe('10:30-21:00');
    expect(normalizeBusinessHoursText('10:00-14:00，17:00-21:00')).toBe('10:00-14:00,17:00-21:00');
  });

  it('跨午夜明确报 HOURS_RANGE', () => {
    expect(codes(draft({ businessHours: '22:00-02:00' }))).toContain('HOURS_RANGE');
  });

  it('开始等于结束报 HOURS_RANGE', () => {
    expect(codes(draft({ businessHours: '10:00-10:00' }))).toContain('HOURS_RANGE');
  });

  it('超过 3 段报 HOURS_TOO_MANY', () => {
    const result = codes(draft({ businessHours: '08:00-09:00,10:00-11:00,12:00-13:00,14:00-15:00' }));
    expect(result).toContain('HOURS_TOO_MANY');
  });

  it('时段重叠报 HOURS_OVERLAP', () => {
    expect(codes(draft({ businessHours: '10:00-14:00,13:00-18:00' }))).toContain('HOURS_OVERLAP');
  });

  it('格式错误报 HOURS_FORMAT', () => {
    expect(codes(draft({ businessHours: '早上十点到晚上九点' }))).toContain('HOURS_FORMAT');
  });
});

describe('字段长度与缺项', () => {
  it('店名超过 48 码点报 NAME_TOO_LONG', () => {
    expect(codes(draft({ storeName: '店'.repeat(49) }))).toContain('NAME_TOO_LONG');
  });

  it('品类超过 24 码点报 CATEGORY_TOO_LONG', () => {
    expect(codes(draft({ category: '品'.repeat(25) }))).toContain('CATEGORY_TOO_LONG');
  });

  it('空店名/品类/营业时间进入 missingFields', () => {
    const fields = missingFields(draft({ storeName: '', category: '', businessHours: '' }));
    expect(fields).toEqual(expect.arrayContaining(['storeName', 'category', 'businessHours']));
  });

  it('双 false 取餐方式进入 missingFields', () => {
    expect(missingFields(draft({ fulfillment: { dineIn: false, takeaway: false } }))).toContain('fulfillment');
  });

  it('同一字段不会同时出现在缺项与错误中', () => {
    const result = validateInternalDraft(draft({ storeName: '店'.repeat(49) }));
    const missing = new Set(result.missingFields.map((item) => item.field));
    for (const error of result.errors) {
      expect(missing.has(error.field)).toBe(false);
    }
  });
});

describe('菜品校验', () => {
  it('少于 3 道进入 missingFields，不进 errors', () => {
    const value = draft({ dishes: [{ id: 'dish-1', name: '米饭', priceCents: 300, description: '' }] });
    const result = validateInternalDraft(value);
    expect(result.missingFields.map((item) => item.field)).toContain('dishes');
    expect(result.errors.map((item) => item.code)).not.toContain('DISHES_TOO_MANY');
  });

  it('超过 5 道报 DISHES_TOO_MANY', () => {
    const dishes = Array.from({ length: 6 }, (_, index) => ({
      id: `dish-${index + 1}`,
      name: `菜${index + 1}`,
      priceCents: 1000 + index,
      description: '',
    }));
    expect(codes(draft({ dishes }))).toContain('DISHES_TOO_MANY');
  });

  it('菜名超过 24 码点报 DISH_NAME_TOO_LONG', () => {
    const value = draft();
    value.dishes[0].name = '菜'.repeat(25);
    expect(codes(value)).toContain('DISH_NAME_TOO_LONG');
  });

  it('菜名为空进入 missingFields', () => {
    const value = draft();
    value.dishes[0].name = '';
    expect(missingFields(value)).toContain('dishes[0].name');
  });

  it('价格为浮点/字符串报 PRICE_INVALID', () => {
    const floatValue = draft();
    floatValue.dishes[0].priceCents = 28.5;
    expect(codes(floatValue)).toContain('PRICE_INVALID');

    const stringValue = draft();
    stringValue.dishes[0].priceCents = '2800';
    expect(codes(stringValue)).toContain('PRICE_INVALID');
  });

  it('价格越界报 PRICE_RANGE', () => {
    const zero = draft();
    zero.dishes[0].priceCents = 0;
    expect(codes(zero)).toContain('PRICE_RANGE');

    const tooLarge = draft();
    tooLarge.dishes[0].priceCents = 1_000_000;
    expect(codes(tooLarge)).toContain('PRICE_RANGE');
  });

  it('价格为 null 进入 missingFields', () => {
    const value = draft();
    value.dishes[0].priceCents = null;
    expect(missingFields(value)).toContain('dishes[0].priceCents');
  });

  it('描述超过 60 码点报 DESCRIPTION_TOO_LONG', () => {
    const value = draft();
    value.dishes[0].description = '描'.repeat(61);
    expect(codes(value)).toContain('DESCRIPTION_TOO_LONG');
  });

  it('菜品 id 重复报 DISH_ID_INVALID', () => {
    const value = draft();
    value.dishes[1].id = value.dishes[0].id;
    expect(codes(value)).toContain('DISH_ID_INVALID');
  });

  it('完整合法草稿 readyForReview=true', () => {
    expect(validateInternalDraft(draft())).toEqual({
      missingFields: [],
      errors: [],
      readyForReview: true,
    });
  });
});

describe('补丁合并白名单', () => {
  it('只接受白名单字段，未知字段被丢弃', () => {
    const base = normalizeInternalDraft({});
    const merged = applyDraftPatch(base, {
      storeName: '松月食堂',
      evil: 'rm -rf',
      status: 'reviewing',
      missingFields: [],
      readyForReview: true,
    });
    const projected = projectContractDraft(merged);
    expect(Object.keys(projected).sort()).toEqual(
      ['businessHours', 'category', 'dishes', 'fulfillment', 'storeName'].sort(),
    );
    expect(projected.storeName).toBe('松月食堂');
    expect(projected).not.toHaveProperty('evil');
    expect(projected).not.toHaveProperty('status');
  });

  it('空字符串不覆盖已有值（模型不确定时不改）', () => {
    const base = normalizeInternalDraft(draft());
    const merged = applyDraftPatch(base, { storeName: '', category: '   ', businessHours: '' });
    expect(merged.storeName).toBe('松月食堂');
    expect(merged.category).toBe('社区餐馆');
    expect(merged.businessHours).toBe('10:00-21:00');
  });

  it('按名称或 id 更新已有菜品，未给价格时保留原价格', () => {
    const base = normalizeInternalDraft(draft());
    const merged = applyDraftPatch(base, {
      dishes: [{ name: '宫保鸡丁', description: '微辣' }],
    });
    const dish = merged.dishes.find((item) => item.name === '宫保鸡丁');
    expect(dish?.priceCents).toBe(2800);
    expect(dish?.description).toBe('微辣');
  });

  it('新增菜品会自动分配本地 id，价格原样保留等待校验', () => {
    const base = normalizeInternalDraft({ storeName: 'A' });
    const merged = applyDraftPatch(base, {
      dishes: [{ name: '酸辣粉', priceCents: '1200' }],
    });
    expect(merged.dishes).toHaveLength(1);
    expect(merged.dishes[0].id).toBe('dish-1');
    expect(validateInternalDraft({
      ...merged,
      storeName: 'A',
      category: 'B',
      businessHours: '10:00-21:00',
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [
        ...merged.dishes,
        { id: 'dish-2', name: '米饭', priceCents: 300, description: '' },
        { id: 'dish-3', name: '小菜', priceCents: 500, description: '' },
      ],
    }).errors.map((item) => item.code)).toContain('PRICE_INVALID');
  });

  it('非对象补丁不改变草稿', () => {
    const base = normalizeInternalDraft(draft());
    expect(applyDraftPatch(base, null)).toEqual(base);
    expect(applyDraftPatch(base, 'oops')).toEqual(base);
  });
});

describe('追问生成', () => {
  it('缺营业时间时返回营业时间追问', () => {
    const validation = validateInternalDraft(draft({ businessHours: '' }));
    expect(buildNextQuestion(validation)).toMatchObject({ field: 'businessHours' });
  });

  it('字段错误时返回错误信息作为追问', () => {
    const validation = validateInternalDraft(draft({ storeName: '店'.repeat(49) }));
    const question = buildNextQuestion(validation);
    expect(question?.field).toBe('storeName');
    expect(question?.text).toContain('不能超过');
  });

  it('资料完整时返回 null', () => {
    expect(buildNextQuestion(validateInternalDraft(draft()))).toBeNull();
  });
});