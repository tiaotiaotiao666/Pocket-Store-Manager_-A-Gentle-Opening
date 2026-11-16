#!/usr/bin/env node
'use strict';

/**
 * 受控同步：把 Base 模板（唯一真源）复制到 `miniprogram/` 镜像目录。
 *
 * 背景：`templates/base/ordering-base/1.0.0/src` 是唯一 sourceOfTruth，
 * 交付物一律由 Composer 导出（`node scripts/composer/cli.cjs ...`）。
 * 仓库根的 `miniprogram/` 只是历史遗留的**只读镜像**，用于本地静态校验与
 * Node 侧烟雾脚本，绝不是导出成果，也不允许被当成产物。
 *
 * 本脚本替换“手工双份维护”：
 * - 覆盖写入真源存在的同名文件；
 * - 保留镜像独有文件（例如 feature-pack 叠加的 poster-carousel、tabbar 图标）；
 * - 同步后写 `miniprogram/MIRROR.json` 清单（角色 + 真源路径 + 文件数 + 整树摘要），
 *   `npm run mini:check` 会核对摘要，镜像一旦陈旧立即报错。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const MIRROR_DIR = path.join(REPO_ROOT, 'miniprogram');
const MANIFEST_NAME = 'MIRROR.json';

function walk(dir, base, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 镜像整树摘要：排除清单自身，按路径排序后对 `path:sha256` 求哈希。 */
function computeMirrorDigest(mirrorDir = MIRROR_DIR) {
  const files = walk(mirrorDir, mirrorDir).filter((file) => file !== MANIFEST_NAME);
  const hash = crypto.createHash('sha256');
  files.forEach((file) => {
    hash.update(file + ':' + sha256OfFile(path.join(mirrorDir, file)) + '\n');
  });
  return { digest: hash.digest('hex'), fileCount: files.length };
}

function readManifest(mirrorDir = MIRROR_DIR) {
  const file = path.join(mirrorDir, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 校验镜像清单：存在、真源一致、摘要与当前镜像内容一致（即镜像未陈旧）。
 * 返回 `{ ok, error }`。
 */
function verifyMirrorManifest(mirrorDir = MIRROR_DIR) {
  const manifest = readManifest(mirrorDir);
  if (!manifest) {
    return { ok: false, error: '缺少 ' + MANIFEST_NAME + '：镜像未受控同步，请运行 node scripts/sync-miniprogram-mirror.cjs' };
  }
  const expectedSource = path.relative(REPO_ROOT, SOURCE_DIR).replace(/\\/g, '/');
  if (manifest.sourceOfTruth !== expectedSource) {
    return { ok: false, error: MANIFEST_NAME + ' 记录的 sourceOfTruth 与当前真源不符（' + manifest.sourceOfTruth + ' ≠ ' + expectedSource + '）' };
  }
  const actual = computeMirrorDigest(mirrorDir);
  if (manifest.digest !== actual.digest) {
    return {
      ok: false,
      error: '镜像内容与清单摘要不一致（镜像已陈旧），请重新运行 node scripts/sync-miniprogram-mirror.cjs',
    };
  }
  if (manifest.fileCount !== actual.fileCount) {
    return { ok: false, error: '镜像文件数与清单不一致（' + actual.fileCount + ' ≠ ' + manifest.fileCount + '）' };
  }
  return { ok: true, error: '', manifest };
}

function syncMirror() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error('真源目录不存在：' + SOURCE_DIR);
  }
  const sourceFiles = walk(SOURCE_DIR, SOURCE_DIR);
  let copied = 0;
  sourceFiles.forEach((rel) => {
    const from = path.join(SOURCE_DIR, rel);
    const to = path.join(MIRROR_DIR, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  });
  const { digest, fileCount } = computeMirrorDigest();
  const manifest = {
    role: 'mirror',
    deliverable: false,
    note: '本目录是 Base 模板的只读镜像，不是导出成果；交付物请用 node scripts/composer/cli.cjs 导出。',
    sourceOfTruth: path.relative(REPO_ROOT, SOURCE_DIR).replace(/\\/g, '/'),
    generatedBy: 'scripts/sync-miniprogram-mirror.cjs',
    validateWith: 'npm run mini:check',
    digestAlgorithm: 'sha256(第2列=path:sha256 排序后拼接)',
    digest,
    fileCount,
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(MIRROR_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { copied, digest, fileCount };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const result = verifyMirrorManifest();
    if (!result.ok) {
      console.error('镜像清单校验失败：' + result.error);
      process.exitCode = 1;
      return;
    }
    console.log('镜像清单校验通过：' + result.manifest.fileCount + ' 个文件 · 摘要 sha256:' + result.manifest.digest.slice(0, 16) + '…');
    return;
  }
  const result = syncMirror();
  console.log('镜像已同步：复制 ' + result.copied + ' 个文件 → miniprogram/（镜像共 ' + result.fileCount + ' 个文件）');
  console.log('镜像摘要 sha256:' + result.digest);
  console.log('提示：miniprogram/ 只是镜像，交付物请走 Composer 导出。');
}

if (require.main === module) {
  main();
}

module.exports = {
  MIRROR_DIR,
  SOURCE_DIR,
  MANIFEST_NAME,
  computeMirrorDigest,
  readManifest,
  verifyMirrorManifest,
  syncMirror,
};
