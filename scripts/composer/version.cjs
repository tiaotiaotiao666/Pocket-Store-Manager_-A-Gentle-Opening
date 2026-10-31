#!/usr/bin/env node
'use strict';

/**
 * Composer 与契约版本常量。
 *
 * 版本一旦冻结，只能通过显式升级流程变更：
 * 1. 修改 registryVersion 并同步 templates/registry/registry.lock.json
 * 2. 在 templates/registry/migration.json 记录迁移说明
 * 3. 运行 npm run registry:check
 */

const COMPOSER_VERSION = '0.1.0';
const REGISTRY_VERSION = '2026.11.0';
const LOCK_VERSION = 'lock.v1';
const SCHEMA_VERSIONS = Object.freeze({
  baseManifest: 'base.manifest.v1',
  manifest: 'manifest.v1',
  slots: 'slots.v1',
  composition: 'composition.v1',
  lock: LOCK_VERSION,
  storeGenerated: 'store.generated.v2',
});

const OUTPUT_SCHEMA_VERSION = 2;
const SUPPORTED_STORE_SCHEMA = new Set([2]);
const SUPPORTED_BASE_RANGE = '^1.0.0';

module.exports = {
  COMPOSER_VERSION,
  REGISTRY_VERSION,
  LOCK_VERSION,
  SCHEMA_VERSIONS,
  OUTPUT_SCHEMA_VERSION,
  SUPPORTED_STORE_SCHEMA,
  SUPPORTED_BASE_RANGE,
};