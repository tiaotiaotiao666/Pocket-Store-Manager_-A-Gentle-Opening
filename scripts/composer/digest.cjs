#!/usr/bin/env node
'use strict';

/**
 * 确定性摘要工具。
 *
 * 约定：
 * - canonical JSON：对象键按 Unicode 排序、无空白、文本 LF。
 * - 数字只允许整数（金额统一整数分）；浮点、NaN、Infinity 一律抛错。
 * - 摘要统一带 `sha256:` 前缀，便于 Lock 中区分算法。
 * - 任何摘要都不得包含时间戳、主机名、绝对路径。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { normalizePresentationTokens, normalizeSlotOrder } = require('./schema.cjs');

function canonical(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER');
    if (!Number.isInteger(value)) throw new Error('NON_INTEGER_NUMBER:' + value);
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonical(item)).join(',') + ']';
  }
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_TYPE:' + type);
}

function sha256(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalDigest(value) {
  return sha256(canonical(value));
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function normalizedText(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return;
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  });
  return files.sort();
}

function relativePosix(from, file) {
  return path.relative(from, file).replace(/\\/g, '/');
}

/** 目录树摘要：按相对路径排序 + 文本 LF 归一化后逐文件摘要。 */
function treeSha256(dir) {
  const entries = walk(dir).filter((file) => path.basename(file) !== '.DS_Store');
  const lines = entries.map((file) => {
    const rel = relativePosix(dir, file);
    const raw = fs.readFileSync(file);
    const isText = !/\.(png|jpe?g|webp|gif|ico|zip)$/i.test(file);
    const content = isText ? Buffer.from(normalizedText(raw.toString('utf8')), 'utf8') : raw;
    return rel + ':' + sha256(content);
  });
  return sha256(lines.join('\n'));
}

function listTree(dir) {
  return walk(dir).map((file) => relativePosix(dir, file));
}

/**
 * Plan 摘要。
 *
 * `presentationTokens` 与 `slotOrder` 必须纳入摘要（C-PLAN-PRESENTATION@1）：
 * - 两者都先归一化：缺省尺寸按 `md` 补齐、缺省落位为空数组，避免“字段存在与否”造成的
 *   语义等价 Plan 摘要不一致；
 * - 归一化只影响摘要口径，不回写 `plan` 本身（Composer 不修改调用方输入）。
 * - 相同输入重复导出必然得到相同摘要；改变任一声明都会改变摘要。
 */
function planDigest(plan) {
  return canonicalDigest({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    planVersion: plan.planVersion,
    baseTemplate: plan.baseTemplate,
    registryVersion: plan.registryVersion,
    pages: plan.pages,
    features: plan.features || [],
    components: plan.components || [],
    themeTokens: plan.themeTokens,
    apiBinding: plan.apiBinding,
    storeProfile: plan.storeProfile || {},
    previewOnlyAck: Boolean(plan.previewOnlyAck),
    degradations: plan.degradations || [],
    frontendPack: plan.frontendPack || null,
    presentationTokens: normalizePresentationTokens(plan.presentationTokens),
    slotOrder: normalizeSlotOrder(plan.slotOrder),
  });
}

function assetDigest(asset) {
  if (asset.dir && fs.existsSync(asset.dir)) {
    return treeSha256(asset.dir);
  }
  return canonicalDigest({
    id: asset.id,
    version: asset.version,
    kind: asset.kind,
    path: asset.path,
  });
}

/** 注册表摘要：只覆盖 registryVersion 与资产索引，不覆盖 lock 自身。 */
function registryDigest(registry) {
  const assets = (registry.assets || [])
    .map((asset) => ({
      id: asset.id,
      version: asset.version,
      kind: asset.kind,
      path: asset.path,
      integrity: asset.integrity,
    }))
    .sort((a, b) => (a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id)));
  return canonicalDigest({ registryVersion: registry.registryVersion, assets });
}

/** Lock 摘要：排除 generatedAt，保证相同输入可复现。 */
function lockDigest(lock) {
  const copy = { ...lock };
  delete copy.generatedAt;
  delete copy.lockDigest;
  return canonicalDigest(copy);
}

function contentDigest(files) {
  const entries = files
    .map((file) => ({ path: file.path, digest: file.digest }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return canonicalDigest(entries);
}

module.exports = {
  canonical,
  sha256,
  canonicalDigest,
  fileSha256,
  treeSha256,
  listTree,
  planDigest,
  assetDigest,
  registryDigest,
  lockDigest,
  contentDigest,
  normalizedText,
  walk,
  relativePosix,
};