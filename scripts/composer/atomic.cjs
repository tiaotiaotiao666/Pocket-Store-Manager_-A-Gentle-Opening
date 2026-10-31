#!/usr/bin/env node
'use strict';

/**
 * 原子写盘与目录保护。
 *
 * 规则：
 * - 预检失败绝不创建任何目录。
 * - staging 建在目标父目录内（同卷），命名 .smartstore-tmp-<8 hex>。
 * - 写入阶段每个文件检查取消信号。
 * - 交付只用一次 rename；失败只删除自己命名的 staging。
 * - 同名目标目录拒绝覆盖，并给出建议名。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { fail, ok } = require('./schema.cjs');

const STAGING_PATTERN = /^\.smartstore-tmp-[0-9a-f]{8}$/;
const MAX_PATH_LENGTH = 240;
const STALE_MS = 60 * 60 * 1000;

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function suggestName(parentDir, baseName) {
  for (let index = 2; index <= 99; index += 1) {
    const candidate = baseName + '-' + index;
    if (!fs.existsSync(path.join(parentDir, candidate))) return candidate;
  }
  return baseName + '-' + Date.now();
}

function sanitizeProjectName(name) {
  const cleaned = String(name || 'smart-store')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 60) || 'smart-store';
}

function canWrite(dir) {
  const probe = path.join(dir, '.smartstore-probe-' + uniqueSuffix());
  try {
    fs.writeFileSync(probe, 'probe', { flag: 'wx' });
    fs.unlinkSync(probe);
    return true;
  } catch (error) {
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch (ignored) { /* noop */ }
    return false;
  }
}

function availableSpace(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (error) {
    return null;
  }
}

function preflight(options) {
  const opts = options || {};
  const parentDir = opts.parentDir ? path.resolve(opts.parentDir) : '';
  const projectName = sanitizeProjectName(opts.projectName || 'smart-store');
  if (!parentDir || !fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
    return fail('TARGET_PARENT_MISSING', 'parentDir', '目标父目录不存在：' + parentDir);
  }
  if (!canWrite(parentDir)) {
    return fail('TARGET_NOT_WRITABLE', 'parentDir', '目标父目录不可写：' + parentDir);
  }
  const finalPath = path.join(parentDir, projectName);
  if (fs.existsSync(finalPath)) {
    return fail('TARGET_EXISTS', 'projectName', '目标目录已存在，不会覆盖', {
      suggestedName: suggestName(parentDir, projectName),
      finalPath,
    });
  }
  const maxRelative = Number(opts.maxRelativePathLength || 120);
  if (finalPath.length + 1 + maxRelative > MAX_PATH_LENGTH) {
    return fail('PATH_TOO_LONG', 'projectName', '目标路径超过 ' + MAX_PATH_LENGTH + ' 字符', {
      length: finalPath.length,
      maximum: MAX_PATH_LENGTH,
    });
  }
  const estimated = Number(opts.estimatedBytes || 0);
  const space = availableSpace(parentDir);
  if (space !== null && space < estimated * 1.2) {
    return fail('TARGET_NO_SPACE', 'parentDir', '目标磁盘空间不足', {
      available: space,
      required: Math.ceil(estimated * 1.2),
    });
  }
  return { ...ok(), parentDir, projectName, finalPath };
}

function cleanupStale(parentDir, now) {
  const time = now === undefined ? Date.now() : now;
  let removed = 0;
  if (!fs.existsSync(parentDir)) return removed;
  fs.readdirSync(parentDir, { withFileTypes: true }).forEach((entry) => {
    if (!entry.isDirectory() || !STAGING_PATTERN.test(entry.name)) return;
    const target = path.join(parentDir, entry.name);
    try {
      const stat = fs.statSync(target);
      if (time - stat.mtimeMs > STALE_MS) {
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
      }
    } catch (error) {
      /* 忽略单个目录的清理失败，不阻断导出 */
    }
  });
  return removed;
}

function createStaging(parentDir) {
  let name = '.smartstore-tmp-' + uniqueSuffix();
  let target = path.join(parentDir, name);
  let attempts = 0;
  while (fs.existsSync(target) && attempts < 10) {
    name = '.smartstore-tmp-' + uniqueSuffix();
    target = path.join(parentDir, name);
    attempts += 1;
  }
  fs.mkdirSync(target, { recursive: false });
  return target;
}

async function writeFiles(stagingDir, files, options) {
  const opts = options || {};
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  for (let index = 0; index < entries.length; index += 1) {
    if (opts.signal && opts.signal.cancelled) {
      return fail('EXPORT_CANCELLED', '$', '导出已取消');
    }
    const [relative, content] = entries[index];
    if (relative.startsWith('/') || relative.includes('..') || /^[A-Za-z]:/.test(relative)) {
      return fail('OUTPUT_PATH_INVALID', relative, '产物路径非法');
    }
    const target = path.join(stagingDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (typeof opts.onFile === 'function') {
      opts.onFile({ index: index + 1, total: entries.length, file: relative });
    }
  }
  return ok();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commitStaging(stagingDir, finalPath) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(stagingDir, finalPath);
      return ok();
    } catch (error) {
      lastError = error;
      if (!retryable.has(error.code) || attempt === 5) break;
      sleepSync(100 * (attempt + 1));
    }
  }
  removeStaging(stagingDir);
  return fail('COMMIT_FAILED', 'finalPath', '目录提交失败：' + lastError.message);
}

function removeStaging(stagingDir) {
  if (!stagingDir || !STAGING_PATTERN.test(path.basename(stagingDir))) return false;
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    return false;
  }
}

function estimateSize(files) {
  const entries = files instanceof Map ? [...files.values()] : Object.values(files);
  return entries.reduce((total, content) => total + (Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), 'utf8')), 0);
}

module.exports = {
  preflight,
  cleanupStale,
  createStaging,
  writeFiles,
  commitStaging,
  removeStaging,
  estimateSize,
  sanitizeProjectName,
  suggestName,
  MAX_PATH_LENGTH,
  STAGING_PATTERN,
};