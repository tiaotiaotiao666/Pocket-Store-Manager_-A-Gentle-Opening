'use strict';

/**
 * P3 候选 dry-run：Composer P0–P6 + mini:check + output-consistency + 可观察项对照。
 *
 * 设计约束：
 * - **复用而不是复制**：组合/校验全部调用 `scripts/composer`（`compose()` 内含 P0–P6 与
 *   `verifyOutput`）、`scripts/validate-miniprogram.cjs#runChecks`（= `npm run mini:check`
 *   的同一实现）与 `desktop/output-consistency.cjs#inspectOutput`；本文件只做编排与错误归类。
 * - **只在本次 attempt 私有目录内写盘**：`<attemptDir>/verification/dry-run[-n]/candidate`。
 * - **结构化可定位**：失败时返回 issues（DSL path / 输出文件 / 字段），可直接交给
 *   `repair.cjs` 做最多两轮受控修复；日志正文、绝对路径、源码不进入 issues。
 * - 产物目录缺失/未通过都如实失败，绝不伪造通过；取消返回 `DRY_RUN_CANCELLED`。
 */

const fs = require('node:fs');
const path = require('node:path');

const { materializeCandidate } = require('./materialize.cjs');
const { REPAIR_ISSUE_CODES } = require('./repair.cjs');
const { compareObservable } = require('./compare.cjs');
const {
  ensureDirectory,
  assertCanonicalDir,
  realpathOf,
  isInsideOrEqual,
} = require('./workspace.cjs');
const { compose } = require('../../scripts/composer/index.cjs');
const { runChecks } = require('../../scripts/validate-miniprogram.cjs');
const { inspectOutput } = require('../output-consistency.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PLAN_FILE = path.join(REPO_ROOT, 'templates', 'recipes', 'order-warm-home', '1.0.0', 'plan.json');
const DRY_RUN_DIR = 'verification';
const DRY_RUN_PREFIX = 'dry-run';
const RESULT_FILE = 'frontend-dry-run.json';
const RESULT_SCHEMA_VERSION = 'frontend-dry-run.v1';
const MAX_ISSUES = 12;
const MAX_CHECKS = 48;
const MAX_MESSAGE = 200;

const CODES = Object.freeze({
  OK: 'DRY_RUN_OK',
  INPUT_INVALID: 'DRY_RUN_INPUT_INVALID',
  CANCELLED: 'DRY_RUN_CANCELLED',
  MATERIALIZE_FAILED: 'DRY_RUN_MATERIALIZE_FAILED',
  FAILED: 'DRY_RUN_FAILED',
  MINI_CHECK_FAILED: 'MINI_CHECK_FAILED',
  CONSISTENCY_FAILED: 'CONSISTENCY_FAILED',
  OUTPUT_REJECTED: 'DRY_RUN_OUTPUT_REJECTED',
});

const STAGES = Object.freeze(['materialize', 'compose', 'mini-check', 'consistency', 'observable']);

function truncate(value, limit) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function boundedDetail(error) {
  if (!error) return 'UNKNOWN';
  return truncate(
    String(error.code || error.message || error)
      .replace(/[A-Za-z]:[\\/][^\s，；,）)]*/g, '<local-path>')
      .replace(/\\\\[^\s，；,）)]+/g, '<local-path>'),
    160,
  );
}

function isCancelled(signal) {
  if (!signal) return false;
  if (typeof signal.cancelled === 'boolean') return signal.cancelled;
  if (typeof signal.aborted === 'boolean') return signal.aborted;
  return false;
}

/** 摘要/issue 文案里不出现本机绝对路径（Composer/文件系统错误文本可能带路径）。 */
function sanitizeMessage(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[A-Za-z]:[\\/][^\s；，,）)]*/g, '<local-path>')
    .replace(/\\\\[^\s；，,）)]+/g, '<local-path>');
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, message: boundedDetail(error) };
  }
}

function fieldOfPath(issuePath) {
  if (typeof issuePath !== 'string' || !issuePath.startsWith('$')) return null;
  const matched = issuePath.match(/([^.[\]]+)\s*$/);
  return matched ? matched[1] : null;
}

function dslPathOf(value) {
  return typeof value === 'string' && value.startsWith('$') ? value : null;
}

function pageIndexPath(plan, pageId) {
  const pages = plan && Array.isArray(plan.pages) ? plan.pages : [];
  const index = pages.findIndex((page) => page && page.pageId === pageId);
  return index >= 0 ? '$.pages[' + index + ']' : null;
}

