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


const { sha256, lockDigest } = require('../scripts/composer/digest.cjs');
const { validateLock } = require('../scripts/composer/schema.cjs');
const { renderMarkdown } = require('../scripts/composer/report.cjs');
const { ARTIFACTS, digestManifest, inspectOutput } = require('./output-consistency.cjs');


const APPID_RE = /^wx[0-9a-f]{16}$/;
const PROJECT_CONFIG = ARTIFACTS.config;
const LOCK_FILE = ARTIFACTS.lock;
const REPORT_FILE = ARTIFACTS.report;
const MARKDOWN_FILE = ARTIFACTS.markdown;
const SIDECAR_FILE = ARTIFACTS.sidecar;

/** W1：本事务涉及的全部文件（config/lock/JSON 报告/Markdown 报告/侧车）。 */
const TRANSACTION_FILES = Object.freeze([
  PROJECT_CONFIG,
  LOCK_FILE,
  REPORT_FILE,
  MARKDOWN_FILE,
  SIDECAR_FILE,
]);

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
  writeTextSync(file, jsonText(value));
}

/** 任意文本的同步原子写（Markdown 报告与侧车共用）。 */
function writeTextSync(file, text) {
  const tmp = `${file}.tmp`;
  const old = `${file}.old`;
  fs.writeFileSync(tmp, text, 'utf8');
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

function assertInside(outputPath, target) {
  const root = path.resolve(outputPath);
  const resolved = path.resolve(target);
  return resolved.startsWith(root + path.sep);
}

/**
 * 备份事务涉及的文件。不存在的文件也记一条（existed:false），
 * 回滚时删除新建文件，保证失败后目录状态与事务前一致。
 *
 * 备份目录放在产物目录之外（同卷的兄弟目录 `.appid-backup`）：
 * 产物目录里多出来的任何文件都会进入安全扫描与整目录摘要，备份副本
 * 会把「已声明的输出路径」再次暴露成 PATH_ESCAPE 噪声，也不该随工程分发。
 */
function backupFiles(outputPath, files, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const backups = [];
  for (const file of files) {
    const source = path.join(outputPath, file);
    const existed = fs.existsSync(source);
    if (!existed) {
      backups.push({ file, target: null, existed: false });
      continue;
    }
    const target = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    backups.push({ file, target, existed: true });
  }
  return { backupDir, backups };
}

function rollback(outputPath, backups) {
  const failures = [];
  for (const item of backups) {
    const destination = path.join(outputPath, item.file);
    try {
      if (item.existed) {
        fs.copyFileSync(item.target, destination);
      } else if (fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
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
    const current = (recomputed.files || []).find((item) => item.path === relative);
    const record = (((previous.report || {}).output || {}).files || []).find((item) => item.path === relative);
    if (record && !current) problems.push(`A8: ${relative} 摘要缺失`);
    else if (record && record.digest !== current.digest) problems.push(`A8: ${relative} 摘要变化`);
  }

  if (report.output.treeSha256 !== recomputed.tree) problems.push('report: treeSha256 未回填');
  if (JSON.stringify(report.output.files) !== JSON.stringify(recomputed.files)) problems.push('report: files 未回填');
  if (report.output.fileCount !== recomputed.files.length) problems.push('report: fileCount 未回填');
  if (previousReport && report.lock && report.lock.lockDigest !== lock.lockDigest) problems.push('report: lockDigest 未回填');

  return problems;
}

function buildSidecarRecord(outputPath, payload) {
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
    note: 'AppID 由口袋店长·轻启写入；本文件不属于 Composer 产物，不参与摘要。',
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
  return record;
}

function writeSidecar(outputPath, payload) {
  writeJsonSync(path.join(outputPath, SIDECAR_FILE), buildSidecarRecord(outputPath, payload));
  return path.join(outputPath, SIDECAR_FILE);
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
  for (const file of [PROJECT_CONFIG, LOCK_FILE, REPORT_FILE, MARKDOWN_FILE]) {
    if (!fs.existsSync(path.join(outputPath, file))) {
      throw new AppidError('APPID_TARGET_MISSING', `产物缺少 ${file}，无法安全回填摘要`);
    }
  }

  // W1 四：写盘前先做统一只读校验（清单路径边界 + lock/report/markdown 自洽）。
  // 任何一项不通过就什么都不改动，避免"改到一半才发现清单越界/摘要已坏"。
  const before = inspectOutput(outputPath, { checkSidecar: false });
  if (!before.ok) {
    const code = before.problems.some((problem) => problem.code === 'APPID_PATH_INVALID')
      ? 'APPID_PATH_INVALID'
      : 'APPID_VERIFY_FAILED';
    throw new AppidError(code, '原始产物摘要不自洽，已拒绝写入 AppID', {
      problems: before.problems.slice(0, 10),
    });
  }

  const configPath = path.join(outputPath, PROJECT_CONFIG);
  if (!assertInside(outputPath, configPath)) throw new AppidError('APPID_PATH_INVALID', '目标路径越界');

  const configBefore = readJson(configPath);
  const lockBefore = readJson(path.join(outputPath, LOCK_FILE));
  const reportBefore = readJson(path.join(outputPath, REPORT_FILE));
  const manifest = before.files.map((item) => item.path);
  if (!manifest.includes(PROJECT_CONFIG)) {
    throw new AppidError('APPID_PATH_INVALID', 'composition.lock.json 清单缺少 project.config.json，无法回填摘要');
  }

  const digestBefore = (before.files.find((item) => item.path === PROJECT_CONFIG) || {}).digest || null;
  const treeBefore = lockBefore.outputDigest.tree;
  const lockBeforeDigest = lockBefore.lockDigest;

  // W1 三：同值不能直接短路 —— 只有 config/lock/report/Markdown/侧车与磁盘完全一致才算 unchanged。
  if (configBefore.appid === appid) {
    const verified = inspectOutput(outputPath, { expectAppid: appid });
    if (!verified.ok) {
      throw new AppidError('APPID_VERIFY_FAILED', 'AppID 相同但产物摘要或报告不一致，已拒绝短路', {
        problems: verified.problems.slice(0, 10),
      });
    }
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
      verified: true,
    };
  }

  const stamp = isoSeconds(now()).replace(/[:]/g, '');
  const backupDir = path.join(path.dirname(outputPath), '.appid-backup', `${path.basename(outputPath)}-${stamp}`);
  let backup;
  try {
    backup = backupFiles(outputPath, TRANSACTION_FILES, backupDir);
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

    // W1 五：JSON 报告里的每一项"当前产物摘要"都要同步；
    // 初次生成的摘要降级为显式历史记录，不能继续冒充当前值。
    const previousOutput = reportBefore.output || {};
    const history = Array.isArray(previousOutput.history) ? previousOutput.history.slice() : [];
    const initialLabel = history.length === 0 ? '初次生成' : 'AppID 写入前';
    if (previousOutput.treeSha256
      && !history.some((item) => item && item.treeSha256 === previousOutput.treeSha256 && item.stage === initialLabel)) {
      history.push({
        stage: initialLabel,
        projectPath: previousOutput.projectPath,
        treeSha256: previousOutput.treeSha256,
        fileCount: previousOutput.fileCount,
        recordedAt: reportBefore.generatedAt,
      });
    }
    const nextChecks = (Array.isArray(reportBefore.checks) ? reportBefore.checks : []).map((item) => (
      item && item.id === 'reproducibility' ? { ...item, message: recomputed.tree } : item
    ));
    const nextReport = {
      ...reportBefore,
      checks: nextChecks,
      lock: { ...(reportBefore.lock || {}), lockDigest: nextLock.lockDigest },
      output: {
        ...previousOutput,
        treeSha256: recomputed.tree,
        files: recomputed.files,
        fileCount: recomputed.files.length,
        history,
      },
    };
    writeJsonSync(path.join(outputPath, REPORT_FILE), nextReport);
    // Markdown 与 JSON 必须同源：用同一个 nextReport 重渲染。
    writeTextSync(path.join(outputPath, MARKDOWN_FILE), renderMarkdown(nextReport));

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
    const inspected = inspectOutput(outputPath, { expectAppid: appid, checkSidecar: false });
    const allProblems = [
      ...problems,
      ...inspected.problems.map((problem) => `${problem.code}: ${problem.message}`),
    ];
    if (allProblems.length > 0) {
      throw new AppidError('APPID_VERIFY_FAILED', '产物摘要自检未通过，已回滚', { problems: allProblems.slice(0, 10) });
    }

    // 侧车最后写入（原子写），写完再整体复核一次；失败同样回滚。
    const sidecarPayload = {
      appliedAt: isoSeconds(now()),
      appid,
      fileDigestBefore: digestBefore,
      fileDigestAfter: recomputed.files.find((item) => item.path === PROJECT_CONFIG)?.digest,
      treeDigestBefore: treeBefore,
      treeDigestAfter: recomputed.tree,
      lockDigestBefore: lockBeforeDigest,
      lockDigestAfter: nextLock.lockDigest,
    };
    writeJsonSync(path.join(outputPath, SIDECAR_FILE), buildSidecarRecord(outputPath, sidecarPayload));

    const finalCheck = inspectOutput(outputPath, { expectAppid: appid });
    if (!finalCheck.ok) {
      throw new AppidError('APPID_VERIFY_FAILED', '写入侧车后复核未通过，已回滚', {
        problems: finalCheck.problems.slice(0, 10),
      });
    }

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
      sidecar: path.join(outputPath, SIDECAR_FILE),
      verified: true,
    };
  } catch (error) {
    const failures = rollback(outputPath, backup.backups);
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

/**
 * 只读核查：按清单口径验证一份产物的摘要是否自洽。
 * W1：直接复用统一校验（含报告/Markdown/侧车一致性），不再只查一部分。
 */
function verifyOutputDigests(outputPath, options) {
  const inspected = inspectOutput(outputPath, { checkSidecar: (options || {}).checkSidecar });
  return {
    ok: inspected.ok,
    code: inspected.code,
    problems: inspected.problems,
    tree: inspected.tree,
    lockTree: inspected.tree,
    lockDigest: inspected.lockDigest,
    reportTree: inspected.tree,
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
  MARKDOWN_FILE,
  SIDECAR_FILE,
  TRANSACTION_FILES,
};