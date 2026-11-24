'use strict';

/**
 * B1 清单/摘要与运行元数据。
 *
 * - `sha256:<hex>` 对文件**字节**求摘要（§1.6）；
 * - `treeDigest`：文件按 POSIX 相对路径升序，逐个拼 `"<path>\n<sha256hex>\n"`，
 *   再对拼接结果求 SHA-256，输出 `sha256:<hex>`；空树 = SHA-256(空串)；
 * - `diff` 逐文件输出 `{path, sha256, bytes, status}`（status ∈ added|modified|deleted|unchanged）；
 * - run / turn / attempt 元数据只允许摘要与相对引用：拒绝绝对路径、base64、超长正文与密钥样内容。
 *
 * 本模块无 Electron / 无 shell 依赖，纯文件系统读写。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ok,
  fail,
  sanitizeFailure,
  writeJsonAtomic,
} = require('./paths.cjs');
const {
  CODES,
  LIMITS,
  resolveLimits,
  METADATA_MAX_BYTES,
  METADATA_MAX_STRING,
  SCHEMAS,
  RUN_ID_PATTERN,
  TURN_ID_PATTERN,
} = require('./constants.cjs');

const ABSOLUTE_WINDOWS = /^[A-Za-z]:[\\/]/;
const ABSOLUTE_POSIX = /^\//;
const ABSOLUTE_UNC = /^\\\\/;
const BASE64_DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function digestOfContent(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeTreeDigest(value) {
  if (typeof value !== 'string') return null;
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value;
  if (/^[0-9a-f]{64}$/.test(value)) return 'sha256:' + value;
  return null;
}

/** 冻结的 treeDigest 算法：只由 `{path, sha256}` 决定，不含时间戳。 */
function treeDigestOfFiles(files) {
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = sorted.map((item) => item.path + '\n' + String(item.sha256).replace(/^sha256:/, '') + '\n').join('');
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 遍历工作树并构建 manifest。
 *
 * 链接（symlink / junction）与越界一律 fail closed；路径/深度/文件数/字节按上限检查。
 * 不跟随链接、不读取 `.git`/`node_modules`。
 */
function buildManifest(treeDir, options) {
  const opts = options || {};
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) return limitsResult;
  const limits = limitsResult.limits;
  if (typeof treeDir !== 'string' || !path.isAbsolute(treeDir)) {
    return fail(CODES.ARGUMENT_INVALID, 'treeDir', '工作树目录必须是绝对路径');
  }
  let rootStats;
  try {
    rootStats = fs.lstatSync(treeDir);
  } catch (error) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', '工作树不存在');
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return fail(CODES.PATH_LINK, '.', '工作树根不得是链接或文件');
  }
  // Windows junction 的 lstat 是目录：必须用 realpath 复核根本身。
  let rootReal;
  try {
    rootReal = fs.realpathSync.native ? fs.realpathSync.native(treeDir) : fs.realpathSync(treeDir);
  } catch (error) {
    return fail(CODES.IO_FAILED, '.', '无法解析工作树真实路径');
  }
  const rootRealMatches = process.platform === 'win32'
    ? rootReal.toLowerCase() === path.resolve(treeDir).toLowerCase()
    : rootReal === path.resolve(treeDir);
  if (!rootRealMatches) {
    return fail(CODES.PATH_LINK, '.', '工作树根不得是 junction 或路径别名（真实路径不一致）');
  }

  const files = [];
  let totalBytes = 0;
  let failure = null;

  const walk = (dir, prefix) => {
    if (failure) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      failure = fail(CODES.IO_FAILED, prefix || '.', '无法读取目录：' + (error.code || error.message));
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (failure) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        failure = fail(CODES.PATH_LINK, relative, '工作树内不得存在符号链接或 junction');
        return;
      }
      if (entry.isDirectory()) {
        let linkLike = false;
        try {
          linkLike = !sameRealPath(full);
        } catch (error) {
          failure = fail(CODES.IO_FAILED, relative, '无法解析真实路径：' + (error.code || error.message));
          return;
        }
        if (linkLike) {
          failure = fail(CODES.PATH_LINK, relative, '工作树内不得存在符号链接或 junction（真实路径不一致）');
          return;
        }
        const depth = relative.split('/').length;
        if (depth > limits.maxDepth) {
          failure = fail(CODES.DEPTH_EXCEEDED, relative, '目录层级超过上限 ' + limits.maxDepth);
          return;
        }
        if (relative.length > limits.maxPathLength) {
          failure = fail(CODES.PATH_INVALID, relative, '路径长度超过上限 ' + limits.maxPathLength);
          return;
        }
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        failure = fail(CODES.PATH_LINK, relative, '只接受普通文件');
        return;
      }
      const depth = relative.split('/').length;
      if (depth > limits.maxDepth) {
        failure = fail(CODES.DEPTH_EXCEEDED, relative, '路径层级超过上限 ' + limits.maxDepth);
        return;
      }
      if (relative.length > limits.maxPathLength) {
        failure = fail(CODES.PATH_INVALID, relative, '路径长度超过上限 ' + limits.maxPathLength);
        return;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(full);
      } catch (error) {
        failure = fail(CODES.IO_FAILED, relative, '无法读取文件：' + (error.code || error.message));
        return;
      }
      if (buffer.length > limits.maxFileBytes) {
        failure = fail(CODES.FILE_TOO_LARGE, relative, '单文件超过上限 ' + limits.maxFileBytes + ' 字节');
        return;
      }
      totalBytes += buffer.length;
      if (totalBytes > limits.maxTreeBytes) {
        failure = fail(CODES.TREE_TOO_LARGE, relative, '工作树总字节超过上限 ' + limits.maxTreeBytes);
        return;
      }
      files.push({ path: relative, sha256: digestOfContent(buffer), bytes: buffer.length });
      if (files.length > limits.maxFiles) {
        failure = fail(CODES.FILE_COUNT_EXCEEDED, relative, '工作树文件数超过上限 ' + limits.maxFiles);
        return;
      }
    }
  };

  walk(treeDir, '');
  if (failure) return failure;

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schemaVersion: SCHEMAS.manifest,
    treeDigest: treeDigestOfFiles(files),
    files,
    fileCount: files.length,
    totalBytes,
  };
  return ok({ manifest });
}

