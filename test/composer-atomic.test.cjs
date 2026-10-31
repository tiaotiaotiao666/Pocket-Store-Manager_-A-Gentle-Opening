'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const atomic = require(path.join(REPO, 'scripts', 'composer', 'atomic.cjs'));
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

test('父目录缺失时预检失败且不创建任何目录', async () => {
  const parent = path.join(os.tmpdir(), 'm5-missing-' + Date.now());
  const result = atomic.preflight({ parentDir: parent, projectName: 'demo' });
  assert.strictEqual(result.code, 'TARGET_PARENT_MISSING');
  assert.ok(!fs.existsSync(parent));
});

test('同名目录被拒绝且原内容逐字节不变', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-exists-'));
  const target = path.join(parent, 'demo-store');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'original');

  const result = atomic.preflight({ parentDir: parent, projectName: 'demo-store' });
  assert.strictEqual(result.code, 'TARGET_EXISTS');
  assert.strictEqual(result.details.suggestedName, 'demo-store-2');
  assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'original');
});

test('路径过长被拒绝', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-long-'));
  const result = atomic.preflight({ parentDir: parent, projectName: 'a'.repeat(60), maxRelativePathLength: 200 });
  assert.strictEqual(result.code, 'PATH_TOO_LONG');
});

test('staging 命名与提交：同名冲突不会覆盖', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-commit-'));
  const staging = atomic.createStaging(parent);
  assert.ok(atomic.STAGING_PATTERN.test(path.basename(staging)));
  fs.writeFileSync(path.join(staging, 'app.json'), '{}');
  const finalPath = path.join(parent, 'demo');
  const commit = atomic.commitStaging(staging, finalPath);
  assert.strictEqual(commit.ok, true);
  assert.ok(fs.existsSync(path.join(finalPath, 'app.json')));
  assert.ok(!fs.existsSync(staging));
});

test('写入阶段取消返回 EXPORT_CANCELLED', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-cancel-'));
  const staging = atomic.createStaging(parent);
  const files = new Map([
    ['a.js', 'a'],
    ['b.js', 'b'],
  ]);
  const result = await atomic.writeFiles(staging, files, { signal: { cancelled: true } });
  assert.strictEqual(result.code, 'EXPORT_CANCELLED');
  atomic.removeStaging(staging);
});

test('创建 staging 后取消整次生成不留残留', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-cancel-compose-'));
  const result = await compose({ plan: PLAN, parentDir: parent, projectName: 'demo-store', signal: { cancelled: true } });
  assert.strictEqual(result.code, 'EXPORT_CANCELLED');
  const leftovers = fs.readdirSync(parent).filter((name) => atomic.STAGING_PATTERN.test(name));
  assert.deepStrictEqual(leftovers, []);
  assert.ok(!fs.existsSync(path.join(parent, 'demo-store')));
});

test('清理超过 1 小时的自家 staging，保留新 staging 与他人目录', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-stale-'));
  const oldStaging = path.join(parent, '.smartstore-tmp-aaaaaaaa');
  const freshStaging = path.join(parent, '.smartstore-tmp-bbbbbbbb');
  const foreign = path.join(parent, 'user-folder');
  [oldStaging, freshStaging, foreign].forEach((dir) => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldStaging, twoHoursAgo, twoHoursAgo);

  const removed = atomic.cleanupStale(parent);
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(oldStaging));
  assert.ok(fs.existsSync(freshStaging));
  assert.ok(fs.existsSync(foreign));
});

test('removeStaging 只删除自家命名目录', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-remove-'));
  const foreign = path.join(parent, 'important');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'x.txt'), 'x');
  assert.strictEqual(atomic.removeStaging(foreign), false);
  assert.ok(fs.existsSync(foreign));
});

test('成功生成后父目录只保留目标工程，无 staging 残留', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-clean-'));
  const result = await compose({ plan: PLAN, parentDir: parent, projectName: 'demo-store' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const entries = fs.readdirSync(parent);
  assert.deepStrictEqual(entries, ['demo-store']);
});