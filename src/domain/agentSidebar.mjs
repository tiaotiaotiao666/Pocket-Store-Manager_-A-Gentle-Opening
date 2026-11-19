import { PHASES } from '../state/constants.mjs';

/**
 * 项目级 Agent 会话（桌面项目页右侧栏「Agent 对话」视图）的纯函数领域层。
 *
 * 设计约束（与任务契约一致）：
 * - 纯函数：不 import React / service / fetch / fs，不读写 localStorage / 全局变量；
 * - 消息只保存「用户看得懂的一句话 + 最小时序上下文」，不保存草稿副本、图片 base64、
 *   Plan / trace / 服务端原始响应等大对象；
 * - 数量上限与单条字数上限只有这一份实现：状态层（sessionMachine）、快照持久化（T2）、
 *   侧栏组件（T3）与 App 接线（T4）都复用这里的 `normalizeChatMessages` /
 *   `CHAT_MESSAGE_LIMIT` / `CHAT_MESSAGE_MAX_CHARS`，不另写第二套裁剪逻辑；
 * - 文案如实：阶段路由只说明「本轮会做什么、不会做什么」，不暗示「任何话都能改任意内容」，
 *   也不假装存在统一的意图识别能力。
 */

/** 侧栏会话的运行态（与 reducer 里的分支一一对应）。 */
export const CHAT_STATUS = Object.freeze({
  IDLE: 'idle',
  REQUESTING: 'requesting',
  FAILED: 'failed',
});

/** 消息角色。`system` 用于本地指引与系统提示，不参与模型请求。 */
export const CHAT_ROLES = Object.freeze(['user', 'assistant', 'system']);

/** 消息状态：只区分「这一条是否已经落地」，请求在途由会话 status 表达。 */
export const CHAT_MESSAGE_STATUSES = Object.freeze(['done', 'failed']);

/**
 * 消息动作类型：这条消息对应的动作口径。
 *
 * - `store-info`：补充/修改门店资料（复用 handleAgentTurn）；
 * - `template-revise`：修改当前模板展示（复用 handleTemplateReviseSubmit）；
 * - `frontend-reconstruct`：图片驱动前端重构（侧栏只给摘要与跳转入口）；
 * - `guide`：本地指引，不调用模型。
 */
export const CHAT_ACTION_KINDS = Object.freeze(['store-info', 'template-revise', 'frontend-reconstruct', 'guide']);

/** 会话消息条数上限（保留最新）。 */
export const CHAT_MESSAGE_LIMIT = 100;

/** 单条消息正文上限（字符）。 */
export const CHAT_MESSAGE_MAX_CHARS = 5000;

/** 侧栏输入框单次可发送的字数上限（空白与超限都不可发送）。 */
export const CHAT_DRAFT_MAX_CHARS = 500;

/** 错误提示正文上限：只留一句话，不留服务端原始响应。 */
export const CHAT_ERROR_MESSAGE_MAX_CHARS = 300;

/** 过程卡允许展示的工具标签数量与单条长度上限（只留标签，不留参数与结果）。 */
export const CHAT_RUN_TOOL_LIMIT = 12;
export const CHAT_RUN_TOOL_LABEL_MAX_CHARS = 40;

const ID_MAX_CHARS = 120;
const PHASE_MAX_CHARS = 40;
const SESSION_ID_MAX_CHARS = 80;
const CREATED_AT_MAX_CHARS = 40;
const ROLE_MAX_CHARS = 16;
const ERROR_CODE_MAX_CHARS = 64;
const RUN_ID_MAX_CHARS = 64;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 去掉首尾空白并截断；非字符串一律视为空。 */
function trimText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (positiveInteger(maxChars, 0) > 0 && trimmed.length > maxChars) return trimmed.slice(0, maxChars);
  return trimmed;
}

/** 按字符上限截断，并且不把代理对（emoji 等）劈成两半。 */
function truncateText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const limit = positiveInteger(maxChars, CHAT_MESSAGE_MAX_CHARS);
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return head.slice(0, -1);
  return head;
}

