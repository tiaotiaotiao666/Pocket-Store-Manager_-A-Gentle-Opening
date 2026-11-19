/**
 * `app-assistant.v1` 契约类型与常量。
 *
 * 契约事实源：`contracts/app-assistant.v1.json` 与 `docs/app-assistant-contract.md`。
 * 能力事实源：只读快照 `capabilities.snapshot.json`（由 scripts/app-capabilities.cjs 生成）。
 *
 * 边界：服务端只生成提案（proposal / needs-input / rejected），
 * 绝不返回 `applied`——最终写入只发生在桌面 reducer。
 */

import type { JsonValue } from '../runtime';

export const APP_ASSISTANT_CONTRACT_VERSION = 'app-assistant.v1';
export const APP_ASSISTANT_CATALOG_VERSION = 'app-capabilities.v1';
export const APP_ASSISTANT_SNAPSHOT_VERSION = 'app-capabilities-snapshot.v1';
export const APP_ASSISTANT_ENDPOINT = '/api/v1/agent/app-assistant';

/** 请求头名（express 中按小写读取）。 */
export const APP_ASSISTANT_REQUEST_ID_HEADER = 'x-agent-request-id';
export const APP_ASSISTANT_CONTRACT_HEADER = 'x-agent-contract';

export const APP_ASSISTANT_STATUSES = ['proposal', 'needs-input', 'rejected'] as const;
export type AppAssistantStatus = (typeof APP_ASSISTANT_STATUSES)[number];

export const APP_ASSISTANT_OPERATIONS = ['field.set', 'dish.upsert', 'dish.remove', 'action.request'] as const;
export type AppAssistantOperationName = (typeof APP_ASSISTANT_OPERATIONS)[number];

export const APP_ASSISTANT_EVIDENCE_SOURCES = ['utterance', 'attachment', 'context'] as const;
export type AppAssistantEvidenceSource = (typeof APP_ASSISTANT_EVIDENCE_SOURCES)[number];

export const APP_ASSISTANT_ATTACHMENT_PURPOSES = ['auto', 'menu', 'store', 'reference'] as const;
export type AppAssistantAttachmentPurpose = (typeof APP_ASSISTANT_ATTACHMENT_PURPOSES)[number];

export const APP_ASSISTANT_STOP_REASONS = [
  'final_answer',
  'empty_reply',
  'max_model_calls',
  'max_tool_calls',
  'loop_detected',
  'time_limit',
  'aborted',
] as const;

export const APP_ASSISTANT_TOOL_NAMES = Object.freeze([
  'get_project_capabilities',
  'get_project_context',
  'propose_project_changes',
  'request_business_action',
  'ask_follow_up',
] as const);
export type AppAssistantToolName = (typeof APP_ASSISTANT_TOOL_NAMES)[number];

/** 与契约 `limits` 对齐；运行期上限同时受 env 配置约束（取较小值）。 */
export const APP_ASSISTANT_LIMITS = Object.freeze({
  maxModelCalls: 6,
  maxToolCalls: 12,
  maxWallClockMs: 60_000,
  maxReplyChars: 500,
  maxChanges: 24,
  maxQuestions: 3,
  maxActionRequests: 2,
  maxEvidenceExcerptChars: 120,
  maxUtteranceChars: 500,
  maxHistoryMessages: 12,
  maxHistoryChars: 6_000,
  maxHistoryMessageChars: 2_000,
  maxAttachments: 3,
  maxProjectContextBytes: 65_536,
});

export const APP_ASSISTANT_SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
export const APP_ASSISTANT_ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const APP_ASSISTANT_PROPOSAL_ID_PATTERN = /^proposal_[A-Za-z0-9._:-]{1,80}$/;

// ---------------------------------------------------------------------------
// 能力快照
// ---------------------------------------------------------------------------

export type CatalogLimits = Readonly<Record<string, unknown>>;

export interface CatalogField {
  fieldId: string;
  label: string;
  type: string;
  writeMode: string;
  writable: boolean;
  risk: 'auto' | 'confirm' | string;
  confirmWhenEmpty?: boolean;
  limits?: CatalogLimits;
  options?: readonly string[];
  required?: readonly string[];
  ops?: readonly string[];
  actions?: readonly string[];
  writeback?: Readonly<Record<string, string>>;
  note?: string;
}

