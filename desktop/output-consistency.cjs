'use strict';

/**
 * W1：产物只读一致性校验（appid 自检 与 DevTools 启动前检查共用同一套）。
 *
 * 只做读取与计算，不写任何文件。核对项：
 * 1. 清单路径边界：每项必须是非空规范 POSIX 相对路径，拒绝绝对路径/盘符/../
 *    重复项；resolve 与 realpath 后必须仍在产物根目录内；目标必须是普通文件
 *    （symlink / junction 一律拒绝）。
 * 2. lock：outputDigest.files 与磁盘逐文件一致、outputDigest.tree 与重算一致、
 *    lockDigest 自洽且通过 schema。
 * 3. report：treeSha256 / files / fileCount / lockDigest 都代表当前产物，
 *    checks 里的 reproducibility 不得停留在旧 tree。
 * 4. markdown：必须包含当前产物树摘要与当前 Lock 摘要。
 * 5. config：AppID 与期望值一致（可选），或在需要时必须是合法 wx AppID。
 * 6. sidecar：若存在，记录的 AppID 摘要与 Lock 摘要必须与当前一致。
 * 7.（可选 deep）运行完整 verifyOutput（静态校验 + 安全扫描 + 媒体校验）。
 *
 * 摘要口径与 Composer 的「清单口径」完全一致：只算 manifest 内文件，
 * 文本按 LF 归一化后 sha256，再按路径排序拼行取 sha256。
 */

const fs = require('node:fs');
const path = require('node:path');

const { sha256, lockDigest, normalizedText, fileSha256 } = require('../scripts/composer/digest.cjs');
const { validateLock } = require('../scripts/composer/schema.cjs');
const { verifyOutput } = require('../scripts/composer/verify.cjs');

const ARTIFACTS = Object.freeze({
  config: 'project.config.json',
  lock: 'composition.lock.json',
  report: 'generation-report.json',
  markdown: '生成报告.md',
  sidecar: 'appid-postprocess.json',
});

const REQUIRED_ARTIFACTS = Object.freeze(['config', 'lock', 'report', 'markdown']);

const APPID_RE = /^wx[0-9a-f]{16}$/;
const DRIVE_RE = /^[A-Za-z]:/;

class OutputCheckError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OutputCheckError';
    this.code = code;
    this.details = details || null;
  }
}

function isCanonicalPosixRelative(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value !== value.trim()) return false;
  if (value.includes('\0')) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (DRIVE_RE.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 清单路径边界检查（写盘前必须全部通过）。
 * @returns {{ code: string, path: string, message: string }[]}
 */
function manifestPathProblems(outputPath, paths) {
  const problems = [];
  const root = path.resolve(outputPath);
  let realRoot;
  try {
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
  } catch (error) {
    return [{ code: 'APPID_PATH_INVALID', path: '.', message: '无法解析产物根目录：' + error.message }];
  }

  const seen = new Set();
  for (const relative of paths) {
    if (!isCanonicalPosixRelative(relative)) {
      problems.push({
        code: 'APPID_PATH_INVALID',
        path: String(relative),
        message: '清单路径必须是规范 POSIX 相对路径（拒绝绝对路径、盘符、..、反斜杠与空段）',
      });
      continue;
    }
    if (seen.has(relative)) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '清单存在重复项' });
      continue;
    }
    seen.add(relative);

    const target = path.resolve(root, relative);
    if (!insideRoot(root, target)) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '清单路径越出产物根目录' });
      continue;
    }

    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch (error) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '清单内文件不可读：' + (error.code || error.message) });
      continue;
    }
    if (stats.isSymbolicLink()) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '清单内文件不得是符号链接或 junction' });
      continue;
    }
    if (!stats.isFile()) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '清单内条目必须是普通文件' });
      continue;
    }

    let real;
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
    } catch (error) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '无法解析真实路径：' + (error.code || error.message) });
      continue;
    }
    if (!insideRoot(realRoot, real)) {
      problems.push({ code: 'APPID_PATH_INVALID', path: relative, message: '真实路径越出产物根目录' });
    }
  }
  return problems;
}