/** FNV-1a 32 位摘要，用于给「没有 id 的历史消息」生成确定且幂等的 id。 */
function hashText(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 空会话工厂（侧栏会话的初始值，也是 reducer 与快照恢复的归一目标）。
 *
 * `requestDraftRevision` / `requestPhase` 是在途请求被冻结的另外两个身份位：
 * 与 `activeProjectId` / `activeRequestId` 一起构成四元组，任一不匹配即拒收迟到响应。
 *
 * @returns {{messages: Array, draft: string, status: string, activeRequestId: string|null,
 *   activeProjectId: string|null, lastUtterance: string, lastError: object|null,
 *   lastRun: object|null, revision: number, requestDraftRevision: number|null,
 *   requestPhase: string|null}}
 */
export function createEmptyAgentChat() {
  return {
    messages: [],
    draft: '',
    status: CHAT_STATUS.IDLE,
    activeRequestId: null,
    activeProjectId: null,
    lastUtterance: '',
    lastError: null,
    lastRun: null,
    revision: 0,
    requestDraftRevision: null,
    requestPhase: null,
  };
}

/** 冻结请求身份用的用户消息 id：同一个 requestId 只对应一条用户消息（重试不重复追加）。 */
export function chatUserMessageId(requestId) {
  const id = trimText(requestId, ID_MAX_CHARS);
  return id ? `chat-user-${id}` : '';
}

/** 冻结请求身份用的助手消息 id：迟到/重复的成功回调只会落到同一条消息上。 */
export function chatAssistantMessageId(requestId) {
  const id = trimText(requestId, ID_MAX_CHARS);
  return id ? `chat-assistant-${id}` : '';
}

/**
 * 消息上下文只允许「当时的阶段 + 会话 id」两个标量。
 *
 * 其余字段（草稿快照、图片、Plan、trace…）在这里被丢弃，保证快照体积可控、不含大对象。
 */
export function normalizeChatContext(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    phase: trimText(source.phase, PHASE_MAX_CHARS) || null,
    sessionId: trimText(source.sessionId, SESSION_ID_MAX_CHARS) || null,
  };
}

/** 消息 id：合法的用原值（截断），非法/缺失则按内容生成稳定 id，保证规范化幂等。 */
function normalizeMessageId(rawId, seed, index) {
  const given = trimText(rawId, ID_MAX_CHARS);
  if (given) return given;
  const prefix = Number.isSafeInteger(index) && index >= 0 ? `${index}-` : '';
  return `chat-${prefix}${hashText(seed)}`.slice(0, ID_MAX_CHARS);
}

/**
 * 规范化单条消息；不合法（非法 role/status/actionKind、非字符串或空正文）返回 `null`。
 *
 * @param {object} raw 任意来源的消息
 * @param {{maxChars?: number, index?: number}} options 单条字数上限与序号（序号只用于生成稳定 id）
 */
export function normalizeChatMessage(raw, options = {}) {
  if (!isPlainObject(raw)) return null;
  const maxChars = positiveInteger(options.maxChars, CHAT_MESSAGE_MAX_CHARS);
  const role = trimText(raw.role, ROLE_MAX_CHARS);
  if (!CHAT_ROLES.includes(role)) return null;
  const status = trimText(raw.status, ROLE_MAX_CHARS);
  if (!CHAT_MESSAGE_STATUSES.includes(status)) return null;
  const actionKind = trimText(raw.actionKind, ROLE_MAX_CHARS * 2);
  if (!CHAT_ACTION_KINDS.includes(actionKind)) return null;
  if (typeof raw.text !== 'string') return null;
  const text = truncateText(raw.text, maxChars);
  if (!text) return null;
  const createdAt = trimText(raw.createdAt, CREATED_AT_MAX_CHARS) || null;
  const id = normalizeMessageId(
    raw.id,
    [role, status, actionKind, createdAt ?? '', text].join('\u0000'),
    options.index,
  );
  return {
    id,
    role,
    text,
    createdAt,
    status,
    actionKind,
    context: normalizeChatContext(raw.context),
  };
}

/**
 * 规范化整份消息列表：过滤非法项、截断超长正文、只保留最新 `limit` 条。
 *
 * 输出确定且幂等——`normalizeChatMessages(normalizeChatMessages(x))` 与
 * `normalizeChatMessages(x)` 深度相等（id 在第一遍就已确定，第二遍原样保留）。
 *
 * @param {Array} list 任意来源的消息列表
 * @param {{limit?: number, maxChars?: number}} options 条数上限与单条字数上限
 * @returns {Array<object>} 规范化后的新数组
 */