export interface CatalogAction {
  actionId: string;
  label: string;
  risk: 'auto' | 'confirm' | string;
  params?: Readonly<Record<string, string>>;
}

export interface AppCapabilityCatalog {
  catalogVersion: string;
  fields: readonly CatalogField[];
  actions: readonly CatalogAction[];
  attachmentPurposes: readonly string[];
  deniedFieldIdPrefixes: readonly string[];
  readOnlyFieldIds: readonly string[];
  riskPolicy: string;
}

export interface CapabilitySnapshot {
  contractVersion: string;
  catalogVersion: string;
  digest: string;
  catalog: AppCapabilityCatalog;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

export interface AppAssistantHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AppAssistantClient {
  surface: 'desktop';
  phase: string;
}

/** 校验通过后的附件：只保留服务端亲自解码的字节数，不信任客户端 bytes。 */
export interface ValidatedAppAttachment {
  id: string;
  kind: AppAssistantAttachmentPurpose;
  mediaType: string;
  /** 纯 base64（不含 data: 前缀）；只用于本次模型调用，不落盘、不进日志。 */
  data: string;
  bytes: number;
}

export type ProjectAgentContext = Record<string, unknown>;

export interface ParsedAppAssistantRequest {
  contractVersion: typeof APP_ASSISTANT_CONTRACT_VERSION;
  requestId: string;
  catalogVersion: typeof APP_ASSISTANT_CATALOG_VERSION;
  contextRevision: number;
  utterance: string;
  history: AppAssistantHistoryMessage[];
  client: AppAssistantClient;
  projectId: string;
  context: ProjectAgentContext;
  attachments: ValidatedAppAttachment[];
}

// ---------------------------------------------------------------------------
// 提案
// ---------------------------------------------------------------------------

export interface AppAssistantEvidence {
  source: AppAssistantEvidenceSource;
  excerpt?: string;
  attachmentId?: string;
}

export interface FieldSetChange {
  opId: string;
  op: 'field.set';
  fieldId: string;
  value: JsonValue;
  evidence: AppAssistantEvidence;
  reason?: string;
}

export interface DishUpsertChange {
  opId: string;
  op: 'dish.upsert';
  name: string;
  dishId?: string;
  priceCents?: number | null;
  description?: string;
  evidence: AppAssistantEvidence;
  reason?: string;
}

export interface DishRemoveChange {
  opId: string;
  op: 'dish.remove';
  dishId: string;
  evidence: AppAssistantEvidence;
  reason?: string;
}

export type AppAssistantChange = FieldSetChange | DishUpsertChange | DishRemoveChange;

export interface AppAssistantActionRequest {
  opId: string;
  op: 'action.request';
  actionId: string;
  params?: Record<string, string>;
  attachmentIds?: string[];
  evidence: AppAssistantEvidence;
  reason?: string;
}

export interface AppAssistantQuestion {
  id: string;
  text: string;
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/** 契约只允许 name/ok/latencyMs：不含参数、结果、错误正文。 */
export interface AppAssistantToolTrace {
  name: string;
  ok: boolean;
  latencyMs: number;
}

export interface AppAssistantTrace {
  modelCalls: number;
  toolCalls: AppAssistantToolTrace[];
  stopReason: string;
  degraded: boolean;
}

export interface AppAssistantMeta {
  transport: 'http';
  provider: 'deepseek';
  mock: false;
  model: string;
  latencyMs: number;
  runId: string;
}

export interface AppAssistantResponse {
  contractVersion: typeof APP_ASSISTANT_CONTRACT_VERSION;
  requestId: string;
  runId: string;
  catalogVersion: typeof APP_ASSISTANT_CATALOG_VERSION;
  contextRevision: number;
  status: AppAssistantStatus;
  reply: string;
  proposalId: string;
  changes: AppAssistantChange[];
  questions: AppAssistantQuestion[];
  actionRequests: AppAssistantActionRequest[];
  trace: AppAssistantTrace;
  meta: AppAssistantMeta;
}