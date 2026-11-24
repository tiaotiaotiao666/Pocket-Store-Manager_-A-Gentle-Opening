'use strict';

/**
 * B1 冻结常量（单一事实源）。
 *
 * 数值与命名来自 `docs/handoff/Workspace-Agent-B阶段接口冻结.md` §1.4/§1.6/§1.7：
 * 这里只是把文档落到代码，测试逐项断言；改上限必须同时改冻结文档并由 Captain 出 rev。
 */

const {
  AGENT_CODES,
  ATTEMPT_DIR_PATTERN,
  STAGING_PATTERN,
  RUN_ID_PATTERN,
  normalizeAgentRelativePath,
} = require('./paths.cjs');
/** B1 统一错误码（AGENT_*）。共享路径码来自 paths.cjs 的 AGENT_CODES profile。 */
const CODES = Object.freeze({
  ...AGENT_CODES,
  ID_INVALID: 'AGENT_ID_INVALID',
  WORKSPACE_NOT_FOUND: 'AGENT_WORKSPACE_NOT_FOUND',
  WORKSPACE_INVALID: 'AGENT_WORKSPACE_INVALID',
  FILE_NOT_FOUND: 'AGENT_FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'AGENT_FILE_TOO_LARGE',
  FILE_COUNT_EXCEEDED: 'AGENT_FILE_COUNT_EXCEEDED',
  TREE_TOO_LARGE: 'AGENT_TREE_TOO_LARGE',
  DEPTH_EXCEEDED: 'AGENT_DEPTH_EXCEEDED',
  BASE_DIGEST_MISMATCH: 'AGENT_BASE_DIGEST_MISMATCH',
  TXN_ABORTED: 'AGENT_TXN_ABORTED',
  ARGUMENT_INVALID: 'AGENT_ARGUMENT_INVALID',
  BATCH_TOO_LARGE: 'AGENT_BATCH_TOO_LARGE',
  PATCH_REJECTED: 'AGENT_PATCH_REJECTED',
  BINARY_FILE: 'AGENT_BINARY_FILE',
  // B2（冻结 §2.2）：版本模型的 8 个允许码，不得私增。
  VERSION_NOT_FOUND: 'AGENT_VERSION_NOT_FOUND',
  VERSION_CONFLICT: 'AGENT_VERSION_CONFLICT',
  VERSION_IMMUTABLE: 'AGENT_VERSION_IMMUTABLE',
  UNDO_UNAVAILABLE: 'AGENT_UNDO_UNAVAILABLE',
  REDO_UNAVAILABLE: 'AGENT_REDO_UNAVAILABLE',
  ADOPTION_FAILED: 'AGENT_ADOPTION_FAILED',
  MIGRATION_FAILED: 'AGENT_MIGRATION_FAILED',
  EXPORT_IDENTITY_MISMATCH: 'AGENT_EXPORT_IDENTITY_MISMATCH',
});

/** 冻结上限（§1.4）。 */
const LIMITS = Object.freeze({
  maxFiles: 4000,
  maxFileBytes: 1024 * 1024,
  maxTreeBytes: 64 * 1024 * 1024,
  maxDepth: 24,
  readDefaultBytes: 64 * 1024,
  readMaxBytes: 256 * 1024,
  readMaxLines: 4000,
  maxSearchResults: 50,
  batchMaxFiles: 32,
  batchMaxBytes: 2 * 1024 * 1024,
  diffMaxFiles: 64,
  diffMaxBytes: 512 * 1024,
  maxPathLength: 240,
});

/** 元数据上限（B1 自身边界：只存摘要与相对引用）。 */
const METADATA_MAX_BYTES = 64 * 1024;
const METADATA_MAX_STRING = 8192;

const SCHEMAS = Object.freeze({
  workspace: 'agent-workspace.v1',
  run: 'agent-run.v1',
  turn: 'agent-turn.v1',
  attempt: 'agent-attempt.v1',
  manifest: 'agent-workspace-manifest.v1',
  // B2（冻结 §2.1/§2.3）
  version: 'agent-version.v1',
  diff: 'agent-diff.v1',
  migration: 'agent-migration.v1',
});