/** 从输出相对文件（`pages/home/index.wxml`）反查 DSL 页路径。 */
function pagePathFromFile(plan, file) {
  if (typeof file !== 'string') return null;
  const matched = file.replace(/\\/g, '/').match(/^pages\/([^/]+)\//);
  if (!matched) return null;
  return pageIndexPath(plan, matched[1]);
}

function makeIssue(input) {
  const code = typeof input.code === 'string' ? input.code : CODES.FAILED;
  return {
    code,
    path: dslPathOf(input.path) || null,
    field: input.field === undefined ? fieldOfPath(input.path) : input.field,
    file: typeof input.file === 'string' && input.file !== '' ? input.file : null,
    message: truncate(sanitizeMessage(input.message), MAX_MESSAGE),
    severity: input.severity === 'warning' ? 'warning' : 'error',
    source: input.source || 'dry-run',
  };
}

/** 把 Composer 错误码归类到契约里允许 repair 的稳定 code（无法归类时 fail closed 为 DRY_RUN_FAILED）。 */
function repairCodeForComposer(code) {
  if (typeof code !== 'string') return CODES.FAILED;
  if (REPAIR_ISSUE_CODES.includes(code)) return code;
  if (code === 'OUTPUT_STATIC_CHECK_FAILED') return CODES.MINI_CHECK_FAILED;
  if (code.startsWith('OUTPUT_')) return CODES.CONSISTENCY_FAILED;
  return CODES.FAILED;
}

function issuesFromDraftFailure(result) {
  const draftCode = result && result.details && typeof result.details.draftCode === 'string'
    ? result.details.draftCode
    : null;
  const code = draftCode && REPAIR_ISSUE_CODES.includes(draftCode) ? draftCode : CODES.FAILED;
  return [makeIssue({
    code,
    path: result && result.path,
    file: null,
    message: (result && result.message) || 'Draft 未通过本地校验',
    source: 'materialize',
  })];
}

/**
 * Composer 失败（P0–P6 任一阶段）→ 结构化 issues。
 * 只有能定位到 DSL path 的问题才可能在 repair 通道里被修复；其余如实标 `path:null`。
 */
function issuesFromComposer(result, plan) {
  const issues = [];
  const entries = [];
  if (result && result.details && Array.isArray(result.details.errors) && result.details.errors.length > 0) {
    for (const entry of result.details.errors) {
      if (entry && typeof entry === 'object') entries.push(entry);
    }
  }
  if (entries.length === 0) {
    entries.push({
      code: result && result.code,
      path: result && result.path,
      message: (result && result.message) || 'Composer 未通过',
      details: result && result.details,
    });
  }

  for (const entry of entries) {
    const composerCode = typeof entry.code === 'string' ? entry.code : CODES.FAILED;
    if (composerCode === 'OUTPUT_STATIC_CHECK_FAILED' && entry.details && Array.isArray(entry.details.errors)) {
      for (const staticError of entry.details.errors) {
        issues.push(...issuesFromMiniCheck([String(staticError)], plan));
      }
      continue;
    }
    const entryPath = entry.path;
    let issuePath = dslPathOf(entryPath);
    let file = null;
    if (!issuePath && typeof entryPath === 'string' && entryPath !== '$') {
      file = entryPath.replace(/\\/g, '/');
    }
    if (!issuePath) {
      const pathHints = [entry.message, entry.details && entry.details.message]
        .filter((item) => typeof item === 'string')
        .join(' ');
      const matched = pathHints.match(/pages\/([^/\s]+)\//);
      if (matched) issuePath = pagePathFromFile(plan, 'pages/' + matched[1] + '/');
    }
    issues.push(makeIssue({
      code: repairCodeForComposer(composerCode),
      path: issuePath,
      file,
      field: fieldOfPath(issuePath),
      message: (entry.message || composerCode) + '（' + composerCode + '）',
      source: 'composer',
    }));
  }
  return issues;
}

/** mini:check 错误字符串（`pages/home/index.wxml: ...`）→ 文件 + DSL 页路径。 */
function issuesFromMiniCheck(errors, plan) {
  const issues = [];
  for (const raw of Array.isArray(errors) ? errors : []) {
    const text = String(raw);
    const matched = text.match(/^([^:\s][^:]*\.(?:wxml|wxss|json|js)):\s*(.*)$/);
    const file = matched ? matched[1].replace(/\\/g, '/') : null;
    const message = matched ? matched[2] : text;
    issues.push(makeIssue({
      code: CODES.MINI_CHECK_FAILED,
      path: pagePathFromFile(plan, file),
      file,
      field: null,
      message: 'mini:check 未通过：' + message,
      source: 'mini-check',
    }));
  }
  return issues;
}

/** output-consistency 问题 → CONSISTENCY_FAILED。 */
function issuesFromConsistency(problems, plan) {
  const issues = [];
  for (const problem of Array.isArray(problems) ? problems : []) {
    if (!problem || typeof problem !== 'object') continue;
    const file = typeof problem.file === 'string' ? problem.file.replace(/\\/g, '/') : null;
    issues.push(makeIssue({
      code: CODES.CONSISTENCY_FAILED,
      path: pagePathFromFile(plan, file) || (typeof problem.path === 'string' && !problem.path.startsWith('$') ? null : problem.path),
      file,
      field: null,
      message: '输出一致性未通过：' + (problem.message || problem.code || 'UNKNOWN'),
      source: 'consistency',
    }));
  }
  return issues;
}

/** 可观察项问题 → 契约允许的 repair code（只有缺锚点有独立 code，其余归 CONSISTENCY_FAILED）。 */
function issuesFromObservable(observable) {
  const issues = [];
  for (const issue of (observable && Array.isArray(observable.issues) ? observable.issues : [])) {
    if (!issue || typeof issue !== 'object') continue;
    const code = issue.code === 'SLOT_ANCHOR_MISSING' ? 'SLOT_ANCHOR_MISSING' : CODES.CONSISTENCY_FAILED;
    issues.push(makeIssue({
      code,
      path: issue.path,
      file: issue.file,
      field: issue.field,
      message: issue.message,
      source: 'observable',
    }));
  }
  return issues;
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = issue.code + '|' + (issue.path || '') + '|' + (issue.file || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/** 统一的失败结果（有界、无绝对路径、可继续交给 repair）。 */
function failResult(options) {
  const opts = options || {};
  const issues = dedupeIssues(opts.issues || []);
  return {
    ok: false,
    code: opts.code || CODES.FAILED,
    summary: truncate(sanitizeMessage(opts.summary || '候选 dry-run 未通过'), 300),
    details: opts.details || {},
    candidateId: opts.candidateId === undefined ? null : opts.candidateId,
    revision: opts.revision === undefined ? null : opts.revision,
    artifacts: opts.artifacts || {},
    issues,
    checks: (opts.checks || []).slice(0, MAX_CHECKS),
  };
}

/** 解析候选 Plan：默认读 Base Recipe Plan，并把 frontendPack 指向本次候选（记录覆盖事实）。 */
function resolveCandidatePlan(planOption, planFileOption, candidate) {
  const source = planOption !== undefined ? 'provided' : 'file';
  const file = planFileOption || DEFAULT_PLAN_FILE;
  let plan = planOption;
  if (plan === undefined) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) {
      return { ok: false, message: 'planFile 必须是绝对路径' };
    }
    const read = readJson(file);
    if (!read.ok) return { ok: false, message: '无法读取 Plan：' + read.message };
    plan = read.value;
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, message: 'Plan 必须是对象' };
  }
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(plan));
  } catch (error) {
    return { ok: false, message: 'Plan 无法序列化：' + boundedDetail(error) };
  }
  const before = cloned.frontendPack && typeof cloned.frontendPack === 'object'
    ? { id: cloned.frontendPack.id, version: cloned.frontendPack.version }
    : null;
  cloned.frontendPack = { id: candidate.id, version: candidate.version };
  return {
    ok: true,
    plan: cloned,
    source,
    planFile: source === 'file' ? path.relative(REPO_ROOT, file).replace(/\\/g, '/') : null,
    overridden: Boolean(before && (before.id !== candidate.id || before.version !== candidate.version)),
    previousFrontendPack: before,
  };
}

