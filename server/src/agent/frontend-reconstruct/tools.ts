/**
 * frontend-reconstruct.v1 的四个 Agent 工具。
 *
 * 权限模型（由本地决定，不交给模型）：
 * - `get_frontend_capabilities` / `check_frontend_coverage`：只读；
 * - `propose_frontend_draft` / `repair_frontend_draft`：只写**本次 run 的内存草稿**，
 *   不触碰磁盘、Registry、Base 或模板；不需要人工审批（不是落地写操作）。
 *
 * 健壮性来自既有 runtime：参数 schema、超时、重试、并发（write 强制串行）、
 * 调用次数上限、循环检测、取消信号都由 ToolExecutor / agent-loop 统一处理。
 * 这里只负责：
 * - 所有 id 必须命中服务端注入事实（失败即结构化 tool error，含稳定 FRONTEND_* code）；
 * - coverage 由 `buildCapabilityCoverage()` 计算，模型无法写 covered；
 * - repair 只接受有界结构化 issues + 路径补丁，2 轮上限来自 state.ts。
 */

import { AgentToolError, defineTool } from '../runtime';
import type { AgentTool, AgentToolContext, JsonObject, JsonSchema, JsonValue } from '../runtime';
import {
  buildCapabilityCoverage,
  completeRequirementMustKeep,
  projectFrontendCapabilities,
} from './capabilities';
import { FrontendReconstructError, frontendError, sanitizeFrontendLogDetails } from './errors';
import { CAPABILITY_PATTERN, FRONTEND_DRAFT_ERROR_CODES } from './contract.generated';
import type { FrontendPageFactsMap } from './page-facts';
import {
  assertFrontendPlannedConsistency,
  validateFrontendPackDraftForP1,
  validateUiRequirement,
} from './schema';
import {
  beginFrontendRepair,
  createFrontendRunState,
  isFrontendRepairPath,
  transitionFrontendRun,
  validateFrontendRepairIssues,
} from './state';
import {
  FRONTEND_LIMITS,
  FRONTEND_REPAIR_ISSUE_CODES,
  FRONTEND_TARGET_PAGES,
  FRONTEND_TOOL_NAMES,
} from './types';
import type {
  CapabilityCoverageReport,
  FrontendDraftNode,
  FrontendFacts,
  FrontendPackDraft,
  FrontendRepairIssue,
  FrontendRepairIssueCode,
  FrontendRunState,
  FrontendTargetPageId,
  UiRequirement,
} from './types';

export const GET_FRONTEND_CAPABILITIES_TOOL = 'get_frontend_capabilities';
export const CHECK_FRONTEND_COVERAGE_TOOL = 'check_frontend_coverage';
export const PROPOSE_FRONTEND_DRAFT_TOOL = 'propose_frontend_draft';
export const REPAIR_FRONTEND_DRAFT_TOOL = 'repair_frontend_draft';

export const FRONTEND_RECONSTRUCT_TOOL_NAMES = FRONTEND_TOOL_NAMES;

const CAPABILITY_ID_PATTERN = CAPABILITY_PATTERN;
const MAX_PATCH_VALUE_CHARS = 2_000;
const MAX_PATCH_BYTES = 4 * 1024;
const MAX_SAFE_PROPERTY_CHARS = 200;

/** 一次 frontend-reconstruct run 的内存状态；进程内、随 run 销毁，绝不落盘。 */
export interface FrontendReconstructSession {
  readonly facts: FrontendFacts;
  readonly pageFacts: FrontendPageFactsMap;
  readonly targetPages: readonly FrontendTargetPageId[];
  runState: FrontendRunState;
  requirement: UiRequirement | null;
  coverage: CapabilityCoverageReport | null;
  draft: FrontendPackDraft | null;
  /** 最近一次 propose 失败时模型提交的原始 draft，仅用于“先失败再 repair”的 P1 流程。 */
  pendingDraft: Record<string, unknown> | null;
  proposalRevision: number;
  /**
   * 模型在最近一次 check_frontend_coverage 中显式声明为“必需”的能力 id。
   * 覆盖结论始终由服务端计算；模型可以重新提交 requirement 修正自己先前的
   * 误判（例如把普通首页误标成直播业务），但不能直接提供 covered 报告。
   */
  requestedCapabilities: string[];
  /**
   * 服务端最近一次门禁失败产生的结构化 issues。repair 只能引用这里的 path+code，
   * 不能由模型自报任意 issue（否则 repair 会退化成通用标量改写入）。
   */
  lastGateIssues: FrontendRepairIssue[];
  /** 本 run 已尝试的 repair 次数（成功/失败都计入），上限 FRONTEND_LIMITS.maxRepairRounds。 */
  repairAttempts: number;
}

