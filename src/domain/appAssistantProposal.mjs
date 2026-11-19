import {
  APP_CAPABILITIES_VERSION,
  buildAppCapabilityCatalog,
  classifyFieldId,
  findAppCapabilityAction,
  findAppCapabilityField,
  validateCapabilityFieldValue,
} from './appCapabilities.mjs';
import { AGENT_DRAFT_LIMITS, normalizeBusinessHoursText } from './agentDraft.mjs';

/**
 * 桌面端对 `app-assistant.v1` 响应的再次校验（fail closed）。
 *
 * 分工：服务端只生成提案；这里负责把所有字段、操作、证据与版本重新校验一遍，
 * 通过后才交给 reducer 原子写入。模型的任何「已修改 / 无需确认」声明都不采信。
 */

export const APP_ASSISTANT_CONTRACT_VERSION = 'app-assistant.v1';

export const APP_ASSISTANT_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: 'APP_ASSISTANT_REQUEST_INVALID',
  CONTRACT_MISMATCH: 'APP_ASSISTANT_CONTRACT_MISMATCH',
  CATALOG_MISMATCH: 'APP_ASSISTANT_CATALOG_MISMATCH',
  CONTEXT_INVALID: 'APP_ASSISTANT_CONTEXT_INVALID',
  CONTEXT_STALE: 'APP_ASSISTANT_CONTEXT_STALE',
  RESPONSE_INVALID: 'APP_ASSISTANT_RESPONSE_INVALID',
  FIELD_UNKNOWN: 'APP_ASSISTANT_FIELD_UNKNOWN',
  FIELD_READ_ONLY: 'APP_ASSISTANT_FIELD_READ_ONLY',
  VALUE_INVALID: 'APP_ASSISTANT_VALUE_INVALID',
  OPERATION_DENIED: 'APP_ASSISTANT_OPERATION_DENIED',
  CONFIRMATION_REQUIRED: 'APP_ASSISTANT_CONFIRMATION_REQUIRED',
  ACTION_UNAVAILABLE: 'APP_ASSISTANT_ACTION_UNAVAILABLE',
  ATTACHMENT_PURPOSE_UNKNOWN: 'APP_ASSISTANT_ATTACHMENT_PURPOSE_UNKNOWN',
  PROPOSAL_DUPLICATE: 'APP_ASSISTANT_PROPOSAL_DUPLICATE',
});

export const APP_ASSISTANT_STATUSES = Object.freeze(['proposal', 'needs-input', 'rejected']);
export const APP_ASSISTANT_OPS = Object.freeze(['field.set', 'dish.upsert', 'dish.remove', 'action.request']);

export const APP_ASSISTANT_LIMITS = Object.freeze({
  maxReplyChars: 500,
  maxChanges: 24,
  maxQuestions: 3,
  maxActionRequests: 2,
  maxEvidenceExcerptChars: 120,
  maxOpIdChars: 64,
});

const RESPONSE_KEYS = Object.freeze([
  'contractVersion',
  'requestId',
  'runId',
  'catalogVersion',
  'contextRevision',
  'status',
  'reply',
  'proposalId',
  'changes',
  'questions',
  'actionRequests',
  'trace',
  'meta',
]);

const CHANGE_KEYS = Object.freeze([
  'opId', 'op', 'fieldId', 'value', 'evidence', 'reason', 'name', 'dishId', 'priceCents', 'description',
  'actionId', 'params', 'attachmentIds',
]);