const LAYOUT = Object.freeze({
  workspaceDir: 'agent-workspace',
  projectFile: 'project.json',
  versionsDir: 'versions',
  runsDir: 'runs',
  runFile: 'run.json',
  turnsDir: 'turns',
  turnFile: 'turn.json',
  attemptsDir: 'attempts',
  attemptFile: 'attempt.json',
  candidateDir: 'candidate',
  verificationDir: 'verification',
  sourceDir: 'source',
  versionFile: 'version.json',
  diffDir: 'diff',
  diffSummaryFile: 'summary.json',
  evidenceDir: 'evidence',
  migrationFile: 'migration.json',
});

/**
 * 模式来源（单一事实源约定，避免第二份契约常量）：
 * - `RUN_ID_PATTERN` **不在这里声明**：它来自 `desktop/frontend-reconstruct/contract.generated.cjs`
 *   （经 `paths.cjs` 重导出同一对象），与 `test/frontend-contract.test.cjs` 的单一源断言同源。
 * - `TURN_ID_PATTERN` / `VERSION_ID_PATTERN` / `TRANSACTION_ID_PATTERN` 是 **agent 域自有**模式：
 *   冻结文档 §1.3（turnId 未给正则，rev3 §1.10 采纳本实现）、§2.1（versionId = v<正整数>）
 *   与 B1 内部事务 id 格式；frontend 契约里没有同义常量，故保留于本文件并在此注明来源。
 * - `ATTEMPT_ID_PATTERN` 直接复用旧候选链同一条 `ATTEMPT_DIR_PATTERN`（冻结 §1.3 attempt-<n>）。
 */
const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const ATTEMPT_ID_PATTERN = ATTEMPT_DIR_PATTERN;
const VERSION_ID_PATTERN = /^v[1-9][0-9]{0,5}$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}$/;

/** 工作树来源：Base 真源（唯一模板真源，见 AGENTS.md）。 */
const BASE_TEMPLATE_ID = 'ordering-base';
const BASE_TEMPLATE_VERSION = '1.0.0';
const BASE_SOURCE_RELATIVE = ['templates', 'base', BASE_TEMPLATE_ID, BASE_TEMPLATE_VERSION, 'src'];

/**
 * 合并上限覆盖值（测试与 B1 参数化用）。只允许已知键、正整数；未知键 fail closed，
 * 避免调用方用“顺手多传一个键”悄悄放宽边界。
 */
function resolveLimits(overrides) {
  const merged = { ...LIMITS };
  if (overrides === undefined || overrides === null) return { ok: true, limits: merged };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, code: CODES.ARGUMENT_INVALID, path: 'limits', message: 'limits 必须是对象' };
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) {
      return { ok: false, code: CODES.ARGUMENT_INVALID, path: 'limits', message: '未知上限：' + key };
    }
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, code: CODES.ARGUMENT_INVALID, path: 'limits', message: '上限必须是正整数：' + key };
    }
    merged[key] = value;
  }
  return { ok: true, limits: merged };
}

/**
 * Agent 路径规范化（唯一实现，见 paths.normalizeAgentRelativePath）。
 * `options.limits` 只允许覆盖已知上限键。
 */
function normalizeRelativePath(relative, options) {
  const opts = options || {};
  const limitsResult = resolveLimits(opts.limits);
  if (!limitsResult.ok) return limitsResult;
  return normalizeAgentRelativePath(relative, limitsResult.limits);
}

module.exports = {
  CODES,
  LIMITS,
  resolveLimits,
  normalizeRelativePath,
  METADATA_MAX_BYTES,
  METADATA_MAX_STRING,
  SCHEMAS,
  LAYOUT,
  RUN_ID_PATTERN,
  TURN_ID_PATTERN,
  ATTEMPT_ID_PATTERN,
  VERSION_ID_PATTERN,
  TRANSACTION_ID_PATTERN,
  STAGING_PATTERN,
  BASE_TEMPLATE_ID,
  BASE_TEMPLATE_VERSION,
  BASE_SOURCE_RELATIVE,
};
