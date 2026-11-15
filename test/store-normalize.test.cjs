'use strict';

/**
 * 运行时 store-header 告警修复的回归。
 *
 * 背景：导出工程在微信开发者工具里渲染时出现
 * `property "address"/"businessHours" ... expected <String> but get null value`，
 * 原因是后端对未填字段返回 null，而组件属性声明为 String。
 * `normalizeStore` 在取数出口把 null/undefined 归一为空串。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STORE_MODULE = path.join(
  __dirname,
  '..',
  'templates',
  'base',
  'ordering-base',
  '1.0.0',
  'src',
  'services',
  'store.js',
);

test('normalizeStore 把 null/undefined 字段归一为空串', () => {
  const { normalizeStore } = require(STORE_MODULE);
  const normalized = normalizeStore({
    name: '松月食堂',
    category: null,
    address: undefined,
    phone: null,
    notes: null,
    businessHours: null,
  });
  assert.equal(normalized.name, '松月食堂');
  for (const field of ['category', 'address', 'phone', 'notes', 'businessHours']) {
    assert.equal(normalized[field], '', `${field} 应为空串`);
  }
});

test('normalizeStore 保留已有值与非对象输入', () => {
  const { normalizeStore } = require(STORE_MODULE);
  const normalized = normalizeStore({
    name: '松月食堂',
    category: '社区家常菜',
    address: '演示路 1 号',
    businessHours: '10:00-21:00',
  });
  assert.equal(normalized.category, '社区家常菜');
  assert.equal(normalized.address, '演示路 1 号');
  assert.equal(normalized.businessHours, '10:00-21:00');
  assert.equal(normalizeStore(null), null);
});