function sameRealPath(target) {
  const real = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  const left = process.platform === 'win32' ? real.toLowerCase() : real;
  const right = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target);
  return left === right;
}

function manifestFromValue(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.files)) return null;
  const files = [];
  for (const item of value.files) {
    if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string') return null;
    const digest = normalizeTreeDigest(item.sha256);
    if (!digest) return null;
    files.push({ path: item.path, sha256: digest, bytes: Number.isInteger(item.bytes) ? item.bytes : 0 });
  }
  return {
    schemaVersion: value.schemaVersion || SCHEMAS.manifest,
    treeDigest: normalizeTreeDigest(value.treeDigest) || treeDigestOfFiles(files),
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
  };
}

/**
 * 两棵树/manifest 的逐文件 diff。输出固定 `{path, sha256, bytes, status}`：
 * - added/modified/unchanged 用 after 摘要；
 * - deleted 用 before 摘要（“最后已知内容”）。
 */
function diffManifests(beforeValue, afterValue, options) {
  const before = manifestFromValue(beforeValue);
  const after = manifestFromValue(afterValue);
  if (!before) return fail(CODES.ARGUMENT_INVALID, 'before', 'before manifest 形状非法');
  if (!after) return fail(CODES.ARGUMENT_INVALID, 'after', 'after manifest 形状非法');
  const opts = options || {};
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) return limitsResult;
  const maxFiles = Number.isInteger(opts.maxFiles) ? opts.maxFiles : Infinity;
  const maxBytes = Number.isInteger(opts.maxBytes) ? opts.maxBytes : Infinity;

  const beforeMap = new Map(before.files.map((item) => [item.path, item]));
  const afterMap = new Map(after.files.map((item) => [item.path, item]));
  const paths = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();

  const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  const all = [];
  for (const target of paths) {
    const beforeFile = beforeMap.get(target);
    const afterFile = afterMap.get(target);
    let status;
    let source;
    if (beforeFile && afterFile) {
      status = beforeFile.sha256 === afterFile.sha256 ? 'unchanged' : 'modified';
      source = afterFile;
    } else if (afterFile) {
      status = 'added';
      source = afterFile;
    } else {
      status = 'deleted';
      source = beforeFile;
    }
    counts[status] += 1;
    all.push({ path: target, sha256: source.sha256, bytes: source.bytes, status });
  }

  let truncated = false;
  let files = all;
  if (Number.isFinite(maxFiles) || Number.isFinite(maxBytes)) {
    files = [];
    let bytes = 0;
    for (const item of all) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (bytes + item.bytes > maxBytes) {
        truncated = true;
        break;
      }
      files.push(item);
      bytes += item.bytes;
    }
    if (files.length < all.length) truncated = true;
  }

  return ok({ files, counts, truncated });
}

