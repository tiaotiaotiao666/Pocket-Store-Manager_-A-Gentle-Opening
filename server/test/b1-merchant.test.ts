import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_OPEN_ID,
  OTHER_OWNER_OPEN_ID,
  OWNER_OPEN_ID,
  PRODUCT_AVAILABLE_ID,
  PRODUCT_SECOND_ID,
  PRODUCT_UNAVAILABLE_ID,
  STAFF_OPEN_ID,
  STORE_ID,
  authHeader,
  createOrderPayload,
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

async function createOrder(token = customerToken): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(authHeader(token))
    .set('Idempotency-Key', uniqueKey('merchant'))
    .send(createOrderPayload());
  expect(response.status).toBe(201);
  return response.body.id as string;
}

async function createPaidOrder(token = customerToken): Promise<string> {
  const orderId = await createOrder(token);
  const paid = await request(app.getHttpServer())
    .post(`/api/v1/orders/${orderId}/demo-payment`)
    .set(authHeader(token));
  expect(paid.status).toBe(200);
  return orderId;
}

function patchStatus(orderId: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app.getHttpServer())
    .patch(`/api/v1/merchant/orders/${orderId}/status`)
    .set(authHeader(token))
    .send(body);
}

describe('店主订单台', () => {
  it('未登录访问商户接口返回 401', async () => {
    const response = await request(app.getHttpServer()).get(
      `/api/v1/merchant/stores/${STORE_ID}/orders`,
    );
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('非门店成员访问商户订单台返回 403 FORBIDDEN', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/orders`)
      .set(authHeader(customerToken));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('STAFF 可访问同一门店订单台', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/orders`)
      .set(authHeader(staffToken));
    expect(response.status).toBe(200);
    expect(response.body.pageSize).toBe(20);
  });

  it('订单台默认只返回 PENDING_PAYMENT 与 PENDING_ACCEPT，按创建时间升序', async () => {
    const unpaid = await createOrder();
    const paid = await createPaidOrder();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/orders?pageSize=50`)
      .set(authHeader(ownerToken));

    expect(response.status).toBe(200);
    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(unpaid);
    expect(ids).toContain(paid);
    for (const item of response.body.items) {
      expect(['PENDING_PAYMENT', 'PENDING_ACCEPT']).toContain(item.status);
    }
    const createdTimes = response.body.items.map((item: { createdAt: string }) =>
      new Date(item.createdAt).getTime(),
    );
    expect([...createdTimes].sort((left, right) => left - right)).toEqual(createdTimes);
  });

  it('订单台支持 status 过滤与分页', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/orders?status=PENDING_PAYMENT&pageSize=1`)
      .set(authHeader(ownerToken));

    expect(response.status).toBe(200);
    expect(response.body.pageSize).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].status).toBe('PENDING_PAYMENT');
  });

  it('订单台非法状态返回 422', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/orders?status=WRONG`)
      .set(authHeader(ownerToken));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('S7 店主处理待付款订单返回 409 MERCHANT_CANNOT_HANDLE_UNPAID', async () => {
    const orderId = await createOrder();
    const response = await patchStatus(orderId, {
      toStatus: 'PREPARING',
      expectedStatus: 'PENDING_ACCEPT',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('MERCHANT_CANNOT_HANDLE_UNPAID');
  });

  it('S8 跨店修改订单返回 403 FORBIDDEN', async () => {
    const orderId = await createPaidOrder();
    const response = await patchStatus(
      orderId,
      { toStatus: 'PREPARING', expectedStatus: 'PENDING_ACCEPT' },
      otherOwnerToken,
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('S9 合法逐步推进 PENDING_ACCEPT → PREPARING → READY → COMPLETED 并各写一条记录', async () => {
    const orderId = await createPaidOrder();

    const preparing = await patchStatus(orderId, {
      toStatus: 'PREPARING',
      expectedStatus: 'PENDING_ACCEPT',
    });
    expect(preparing.status).toBe(200);
    expect(preparing.body.status).toBe('PREPARING');

    const ready = await patchStatus(orderId, { toStatus: 'READY', expectedStatus: 'PREPARING' });
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('READY');

    const completed = await patchStatus(orderId, {
      toStatus: 'COMPLETED',
      expectedStatus: 'READY',
    });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('COMPLETED');

    const prisma = createTestPrisma();
    const logs = await prisma.orderStatusLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs).toHaveLength(5);
    expect(logs.slice(2).map((log) => log.toStatus)).toEqual(['PREPARING', 'READY', 'COMPLETED']);
    expect(logs.slice(2).every((log) => log.actorType === 'MERCHANT')).toBe(true);
    await prisma.$disconnect();
  });

  it('S10 跳过中间状态返回 409 INVALID_STATUS_TRANSITION', async () => {
    const orderId = await createPaidOrder();
    const response = await patchStatus(orderId, {
      toStatus: 'READY',
      expectedStatus: 'PENDING_ACCEPT',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('expectedStatus 与当前状态不一致返回 409 STATUS_CONFLICT', async () => {
    const orderId = await createPaidOrder();
    const response = await patchStatus(orderId, {
      toStatus: 'PREPARING',
      expectedStatus: 'READY',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATUS_CONFLICT');
  });

  it('店主取消订单必须填写 reason', async () => {
    const orderId = await createPaidOrder();
    const missing = await patchStatus(orderId, { toStatus: 'CANCELLED' });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('VALIDATION_ERROR');

    const cancelled = await patchStatus(orderId, {
      toStatus: 'CANCELLED',
      reason: '顾客电话取消',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.paymentStatus).toBe('DEMO_PAID');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeader(customerToken));
    expect(detail.body.statusHistory.at(-1)).toMatchObject({
      toStatus: 'CANCELLED',
      actorType: 'MERCHANT',
      reason: '顾客电话取消',
    });
  });

  it('订单不存在返回 404 ORDER_NOT_FOUND', async () => {
    const response = await patchStatus('ord_missing_000000000000', { toStatus: 'PREPARING' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('非法 toStatus 返回 422', async () => {
    const orderId = await createPaidOrder();
    const response = await patchStatus(orderId, { toStatus: 'DONE' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('店主商品管理', () => {
  it('店主商品列表包含下架商品且不返回 version', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/products`)
      .set(authHeader(ownerToken));

    expect(response.status).toBe(200);
    expect(response.body.storeId).toBe(STORE_ID);
    expect(response.body).not.toHaveProperty('version');

    const products = response.body.categories.flatMap(
      (category: { products: Array<{ id: string; available: boolean; updatedAt: string }> }) =>
        category.products,
    );
    const stopped = products.find(
      (product: { id: string }) => product.id === PRODUCT_UNAVAILABLE_ID,
    );
    expect(stopped.available).toBe(false);
    expect(typeof stopped.updatedAt).toBe('string');
  });

  it('跨店访问商品列表返回 403 FORBIDDEN', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/merchant/stores/${STORE_ID}/products`)
      .set(authHeader(otherOwnerToken));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('商品不存在返回 404 PRODUCT_NOT_FOUND', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/merchant/products/prd_missing/availability')
      .set(authHeader(ownerToken))
      .send({ available: false });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('跨店修改商品返回 403 FORBIDDEN', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/merchant/products/${PRODUCT_SECOND_ID}/availability`)
      .set(authHeader(otherOwnerToken))
      .send({ available: false });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('available 非布尔值返回 422', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/merchant/products/${PRODUCT_SECOND_ID}/availability`)
      .set(authHeader(ownerToken))
      .send({ available: 'false' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('S12 停售后公开目录缓存失效、版本递增，历史订单快照不变', async () => {
    const orderId = await createPaidOrder();

    const before = await request(app.getHttpServer()).get(
      `/api/v1/stores/${STORE_ID}/catalog`,
    );
    expect(before.status).toBe(200);
    const versionBefore = before.body.version as number;

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/merchant/products/${PRODUCT_AVAILABLE_ID}/availability`)
      .set(authHeader(ownerToken))
      .send({ available: false });
    expect(patched.status).toBe(200);
    expect(patched.body.available).toBe(false);

    const after = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}/catalog`);
    expect(after.status).toBe(200);
    expect(after.body.version).toBeGreaterThan(versionBefore);
    const visibleIds = after.body.categories.flatMap(
      (category: { products: Array<{ id: string }> }) => category.products.map((product) => product.id),
    );
    expect(visibleIds).not.toContain(PRODUCT_AVAILABLE_ID);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeader(customerToken));
    expect(detail.body.items[0]).toMatchObject({
      productId: PRODUCT_AVAILABLE_ID,
      name: '柑橘牛肉饭',
      unitPriceCents: 2800,
    });

    const restored = await request(app.getHttpServer())
      .patch(`/api/v1/merchant/products/${PRODUCT_AVAILABLE_ID}/availability`)
      .set(authHeader(ownerToken))
      .send({ available: true });
    expect(restored.status).toBe(200);
    expect(restored.body.available).toBe(true);

    const restoredCatalog = await request(app.getHttpServer()).get(
      `/api/v1/stores/${STORE_ID}/catalog`,
    );
    const restoredIds = restoredCatalog.body.categories.flatMap(
      (category: { products: Array<{ id: string }> }) => category.products.map((product) => product.id),
    );
    expect(restoredIds).toContain(PRODUCT_AVAILABLE_ID);
  });

  it('STAFF 也可以上下架商品', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/merchant/products/${PRODUCT_SECOND_ID}/availability`)
      .set(authHeader(staffToken))
      .send({ available: true });
    expect(response.status).toBe(200);
  });
});