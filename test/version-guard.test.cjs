'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const guard = require(path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src', 'domain', 'versionGuard.js'));

test('本地版本落后时提示刷新', () => {
  const result = guard.compareVersions(3, 5);
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.shouldRefresh, true);
  assert.ok(result.message.includes('刷新'));
});

test('版本相等或本地更高时不提示', () => {
  assert.deepStrictEqual(guard.compareVersions(5, 5), {
    stale: false,
    shouldRefresh: false,
    unknown: false,
    message: '',
  });
  assert.strictEqual(guard.compareVersions(6, 5).stale, false);
});

test('在线或本地版本缺失时不做错误判断', () => {
  assert.strictEqual(guard.compareVersions(null, 5).unknown, true);
  assert.strictEqual(guard.compareVersions(3, null).unknown, true);
  assert.strictEqual(guard.compareVersions(3, undefined).stale, false);
});

test('桌号不再由版本守卫兜底：resolveTables 已移除，桌号只走 domain/tableOptions', () => {
  assert.strictEqual(guard.resolveTables, undefined);
  const tableOptions = require(path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src', 'domain', 'tableOptions.js'));
  assert.strictEqual(typeof tableOptions.loadTableOptions, 'function');
});

test('Base 服务层提供 getTables 且只调用公开接口', () => {
  const storeService = require(path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src', 'services', 'store.js'));
  assert.strictEqual(typeof storeService.getTables, 'function');
  const source = require('node:fs').readFileSync(
    path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src', 'services', 'store.js'),
    'utf8',
  );
  assert.match(source, /\/stores\/.*\/tables/);
  assert.match(source, /auth: false/);
});