/** 值与参数里一律不允许出现的东西（data URL / 外部 URL / 路径穿越）。 */
const FORBIDDEN_VALUE_PATTERNS = Object.freeze(['data:', 'file://', 'http://', 'https://', '../', '..\\', '\\\\']);
const FORBIDDEN_PARAM_KEYS = Object.freeze(['path', 'absolutePath', 'url', 'script', 'command', 'ipc', 'reducer', 'actionType', 'cwd']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function fail(code, message) {
  return { ok: false, code, message };
}

function includesForbiddenPattern(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return FORBIDDEN_VALUE_PATTERNS.some((pattern) => text.includes(pattern));
}

function scanValue(value, depth = 0) {
  if (depth > 4) return true;
  if (typeof value === 'string') return includesForbiddenPattern(value);
  if (Array.isArray(value)) return value.some((item) => scanValue(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).some((item) => scanValue(item, depth + 1));
  return false;
}

function normalizeEvidence(raw) {
  if (!isPlainObject(raw)) return null;
  const source = raw.source === 'image' ? 'image' : (typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 24) : '');
  const excerpt = typeof raw.excerpt === 'string' ? raw.excerpt.trim() : '';
  if (!source) return null;
  if (codePointLength(excerpt) > APP_ASSISTANT_LIMITS.maxEvidenceExcerptChars) return null;
  if (source !== 'image' && !excerpt) return null;

  const evidence = { source, excerpt };
  if (typeof raw.attachmentId === 'string' && raw.attachmentId.trim()) {
    evidence.attachmentId = raw.attachmentId.trim().slice(0, 80);
  }
  return evidence;
}

/**
 * 校验一条 change，返回 { ok, change } 或 { ok:false, code, message }。
 * 规范化后的 change 只保留契约允许的键。
 */
function validateChange(raw, context) {
  if (!isPlainObject(raw)) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '修改项必须是对象。');
  for (const key of Object.keys(raw)) {
    if (!CHANGE_KEYS.includes(key)) {
      return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, `修改项包含未知键 ${key}。`);
    }
  }
  const opId = typeof raw.opId === 'string' ? raw.opId.trim() : '';
  if (!opId || opId.length > APP_ASSISTANT_LIMITS.maxOpIdChars) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '修改项缺少合法 opId。');
  }
  if (context.opIds.has(opId)) {
    return fail(APP_ASSISTANT_ERROR_CODES.PROPOSAL_DUPLICATE, `修改项 opId 重复：${opId}。`);
  }
  context.opIds.add(opId);

  const op = raw.op;
  if (!APP_ASSISTANT_OPS.includes(op)) {
    return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `不支持的操作 ${String(op)}。`);
  }
  const evidenceExcerpt = isPlainObject(raw.evidence) && typeof raw.evidence.excerpt === 'string'
    ? raw.evidence.excerpt
    : '';
  if (includesForbiddenPattern(evidenceExcerpt)) {
    return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `修改项 ${opId} 的证据含被禁止的地址或路径。`);
  }
  const evidence = normalizeEvidence(raw.evidence);
  if (!evidence) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, `修改项 ${opId} 缺少合法 evidence。`);
  }
  if (scanValue(raw.value) || scanValue(raw.params)) {
    return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `修改项 ${opId} 含被禁止的地址或路径。`);
  }

  if (op === 'field.set') {
    const fieldId = typeof raw.fieldId === 'string' ? raw.fieldId.trim() : '';
    if (!fieldId) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'field.set 缺少 fieldId。');
    const kind = classifyFieldId(fieldId);
    if (kind === 'unknown') return fail(APP_ASSISTANT_ERROR_CODES.FIELD_UNKNOWN, `未知字段 ${fieldId}。`);
    if (kind !== 'writable') return fail(APP_ASSISTANT_ERROR_CODES.FIELD_READ_ONLY, `${fieldId} 不可写。`);
    const field = findAppCapabilityField(fieldId);
    if (!field || field.writeMode !== 'field.set') {
      return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `${fieldId} 不能用 field.set 写入。`);
    }
    const checked = validateCapabilityFieldValue(fieldId, raw.value);
    if (!checked.ok) return fail(checked.code, checked.message);
    return {
      ok: true,
      change: {
        opId,
        op,
        fieldId,
        value: checked.value,
        evidence,
        ...(typeof raw.reason === 'string' && raw.reason.trim() ? { reason: raw.reason.trim().slice(0, 120) } : {}),
      },
    };
  }

  if (op === 'dish.upsert') {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'dish.upsert 缺少菜名。');
    if (codePointLength(name) > AGENT_DRAFT_LIMITS.maxDishName) {
      return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, `菜名不能超过 ${AGENT_DRAFT_LIMITS.maxDishName} 个字。`);
    }
    const change = { opId, op, name, evidence };
    if (raw.dishId !== undefined) {
      const dishId = typeof raw.dishId === 'string' ? raw.dishId.trim() : '';
      if (!dishId) return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, 'dishId 非法。');
      if (context.state && !context.state.agentDraft.dishes.some((dish) => dish.id === dishId)) {
        return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, `菜品 ${dishId} 不存在。`);
      }
      change.dishId = dishId;
    }
    if (raw.priceCents !== undefined && raw.priceCents !== null) {
      if (!Number.isInteger(raw.priceCents)
        || raw.priceCents < AGENT_DRAFT_LIMITS.minPriceCents
        || raw.priceCents > AGENT_DRAFT_LIMITS.maxPriceCents) {
        return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, '价格必须是合法整数分（0.01–9999.99 元）。');
      }
      change.priceCents = raw.priceCents;
    } else if (raw.priceCents === null) {
      change.priceCents = null;
    }
    if (raw.description !== undefined) {
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      if (codePointLength(description) > AGENT_DRAFT_LIMITS.maxDescription) {
        return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, `描述不能超过 ${AGENT_DRAFT_LIMITS.maxDescription} 个字。`);
      }
      change.description = description;
    }
    if (typeof raw.reason === 'string' && raw.reason.trim()) change.reason = raw.reason.trim().slice(0, 120);
    return { ok: true, change };
  }

  if (op === 'dish.remove') {
    const dishId = typeof raw.dishId === 'string' ? raw.dishId.trim() : '';
    if (!dishId) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'dish.remove 缺少 dishId。');
    if (context.state && !context.state.agentDraft.dishes.some((dish) => dish.id === dishId)) {
      return fail(APP_ASSISTANT_ERROR_CODES.VALUE_INVALID, `菜品 ${dishId} 不存在。`);
    }
    return { ok: true, change: { opId, op, dishId, evidence, risk: 'confirm' } };
  }

  // action.request
  const actionId = typeof raw.actionId === 'string' ? raw.actionId.trim() : '';
  const action = findAppCapabilityAction(actionId);
  if (!action) return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `未知动作 ${actionId}。`);
  if (isPlainObject(raw.params)) {
    for (const key of Object.keys(raw.params)) {
      if (FORBIDDEN_PARAM_KEYS.includes(key)) {
        return fail(APP_ASSISTANT_ERROR_CODES.OPERATION_DENIED, `动作参数不允许包含 ${key}。`);
      }
    }
  }
  const params = isPlainObject(raw.params) ? { ...raw.params } : {};
  const attachmentIds = Array.isArray(raw.attachmentIds)
    ? raw.attachmentIds.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 80)).slice(0, 3)
    : [];
  return {
    ok: true,
    change: {
      opId,
      op,
      actionId,
      params,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      evidence,
      risk: action.risk,
    },
  };
}