function pickMaterializeOptions(opts) {
  const keys = [
    'facts', 'snapshotDir', 'trustedRegistryRoot', 'trustedAssetRoots',
    'baseId', 'baseVersion', 'candidateVersion', 'candidateRecipe', 'createdAt',
  ];
  const out = {};
  for (const key of keys) {
    if (opts[key] !== undefined) out[key] = opts[key];
  }
  return out;
}

function validateMaterialized(materialized) {
  if (!materialized || typeof materialized !== 'object' || materialized.ok !== true) {
    return { ok: false, message: 'materialized 必须是成功的物化结果' };
  }
  for (const field of ['attemptDir', 'candidateDir', 'overlayDir']) {
    const value = materialized[field];
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      return { ok: false, message: field + ' 必须是绝对路径' };
    }
  }
  const candidate = materialized.candidate;
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.version !== 'string') {
    return { ok: false, message: 'materialized.candidate 缺少 id/version' };
  }
  if (!isInsideOrEqual(materialized.attemptDir, materialized.candidateDir)
    || !isInsideOrEqual(materialized.attemptDir, materialized.overlayDir)) {
    return { ok: false, message: '候选目录必须位于本次 attempt 内' };
  }
  const attemptCanonical = assertCanonicalDir(materialized.attemptDir);
  if (!attemptCanonical.ok) return { ok: false, message: 'attempt 目录不是规范目录：' + (attemptCanonical.message || attemptCanonical.code) };
  for (const [name, value] of [['candidateDir', materialized.candidateDir], ['overlayDir', materialized.overlayDir]]) {
    const canonical = assertCanonicalDir(value);
    if (!canonical.ok) {
      return { ok: false, message: name + ' 不是规范目录：' + (canonical.message || canonical.code) };
    }
  }
  // 显式 overlay registry 来源：缺失时绝不回落到全局 Registry（否则会拿 Base 冒充候选）。
  if (typeof materialized.overlayRegistryRoot !== 'string' || !path.isAbsolute(materialized.overlayRegistryRoot)) {
    return { ok: false, message: 'overlayRegistryRoot 必须是绝对路径（禁止回落到全局 Registry）' };
  }
  if (path.resolve(materialized.overlayRegistryRoot) !== path.resolve(materialized.overlayDir)) {
    return { ok: false, message: 'overlayRegistryRoot 必须等于本次 overlayDir' };
  }
  const roots = materialized.assetRoots;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    return { ok: false, message: 'assetRoots 必须是非空绝对路径数组' };
  }
  return { ok: true };
}

