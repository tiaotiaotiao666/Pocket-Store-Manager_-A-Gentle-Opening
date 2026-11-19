/**
 * `app-assistant.v1` 请求/提案/响应的运行时校验（纯函数）。
 *
 * 统一规则：
 * - 顶层与嵌套协议对象严格未知键拒绝；
 * - `project.context` 只接受安全项目快照的形状，超限/含 base64/路径/未知字段即拒绝；
 * - 模型只能产生目录内的字段与动作；值类型、选项、长度、价格全部 fail closed；
 * - 错误消息只带结构路径与固定中文文案，不回填 base64、完整正文或密钥。
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AGENT_IMAGE_BASE64_PATTERN,
  AGENT_IMAGE_LIMITS,
  AGENT_IMAGE_MEDIA_TYPES,
} from '../agent-image.validator';
import type { JsonValue } from '../runtime';
import {

  catalogLimitNumber,
  catalogLimitString,
  findCatalogAction,
  findCatalogField,
} from './capabilities';
import {
  APP_ASSISTANT_ATTACHMENT_ID_PATTERN,
  APP_ASSISTANT_ATTACHMENT_PURPOSES,
  APP_ASSISTANT_CATALOG_VERSION,
  APP_ASSISTANT_CONTRACT_VERSION,
  APP_ASSISTANT_EVIDENCE_SOURCES,
  APP_ASSISTANT_LIMITS,
  APP_ASSISTANT_PROPOSAL_ID_PATTERN,
  APP_ASSISTANT_SAFE_ID_PATTERN,
  APP_ASSISTANT_STATUSES,
  APP_ASSISTANT_STOP_REASONS,
  APP_ASSISTANT_TOOL_NAMES,
} from './types';
import type {
  AppAssistantActionRequest,
  AppAssistantChange,
  AppAssistantEvidence,
  AppAssistantEvidenceSource,
  AppAssistantHistoryMessage,
  AppAssistantQuestion,

  CatalogField,
  ParsedAppAssistantRequest,
  ProjectAgentContext,
  ValidatedAppAttachment,
} from './types';

const REQUEST_ALLOWED_KEYS = [
  'contractVersion',
  'requestId',
  'catalogVersion',
  'contextRevision',
  'utterance',
  'history',
  'client',
  'project',
  'attachments',
] as const;

const RESPONSE_ALLOWED_KEYS = [
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
] as const;

const CLIENT_ALLOWED_KEYS = ['surface', 'phase'] as const;
const PROJECT_ALLOWED_KEYS = ['projectId', 'context'] as const;
const HISTORY_ALLOWED_KEYS = ['role', 'text'] as const;
const ATTACHMENT_ALLOWED_KEYS = [
  'id',
  'kind',
  'mediaType',
  'dataBase64',
  'name',
  'bytes',
  'previewDataUrl',
] as const;
const EVIDENCE_ALLOWED_KEYS = ['source', 'excerpt', 'attachmentId'] as const;
const QUESTION_ALLOWED_KEYS = ['id', 'text'] as const;
const TRACE_ALLOWED_KEYS = ['modelCalls', 'toolCalls', 'stopReason', 'degraded'] as const;
const TOOL_TRACE_ALLOWED_KEYS = ['name', 'ok', 'latencyMs'] as const;
const META_ALLOWED_KEYS = ['transport', 'provider', 'mock', 'model', 'latencyMs', 'runId'] as const;

const CONTEXT_ALLOWED_KEYS = [
  'contextVersion',
  'capabilitiesVersion',
  'projectId',
  'contentRevision',
  'phase',
  'fields',
  'validation',
  'build',
  'assets',
  'screenRef',
  'frontendCandidate',
  'deploy',
] as const;

const VALIDATION_ALLOWED_KEYS = ['missingFields', 'errors', 'readyForReview', 'nextQuestion'] as const;
const MISSING_FIELD_KEYS = ['field', 'label'] as const;
const FIELD_ERROR_KEYS = ['field', 'code', 'message'] as const;
const NEXT_QUESTION_KEYS = ['field', 'label', 'text'] as const;
const BUILD_ALLOWED_KEYS = ['candidates', 'selectedId'] as const;
const CANDIDATE_KEYS = ['id', 'name', 'layout', 'score'] as const;
const ASSETS_ALLOWED_KEYS = ['images'] as const;
const ASSET_IMAGE_KEYS = ['assetId', 'fileName', 'mime', 'width', 'height', 'source'] as const;
const SCREEN_REF_ALLOWED_KEYS = ['status', 'hasImage', 'adopted'] as const;
const FRONTEND_CANDIDATE_KEYS = ['status', 'adopted', 'templateId'] as const;
const DEPLOY_ALLOWED_KEYS = ['status', 'appidFilled', 'preflightReady'] as const;

const DISH_KEYS = ['id', 'name', 'priceCents', 'description'] as const;
const FULFILLMENT_KEYS = ['dineIn', 'takeaway'] as const;

const CLIENT_PHASE_PATTERN = /^[A-Za-z0-9._:-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,48}$/;
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{1,60}$/;
const ACTION_ID_PATTERN = /^[a-z][A-Za-z0-9._-]{1,64}$/;
const QUESTION_ID_PATTERN = /^q_[A-Za-z0-9_-]{1,20}$/;
const QUESTION_FIELD_PATTERN = /^[A-Za-z0-9._[\]-]{1,60}$/;
const DEFAULT_APPID_PATTERN = '^wx[0-9a-fA-F]{16}$';
const HOURS_SEGMENT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const FORBIDDEN_VALUE_PATTERNS = ['data:', 'file://', 'http://', 'https://', '../', '..\\', '\\\\'];
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/var\/|\/tmp\/)/;

const DENIED_ACTION_IDS = new Set(['dispatch', 'ipc.invoke', 'fs.write', 'shell.run', 'reducer.raw']);

export interface ValidationFailure {
  ok: false;
  code: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | ValidationFailure;

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(code: string, message: string): ValidationResult<T> {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countChars(text: string): number {
  return Array.from(text).length;
}

function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text);
}

function reject(code: string, message: string): never {
  throw new HttpException({ code, message }, HttpStatus.BAD_REQUEST);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reject(code, `${label}包含未知字段。`);
  }
}

function firstHeader(value: unknown): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && single.trim() ? single.trim() : undefined;
}

function containsForbiddenValue(value: string): boolean {
  if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => value.includes(pattern))) return true;
  return ABSOLUTE_PATH_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 请求解析
// ---------------------------------------------------------------------------

export interface AppAssistantRequestHeaders {
  agentRequestId?: unknown;
  agentContract?: unknown;
}

export function parseAppAssistantRequest(
  raw: unknown,
  headers: AppAssistantRequestHeaders = {},
): ParsedAppAssistantRequest {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', '请求体必须是 JSON 对象。');
  }
  if (raw.contractVersion !== APP_ASSISTANT_CONTRACT_VERSION) {
    reject('APP_ASSISTANT_CONTRACT_MISMATCH', `contractVersion 必须为 ${APP_ASSISTANT_CONTRACT_VERSION}。`);
  }
  assertAllowedKeys(raw, REQUEST_ALLOWED_KEYS, 'APP_ASSISTANT_REQUEST_INVALID', '请求体');

  const headerContract = firstHeader(headers.agentContract);
  if (headerContract !== undefined && headerContract !== APP_ASSISTANT_CONTRACT_VERSION) {
    reject('APP_ASSISTANT_CONTRACT_MISMATCH', `请求头 X-Agent-Contract 必须为 ${APP_ASSISTANT_CONTRACT_VERSION}。`);
  }

  const requestId = raw.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'requestId 必须是 1–120 个安全字符。');
  }
  const headerRequestId = firstHeader(headers.agentRequestId);
  if (headerRequestId !== undefined) {
    if (!REQUEST_ID_PATTERN.test(headerRequestId)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', '请求头 X-Agent-Request-Id 格式非法。');
    }
    if (headerRequestId !== requestId) {
      reject('APP_ASSISTANT_REQUEST_INVALID', 'requestId 与请求头 X-Agent-Request-Id 不一致。');
    }
  }

  if (raw.catalogVersion !== APP_ASSISTANT_CATALOG_VERSION) {
    reject(
      'APP_ASSISTANT_CATALOG_MISMATCH',
      `catalogVersion 必须为 ${APP_ASSISTANT_CATALOG_VERSION}。`,
    );
  }

  const contextRevision = raw.contextRevision;
  if (
    typeof contextRevision !== 'number' ||
    !Number.isInteger(contextRevision) ||
    contextRevision < 0 ||
    contextRevision > 1_000_000
  ) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'contextRevision 必须是非负整数。');
  }

  const client = parseClient(raw.client);
  const history = parseHistory(raw.history);
  const attachments = parseAttachments(raw.attachments);
  const utterance = parseUtterance(raw.utterance);

  if (!utterance && attachments.length === 0) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'utterance 不能为空；只有附件时允许为空。');
  }

  const project = parseProject(raw.project, contextRevision);

  return {
    contractVersion: APP_ASSISTANT_CONTRACT_VERSION,
    requestId,
    catalogVersion: APP_ASSISTANT_CATALOG_VERSION,
    contextRevision,
    utterance,
    history,
    client,
    projectId: project.projectId,
    context: project.context,
    attachments,
  };
}

function parseClient(raw: unknown): { surface: 'desktop'; phase: string } {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'client 必须是对象。');
  }
  assertAllowedKeys(raw, CLIENT_ALLOWED_KEYS, 'APP_ASSISTANT_REQUEST_INVALID', 'client');
  if (raw.surface !== 'desktop') {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'client.surface 目前只支持 desktop。');
  }
  if (typeof raw.phase !== 'string' || !CLIENT_PHASE_PATTERN.test(raw.phase)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'client.phase 必须是 1–40 个安全字符。');
  }
  return { surface: 'desktop', phase: raw.phase };
}

function parseUtterance(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'utterance 必须是字符串。');
  }
  const utterance = raw.trim();
  if (countChars(utterance) > APP_ASSISTANT_LIMITS.maxUtteranceChars) {
    reject(
      'APP_ASSISTANT_REQUEST_INVALID',
      `utterance 不能超过 ${APP_ASSISTANT_LIMITS.maxUtteranceChars} 字。`,
    );
  }
  if (hasControlChars(utterance)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'utterance 包含不可见控制字符。');
  }
  return utterance;
}

function parseHistory(raw: unknown): AppAssistantHistoryMessage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'history 必须是数组。');
  }
  if (raw.length > APP_ASSISTANT_LIMITS.maxHistoryMessages) {
    reject(
      'APP_ASSISTANT_REQUEST_INVALID',
      `history 最多 ${APP_ASSISTANT_LIMITS.maxHistoryMessages} 条。`,
    );
  }
  let total = 0;
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', `history[${index}] 必须是对象。`);
    }
    assertAllowedKeys(item, HISTORY_ALLOWED_KEYS, 'APP_ASSISTANT_REQUEST_INVALID', `history[${index}]`);
    if (item.role !== 'user' && item.role !== 'assistant') {
      reject('APP_ASSISTANT_REQUEST_INVALID', `history[${index}].role 必须是 user 或 assistant。`);
    }
    if (typeof item.text !== 'string') {
      reject('APP_ASSISTANT_REQUEST_INVALID', `history[${index}].text 必须是字符串。`);
    }
    const text = item.text.trim();
    const chars = countChars(text);
    if (chars < 1 || chars > APP_ASSISTANT_LIMITS.maxHistoryMessageChars) {
      reject(
        'APP_ASSISTANT_REQUEST_INVALID',
        `history[${index}].text 长度必须在 1–${APP_ASSISTANT_LIMITS.maxHistoryMessageChars} 字之间。`,
      );
    }
    if (hasControlChars(text)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', `history[${index}].text 包含不可见控制字符。`);
    }
    total += chars;
    if (total > APP_ASSISTANT_LIMITS.maxHistoryChars) {
      reject(
        'APP_ASSISTANT_REQUEST_INVALID',
        `history 总长度不能超过 ${APP_ASSISTANT_LIMITS.maxHistoryChars} 字。`,
      );
    }
    return { role: item.role, text };
  });
}

function parseAttachments(raw: unknown): ValidatedAppAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'attachments 必须是数组。');
  }
  if (raw.length > APP_ASSISTANT_LIMITS.maxAttachments) {
    reject(
      'APP_ASSISTANT_REQUEST_INVALID',
      `附件最多 ${APP_ASSISTANT_LIMITS.maxAttachments} 张。`,
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}] 必须是对象。`);
    }
    assertAllowedKeys(item, ATTACHMENT_ALLOWED_KEYS, 'APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}]`);

    if (typeof item.id !== 'string' || !APP_ASSISTANT_ATTACHMENT_ID_PATTERN.test(item.id)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}].id 格式非法。`);
    }
    if (seen.has(item.id)) {
      reject('APP_ASSISTANT_REQUEST_INVALID', '附件 id 不能重复。');
    }
    seen.add(item.id);

    if (
      typeof item.kind !== 'string' ||
      !(APP_ASSISTANT_ATTACHMENT_PURPOSES as readonly string[]).includes(item.kind)
    ) {
      reject(
        'APP_ASSISTANT_REQUEST_INVALID',
        `attachments[${index}].kind 必须是 ${APP_ASSISTANT_ATTACHMENT_PURPOSES.join('/')}。`,
      );
    }

    if (
      typeof item.mediaType !== 'string' ||
      !AGENT_IMAGE_MEDIA_TYPES.includes(item.mediaType)
    ) {
      reject('APP_ASSISTANT_REQUEST_INVALID', '仅支持 JPEG、PNG、WebP 图片。');
    }

    const data = item.dataBase64;
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length % 4 !== 0 ||
      !AGENT_IMAGE_BASE64_PATTERN.test(data)
    ) {
      reject('APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}].dataBase64 不是合法 base64。`);
    }

    const bytes = Buffer.byteLength(Buffer.from(data, 'base64'));
    if (bytes === 0 || bytes > AGENT_IMAGE_LIMITS.maxImageBytes) {
      reject('APP_ASSISTANT_REQUEST_INVALID', '单张图片超过 400 KiB 或内容为空。');
    }
    totalBytes += bytes;
    if (totalBytes > AGENT_IMAGE_LIMITS.maxTotalBytes) {
      reject('APP_ASSISTANT_REQUEST_INVALID', '图片合计超过 1 MiB。');
    }

    if (item.name !== undefined) {
      if (typeof item.name !== 'string' || countChars(item.name) > 80 || hasControlChars(item.name)) {
        reject('APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}].name 非法。`);
      }
    }

    if (item.previewDataUrl !== undefined) {
      // 预览只供桌面展示；服务端不保存、不回传，但仍要求是受支持的图片 data URL。
      if (
        typeof item.previewDataUrl !== 'string' ||
        !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.previewDataUrl) ||
        item.previewDataUrl.length > 800_000
      ) {
        reject('APP_ASSISTANT_REQUEST_INVALID', `attachments[${index}].previewDataUrl 非法。`);
      }
    }

    return {
      id: item.id,
      kind: item.kind as ValidatedAppAttachment['kind'],
      mediaType: item.mediaType,
      data,
      bytes,
    };
  });
}

function parseProject(
  raw: unknown,
  contextRevision: number,
): { projectId: string; context: ProjectAgentContext } {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'project 必须是对象。');
  }
  assertAllowedKeys(raw, PROJECT_ALLOWED_KEYS, 'APP_ASSISTANT_REQUEST_INVALID', 'project');
  if (typeof raw.projectId !== 'string' || !APP_ASSISTANT_SAFE_ID_PATTERN.test(raw.projectId)) {
    reject('APP_ASSISTANT_REQUEST_INVALID', 'project.projectId 必须是 1–120 个安全字符。');
  }
  const projectId = raw.projectId;
  const context = validateProjectContext(raw.context, { contextRevision, projectId });
  return { projectId, context };
}

// ---------------------------------------------------------------------------
// 项目上下文（只读安全快照）
// ---------------------------------------------------------------------------

export function validateProjectContext(
  raw: unknown,
  expected: { contextRevision: number; projectId: string },
): ProjectAgentContext {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context 必须是对象。');
  }
  assertAllowedKeys(raw, CONTEXT_ALLOWED_KEYS, 'APP_ASSISTANT_CONTEXT_INVALID', 'project.context');

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context 不是合法 JSON。');
  }
  if (bytes > APP_ASSISTANT_LIMITS.maxProjectContextBytes) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context 超过大小上限。');
  }

  if (
    raw.capabilitiesVersion !== undefined &&
    raw.capabilitiesVersion !== APP_ASSISTANT_CATALOG_VERSION
  ) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.capabilitiesVersion 与能力目录不一致。');
  }
  if (raw.contextVersion !== undefined && !isShortText(raw.contextVersion, 60)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.contextVersion 非法。');
  }
  if (raw.projectId !== undefined && raw.projectId !== expected.projectId) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.projectId 与 project.projectId 不一致。');
  }
  if (raw.contentRevision !== undefined && raw.contentRevision !== expected.contextRevision) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.contentRevision 与 contextRevision 不一致。');
  }
  if (raw.phase !== undefined && raw.phase !== null && !isShortText(raw.phase, 40)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.phase 非法。');
  }
  if (raw.fields !== undefined) validateContextFields(raw.fields);
  if (raw.validation !== undefined) validateContextValidation(raw.validation);
  if (raw.build !== undefined) validateContextBuild(raw.build);
  if (raw.assets !== undefined) validateContextAssets(raw.assets);
  if (raw.screenRef !== undefined) {
    assertContextSection(raw.screenRef, SCREEN_REF_ALLOWED_KEYS, 'screenRef');
    if (raw.screenRef.status !== undefined && !isShortText(raw.screenRef.status, 24)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.screenRef.status 非法。');
    }
    if (raw.screenRef.hasImage !== undefined && typeof raw.screenRef.hasImage !== 'boolean') {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.screenRef.hasImage 必须是布尔值。');
    }
    if (raw.screenRef.adopted !== undefined && typeof raw.screenRef.adopted !== 'boolean') {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.screenRef.adopted 必须是布尔值。');
    }
  }
  if (raw.frontendCandidate !== undefined) {
    assertContextSection(raw.frontendCandidate, FRONTEND_CANDIDATE_KEYS, 'frontendCandidate');
    if (
      raw.frontendCandidate.status !== undefined &&
      !isShortText(raw.frontendCandidate.status, 24)
    ) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.frontendCandidate.status 非法。');
    }
    if (
      raw.frontendCandidate.adopted !== undefined &&
      typeof raw.frontendCandidate.adopted !== 'boolean'
    ) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.frontendCandidate.adopted 必须是布尔值。');
    }
    if (
      raw.frontendCandidate.templateId !== undefined &&
      raw.frontendCandidate.templateId !== null &&
      !isShortText(raw.frontendCandidate.templateId, 40)
    ) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.frontendCandidate.templateId 非法。');
    }
  }
  if (raw.deploy !== undefined) {
    assertContextSection(raw.deploy, DEPLOY_ALLOWED_KEYS, 'deploy');
    for (const key of ['appidFilled', 'preflightReady'] as const) {
      if (raw.deploy[key] !== undefined && typeof raw.deploy[key] !== 'boolean') {
        reject('APP_ASSISTANT_CONTEXT_INVALID', `project.context.deploy.${key} 必须是布尔值。`);
      }
    }
    if (raw.deploy.status !== undefined && !isShortText(raw.deploy.status, 24)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.deploy.status 非法。');
    }
  }

  scanContextSafety(raw);
  return raw;
}

function isShortText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && countChars(value) <= maxChars && !hasControlChars(value);
}

function assertContextSection(
  raw: unknown,
  allowed: readonly string[],
  label: string,
): asserts raw is Record<string, unknown> {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', `project.context.${label} 必须是对象。`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', `project.context.${label} 包含未知字段。`);
    }
  }
}

function validateContextFields(raw: unknown): void {
  if (!isPlainObject(raw)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.fields 必须是对象。');
  }
  for (const [fieldId, value] of Object.entries(raw)) {
    const field = findCatalogField(fieldId);
    if (!field) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.fields 包含能力目录之外的字段。');
    }
    if (!isValidContextValue(field, value)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.fields 的值与字段类型不一致。');
    }
  }
}

function isValidContextValue(field: CatalogField, value: unknown): boolean {
  switch (field.type) {
    case 'string':
    case 'hours':
    case 'enum':
    case 'appid':
    case 'assetId':
      return (
        value === null
          ? field.type === 'assetId'
          : typeof value === 'string' &&
            countChars(value) <= 2_200 &&
            !hasControlChars(value)
      );
    case 'fulfillment': {
      if (!isPlainObject(value)) return false;
      const keys = Object.keys(value);
      if (keys.length !== FULFILLMENT_KEYS.length) return false;
      return FULFILLMENT_KEYS.every((key) => typeof value[key] === 'boolean');
    }
    case 'dish.list': {
      if (!Array.isArray(value) || value.length > 8) return false;
      return value.every((dish) => {
        if (!isPlainObject(dish)) return false;
        return Object.keys(dish).every((key) => (DISH_KEYS as readonly string[]).includes(key));
      });
    }
    case 'featureId.list':
      return (
        Array.isArray(value) &&
        value.length <= 24 &&
        value.every((item) => typeof item === 'string' && countChars(item) <= 60)
      );
    case 'assetId.list':
      return (
        Array.isArray(value) &&
        value.length <= 6 &&
        value.every((item) => typeof item === 'string' && countChars(item) <= 80)
      );
    default:
      return false;
  }
}

function validateContextValidation(raw: unknown): void {
  assertContextSection(raw, VALIDATION_ALLOWED_KEYS, 'validation');
  if (raw.missingFields !== undefined) {
    if (!Array.isArray(raw.missingFields) || raw.missingFields.length > 40) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.validation.missingFields 非法。');
    }
    for (const item of raw.missingFields) {
      assertContextSection(item, MISSING_FIELD_KEYS, 'validation.missingFields');
    }
  }
  if (raw.errors !== undefined) {
    if (!Array.isArray(raw.errors) || raw.errors.length > 40) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.validation.errors 非法。');
    }
    for (const item of raw.errors) {
      assertContextSection(item, FIELD_ERROR_KEYS, 'validation.errors');
    }
  }
  if (raw.readyForReview !== undefined && typeof raw.readyForReview !== 'boolean') {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.validation.readyForReview 必须是布尔值。');
  }
  if (raw.nextQuestion !== undefined && raw.nextQuestion !== null) {
    assertContextSection(raw.nextQuestion, NEXT_QUESTION_KEYS, 'validation.nextQuestion');
  }
}

function validateContextBuild(raw: unknown): void {
  assertContextSection(raw, BUILD_ALLOWED_KEYS, 'build');
  if (raw.candidates !== undefined) {
    if (!Array.isArray(raw.candidates) || raw.candidates.length > 5) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.build.candidates 非法。');
    }
    for (const item of raw.candidates) {
      assertContextSection(item, CANDIDATE_KEYS, 'build.candidates');
    }
  }
  if (raw.selectedId !== undefined && raw.selectedId !== null && !isShortText(raw.selectedId, 40)) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.build.selectedId 非法。');
  }
}

function validateContextAssets(raw: unknown): void {
  assertContextSection(raw, ASSETS_ALLOWED_KEYS, 'assets');
  if (raw.images === undefined) return;
  if (!Array.isArray(raw.images) || raw.images.length > 12) {
    reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context.assets.images 非法。');
  }
  for (const item of raw.images) {
    assertContextSection(item, ASSET_IMAGE_KEYS, 'assets.images');
  }
}

/** 递归检查上下文里的字符串：不允许 base64/data URL、绝对路径与控制字符。 */
function scanContextSafety(value: unknown): void {
  if (typeof value === 'string') {
    if (hasControlChars(value)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context 包含不可见控制字符。');
    }
    if (value.includes('data:') || value.includes('file://') || ABSOLUTE_PATH_PATTERN.test(value)) {
      reject('APP_ASSISTANT_CONTEXT_INVALID', 'project.context 不能包含 base64、data URL 或绝对路径。');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanContextSafety(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) scanContextSafety(child);
  }
}

// ---------------------------------------------------------------------------
// 提案（字段/菜品/动作）
// ---------------------------------------------------------------------------

export function normalizeEvidence(
  raw: unknown,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantEvidence> {
  if (!isPlainObject(raw)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence 必须是对象。');
  }
  for (const key of Object.keys(raw)) {
    if (!(EVIDENCE_ALLOWED_KEYS as readonly string[]).includes(key)) {
      return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence 包含未知字段。');
    }
  }
  const source = raw.source;
  if (
    typeof source !== 'string' ||
    !(APP_ASSISTANT_EVIDENCE_SOURCES as readonly string[]).includes(source)
  ) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence.source 非法。');
  }
  const evidence: AppAssistantEvidence = { source: source as AppAssistantEvidenceSource };

  if (raw.excerpt !== undefined) {
    if (typeof raw.excerpt !== 'string') {
      return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence.excerpt 必须是字符串。');
    }
    const excerpt = raw.excerpt.trim();
    if (
      excerpt.length === 0 ||
      countChars(excerpt) > APP_ASSISTANT_LIMITS.maxEvidenceExcerptChars ||
      hasControlChars(excerpt)
    ) {
      return fail(
        'APP_ASSISTANT_RESPONSE_INVALID',
        `evidence.excerpt 必须是非空且不超过 ${APP_ASSISTANT_LIMITS.maxEvidenceExcerptChars} 字的文本。`,
      );
    }
    evidence.excerpt = excerpt;
  }

  if (raw.attachmentId !== undefined) {
    if (
      typeof raw.attachmentId !== 'string' ||
      !APP_ASSISTANT_ATTACHMENT_ID_PATTERN.test(raw.attachmentId)
    ) {
      return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence.attachmentId 格式非法。');
    }
    if (!attachmentIds.has(raw.attachmentId)) {
      return fail('APP_ASSISTANT_VALUE_INVALID', 'evidence.attachmentId 不是本轮提供的附件。');
    }
    evidence.attachmentId = raw.attachmentId;
  }

  if (source === 'attachment' && evidence.attachmentId === undefined) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', '图片证据必须引用 attachmentId。');
  }
  if (source !== 'attachment' && evidence.excerpt === undefined && evidence.attachmentId === undefined) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'evidence 必须包含 excerpt 或 attachmentId。');
  }

  return ok(evidence);
}