/**
 * 校验完整响应。
 *
 * @param {unknown} raw 服务端/direct transport 返回的响应
 * @param {{catalogVersion?: string, contextRevision?: number, state?: object, now?: () => number}} options
 * @returns {{ok: true, proposal: object} | {ok: false, code: string, message: string}}
 */
export function validateAppAssistantResponse(raw, options = {}) {
  if (!isPlainObject(raw)) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应必须是 JSON 对象。');
  if (raw.contractVersion !== APP_ASSISTANT_CONTRACT_VERSION) {
    return fail(APP_ASSISTANT_ERROR_CODES.CONTRACT_MISMATCH, '响应契约版本不一致。');
  }
  for (const key of Object.keys(raw)) {
    if (!RESPONSE_KEYS.includes(key)) {
      return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, `响应包含未知键 ${key}。`);
    }
  }
  const catalogVersion = typeof raw.catalogVersion === 'string' ? raw.catalogVersion : '';
  if (catalogVersion !== APP_CAPABILITIES_VERSION) {
    return fail(APP_ASSISTANT_ERROR_CODES.CATALOG_MISMATCH, `能力目录版本不一致（${catalogVersion || '缺失'}）。`);
  }
  if (options.catalogVersion && catalogVersion !== options.catalogVersion) {
    return fail(APP_ASSISTANT_ERROR_CODES.CATALOG_MISMATCH, '能力目录版本与请求不一致。');
  }
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
  if (!requestId) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应缺少 requestId。');
  if (options.requestId && requestId !== options.requestId) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应 requestId 与请求不一致。');
  }
  if (!Number.isInteger(raw.contextRevision) || raw.contextRevision < 0) {
    return fail(APP_ASSISTANT_ERROR_CODES.CONTEXT_INVALID, '响应缺少合法 contextRevision。');
  }
  if (Number.isInteger(options.contextRevision) && raw.contextRevision !== options.contextRevision) {
    return fail(APP_ASSISTANT_ERROR_CODES.CONTEXT_STALE, '项目在此期间已变化，这次结果未写入，请重试。');
  }
  if (!APP_ASSISTANT_STATUSES.includes(raw.status)) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应状态不合法。');
  }
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
  if (!reply) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应缺少回复内容。');
  if (codePointLength(reply) > APP_ASSISTANT_LIMITS.maxReplyChars) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '回复超长。');
  }
  const proposalId = typeof raw.proposalId === 'string' ? raw.proposalId.trim() : '';
  if (!proposalId) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应缺少 proposalId。');
  if (!Array.isArray(raw.changes)) return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '响应缺少 changes。');
  if (raw.changes.length > APP_ASSISTANT_LIMITS.maxChanges) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '修改项超过单轮上限。');
  }
  if (!Array.isArray(raw.questions) || raw.questions.length > APP_ASSISTANT_LIMITS.maxQuestions) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '追问数量不合法。');
  }
  if (!Array.isArray(raw.actionRequests) || raw.actionRequests.length > APP_ASSISTANT_LIMITS.maxActionRequests) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '动作请求数量不合法。');
  }
  if (raw.status === 'needs-input' && raw.changes.length > 0) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'needs-input 不得附带猜测性写入。');
  }
  if (raw.status === 'rejected' && raw.changes.length > 0) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'rejected 不得附带写入。');
  }

  // 契约允许把 action.request 放在 changes 或顶层 actionRequests：
  // 两者都是操作项，共用 opId 去重与同一套校验。
  const inlineChanges = [...raw.changes];
  for (const item of raw.actionRequests) {
    if (!isPlainObject(item) || item.op !== 'action.request') {
      return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'actionRequests 只能包含 action.request。');
    }
    inlineChanges.push(item);
  }

  const changeContext = {
    opIds: new Set(),
    state: isPlainObject(options.state) ? options.state : null,
  };
  const changes = [];
  for (const item of inlineChanges) {
    const checked = validateChange(item, changeContext);
    if (!checked.ok) return checked;
    changes.push(checked.change);
  }

  const questions = raw.questions.map((item, index) => {
    if (typeof item === 'string') {
      const text = item.trim();
      if (!text) throw new Error('question empty');
      return { id: `q_${index + 1}`, text: text.slice(0, 200) };
    }
    if (!isPlainObject(item)) return null;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) return null;
    return { id: typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 40) : `q_${index + 1}`, text: text.slice(0, 200) };
  });
  if (questions.some((item) => !item)) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, '追问内容不合法。');
  }
  if (raw.status === 'needs-input' && questions.length === 0) {
    return fail(APP_ASSISTANT_ERROR_CODES.RESPONSE_INVALID, 'needs-input 必须给出具体问题。');
  }

  // 动作请求与字段修改分开装配：动作永远是独立确认单元。
  const actionRequests = changes.filter((item) => item.op === 'action.request').map((item) => ({
    opId: item.opId,
    op: item.op,
    actionId: item.actionId,
    params: item.params,
    ...(item.attachmentIds ? { attachmentIds: item.attachmentIds } : {}),
    evidence: item.evidence,
    risk: item.risk,
  }));
  const fieldChanges = changes.filter((item) => item.op !== 'action.request');

  return {
    ok: true,
    proposal: {
      contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
      requestId,
      runId: typeof raw.runId === 'string' ? raw.runId.trim().slice(0, 64) : null,
      catalogVersion,
      contextRevision: raw.contextRevision,
      status: raw.status,
      reply,
      proposalId,
      changes: fieldChanges,
      questions,
      actionRequests,
      trace: isPlainObject(raw.trace)
        ? {
          modelCalls: Number.isInteger(raw.trace.modelCalls) ? raw.trace.modelCalls : 0,
          toolCalls: Array.isArray(raw.trace.toolCalls) ? raw.trace.toolCalls.length : 0,
          stopReason: typeof raw.trace.stopReason === 'string' ? raw.trace.stopReason.slice(0, 40) : '',
          degraded: raw.trace.degraded === true,
        }
        : { modelCalls: 0, toolCalls: 0, stopReason: '', degraded: true },
    },
  };
}

