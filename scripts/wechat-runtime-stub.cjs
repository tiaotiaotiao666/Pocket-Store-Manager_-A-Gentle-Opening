#!/usr/bin/env node
/**
 * W5：微信小程序运行验证用的「本机桩后端」。
 *
 * 用途：本机 NestJS 服务端存在既有 TypeScript 编译错误、无法启动，
 * 为了让导出的微信小程序在开发者工具里走真实渲染与交互路径，
 * 这里提供一组只读桩接口（门店 / 菜单 / 桌号 / 海报 / 演示登录）。
 *
 * 明确边界：
 * - 这不是真实后端，只用于 UI 运行验证；不得用于生产、不得对外宣称接口可用。
 * - 数据全部为本脚本内的演示数据，不读写数据库、不联网。
 *
 * 用法：node scripts/wechat-runtime-stub.cjs [--port 3000]
 */
'use strict';

const http = require('node:http');

const STORE = {
  id: 'store-demo-001',
  name: 'W5 审核小馆',
  description: '本机桩后端演示门店',
  address: '演示路 1 号',
  phone: '000-0000-0000',
  businessHours: '10:00-21:00',
  notice: '演示数据，不产生真实订单与真实支付',
  status: 'OPEN',
  fulfillment: { dineIn: true, takeaway: true },
  delivery: { enabled: false, minCents: 0, feeCents: 0 },
  poster: null,
};

const CATEGORIES = [
  {
    id: 'cat-hot',
    name: '招牌热菜',
    products: [
      { id: 'dish-001', name: '招牌红烧肉', description: '慢炖三小时', priceCents: 3800, priceText: '¥38.00', available: true, image: '', tags: ['招牌'] },
      { id: 'dish-002', name: '干锅花菜', description: '微辣下饭', priceCents: 2600, priceText: '¥26.00', available: true, image: '', tags: ['热销'] },
    ],
  },
  {
    id: 'cat-cold',
    name: '凉菜小食',
    products: [
      { id: 'dish-003', name: '口水鸡', description: '微麻微辣', priceCents: 2200, priceText: '¥22.00', available: true, image: '', tags: [] },
      { id: 'dish-004', name: '拍黄瓜', description: '清爽解腻', priceCents: 1200, priceText: '¥12.00', available: false, image: '', tags: ['售罄'] },
    ],
  },
  {
    id: 'cat-drink',
    name: '饮品',
    products: [
      { id: 'dish-005', name: '酸梅汤', description: '冰镇', priceCents: 800, priceText: '¥8.00', available: true, image: '', tags: [] },
    ],
  },
];

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (req.method === 'GET' && /^\/stores\/[^/]+$/.test(path)) return sendJson(res, 200, STORE);
    if (req.method === 'GET' && /^\/stores\/[^/]+\/catalog$/.test(path)) {
      return sendJson(res, 200, { storeId: STORE.id, categories: CATEGORIES, version: 'w5-stub-1' });
    }
    if (req.method === 'GET' && /^\/stores\/[^/]+\/tables$/.test(path)) {
      return sendJson(res, 200, {
        tables: [
          { id: 'tbl_A01', name: 'A01' },
          { id: 'tbl_A02', name: 'A02' },
        ],
      });
    }
    if (req.method === 'GET' && /^\/stores\/[^/]+\/posters$/.test(path)) {
      return sendJson(res, 200, { posters: [] });
    }
    if (req.method === 'POST' && path === '/auth/wechat/login') {
      return sendJson(res, 200, {
        token: 'w5-stub-token',
        openId: 'demo-customer-001',
        identity: 'customer',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    return sendJson(res, 404, { code: 'NOT_FOUND', message: '桩后端未实现：' + req.method + ' ' + path });
  });
}

if (require.main === module) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex > -1 ? Number(process.argv[portIndex + 1]) : 3000;
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log('W5 桩后端已启动：http://127.0.0.1:' + port + '/api/v1（演示数据，非真实服务）');
  });
}

module.exports = { createServer, STORE, CATEGORIES };
