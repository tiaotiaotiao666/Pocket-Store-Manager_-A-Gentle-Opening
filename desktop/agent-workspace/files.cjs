'use strict';

/**
 * B1 工作树读改 API（纯主进程）：list / read / search / write / delete。
 *
 * - 所有路径只接受 POSIX 相对路径，经 `normalizeRelativePath` 统一闸门；
 * - 已存在路径段必须是真实目录/文件（lstat + realpath 拒 symlink/junction）；
 * - 读取有字节/行数上限，搜索有命中上限并跳过二进制；
 * - 写入/删除一律走 transactions.cjs 的事务（完整文件覆盖、显式删除、冲突检测）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { CODES, LIMITS, resolveLimits, normalizeRelativePath } = require('./constants.cjs');
const {
  ok,
  fail,
  sanitizeFailure,
  assertCanonicalDir,
  auditPath,
  isInsideOrEqual,
} = require('./paths.cjs');
const manifestMod = require('./manifest.cjs');
const transactions = require('./transactions.cjs');

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tgz',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'webm', 'wasm', 'bin',
]);

/**
 * 归属校验（F1）：句柄必须是 runs/<runId>/turns/<turnId>/attempts/attempt-<n>/candidate，
 * 伪造指向 versions/、project.json、migration.json 或仓库的句柄一律拒绝（零落盘）。
 * 唯一实现在 transactions.assertAttemptHandle（两处入口共用，避免第二份安全路径逻辑）。
 */
function guardAttempt(attempt) {
  return transactions.assertAttemptHandle(attempt);
}

function limitsOf(attempt) {
  const result = resolveLimits(attempt.limits);
  return result.ok ? result.limits : LIMITS;
}

function isBinaryBuffer(buffer, relative) {
  if (buffer.includes(0)) return true;
  const extension = path.extname(relative).slice(1).toLowerCase();
  if (extension && BINARY_EXTENSIONS.has(extension)) return true;
  const text = buffer.toString('utf8');
  return !Buffer.from(text, 'utf8').equals(buffer);
}

/**
 * 把相对路径解析成工作树内绝对路径，并复核 candidate 根与每一段都不是链接。
 * 返回 `{ok, relative, target}`；失败体已脱敏。
 */
function resolveInTree(attempt, relative, limits) {
  const normalized = normalizeRelativePath(relative, { limits });
  if (!normalized.ok) return sanitizeFailure(normalized, attempt.attemptDir);
  const rootCheck = assertCanonicalDir(attempt.candidateDir, CODES);
  if (!rootCheck.ok) return sanitizeFailure(rootCheck, attempt.attemptDir);
  const target = path.join(attempt.candidateDir, ...relative.split('/'));
  if (!isInsideOrEqual(attempt.candidateDir, target)) {
    return fail(CODES.PATH_ESCAPE, relative, '路径越出工作树');
  }
  const audited = auditPath(attempt.candidateDir, rootCheck.realDir, target, CODES);
  if (!audited.ok) return sanitizeFailure(audited, attempt.attemptDir);
  return ok({ relative, target });
}

function listFiles(attempt, options) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const opts = options || {};
  const limits = limitsOf(attempt);
  const dir = opts.dir === undefined ? '' : opts.dir;
  if (typeof dir !== 'string') return fail(CODES.ARGUMENT_INVALID, 'dir', 'dir 必须是相对路径字符串');

  const rootCheck = assertCanonicalDir(attempt.candidateDir, CODES);
  if (!rootCheck.ok) return sanitizeFailure(rootCheck, attempt.attemptDir);

  let startDir = attempt.candidateDir;
  let prefix = '';
  if (dir !== '') {
    const resolved = resolveInTree(attempt, dir, limits);
    if (!resolved.ok) return resolved;
    let stats;
    try {
      stats = fs.lstatSync(resolved.target);
    } catch (error) {
      return fail(CODES.FILE_NOT_FOUND, dir, '目录不存在');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return fail(CODES.ARGUMENT_INVALID, dir, '不是目录');
    }
    startDir = resolved.target;
    prefix = dir;
  }

  const files = [];
  let totalBytes = 0;
  let truncated = false;

  const walk = (currentDir, currentPrefix) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      const failure = fail(CODES.IO_FAILED, currentPrefix || '.', '无法读取目录：' + (error.code || error.message));
      throw failure;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(currentDir, entry.name);
      const relative = currentPrefix ? currentPrefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        throw fail(CODES.PATH_LINK, relative, '工作树内不得存在符号链接或 junction');
      }
      if (entry.isDirectory()) {
        let real;
        try {
          real = fs.realpathSync.native ? fs.realpathSync.native(full) : fs.realpathSync(full);
        } catch (error) {
          throw fail(CODES.IO_FAILED, relative, '无法解析真实路径：' + (error.code || error.message));
        }
        const same = process.platform === 'win32'
          ? real.toLowerCase() === path.resolve(full).toLowerCase()
          : real === path.resolve(full);
        if (!same) throw fail(CODES.PATH_LINK, relative, '工作树内不得存在 junction（真实路径不一致）');
        if (relative.split('/').length > limits.maxDepth) {
          truncated = true;
          return;
        }
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw fail(CODES.PATH_LINK, relative, '只接受普通文件');
      }
      if (relative.split('/').length > limits.maxDepth) {
        truncated = true;
        return;
      }
      let stats;
      try {
        stats = fs.lstatSync(full);
      } catch (error) {
        throw fail(CODES.IO_FAILED, relative, '无法读取文件信息');
      }
      if (files.length >= limits.maxFiles) {
        truncated = true;
        return;
      }
      files.push({ path: relative, bytes: stats.size });
      totalBytes += stats.size;
    }
  };

  try {
    walk(startDir, prefix);
  } catch (failure) {
    if (failure && failure.ok === false) return sanitizeFailure(failure, attempt.attemptDir);
    return fail(CODES.IO_FAILED, '.', '列目录失败');
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ dir, files, fileCount: files.length, totalBytes, truncated });
}