export function normalizeChange(
  raw: unknown,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantChange> {
  if (!isPlainObject(raw)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'change 必须是对象。');
  }
  const op = raw.op;
  if (op === 'field.set') return normalizeFieldSet(raw, attachmentIds);
  if (op === 'dish.upsert') return normalizeDishUpsert(raw, attachmentIds);
  if (op === 'dish.remove') return normalizeDishRemove(raw, attachmentIds);
  return fail('APP_ASSISTANT_OPERATION_DENIED', '只允许 field.set / dish.upsert / dish.remove。');
}



function normalizeFieldSet(
  raw: Record<string, unknown>,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantChange> {
  for (const key of Object.keys(raw)) {
    if (!['opId', 'op', 'fieldId', 'value', 'evidence', 'reason'].includes(key)) {
      return fail('APP_ASSISTANT_OPERATION_DENIED', 'field.set 包含不允许的字段。');
    }
  }
  if (typeof raw.opId !== 'string' || !OP_ID_PATTERN.test(raw.opId)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'opId 格式非法。');
  }
  if (typeof raw.fieldId !== 'string' || !FIELD_ID_PATTERN.test(raw.fieldId)) {
    return fail('APP_ASSISTANT_FIELD_UNKNOWN', 'fieldId 格式非法或不在能力目录内。');
  }
  const field = findCatalogField(raw.fieldId);
  if (!field) {
    return fail('APP_ASSISTANT_FIELD_UNKNOWN', '该字段不在能力目录内。');
  }
  if (!field.writable || field.writeMode !== 'field.set') {
    return fail('APP_ASSISTANT_FIELD_READ_ONLY', '该字段不接受 field.set。');
  }
  if (raw.value === undefined) {
    return fail('APP_ASSISTANT_VALUE_INVALID', 'field.set 必须提供 value。');
  }
  const value = validateCatalogFieldValue(field, raw.value);
  if (!value.ok) return fail(value.code, value.message);

  const evidence = normalizeEvidence(raw.evidence, attachmentIds);
  if (!evidence.ok) return fail(evidence.code, evidence.message);

  const reason = readOptionalReason(raw.reason);
  if (!reason.ok) return fail(reason.code, reason.message);

  return ok({
    opId: raw.opId,
    op: 'field.set',
    fieldId: raw.fieldId,
    value: value.value,
    evidence: evidence.value,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
  });
}

