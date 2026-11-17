import { frontendError } from './errors';
import type { FrontendErrorCode } from './errors';
import { FRONTEND_LIMITS, FRONTEND_REPAIR_ISSUE_CODES, FRONTEND_STATES } from './types';
import type {
  FrontendRepairIssue,
  FrontendRepairIssueCode,
  FrontendRunState,
  FrontendState,
} from './types';

/**
 * frontend-reconstruct.v1 运行状态机与 repair 预算。
 *
 * 设计边界：
 * - 只允许单向迁移与显式重试/撤销；`rejected`、`cancelled` 是终态；
 * - `validating → generating` 只能经 `beginFrontendRepair`（结构化 issues），
 *   直接迁移被拒绝，避免绕过“最多 2 轮修复”；
 * - `failed → analyzing` 只能经 `retryFrontendRun` 且必须换新 runId，
 *   旧响应用 runId + revision 丢弃；
 * - `partial → adopted` 必须显式确认，绝不把“微信验证未完成”当验收通过。
 */

/** 修复轮次上限：契约固定 2 轮，任何配置不得放宽。 */
export const FRONTEND_MAX_REPAIR_ROUNDS = FRONTEND_LIMITS.maxRepairRounds;

/** 终态：不能离开，只能由用户显式新建 run。 */
export const FRONTEND_TERMINAL_STATES: readonly FrontendState[] = ['rejected', 'cancelled'];

/** 合法迁移表（特殊迁移仍受下方守卫约束）。 */
export const FRONTEND_STATE_TRANSITIONS: Readonly<Record<FrontendState, readonly FrontendState[]>> =
  Object.freeze({
    idle: ['analyzing'],
    analyzing: ['planning', 'rejected', 'failed', 'cancelled'],
    planning: ['awaiting-capability-confirmation', 'generating', 'rejected', 'failed', 'cancelled'],
    'awaiting-capability-confirmation': ['generating', 'rejected', 'failed', 'cancelled'],
    generating: ['validating', 'rejected', 'failed', 'cancelled'],
    validating: ['verifying-runtime', 'generating', 'failed', 'cancelled'],
    'verifying-runtime': ['ready', 'partial', 'failed', 'cancelled'],
    ready: ['adopted', 'cancelled'],
    partial: ['adopted', 'rejected', 'cancelled'],
    rejected: [],
    failed: ['analyzing', 'cancelled'],
    adopted: ['idle'],
    cancelled: [],
  });

const RUN_ID_PATTERN = /^frun-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const REPAIR_PATH_PATTERN = /^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\]){1,12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function isFrontendState(value: unknown): value is FrontendState {
  return typeof value === 'string' && (FRONTEND_STATES as readonly string[]).includes(value);
}

/** repair 工具只接受与服务端门禁同源的稳定 DSL 路径。 */
export function isFrontendRepairPath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !CONTROL_CHAR_PATTERN.test(value)
    && REPAIR_PATH_PATTERN.test(value)
  );
}

function fail(code: FrontendErrorCode, details?: Record<string, unknown>): never {
  throw frontendError(code, details);
}

export function isFrontendTerminalState(state: FrontendRunState): boolean {
  return FRONTEND_TERMINAL_STATES.includes(state.status);
}

/** 迁移表查询；不包含 repair/retry/adopt 等特殊守卫。 */
export function canTransitionFrontendState(from: FrontendState, to: FrontendState): boolean {
  const allowed = FRONTEND_STATE_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function createFrontendRunState(runId: string): FrontendRunState {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    fail('FRONTEND_REQUEST_INVALID', { path: 'runId' });
  }
  return { runId, revision: 0, status: 'idle', repairAttempts: 0, issues: [] };
}

/**
 * 只接受结构化 issue：稳定 DSL path + 固定 code。
 * 任何自由文本日志、shell 命令、堆栈都不允许进入 repair 通道。
 */
export function validateFrontendRepairIssues(raw: unknown): FrontendRepairIssue[] {
  const code: FrontendErrorCode = 'FRONTEND_REPAIR_ISSUES_INVALID';
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > FRONTEND_LIMITS.maxRepairIssues) {
    fail(code, { path: '$.issues' });
  }
  const issues: FrontendRepairIssue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const path = `$.issues[${index}]`;
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(code, { path });
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'path' && key !== 'code') fail(code, { path: `${path}.${key}` });
    }
    if (
      typeof record.path !== 'string'
      || record.path.length === 0
      || record.path.length > 200
      || CONTROL_CHAR_PATTERN.test(record.path)
      || !REPAIR_PATH_PATTERN.test(record.path)
    ) {
      fail(code, { path: `${path}.path` });
    }
    if (
      typeof record.code !== 'string'
      || !(FRONTEND_REPAIR_ISSUE_CODES as readonly string[]).includes(record.code)
    ) {
      fail(code, { path: `${path}.code` });
    }
    const dedupeKey = `${record.path}\u0000${record.code}`;
    if (seen.has(dedupeKey)) fail(code, { path });
    seen.add(dedupeKey);
    issues.push({ path: record.path, code: record.code as FrontendRepairIssueCode });
  }
  return issues;
}

