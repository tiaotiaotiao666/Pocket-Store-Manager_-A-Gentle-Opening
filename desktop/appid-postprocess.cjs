'use strict';

/**
 * AppID 后置写入（实现方案第 8 章，方案 D-1）。
 *
 * 关键结论：Composer 的 outputDigest 覆盖 project.config.json，直接改写会让
 * composition.lock.json 与 generation-report.json 自相矛盾。因此必须按
 * 「清单口径」重算并回填 lock/report，再做 A1–A8 自检，失败全量回滚。
 *
 * 口径（不可换成整目录 tree）：
 * - files' = lock.outputDigest.files[].path 逐条重算（sha256 文件字节）
 * - tree'  = 清单排序后按 treeSha256 同款文本归一化拼接，再 sha256
 * - lock.lockDigest = lockDigest(去掉 generatedAt 与 lockDigest 后的 lock)
 * - 侧车 appid-postprocess.json 在回填完成后写入，因此天然不在清单里。
 */

const fs = require('node:fs');
const path = require('node:path');


const { sha256, lockDigest, normalizedText, fileSha256 } = require('../scripts/composer/digest.cjs');
const { validateLock } = require('../scripts/composer/schema.cjs');


const APPID_RE = /^wx[0-9a-f]{16}$/;
const PROJECT_CONFIG = 'project.config.json';
const LOCK_FILE = 'composition.lock.json';
const REPORT_FILE = 'generation-report.json';
const SIDECAR_FILE = 'appid-postprocess.json';

class AppidError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppidError';
    this.code = code;
    this.details = details || null;
  }
}