function normalizeDishUpsert(
  raw: Record<string, unknown>,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantChange> {
  for (const key of Object.keys(raw)) {
    if (!['opId', 'op', 'name', 'dishId', 'priceCents', 'description', 'evidence', 'reason'].includes(key)) {
      return fail('APP_ASSISTANT_OPERATION_DENIED', 'dish.upsert 包含不允许的字段。');
    }
  }
  if (typeof raw.opId !== 'string' || !OP_ID_PATTERN.test(raw.opId)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'opId 格式非法。');
  }
  if (typeof raw.name !== 'string') {
    return fail('APP_ASSISTANT_VALUE_INVALID', 'dish.upsert 必须提供菜名。');
  }
  const name = raw.name.trim();
  if (name.length === 0 || countChars(name) > 24 || hasControlChars(name)) {
    return fail('APP_ASSISTANT_VALUE_INVALID', '菜名必须是 1–24 字的文本。');
  }
  const dishId = readOptionalText(raw.dishId, 32);
  if (!dishId.ok) return fail(dishId.code, dishId.message);

  let priceCents: number | null | undefined;
  if (raw.priceCents !== undefined) {
    if (raw.priceCents === null) {
      priceCents = null;
    } else if (
      typeof raw.priceCents === 'number' &&
      Number.isInteger(raw.priceCents) &&
      raw.priceCents >= 1 &&
      raw.priceCents <= 999_999
    ) {
      priceCents = raw.priceCents;
    } else {
      return fail('APP_ASSISTANT_VALUE_INVALID', '价格必须是 1–999999 的整数分，或 null。');
    }
  }
  const description = readOptionalText(raw.description, 60);
  if (!description.ok) return fail(description.code, description.message);

  const evidence = normalizeEvidence(raw.evidence, attachmentIds);
  if (!evidence.ok) return fail(evidence.code, evidence.message);
  const reason = readOptionalReason(raw.reason);
  if (!reason.ok) return fail(reason.code, reason.message);

  return ok({
    opId: raw.opId,
    op: 'dish.upsert',
    name,
    ...(dishId.value === undefined ? {} : { dishId: dishId.value }),
    ...(priceCents === undefined ? {} : { priceCents }),
    ...(description.value === undefined ? {} : { description: description.value }),
    evidence: evidence.value,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
  });
}

