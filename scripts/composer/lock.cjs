#!/usr/bin/env node
'use strict';

/**
 * Lock 生成：记录一次生成的全部输入与（P6 回填的）输出摘要。
 *
 * 相同 Plan + 相同注册表 → 相同 lockDigest，无论 generatedAt 与实际输出时间。
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonical, canonicalDigest, lockDigest, walk, relativePosix, fileSha256 } = require('./digest.cjs');
const { validateLock, fail, ok } = require('./schema.cjs');
const { COMPOSER_VERSION, LOCK_VERSION } = require('./version.cjs');

function collectSourceDigests(graph, loaded) {
  const entries = [];
  const baseLabel = 'base/' + graph.base.manifest.identity.id + '@' + graph.base.manifest.identity.version;
  walk(graph.baseSrc).forEach((file) => {
    const relative = relativePosix(graph.baseSrc, file);
    entries.push({
      path: baseLabel + '/' + relative,
      digest: fileSha256(file),
    });
  });
  graph.assets.forEach((asset) => {
    const label = asset.kind + '/' + asset.id + '@' + asset.version;
    walk(asset.dir).forEach((file) => {
      const relative = relativePosix(asset.dir, file);
      if (relative.includes('/preview/') || relative === 'manifest.json') return;
      entries.push({ path: label + '/' + relative, digest: fileSha256(file) });
    });
  });
  if (loaded && loaded.registry) {
    entries.push({
      path: 'registry/registry.v1.json',
      digest: canonicalDigest(loaded.registry),
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function buildLock(graph, options) {
  const opts = options || {};
  const sourceDigests = collectSourceDigests(graph, opts.loaded);
  const lock = {
    lockVersion: LOCK_VERSION,
    planDigest: opts.planDigest,
    base: {
      id: graph.base.manifest.identity.id,
      version: graph.base.manifest.identity.version,
    },
    registryVersion: graph.plan.registryVersion,
    registryDigest: opts.registryDigest,
    features: graph.manifestDigests
      .map((item) => ({ id: item.id, version: item.version, kind: item.kind, digest: item.digest }))
      .sort((a, b) => (a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id))),
    resolvedDependencies: graph.resolvedDependencies,
    composerVersion: COMPOSER_VERSION,
    apiContract: graph.plan.apiBinding.contract,
    capabilitySet: graph.capabilitySet,
    sourceDigests,
    outputDigest: opts.outputDigest || { tree: '', files: [] },
    backendVersions: opts.backendVersions || { configVersion: null, catalogVersion: null },
    generatedAt: opts.generatedAt || '1970-01-01T00:00:00Z',
  };
  const validation = validateLock(lock);
  if (!validation.ok) return validation;
  lock.lockDigest = lockDigest(lock);
  return { ...ok(), lock, lockDigest: lock.lockDigest };
}

function finalizeLock(lock, outputDigest) {
  const next = { ...lock, outputDigest };
  next.lockDigest = lockDigest(next);
  return next;
}

function assertLockHasNoBusinessData(lock) {
  const text = canonical(lock);
  if (/(priceCents|openid|openId|AppSecret|BEGIN PRIVATE)/i.test(text)) {
    return fail('LOCK_BUSINESS_DATA', '$', 'Lock 不得包含业务数据或密钥');
  }
  return ok();
}

module.exports = {
  buildLock,
  finalizeLock,
  collectSourceDigests,
  assertLockHasNoBusinessData,
};