function readFile(attempt, options) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const opts = options || {};
  const limits = limitsOf(attempt);
  if (typeof opts.path !== 'string') return fail(CODES.ARGUMENT_INVALID, 'path', 'path 必须是字符串');

  const resolved = resolveInTree(attempt, opts.path, limits);
  if (!resolved.ok) return resolved;

  let stats;
  try {
    stats = fs.lstatSync(resolved.target);
  } catch (error) {
    return fail(CODES.FILE_NOT_FOUND, opts.path, '文件不存在');
  }
  if (stats.isSymbolicLink()) return fail(CODES.PATH_LINK, opts.path, '文件不得是符号链接');
  if (!stats.isFile()) return fail(CODES.ARGUMENT_INVALID, opts.path, '不是普通文件');

  let buffer;
  try {
    buffer = fs.readFileSync(resolved.target);
  } catch (error) {
    return fail(CODES.IO_FAILED, opts.path, '读取失败：' + (error.code || error.message));
  }
  if (isBinaryBuffer(buffer, opts.path)) {
    return fail(CODES.BINARY_FILE, opts.path, '二进制文件不支持按文本读取');
  }

  const offset = opts.offset === undefined ? 0 : opts.offset;
  if (!Number.isInteger(offset) || offset < 0) return fail(CODES.ARGUMENT_INVALID, 'offset', 'offset 必须是非负整数');

  let limitBytes = opts.limitBytes === undefined ? limits.readDefaultBytes : opts.limitBytes;
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    return fail(CODES.ARGUMENT_INVALID, 'limitBytes', 'limitBytes 必须是正整数');
  }
  limitBytes = Math.min(limitBytes, limits.readMaxBytes);

  let maxLines = opts.maxLines === undefined ? limits.readMaxLines : opts.maxLines;
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    return fail(CODES.ARGUMENT_INVALID, 'maxLines', 'maxLines 必须是正整数');
  }
  maxLines = Math.min(maxLines, limits.readMaxLines);

  const start = Math.min(offset, buffer.length);
  let end = Math.min(buffer.length, start + limitBytes);
  let slice = buffer.subarray(start, end);

  // 行数上限：在 maxLines 条完整行处截断。
  const lineSplit = slice.toString('utf8').split('\n');
  if (lineSplit.length > maxLines) {
    const kept = lineSplit.slice(0, maxLines).join('\n') + '\n';
    slice = Buffer.from(kept, 'utf8');
    end = start + slice.length;
  }

  // 字节上限可能切开多字节 UTF-8：回退到完整字符边界。
  if (end < buffer.length && end > start) {
    let cut = end;
    while (cut > start && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
    const lead = buffer[cut];
    let need = 0;
    if ((lead & 0xe0) === 0xc0) need = 2;
    else if ((lead & 0xf0) === 0xe0) need = 3;
    else if ((lead & 0xf8) === 0xf0) need = 4;
    if (need && cut + need > end) {
      end = cut;
      slice = buffer.subarray(start, end);
    }
  }

  const content = slice.toString('utf8');
  const nextOffset = start + slice.length;
  const lineCount = content === ''
    ? 0
    : (content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length);

  return ok({
    path: opts.path,
    content,
    encoding: 'utf8',
    bytes: slice.length,
    totalBytes: buffer.length,
    sha256: manifestMod.digestOfContent(buffer),
    offset: start,
    nextOffset,
    lines: lineCount,
    truncated: nextOffset < buffer.length,
  });
}