function normalizeDishRemove(
  raw: Record<string, unknown>,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantChange> {
  for (const key of Object.keys(raw)) {
    if (!['opId', 'op', 'dishId', 'evidence', 'reason'].includes(key)) {
      return fail('APP_ASSISTANT_OPERATION_DENIED', 'dish.remove 包含不允许的字段。');
    }
  }
  if (typeof raw.opId !== 'string' || !OP_ID_PATTERN.test(raw.opId)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'opId 格式非法。');
  }
  const dishId = readOptionalText(raw.dishId, 32);
  if (!dishId.ok) return fail(dishId.code, dishId.message);
  if (dishId.value === undefined) {
    return fail('APP_ASSISTANT_VALUE_INVALID', 'dish.remove 必须提供 dishId。');
  }
  const evidence = normalizeEvidence(raw.evidence, attachmentIds);
  if (!evidence.ok) return fail(evidence.code, evidence.message);
  const reason = readOptionalReason(raw.reason);
  if (!reason.ok) return fail(reason.code, reason.message);

  return ok({
    opId: raw.opId,
    op: 'dish.remove',
    dishId: dishId.value,
    evidence: evidence.value,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
  });
}

export function normalizeActionRequest(
  raw: unknown,
  attachmentIds: ReadonlySet<string>,
): ValidationResult<AppAssistantActionRequest> {
  if (!isPlainObject(raw)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'actionRequest 必须是对象。');
  }
  for (const key of Object.keys(raw)) {
    if (!['opId', 'op', 'actionId', 'params', 'attachmentIds', 'evidence', 'reason'].includes(key)) {
      return fail('APP_ASSISTANT_OPERATION_DENIED', 'action.request 包含不允许的字段。');
    }
  }
  if (typeof raw.opId !== 'string' || !OP_ID_PATTERN.test(raw.opId)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'opId 格式非法。');
  }
  if (typeof raw.actionId !== 'string' || !ACTION_ID_PATTERN.test(raw.actionId)) {
    return fail('APP_ASSISTANT_ACTION_UNAVAILABLE', 'actionId 格式非法或不在能力目录内。');
  }
  if (DENIED_ACTION_IDS.has(raw.actionId)) {
    return fail('APP_ASSISTANT_OPERATION_DENIED', '该动作属于安全拒绝项，服务端不会登记。');
  }
  const action = findCatalogAction(raw.actionId);
  if (!action) {
    return fail('APP_ASSISTANT_ACTION_UNAVAILABLE', '该动作不在能力目录内。');
  }

  const params: Record<string, string> = {};
  if (raw.params !== undefined) {
    if (!isPlainObject(raw.params)) {
      return fail('APP_ASSISTANT_OPERATION_DENIED', '动作参数必须是对象。');
    }
    const declared = action.params ?? {};
    for (const [key, value] of Object.entries(raw.params)) {
      if (!Object.prototype.hasOwnProperty.call(declared, key)) {
        return fail('APP_ASSISTANT_OPERATION_DENIED', '动作参数不在能力目录内。');
      }
      if (typeof value !== 'string') {
        return fail('APP_ASSISTANT_VALUE_INVALID', '动作参数值必须是字符串。');
      }
      const trimmed = value.trim();
      if (trimmed.length === 0 || countChars(trimmed) > 500 || hasControlChars(trimmed)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', '动作参数值非法。');
      }
      if (containsForbiddenValue(trimmed)) {
        return fail('APP_ASSISTANT_OPERATION_DENIED', '动作参数不能包含路径、URL 或脚本。');
      }
      const declaredType = declared[key];
      if (declaredType.includes('|')) {
        const options = declaredType.split('|').map((item) => item.trim());
        if (!options.includes(trimmed)) {
          return fail('APP_ASSISTANT_VALUE_INVALID', `动作参数 ${key} 必须是 ${options.join('/')} 之一。`);
        }
      }
      params[key] = trimmed;
    }
  }

  const requiredParams = requiredActionParams(raw.actionId);
  for (const key of requiredParams) {
    if (!params[key]) {
      return fail('APP_ASSISTANT_VALUE_INVALID', `动作缺少必需参数 ${key}。`);
    }
  }
  if (params.attachmentId && !attachmentIds.has(params.attachmentId)) {
    return fail('APP_ASSISTANT_VALUE_INVALID', '动作引用的附件不是本轮提供的图片。');
  }

  let requestAttachmentIds: string[] | undefined;
  if (raw.attachmentIds !== undefined) {
    if (!Array.isArray(raw.attachmentIds) || raw.attachmentIds.length > APP_ASSISTANT_LIMITS.maxAttachments) {
      return fail('APP_ASSISTANT_VALUE_INVALID', 'attachmentIds 最多 3 个。');
    }
    requestAttachmentIds = [];
    for (const item of raw.attachmentIds) {
      if (typeof item !== 'string' || !attachmentIds.has(item)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', 'attachmentIds 只能引用本轮提供的附件。');
      }
      if (!requestAttachmentIds.includes(item)) requestAttachmentIds.push(item);
    }
  }

  const evidence = normalizeEvidence(raw.evidence, attachmentIds);
  if (!evidence.ok) return fail(evidence.code, evidence.message);
  const reason = readOptionalReason(raw.reason);
  if (!reason.ok) return fail(reason.code, reason.message);

  return ok({
    opId: raw.opId,
    op: 'action.request',
    actionId: raw.actionId,
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(requestAttachmentIds === undefined || requestAttachmentIds.length === 0
      ? {}
      : { attachmentIds: requestAttachmentIds }),
    evidence: evidence.value,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
  });
}