function readJsonFile(file) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    return fail(CODES.WORKSPACE_NOT_FOUND, '.', '元数据不存在');
  }
  if (stats.isSymbolicLink()) return fail(CODES.PATH_LINK, '.', '元数据文件不得是链接');
  if (!stats.isFile()) return fail(CODES.WORKSPACE_INVALID, '.', '元数据不是普通文件');
  try {
    return ok({ value: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch (error) {
    return fail(CODES.WORKSPACE_INVALID, '.', '元数据无法解析');
  }
}

/**
 * 元数据安全：递归检查字符串值。
 * 拒绝绝对路径（盘符/POSIX/UNC）、data URI base64、控制字符、超长正文；
 * 整份 JSON 超过 METADATA_MAX_BYTES 也拒绝。
 */
function inspectMetadata(value, keyPath) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return null;
  if (typeof value === 'string') {
    if (value.length > METADATA_MAX_STRING) return (keyPath || '.') + ' 字符串超过上限';
    if (CONTROL_CHAR.test(value)) return (keyPath || '.') + ' 含控制字符';
    if (BASE64_DATA_URI.test(value)) return (keyPath || '.') + ' 不得存 base64 正文';
    if (ABSOLUTE_WINDOWS.test(value) || ABSOLUTE_POSIX.test(value) || ABSOLUTE_UNC.test(value)) {
      return (keyPath || '.') + ' 不得存绝对路径';
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = inspectMetadata(value[index], keyPath + '[' + index + ']');
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (CONTROL_CHAR.test(key)) return '元数据键含控制字符';
      const issue = inspectMetadata(item, keyPath ? keyPath + '.' + key : key);
      if (issue) return issue;
    }
    return null;
  }
  return (keyPath || '.') + ' 含不支持的类型';
}

function sanitizeMetadata(meta) {
  const issue = inspectMetadata(meta, '');
  if (issue) return fail(CODES.WORKSPACE_INVALID, '.', '元数据不安全：' + issue);
  let serialized;
  try {
    serialized = JSON.stringify(meta);
  } catch (error) {
    return fail(CODES.WORKSPACE_INVALID, '.', '元数据无法序列化');
  }
  if (Buffer.byteLength(serialized, 'utf8') > METADATA_MAX_BYTES) {
    return fail(CODES.WORKSPACE_INVALID, '.', '元数据超过 ' + METADATA_MAX_BYTES + ' 字节');
  }
  return ok({ serialized });
}

const ATTEMPT_PROTECTED_KEYS = [
  'schemaVersion', 'projectId', 'runId', 'turnId', 'attemptId', 'attempt',
  'treeDigest', 'fileCount', 'totalBytes', 'revision', 'createdAt',
];
const RUN_PROTECTED_KEYS = ['schemaVersion', 'projectId', 'runId', 'createdAt', 'turns'];
const TURN_PROTECTED_KEYS = ['schemaVersion', 'projectId', 'runId', 'turnId', 'createdAt', 'attempts'];

function mergeMetadata(current, patch, protectedKeys, identity, rootForSanitize) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail(CODES.ARGUMENT_INVALID, 'patch', 'patch 必须是对象');
  }
  for (const key of Object.keys(patch)) {
    if (protectedKeys.includes(key)) {
      return fail(CODES.WORKSPACE_INVALID, 'patch', '不得通过 patch 修改受保护字段：' + key);
    }
  }
  const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const safe = sanitizeMetadata(merged);
  if (!safe.ok) return sanitizeFailure(safe, rootForSanitize);
  return ok({ meta: merged });
}