export function normalizeChatMessages(list, options = {}) {
  if (!Array.isArray(list)) return [];
  const limit = positiveInteger(options.limit, CHAT_MESSAGE_LIMIT);
  const maxChars = positiveInteger(options.maxChars, CHAT_MESSAGE_MAX_CHARS);
  const normalized = [];
  for (let index = 0; index < list.length; index += 1) {
    const message = normalizeChatMessage(list[index], { maxChars, index });
    if (message) normalized.push(message);
  }
  return normalized.length > limit ? normalized.slice(normalized.length - limit) : normalized;
}

/**
 * 构造一条消息（先补默认值再走规范化；不合法的输入返回 `null`）。
 *
 * @param {object} input 消息内容
 * @param {{maxChars?: number}} options 单条字数上限
 */
export function createChatMessage(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  return normalizeChatMessage({
    id: source.id,
    role: source.role,
    text: source.text,
    createdAt: source.createdAt,
    // 落地即完成；失败写回由调用方显式传 `status: 'failed'`。
    status: source.status ?? 'done',
    // 缺省按「本地指引」记账，调用方应显式传真实动作类型。
    actionKind: source.actionKind ?? 'guide',
    context: source.context,
  }, options);
}

/**
 * 追加一条消息：同 id 不重复追加（天然避免 React StrictMode 双调用或重试导致重复气泡）。
 *
 * @param {Array} messages 现有消息
 * @param {object} message 待追加消息
 * @param {{limit?: number, maxChars?: number}} options 上限（缺省复用会话口径）
 * @returns {Array<object>} 追加后的新数组（未追加时返回规范化后的原列表）
 */
export function appendChatMessage(messages, message, options = {}) {
  const limit = positiveInteger(options.limit, CHAT_MESSAGE_LIMIT);
  const maxChars = positiveInteger(options.maxChars, CHAT_MESSAGE_MAX_CHARS);
  const current = normalizeChatMessages(messages, { limit, maxChars });
  const normalized = normalizeChatMessage(message, { maxChars, index: current.length });
  if (!normalized) return current;
  if (current.some((item) => item.id === normalized.id)) return current;
  return normalizeChatMessages([...current, normalized], { limit, maxChars });
}

/**
 * 输入框草稿是否可发送：非空且不超过字数上限。
 *
 * 空白与超限都不发；上限只有这一份，UI 与 App 复用同一判断，避免两套规则打架。
 */
export function isValidChatDraft(text, options = {}) {
  const maxChars = positiveInteger(options.maxChars, CHAT_DRAFT_MAX_CHARS);
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.length <= maxChars;
}

/**
 * 阶段 → 动作的显式路由表（唯一口径）。
 *
 * 只有这两个阶段会真正调用模型；其余阶段一律是本地指引，不假装「什么都能改」。
 */
const PHASE_ROUTES = Object.freeze({
  [PHASES.STORE_INFO]: Object.freeze({
    actionKind: 'store-info',
    label: '补充/修改门店资料',
    notice: '本轮将补充/修改门店资料：模型会整理这句话并写入门店草稿。',
  }),
  [PHASES.TEMPLATE_PICK]: Object.freeze({
    actionKind: 'template-revise',
    label: '修改当前模板展示',
    notice: '本轮将修改当前模板展示：只改展示内容，不动门店资料与价格。',
  }),
});

const GUIDE_ROUTE = Object.freeze({
  actionKind: 'guide',
  label: '本地指引',
  notice: '本轮不调用模型，仅给出入口指引，不会修改项目内容。',
});

const NO_PROJECT_ROUTE = Object.freeze({
  actionKind: 'guide',
  label: '先打开项目',
  notice: '还没有打开项目：先在左侧打开或新建一个项目，再在右侧对话。',
});

/**
 * 侧栏提交的纯函数口径：按当前阶段显式路由，回答「能不能发、这轮做什么」。
 *
 * @param {{projectId?: string|null, phase?: string|null, hasProject?: boolean}} input
 * @returns {{allowed: boolean, actionKind: string, label: string, notice: string}}
 */
export function buildAgentChatSubmitPlan(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const hasProject = typeof source.hasProject === 'boolean' ? source.hasProject : Boolean(trimText(source.projectId, ID_MAX_CHARS));
  if (!hasProject) return { allowed: false, ...NO_PROJECT_ROUTE };
  const route = PHASE_ROUTES[source.phase] ?? GUIDE_ROUTE;
  return { allowed: true, actionKind: route.actionKind, label: route.label, notice: route.notice };
}