/** 与 verify.cjs 完全一致的 tree 口径（只对清单内文件）。 */
function digestManifest(outputPath, paths) {
  const sorted = [...paths].sort();
  const files = sorted.map((relative) => ({
    path: relative,
    digest: fileSha256(path.join(outputPath, relative)),
  }));
  const lines = sorted.map((relative) => {
    const file = path.join(outputPath, relative);
    const raw = fs.readFileSync(file);
    const isText = !/\.(png|jpe?g|webp|gif|ico|zip)$/i.test(file);
    const content = isText ? Buffer.from(normalizedText(raw.toString('utf8')), 'utf8') : raw;
    return `${relative}:${sha256(content)}`;
  });
  return { tree: sha256(lines.join('\n')), files };
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 只读一致性检查。
 *
 * @param {string} outputPath 产物根目录
 * @param {{ expectAppid?: string, requireValidAppid?: boolean, checkSidecar?: boolean,
 *   deep?: boolean, mode?: string }} [options]
 */
function inspectOutput(outputPath, options) {
  const opts = options || {};
  const problems = [];
  const add = (code, message, extra) => problems.push({ code, message, ...(extra || {}) });
  const result = {
    ok: false,
    code: null,
    message: '',
    problems,
    outputPath: typeof outputPath === 'string' ? path.resolve(outputPath) : '',
    appid: '',
    tree: null,
    lockDigest: null,
    fileCount: null,
    files: null,
    verify: null,
    candidate: null,
  };

  const finish = () => {
    result.problems = problems;
    result.ok = problems.length === 0;
    result.code = problems.length > 0 ? problems[0].code : null;
    result.message = problems.length > 0 ? problems[0].message : '';
    return result;
  };

  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    add('OUTPUT_MISSING', '缺少产物目录');
    return finish();
  }
  const root = path.resolve(outputPath);
  let rootStats;
  try {
    rootStats = fs.statSync(root);
  } catch (error) {
    add('OUTPUT_MISSING', '产物目录不存在：' + (error.code || error.message));
    return finish();
  }
  if (!rootStats.isDirectory()) {
    add('OUTPUT_MISSING', '产物路径不是目录');
    return finish();
  }

  const files = {};
  for (const [key, name] of Object.entries(ARTIFACTS)) files[key] = path.join(root, name);
  for (const key of REQUIRED_ARTIFACTS) {
    if (!fs.existsSync(files[key])) add('OUTPUT_FILE_MISSING', `产物缺少 ${ARTIFACTS[key]}`, { file: ARTIFACTS[key] });
  }
  if (problems.length > 0) return finish();

  let config;
  let lock;
  let report;
  try {
    config = JSON.parse(fs.readFileSync(files.config, 'utf8'));
  } catch (error) {
    add('OUTPUT_JSON_INVALID', 'project.config.json 解析失败：' + error.message, { file: ARTIFACTS.config });
  }
  try {
    lock = JSON.parse(fs.readFileSync(files.lock, 'utf8'));
  } catch (error) {
    add('OUTPUT_JSON_INVALID', 'composition.lock.json 解析失败：' + error.message, { file: ARTIFACTS.lock });
  }
  try {
    report = JSON.parse(fs.readFileSync(files.report, 'utf8'));
  } catch (error) {
    add('OUTPUT_JSON_INVALID', 'generation-report.json 解析失败：' + error.message, { file: ARTIFACTS.report });
  }
  if (problems.length > 0) return finish();

  result.appid = typeof config.appid === 'string' ? config.appid.trim() : '';

  // ---- 1. 清单存在且路径合法 ----
  const manifestItems = lock && lock.outputDigest && Array.isArray(lock.outputDigest.files)
    ? lock.outputDigest.files
    : null;
  if (!manifestItems || manifestItems.length === 0) {
    add('APPID_PATH_INVALID', 'composition.lock.json 缺少产物清单，无法校验摘要');
    return finish();
  }
  const manifestPaths = manifestItems.map((item) => (item && typeof item === 'object' ? item.path : item));
  manifestPathProblems(root, manifestPaths).forEach((problem) => {
    add(problem.code, problem.message, { path: problem.path });
  });
  if (problems.length > 0) return finish();

  // ---- 2. lock 与磁盘一致 ----
  let recomputed;
  try {
    recomputed = digestManifest(root, manifestPaths);
  } catch (error) {
    add('OUTPUT_MANIFEST_MISMATCH', '清单内文件读取失败：' + (error.code || error.message));
    return finish();
  }
  result.tree = recomputed.tree;
  result.files = recomputed.files;
  result.fileCount = recomputed.files.length;
  result.lockDigest = lock.lockDigest || null;

  if (JSON.stringify(recomputed.files) !== JSON.stringify(manifestItems)) {
    add('OUTPUT_MANIFEST_MISMATCH', 'lock.outputDigest.files 与磁盘不一致');
  }
  if (recomputed.tree !== (lock.outputDigest && lock.outputDigest.tree)) {
    add('OUTPUT_TREE_MISMATCH', 'lock.outputDigest.tree 与磁盘重算结果不一致');
  }
  if (lockDigest(lock) !== lock.lockDigest) {
    add('OUTPUT_LOCK_DIGEST_MISMATCH', 'lockDigest 与 Lock 内容不自洽');
  }
  const lockSchema = validateLock(lock);
  if (!lockSchema.ok) {
    add('OUTPUT_LOCK_INVALID', 'Lock 未通过 schema：' + lockSchema.code + ' ' + lockSchema.message);
  }

  // ---- 3. report 必须代表当前产物 ----
  const reportOutput = report && typeof report.output === 'object' && report.output ? report.output : {};
  if (reportOutput.treeSha256 !== recomputed.tree) {
    add('OUTPUT_REPORT_STALE', '生成报告 output.treeSha256 不是当前产物摘要');
  }
  if (JSON.stringify(reportOutput.files) !== JSON.stringify(recomputed.files)) {
    add('OUTPUT_REPORT_STALE', '生成报告 output.files 与当前产物不一致');
  }
  if (reportOutput.fileCount !== recomputed.files.length) {
    add('OUTPUT_REPORT_STALE', '生成报告 output.fileCount 与当前产物不一致');
  }
  if (!report.lock || report.lock.lockDigest !== lock.lockDigest) {
    add('OUTPUT_REPORT_STALE', '生成报告 lock.lockDigest 未同步到当前 Lock');
  }
  if (reportOutput.projectPath && !samePath(reportOutput.projectPath, root)) {
    add('OUTPUT_REPORT_PATH_MISMATCH', '生成报告 output.projectPath 与当前目录不一致', { expected: root });
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const reproducibility = checks.find((item) => item && item.id === 'reproducibility');
  if (reproducibility && String(reproducibility.message || '') !== recomputed.tree) {
    add('OUTPUT_REPORT_STALE', '生成报告 checks 仍记录旧产物摘要（reproducibility）');
  }

  // ---- 4. markdown 必须包含当前摘要 ----
  let markdown = '';
  try {
    markdown = fs.readFileSync(files.markdown, 'utf8');
  } catch (error) {
    add('OUTPUT_FILE_MISSING', '生成报告.md 不可读：' + (error.code || error.message), { file: ARTIFACTS.markdown });
  }
  if (markdown) {
    if (!markdown.includes(recomputed.tree)) {
      add('OUTPUT_REPORT_STALE', '生成报告.md 未包含当前产物树摘要');
    }
    if (lock.lockDigest && !markdown.includes(lock.lockDigest)) {
      add('OUTPUT_REPORT_STALE', '生成报告.md 未包含当前 Lock 摘要');
    }
  }

  // ---- 5. AppID ----
  if (opts.expectAppid !== undefined && opts.expectAppid !== null) {
    const expected = String(opts.expectAppid).trim().toLowerCase();
    if (result.appid.toLowerCase() !== expected) {
      add('OUTPUT_APPID_MISMATCH', 'project.config.json 的 AppID 与期望不一致');
    }
  }
  if (opts.requireValidAppid && !APPID_RE.test(result.appid)) {
    add('OUTPUT_APPID_INVALID', 'AppID 不合法（应为 wx + 16 位十六进制），当前：' + (result.appid || '空'));
  }

  // ---- 6. 侧车 ----
  if (opts.checkSidecar !== false && fs.existsSync(files.sidecar)) {
    let sidecar = null;
    try {
      sidecar = JSON.parse(fs.readFileSync(files.sidecar, 'utf8'));
    } catch (error) {
      add('SIDECAR_INVALID', 'appid-postprocess.json 解析失败：' + error.message);
    }
    if (sidecar && typeof sidecar === 'object') {
      if (sidecar.appidSha256 && result.appid && sidecar.appidSha256 !== sha256(result.appid)) {
        add('SIDECAR_MISMATCH', '侧车记录的 AppID 摘要与 project.config.json 不一致');
      }
      if (sidecar.lockDigestAfter && sidecar.lockDigestAfter !== lock.lockDigest) {
        add('SIDECAR_MISMATCH', '侧车记录的 Lock 摘要与当前 Lock 不一致');
      }
    }
  }

  // ---- 7. 候选 overlay 一致性（P5） ----
  if (opts.candidate) {
    result.candidate = inspectCandidateOutput(root, report, opts.candidate, add);
  }

  // ---- 8. 可选：完整 verifyOutput ----
  if (opts.deep) {
    const verified = verifyOutput(root, { mode: opts.mode || 'development' });
    if (!verified.ok) {
      add(verified.code || 'OUTPUT_VERIFY_FAILED', 'verifyOutput 未通过：' + (verified.message || ''), {
        verifyCode: verified.code || null,
      });
    } else {
      result.verify = {
        ok: true,
        tree: verified.tree,
        fileCount: Array.isArray(verified.files) ? verified.files.length : null,
        checks: verified.checks || [],
      };
    }
  }

  return finish();
}

/** 在产物 pages/**\/*.wxss 里找候选 FrontendPack 标记（有限深度/文件数，避免任意扫描）。 */
function findWxssCandidateMarker(root, marker) {
  const pagesDir = path.join(root, 'pages');
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || visited > 200) return false;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return false;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 200) return false;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(target, depth + 1)) return true;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.wxss')) continue;
      try {
        if (fs.readFileSync(target, 'utf8').includes(marker)) return true;
      } catch (error) {
        /* 单个文件读失败不影响「没找到」的结论 */
      }
    }
    return false;
  };
  return walk(pagesDir, 0);
}

