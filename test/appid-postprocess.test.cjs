'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { treeSha256, fileSha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const {
  applyAppid,
  verifyOutputDigests,
  digestManifest,
  maskAppid,
  AppidError,
} = require(path.join(REPO, 'desktop', 'appid-postprocess.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

async function buildProject(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-appid-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const result = await compose({
    plan: { ...PLAN, previewOnlyAck: true },
    parentDir: parent,
    projectName: 'appid-check',
    mode: 'development',
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  return result.outputPath;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('C2–C4：生成时摘要自洽；清单口径可复现；整目录口径必然不等', async (t) => {
  const outputPath = await buildProject(t);
  const lock = readJson(path.join(outputPath, 'composition.lock.json'));
  const report = readJson(path.join(outputPath, 'generation-report.json'));

  assert.strictEqual(report.output.treeSha256, lock.outputDigest.tree);
  const manifest = lock.outputDigest.files.map((item) => item.path);
  const recomputed = digestManifest(outputPath, manifest);
  assert.strictEqual(recomputed.tree, lock.outputDigest.tree);
  assert.deepStrictEqual(recomputed.files, lock.outputDigest.files);

  const wholeTree = treeSha256(outputPath);
  assert.notStrictEqual(wholeTree, lock.outputDigest.tree, '整目录口径因 lock/report 存在必然不同');
});

test('C5–C7：改写后回填自洽；改动非目标文件会被自检拒绝并回滚', async (t) => {
  const outputPath = await buildProject(t);
  const lockBefore = readJson(path.join(outputPath, 'composition.lock.json'));
  const reportBefore = readJson(path.join(outputPath, 'generation-report.json'));
  const configBefore = readJson(path.join(outputPath, 'project.config.json'));
  assert.strictEqual(configBefore.appid, 'touristappid');
  const target = 'wx1234567890abcdef';

  const applied = applyAppid({ outputPath, appid: target });
  assert.strictEqual(applied.applied, true);
  assert.strictEqual(applied.unchanged, false);
  assert.ok(applied.digestAfter);
  assert.notStrictEqual(applied.lockDigestBefore, applied.lockDigestAfter);

  const lockAfter = readJson(path.join(outputPath, 'composition.lock.json'));
  const reportAfter = readJson(path.join(outputPath, 'generation-report.json'));
  assert.strictEqual(readJson(path.join(outputPath, 'project.config.json')).appid, target);
  assert.strictEqual(lockAfter.planDigest, lockBefore.planDigest);
  assert.strictEqual(lockAfter.registryDigest, lockBefore.registryDigest);
  assert.deepStrictEqual(lockAfter.features, lockBefore.features);
  assert.strictEqual(reportAfter.output.treeSha256, lockAfter.outputDigest.tree);
  assert.strictEqual(reportAfter.lock.lockDigest, lockAfter.lockDigest);
  assert.deepStrictEqual(verifyOutputDigests(outputPath).ok, true);

  const sidecar = readJson(path.join(outputPath, 'appid-postprocess.json'));
  assert.strictEqual(sidecar.recordVersion, 'appid-postprocess.v1');
  assert.strictEqual(sidecar.appidMasked, maskAppid(target));
  assert.ok(!JSON.stringify(sidecar).includes(target), '侧车不得出现明文 AppID');

  const c7 = readJson(path.join(outputPath, 'app.json'));
  c7.pages = c7.pages.slice(1);
  fs.writeFileSync(path.join(outputPath, 'app.json'), JSON.stringify(c7, null, 2) + '\n');
  const beforeRetry = fs.readFileSync(path.join(outputPath, 'app.json'), 'utf8');

  assert.throws(
    () => applyAppid({ outputPath, appid: 'wxabcdef1234567890' }),
    (error) => error instanceof AppidError && ['APPID_VERIFY_FAILED', 'APPID_WRITE_FAILED'].includes(error.code),
  );
  assert.strictEqual(fs.readFileSync(path.join(outputPath, 'app.json'), 'utf8'), beforeRetry, '失败后 app.json 必须回滚');
  assert.strictEqual(readJson(path.join(outputPath, 'project.config.json')).appid, target, '失败后 project.config.json 必须回滚');
});

test('重复写入同一 AppID 短路，不产生新备份', async (t) => {
  const outputPath = await buildProject(t);
  const target = 'wx1234567890abcdef';
  applyAppid({ outputPath, appid: target });
  const second = applyAppid({ outputPath, appid: target });
  assert.strictEqual(second.unchanged, true);
  assert.strictEqual(second.backupDir, null);
});

test('非法 AppID 与缺失产物在改动文件前失败', async (t) => {
  const outputPath = await buildProject(t);
  const configPath = path.join(outputPath, 'project.config.json');
  const before = fs.statSync(configPath).mtimeMs;
  assert.throws(
    () => applyAppid({ outputPath, appid: 'wx123' }),
    (error) => error.code === 'APPID_INVALID',
  );
  assert.strictEqual(fs.statSync(configPath).mtimeMs, before);

  assert.throws(
    () => applyAppid({ outputPath: path.join(outputPath, 'not-exist'), appid: 'wx1234567890abcdef' }),
    (error) => error.code === 'APPID_TARGET_MISSING',
  );
});

test('清单缺少 project.config.json 时拒绝回填', async (t) => {
  const outputPath = await buildProject(t);
  const lockFile = path.join(outputPath, 'composition.lock.json');
  const lock = readJson(lockFile);
  lock.outputDigest.files = lock.outputDigest.files.filter((item) => item.path !== 'project.config.json');
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  assert.throws(
    () => applyAppid({ outputPath, appid: 'wx1234567890abcdef' }),
    (error) => error.code === 'APPID_TARGET_MISSING',
  );
});