function searchFiles(attempt, options) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const opts = options || {};
  const limits = limitsOf(attempt);
  if (typeof opts.query !== 'string' || opts.query.length === 0) {
    return fail(CODES.ARGUMENT_INVALID, 'query', 'query 必须是非空字符串');
  }
  const mode = opts.mode === undefined ? 'content' : opts.mode;
  if (mode !== 'name' && mode !== 'content' && mode !== 'both') {
    return fail(CODES.ARGUMENT_INVALID, 'mode', 'mode 只能是 name/content/both');
  }
  const caseSensitive = opts.caseSensitive === true;
  let maxResults = opts.maxResults === undefined ? limits.maxSearchResults : opts.maxResults;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    return fail(CODES.ARGUMENT_INVALID, 'maxResults', 'maxResults 必须是正整数');
  }
  maxResults = Math.min(maxResults, limits.maxSearchResults);

  const rootCheck = assertCanonicalDir(attempt.candidateDir, CODES);
  if (!rootCheck.ok) return sanitizeFailure(rootCheck, attempt.attemptDir);

  const needle = caseSensitive ? opts.query : opts.query.toLowerCase();
  const matches = [];
  const seen = new Set();
  let truncated = false;
  let scannedFiles = 0;

  const pushMatch = (match) => {
    const key = match.path + '\u0000' + (match.line || 0) + '\u0000' + (match.column || 0);
    if (seen.has(key)) return true;
    seen.add(key);
    matches.push(match);
    if (matches.length >= maxResults) {
      truncated = true;
      return false;
    }
    return true;
  };

  const walk = (currentDir, currentPrefix) => {
    if (truncated) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(currentDir, entry.name);
      const relative = currentPrefix ? currentPrefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw fail(CODES.PATH_LINK, relative, '工作树内不得存在符号链接或 junction');
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;

      const haystackName = caseSensitive ? relative : relative.toLowerCase();
      if ((mode === 'name' || mode === 'both') && haystackName.includes(needle)) {
        if (!pushMatch({ path: relative })) return;
      }
      if (mode === 'name') continue;

      let stats;
      try {
        stats = fs.lstatSync(full);
      } catch (error) {
        continue;
      }
      if (stats.size > limits.readMaxBytes) continue;
      let buffer;
      try {
        buffer = fs.readFileSync(full);
      } catch (error) {
        continue;
      }
      scannedFiles += 1;
      if (isBinaryBuffer(buffer, relative)) continue;
      const lines = buffer.toString('utf8').split('\n');
      for (let index = 0; index < lines.length && !truncated; index += 1) {
        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLowerCase();
        let from = 0;
        for (;;) {
          const found = haystack.indexOf(needle, from);
          if (found < 0) break;
          const preview = line.trim().slice(0, 200);
          if (!pushMatch({ path: relative, line: index + 1, column: found + 1, preview })) return;
          from = found + Math.max(needle.length, 1);
        }
      }
    }
  };

  try {
    walk(attempt.candidateDir, '');
  } catch (failure) {
    if (failure && failure.ok === false) return sanitizeFailure(failure, attempt.attemptDir);
    return fail(CODES.IO_FAILED, '.', '搜索失败');
  }

  matches.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if ((a.line || 0) !== (b.line || 0)) return (a.line || 0) - (b.line || 0);
    return (a.column || 0) - (b.column || 0);
  });

  return ok({ query: opts.query, mode, matches, truncated, scannedFiles });
}

function writeFile(attempt, options) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const opts = options || {};
  const change = { op: 'write', path: opts.path, content: opts.content };
  if (Object.prototype.hasOwnProperty.call(opts, 'expectedBaseSha256')) {
    change.expectedBaseSha256 = opts.expectedBaseSha256;
  }
  return transactions.applyChanges(attempt, [change]);
}

function deleteFile(attempt, options) {
  const guard = guardAttempt(attempt);
  if (!guard.ok) return guard;
  const opts = options || {};
  const change = { op: 'delete', path: opts.path };
  if (Object.prototype.hasOwnProperty.call(opts, 'expectedBaseSha256')) {
    change.expectedBaseSha256 = opts.expectedBaseSha256;
  }
  return transactions.applyChanges(attempt, [change]);
}

module.exports = {
  CODES,
  LIMITS,
  normalizeRelativePath,
  isBinaryBuffer,
  listFiles,
  readFile,
  searchFiles,
  writeFile,
  deleteFile,
};
