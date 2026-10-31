import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../src/common/auth/session-auth.guard';
import {
  CUSTOMER_OPEN_ID,
  STORE_ID,
  authHeader,
  createOrderPayload,
  createTestApp,
  createTestPrisma,
  prepareDatabase,
} from './helpers/b1-fixtures';

let app: INestApplication;
let token: string;

const PRODUCTION_TOKEN = 'production-disabled-demo-token-0123456789';

beforeAll(async () => {
  await prepareDatabase();
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_DEMO_LOGIN = 'false';
  process.env.ALLOW_DEMO_PAYMENT = 'false';
  process.env.WECHAT_APP_ID = 'wx-production-test-app';
  process.env.WECHAT_APP_SECRET = 'wx-production-test-secret';
  process.env.AGENT_REQUIRE_AUTH = 'true';

  app = await createTestApp();

  const prisma = createTestPrisma();
  const user = await prisma.user.findUniqueOrThrow({ where: { openId: CUSTOMER_OPEN_ID } });
  const now = new Date();
  await prisma.session.create({
    data: {
      id: 'ses_prod_test_0000000001',
      userId: user.id,
      tokenHash: hashSessionToken(PRODUCTION_TOKEN),
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
    },
  });
  await prisma.$disconnect();
  token = PRODUCTION_TOKEN;
}, 180000);

afterAll(async () => {
  await app?.close();
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_DEMO_LOGIN = 'true';
  process.env.ALLOW_DEMO_PAYMENT = 'true';
  process.env.AGENT_REQUIRE_AUTH = 'false';
  delete process.env.WECHAT_APP_ID;
  delete process.env.WECHAT_APP_SECRET;
});

describe('S11 生产环境拒绝演示能力', () => {
  it('生产环境演示登录返回 403 DEMO_LOGIN_DISABLED', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ demoOpenId: CUSTOMER_OPEN_ID });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEMO_LOGIN_DISABLED');
    expect(response.body.requestId).toMatch(/^req_/);
  });

  it('生产环境模拟付款返回 403 DEMO_PAYMENT_DISABLED，且不改变订单', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set(authHeader(token))
      .set('Idempotency-Key', 'production-order-key-0001')
      .send(createOrderPayload());

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING_PAYMENT');

    const payment = await request(app.getHttpServer())
      .post(`/api/v1/orders/${created.body.id}/demo-payment`)
      .set(authHeader(token));

    expect(payment.status).toBe(403);
    expect(payment.body.code).toBe('DEMO_PAYMENT_DISABLED');
    expect(payment.body.message).toContain('不允许模拟支付');

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${created.body.id}`)
      .set(authHeader(token));
    expect(detail.body.status).toBe('PENDING_PAYMENT');
    expect(detail.body.paymentStatus).toBe('UNPAID');
    expect(detail.body.statusHistory).toHaveLength(1);
  });

  it('生产环境订单仍按 storeId 隔离且目录可公开读取', async () => {
    const catalog = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}/catalog`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.storeId).toBe(STORE_ID);
  });
});