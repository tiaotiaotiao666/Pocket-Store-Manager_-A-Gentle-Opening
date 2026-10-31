import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_OPEN_ID,
  OTHER_CUSTOMER_OPEN_ID,
  OTHER_TABLE_ID,
  OWNER_OPEN_ID,
  PRODUCT_AVAILABLE_ID,
  PRODUCT_SECOND_ID,
  PRODUCT_UNAVAILABLE_ID,
  STORE_ID,
  TABLE_ID,
  authHeader,
  createOrderPayload,
  createTestApp,
  createTestPrisma,
  loginAs,
  prepareDatabase,
  uniqueKey,
} from './helpers/b1-fixtures';

let app: INestApplication;
let customerToken: string;
let otherCustomerToken: string;
let ownerToken: string;

beforeAll(async () => {
  await prepareDatabase();
  app = await createTestApp();
  customerToken = await loginAs(app, CUSTOMER_OPEN_ID);
  otherCustomerToken = await loginAs(app, OTHER_CUSTOMER_OPEN_ID);
  ownerToken = await loginAs(app, OWNER_OPEN_ID);
}, 120000);

afterAll(async () => {
  await app?.close();
});

function postOrder(payload: Record<string, unknown>, key: string, token = customerToken) {
  return request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(authHeader(token))
    .set('Idempotency-Key', key)
    .send(payload);
}

