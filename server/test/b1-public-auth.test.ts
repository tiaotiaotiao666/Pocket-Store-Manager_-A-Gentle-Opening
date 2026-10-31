import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_OPEN_ID,
  OTHER_STORE_ID,
  PRODUCT_UNAVAILABLE_ID,
  STORE_ID,
  authHeader,
  createTestApp,
  loginAs,
  prepareDatabase,
} from './helpers/b1-fixtures';

let app: INestApplication;

beforeAll(async () => {
  await prepareDatabase();
  app = await createTestApp();
}, 120000);

afterAll(async () => {
  await app?.close();
});

describe('健康检查与公开门店', () => {
  it('GET /health 不访问数据库也返回 200', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('GET /stores/:storeId 无需登录并返回履约与主题', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: STORE_ID,
      name: '柑橘小馆',
      fulfillment: { dineIn: true, takeaway: true },
      theme: { backgroundColor: '#F7F3EC', textColor: '#232323', primaryColor: '#E86A17' },
    });
  });

  it('门店不存在返回 404 STORE_NOT_FOUND 且带 requestId', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/stores/missing-store');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STORE_NOT_FOUND');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
  });

  it('公开目录只返回 available=true 的商品，并带 version 与 updatedAt', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/stores/${STORE_ID}/catalog`);
    expect(response.status).toBe(200);
    expect(response.body.storeId).toBe(STORE_ID);
    expect(response.body.version).toBe(1);
    expect(typeof response.body.updatedAt).toBe('string');

    const productIds = response.body.categories.flatMap(
      (category: { products: Array<{ id: string }> }) => category.products.map((product) => product.id),
    );
    expect(productIds).toContain('prd_beef_rice');
    expect(productIds).not.toContain(PRODUCT_UNAVAILABLE_ID);

    const firstCategory = response.body.categories[0];
    expect(firstCategory.products[0]).toMatchObject({
      name: '柑橘牛肉饭',
      priceCents: 2800,
      available: true,
    });
  });

  it('目录接口对不存在门店返回 404 STORE_NOT_FOUND', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/stores/missing-store/catalog');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STORE_NOT_FOUND');
  });

  it('其他门店目录按 storeId 隔离', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/stores/${OTHER_STORE_ID}/catalog`);
    expect(response.status).toBe(200);
    const productIds = response.body.categories.flatMap(
      (category: { products: Array<{ id: string }> }) => category.products.map((product) => product.id),
    );
    expect(productIds).not.toContain('prd_beef_rice');
  });
});

describe('微信登录与当前用户', () => {
  it('演示登录返回 opaque token、expiresIn 与 memberships', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ demoOpenId: 'demo-owner-001' });

    expect(response.status).toBe(200);
    expect(typeof response.body.token).toBe('string');
    expect(response.body.token.length).toBeGreaterThanOrEqual(32);
    expect(response.body.expiresIn).toBe(604800);
    expect(response.body.user.memberships).toEqual([{ storeId: STORE_ID, role: 'OWNER' }]);
    expect(JSON.stringify(response.body)).not.toContain('demo-owner-001');
  });

  it('首次登录创建用户但不授予任何门店角色', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ demoOpenId: 'demo-brand-new-customer' });

    expect(response.status).toBe(200);
    expect(response.body.user.memberships).toEqual([]);
    expect(response.body.user.displayName).toBe('微信顾客');
  });

  it('code 与 demoOpenId 同时提供返回 422', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({ code: 'fake-code', demoOpenId: CUSTOMER_OPEN_ID });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('没有任何登录凭证返回 422，且 details 给出字段', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/wechat/login')
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.details.fields).toContain('code');
  });

  it('GET /auth/me 缺少 Token 返回 401 AUTH_REQUIRED', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toMatch(/^req_/);
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(JSON.stringify(response.body)).not.toContain('stack');
  });

  it('GET /auth/me 伪造 Token 返回 401 AUTH_INVALID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer forged-token-value');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_INVALID');
  });

  it('GET /auth/me 返回用户、memberships 与 serverTime', async () => {
    const token = await loginAs(app, CUSTOMER_OPEN_ID);
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(authHeader(token));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'usr_customer_001',
      displayName: '演示顾客',
      memberships: [],
    });
    expect(typeof response.body.serverTime).toBe('string');
  });
});