function allocateDryRunDir(attemptDir, attemptReal) {
  const base = path.join(attemptDir, DRY_RUN_DIR);
  const ensuredBase = ensureDirectory(attemptDir, attemptReal, base);
  if (!ensuredBase.ok) return ensuredBase;
  for (let index = 1; index <= 10; index += 1) {
    const dir = path.join(base, index === 1 ? DRY_RUN_PREFIX : DRY_RUN_PREFIX + '-' + index);
    if (fs.existsSync(dir)) continue;
    const ensured = ensureDirectory(attemptDir, attemptReal, dir);
    if (!ensured.ok) return ensured;
    const canonical = assertCanonicalDir(dir);
    if (!canonical.ok) return canonical;
    return { ok: true, dir, relative: 'verification/' + path.basename(dir) };
  }
  return { ok: false, code: CODES.OUTPUT_REJECTED, message: 'dry-run 目录超过上限' };
}

function writeResultFile(dir, value) {
  const file = path.join(dir, RESULT_FILE);
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return { ok: true, file };
  } catch (error) {
    return { ok: false, message: boundedDetail(error) };
  }
}

/**
 * 执行一次候选 dry-run。
 *
 * @param {object} options
 * @param {unknown} [options.draft]            FrontendPackDraft（与 materialized 二选一）
 * @param {object} [options.materialized]      `materializeCandidate` 的成功结果（推荐，避免重复物化）
 * @param {string} [options.userDataDir]       draft 模式必填
 * @param {string} [options.projectId]         draft 模式必填
 * @param {string} [options.runId]             draft 模式必填
 * @param {object} [options.plan]              候选 CompositionPlan；缺省读 Base Recipe Plan 并覆盖 frontendPack
 * @param {string} [options.planFile]          Plan 绝对路径（仅 plan 缺省时使用）
 * @param {'development'|'production'} [options.mode]
 * @param {string} [options.projectName]       产物目录名（默认 candidate）
 * @param {number} [options.revision]          回传用的 revision（缺省=attempt）
 * @param {object} [options.requirement]       可选 P1 Requirement（只用于说明密度未测量）
 * @param {object} [options.runtimeReport]     可选微信运行报告（只读，用于“关键动作可点”）
 * @param {object} [options.signal]            取消信号
 * @param {(stage:string, detail?:object)=>void} [options.onStage]
 */