function isoSeconds(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function maskAppid(appid) {
  if (typeof appid !== 'string' || appid.length < 10) return '';
  return `${appid.slice(0, 4)}****${appid.slice(-6)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AppidError('APPID_WRITE_FAILED', `无法解析 ${path.basename(file)}`, { cause: error.message });
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 同步原子写（Windows 三步法）。
 * 本模块是同步函数（便于在 IPC 内一次性完成备份/改写/校验/回滚），
 * 因此不能复用 project-store 里 async 的 writeFileAtomic。
 */
function writeJsonSync(file, value) {
  const tmp = `${file}.tmp`;
  const old = `${file}.old`;
  fs.writeFileSync(tmp, jsonText(value), 'utf8');
  try {
    fs.unlinkSync(old);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let hadOld = false;
  try {
    fs.renameSync(file, old);
    hadOld = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { fs.unlinkSync(tmp); } catch (ignored) { /* tmp 可能不存在 */ }
      throw error;
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    if (hadOld) {
      try { fs.renameSync(old, file); } catch (ignored) { /* 回滚失败时由上层报告 */ }
    }
    try { fs.unlinkSync(tmp); } catch (ignored) { /* 无 tmp 时忽略 */ }
    throw error;
  }
  if (hadOld) {
    try { fs.unlinkSync(old); } catch (ignored) { /* old 清理失败不影响已提交内容 */ }
  }
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

function assertInside(outputPath, target) {
  const root = path.resolve(outputPath);
  const resolved = path.resolve(target);
  return resolved.startsWith(root + path.sep);
}

function backupFiles(outputPath, files, stamp) {
  const backupDir = path.join(outputPath, '.appid-backup', stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const backups = [];
  for (const file of files) {
    const source = path.join(outputPath, file);
    const target = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    backups.push({ file, target });
  }
  return { backupDir, backups };
}

function rollback(backups) {
  const failures = [];
  for (const item of backups) {
    try {
      fs.copyFileSync(item.target, path.join(path.dirname(item.target), '..', '..', item.file));
    } catch (error) {
      failures.push({ file: item.file, message: error.message });
    }
  }
  return failures;
}

function verifyApplied(options) {
  const { outputPath, appid, lock, report, manifest, previous, previousLock, previousReport } = options;
  const problems = [];

  const configAfter = readJson(path.join(outputPath, PROJECT_CONFIG));
  if (configAfter.appid !== appid) problems.push('A1: project.config.json appid 未写入');

  const recomputed = digestManifest(outputPath, manifest);
  const lockFiles = lock.outputDigest && Array.isArray(lock.outputDigest.files) ? lock.outputDigest.files : [];
  if (JSON.stringify(recomputed.files) !== JSON.stringify(lockFiles)) problems.push('A2: outputDigest.files 与磁盘不一致');
  if (recomputed.tree !== (lock.outputDigest && lock.outputDigest.tree)) problems.push('A3: outputDigest.tree 与磁盘不一致');

  if (lockDigest(lock) !== lock.lockDigest) problems.push('A4: lockDigest 不自洽');

  const changed = manifest.filter((relative) => relative !== PROJECT_CONFIG);
  const beforeMap = new Map(((previousLock.outputDigest && previousLock.outputDigest.files) || []).map((item) => [item.path, item.digest]));
  for (const relative of changed) {
    const current = recomputed.files.find((item) => item.path === relative);
    if (!current || beforeMap.get(relative) !== current.digest) problems.push(`A5: 非目标文件被改动 ${relative}`);
  }

  if (lock.planDigest !== previousLock.planDigest
    || lock.registryDigest !== previousLock.registryDigest
    || JSON.stringify(lock.features) !== JSON.stringify(previousLock.features)) {
    problems.push('A6: 配方/注册表/能力指纹被改动');
  }

  const lockCheck = validateLock(lock);
  if (!lockCheck.ok) problems.push(`A7: ${lockCheck.code} ${lockCheck.message}`);

  for (const relative of ['app.json', 'config/store.generated.js']) {
    const before = fileSha256(path.join(outputPath, relative));
    const record = (previous.report.output.files || []).find((item) => item.path === relative);
    if (record && record.digest !== before) problems.push(`A8: ${relative} 摘要变化`);
  }

  if (report.output.treeSha256 !== recomputed.tree) problems.push('report: treeSha256 未回填');
  if (JSON.stringify(report.output.files) !== JSON.stringify(recomputed.files)) problems.push('report: files 未回填');
  if (report.output.fileCount !== recomputed.files.length) problems.push('report: fileCount 未回填');
  if (previousReport && report.lock && report.lock.lockDigest !== lock.lockDigest) problems.push('report: lockDigest 未回填');

  return problems;
}

function writeSidecar(outputPath, payload) {
  const file = path.join(outputPath, SIDECAR_FILE);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    previous = null;
  }
  const record = {
    recordVersion: 'appid-postprocess.v1',
    appliedAt: payload.appliedAt,
    target: PROJECT_CONFIG,
    appidMasked: maskAppid(payload.appid),
    appidSha256: sha256(payload.appid),
    fileDigestBefore: payload.fileDigestBefore,
    fileDigestAfter: payload.fileDigestAfter,
    treeDigestBefore: payload.treeDigestBefore,
    treeDigestAfter: payload.treeDigestAfter,
    lockDigestBefore: payload.lockDigestBefore,
    lockDigestAfter: payload.lockDigestAfter,
    scope: 'composer-outputDigest-files',
    note: 'AppID 由智能开店宿主写入；本文件不属于 Composer 产物，不参与摘要。',
    revisions: Array.isArray(previous && previous.revisions) ? previous.revisions.slice(-9) : [],
  };
  if (previous) {
    record.revisions.push({
      appliedAt: previous.appliedAt,
      appidMasked: previous.appidMasked,
      lockDigestBefore: previous.lockDigestBefore,
      lockDigestAfter: previous.lockDigestAfter,
    });
  }
  fs.writeFileSync(file, jsonText(record), 'utf8');
  return file;
}

/**
 * @param {{outputPath: string, appid: string, now?: () => Date}} options
 */
function applyAppid(options) {
  const opts = options || {};
  const outputPath = typeof opts.outputPath === 'string' ? path.resolve(opts.outputPath) : '';
  const appid = typeof opts.appid === 'string' ? opts.appid.trim().toLowerCase() : '';
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  if (!outputPath || !fs.existsSync(outputPath) || !fs.statSync(outputPath).isDirectory()) {
    throw new AppidError('APPID_TARGET_MISSING', '产物目录不存在，请重新导出');
  }
  if (!APPID_RE.test(appid)) {
    throw new AppidError('APPID_INVALID', 'AppID 格式不正确（wx + 16 位十六进制）');
  }
  for (const file of [PROJECT_CONFIG, LOCK_FILE, REPORT_FILE]) {
    if (!fs.existsSync(path.join(outputPath, file))) {
      throw new AppidError('APPID_TARGET_MISSING', `产物缺少 ${file}，无法安全回填摘要`);
    }
  }

  const configPath = path.join(outputPath, PROJECT_CONFIG);
  if (!assertInside(outputPath, configPath)) throw new AppidError('APPID_WRITE_FAILED', '目标路径越界');

  const configBefore = readJson(configPath);
  const lockBefore = readJson(path.join(outputPath, LOCK_FILE));
  const reportBefore = readJson(path.join(outputPath, REPORT_FILE));
  const manifest = Array.isArray(lockBefore.outputDigest && lockBefore.outputDigest.files)
    ? lockBefore.outputDigest.files.map((item) => item.path)
    : [];
  if (manifest.length === 0 || !manifest.includes(PROJECT_CONFIG)) {
    throw new AppidError('APPID_TARGET_MISSING', 'composition.lock.json 缺少产物清单，无法回填摘要');
  }

  const digestBefore = fileSha256(configPath);
  const treeBefore = lockBefore.outputDigest.tree;
  const lockBeforeDigest = lockBefore.lockDigest;

  if (configBefore.appid === appid) {
    return {
      applied: true,
      unchanged: true,
      appid,
      digestBefore,
      digestAfter: digestBefore,
      lockDigestBefore: lockBeforeDigest,
      lockDigestAfter: lockBeforeDigest,
      treeDigestBefore: treeBefore,
      treeDigestAfter: treeBefore,
      fileCount: manifest.length,
      backupDir: null,
      sidecar: path.join(outputPath, SIDECAR_FILE),
    };
  }

  const stamp = isoSeconds(now()).replace(/[:]/g, '');
  let backup;
  try {
    backup = backupFiles(outputPath, [PROJECT_CONFIG, LOCK_FILE, REPORT_FILE], stamp);
  } catch (error) {
    throw new AppidError('APPID_WRITE_FAILED', '无法创建回滚备份，工程保持原始状态', { cause: error.message });
  }

  try {
    const nextConfig = { ...configBefore, appid };
    writeJsonSync(configPath, nextConfig);

    const recomputed = digestManifest(outputPath, manifest);
    const nextLock = {
      ...lockBefore,
      outputDigest: { tree: recomputed.tree, files: recomputed.files },
    };
    nextLock.lockDigest = lockDigest(nextLock);
    const lockValidation = validateLock(nextLock);
    if (!lockValidation.ok) {
      throw new AppidError('APPID_VERIFY_FAILED', `回填后的 Lock 未通过 schema：${lockValidation.message}`);
    }
    writeJsonSync(path.join(outputPath, LOCK_FILE), nextLock);

    const nextReport = {
      ...reportBefore,
      lock: { ...(reportBefore.lock || {}), lockDigest: nextLock.lockDigest },
      output: {
        ...(reportBefore.output || {}),
        treeSha256: recomputed.tree,
        files: recomputed.files,
        fileCount: recomputed.files.length,
      },
    };
    writeJsonSync(path.join(outputPath, REPORT_FILE), nextReport);

    const problems = verifyApplied({
      outputPath,
      appid,
      lock: nextLock,
      report: nextReport,
      manifest,
      previous: { report: reportBefore },
      previousLock: lockBefore,
      previousReport: reportBefore,
    });
    if (problems.length > 0) {
      throw new AppidError('APPID_VERIFY_FAILED', '产物摘要自检未通过，已回滚', { problems });
    }

    const sidecar = writeSidecar(outputPath, {
      appliedAt: isoSeconds(now()),
      appid,
      fileDigestBefore: digestBefore,
      fileDigestAfter: recomputed.files.find((item) => item.path === PROJECT_CONFIG)?.digest,
      treeDigestBefore: treeBefore,
      treeDigestAfter: recomputed.tree,
      lockDigestBefore: lockBeforeDigest,
      lockDigestAfter: nextLock.lockDigest,
    });

    return {
      applied: true,
      unchanged: false,
      appid,
      digestBefore,
      digestAfter: recomputed.files.find((item) => item.path === PROJECT_CONFIG)?.digest,
      lockDigestBefore: lockBeforeDigest,
      lockDigestAfter: nextLock.lockDigest,
      treeDigestBefore: treeBefore,
      treeDigestAfter: recomputed.tree,
      fileCount: recomputed.files.length,
      backupDir: backup.backupDir,
      sidecar,
    };
  } catch (error) {
    const failures = rollback(backup.backups);
    if (failures.length > 0) {
      throw new AppidError('APPID_WRITE_FAILED', '写入失败且自动回滚未完全成功，请手动从备份恢复', {
        backupDir: backup.backupDir,
        failures,
        cause: error.message,
      });
    }
    if (error instanceof AppidError) throw error;
    throw new AppidError('APPID_WRITE_FAILED', 'AppID 写入失败，工程已恢复到原始状态', {
      cause: error.message,
      backupDir: backup.backupDir,
    });
  }
}

/** 只读核查：按清单口径验证一份产物的摘要是否自洽。 */
function verifyOutputDigests(outputPath) {
  const lock = readJson(path.join(outputPath, LOCK_FILE));
  const report = readJson(path.join(outputPath, REPORT_FILE));
  const manifest = (lock.outputDigest && lock.outputDigest.files || []).map((item) => item.path);
  const recomputed = digestManifest(outputPath, manifest);
  return {
    ok: recomputed.tree === lock.outputDigest.tree
      && JSON.stringify(recomputed.files) === JSON.stringify(lock.outputDigest.files)
      && lockDigest(lock) === lock.lockDigest
      && report.output.treeSha256 === recomputed.tree,
    tree: recomputed.tree,
    lockTree: lock.outputDigest.tree,
    lockDigest: lock.lockDigest,
    reportTree: report.output.treeSha256,
  };
}

module.exports = {
  applyAppid,
  verifyOutputDigests,
  digestManifest,
  maskAppid,
  AppidError,
  APPID_RE,
  PROJECT_CONFIG,
  LOCK_FILE,
  REPORT_FILE,
  SIDECAR_FILE,
};