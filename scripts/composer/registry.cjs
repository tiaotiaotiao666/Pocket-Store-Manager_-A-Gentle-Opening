#!/usr/bin/env node
'use strict';

/**
 * 注册表加载与冻结校验。
 *
 * 任何未登记资产、版本不一致、入口缺失、Manifest 字段缺失都在生成前拒绝。
 * registry.lock.json 只保存注册表摘要，避免同一状态两处维护。
 */

const fs = require('node:fs');
const path = require('node:path');

const { registryDigest, assetDigest, fileSha256 } = require('./digest.cjs');
const {
  validateManifest,
  validateFrontendPackManifest,
  validateBaseManifest,
  validatePath,
  fail,
  ok,
} = require('./schema.cjs');
const { REGISTRY_VERSION } = require('./version.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_REGISTRY_ROOT = path.join(REPO_ROOT, 'templates', 'registry');

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function resolveInside(root, relative) {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    return null;
  }
  return resolved;
}

function loadRegistry(options) {
  const opts = options || {};
  const registryRoot = opts.registryRoot || DEFAULT_REGISTRY_ROOT;
  const verifyFreeze = opts.verifyFreeze !== false;
  const indexFile = path.join(registryRoot, 'registry.v1.json');
  const lockFile = path.join(registryRoot, 'registry.lock.json');

  const indexRead = readJson(indexFile);
  if (!indexRead.ok) return fail('REGISTRY_UNREADABLE', indexFile, '注册表索引无法读取：' + indexRead.error);
  const registry = indexRead.value;

  if (!registry || typeof registry !== 'object') {
    return fail('REGISTRY_UNREADABLE', indexFile, '注册表索引必须是对象');
  }
  if (registry.registryVersion !== REGISTRY_VERSION) {
    return fail('REGISTRY_VERSION_MISMATCH', 'registryVersion', '注册表版本与冻结值不一致：' + registry.registryVersion, {
      expected: REGISTRY_VERSION,
      actual: registry.registryVersion,
    });
  }
  if (registry.frozen !== true) {
    return fail('REGISTRY_NOT_FROZEN', 'frozen', '注册表必须显式冻结（frozen: true）');
  }
  if (!Array.isArray(registry.assets)) {
    return fail('REGISTRY_UNREADABLE', 'assets', 'assets 必须是数组');
  }

  const lockRead = readJson(lockFile);
  if (!lockRead.ok) return fail('REGISTRY_LOCK_UNREADABLE', lockFile, '注册表 lock 无法读取：' + lockRead.error);
  const lock = lockRead.value;
  if (!lock || lock.registryVersion !== REGISTRY_VERSION) {
    return fail('REGISTRY_VERSION_MISMATCH', 'registryVersion', 'lock 版本与冻结值不一致', {
      expected: REGISTRY_VERSION,
      actual: lock && lock.registryVersion,
    });
  }

  const expectedDigest = registryDigest(registry);
  if (verifyFreeze && lock.contentDigest !== expectedDigest) {
    return fail('REGISTRY_DRIFT', '$', '注册表摘要漂移，请确认变更后重新冻结', {
      registryVersion: REGISTRY_VERSION,
      expectedDigest,
      actualDigest: lock.contentDigest,
    });
  }

  const assets = [];
  const byKey = new Map();
  const errors = [];

  for (let index = 0; index < registry.assets.length; index += 1) {
    const entry = registry.assets[index];
    const entryPath = 'assets[' + index + ']';
    if (!entry || typeof entry !== 'object') {
      errors.push({ code: 'REGISTRY_ENTRY_INVALID', path: entryPath, message: '资产索引必须是对象' });
      continue;
    }
    for (const field of ['id', 'version', 'kind', 'path', 'integrity']) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) {
        errors.push({ code: 'REGISTRY_ENTRY_INVALID', path: entryPath + '.' + field, message: '缺少字段 ' + field });
      }
    }
    if (!['base', 'ui-block', 'feature-pack', 'frontend-pack', 'recipe'].includes(entry.kind)) {
      errors.push({ code: 'REGISTRY_ENTRY_INVALID', path: entryPath + '.kind', message: '未知资产类型 ' + entry.kind });
      continue;
    }

    const assetDir = resolveInside(REPO_ROOT, entry.path);
    const integrity = assetDigest({ ...entry, dir: assetDir || path.join(REPO_ROOT, entry.path) });
    if (verifyFreeze && entry.integrity && entry.integrity !== integrity) {
      errors.push({
        code: 'ASSET_INTEGRITY_MISMATCH',
        path: entry.path,
        message: '资产内容摘要与索引不一致（内容变更后需重新冻结）',
        details: { expected: integrity, actual: entry.integrity },
      });
      continue;
    }
    const manifestFile = resolveInside(REPO_ROOT, path.join(entry.path, 'manifest.json'));
    if (entry.kind === 'recipe') {
      const recipeFile = resolveInside(REPO_ROOT, path.join(entry.path, 'recipe.json'));
      if (!recipeFile || !fs.existsSync(recipeFile)) {
        errors.push({ code: 'ENTRY_MISSING', path: entry.path + '/recipe.json', message: 'Recipe 文件不存在' });
        continue;
      }
      const recipeRead = readJson(recipeFile);
      if (!recipeRead.ok) {
        errors.push({ code: 'MANIFEST_UNREADABLE', path: entry.path + '/recipe.json', message: recipeRead.error });
        continue;
      }
      assets.push({ ...entry, dir: path.dirname(recipeFile), recipe: recipeRead.value, manifest: null });
      byKey.set(entry.id + '@' + entry.version, assets[assets.length - 1]);
      continue;
    }

    if (!manifestFile || !fs.existsSync(manifestFile)) {
      errors.push({ code: 'MANIFEST_FIELD_MISSING', path: entry.path + '/manifest.json', message: 'Manifest 不存在' });
      continue;
    }
    const manifestRead = readJson(manifestFile);
    if (!manifestRead.ok) {
      errors.push({ code: 'MANIFEST_UNREADABLE', path: entry.path + '/manifest.json', message: manifestRead.error });
      continue;
    }
    const manifest = manifestRead.value;
    const validation = entry.kind === 'base'
      ? validateBaseManifest(manifest)
      : entry.kind === 'frontend-pack'
        ? validateFrontendPackManifest(manifest)
        : validateManifest(manifest, { expectedKind: entry.kind });
    if (!validation.ok) {
      errors.push({ ...validation, assetId: entry.id });
      continue;
    }

    if (manifest.identity.id !== entry.id || manifest.identity.version !== entry.version) {
      errors.push({
        code: 'MANIFEST_VERSION_MISMATCH',
        path: entry.path + '/manifest.json',
        message: '索引与 Manifest 身份不一致',
        details: {
          index: { id: entry.id, version: entry.version },
          manifest: manifest.identity,
        },
      });
      continue;
    }

    const dirName = path.basename(entry.path);
    if (dirName !== entry.version) {
      errors.push({
        code: 'MANIFEST_VERSION_MISMATCH',
        path: entry.path,
        message: '目录版本与 identity.version 不一致：' + dirName,
      });
    }

    const rootDir = entry.kind === 'base'
      ? resolveInside(path.dirname(manifestFile), manifest.entry.root)
      : resolveInside(path.dirname(manifestFile), manifest.entry.path);
    if (!rootDir) {
      errors.push({ code: 'ENTRY_PATH_INVALID', path: entry.path, message: '入口路径逃逸' });
      continue;
    }
    if (!fs.existsSync(rootDir)) {
      errors.push({ code: 'ENTRY_MISSING', path: entry.path, message: '入口目录不存在' });
      continue;
    }

    const entryFiles = entry.kind === 'base'
      ? [...manifest.entry.files]
      : manifest.entry.files.map((file) => path.posix.join(manifest.entry.path, file));
    for (const file of entryFiles) {
      const target = entry.kind === 'base' ? resolveInside(rootDir, file) : resolveInside(path.dirname(manifestFile), file);
      if (!target || !fs.existsSync(target)) {
        errors.push({ code: 'ENTRY_MISSING', path: entry.path, message: '入口文件不存在：' + file });
      }
    }

    for (const kind of manifest.preview ? manifest.preview.kinds : []) {
      const previewFile = path.join(path.dirname(manifestFile), manifest.preview.dir, kind + '.json');
      if (!fs.existsSync(previewFile)) {
        errors.push({ code: 'PREVIEW_DATA_MISSING', path: path.relative(REPO_ROOT, previewFile).replace(/\\/g, '/'), message: '缺少预览数据 ' + kind });
      }
    }


    const record = { ...entry, dir: path.dirname(manifestFile), manifest };
    assets.push(record);
    byKey.set(entry.id + '@' + entry.version, record);
  }

  if (errors.length > 0) {
    return { ...fail(errors[0].code, errors[0].path, errors[0].message, errors[0].details), errors };
  }

  return {
    ...ok(),
    registry,
    lock,
    registryRoot,
    registryDigest: expectedDigest,
    assets,
    byKey,
  };
}

function getAsset(loaded, id, version) {
  if (!loaded || !loaded.byKey) return fail('REGISTRY_NOT_LOADED', '$', '注册表尚未加载');
  const key = id + '@' + version;
  if (loaded.byKey.has(key)) return { ...ok(), asset: loaded.byKey.get(key) };
  const available = loaded.assets.filter((asset) => asset.id === id).map((asset) => asset.version);
  if (available.length === 0) {
    return fail('ASSET_NOT_REGISTERED', '$', '资产未登记：' + id, { id });
  }
  return fail('ASSET_VERSION_NOT_FOUND', '$', '资产版本不存在：' + key, { id, version, available });
}

function listRecipeCandidates(loaded) {
  return loaded.assets
    .filter((asset) => asset.kind === 'recipe')
    .map((asset) => ({ id: asset.id, version: asset.version, path: asset.path, recipe: asset.recipe }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
}

function fileDigestOf(file) {
  return fileSha256(file);
}

module.exports = {
  REPO_ROOT,
  DEFAULT_REGISTRY_ROOT,
  loadRegistry,
  getAsset,
  listRecipeCandidates,
  fileDigestOf,
  readJson,
  resolveInside,
};