#!/usr/bin/env node
'use strict';

/**
 * 注册表门禁 CLI。
 *
 * 校验项：
 * 1. 注册表版本冻结、摘要一致（漂移 → REGISTRY_DRIFT）
 * 2. 每个资产 Manifest 完整、目录版本一致、入口存在、预览数据齐全
 * 3. Recipe 晋升证据：direct 必须四类证据齐全
 * 4. preview-only 资产必须有 preview-registry 登记
 * 5. 扩展顺序门禁：不得跳过前序资产
 *
 * 用法：
 *   node scripts/registry-check.cjs            # 校验
 *   node scripts/registry-check.cjs --write    # 重新冻结 registry.lock.json
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadRegistry, REPO_ROOT } = require('./composer/registry.cjs');
const { registryDigest, assetDigest } = require('./composer/digest.cjs');
const { checkComponentImplementation } = require('./composer/manifest-impl-check.cjs');
const { scanSources } = require('./composer/safety.cjs');

function printError(code, message, details) {
  console.error('  ✗ ' + code + '：' + message);
  if (details) console.error('    ' + JSON.stringify(details));
}

function validateRecipeStage(recipe, assetId) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') {
    errors.push({ code: 'RECIPE_SCHEMA_INVALID', message: 'recipe.json 必须是对象' });
    return errors;
  }
  if (!recipe.identity || !recipe.identity.id || !recipe.identity.version) {
    errors.push({ code: 'RECIPE_SCHEMA_INVALID', message: 'recipe.json 缺少 identity' });
  }
  if (recipe.identity && assetId && recipe.identity.id !== assetId) {
    errors.push({ code: 'RECIPE_SCHEMA_INVALID', message: 'Recipe ID 与索引不一致：' + recipe.identity.id });
  }
  const meta = recipe.recipe || {};
  if (!['direct', 'candidate', 'expired'].includes(meta.stage)) {
    errors.push({ code: 'RECIPE_STAGE_INVALID', message: 'recipe.stage 非法：' + meta.stage });
    return errors;
  }
  if (meta.stage === 'direct') {
    const missing = [];
    if (meta.wechatCompile !== 'pass') missing.push('wechatCompile');
    if (meta.regression !== 'pass') missing.push('regression');
    if (meta.secretScan !== 'pass') missing.push('secretScan');
    if (!Array.isArray(meta.approvals) || meta.approvals.length === 0) missing.push('approvals');
    if (missing.length) {
      errors.push({
        code: 'RECIPE_EVIDENCE_MISSING',
        message: 'direct Recipe 缺少晋升证据：' + missing.join(', '),
        details: { missing },
      });
    }
  }
  return errors;
}

function validatePreviewRegistry(registry) {
  const file = path.join(REPO_ROOT, 'templates', 'registry', 'preview-registry.json');
  if (!fs.existsSync(file)) {
    return { errors: [{ code: 'PREVIEW_REGISTRY_MISSING', message: '缺少 templates/registry/preview-registry.json' }] };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { errors: [{ code: 'PREVIEW_REGISTRY_INVALID', message: error.message }] };
  }
  if (!Array.isArray(doc.entries)) {
    return { errors: [{ code: 'PREVIEW_REGISTRY_INVALID', message: 'entries 必须是数组' }] };
  }
  const errors = [];
  const registered = new Set(doc.entries.map((entry) => entry.assetId));
  (registry.assets || []).forEach((asset) => {
    if (asset.manifest && asset.manifest.release && asset.manifest.release.stage === 'preview-only') {
      if (!registered.has(asset.id)) {
        errors.push({
          code: 'PREVIEW_REGISTRY_MISSING',
          message: 'preview-only 资产未登记：' + asset.id,
        });
      }
    }
  });
  doc.entries.forEach((entry) => {
    const asset = (registry.assets || []).find((item) => item.id === entry.assetId);
    if (!asset) {
      errors.push({ code: 'PREVIEW_REGISTRY_INVALID', message: '登记了不存在的资产：' + entry.assetId });
    }
    for (const field of ['capability', 'businessPurpose', 'minimalContract', 'priority', 'acceptance']) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) {
        errors.push({ code: 'PREVIEW_REGISTRY_INVALID', message: entry.assetId + ' 缺少字段 ' + field });
      }
    }
  });
  return { errors, doc };
}

function validateExpansionOrder(registry) {
  const file = path.join(REPO_ROOT, 'templates', 'registry', 'expansion-order.json');
  if (!fs.existsSync(file)) {
    return { errors: [{ code: 'EXPANSION_ORDER_MISSING', message: '缺少 templates/registry/expansion-order.json' }] };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { errors: [{ code: 'EXPANSION_ORDER_INVALID', message: error.message }] };
  }
  const order = Array.isArray(doc.order) ? doc.order : [];
  if (order.length === 0) {
    return { errors: [{ code: 'EXPANSION_ORDER_INVALID', message: 'order 必须是非空数组' }] };
  }
  const errors = [];
  const capabilities = new Set();
  (registry.assets || []).forEach((asset) => {
    if (asset.manifest && Array.isArray(asset.manifest.capabilities)) {
      asset.manifest.capabilities.forEach((capability) => capabilities.add(capability));
    }
    if (asset.kind === 'feature-pack') capabilities.add(asset.id);
  });

  capabilities.forEach((capability) => {
    const index = order.indexOf(capability);
    if (index < 0) return;
    for (let before = 0; before < index; before += 1) {
      const previous = order[before];
      if (!capabilities.has(previous)) {
        errors.push({
          code: 'EXPANSION_ORDER_SKIPPED',
          message: '登记 ' + capability + ' 前必须先完成 ' + previous,
          details: { capability, previous },
        });
        break;
      }
    }
  });
  return { errors, doc };
}

function main() {
  const write = process.argv.includes('--write');
  const loaded = loadRegistry({ verifyFreeze: !write });
  if (!loaded.ok) {
    console.error('注册表校验失败：' + loaded.code);
    printError(loaded.code, loaded.message, loaded.details);
    if (loaded.errors) loaded.errors.forEach((error) => printError(error.code, error.message, error.details));
    process.exitCode = 1;
    return;
  }

  if (write) {
    const lockFile = path.join(loaded.registryRoot, 'registry.lock.json');
    const indexPath = path.join(loaded.registryRoot, 'registry.v1.json');
    const nextRegistry = {
      ...loaded.registry,
      assets: loaded.registry.assets.map((entry) => ({
        ...entry,
        integrity: assetDigest({ ...entry, dir: path.join(REPO_ROOT, entry.path) }),
      })),
    };
    fs.writeFileSync(indexPath, JSON.stringify(nextRegistry, null, 2) + '\n', 'utf8');
    const nextLock = {
      lockVersion: 'lock.v1',
      registryVersion: nextRegistry.registryVersion,
      contentDigest: registryDigest(nextRegistry),
    };
    fs.writeFileSync(lockFile, JSON.stringify(nextLock, null, 2) + '\n', 'utf8');
    loaded.registry = nextRegistry;
    console.log('已重新冻结 ' + nextRegistry.assets.length + ' 个资产摘要：' + nextLock.contentDigest);
  }

  const errors = [];

  loaded.assets.forEach((asset) => {
    if (asset.kind === 'recipe') {
      errors.push(...validateRecipeStage(asset.recipe, asset.id).map((error) => ({ ...error, assetId: asset.id })));
      return;
    }
    if (!asset.manifest) return;
    const entryRoot = asset.kind === 'base'
      ? path.join(asset.dir, asset.manifest.entry.root)
      : path.join(asset.dir, asset.manifest.entry.path);
    if (asset.kind !== 'base') {
      const impl = checkComponentImplementation(asset.manifest, entryRoot);
      if (!impl.ok) errors.push({ code: impl.code, message: impl.message, assetId: asset.id, details: impl.details });
    }
    const scan = scanSources([asset.dir], { mode: asset.kind === 'base' ? 'development' : 'production' });
    if (!scan.ok) {
      errors.push({
        code: 'ASSET_SECRET_DETECTED',
        message: '资产包含敏感内容',
        assetId: asset.id,
        details: scan.findings.slice(0, 5),
      });
    }
  });

  const preview = validatePreviewRegistry(loaded.registry);
  errors.push(...preview.errors);
  const expansion = validateExpansionOrder(loaded.registry);
  errors.push(...expansion.errors);

  if (errors.length > 0) {
    console.error('注册表门禁失败：' + errors.length + ' 项');
    errors.forEach((error) => printError(error.code, error.message, error.details));
    process.exitCode = 1;
    return;
  }

  const counts = loaded.assets.reduce((acc, asset) => {
    acc[asset.kind] = (acc[asset.kind] || 0) + 1;
    return acc;
  }, {});
  const directRecipes = loaded.assets.filter((asset) => asset.kind === 'recipe' && asset.recipe.recipe && asset.recipe.recipe.stage === 'direct').length;
  console.log('注册表校验通过：' + loaded.registry.registryVersion +
    ' · base ' + (counts.base || 0) +
    ' / ui-block ' + (counts['ui-block'] || 0) +
    ' / feature-pack ' + (counts['feature-pack'] || 0) +
    ' / recipe ' + (counts.recipe || 0) +
    '（direct ' + directRecipes + '）');
  console.log('  ✓ 摘要冻结、Manifest、入口、预览、边界、晋升证据与扩展顺序均通过');
}

function listSelectableRecipes(registry) {
  return (registry.assets || [])
    .filter((asset) => asset.kind === 'recipe')
    .filter((asset) => {
      const meta = asset.recipe && asset.recipe.recipe;
      return meta && meta.stage === 'direct';
    })
    .map((asset) => ({ id: asset.id, version: asset.version }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

if (require.main === module) {
  main();
}

module.exports = {
  validateRecipeStage,
  validatePreviewRegistry,
  validateExpansionOrder,
  listSelectableRecipes,
};