import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_OPEN_ID,
  OTHER_OWNER_OPEN_ID,
  OWNER_OPEN_ID,
  STAFF_OPEN_ID,
  STORE_ID,
  authHeader,
  createTestApp,
  createTestPrisma,
  loginAs,
  prepareDatabase,
  uniqueKey,
} from './helpers/b1-fixtures';

let app: INestApplication;
let ownerToken: string;
let staffToken: string;
let customerToken: string;
let otherOwnerToken: string;

const BASE_PROFILE = {
  name: '柑橘小馆',
  category: '社区餐馆',
  address: '示范市演示路 1 号',
  phone: '000-0000-0000',
  notes: '',
  businessHours: [{ start: '10:00', end: '21:00' }],
};

function importPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: BASE_PROFILE,
    categories: [{ draftId: 'cat-new', name: '店主新分类', sortOrder: 3 }],
    products: [
      { draftId: 'dish-a', categoryDraftId: 'cat-new', name: '松月炒饭', priceCents: 2200, available: true },
      { draftId: 'dish-b', categoryDraftId: 'cat-new', name: '时蔬小炒', priceCents: 1800, available: true },
      { draftId: 'dish-c', categoryDraftId: 'cat-new', name: '例汤', priceCents: 600, available: true },
    ],
    tables: [{ draftId: 'table-b', name: 'B01', sortOrder: 3 }],
    sourceDraftDigest: 'a'.repeat(64),
    unsupported: { images: true, modifiers: false, specs: false },
    ...overrides,
  };
}

function preview(body = importPayload(), token = ownerToken) {
  return request(app.getHttpServer())
    .post(`/api/v1/merchant/stores/${STORE_ID}/imports`)
    .set(authHeader(token))
    .send({ mode: 'preview', payload: body });
}

function apply(body: Record<string, unknown>, previewToken: string, key: string, token = ownerToken, confirmations: string[] = []) {
  return request(app.getHttpServer())
    .post(`/api/v1/merchant/stores/${STORE_ID}/imports`)
    .set(authHeader(token))
    .set('Idempotency-Key', key)
    .send({ mode: 'apply', payload: body, previewToken, confirmations });
}

async function counts() {
  const prisma = createTestPrisma();
  try {
    return {
      categories: await prisma.category.count({ where: { storeId: STORE_ID } }),
      products: await prisma.product.count({ where: { storeId: STORE_ID } }),
      tables: await prisma.storeTable.count({ where: { storeId: STORE_ID } }),
      imports: await prisma.storeImport.count({ where: { storeId: STORE_ID } }),
    };
  } finally {
    await prisma.$disconnect();
  }
}

beforeAll(async () => {
  await prepareDatabase();
  app = await createTestApp();
  ownerToken = await loginAs(app, OWNER_OPEN_ID);
  staffToken = await loginAs(app, STAFF_OPEN_ID);
  customerToken = await loginAs(app, CUSTOMER_OPEN_ID);
  otherOwnerToken = await loginAs(app, OTHER_OWNER_OPEN_ID);
}, 120000);

afterAll(async () => {
  await app?.close();
});

