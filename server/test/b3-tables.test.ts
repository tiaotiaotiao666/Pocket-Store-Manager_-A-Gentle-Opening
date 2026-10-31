import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_OPEN_ID,
  OTHER_STORE_ID,
  STORE_ID,
  authHeader,
  createOrderPayload,
  createTestApp,
  loginAs,
  prepareDatabase,
  uniqueKey,
} from './helpers/b1-fixtures';

let app: INestApplication;
let customerToken: string;

beforeAll(async () => {
  await prepareDatabase();
  app = await createTestApp();
  customerToken = await loginAs(app, CUSTOMER_OPEN_ID);
}, 120000);

afterAll(async () => {
  await app?.close();
});

describe('B3 公开桌号接口', () => {
  it('无需登录返回排序稳定的桌号，且不含订单字段', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}/tables`);
    expect(response.status).toBe(200);
    expect(response.body.storeId).toBe(STORE_ID);
    expect(Array.isArray(response.body.tables)).toBe(true);
    expect(response.body.tables.length).toBeGreaterThanOrEqual(2);
    expect(response.body.tables[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      name: expect.any(String),
      sortOrder: expect.any(Number),
    }));
    const sortOrders = response.body.tables.map((table: { sortOrder: number }) => table.sortOrder);
    expect(sortOrders).toEqual([...sortOrders].sort((a, b) => a - b));
    response.body.tables.forEach((table: Record<string, unknown>) => {
      expect(Object.keys(table).sort()).toEqual(['id', 'name', 'sortOrder']);
    });
  });

  it('门店不存在返回 404 STORE_NOT_FOUND', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/stores/missing-store/tables');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STORE_NOT_FOUND');
  });

  it('跨店桌号仍不能下单', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set(authHeader(customerToken))
      .set('Idempotency-Key', uniqueKey('b3-table'))
      .send(createOrderPayload({ storeId: OTHER_STORE_ID, tableId: 'tbl_A01' }));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('TABLE_NOT_FOUND');
  });
});