'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { validateComposition } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { fileSha256, listTree } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

function outputDir(parent) {
  return path.join(parent, 'demo-store');
}

test('两次生成（不同父目录、不同时间）产物树与 Lock 摘要一致', async () => {
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-a-'));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-b-'));

  const first = await compose({ plan: PLAN, parentDir: parentA, projectName: 'demo-store', mode: 'development', generatedAt: '2026-11-20T00:00:00Z' });
  const second = await compose({ plan: PLAN, parentDir: parentB, projectName: 'demo-store', mode: 'development', generatedAt: '2026-11-21T00:00:00Z' });

  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(first.treeSha256, second.treeSha256);
  assert.strictEqual(first.lockDigest, second.lockDigest);
  assert.notStrictEqual(first.lock.generatedAt, second.lock.generatedAt);

  const filesA = listTree(outputDir(parentA)).sort();
  const filesB = listTree(outputDir(parentB)).sort();
  assert.deepStrictEqual(filesA, filesB);
  filesA.forEach((file) => {
    if (file === 'generation-report.json' || file === '生成报告.md' || file === 'composition.lock.json') return;
    assert.strictEqual(
      fileSha256(path.join(outputDir(parentA), file)),
      fileSha256(path.join(outputDir(parentB), file)),
      file + ' 摘要不一致',
    );
  });
});

test('Plan 变更会导致产物树变化', async () => {
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-c-'));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-d-'));
  const changed = { ...JSON.parse(JSON.stringify(PLAN)), themeTokens: { ...PLAN.themeTokens, primaryColor: '#1F6F54' } };

  const first = await compose({ plan: PLAN, parentDir: parentA, projectName: 'demo-store' });
  const second = await compose({ plan: changed, parentDir: parentB, projectName: 'demo-store' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.notStrictEqual(first.treeSha256, second.treeSha256);
});

test('Plan 与注册表版本不一致被拒绝', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-e-'));
  const changed = { ...JSON.parse(JSON.stringify(PLAN)), registryVersion: '2020.01.0' };
  const result = await compose({ plan: changed, parentDir: parent, projectName: 'demo-store' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'REGISTRY_VERSION_MISMATCH');
});

test('validateComposition 不写盘且返回能力摘要', async () => {
  const result = validateComposition(PLAN);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(result.planDigest.startsWith('sha256:'));
  assert.deepStrictEqual(result.warnings, []);
});

test('生成成功后存在 Lock、报告与可解析配置', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-det-f-'));
  const result = await compose({ plan: PLAN, parentDir: parent, projectName: 'demo-store' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));

  const out = outputDir(parent);
  ['app.json', 'config/store.generated.js', 'composition.lock.json', 'generation-report.json', '生成报告.md'].forEach((file) => {
    assert.ok(fs.existsSync(path.join(out, file)), '缺少 ' + file);
  });
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'composition.lock.json'), 'utf8'));
  assert.strictEqual(lock.lockVersion, 'lock.v1');
  assert.ok(lock.outputDigest.tree.startsWith('sha256:'));
  assert.ok(lock.sourceDigests.length > 50);
  assert.ok(lock.generatedAt.endsWith('Z'));

  const report = JSON.parse(fs.readFileSync(path.join(out, 'generation-report.json'), 'utf8'));
  assert.strictEqual(report.wechatCompile.result, 'not-run');
  assert.ok(report.checks.some((item) => item.id === 'static-check' && item.result === 'pass'));
  assert.ok(report.output.projectPath.endsWith('demo-store'));
});