/**
 * 迟到响应是否属于当前挂起请求（请求防串的唯一判断）。
 *
 * 四元组 `projectId + requestId + draftRevision + phase` 全部匹配才接受；
 * 任一不匹配（包括空值）即拒收——切换项目、重置、删除项目后的旧响应都走这条路。
 *
 * @param {{chat: object, projectId?: string|null, requestId?: string|null,
 *   draftRevision?: number|null, phase?: string|null}} input
 * @returns {boolean}
 */
export function isChatResponseAcceptable(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const chat = isPlainObject(source.chat) ? source.chat : null;
  if (!chat) return false;
  if (chat.status !== CHAT_STATUS.REQUESTING) return false;

  const activeProjectId = trimText(chat.activeProjectId, ID_MAX_CHARS);
  const projectId = trimText(source.projectId, ID_MAX_CHARS);
  if (!activeProjectId || !projectId || activeProjectId !== projectId) return false;

  const activeRequestId = trimText(chat.activeRequestId, ID_MAX_CHARS);
  const requestId = trimText(source.requestId, ID_MAX_CHARS);
  if (!activeRequestId || !requestId || activeRequestId !== requestId) return false;

  const frozenRevision = Number.isInteger(chat.requestDraftRevision) ? chat.requestDraftRevision : null;
  if (frozenRevision === null) return false;
  if (!Number.isInteger(source.draftRevision) || source.draftRevision !== frozenRevision) return false;

  const frozenPhase = trimText(chat.requestPhase, PHASE_MAX_CHARS);
  const phase = trimText(source.phase, PHASE_MAX_CHARS);
  if (!frozenPhase || !phase || frozenPhase !== phase) return false;

  return true;
}

/**
 * 把任意错误收敛成可展示的一句提示。
 *
 * 只留 code / message / retryable，丢弃服务端原始响应、堆栈与请求头等敏感内容。
 */
export function normalizeChatError(error) {
  const source = isPlainObject(error) ? error : {};
  return {
    code: trimText(source.code, ERROR_CODE_MAX_CHARS) || 'AGENT_CHAT_FAILED',
    message: truncateText(
      typeof source.message === 'string' && source.message.trim() ? source.message : '请求失败，请重试。',
      CHAT_ERROR_MESSAGE_MAX_CHARS,
    ),
    retryable: source.retryable !== false,
  };
}

/** 过程卡里的一步：只有工具标签与状态，不含工具参数、结果或原始 trace。 */
function normalizeChatRunTools(tools) {
  if (!Array.isArray(tools)) return [];
  const labels = [];
  for (const tool of tools) {
    const label = trimText(isPlainObject(tool) ? tool.label ?? tool.name : tool, CHAT_RUN_TOOL_LABEL_MAX_CHARS);
    if (!label) continue;
    labels.push(label);
    if (labels.length >= CHAT_RUN_TOOL_LIMIT) break;
  }
  return labels;
}

const CHAT_RUN_STATUSES = Object.freeze(['done', 'partial', 'failed']);

/**
 * 过程卡的安全视图：只保留状态、耗时与工具标签。
 *
 * 传入的 `trace` / `prompt` / `runId` 明细不会被复制，`runId` 只做标识用途且截断。
 *
 * @param {object|null} raw 任意来源的运行信息
 * @returns {{requestId: string|null, actionKind: string|null, status: string, durationMs: number,
 *   toolLabels: Array<string>, degraded: boolean, note: string|null, runId: string|null}|null}
 */
export function normalizeChatRun(raw) {
  if (!isPlainObject(raw)) return null;
  const status = trimText(raw.status, 16);
  const durationMs = Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.min(600000, Math.round(raw.durationMs)) : 0;
  const actionKind = trimText(raw.actionKind, ROLE_MAX_CHARS * 2);
  return {
    requestId: trimText(raw.requestId, ID_MAX_CHARS) || null,
    actionKind: CHAT_ACTION_KINDS.includes(actionKind) ? actionKind : null,
    status: CHAT_RUN_STATUSES.includes(status) ? status : 'done',
    durationMs,
    toolLabels: normalizeChatRunTools(raw.tools ?? raw.toolLabels),
    degraded: raw.degraded === true,
    note: truncateText(typeof raw.note === 'string' ? raw.note : '', CHAT_ERROR_MESSAGE_MAX_CHARS) || null,
    runId: trimText(raw.runId, RUN_ID_MAX_CHARS) || null,
  };
}