/**
 * 把校验后的提案拆成「可直接应用」与「需要确认」两批。
 *
 * 规则（与 docs/app-assistant-contract.md §4 一致）：
 * - 清空已有值、dish.remove、素材引用、AppID、模板选择、候选采用、导出 → 确认；
 * - 其余明确的 field.set / dish.upsert → 可自动应用；
 * - 任何不确定性都归入确认批，绝不影响字段批的原子性。
 *
 * @param {object} proposal validateAppAssistantResponse 的 proposal
 * @param {object} state 当前桌面状态
 * @returns {{autoChanges: Array, pendingConfirmations: Array, entries: Array}}
 */
export function buildProposalApplyPlan(proposal, state) {
  const autoChanges = [];
  const pendingConfirmations = [];
  for (const change of proposal.changes) {
    const field = change.op === 'field.set' ? findAppCapabilityField(change.fieldId) : null;
    let confirm = false;
    if (change.op === 'dish.remove') confirm = true;
    if (field && field.risk === 'confirm') confirm = true;
    if (field && field.confirmWhenEmpty && typeof change.value === 'string' && !change.value.trim()) {
      confirm = true;
    }
    if (change.op === 'field.set' && change.fieldId === 'store.fulfillment') {
      const next = { ...state.agentDraft.fulfillment, ...change.value };
      if (!next.dineIn && !next.takeaway) confirm = true;
    }
    if (change.op === 'field.set' && change.fieldId === 'features.selected') {
      // 取消任一已选功能属于影响推荐范围的变更，让用户看一眼再应用更稳妥。
      const current = Array.isArray(state.features.selected) ? state.features.selected : [];
      if (current.some((id) => !change.value.includes(id))) confirm = true;
    }
    if (confirm) pendingConfirmations.push(change);
    else autoChanges.push(change);
  }
  const pendingActions = proposal.actionRequests.map((item) => ({ ...item, risk: item.risk || 'confirm' }));
  return {
    autoChanges,
    pendingConfirmations,
    pendingActions,
    entries: [...proposal.changes, ...proposal.actionRequests].map((item) => item.opId),
  };
}