async function dryRun(options) {
  const opts = options || {};
  const emit = typeof opts.onStage === 'function' ? opts.onStage : () => {};
  const signal = opts.signal;

  if (isCancelled(signal)) {
    return failResult({ code: CODES.CANCELLED, summary: '候选 dry-run 已取消（未开始）', details: { stage: 'cancelled' } });
  }

  let materialized = opts.materialized;
  let attemptDir;
  let candidate;
  let revision = Number.isInteger(opts.revision) ? opts.revision : null;

  if (materialized === undefined) {
    if (opts.draft === undefined) {
      return failResult({ code: CODES.INPUT_INVALID, summary: '必须提供 draft 或 materialized', details: { stage: 'input' } });
    }
    emit('materialize');
    let result;
    try {
      result = materializeCandidate({
        ...pickMaterializeOptions(opts),
        userDataDir: opts.userDataDir,
        projectId: opts.projectId,
        runId: opts.runId,
        draft: opts.draft,
      });
    } catch (error) {
      return failResult({
        code: CODES.MATERIALIZE_FAILED,
        summary: '候选物化异常：' + boundedDetail(error),
        details: { stage: 'materialize' },
      });
    }
    if (!result || result.ok !== true) {
      const issues = result && result.path !== undefined ? issuesFromDraftFailure(result) : [];
      const precise = issues.length > 0 && REPAIR_ISSUE_CODES.includes(issues[0].code) ? issues[0].code : null;
      return failResult({
        code: precise || (result && result.code) || CODES.MATERIALIZE_FAILED,
        summary: '候选物化失败：' + truncate((result && (result.message || result.code)) || 'UNKNOWN', 160),
        details: {
          stage: 'materialize',
          materializeCode: result ? result.code : null,
          materializePath: result && result.path ? result.path : null,
        },
        issues,
        checks: [{ id: 'materialize', status: 'fail', message: truncate((result && result.message) || '物化失败', MAX_MESSAGE) }],
      });
    }
    materialized = result;
  } else {
    emit('materialize');
  }

  const validated = validateMaterialized(materialized);
  if (!validated.ok) {
    return failResult({ code: CODES.INPUT_INVALID, summary: '物化结果不可用：' + truncate(validated.message, 160), details: { stage: 'input' } });
  }
  attemptDir = materialized.attemptDir;
  candidate = { id: materialized.candidate.id, version: materialized.candidate.version };
  if (revision === null) revision = Number.isInteger(materialized.attempt) ? materialized.attempt : 1;

  const planResult = resolveCandidatePlan(opts.plan, opts.planFile, candidate);
  if (!planResult.ok) {
    return failResult({
      code: CODES.INPUT_INVALID,
      summary: '候选 Plan 不可用：' + truncate(planResult.message, 160),
      details: { stage: 'input' },
      candidateId: candidate.id,
      revision,
    });
  }
  const plan = planResult.plan;
  const planDetails = {
    source: planResult.source,
    planFile: planResult.planFile,
    frontendPack: plan.frontendPack,
    overridden: planResult.overridden,
  };

  let attemptReal;
  try {
    attemptReal = realpathOf(attemptDir);
  } catch (error) {
    return failResult({
      code: CODES.OUTPUT_REJECTED,
      summary: '无法解析 attempt 真实路径：' + boundedDetail(error),
      details: { stage: 'workspace' },
      candidateId: candidate.id,
      revision,
    });
  }
  const dryRunDirResult = allocateDryRunDir(attemptDir, attemptReal);
  if (!dryRunDirResult.ok) {
    return failResult({
      code: CODES.OUTPUT_REJECTED,
      summary: '无法创建私有 dry-run 目录：' + truncate(dryRunDirResult.message, 160),
      details: { stage: 'workspace' },
      candidateId: candidate.id,
      revision,
    });
  }
  const dryRunDir = dryRunDirResult.dir;
  const projectName = typeof opts.projectName === 'string' && opts.projectName.trim() !== ''
    ? opts.projectName.trim()
    : 'candidate';
  const mode = opts.mode === 'production' ? 'production' : 'development';

  emit('compose', { planSource: planResult.source });
  let composed;
  try {
    composed = await compose({
      plan,
      parentDir: dryRunDir,
      projectName,
      mode,
      registryRoot: materialized.overlayRegistryRoot,
      assetRoots: materialized.assetRoots,
      signal,
    });
  } catch (error) {
    return failResult({
      code: CODES.FAILED,
      summary: 'Composer 编排异常：' + boundedDetail(error),
      details: { stage: 'compose', plan: planDetails },
      candidateId: candidate.id,
      revision,
      artifacts: { attemptDir, verificationDir: dryRunDir },
    });
  }
  if (!composed || composed.ok !== true) {
    const issues = composed ? issuesFromComposer(composed, plan) : [];
    return failResult({
      code: repairCodeForComposer(composed && composed.code),
      summary: 'Composer 未通过：' + truncate((composed && (composed.message || composed.code)) || 'UNKNOWN', 160),
      details: {
        stage: 'compose',
        plan: planDetails,
        composerCode: composed ? composed.code : null,
        composerPath: composed && composed.path ? composed.path : null,
      },
      issues,
      checks: [{ id: 'compose', status: 'fail', message: truncate((composed && composed.message) || 'Composer 未通过', MAX_MESSAGE) }],
      candidateId: candidate.id,
      revision,
      artifacts: { attemptDir, verificationDir: dryRunDir },
    });
  }

  if (isCancelled(signal)) {
    return failResult({
      code: CODES.CANCELLED,
      summary: '候选 dry-run 在 Composer 之后被取消',
      details: { stage: 'cancelled', plan: planDetails },
      candidateId: candidate.id,
      revision,
      artifacts: { attemptDir, verificationDir: dryRunDir, outputDir: composed.outputPath },
    });
  }

  const outputDir = composed.outputPath;
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || !isInsideOrEqual(attemptDir, outputDir)) {
    return failResult({
      code: CODES.OUTPUT_REJECTED,
      summary: 'Composer 产物目录不在本次 attempt 内，拒绝继续校验',
      details: { stage: 'compose', plan: planDetails },
      candidateId: candidate.id,
      revision,
    });
  }
  const outputRelative = path.relative(attemptDir, outputDir).replace(/\\/g, '/');
  const artifacts = {
    attemptDir,
    verificationDir: dryRunDir,
    outputDir,
    outputRelativePath: outputRelative,
    evidenceFile: path.join(dryRunDir, RESULT_FILE),
    treeSha256: composed.treeSha256,
  };
  const checks = [];
  const allIssues = [];
  let firstFailedCode = null;
  let failedStage = null;

  // ---- mini:check（与 npm run mini:check 同一实现：validate-miniprogram.runChecks） ----
  emit('mini-check');
  let mini;
  try {
    mini = runChecks(outputDir);
  } catch (error) {
    mini = { ok: false, fatal: true, errors: ['mini:check 异常：' + boundedDetail(error)], warnings: [], stats: null };
  }
  if (mini && mini.ok) {
    checks.push({
      id: 'mini-check',
      status: 'pass',
      message: '小程序静态校验通过（' + (mini.stats ? mini.stats.pages : 0) + ' 页 / ' + (mini.stats ? mini.stats.components : 0) + ' 组件）',
    });
  } else {
    firstFailedCode = CODES.MINI_CHECK_FAILED;
    failedStage = 'mini-check';
    checks.push({ id: 'mini-check', status: 'fail', message: truncate((mini && mini.errors && mini.errors[0]) || 'mini:check 未通过', MAX_MESSAGE) });
    allIssues.push(...issuesFromMiniCheck((mini && mini.errors) || [], plan));
  }

  // ---- output-consistency（与桌面导出同一套只读校验） ----
  emit('consistency');
  let consistency;
  try {
    consistency = inspectOutput(outputDir, { mode });
  } catch (error) {
    consistency = { ok: false, code: 'OUTPUT_INCONSISTENT', message: '一致性检查异常：' + boundedDetail(error), problems: [] };
  }
  if (consistency && consistency.ok) {
    checks.push({ id: 'consistency', status: 'pass', message: '产物与 Lock/报告一致（' + (consistency.fileCount || 0) + ' 个文件）' });
  } else {
    if (!firstFailedCode) {
      firstFailedCode = CODES.CONSISTENCY_FAILED;
      failedStage = 'consistency';
    }
    checks.push({ id: 'consistency', status: 'fail', message: truncate((consistency && consistency.message) || '一致性检查未通过', MAX_MESSAGE) });
    allIssues.push(...issuesFromConsistency(consistency && consistency.problems, plan));
  }

  // ---- 可观察项对照（分区顺序/主题/组件/按钮/锚点/空白；密度与溢出如实标未测量） ----
  emit('observable');
  let observable;
  try {
    observable = compareObservable({
      draft: opts.draft !== undefined ? opts.draft : null,
      outputDir,
      requirement: opts.requirement,
      runtimeReport: opts.runtimeReport,
    });
  } catch (error) {
    observable = { ok: false, checks: [], issues: [], summary: '可观察项对照异常：' + boundedDetail(error) };
  }
  if (opts.draft !== undefined && observable) {
    checks.push({
      id: 'observable',
      status: observable.ok ? 'pass' : 'fail',
      message: truncate(observable.summary || '', MAX_MESSAGE),
      counts: observable.counts || null,
    });
    for (const item of (observable.checks || []).slice(0, MAX_CHECKS)) checks.push(item);
    if (!observable.ok) {
      const observableIssues = issuesFromObservable(observable);
      allIssues.push(...observableIssues);
      const anchorOnly = observableIssues.length > 0 && observableIssues.every((issue) => issue.code === 'SLOT_ANCHOR_MISSING');
      if (!firstFailedCode) {
        firstFailedCode = anchorOnly ? 'SLOT_ANCHOR_MISSING' : CODES.CONSISTENCY_FAILED;
        failedStage = 'observable';
      }
    }
  } else {
    checks.push({ id: 'observable', status: 'not_run', message: '未提供 Draft，跳过可观察项对照' });
  }

  const issues = dedupeIssues(allIssues);
  const ok = !firstFailedCode;
  const summaryParts = [
    'dry-run ' + (ok ? '通过' : '未通过'),
    'candidate=' + candidate.id + '@' + candidate.version,
    'ComposerP0-P6=' + (composed.fileCount || 0) + ' 个文件',
    'mini:check=' + (mini && mini.ok ? '通过' : '失败'),
    'consistency=' + (consistency && consistency.ok ? '通过' : '失败'),
  ];
  if (opts.draft !== undefined && observable) summaryParts.push(observable.summary || '');
  const result = {
    ok,
    code: ok ? CODES.OK : (firstFailedCode || CODES.FAILED),
    summary: truncate(summaryParts.join('；'), 300),
    details: {
      stage: ok ? 'done' : (failedStage || 'dry-run'),
      plan: planDetails,
      materialize: { attempt: materialized.attempt, candidateId: candidate.id, candidateVersion: candidate.version },
      compose: { outputRelativePath: outputRelative, treeSha256: composed.treeSha256, fileCount: composed.fileCount || 0 },
      mini: mini && mini.stats ? { pages: mini.stats.pages, components: mini.stats.components, errors: (mini.errors || []).length } : { errors: (mini && mini.errors ? mini.errors.length : 0) },
      consistency: { ok: Boolean(consistency && consistency.ok), problems: consistency && consistency.problems ? consistency.problems.length : 0 },
      observable: observable ? { ok: Boolean(observable.ok), counts: observable.counts || null } : null,
    },
    candidateId: candidate.id,
    revision,
    artifacts,
    issues,
    checks: checks.slice(0, MAX_CHECKS),
  };

  const written = writeResultFile(dryRunDir, {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: result.ok,
    code: result.code,
    summary: result.summary,
    candidateId: result.candidateId,
    candidateVersion: candidate.version,
    revision: result.revision,
    plan: planDetails,
    outputRelativePath: outputRelative,
    checks: result.checks,
    issues: result.issues,
    details: result.details,
    generatedAt: new Date().toISOString(),
  });
  if (!written.ok) {
    return failResult({
      code: CODES.FAILED,
      summary: 'dry-run 证据写入失败：' + truncate(written.message, 160),
      details: result.details,
      candidateId: candidate.id,
      revision,
      artifacts,
      issues: result.issues,
      checks: result.checks,
    });
  }
  emit('done', { ok: result.ok });
  return result;
}

module.exports = {
  CODES,
  STAGES,
  DEFAULT_PLAN_FILE,
  RESULT_SCHEMA_VERSION,
  RESULT_FILE,
  dryRun,
  // 供测试/诊断的纯函数（不写盘）
  repairCodeForComposer,
  issuesFromComposer,
  issuesFromMiniCheck,
  issuesFromConsistency,
  issuesFromObservable,
  resolveCandidatePlan,
};