describe('创建订单', () => {
  it('缺少 Token 返回 401 AUTH_REQUIRED', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Idempotency-Key', uniqueKey())
      .send(createOrderPayload());
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });

  it('缺少 Idempotency-Key 返回 400 BAD_REQUEST 且不落单', async () => {
    const note = `no-key-${uniqueKey('note')}`;
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set(authHeader(customerToken))
      .send(createOrderPayload({ note }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
    expect(response.body.details.fields).toContain('Idempotency-Key');

    const prisma = createTestPrisma();
    expect(await prisma.order.count({ where: { note } })).toBe(0);
    await prisma.$disconnect();
  });

  it('S1 堂食缺少桌号返回 422 TABLE_REQUIRED 且不落单', async () => {
    const note = `s1-${uniqueKey('note')}`;
    const response = await postOrder(
      createOrderPayload({ tableId: undefined, note }),
      uniqueKey('s1'),
    );

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('TABLE_REQUIRED');

    const prisma = createTestPrisma();
    expect(await prisma.order.count({ where: { note } })).toBe(0);
    await prisma.$disconnect();
  });

  it('S2 使用其他门店桌号返回 422 TABLE_NOT_FOUND', async () => {
    const response = await postOrder(
      createOrderPayload({ tableId: OTHER_TABLE_ID }),
      uniqueKey('s2'),
    );

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('TABLE_NOT_FOUND');
  });

  it('自取订单忽略 tableId 并存储 null', async () => {
    const response = await postOrder(
      createOrderPayload({ fulfillmentType: 'TAKEAWAY', tableId: TABLE_ID }),
      uniqueKey('takeaway'),
    );

    expect(response.status).toBe(201);
    expect(response.body.fulfillmentType).toBe('TAKEAWAY');
    expect(response.body.tableId).toBeNull();
    expect(response.body.tableName).toBeNull();
    expect(response.body.status).toBe('PENDING_PAYMENT');
    expect(response.body.paymentStatus).toBe('UNPAID');
  });

  it('S12 关联 停售商品返回 409 PRODUCT_UNAVAILABLE', async () => {
    const response = await postOrder(
      createOrderPayload({ items: [{ productId: PRODUCT_UNAVAILABLE_ID, quantity: 1 }] }),
      uniqueKey('unavailable'),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PRODUCT_UNAVAILABLE');
    expect(response.body.details.productId).toBe(PRODUCT_UNAVAILABLE_ID);
  });

  it('服务端按数据库单价计价，客户端传入价格字段被忽略', async () => {
    const response = await postOrder(
      {
        ...createOrderPayload(),
        totalCents: 1,
        items: [{ productId: PRODUCT_AVAILABLE_ID, quantity: 2, priceCents: 1 }],
      },
      uniqueKey('price'),
    );

    expect(response.status).toBe(201);
    expect(response.body.items).toEqual([
      {
        productId: PRODUCT_AVAILABLE_ID,
        name: '柑橘牛肉饭',
        unitPriceCents: 2800,
        quantity: 2,
        lineTotalCents: 5600,
      },
    ]);
    expect(response.body.totalCents).toBe(5600);
  });

  it('重复商品 ID 合并数量', async () => {
    const response = await postOrder(
      createOrderPayload({
        items: [
          { productId: PRODUCT_AVAILABLE_ID, quantity: 1 },
          { productId: PRODUCT_AVAILABLE_ID, quantity: 2 },
          { productId: PRODUCT_SECOND_ID, quantity: 1 },
        ],
      }),
      uniqueKey('merge'),
    );

    expect(response.status).toBe(201);
    expect(response.body.items).toHaveLength(2);
    const beef = response.body.items.find(
      (item: { productId: string }) => item.productId === PRODUCT_AVAILABLE_ID,
    );
    expect(beef.quantity).toBe(3);
    expect(beef.lineTotalCents).toBe(8400);
    expect(response.body.totalCents).toBe(8400 + 2600);
  });

  it('合并后超过 99 返回 422 VALIDATION_ERROR', async () => {
    const response = await postOrder(
      createOrderPayload({
        items: [
          { productId: PRODUCT_AVAILABLE_ID, quantity: 60 },
          { productId: PRODUCT_AVAILABLE_ID, quantity: 60 },
        ],
      }),
      uniqueKey('overflow'),
    );

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('quantity 超出 1–99 返回 422', async () => {
    const response = await postOrder(
      createOrderPayload({ items: [{ productId: PRODUCT_AVAILABLE_ID, quantity: 100 }] }),
      uniqueKey('qty'),
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('门店不存在返回 404 STORE_NOT_FOUND', async () => {
    const response = await postOrder(
      createOrderPayload({ storeId: 'store-missing' }),
      uniqueKey('store'),
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STORE_NOT_FOUND');
  });

  it('S3 相同幂等键与相同 payload 重放返回 200 与原订单', async () => {
    const key = uniqueKey('s3');
    const payload = createOrderPayload();
    const first = await postOrder(payload, key);
    const second = await postOrder(payload, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    const prisma = createTestPrisma();
    expect(await prisma.order.count({ where: { id: first.body.id } })).toBe(1);
    await prisma.$disconnect();
  });

  it('S4 相同幂等键但 payload 不同返回 409 IDEMPOTENCY_CONFLICT', async () => {
    const key = uniqueKey('s4');
    await postOrder(createOrderPayload(), key);
    const conflict = await postOrder(
      createOrderPayload({ items: [{ productId: PRODUCT_AVAILABLE_ID, quantity: 3 }] }),
      key,
    );

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('幂等键按用户隔离：其他用户使用同一 Key 可正常下单', async () => {
    const key = uniqueKey('shared');
    const mine = await postOrder(createOrderPayload(), key);
    const other = await postOrder(
      createOrderPayload({ storeId: STORE_ID, tableId: TABLE_ID }),
      key,
      otherCustomerToken,
    );

    expect(mine.status).toBe(201);
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(mine.body.id);
  });
});

describe('模拟付款与取消', () => {
  async function createUnpaidOrder(token = customerToken): Promise<string> {
    const response = await postOrder(createOrderPayload(), uniqueKey('pay'), token);
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  it('S5 本人模拟付款将订单推进到 PENDING_ACCEPT / DEMO_PAID 并写状态记录', async () => {
    const orderId = await createUnpaidOrder();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(customerToken));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('PENDING_ACCEPT');
    expect(response.body.paymentStatus).toBe('DEMO_PAID');
    expect(JSON.stringify(response.body)).not.toContain('微信支付成功');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeader(customerToken));
    expect(detail.body.statusHistory).toHaveLength(2);
    expect(detail.body.statusHistory[1]).toMatchObject({
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'PENDING_ACCEPT',
      actorType: 'CUSTOMER',
    });
  });

  it('非本人付款返回 404 ORDER_NOT_FOUND', async () => {
    const orderId = await createUnpaidOrder();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(otherCustomerToken));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('S6 重复模拟付款幂等返回当前订单且不重复写状态记录', async () => {
    const orderId = await createUnpaidOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(customerToken));
    const again = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(customerToken));

    expect(again.status).toBe(200);
    expect(again.body.status).toBe('PENDING_ACCEPT');

    const prisma = createTestPrisma();
    expect(await prisma.orderStatusLog.count({ where: { orderId } })).toBe(2);
    await prisma.$disconnect();
  });

  it('顾客取消待付款订单成功，重复取消幂等', async () => {
    const orderId = await createUnpaidOrder();
    const first = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(customerToken))
      .send({});
    const second = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(customerToken))
      .send({});

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('CANCELLED');
    expect(first.body.paymentStatus).toBe('UNPAID');
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('CANCELLED');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeader(customerToken));
    expect(detail.body.statusHistory.at(-1)).toMatchObject({
      toStatus: 'CANCELLED',
      actorType: 'CUSTOMER',
      reason: 'USER_CANCELLED',
    });
  });

  it('顾客取消已付款订单返回 409 INVALID_STATUS_TRANSITION', async () => {
    const orderId = await createUnpaidOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(customerToken));
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(customerToken))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('已取消订单再次模拟付款返回 409', async () => {
    const orderId = await createUnpaidOrder();
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(customerToken))
      .send({});
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/demo-payment`)
      .set(authHeader(customerToken));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('非本人取消返回 404', async () => {
    const orderId = await createUnpaidOrder();
    const response = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(otherCustomerToken))
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ORDER_NOT_FOUND');
  });
});

describe('订单查询', () => {
  it('GET /orders 缺少 storeId 返回 422', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set(authHeader(customerToken));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /orders 门店不存在返回 404 STORE_NOT_FOUND', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/orders?storeId=store-missing')
      .set(authHeader(customerToken));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STORE_NOT_FOUND');
  });

  it('GET /orders 只返回本人订单并支持分页', async () => {
    const mine = await postOrder(createOrderPayload(), uniqueKey('list-mine'));
    expect(mine.status).toBe(201);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders?storeId=${STORE_ID}&page=1&pageSize=2`)
      .set(authHeader(customerToken));

    expect(response.status).toBe(200);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(2);
    expect(response.body.items.length).toBeLessThanOrEqual(2);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    for (const item of response.body.items) {
      expect(item.storeId).toBe(STORE_ID);
    }

    const others = await request(app.getHttpServer())
      .get(`/api/v1/orders?storeId=${STORE_ID}&pageSize=50`)
      .set(authHeader(otherCustomerToken));
    const otherOrderIds = others.body.items.map((item: { id: string }) => item.id);
    expect(otherOrderIds).not.toContain(mine.body.id);
  });

  it('GET /orders 支持 status 过滤与 active 过滤', async () => {
    const created = await postOrder(createOrderPayload(), uniqueKey('filter'));
    const pending = await request(app.getHttpServer())
      .get(`/api/v1/orders?storeId=${STORE_ID}&status=PENDING_PAYMENT&pageSize=50`)
      .set(authHeader(customerToken));
    expect(pending.status).toBe(200);
    for (const item of pending.body.items) {
      expect(item.status).toBe('PENDING_PAYMENT');
    }
    expect(pending.body.items.map((item: { id: string }) => item.id)).toContain(created.body.id);

    const active = await request(app.getHttpServer())
      .get(`/api/v1/orders?storeId=${STORE_ID}&active=true&pageSize=50`)
      .set(authHeader(customerToken));
    expect(active.status).toBe(200);
    for (const item of active.body.items) {
      expect(['PENDING_PAYMENT', 'PENDING_ACCEPT', 'PREPARING', 'READY']).toContain(item.status);
    }
  });

  it('未知状态值返回 422 并列出非法值', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders?storeId=${STORE_ID}&status=PENDING_PAYMENT,NOT_A_STATUS`)
      .set(authHeader(customerToken));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.details.invalid).toContain('NOT_A_STATUS');
  });

  it('GET /orders/:id 本人可读并带 statusHistory', async () => {
    const created = await postOrder(createOrderPayload(), uniqueKey('detail'));
    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${created.body.id}`)
      .set(authHeader(customerToken));

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
    expect(response.body.storeName).toBe('柑橘小馆');
    expect(response.body.tableName).toBe('A01');
    expect(response.body.statusHistory).toHaveLength(1);
  });

  it('其他顾客读取订单返回 404 以隐藏订单是否存在', async () => {
    const created = await postOrder(createOrderPayload(), uniqueKey('hidden'));
    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${created.body.id}`)
      .set(authHeader(otherCustomerToken));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ORDER_NOT_FOUND');
  });

  it('门店成员可读取该店订单', async () => {
    const created = await postOrder(createOrderPayload(), uniqueKey('member-read'));
    const response = await request(app.getHttpServer())
      .get(`/api/v1/orders/${created.body.id}`)
      .set(authHeader(ownerToken));

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
  });
});