function requiredActionParams(actionId: string): readonly string[] {
  switch (actionId) {
    case 'template.select':
      return ['templateId'];
    case 'template.revise':
      return ['utterance'];
    case 'asset.attach-store-image':
      return ['attachmentId', 'target'];
    default:
      return [];
  }
}

export function normalizeQuestion(raw: unknown): ValidationResult<AppAssistantQuestion> {
  if (!isPlainObject(raw)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'question 必须是对象。');
  }
  for (const key of Object.keys(raw)) {
    if (!['field', 'text'].includes(key)) {
      return fail('APP_ASSISTANT_RESPONSE_INVALID', 'question 包含未知字段。');
    }
  }
  if (raw.field !== undefined) {
    if (typeof raw.field !== 'string' || !QUESTION_FIELD_PATTERN.test(raw.field)) {
      return fail('APP_ASSISTANT_RESPONSE_INVALID', 'question.field 非法。');
    }
  }
  if (typeof raw.text !== 'string') {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'question.text 必须是字符串。');
  }
  const text = raw.text.trim();
  if (text.length === 0 || countChars(text) > 200 || hasControlChars(text)) {
    return fail('APP_ASSISTANT_RESPONSE_INVALID', 'question.text 必须是 1–200 字的文本。');
  }
  return ok({ id: '', text });
}