export function createFrontendReconstructSession(input: {
  runId: string;
  facts: FrontendFacts;
  pageFacts: FrontendPageFactsMap;
  targetPages: readonly FrontendTargetPageId[];
}): FrontendReconstructSession {
  let state = createFrontendRunState(input.runId);
  state = transitionFrontendRun(state, 'analyzing');
  state = transitionFrontendRun(state, 'planning');
  return {
    facts: input.facts,
    pageFacts: input.pageFacts,
    targetPages: [...input.targetPages],
    runState: state,
    requirement: null,
    coverage: null,
    draft: null,
    pendingDraft: null,
    proposalRevision: 0,
    requestedCapabilities: [],
    lastGateIssues: [],
    repairAttempts: 0,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 契约错误 → 结构化 tool error（模型只看到稳定 code 与有界路径/issues）。
 * 日志只记录 code 与经 sanitizeFrontendLogDetails 白名单化后的结构化信息，
 * 不记录参数、模型原文、图片或超长未知字段名。
 */
function toToolError(
  error: unknown,
  context?: AgentToolContext,
  issues?: readonly FrontendRepairIssue[],
): never {
  if (error instanceof FrontendReconstructError) {
    const details: Record<string, unknown> = { ...(error.details ?? {}) };
    if (issues !== undefined && issues.length > 0) {
      details.issues = issues.slice(0, FRONTEND_LIMITS.maxRepairIssues);
    }
    context?.logger.log({
      event: 'frontend_tool_rejected',
      level: 'warn',
      runId: context.runId,
      requestId: context.requestId,
      step: context.step,
      code: error.code,
      ...sanitizeFrontendLogDetails(details),
    });
    throw new AgentToolError(error.code, error.message, {
      retryable: error.retryable,
      details,
    });
  }
  if (error instanceof AgentToolError) throw error;
  throw new AgentToolError('FRONTEND_INTERNAL_ERROR', '前端重构工具内部错误。');
}

/** 把一次门禁错误映射成最小结构化 issue（path 必须能用于 repair 补丁定位）。 */
function repairIssueCodeFromError(error: FrontendReconstructError, path: string): FrontendRepairIssueCode {
  if (error.code === 'FRONTEND_DRAFT_INVALID') {
    if (/\.componentId$/.test(path)) return FRONTEND_DRAFT_ERROR_CODES.component;
    if (/\.(action)$/.test(path) || /\.events\.[A-Za-z]/.test(path)) return FRONTEND_DRAFT_ERROR_CODES.event;
    if (/\.(textToken|dataPath)$/.test(path)) return FRONTEND_DRAFT_ERROR_CODES.dataPath;
    if (/\.style(\.|$)/.test(path)) return FRONTEND_DRAFT_ERROR_CODES.style;
    if (/\.pageJson(\.|$)/.test(path)) return FRONTEND_DRAFT_ERROR_CODES.pageJson;
    return FRONTEND_DRAFT_ERROR_CODES.schema;
  }
  return FRONTEND_DRAFT_ERROR_CODES.schema;
}

export function gateIssuesFromError(error: unknown): FrontendRepairIssue[] {
  if (error instanceof FrontendReconstructError) {
    const rawPath = typeof error.details?.path === 'string' && isFrontendRepairPath(error.details.path)
      ? error.details.path
      : '$.draft';
    return [{ path: rawPath, code: repairIssueCodeFromError(error, rawPath) }];
  }
  return [{ path: '$.draft', code: FRONTEND_DRAFT_ERROR_CODES.schema }];
}

function issueKey(issue: FrontendRepairIssue): string {
  return `${issue.path}\u0000${issue.code}`;
}

function readPageIdsArg(value: unknown): FrontendTargetPageId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > FRONTEND_LIMITS.maxPages) {
    throw frontendError('FRONTEND_REQUEST_INVALID', { path: '$.pageIds' });
  }
  const pageIds: FrontendTargetPageId[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(FRONTEND_TARGET_PAGES as readonly string[]).includes(item)) {
      throw frontendError('FRONTEND_TARGET_PAGES_UNSUPPORTED', { path: '$.pageIds' });
    }
    if (!pageIds.includes(item as FrontendTargetPageId)) pageIds.push(item as FrontendTargetPageId);
  }
  return pageIds;
}

