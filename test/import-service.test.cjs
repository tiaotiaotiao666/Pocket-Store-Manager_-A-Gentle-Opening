'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ENV_BACKUP = process.env;

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  return calls;
}

function draftFixture() {
  return {
    storeName: '松月食堂',
    category: '社区餐馆',
    businessHours: '10:00-14:00,17:00-21:00',
    fulfillment: { dineIn: true, takeaway: false },
    dishes: [
      { id: 'dish-1', name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣' },
      { id: 'dish-2', name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
      { id: 'dish-3', name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
    ],
  };
}

const STORE = {
  name: '松月食堂',
  type: '社区餐馆',
  address: '上海市静安区示例路 8 号',
  phone: '13800000000',
  notes: '',
};

test('AgentDraft 映射为导入 payload：3 道菜、整数分、营业时段与 notImported 声明', async () => {
  const service = await import('../src/services/importService.js');
  const payload = await service.buildImportPayload(draftFixture(), STORE);
  assert.strictEqual(payload.profile.name, '松月食堂');
  assert.strictEqual(payload.profile.category, '社区餐馆');
  assert.deepStrictEqual(payload.profile.businessHours, [
    { start: '10:00', end: '14:00' },
    { start: '17:00', end: '21:00' },
  ]);
  assert.strictEqual(payload.products.length, 3);
  assert.ok(payload.products.every((item) => Number.isInteger(item.priceCents)));
  assert.ok(payload.products.every((item) => !('priceText' in item)));
  assert.deepStrictEqual(payload.categories.map((item) => item.name), ['社区餐馆']);
  assert.strictEqual(payload.tables.length, 0);
  assert.strictEqual(payload.delivery, false);
  assert.deepStrictEqual(payload.unsupported, { images: true, modifiers: false, specs: false });
  assert.match(payload.sourceDraftDigest, /^[0-9a-f]{64}$/);

  const again = await service.buildImportPayload(draftFixture(), STORE);
  assert.strictEqual(again.sourceDraftDigest, payload.sourceDraftDigest, '相同输入摘要稳定');
});

test('preview 调用 demo 登录与受控导入接口，Token 只进 Authorization', async () => {
  const service = await import('../src/services/importService.js');
  service.resetImportSession();
  const calls = installFetch(async (url) => {
    if (url.endsWith('/auth/wechat/login')) {
      return jsonResponse({ token: 'session-token-1', expiresIn: 604800, user: { id: 'usr_1' } });
    }
    if (url.includes('/imports')) {
      return jsonResponse({
        importId: 'imp_preview',
        mode: 'preview',
        previewToken: '123.abc',
        diff: { profile: [], categories: [], products: [], tables: [] },
        conflicts: [],
        notImported: ['菜品图片', '外送'],
        summary: { create: 4, update: 0, skip: 5, conflict: 0 },
      }, 201);
    }
    throw new Error('unexpected url ' + url);
  });

  const payload = await service.buildImportPayload(draftFixture(), STORE);
  const result = await service.previewImport({ storeId: 'store-demo-001', payload });
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.data.previewToken, '123.abc');
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/auth/wechat/login'));
  assert.strictEqual(JSON.parse(calls[0].options.body).demoOpenId, 'demo-owner-001');
  assert.strictEqual(calls[1].options.headers.Authorization, 'Bearer session-token-1');
  assert.strictEqual(calls[1].options.headers['Content-Type'], 'application/json');
  assert.strictEqual(JSON.parse(calls[1].options.body).mode, 'preview');
  assert.ok(!JSON.stringify(result).includes('session-token-1'), 'Token 不得出现在返回值');
});

test('apply 携带 Idempotency-Key、previewToken 与逐项确认', async () => {
  const service = await import('../src/services/importService.js');
  service.resetImportSession();
  const calls = installFetch(async (url) => {
    if (url.endsWith('/auth/wechat/login')) return jsonResponse({ token: 'token-2' });
    return jsonResponse({
      importId: 'imp_1',
      mode: 'apply',
      status: 'APPLIED',
      replay: false,
      mapping: { categories: {}, products: {}, tables: {} },
      configVersion: 3,
      catalogVersion: 6,
      cacheRefreshed: true,
      notImported: ['外送'],
      conflicts: [],
    }, 201);
  });

  const payload = await service.buildImportPayload(draftFixture(), STORE);
  const result = await service.applyImport({
    storeId: 'store-demo-001',
    payload,
    previewToken: '999.digest',
    confirmations: ['profile.name'],
    idempotencyKey: 'idem-key-12345678',
  });
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.data.configVersion, 3);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].options.headers['Idempotency-Key'], 'idem-key-12345678');
  const body = JSON.parse(calls[1].options.body);
  assert.strictEqual(body.mode, 'apply');
  assert.strictEqual(body.previewToken, '999.digest');
  assert.deepStrictEqual(body.confirmations, ['profile.name']);
});

test('演示登录被关闭时返回 auth-unavailable 并提供小程序端提示', async () => {
  const service = await import('../src/services/importService.js');
  service.resetImportSession();
  installFetch(async (url) => {
    if (url.endsWith('/auth/wechat/login')) {
      return jsonResponse({ code: 'DEMO_LOGIN_DISABLED', message: '当前环境不允许模拟登录。' }, 403);
    }
    throw new Error('不应继续请求');
  });
  const payload = await service.buildImportPayload(draftFixture(), STORE);
  const result = await service.previewImport({ storeId: 'store-demo-001', payload });
  assert.strictEqual(result.status, 'auth-unavailable');
  assert.strictEqual(result.code, 'DEMO_LOGIN_DISABLED');
  assert.ok(result.message.includes('微信小程序端'));
});

test('后端错误码映射为中文并可重试', async () => {
  const service = await import('../src/services/importService.js');
  service.resetImportSession();
  installFetch(async (url) => {
    if (url.endsWith('/auth/wechat/login')) return jsonResponse({ token: 'token-3' });
    return jsonResponse({ code: 'CONFIRMATION_REQUIRED', message: '未确认', details: { missing: ['profile.name'] } }, 422);
  });
  const payload = await service.buildImportPayload(draftFixture(), STORE);
  const result = await service.previewImport({ storeId: 'store-demo-001', payload });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.code, 'CONFIRMATION_REQUIRED');
  assert.ok(service.describeImportError('PREVIEW_STALE').includes('重新检查'));
  assert.ok(service.describeImportError('UNKNOWN_CODE').length > 0);
});

test.after(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ENV_BACKUP)) delete process.env[key];
  });
  delete global.fetch;
});