function readOptionalText(
  raw: unknown,
  maxChars: number,
): ValidationResult<string | undefined> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string') {
    return fail('APP_ASSISTANT_VALUE_INVALID', '文本字段必须是字符串。');
  }
  const value = raw.trim();
  if (value.length === 0) return ok(undefined);
  if (countChars(value) > maxChars || hasControlChars(value)) {
    return fail('APP_ASSISTANT_VALUE_INVALID', `文本字段不能超过 ${maxChars} 字。`);
  }
  if (containsForbiddenValue(value)) {
    return fail('APP_ASSISTANT_OPERATION_DENIED', '文本字段不能包含路径、URL 或脚本。');
  }
  return ok(value);
}

function readOptionalReason(raw: unknown): ValidationResult<string | undefined> {
  return readOptionalText(raw, 120);
}

/** 字段值校验：值类型/选项/长度/价格/路径红线全部在这里决定。 */
export function validateCatalogFieldValue(
  field: CatalogField,
  raw: unknown,
): ValidationResult<JsonValue> {
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}必须是文本。`);
      }
      const value = raw.trim();
      const chars = countChars(value);
      const maxChars = catalogLimitNumber(field, 'maxChars') ?? 2_000;
      const minChars = catalogLimitNumber(field, 'minChars') ?? 0;
      if (chars > maxChars) {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}不能超过 ${maxChars} 字。`);
      }
      if (chars < minChars) {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}至少需要 ${minChars} 个字。`);
      }
      if (hasControlChars(value)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}包含不可见控制字符。`);
      }
      if (containsForbiddenValue(value)) {
        return fail('APP_ASSISTANT_OPERATION_DENIED', `${field.label}不能包含链接、data URL 或路径。`);
      }
      return ok(value);
    }
    case 'hours': {
      if (typeof raw !== 'string') {
        return fail('APP_ASSISTANT_VALUE_INVALID', '营业时间必须是文本。');
      }
      const maxChars = catalogLimitNumber(field, 'maxChars') ?? 120;
      const maxSegments = catalogLimitNumber(field, 'maxSegments') ?? 3;
      const segments = raw.split(',').map((segment) => segment.trim());
      if (
        segments.length === 0 ||
        segments.length > maxSegments ||
        segments.some((segment) => !HOURS_SEGMENT_PATTERN.test(segment))
      ) {
        return fail(
          'APP_ASSISTANT_VALUE_INVALID',
          `营业时间必须是 1–${maxSegments} 段 HH:MM-HH:MM，用英文逗号分隔。`,
        );
      }
      const value = segments.join(',');
      if (countChars(value) > maxChars || hasControlChars(value)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', '营业时间格式非法。');
      }
      return ok(value);
    }
    case 'fulfillment': {
      if (!isPlainObject(raw)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', '取餐方式必须是对象。');
      }
      const keys = Object.keys(raw);
      if (keys.length !== FULFILLMENT_KEYS.length) {
        return fail('APP_ASSISTANT_VALUE_INVALID', '取餐方式必须同时提供 dineIn 与 takeaway。');
      }
      for (const key of FULFILLMENT_KEYS) {
        if (typeof raw[key] !== 'boolean') {
          return fail('APP_ASSISTANT_VALUE_INVALID', '取餐方式必须是布尔值。');
        }
      }
      return ok({ dineIn: raw.dineIn as boolean, takeaway: raw.takeaway as boolean });
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}必须是文本。`);
      }
      const options = field.options ?? [];
      if (!options.includes(raw)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}必须从目录选项中选择。`);
      }
      return ok(raw);
    }
    case 'featureId.list': {
      if (!Array.isArray(raw)) {
        return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}必须是数组。`);
      }
      const options = field.options ?? [];
      const required = field.required ?? [];
      const selected: string[] = [];
      for (const item of raw) {
        if (typeof item !== 'string' || !options.includes(item)) {
          return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}包含目录之外的功能。`);
        }
        if (!selected.includes(item)) selected.push(item);
      }
      for (const item of required) {
        if (!selected.includes(item)) {
          return fail('APP_ASSISTANT_VALUE_INVALID', `${field.label}不能移除必需功能。`);
        }
      }
      return ok(selected);
    }
    case 'appid': {
      if (typeof raw !== 'string') {
        return fail('APP_ASSISTANT_VALUE_INVALID', 'AppID 必须是文本。');
      }
      const pattern = catalogLimitString(field, 'pattern') ?? DEFAULT_APPID_PATTERN;
      let valid = false;
      try {
        valid = new RegExp(pattern, 'u').test(raw);
      } catch {
        valid = false;
      }
      if (!valid) {
        return fail('APP_ASSISTANT_VALUE_INVALID', 'AppID 格式必须是 wx 开头的 18 位标识。');
      }
      return ok(raw);
    }
    default:
      return fail('APP_ASSISTANT_FIELD_READ_ONLY', `${field.label}不接受直接写入。`);
  }
}

