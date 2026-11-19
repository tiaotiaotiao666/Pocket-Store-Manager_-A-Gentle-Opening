import { APP_CAPABILITIES_VERSION } from '../../domain/appCapabilities.mjs';
import {
  buildProjectAgentContext,
  measureProjectContextBytes,
} from '../../domain/projectAgentContext.mjs';
import {
  APP_ASSISTANT_CONTRACT_VERSION,
} from './appAssistantConfig.js';
import { createAppAssistantError } from './appAssistantError.js';

/**
 * `app-assistant.v1` 请求的组装与本地校验。
 *
 * 只做三件事：收敛用户可见输入、挂上安全项目上下文、按契约上限 fail closed。
 * 不读 DOM、不读写业务状态，也不做任何模型侧判断。
 */

export const APP_ASSISTANT_REQUEST_LIMITS = Object.freeze({
  maxUtteranceChars: 500,
  maxHistoryMessages: 12,
  maxHistoryChars: 6000,
  maxContextBytes: 65536,
  maxAttachments: 3,
});

const HISTORY_KEYS = Object.freeze(['role', 'text']);
const ATTACHMENT_KEYS = Object.freeze([
  'id', 'kind', 'mediaType', 'dataBase64', 'previewDataUrl', 'name', 'bytes',
]);
const ATTACHMENT_PURPOSES = Object.freeze(['auto', 'menu', 'store', 'reference']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value) {
  return Array.from(value).length;
}

function invalidRequest(message) {
  return createAppAssistantError('APP_ASSISTANT_REQUEST_INVALID', { message });
}

export function createChatRequestId() {
  const stamp = Date.now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `chat_req_${stamp}${suffix}`;
}

function normalizeHistory(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidRequest('history 必须是数组。');
  if (raw.length > APP_ASSISTANT_REQUEST_LIMITS.maxHistoryMessages) {
    throw invalidRequest(`history 最多 ${APP_ASSISTANT_REQUEST_LIMITS.maxHistoryMessages} 条。`);
  }
  let totalChars = 0;
  const messages = [];
  for (const item of raw) {
    if (!isPlainObject(item)) throw invalidRequest('history 只接受 {role,text} 对象。');
    for (const key of Object.keys(item)) {
      if (!HISTORY_KEYS.includes(key)) throw invalidRequest(`history 不允许包含 ${key}。`);
    }
    const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : null);
    if (!role) throw invalidRequest('history 只接受 user / assistant。');
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) throw invalidRequest('history 正文不能为空。');
    totalChars += codePointLength(text);
    messages.push({ role, text });
  }
  if (totalChars > APP_ASSISTANT_REQUEST_LIMITS.maxHistoryChars) {
    throw invalidRequest(`history 总长度不能超过 ${APP_ASSISTANT_REQUEST_LIMITS.maxHistoryChars} 字。`);
  }
  return messages;
}

function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidRequest('attachments 必须是数组。');
  if (raw.length > APP_ASSISTANT_REQUEST_LIMITS.maxAttachments) {
    throw invalidRequest(`最多 ${APP_ASSISTANT_REQUEST_LIMITS.maxAttachments} 张图片。`);
  }
  return raw.map((item, index) => {
    if (!isPlainObject(item)) throw invalidRequest('附件必须是对象。');
    for (const key of Object.keys(item)) {
      if (!ATTACHMENT_KEYS.includes(key)) throw invalidRequest(`附件不允许包含 ${key}。`);
    }
    const kind = item.kind === undefined ? 'auto' : item.kind;
    if (!ATTACHMENT_PURPOSES.includes(kind)) throw invalidRequest(`未知附件用途 ${String(kind)}。`);
    const dataBase64 = typeof item.dataBase64 === 'string' ? item.dataBase64 : '';
    if (!dataBase64.trim()) throw invalidRequest('附件缺少图片正文。');
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `att_${index + 1}`;
    const attachment = {
      id,
      kind,
      mediaType: typeof item.mediaType === 'string' && item.mediaType.trim()
        ? item.mediaType.trim().slice(0, 40)
        : 'image/png',
      dataBase64,
      name: typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '',
      bytes: Number.isFinite(item.bytes) ? Math.max(0, Math.floor(item.bytes)) : 0,
    };
    if (typeof item.previewDataUrl === 'string' && item.previewDataUrl.startsWith('data:')) {
      attachment.previewDataUrl = item.previewDataUrl;
    }
    return attachment;
  });
}

function resolveUtterance(raw, hasAttachments) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    if (hasAttachments) return '';
    throw invalidRequest('请先输入这次要修改的内容，或附上一张图片。');
  }
  if (codePointLength(text) > APP_ASSISTANT_REQUEST_LIMITS.maxUtteranceChars) {
    throw invalidRequest(`一次最多输入 ${APP_ASSISTANT_REQUEST_LIMITS.maxUtteranceChars} 个字。`);
  }
  return text;
}

/**
 * 组请求。所有上限在这里判定，调用方不需要再做一遍。
 *
 * @param {object} params
 * @param {string} [params.utterance]
 * @param {Array} [params.history]
 * @param {Array} [params.attachments]
 * @param {object} [params.state] 桌面 reducer 状态（生成安全项目上下文）
 * @param {string} [params.phase]
 * @param {string} [params.projectId]
 * @param {number} [params.contextRevision]
 * @param {string} [params.requestId]
 * @param {object} [params.projectContext] 仅测试/复用：已生成的安全上下文
 */
export function buildAppAssistantRequest(params = {}) {
  const source = isPlainObject(params) ? params : {};
  const attachments = normalizeAttachments(source.attachments);
  const history = normalizeHistory(source.history);
  const utterance = resolveUtterance(source.utterance, attachments.length > 0);

  const state = isPlainObject(source.state) ? source.state : null;
  const project = state && isPlainObject(state.project) ? state.project : {};
  const projectContext = isPlainObject(source.projectContext)
    ? source.projectContext
    : (state ? buildProjectAgentContext(state) : null);
  if (!projectContext) {
    throw createAppAssistantError('APP_ASSISTANT_CONTEXT_INVALID', {
      message: '缺少项目上下文，本次请求未发送。',
    });
  }
  if (measureProjectContextBytes(projectContext) > APP_ASSISTANT_REQUEST_LIMITS.maxContextBytes) {
    throw createAppAssistantError('APP_ASSISTANT_CONTEXT_INVALID', {
      message: '项目上下文过大，本次请求未发送。',
    });
  }

  const contextRevision = Number.isInteger(source.contextRevision)
    ? source.contextRevision
    : (Number.isInteger(project.contentRevision) ? project.contentRevision : 0);
  const projectId = typeof source.projectId === 'string' && source.projectId.trim()
    ? source.projectId.trim().slice(0, 120)
    : (typeof project.activeId === 'string' && project.activeId.trim() ? project.activeId.trim().slice(0, 120) : null);

  const requestId = typeof source.requestId === 'string' && source.requestId.trim()
    ? source.requestId.trim().slice(0, 120)
    : createChatRequestId();

  const phase = typeof source.phase === 'string' && source.phase.trim()
    ? source.phase.trim().slice(0, 40)
    : (typeof state?.phase === 'string' && state.phase.trim() ? state.phase.trim().slice(0, 40) : 'unknown');

  return {
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
    requestId,
    catalogVersion: APP_CAPABILITIES_VERSION,
    contextRevision,
    utterance,
    history,
    client: { surface: 'desktop', phase },
    project: { projectId, context: projectContext },
    attachments,
  };
}