/**
 * P5：候选 overlay 一致性（导出必须与 dry-run 同源）。
 * 只认三处可观察证据：config/store.generated.js 的 frontendPackId/Version、
 * 页面 WXSS 的 FrontendPack 标记、generation-report 的 candidate 记录。
 */
function inspectCandidateOutput(root, report, candidate, add) {
  const candidateId = candidate && typeof candidate.candidateId === 'string' ? candidate.candidateId : '';
  const candidateVersion = candidate && typeof candidate.candidateVersion === 'string' ? candidate.candidateVersion : '';
  if (!candidateId || !candidateVersion) {
    add('CANDIDATE_OUTPUT_MISMATCH', '候选一致性检查缺少 candidateId/version');
    return { candidateId, candidateVersion, matched: false };
  }
  const storeConfigFile = path.join(root, 'config', 'store.generated.js');
  let storeConfigText = '';
  try {
    storeConfigText = fs.readFileSync(storeConfigFile, 'utf8');
  } catch (error) {
    add('CANDIDATE_OUTPUT_MISMATCH', '产物缺少 config/store.generated.js：' + (error.code || error.message), { file: 'config/store.generated.js' });
  }
  if (storeConfigText) {
    const idMatch = /["']?frontendPackId["']?\s*:\s*["']([^"']+)["']/.exec(storeConfigText);
    const versionMatch = /["']?frontendPackVersion["']?\s*:\s*["']([^"']+)["']/.exec(storeConfigText);
    if (!idMatch || idMatch[1] !== candidateId) {
      add('CANDIDATE_OUTPUT_MISMATCH', '产物配置里的 FrontendPack 不是请求的候选（可能已回落 Base）', { file: 'config/store.generated.js' });
    }
    if (!versionMatch || versionMatch[1] !== candidateVersion) {
      add('CANDIDATE_OUTPUT_MISMATCH', '产物配置里的候选版本不一致', { file: 'config/store.generated.js' });
    }
  }
  const marker = 'FrontendPack ' + candidateId + '@' + candidateVersion;
  if (!findWxssCandidateMarker(root, marker)) {
    add('CANDIDATE_OUTPUT_MISMATCH', '产物页面 WXSS 没有候选 FrontendPack 标记');
  }
  const unresolved = Array.isArray(report && report.unresolved) ? report.unresolved : [];
  const line = unresolved.find((item) => typeof item === 'string' && item.startsWith('candidate:'));
  if (!line || !line.includes(candidateId + '@' + candidateVersion)) {
    add('OUTPUT_REPORT_STALE', '生成报告没有记录当前候选状态（candidate 行缺失）');
  }
  return { candidateId, candidateVersion, matched: true };
}

/** 严格版本：失败即抛错（code 从问题里取第一个）。 */
function assertOutputConsistent(outputPath, options) {
  const result = inspectOutput(outputPath, options);
  if (!result.ok) {
    throw new OutputCheckError(result.code || 'OUTPUT_INCONSISTENT', result.message || '产物校验未通过', {
      problems: result.problems.slice(0, 10),
    });
  }
  return result;
}

module.exports = {
  ARTIFACTS,
  REQUIRED_ARTIFACTS,
  APPID_RE,
  OutputCheckError,
  isCanonicalPosixRelative,
  manifestPathProblems,
  digestManifest,
  inspectOutput,
  assertOutputConsistent,
};
