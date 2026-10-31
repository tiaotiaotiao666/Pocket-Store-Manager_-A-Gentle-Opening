import { describe, expect, it } from 'vitest';
import {
  assertConfirmations,
  computeImportDiff,
  joinBusinessHours,
  validateBusinessHours,
  validateIdempotencyKey,
  validateImportPayload,
} from '../src/imports/import-diff';
import type { ExistingStore, ImportPayload } from '../src/imports/import-diff';

function payload(overrides: Partial<ImportPayload> = {}): ImportPayload {
  return {
    profile: {
      name: '松月食堂',
      category: '社区餐馆',
      address: '上海市静安区示例路 8 号',
      phone: '13800000000',
      notes: '',
      businessHours: [{ start: '10:00', end: '21:00' }],
    },
    categories: [{ draftId: 'cat-1', name: '招牌主食', sortOrder: 1 }],
    products: [
      { draftId: 'dish-1', categoryDraftId: 'cat-1', name: '宫保鸡丁', priceCents: 2800, available: true },
      { draftId: 'dish-2', categoryDraftId: 'cat-1', name: '番茄炒蛋', priceCents: 1600, available: true },
      { draftId: 'dish-3', categoryDraftId: 'cat-1', name: '米饭', priceCents: 300, available: true },
    ],
    tables: [{ draftId: 'table-1', name: 'A01', sortOrder: 1 }],
    sourceDraftDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingStore> = {}): ExistingStore {
  return {
    name: '柑橘小馆',
    category: '社区餐馆',
    address: '示范市演示路 1 号',
    phone: '000-0000-0000',
    businessHours: '10:00-21:00',
    categories: [
      {
        id: 'cat_sig',
        name: '招牌主食',
        sortOrder: 1,
        products: [
          { id: 'prd_beef', name: '宫保鸡丁', priceCents: 2600, available: true },
        ],
      },
    ],
    tables: [{ id: 'tbl_A01', name: 'A01', sortOrder: 1 }],
    ...overrides,
  };
}

describe('受控导入 DTO/纯函数校验', () => {
  it('正常 payload 通过', () => {
    expect(validateImportPayload(payload())).toEqual({ ok: true });
  });

  it('营业时间格式、范围、重叠与拼接长度', () => {
    expect(validateBusinessHours([{ start: '21:00', end: '10:00' }])).toMatchObject({ code: 'HOURS_RANGE' });
    expect(validateBusinessHours([{ start: '10:00', end: '14:00' }, { start: '13:00', end: '18:00' }])).toMatchObject({ code: 'HOURS_OVERLAP' });
    expect(validateBusinessHours([{ start: '9:00', end: '18:00' }])).toMatchObject({ code: 'HOURS_FORMAT' });
    expect(validateBusinessHours([])).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(joinBusinessHours([{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }])).toBe('10:00-14:00,17:00-21:00');
  });

  it('数量边界：菜品 3–5、分类 ≤3、桌号 ≤20', () => {
    expect(validateImportPayload(payload({ products: payload().products.slice(0, 2) }))).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(validateImportPayload(payload({ categories: Array.from({ length: 4 }, (_, index) => ({ draftId: `c${index}`, name: `分类${index}` })) }))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('请求内重名与非法 draftId', () => {
    expect(validateImportPayload(payload({
      categories: [{ draftId: 'c1', name: '主食' }, { draftId: 'c2', name: '主食' }],
    }))).toMatchObject({ code: 'DUPLICATE_CATEGORY' });
    expect(validateImportPayload(payload({
      products: [
        { draftId: 'd1', categoryDraftId: 'cat-1', name: '米饭', priceCents: 300, available: true },
        { draftId: 'd2', categoryDraftId: 'cat-1', name: '米饭', priceCents: 200, available: true },
        { draftId: 'd3', categoryDraftId: 'cat-1', name: '汤', priceCents: 500, available: true },
      ],
    }))).toMatchObject({ code: 'DUPLICATE_PRODUCT' });
    expect(validateImportPayload(payload({
      tables: [{ draftId: 't1', name: 'A01' }, { draftId: 't2', name: 'A01' }],
    }))).toMatchObject({ code: 'DUPLICATE_TABLE' });
    expect(validateImportPayload(payload({
      categories: [{ draftId: 'dup', name: '主食' }],
      products: payload().products.map((item) => ({ ...item, draftId: 'dup' })),
    }))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('价格与分类引用校验', () => {
    const badPrice = payload().products.map((item, index) => (index === 0 ? { ...item, priceCents: 0 } : item));
    expect(validateImportPayload(payload({ products: badPrice }))).toMatchObject({ code: 'PRICE_RANGE' });
    const badCategory = payload().products.map((item, index) => (index === 0 ? { ...item, categoryDraftId: 'missing' } : item));
    expect(validateImportPayload(payload({ products: badCategory }))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('外送与不支持的字段', () => {
    expect(validateImportPayload(payload({ delivery: true }))).toMatchObject({ code: 'DELIVERY_NOT_SUPPORTED' });
    expect(validateImportPayload(payload({ sourceDraftDigest: 'xyz' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('幂等键格式', () => {
    expect(validateIdempotencyKey(undefined)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(validateIdempotencyKey('short')).toMatchObject({ code: 'BAD_REQUEST' });
    expect(validateIdempotencyKey('idem-12345678')).toEqual({ ok: true });
  });
});

describe('差异计算与确认', () => {
  it('同名分类/桌号默认 skip，不覆盖既有记录', () => {
    const diff = computeImportDiff(payload(), existing());
    expect(diff.categories[0]).toMatchObject({ action: 'skip', existingId: 'cat_sig' });
    expect(diff.tables[0]).toMatchObject({ action: 'skip', existingId: 'tbl_A01' });
  });

  it('价格变化进入冲突并收集确认键', () => {
    const diff = computeImportDiff(payload(), existing());
    const matched = diff.products.find((item) => item.name === '宫保鸡丁');
    expect(matched).toMatchObject({ action: 'conflict', existingId: 'prd_beef' });
    expect(matched?.reasons).toContain('PRICE_CHANGED');
    expect(diff.conflicts).toContain('product:dish-1');
    expect(assertConfirmations(diff, [])).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(assertConfirmations(diff, ['product:dish-1', 'profile.name'])).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(assertConfirmations(diff, ['product:dish-1', 'profile.name', 'profile.address', 'profile.phone'])).toEqual({ ok: true });
  });

  it('上架状态变化同样进入冲突，不静默上架/下架', () => {
    const withUnlisted = existing({
      categories: [{
        id: 'cat_sig',
        name: '招牌主食',
        sortOrder: 1,
        products: [{ id: 'prd_beef', name: '宫保鸡丁', priceCents: 2800, available: false }],
      }],
    });
    const diff = computeImportDiff(payload(), withUnlisted);
    expect(diff.products.find((item) => item.name === '宫保鸡丁')?.reasons).toContain('WILL_LIST');
  });

  it('profile 字段变化逐项进入冲突', () => {
    const diff = computeImportDiff(payload(), existing());
    expect(diff.profile.find((item) => item.field === 'name')?.action).toBe('conflict');
    expect(diff.profile.find((item) => item.field === 'category')?.action).toBe('skip');
    expect(diff.conflicts).toContain('profile.name');
  });

  it('未声明项不删除，notImported 明确列出外送与图片', () => {
    const diff = computeImportDiff(payload({ unsupported: { images: true, modifiers: true, specs: true } }), existing());
    expect(diff.notImported).toEqual(['菜品图片', '加料', '规格', '外送']);
    expect(diff.tables).toHaveLength(1);
    expect(diff.categories).toHaveLength(1);
  });
});