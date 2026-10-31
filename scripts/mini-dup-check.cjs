#!/usr/bin/env node
'use strict';

/**
 * Base 与镜像双份维护门禁。
 *
 * 迁移期规则：
 * - templates/base/.../src 是唯一 sourceOfTruth。
 * - miniprogram/ 是镜像，同名文件内容必须一致。
 * - allowedDiffs 中列出的文件允许差异（配置、插槽锚点、工程配置）。
 * - 仅 Base 有：正常（新增生成产物，例如 slots.generated.js / extensions.generated.js）。
 * - 仅镜像有：警告（可能是待迁移文件）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return;
      result.push(...walk(full, base));
    } else if (entry.isFile()) {
      result.push(relative);
    }
  });
  return result.sort();
}

function matchesAllowed(relative, allowed) {
  return allowed.some((rule) => {
    if (rule === relative) return true;
    if (!rule.includes('*')) return false;
    const pattern = '^' + rule
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLE_STAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLE_STAR::/g, '.*') + '$';
    return new RegExp(pattern).test(relative);
  });
}

function main() {
  const migrationFile = path.join(REPO_ROOT, 'templates', 'registry', 'migration.json');
  if (!fs.existsSync(migrationFile)) {
    console.error('缺少 templates/registry/migration.json');
    process.exitCode = 1;
    return;
  }
  const migration = JSON.parse(fs.readFileSync(migrationFile, 'utf8'));
  const baseDir = path.join(REPO_ROOT, migration.sourceOfTruth);
  const mirrorDir = path.join(REPO_ROOT, migration.mirror);
  const allowed = Array.isArray(migration.allowedDiffs) ? migration.allowedDiffs : [];

  if (!fs.existsSync(baseDir)) {
    console.error('sourceOfTruth 不存在：' + migration.sourceOfTruth);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(mirrorDir)) {
    console.error('mirror 不存在：' + migration.mirror);
    process.exitCode = 1;
    return;
  }

  const baseFiles = walk(baseDir, baseDir);
  const mirrorFiles = new Set(walk(mirrorDir, mirrorDir));
  const errors = [];
  const warnings = [];
  const identical = [];
  const allowedDiffs = [];

  baseFiles.forEach((relative) => {
    if (/^project\.private\.config\.json$/.test(relative)) {
      errors.push('Base 不得包含 project.private.config.json');
      return;
    }
    const baseFile = path.join(baseDir, relative);
    if (!mirrorFiles.has(relative)) {
      if (relative.endsWith('.generated.js') || relative.endsWith('.generated.wxss') || relative.startsWith('fragments/')) {
        return;
      }
      warnings.push('仅 Base 存在（待同步）：' + relative);
      return;
    }
    const mirrorFile = path.join(mirrorDir, relative);
    const same = sha256(baseFile) === sha256(mirrorFile);
    if (same) {
      identical.push(relative);
      return;
    }
    if (matchesAllowed(relative, allowed)) {
      allowedDiffs.push(relative);
      return;
    }
    errors.push('内容不一致且不在允许差异清单：' + relative);
  });

  mirrorFiles.forEach((relative) => {
    if (!baseFiles.includes(relative)) {
      if (/\.generated\.(js|wxss)$/.test(relative)) return;
      warnings.push('仅镜像存在：' + relative);
    }
  });

  console.log('双份维护门禁：source=' + migration.sourceOfTruth + ' · mirror=' + migration.mirror);
  console.log('  一致 ' + identical.length + ' 个文件，允许差异 ' + allowedDiffs.length + ' 个，警告 ' + warnings.length + ' 个，错误 ' + errors.length + ' 个');
  console.log('  迁移状态：' + migration.status);
  console.log('  退出条件：' + migration.exitCondition);

  warnings.forEach((warning) => console.log('  ⚠ ' + warning));
  if (errors.length > 0) {
    errors.forEach((error) => console.log('  ✗ ' + error));
    console.error('\n双份维护门禁失败');
    process.exitCode = 1;
    return;
  }
  console.log('  ✓ 镜像一致性检查通过');
}

main();