// ---------------------------------------------------------------------------
// 响应外壳自检
// ---------------------------------------------------------------------------

export interface AppAssistantResponseExpectation {
  requestId: string;
  contextRevision: number;
  attachmentIds: ReadonlySet<string>;
}

export function collectAppAssistantResponseIssues(
  raw: unknown,
  expected: AppAssistantResponseExpectation,
): string[] {
  const issues: string[] = [];
  const push = (message: string): void => {
    if (issues.length < 20) issues.push(message);
  };

  if (!isPlainObject(raw)) {
    return ['响应必须是 JSON 对象。'];
  }
  for (const key of Object.keys(raw)) {
    if (!(RESPONSE_ALLOWED_KEYS as readonly string[]).includes(key)) {
      push('响应包含未知顶层字段。');
      break;
    }
  }

  if (raw.contractVersion !== APP_ASSISTANT_CONTRACT_VERSION) push('contractVersion 不一致。');
  if (raw.requestId !== expected.requestId) push('requestId 不一致。');
  if (raw.catalogVersion !== APP_ASSISTANT_CATALOG_VERSION) push('catalogVersion 不一致。');
  if (raw.contextRevision !== expected.contextRevision) push('contextRevision 不一致。');
  if (
    typeof raw.status !== 'string' ||
    !(APP_ASSISTANT_STATUSES as readonly string[]).includes(raw.status)
  ) {
    push('status 只能是 proposal / needs-input / rejected。');
  }
  if (typeof raw.reply !== 'string' || countChars(raw.reply) > APP_ASSISTANT_LIMITS.maxReplyChars) {
    push(`reply 必须是 ${APP_ASSISTANT_LIMITS.maxReplyChars} 字以内的文本。`);
  }
  if (typeof raw.proposalId !== 'string' || !APP_ASSISTANT_PROPOSAL_ID_PATTERN.test(raw.proposalId)) {
    push('proposalId 格式非法。');
  }
  if (typeof raw.runId !== 'string' || raw.runId.length === 0 || raw.runId.length > 120) {
    push('runId 非法。');
  }

  if (!Array.isArray(raw.changes)) {
    push('changes 必须是数组。');
  } else {
    if (raw.changes.length > APP_ASSISTANT_LIMITS.maxChanges) push('changes 超过上限。');
    raw.changes.forEach((change, index) => {
      const result = normalizeChange(change, expected.attachmentIds);
      if (!result.ok) push(`changes[${index}] 非法（${result.code}）。`);
    });
  }

  if (!Array.isArray(raw.questions)) {
    push('questions 必须是数组。');
  } else {
    if (raw.questions.length > APP_ASSISTANT_LIMITS.maxQuestions) push('questions 超过上限。');
    raw.questions.forEach((question, index) => {
      if (!isPlainObject(question)) {
        push(`questions[${index}] 必须是对象。`);
        return;
      }
      for (const key of Object.keys(question)) {
        if (!(QUESTION_ALLOWED_KEYS as readonly string[]).includes(key)) {
          push(`questions[${index}] 包含未知字段。`);
        }
      }
      if (typeof question.id !== 'string' || !QUESTION_ID_PATTERN.test(question.id)) {
        push(`questions[${index}].id 非法。`);
      }
      if (
        typeof question.text !== 'string' ||
        question.text.trim().length === 0 ||
        countChars(question.text) > 200
      ) {
        push(`questions[${index}].text 非法。`);
      }
    });
  }

  if (!Array.isArray(raw.actionRequests)) {
    push('actionRequests 必须是数组。');
  } else {
    if (raw.actionRequests.length > APP_ASSISTANT_LIMITS.maxActionRequests) {
      push('actionRequests 超过上限。');
    }
    raw.actionRequests.forEach((request, index) => {
      const result = normalizeActionRequest(request, expected.attachmentIds);
      if (!result.ok) push(`actionRequests[${index}] 非法（${result.code}）。`);
    });
  }

  const trace = raw.trace;
  if (!isPlainObject(trace)) {
    push('trace 必须是对象。');
  } else {
    for (const key of Object.keys(trace)) {
      if (!(TRACE_ALLOWED_KEYS as readonly string[]).includes(key)) push('trace 包含未知字段。');
    }
    if (typeof trace.modelCalls !== 'number' || !Number.isInteger(trace.modelCalls) || trace.modelCalls < 0) {
      push('trace.modelCalls 非法。');
    }
    if (!Array.isArray(trace.toolCalls)) {
      push('trace.toolCalls 必须是数组。');
    } else {
      trace.toolCalls.forEach((call, index) => {
        if (!isPlainObject(call)) {
          push(`trace.toolCalls[${index}] 必须是对象。`);
          return;
        }
        for (const key of Object.keys(call)) {
          if (!(TOOL_TRACE_ALLOWED_KEYS as readonly string[]).includes(key)) {
            push(`trace.toolCalls[${index}] 包含未知字段。`);
          }
        }
        if (
          typeof call.name !== 'string' ||
          !(APP_ASSISTANT_TOOL_NAMES as readonly string[]).includes(call.name)
        ) {
          push(`trace.toolCalls[${index}].name 非法。`);
        }
        if (typeof call.ok !== 'boolean') push(`trace.toolCalls[${index}].ok 非法。`);
        if (typeof call.latencyMs !== 'number' || !Number.isFinite(call.latencyMs)) {
          push(`trace.toolCalls[${index}].latencyMs 非法。`);
        }
      });
    }
    if (
      typeof trace.stopReason !== 'string' ||
      !(APP_ASSISTANT_STOP_REASONS as readonly string[]).includes(trace.stopReason)
    ) {
      push('trace.stopReason 非法。');
    }
    if (typeof trace.degraded !== 'boolean') push('trace.degraded 非法。');
  }

  const meta = raw.meta;
  if (!isPlainObject(meta)) {
    push('meta 必须是对象。');
  } else {
    for (const key of Object.keys(meta)) {
      if (!(META_ALLOWED_KEYS as readonly string[]).includes(key)) push('meta 包含未知字段。');
    }
    if (meta.transport !== 'http') push('meta.transport 非法。');
    if (meta.provider !== 'deepseek') push('meta.provider 非法。');
    if (meta.mock !== false) push('meta.mock 必须是 false。');
    if (typeof meta.model !== 'string' || meta.model.length === 0 || meta.model.length > 80) {
      push('meta.model 非法。');
    }
    if (typeof meta.latencyMs !== 'number' || !Number.isInteger(meta.latencyMs) || meta.latencyMs < 0) {
      push('meta.latencyMs 非法。');
    }
    if (typeof meta.runId !== 'string' || meta.runId.length === 0 || meta.runId.length > 120) {
      push('meta.runId 非法。');
    }
  }

  return issues;
}