function writeMetadata(file, meta, rootForSanitize) {
  const written = writeJsonAtomic(file, meta, CODES);
  if (!written.ok) return sanitizeFailure(written, rootForSanitize);
  return ok({ meta });
}

function readAttemptMeta(attempt) {
  if (!attempt || typeof attempt !== 'object' || typeof attempt.attemptFile !== 'string') {
    return fail(CODES.ARGUMENT_INVALID, 'attempt', '缺少 attempt 句柄');
  }
  const read = readJsonFile(attempt.attemptFile, attempt.attemptDir);
  if (!read.ok) return sanitizeFailure(read, attempt.attemptDir);
  return ok({ meta: read.value });
}

function writeAttemptMeta(attempt, patch) {
  if (!attempt || typeof attempt.attemptFile !== 'string') {
    return fail(CODES.ARGUMENT_INVALID, 'attempt', '缺少 attempt 句柄');
  }
  const current = readAttemptMeta(attempt);
  if (!current.ok) return current;
  const merged = mergeMetadata(current.meta, patch, ATTEMPT_PROTECTED_KEYS, attempt, attempt.attemptDir);
  if (!merged.ok) return merged;
  return writeMetadata(attempt.attemptFile, merged.meta, attempt.attemptDir);
}

function runFileOf(workspace, runId) {
  return path.join(workspace.runsDir, runId, 'run.json');
}

function turnFileOf(workspace, runId, turnId) {
  return path.join(workspace.runsDir, runId, 'turns', turnId, 'turn.json');
}

function checkRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    return fail(CODES.ID_INVALID, 'runId', 'runId 非法（必须 frun-<字母数字...>）');
  }
  return ok();
}

function checkTurnId(turnId) {
  if (typeof turnId !== 'string' || !TURN_ID_PATTERN.test(turnId)) {
    return fail(CODES.ID_INVALID, 'turnId', 'turnId 非法');
  }
  return ok();
}

function readRunMeta(workspace, runId) {
  if (!workspace || typeof workspace.runsDir !== 'string') return fail(CODES.ARGUMENT_INVALID, 'workspace', '缺少 workspace 句柄');
  const idCheck = checkRunId(runId);
  if (!idCheck.ok) return idCheck;
  const read = readJsonFile(runFileOf(workspace, runId), workspace.workspaceDir);
  if (!read.ok) return sanitizeFailure(read, workspace.workspaceDir);
  return ok({ meta: read.value });
}

function writeRunMeta(workspace, runId, patch) {
  if (!workspace || typeof workspace.runsDir !== 'string') return fail(CODES.ARGUMENT_INVALID, 'workspace', '缺少 workspace 句柄');
  const idCheck = checkRunId(runId);
  if (!idCheck.ok) return idCheck;
  const current = readRunMeta(workspace, runId);
  if (!current.ok) return current;
  const merged = mergeMetadata(current.meta, patch, RUN_PROTECTED_KEYS, workspace, workspace.workspaceDir);
  if (!merged.ok) return merged;
  return writeMetadata(runFileOf(workspace, runId), merged.meta, workspace.workspaceDir);
}

function readTurnMeta(workspace, options) {
  if (!workspace || typeof workspace.runsDir !== 'string') return fail(CODES.ARGUMENT_INVALID, 'workspace', '缺少 workspace 句柄');
  const opts = options || {};
  const runCheck = checkRunId(opts.runId);
  if (!runCheck.ok) return runCheck;
  const turnCheck = checkTurnId(opts.turnId);
  if (!turnCheck.ok) return turnCheck;
  const read = readJsonFile(turnFileOf(workspace, opts.runId, opts.turnId), workspace.workspaceDir);
  if (!read.ok) return sanitizeFailure(read, workspace.workspaceDir);
  return ok({ meta: read.value });
}

module.exports = {
  LIMITS,
  CODES,
  digestOfContent,
  normalizeTreeDigest,
  treeDigestOfFiles,
  buildManifest,
  diffManifests,
  sanitizeMetadata,
  inspectMetadata,
  readAttemptMeta,
  writeAttemptMeta,
  readRunMeta,
  writeRunMeta,
  readTurnMeta,
  // 供 files.cjs / transactions.cjs 复用的写入口（同一套原子写与脱敏）。
  writeMetadata,
};