/**
 * 通用合法迁移。拒绝四类“捷径”：
 * - `validating → generating`（必须走 repair）；
 * - `failed → analyzing`（必须走 retry 且换 runId）；
 * - `adopted → idle`（必须走 undo）；
 * - 任意 `→ adopted`（必须走 adopt，partial 需显式确认）。
 */
export function transitionFrontendRun(state: FrontendRunState, to: FrontendState): FrontendRunState {
  if (!isFrontendState(state.status) || !isFrontendState(to)) {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: String(state.status), to: String(to) });
  }
  if (state.status === 'validating' && to === 'generating') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to, reason: 'repair-required' });
  }
  if (state.status === 'failed' && to === 'analyzing') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to, reason: 'retry-required' });
  }
  // adopted → idle 必须经 undoAdoptedFrontend（恢复采用前版本、清零 repair 预算），
  // 不允许用通用迁移绕过撤销入口。
  if (state.status === 'adopted' && to === 'idle') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to, reason: 'undo-required' });
  }
  if (to === 'adopted') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to, reason: 'adopt-required' });
  }
  if (!canTransitionFrontendState(state.status, to)) {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to });
  }
  return {
    ...state,
    status: to,
    revision: state.revision + 1,
  };
}

/**
 * 进入下一轮修复：仅 `validating` 可调用，issues 必须是本次结构化门禁错误。
 * 第 3 次调用返回 `FRONTEND_REPAIR_LIMIT_EXCEEDED`，调用方必须把状态置 failed。
 */
export function beginFrontendRepair(
  state: FrontendRunState,
  rawIssues: unknown,
): FrontendRunState {
  if (state.status !== 'validating') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to: 'generating', reason: 'repair-state' });
  }
  const issues = validateFrontendRepairIssues(rawIssues);
  if (state.repairAttempts >= FRONTEND_MAX_REPAIR_ROUNDS) {
    fail('FRONTEND_REPAIR_LIMIT_EXCEEDED', { repairAttempts: state.repairAttempts });
  }
  return {
    ...state,
    status: 'generating',
    revision: state.revision + 1,
    repairAttempts: state.repairAttempts + 1,
    issues,
  };
}

export interface AdoptFrontendOptions {
  /** partial（微信运行时验证未完成）必须显式勾选，不能默认采用。 */
  explicitPartialConfirmation?: boolean;
}

/** 采用候选：ready 直接采用；partial 需要显式确认。 */
export function adoptFrontendCandidate(
  state: FrontendRunState,
  options: AdoptFrontendOptions = {},
): FrontendRunState {
  if (state.status === 'ready') {
    return { ...state, status: 'adopted', revision: state.revision + 1 };
  }
  if (state.status === 'partial' && options.explicitPartialConfirmation === true) {
    return { ...state, status: 'adopted', revision: state.revision + 1 };
  }
  fail('FRONTEND_STATE_TRANSITION_INVALID', {
    from: state.status,
    to: 'adopted',
    reason: state.status === 'partial' ? 'partial-confirmation-required' : 'adopt-state',
  });
}

/** 取消：终态与 adopted 不可取消；取消后不产生任何已采用变更。 */
export function cancelFrontendRun(state: FrontendRunState): FrontendRunState {
  if (isFrontendTerminalState(state) || state.status === 'adopted') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to: 'cancelled' });
  }
  return { ...state, status: 'cancelled', revision: state.revision + 1 };
}

/** 撤销已采用候选：回到 idle，repair 预算清零（版本恢复由桌面持久化层负责）。 */
export function undoAdoptedFrontend(state: FrontendRunState): FrontendRunState {
  if (state.status !== 'adopted') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to: 'idle', reason: 'undo-state' });
  }
  return {
    ...state,
    status: 'idle',
    revision: state.revision + 1,
    repairAttempts: 0,
    issues: [],
  };
}

/** failed 后显式重试：必须换新 runId（旧响应按 runId 丢弃），repair 预算清零。 */
export function retryFrontendRun(state: FrontendRunState, newRunId: string): FrontendRunState {
  if (state.status !== 'failed') {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to: 'analyzing', reason: 'retry-state' });
  }
  if (typeof newRunId !== 'string' || !RUN_ID_PATTERN.test(newRunId) || newRunId === state.runId) {
    fail('FRONTEND_STATE_TRANSITION_INVALID', { from: state.status, to: 'analyzing', reason: 'retry-run-id' });
  }
  return {
    runId: newRunId,
    revision: state.revision + 1,
    status: 'analyzing',
    repairAttempts: 0,
    issues: [],
  };
}