/**
 * 生成「桌面实际 before/after」的变更摘要（不采信模型文案）。
 *
 * @param {object} proposal
 * @param {object} state 应用前的状态
 * @param {object} nextState 应用后的状态
 * @returns {Array<{fieldId: string, label: string, before: string, after: string}>}
 */
export function describeAppliedChanges(proposal, state, nextState) {
  const entries = [];
  for (const change of proposal.changes) {
    if (change.op === 'field.set') {
      const field = findAppCapabilityField(change.fieldId);
      entries.push({
        fieldId: change.fieldId,
        label: field ? field.label : change.fieldId,
        before: readFieldValue(state, change.fieldId),
        after: readFieldValue(nextState, change.fieldId),
      });
      continue;
    }
    if (change.op === 'dish.upsert') {
      const before = (state.agentDraft.dishes || []).find((dish) => (
        change.dishId ? dish.id === change.dishId : dish.name === change.name
      ));
      const after = (nextState.agentDraft.dishes || []).find((dish) => (
        change.dishId ? dish.id === change.dishId : dish.name === change.name
      ));
      entries.push({
        fieldId: 'store.dishes',
        label: '菜品',
        before: before ? formatDish(before) : '（新增前不存在）',
        after: after ? formatDish(after) : '（未写入）',
      });
      continue;
    }
    if (change.op === 'dish.remove') {
      const before = (state.agentDraft.dishes || []).find((dish) => dish.id === change.dishId);
      entries.push({
        fieldId: 'store.dishes',
        label: '菜品',
        before: before ? formatDish(before) : '（不存在）',
        after: '（已移除）',
      });
    }
  }
  return entries;
}

function formatDish(dish) {
  const price = Number.isInteger(dish.priceCents) ? `¥${(dish.priceCents / 100).toFixed(2)}` : '未定价';
  return `${dish.name} ${price}`;
}

/** 读取某个 fieldId 的当前可读值（用于 before/after）。 */
export function readFieldValue(state, fieldId) {
  const input = isPlainObject(state) ? state : {};
  const draft = input.agentDraft || {};
  const store = input.store || {};
  const visual = input.visual || {};
  const features = input.features || {};
  const project = input.project || {};
  switch (fieldId) {
    case 'store.name': return String(draft.storeName || store.name || '');
    case 'store.category': return String(draft.category || store.type || '');
    case 'store.businessHours': return String(draft.businessHours || '');
    case 'store.fulfillment': {
      const value = draft.fulfillment || {};
      return [value.dineIn ? '堂食' : '', value.takeaway ? '到店自取' : ''].filter(Boolean).join('、') || '未设置';
    }
    case 'store.address': return String(store.address || '');
    case 'store.phone': return String(store.phone || '');
    case 'store.notes': return String(store.notes || '');
    case 'visual.styleId': return String(visual.styleId || '');
    case 'visual.prompt': return String(visual.prompt || '');
    case 'features.selected': return (features.selected || []).join('、');
    case 'features.custom': return String(features.custom || '');
    case 'project.appid': return String(project.appid || '');
    case 'store.dishes': return (draft.dishes || []).map(formatDish).join('；');
    default: return '';
  }
}

/** 把建议的营业时间文本规范化（导出给 UI 复用）。 */
export function normalizeProposalHours(value) {
  return normalizeBusinessHoursText(value);
}