describe('B3 受控导入', () => {
  it('preview 返回差异与 previewToken，且不写库', async () => {
    const before = await counts();
    const response = await preview();
    expect(response.status).toBe(201);
    expect(response.body.mode).toBe('preview');
    expect(response.body.previewToken).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(response.body.summary).toMatchObject({ create: 5, skip: 5, conflict: 0 });
    expect(response.body.notImported).toContain('菜品图片');
    expect(response.body.notImported).toContain('外送');
    expect(await counts()).toEqual(before);
  });

  it('apply 写入分类/商品/桌号、递增双版本并返回完整 mapping', async () => {
    const body = importPayload();
    const previewed = await preview(body);
    const result = await apply(body, previewed.body.previewToken, uniqueKey('b3-apply'));
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('APPLIED');
    expect(result.body.replay).toBe(false);
    expect(Object.keys(result.body.mapping.categories)).toEqual(['cat-new']);
    expect(Object.keys(result.body.mapping.products).sort()).toEqual(['dish-a', 'dish-b', 'dish-c']);
    expect(Object.keys(result.body.mapping.tables)).toEqual(['table-b']);
    expect(result.body.configVersion).toBe(2);
    expect(result.body.catalogVersion).toBe(2);
    expect(result.body.cacheRefreshed).toBe(true);

    const store = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}`);
    expect(store.body.configVersion).toBe(2);
    expect(store.body.catalogVersion).toBe(2);

    const imported = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/imports/${result.body.importId}`)
      .set(authHeader(ownerToken));
    expect(imported.status).toBe(200);
    expect(imported.body.status).toBe('APPLIED');
  });

  it('同一幂等键重放返回首次结果且版本不再递增', async () => {
    const body = importPayload({
      categories: [{ draftId: 'cat-replay', name: '重放分类', sortOrder: 9 }],
      products: [
        { draftId: 'r-1', categoryDraftId: 'cat-replay', name: '重放菜一', priceCents: 1000, available: true },
        { draftId: 'r-2', categoryDraftId: 'cat-replay', name: '重放菜二', priceCents: 1200, available: true },
        { draftId: 'r-3', categoryDraftId: 'cat-replay', name: '重放菜三', priceCents: 1400, available: true },
      ],
      tables: [{ draftId: 'table-replay', name: 'R01', sortOrder: 9 }],
    });
    const key = uniqueKey('b3-replay');
    const previewed = await preview(body);
    const first = await apply(body, previewed.body.previewToken, key);
    expect(first.status).toBe(201);

    const previewedAgain = await preview(body);
    const replay = await apply(body, previewedAgain.body.previewToken, key);
    expect(replay.status).toBe(201);
    expect(replay.body.replay).toBe(true);
    expect(replay.body.importId).toBe(first.body.importId);
    expect(replay.body.configVersion).toBe(first.body.configVersion);
  });

  it('同一幂等键不同内容返回 409 IDEMPOTENCY_CONFLICT', async () => {
    const body = importPayload({
      categories: [{ draftId: 'cat-conflict-key', name: '冲突键分类', sortOrder: 9 }],
      products: [
        { draftId: 'k-1', categoryDraftId: 'cat-conflict-key', name: '键菜一', priceCents: 1000, available: true },
        { draftId: 'k-2', categoryDraftId: 'cat-conflict-key', name: '键菜二', priceCents: 1200, available: true },
        { draftId: 'k-3', categoryDraftId: 'cat-conflict-key', name: '键菜三', priceCents: 1400, available: true },
      ],
      tables: [{ draftId: 'table-key', name: 'K01', sortOrder: 9 }],
    });
    const key = uniqueKey('b3-idem');
    const previewed = await preview(body);
    await apply(body, previewed.body.previewToken, key);

    const changed = { ...body, tables: [{ draftId: 'table-key', name: 'K02', sortOrder: 9 }] };
    const previewedChanged = await preview(changed);
    const conflict = await apply(changed, previewedChanged.body.previewToken, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('缺少 previewToken 或预览过期返回 422 PREVIEW_STALE', async () => {
    const missing = await apply(importPayload(), '', uniqueKey('b3-stale'));
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('PREVIEW_STALE');

    const expired = await apply(importPayload(), '1.' + 'a'.repeat(64), uniqueKey('b3-stale'));
    expect(expired.status).toBe(422);
    expect(expired.body.code).toBe('PREVIEW_STALE');

    const previewed = await preview(importPayload());
    const tamperedBody = importPayload({ tables: [{ draftId: 'table-b', name: 'B09', sortOrder: 9 }] });
    const mismatch = await apply(tamperedBody, previewed.body.previewToken, uniqueKey('b3-stale'));
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('PREVIEW_STALE');
  });

  it('冲突默认不覆盖，必须逐项确认后才更新价格', async () => {
    const body = importPayload({
      categories: [{ draftId: 'cat-price', name: '改价分类', sortOrder: 4 }],
      products: [
        { draftId: 'p-1', categoryDraftId: 'cat-price', name: '改价菜', priceCents: 2000, available: true },
        { draftId: 'p-2', categoryDraftId: 'cat-price', name: '稳定菜', priceCents: 1500, available: true },
        { draftId: 'p-3', categoryDraftId: 'cat-price', name: '例汤', priceCents: 500, available: true },
      ],
      tables: [{ draftId: 'table-price', name: 'P01', sortOrder: 4 }],
    });
    const previewed = await preview(body);
    const applied = await apply(body, previewed.body.previewToken, uniqueKey('b3-price'));
    expect(applied.status).toBe(201);

    const changed = {
      ...body,
      products: body.products.map((item: Record<string, unknown>) => (
        item.name === '改价菜' ? { ...item, priceCents: 2600 } : item
      )),
    };
    const changedPreview = await preview(changed);
    expect(changedPreview.body.conflicts).toContain('product:p-1');
    expect(changedPreview.body.diff.products.find((item: { draftId: string }) => item.draftId === 'p-1').action).toBe('conflict');

    const unconfirmed = await apply(changed, changedPreview.body.previewToken, uniqueKey('b3-price'));
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.body.code).toBe('CONFIRMATION_REQUIRED');

    const confirmed = await apply(changed, changedPreview.body.previewToken, uniqueKey('b3-price'), ownerToken, ['product:p-1']);
    expect(confirmed.status).toBe(201);

    const prisma = createTestPrisma();
    try {
      const product = await prisma.product.findUnique({ where: { id: confirmed.body.mapping.products['p-1'] } });
      expect(product?.priceCents).toBe(2600);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('权限：STAFF、顾客、跨店店主一律 403', async () => {
    for (const token of [staffToken, customerToken, otherOwnerToken]) {
      const response = await preview(importPayload(), token);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    const anonymous = await request(app.getHttpServer())
      .post(`/api/v1/merchant/stores/${STORE_ID}/imports`)
      .send({ mode: 'preview', payload: importPayload() });
    expect(anonymous.status).toBe(401);
  });

  it('请求校验：菜品数量、重复分类、外送与非法价格', async () => {
    const twoDishes = importPayload({ products: importPayload().products.slice(0, 2) });
    const two = await preview(twoDishes);
    expect(two.status).toBe(422);
    expect(two.body.code).toBe('VALIDATION_ERROR');

    const duplicateCategory = importPayload({
      categories: [
        { draftId: 'dc-1', name: '重名分类', sortOrder: 1 },
        { draftId: 'dc-2', name: '重名分类', sortOrder: 2 },
      ],
    });
    const duplicate = await preview(duplicateCategory);
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe('DUPLICATE_CATEGORY');

    const delivery = await preview(importPayload({ delivery: true }));
    expect(delivery.status).toBe(422);
    expect(delivery.body.code).toBe('DELIVERY_NOT_SUPPORTED');

    const badPrice = importPayload({
      products: [
        { draftId: 'bp-1', categoryDraftId: 'cat-new', name: '菜一', priceCents: 0, available: true },
        { draftId: 'bp-2', categoryDraftId: 'cat-new', name: '菜二', priceCents: 100, available: true },
        { draftId: 'bp-3', categoryDraftId: 'cat-new', name: '菜三', priceCents: 200, available: true },
      ],
    });
    const price = await preview(badPrice);
    expect(price.status).toBe(422);
    expect(price.body.code).toBe('VALIDATION_ERROR');
  });

  it('校验失败不产生任何写入', async () => {
    const before = await counts();
    await preview(importPayload({ products: importPayload().products.slice(0, 2) }));
    await preview(importPayload({ delivery: true }));
    expect(await counts()).toEqual(before);
  });

  it('并发双击同一幂等键只产生一条导入记录', async () => {
    const body = importPayload({
      categories: [{ draftId: 'cat-race', name: '并发分类', sortOrder: 8 }],
      products: [
        { draftId: 'race-1', categoryDraftId: 'cat-race', name: '并发菜一', priceCents: 1000, available: true },
        { draftId: 'race-2', categoryDraftId: 'cat-race', name: '并发菜二', priceCents: 1200, available: true },
        { draftId: 'race-3', categoryDraftId: 'cat-race', name: '并发菜三', priceCents: 1400, available: true },
      ],
      tables: [{ draftId: 'table-race', name: 'X01', sortOrder: 8 }],
    });
    const key = uniqueKey('b3-race');
    const previewed = await preview(body);
    const [first, second] = await Promise.all([
      apply(body, previewed.body.previewToken, key),
      apply(body, previewed.body.previewToken, key),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const prisma = createTestPrisma();
    try {
      const records = await prisma.storeImport.count({ where: { storeId: STORE_ID, idempotencyKey: key } });
      expect(records).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});