function readRequestedCapabilities(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FRONTEND_LIMITS.maxRequiredCapabilities) {
    throw frontendError('FRONTEND_COVERAGE_INVALID', { path: '$.requestedCapabilities' });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CAPABILITY_ID_PATTERN.test(item)) {
      throw frontendError('FRONTEND_COVERAGE_INVALID', { path: '$.requestedCapabilities' });
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** 页集合一致性：草稿必须与 requirement.pages 一一对应（P0 契约已冻结）。 */
function assertDraftPageSet(requirement: UiRequirement, draft: FrontendPackDraft): void {
  const requirementPages = requirement.pages.map((page) => page.pageId).sort();
  const draftPages = draft.pages.map((page) => page.pageId).sort();
  if (requirementPages.length !== draftPages.length) {
    throw frontendError('FRONTEND_DRAFT_INVALID', { path: '$.pages' });
  }
  for (let index = 0; index < requirementPages.length; index += 1) {
    if (requirementPages[index] !== draftPages[index]) {
      throw frontendError('FRONTEND_DRAFT_INVALID', { path: '$.pages' });
    }
  }
}

/** repair 补丁：路径 → 标量；路径必须来自本次结构化 issues，且只能替换已有叶子。 */
export type FrontendRepairPatch = Record<string, string | number | boolean | null>;

function readRepairPatch(value: unknown, issuePaths: ReadonlySet<string>): FrontendRepairPatch {
  if (!isPlainObject(value)) {
    throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  }
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > FRONTEND_LIMITS.maxRepairIssues) {
    throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  }
  const patch: FrontendRepairPatch = {};
  for (const key of keys) {
    if (!isFrontendRepairPath(key) || !issuePaths.has(key)) {
      throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
    }
    const item = value[key];
    if (
      item === null
      || typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
      || (typeof item === 'string' && Array.from(item).length <= MAX_PATCH_VALUE_CHARS)
    ) {
      patch[key] = item;
      continue;
    }
    throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  }
  let serialized = '';
  try {
    serialized = JSON.stringify(patch);
  } catch {
    throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PATCH_BYTES) {
    throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  }
  return patch;
}

const FORBIDDEN_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

type RepairPathToken = { key: string } | { index: number };

function parseRepairPath(path: string): RepairPathToken[] {
  const tokens: RepairPathToken[] = [];
  const body = path.slice(1);
  const pattern = /\.([A-Za-z][A-Za-z0-9]*)|\[(\d{1,3})\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1] !== undefined) {
      if (match[1].length > MAX_SAFE_PROPERTY_CHARS || FORBIDDEN_PROPERTY_NAMES.has(match[1])) {
        throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
      }
      tokens.push({ key: match[1] });
    } else {
      tokens.push({ index: Number(match[2]) });
    }
  }
  if (tokens.length === 0) throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
  return tokens;
}

/**
 * 把补丁应用到草稿副本：只允许替换已存在的标量叶子，禁止新增未知字段、
 * 数组越界与原型链污染路径。
 */
export function applyFrontendRepairPatch(draft: FrontendPackDraft, patch: FrontendRepairPatch): FrontendPackDraft {
  const next = JSON.parse(JSON.stringify(draft)) as FrontendPackDraft;
  for (const [path, value] of Object.entries(patch)) {
    const tokens = parseRepairPath(path);
    let cursor: unknown = next;
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const token = tokens[index];
      if ('index' in token) {
        if (!Array.isArray(cursor) || token.index >= cursor.length) {
          throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
        }
        cursor = cursor[token.index];
        continue;
      }
      if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, token.key)) {
        throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
      }
      cursor = cursor[token.key];
    }
    const last = tokens[tokens.length - 1];
    if ('index' in last) {
      if (!Array.isArray(cursor) || last.index >= cursor.length) {
        throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
      }
      cursor[last.index] = value;
    } else {
      if (
        !isPlainObject(cursor)
        || !Object.prototype.hasOwnProperty.call(cursor, last.key)
        || isPlainObject(cursor[last.key])
        || Array.isArray(cursor[last.key])
      ) {
        throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.patch' });
      }
      cursor[last.key] = value;
    }
  }
  return next;
}

function revisionOf(session: FrontendReconstructSession): number {
  return session.runState.revision;
}

// ---------------------------------------------------------------------------
// Schemas（严格对象、有界数组；细节校验由 execute 复用契约校验器完成）
// ---------------------------------------------------------------------------

export const GET_FRONTEND_CAPABILITIES_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pageIds'],
  properties: {
    pageIds: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: ['home', 'menu'] },
      description: '要读取能力的目标页面；首期仅 home/menu。',
    },
  },
};

export const CHECK_FRONTEND_COVERAGE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requirement'],
  properties: {
    requirement: {
      type: 'object',
      description: 'UiRequirement JSON（严格按 frontend-reconstruct.v1 契约）；服务端会完整校验。',
    },
    requestedCapabilities: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', pattern: CAPABILITY_PATTERN.source },
      description:
        '模型认为必需的能力 id（page:/component:/slot:/action:/data:）。服务端据此判定缺失；不存在的能力会使覆盖结论为 rejected。',
    },
  },
};

export const PROPOSE_FRONTEND_DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['draft'],
  properties: {
    draft: {
      type: 'object',
      description: 'FrontendPackDraft JSON DSL（frontend-pack-draft.v1）；只允许 5 类受控节点。',
    },
  },
};

export const REPAIR_FRONTEND_DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['issues', 'patch'],
  properties: {
    issues: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'code'],
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            pattern: '^\\$(?:\\.[A-Za-z][A-Za-z0-9]*|\\[\\d{1,3}\\]){1,12}$',
          },
          code: { type: 'string', enum: [...FRONTEND_REPAIR_ISSUE_CODES] },
        },
      },
      description: '服务端门禁返回的结构化 issues（最多 8 条）；自由文本日志不允许。',
    },
    patch: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      description: '路径 → 新值；路径必须来自 issues，只能替换已有叶子。最多 8 条。',
    },
  },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createFrontendReconstructTools(session: FrontendReconstructSession): AgentTool[] {
  const getCapabilities = defineTool<JsonObject>({
    name: GET_FRONTEND_CAPABILITIES_TOOL,
    title: '读取前端能力',
    description:
      '只读：返回目标页真实可用的组件 props/events、插槽、控制器动作、数据路径、主题 token 与尺寸档位。生成前先调用。',
    parameters: GET_FRONTEND_CAPABILITIES_SCHEMA,
    sideEffect: 'read',
    timeoutMs: 5_000,
    retry: { maxAttempts: 2, backoffMs: 100, retryOnTimeout: true },
    execute: async (args, context) => {
      try {
        const pageIds = readPageIdsArg(args.pageIds);
        return projectFrontendCapabilities(session.facts, session.pageFacts, pageIds) as unknown as JsonValue;
      } catch (error) {
        toToolError(error, context);
      }
    },
  });

  const checkCoverage = defineTool<JsonObject>({
    name: CHECK_FRONTEND_COVERAGE_TOOL,
    title: '校验能力覆盖',
    description:
      '只读：提交 UiRequirement，由服务端按真实能力事实计算 covered/partial/rejected。模型不能自行声明 covered。',
    parameters: CHECK_FRONTEND_COVERAGE_SCHEMA,
    sideEffect: 'read',
    timeoutMs: 5_000,
    retry: { maxAttempts: 2, backoffMs: 100, retryOnTimeout: true },
    execute: async (args, context) => {
      try {
        const requirement = validateUiRequirement(args.requirement, session.facts, {
          targetPages: session.targetPages,
        });
        const completed = completeRequirementMustKeep(requirement, session.facts, session.targetPages);
        const requested = readRequestedCapabilities(args.requestedCapabilities);
        const coverage = buildCapabilityCoverage(completed, session.facts, {
          additionalRequiredCapabilities: requested,
        });

        // R-F3：已有草稿时先在与旧状态隔离的候选上做一致性检查。
        // 不一致就显式失败退出（session 保持旧的一致状态），绝不先改 requirement
        // 再让 state 卡在 validating 且旧 draft 保留，导致端点最终 502。
        let draftKept = false;
        if (session.draft !== null) {
          assertDraftPageSet(completed, session.draft);
          assertFrontendPlannedConsistency(completed, coverage, session.draft);
          draftKept = true;
        }

        // 只有候选完全一致才提交；以最近一次声明为准，覆盖结论始终由服务端计算。
        session.requestedCapabilities = requested;
        session.requirement = completed;
        session.coverage = coverage;
        return {
          status: coverage.status,
          requiredCapabilities: coverage.requiredCapabilities,
          missingCapabilities: coverage.missingCapabilities,
          coveredBy: coverage.coveredBy,
          risks: coverage.risks,
          degradations: coverage.degradations,
          requirementMustKeep: completed.mustKeep.map((item) => item.ref),
          draftKept,
        } as unknown as JsonValue;
      } catch (error) {
        toToolError(error, context);
      }
    },
  });

  const proposeDraft = defineTool<JsonObject>({
    name: PROPOSE_FRONTEND_DRAFT_TOOL,
    title: '提交前端草稿',
    description:
      'write（仅内存）：提交 FrontendPackDraft，完整校验 DSL、页面集合、mustKeep 与覆盖结论。不写磁盘、不改 Base。',
    parameters: PROPOSE_FRONTEND_DRAFT_SCHEMA,
    sideEffect: 'write',
    timeoutMs: 5_000,
    execute: async (args, context) => {
      try {
        if (session.requirement === null || session.coverage === null) {
          throw frontendError('FRONTEND_STATE_TRANSITION_INVALID', { path: '$.draft' });
        }
        if (session.coverage.status === 'rejected') {
          throw frontendError('FRONTEND_COVERAGE_REJECTED', { path: '$.draft' });
        }
        if (session.runState.status !== 'planning') {
          throw frontendError('FRONTEND_STATE_TRANSITION_INVALID', { path: '$.draft' });
        }
        let draft: FrontendPackDraft;
        try {
          draft = validateFrontendPackDraftForP1(args.draft, session.facts, session.pageFacts);
          assertDraftPageSet(session.requirement, draft);
          assertFrontendPlannedConsistency(session.requirement, session.coverage, draft);
        } catch (error) {
          // 门禁失败：记录服务端生成的 issues（含可修复的 DSL path），供 repair 绑定；
          // 同时保留原始 draft，允许 repair 在 pendingDraft 上做有界修复。
          const issues = gateIssuesFromError(error);
          session.lastGateIssues = issues;
          if (isPlainObject(args.draft)) {
            session.pendingDraft = JSON.parse(JSON.stringify(args.draft)) as Record<string, unknown>;
          }
          toToolError(error, context, issues);
        }

        session.runState = transitionFrontendRun(session.runState, 'generating');
        session.runState = transitionFrontendRun(session.runState, 'validating');
        session.draft = draft;
        session.pendingDraft = null;
        session.lastGateIssues = [];
        session.proposalRevision += 1;

        return {
          ok: true,
          code: 'FRONTEND_DRAFT_ACCEPTED',
          summary: '草稿已通过服务端 DSL 校验、页面集合与 mustKeep/覆盖交叉校验。',
          candidateId: `frontend-draft-${session.proposalRevision}`,
          revision: revisionOf(session),
          details: {
            pageIds: draft.pages.map((page) => page.pageId),
            coverageStatus: session.coverage.status,
            assertions: collectDraftAssertionCounts(draft),
          },
        } as unknown as JsonValue;
      } catch (error) {
        toToolError(error, context);
      }
    },
  });

  const repairDraft = defineTool<JsonObject>({
    name: REPAIR_FRONTEND_DRAFT_TOOL,
    title: '修复前端草稿',
    description:
      'write（仅内存）：只接受服务端结构化 issues（path+code）与路径补丁；最多 2 轮。不能改 Base、Registry 或任意源码。',
    parameters: REPAIR_FRONTEND_DRAFT_SCHEMA,
    sideEffect: 'write',
    timeoutMs: 5_000,
    execute: async (args, context) => {
      try {
        if (session.requirement === null || session.coverage === null) {
          throw frontendError('FRONTEND_STATE_TRANSITION_INVALID', { path: '$.issues' });
        }
        const issues: FrontendRepairIssue[] = validateFrontendRepairIssues(args.issues);
        if (session.lastGateIssues.length === 0) {
          // R-F6：没有服务端门禁失败记录时，repair 不能被模型当通用标量改写入使用。
          throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.issues' });
        }
        const allowedIssues = new Set(session.lastGateIssues.map(issueKey));
        for (const issue of issues) {
          if (!allowedIssues.has(issueKey(issue))) {
            throw frontendError('FRONTEND_REPAIR_ISSUES_INVALID', { path: '$.issues' });
          }
        }
        const issuePaths = new Set(issues.map((issue) => issue.path));
        const patch = readRepairPatch(args.patch, issuePaths);
        if (session.repairAttempts >= FRONTEND_LIMITS.maxRepairRounds) {
          throw frontendError('FRONTEND_REPAIR_LIMIT_EXCEEDED', { path: '$.issues' });
        }

        const hasAcceptedDraft = session.draft !== null;
        const targetDraft = hasAcceptedDraft ? session.draft : session.pendingDraft;
        if (targetDraft === null) {
          throw frontendError('FRONTEND_STATE_TRANSITION_INVALID', { path: '$.issues' });
        }
        session.repairAttempts += 1;

        if (hasAcceptedDraft) {
          // 已接受草稿的修复：状态守卫与 2 轮上限仍由 state.ts 执行。
          session.runState = beginFrontendRepair(session.runState, issues);
          try {
            const repaired = applyFrontendRepairPatch(session.draft as FrontendPackDraft, patch);
            const draft = validateFrontendPackDraftForP1(repaired, session.facts, session.pageFacts);
            assertDraftPageSet(session.requirement, draft);
            if (session.coverage.status === 'rejected') {
              throw frontendError('FRONTEND_COVERAGE_REJECTED', { path: '$.draft' });
            }
            assertFrontendPlannedConsistency(session.requirement, session.coverage, draft);
            session.draft = draft;
          } catch (error) {
            // 门禁仍失败：回到 validating 允许最后一次修复，并绑定新的门禁 issues。
            session.runState = transitionFrontendRun(session.runState, 'validating');
            session.lastGateIssues = gateIssuesFromError(error);
            toToolError(error, context, session.lastGateIssues);
          }
          session.runState = transitionFrontendRun(session.runState, 'validating');
        } else {
          // propose 失败后的 pending draft：状态仍是 planning，修复成功后重新进入 validating。
          if (session.runState.status !== 'planning') {
            throw frontendError('FRONTEND_STATE_TRANSITION_INVALID', { path: '$.issues' });
          }
          try {
            const repaired = applyFrontendRepairPatch(
              targetDraft as unknown as FrontendPackDraft,
              patch,
            );
            const draft = validateFrontendPackDraftForP1(repaired, session.facts, session.pageFacts);
            assertDraftPageSet(session.requirement, draft);
            if (session.coverage.status === 'rejected') {
              throw frontendError('FRONTEND_COVERAGE_REJECTED', { path: '$.draft' });
            }
            assertFrontendPlannedConsistency(session.requirement, session.coverage, draft);
            session.draft = draft;
          } catch (error) {
            // 保留已打补丁的 pending draft（若可序列化），并绑定新的门禁 issues。
            if (isPlainObject(targetDraft)) {
              session.pendingDraft = JSON.parse(JSON.stringify(targetDraft)) as Record<string, unknown>;
            }
            session.lastGateIssues = gateIssuesFromError(error);
            toToolError(error, context, session.lastGateIssues);
          }
          session.runState = transitionFrontendRun(session.runState, 'generating');
          session.runState = transitionFrontendRun(session.runState, 'validating');
        }

        session.pendingDraft = null;
        session.lastGateIssues = [];
        session.proposalRevision += 1;
        return {
          ok: true,
          code: 'FRONTEND_DRAFT_REPAIRED',
          summary: '结构化 issues 已应用，草稿重新通过服务端门禁。',
          revision: revisionOf(session),
          details: {
            repairAttempts: session.repairAttempts,
            repairsLeft: Math.max(0, FRONTEND_LIMITS.maxRepairRounds - session.repairAttempts),
            pageIds: (session.draft as FrontendPackDraft).pages.map((page) => page.pageId),
          },
        } as unknown as JsonValue;
      } catch (error) {
        toToolError(error, context);
      }
    },
  });

  return [getCapabilities, checkCoverage, proposeDraft, repairDraft];
}

function collectDraftAssertionCounts(draft: FrontendPackDraft): JsonValue {
  const counts: Record<string, number> = { component: 0, slot: 0, container: 0, text: 0, button: 0 };
  const walk = (nodes: readonly FrontendDraftNode[]): void => {
    for (const node of nodes) {
      counts[node.type] += 1;
      if (node.type === 'container') walk(node.children);
    }
  };
  for (const page of draft.pages) walk(page.nodes);
  return counts as unknown as JsonValue;
}
