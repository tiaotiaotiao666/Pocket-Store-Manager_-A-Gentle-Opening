import { HttpException } from '@nestjs/common';
import {
  AGENT_IMAGE_BASE64_PATTERN,
  AGENT_IMAGE_LIMITS,
  AGENT_IMAGE_MEDIA_TYPES,
  validateAgentImages,
} from '../agent-image.validator';
import type { ValidatedAgentImage } from '../agent-image.validator';
import { frontendError } from './errors';
import type { FrontendErrorCode } from './errors';
import { validateFrontendPageFactsMap } from './page-facts';
import type { FrontendPageFacts, FrontendPageFactsMap } from './page-facts';
import {
  FRONTEND_CLIENT_PHASES,
  FRONTEND_CLIENT_SURFACES,
  FRONTEND_DRAFT_NODE_TYPES,
  FRONTEND_FACTS_VERSION,
  FRONTEND_LAYOUT_KINDS,
  FRONTEND_LIMITS,
  FRONTEND_PACK_DRAFT_SCHEMA_VERSION,
  FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
  FRONTEND_REGION_TYPES,
  FRONTEND_RESPONSE_STATUSES,
  FRONTEND_SIZE_KEYS,
  FRONTEND_SIZE_STEPS,
  FRONTEND_STATES,
  FRONTEND_STOP_REASONS,
  FRONTEND_TARGET_PAGES,
  FRONTEND_THEME_TOKEN_KEYS,
  FRONTEND_TOOL_NAMES,
} from './types';
import type {
  CapabilityCoverageReport,
  CoverageDegradation,
  CoverageRisk,
  Degradation,
  Density,
  DraftComponentNode,
  DraftContainerNode,
  DraftContainerStyle,
  DraftButtonNode,
  DraftPage,
  DraftPageJson,
  DraftPropBinding,
  DraftSlotNode,
  DraftTextNode,
  DraftTextStyle,
  FrontendDraftNode,
  FrontendFacts,
  FrontendFactsComponent,
  FrontendMeta,
  FrontendPackDraft,
  FrontendQuestion,
  FrontendReconstructResponse,
  FrontendRequestClient,
  FrontendRequestCurrent,
  FrontendRequestImage,
  FrontendResponseStatus,
  FrontendTargetPageId,
  FrontendThemeTokenKey,
  FrontendTrace,
  FrontendTraceToolCall,
  InferredInteraction,
  LowConfidenceRegion,
  MustKeep,
  NormalizedRect,
  ParsedFrontendReconstructRequest,
  RegionNode,
  RequirementBinding,
  RequirementPage,
  UiRequirement,
  UnknownRegion,
  UnsupportedRequirement,
  VisualSpec,
} from './types';

/**
 * frontend-reconstruct.v1 运行时校验（纯函数，无网络/无文件/无 Nest 容器）。
 *
 * 统一规则：
 * - 所有对象都是**严格未知键拒绝**；数组有明确上限；
 * - 所有自由文本移除/拒绝控制字符，禁止 `<`/`>`、模板表达式、脚本 scheme、URL、
 *   反斜杠与 `..`；错误信息只带结构路径，绝不回填正文；
 * - 模型输出中的组件/事件/数据/插槽/颜色 token 必须命中服务端注入事实；
 * - 能力覆盖由服务端事实判定，模型无法伪造 `covered`。
 */

// 标识符正则、文本黑名单与键白名单只允许来自契约生成模块（与桌面执行侧同源）。
import {
  ACTION_PATTERN,
  CAPABILITY_PATTERN,
  CONTROL_CHAR_PATTERN,
  DATA_PATH_PATTERN,
  EVENT_ID_PATTERN,
  FORBIDDEN_TEXT_PATTERNS,
  FRONTEND_BUTTON_KEYS as BUTTON_KEYS,
  FRONTEND_COMPONENT_KEYS as COMPONENT_KEYS,
  FRONTEND_CONTAINER_KEYS as CONTAINER_KEYS,
  FRONTEND_DATA_PROP_KEYS as DATA_PROP_KEYS,
  FRONTEND_DRAFT_KEYS as DRAFT_KEYS,
  FRONTEND_DRAFT_PAGE_JSON_KEYS as PAGE_JSON_KEYS,
  FRONTEND_DRAFT_PAGE_KEYS as DRAFT_PAGE_KEYS,
  FRONTEND_LAYOUT_STYLE_KEYS as LAYOUT_STYLE_KEYS,
  FRONTEND_LITERAL_PROP_KEYS as LITERAL_PROP_KEYS,
  FRONTEND_SLOT_KEYS as SLOT_KEYS,
  FRONTEND_TEXT_KEYS as TEXT_KEYS,
  FRONTEND_TEXT_STYLE_KEYS as TEXT_STYLE_KEYS,
  HEX_COLOR_PATTERN,
  INFERRED_FORBIDDEN_TOKENS,
  LOWERCASE_ID_PATTERN,
  MODEL_PATTERN,
  PACK_ID_PATTERN,
  PROJECT_ID_PATTERN,
  PROP_ID_PATTERN,
  PROVIDER_PATTERN,
  QUESTION_FIELD_PATTERN,
  REGION_ID_PATTERN,
  REQUEST_ID_PATTERN,
  RUN_ID_PATTERN,
  VERSION_PATTERN,
} from './contract.generated';

/** 0–1 rect 的浮点容差。 */
const RECT_EPSILON = 1e-6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: FrontendErrorCode, path?: string): never {
  throw frontendError(code, path === undefined ? undefined : { path });
}

function assertObject(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code, path);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: FrontendErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${path}.${key}`);
  }
}

function assertArray(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  min: number,
  max: number,
): unknown[] {
  if (!Array.isArray(value)) fail(code, path);
  if (value.length < min || value.length > max) fail(code, path);
  return value;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  code: FrontendErrorCode,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(code, path);
  return value as T;
}

function assertPattern(
  value: unknown,
  pattern: RegExp,
  path: string,
  code: FrontendErrorCode,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code, path);
  return value;
}

function assertInteger(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(code, path);
  }
  return value;
}

function assertNumber(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(code, path);
  }
  return value;
}

function assertBoolean(value: unknown, path: string, code: FrontendErrorCode): boolean {
  if (typeof value !== 'boolean') fail(code, path);
  return value;
}

/**
 * 强制“纯文本”：拒绝控制字符、标签/模板、脚本 scheme、URL、反斜杠与路径穿越。
 * 返回值 trim 后仍满足长度下限，否则视为非法（不回填空串掩盖问题）。
 */
function assertPlainText(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  options: { max: number; min?: number; allowEmpty?: boolean },
): string {
  if (typeof value !== 'string') fail(code, path);
  const min = options.allowEmpty === true ? 0 : options.min ?? 1;
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < min || length > options.max) fail(code, path);
  if (CONTROL_CHAR_PATTERN.test(text)) fail(code, path);
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    if (pattern.test(text)) fail(code, path);
  }
  return text;
}

function normalizeHexColor(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
): string {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) fail(code, path);
  return value.toUpperCase();
}

function uniqueStrings(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  pattern: RegExp,
  min: number,
  max: number,
): string[] {
  const raw = assertArray(value, path, code, min, max);
  const out: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = assertPattern(raw[index], pattern, `${path}[${index}]`, code);
    if (out.includes(item)) fail(code, `${path}[${index}]`);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 服务端注入事实
// ---------------------------------------------------------------------------

/**
 * 校验能力事实快照。任何键缺失/未知、id 非法、数组越界都 fail closed；
 * 该函数不做 IO，能力快照由 P1 从 Catalog/Base/控制器确定性生成。
 */
export function validateFrontendFacts(raw: unknown): FrontendFacts {
  const code: FrontendErrorCode = 'FRONTEND_FACTS_INVALID';
  const root = assertObject(raw, '$', code);
  assertExactKeys(
    root,
    ['version', 'pageIds', 'components', 'slots', 'actions', 'dataPaths', 'themeTokens', 'sizeKeys'],
    '$',
    code,
  );
  if (root.version !== FRONTEND_FACTS_VERSION) fail(code, '$.version');

  const pageIds = uniqueStrings(
    root.pageIds,
    '$.pageIds',
    code,
    LOWERCASE_ID_PATTERN,
    1,
    FRONTEND_TARGET_PAGES.length,
  );
  for (const pageId of pageIds) {
    if (!(FRONTEND_TARGET_PAGES as readonly string[]).includes(pageId)) fail(code, '$.pageIds');
  }

  const rawComponents = assertObject(root.components, '$.components', code);
  if (Object.keys(rawComponents).length > FRONTEND_LIMITS.maxFactsEntries) fail(code, '$.components');
  const components: Record<string, FrontendFactsComponent> = {};
  for (const componentId of Object.keys(rawComponents)) {
    if (!LOWERCASE_ID_PATTERN.test(componentId)) fail(code, '$.components');
    const component = assertObject(rawComponents[componentId], `$.components.${componentId}`, code);
    assertExactKeys(component, ['props', 'events'], `$.components.${componentId}`, code);
    components[componentId] = {
      props: uniqueStrings(
        component.props,
        `$.components.${componentId}.props`,
        code,
        PROP_ID_PATTERN,
        0,
        FRONTEND_LIMITS.maxFactsEntries,
      ),
      events: uniqueStrings(
        component.events,
        `$.components.${componentId}.events`,
        code,
        EVENT_ID_PATTERN,
        0,
        FRONTEND_LIMITS.maxFactsEntries,
      ),
    };
  }

  const slots = uniqueStrings(
    root.slots,
    '$.slots',
    code,
    LOWERCASE_ID_PATTERN,
    0,
    FRONTEND_LIMITS.maxFactsEntries,
  );
  const actions = uniqueStrings(
    root.actions,
    '$.actions',
    code,
    ACTION_PATTERN,
    0,
    FRONTEND_LIMITS.maxFactsEntries,
  );
  const dataPaths = uniqueStrings(
    root.dataPaths,
    '$.dataPaths',
    code,
    DATA_PATH_PATTERN,
    0,
    FRONTEND_LIMITS.maxFactsEntries,
  );

  const themeTokens = uniqueStrings(
    root.themeTokens,
    '$.themeTokens',
    code,
    /^[A-Za-z][A-Za-z0-9]{0,39}$/,
    1,
    FRONTEND_THEME_TOKEN_KEYS.length,
  );
  for (const token of themeTokens) {
    if (!(FRONTEND_THEME_TOKEN_KEYS as readonly string[]).includes(token)) fail(code, '$.themeTokens');
  }

  const sizeKeys = uniqueStrings(
    root.sizeKeys,
    '$.sizeKeys',
    code,
    /^[A-Za-z][A-Za-z0-9]{0,39}$/,
    1,
    FRONTEND_SIZE_KEYS.length,
  );
  for (const key of sizeKeys) {
    if (!(FRONTEND_SIZE_KEYS as readonly string[]).includes(key)) fail(code, '$.sizeKeys');
  }

  return {
    version: FRONTEND_FACTS_VERSION,
    pageIds,
    components,
    slots,
    actions,
    dataPaths,
    themeTokens,
    sizeKeys,
  };
}

/** 由事实派生合法 capability id 集合；模型不能自造能力 id。 */
export function buildFrontendCapabilityIds(rawFacts: unknown): string[] {
  const facts = validateFrontendFacts(rawFacts);
  const ids: string[] = [];
  for (const pageId of facts.pageIds) ids.push(`page:${pageId}`);
  for (const componentId of Object.keys(facts.components)) ids.push(`component:${componentId}`);
  for (const slotId of facts.slots) ids.push(`slot:${slotId}`);
  for (const action of facts.actions) ids.push(`action:${action}`);
  for (const dataPath of facts.dataPaths) ids.push(`data:${dataPath}`);
  return ids;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

const REQUEST_KEYS = [
  'contractVersion',
  'requestId',
  'utterance',
  'images',
  'targetPages',
  'current',
  'client',
  'projectId',
] as const;

const IMAGE_KEYS = ['kind', 'mediaType', 'dataBase64'] as const;
const CURRENT_KEYS = ['baseTemplate', 'frontendPack', 'presentationPatch'] as const;
const CLIENT_KEYS = ['surface', 'phase'] as const;

function mapAgentImageError(error: unknown): never {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const agentCode = isPlainObject(body) && typeof body.code === 'string' ? body.code : '';
    const mapping: Record<string, FrontendErrorCode> = {
      AGENT_IMAGE_KIND_MIXED: 'FRONTEND_IMAGE_KIND_INVALID',
      AGENT_IMAGE_COUNT_EXCEEDED: 'FRONTEND_IMAGE_COUNT_INVALID',
      AGENT_IMAGE_TYPE_UNSUPPORTED: 'FRONTEND_IMAGE_TYPE_UNSUPPORTED',
      AGENT_IMAGE_INVALID: 'FRONTEND_IMAGE_INVALID',
      AGENT_IMAGE_TOO_LARGE: 'FRONTEND_IMAGE_TOO_LARGE',
    };
    fail(mapping[agentCode] ?? 'FRONTEND_REQUEST_INVALID', '$.images');
  }
  throw error;
}

/** 只按真实文件头判断，避免“声明 image/png、实际是任意字节”。 */
function sniffImageMediaType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function parseReferenceImage(raw: unknown): FrontendRequestImage {
  if (raw === undefined || raw === null) fail('FRONTEND_IMAGE_REQUIRED', '$.images');
  if (!Array.isArray(raw)) fail('FRONTEND_REQUEST_INVALID', '$.images');
  if (raw.length === 0) fail('FRONTEND_IMAGE_REQUIRED', '$.images');

  for (let index = 0; index < raw.length; index += 1) {
    const itemPath = `$.images[${index}]`;
    const item = assertObject(raw[index], itemPath, 'FRONTEND_REQUEST_INVALID');
    assertExactKeys(item, IMAGE_KEYS, itemPath, 'FRONTEND_REQUEST_INVALID');
    if (item.kind !== 'reference') fail('FRONTEND_IMAGE_KIND_INVALID', `${itemPath}.kind`);
  }
  if (raw.length !== 1) fail('FRONTEND_IMAGE_COUNT_INVALID', '$.images');

  let validated: ValidatedAgentImage;
  try {
    const result = validateAgentImages(raw);
    if (result.images.length !== 1 || result.referenceImages !== 1) {
      fail('FRONTEND_IMAGE_COUNT_INVALID', '$.images');
    }
    validated = result.images[0];
  } catch (error) {
    mapAgentImageError(error);
  }

  if (!AGENT_IMAGE_MEDIA_TYPES.includes(validated.mediaType)) {
    fail('FRONTEND_IMAGE_TYPE_UNSUPPORTED', '$.images[0].mediaType');
  }
  if (!AGENT_IMAGE_BASE64_PATTERN.test(validated.data)) {
    fail('FRONTEND_IMAGE_INVALID', '$.images[0].dataBase64');
  }
  const buffer = Buffer.from(validated.data, 'base64');
  if (buffer.byteLength !== validated.bytes || buffer.byteLength > AGENT_IMAGE_LIMITS.maxImageBytes) {
    fail('FRONTEND_IMAGE_TOO_LARGE', '$.images[0].dataBase64');
  }
  const sniffed = sniffImageMediaType(buffer);
  if (sniffed === null || sniffed !== validated.mediaType) {
    fail('FRONTEND_IMAGE_INVALID', '$.images[0].mediaType');
  }

  return {
    mediaType: validated.mediaType,
    dataBase64: validated.data,
    bytes: validated.bytes,
  };
}

function parseCurrent(raw: unknown): FrontendRequestCurrent {
  const code: FrontendErrorCode = 'FRONTEND_REQUEST_INVALID';
  const current = assertObject(raw, '$.current', code);
  assertExactKeys(current, CURRENT_KEYS, '$.current', code);

  const baseTemplate = assertObject(current.baseTemplate, '$.current.baseTemplate', code);
  assertExactKeys(baseTemplate, ['id', 'version'], '$.current.baseTemplate', code);
  if (baseTemplate.id !== 'ordering-base') fail(code, '$.current.baseTemplate.id');
  const baseVersion = assertPattern(
    baseTemplate.version,
    VERSION_PATTERN,
    '$.current.baseTemplate.version',
    code,
  );

  let frontendPack: FrontendRequestCurrent['frontendPack'] = null;
  if (current.frontendPack !== null) {
    const pack = assertObject(current.frontendPack, '$.current.frontendPack', code);
    assertExactKeys(pack, ['id', 'version'], '$.current.frontendPack', code);
    frontendPack = {
      id: assertPattern(pack.id, PACK_ID_PATTERN, '$.current.frontendPack.id', code),
      version: assertPattern(pack.version, VERSION_PATTERN, '$.current.frontendPack.version', code),
    };
  }

  const patch = assertObject(current.presentationPatch, '$.current.presentationPatch', code);
  assertJsonValue(patch, '$.current.presentationPatch', code, 0);
  let serialized = '';
  try {
    serialized = JSON.stringify(patch);
  } catch {
    fail(code, '$.current.presentationPatch');
  }
  // 上限按 UTF-8 字节计：中文/emoji 的字符串长度会低估体积。
  if (Buffer.byteLength(serialized, 'utf8') > FRONTEND_LIMITS.maxPresentationPatchBytes) {
    fail(code, '$.current.presentationPatch');
  }

  return {
    baseTemplate: { id: 'ordering-base', version: baseVersion },
    frontendPack,
    presentationPatch: patch,
  };
}

function assertJsonValue(
  value: unknown,
  path: string,
  code: FrontendErrorCode,
  depth: number,
): void {
  if (depth > 8) fail(code, path);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, code, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) fail(code, path);
  for (const key of Object.keys(value)) {
    assertJsonValue(value[key], `${path}.${key}`, code, depth + 1);
  }
}

function parseClient(raw: unknown): FrontendRequestClient {
  const code: FrontendErrorCode = 'FRONTEND_REQUEST_INVALID';
  const client = assertObject(raw, '$.client', code);
  assertExactKeys(client, CLIENT_KEYS, '$.client', code);
  assertEnum(client.surface, FRONTEND_CLIENT_SURFACES, '$.client.surface', code);
  const phase = assertEnum(client.phase, FRONTEND_CLIENT_PHASES, '$.client.phase', code);
  return { surface: 'desktop', phase };
}

/**
 * 解析并校验 `POST /api/v1/agent/frontend-reconstruct` 请求。
 * 校验顺序：体积 → 未知键 → 版本 → requestId → 图片 → utterance → targetPages
 * → current → client → projectId。图片沿用既有 `validateAgentImages` 的字节级规则。
 */
export function parseFrontendReconstructRequest(raw: unknown): ParsedFrontendReconstructRequest {
  const code: FrontendErrorCode = 'FRONTEND_REQUEST_INVALID';
  const body = assertObject(raw, '$', code);
  let bodyLength = 0;
  try {
    // 上限按 UTF-8 字节计：与 express body-parser 的 limit 口径一致。
    bodyLength = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    fail(code, '$');
  }
  if (bodyLength > FRONTEND_LIMITS.maxBodyBytes) fail(code, '$');

  assertExactKeys(body, REQUEST_KEYS, '$', code);

  if (body.contractVersion !== FRONTEND_RECONSTRUCT_CONTRACT_VERSION) {
    fail('FRONTEND_CONTRACT_MISMATCH', '$.contractVersion');
  }
  const requestId = assertPattern(body.requestId, REQUEST_ID_PATTERN, '$.requestId', code);

  const image = parseReferenceImage(body.images);

  let utterance = '';
  if (body.utterance !== undefined && body.utterance !== null) {
    if (typeof body.utterance !== 'string') fail('FRONTEND_UTTERANCE_INVALID', '$.utterance');
    const trimmed = body.utterance.trim();
    if (Array.from(trimmed).length > FRONTEND_LIMITS.maxUtteranceChars) {
      fail('FRONTEND_UTTERANCE_INVALID', '$.utterance');
    }
    if (CONTROL_CHAR_PATTERN.test(trimmed)) fail('FRONTEND_UTTERANCE_INVALID', '$.utterance');
    utterance = trimmed;
  }

  const rawPages = assertArray(body.targetPages, '$.targetPages', code, 1, FRONTEND_LIMITS.maxPages);
  const targetPages: FrontendTargetPageId[] = [];
  for (let index = 0; index < rawPages.length; index += 1) {
    const pagePath = `$.targetPages[${index}]`;
    if (typeof rawPages[index] !== 'string') fail(code, pagePath);
    const pageId = rawPages[index] as string;
    if (!(FRONTEND_TARGET_PAGES as readonly string[]).includes(pageId)) {
      fail('FRONTEND_TARGET_PAGES_UNSUPPORTED', pagePath);
    }
    if (targetPages.includes(pageId as FrontendTargetPageId)) fail(code, pagePath);
    targetPages.push(pageId as FrontendTargetPageId);
  }

  const current = parseCurrent(body.current);
  const client = parseClient(body.client);

  let projectId: string | null = null;
  if (body.projectId !== null) {
    projectId = assertPattern(body.projectId, PROJECT_ID_PATTERN, '$.projectId', code);
  }

  return {
    contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
    requestId,
    utterance,
    targetPages,
    current,
    client,
    projectId,
    image,
  };
}

// ---------------------------------------------------------------------------
// UiRequirement / VisualSpec
// ---------------------------------------------------------------------------

const REQUIREMENT_KEYS = [
  'summary',
  'mustKeep',
  'pages',
  'visual',
  'bindings',
  'unknownRegions',
  'lowConfidence',
  'inferredInteractions',
  'unsupported',
  'degradations',
] as const;
const VISUAL_KEYS = ['theme', 'sizes', 'density'] as const;
const PAGE_KEYS = ['pageId', 'order', 'layout', 'targetSize', 'regions'] as const;
const REGION_KEYS = ['id', 'type', 'order', 'rect', 'children', 'confidence'] as const;
const RECT_KEYS = ['x', 'y', 'w', 'h'] as const;
const TARGET_SIZE_KEYS = ['width', 'height'] as const;
const BINDING_KEYS = ['regionId', 'dataPath', 'eventName', 'status'] as const;
const UNKNOWN_REGION_KEYS = ['regionId', 'label', 'reason'] as const;
const LOW_CONFIDENCE_KEYS = ['regionId', 'confidence', 'reason'] as const;
const INFERRED_KEYS = ['regionId', 'label', 'reason'] as const;
const UNSUPPORTED_KEYS = ['capability', 'label', 'reason'] as const;
const DEGRADATION_KEYS = ['regionId', 'label', 'reason', 'severity'] as const;

export interface RequirementValidationOptions {
  /** 请求声明的目标页；用于交叉校验 pages 与 mustKeep。 */
  targetPages?: readonly FrontendTargetPageId[];
  /**
   * 页面级事实；提供时 planned 响应里的 draft 会额外按页校验组件/插槽/数据路径/动作前缀，
   * 与桌面 P2 loadPageFacts 同源。P1 端点/工具必须提供。
   */
  pageFacts?: FrontendPageFactsMap | unknown;
}

interface RegionParseContext {
  ids: Set<string>;
  count: number;
  code: FrontendErrorCode;
}

function parseRect(raw: unknown, path: string, code: FrontendErrorCode): NormalizedRect {
  const rect = assertObject(raw, path, code);
  assertExactKeys(rect, RECT_KEYS, path, code);
  const x = assertNumber(rect.x, `${path}.x`, code, 0, 1);
  const y = assertNumber(rect.y, `${path}.y`, code, 0, 1);
  const w = assertNumber(rect.w, `${path}.w`, code, 0, 1);
  const h = assertNumber(rect.h, `${path}.h`, code, 0, 1);
  if (x + w > 1 + RECT_EPSILON || y + h > 1 + RECT_EPSILON) fail(code, path);
  return { x, y, w, h };
}

function parseRegion(
  raw: unknown,
  path: string,
  depth: number,
  context: RegionParseContext,
): RegionNode {
  const code = context.code;
  const node = assertObject(raw, path, code);
  assertExactKeys(node, REGION_KEYS, path, code);
  const id = assertPattern(node.id, REGION_ID_PATTERN, `${path}.id`, code);
  if (context.ids.has(id)) fail(code, `${path}.id`);
  context.ids.add(id);
  context.count += 1;
  if (context.count > FRONTEND_LIMITS.maxRegionsPerPage) fail(code, path);

  const type = assertEnum(node.type, FRONTEND_REGION_TYPES, `${path}.type`, code);
  const order = assertInteger(node.order, `${path}.order`, code, 0, 999);
  const confidence = assertNumber(node.confidence, `${path}.confidence`, code, 0, 1);
  const rect = node.rect === undefined ? undefined : parseRect(node.rect, `${path}.rect`, code);

  const rawChildren = assertArray(
    node.children,
    `${path}.children`,
    code,
    0,
    FRONTEND_LIMITS.maxRegionChildren,
  );
  if (rawChildren.length > 0 && depth >= FRONTEND_LIMITS.maxRegionDepth) fail(code, `${path}.children`);
  const children: RegionNode[] = [];
  let previousOrder = -1;
  for (let index = 0; index < rawChildren.length; index += 1) {
    const child = parseRegion(rawChildren[index], `${path}.children[${index}]`, depth + 1, context);
    if (child.order <= previousOrder) fail(code, `${path}.children[${index}].order`);
    previousOrder = child.order;
    children.push(child);
  }

  return { id, type, order, rect, children, confidence };
}

function parseMustKeep(raw: unknown, facts: FrontendFacts, code: FrontendErrorCode): MustKeep[] {
  const rawItems = assertArray(raw, '$.mustKeep', code, 1, FRONTEND_LIMITS.maxMustKeep);
  const capabilityIds = new Set(buildFrontendCapabilityIds(facts));
  const out: MustKeep[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.mustKeep[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, ['kind', 'ref'], path, code);
    const kind = assertEnum(item.kind, ['page', 'action', 'data'] as const, `${path}.kind`, code);
    const ref = assertPattern(item.ref, CAPABILITY_PATTERN, `${path}.ref`, code);
    if (!ref.startsWith(`${kind}:`)) fail(code, `${path}.ref`);
    if (!capabilityIds.has(ref)) fail(code, `${path}.ref`);
    if (out.some((existing) => existing.ref === ref)) fail(code, `${path}.ref`);
    out.push({ kind, ref });
  }
  return out;
}

function parseVisual(raw: unknown, facts: FrontendFacts, code: FrontendErrorCode): VisualSpec {
  const visual = assertObject(raw, '$.visual', code);
  assertExactKeys(visual, VISUAL_KEYS, '$.visual', code);

  const rawTheme = assertObject(visual.theme, '$.visual.theme', code);
  const theme: Record<string, string> = {};
  for (const key of Object.keys(rawTheme)) {
    // 既要求是契约七类 token，也要求能力事实里真的声明了该 token；
    // 模型无权从截图里“发明”一个主题键。
    if (!(FRONTEND_THEME_TOKEN_KEYS as readonly string[]).includes(key)) {
      fail(code, `$.visual.theme.${key}`);
    }
    if (!facts.themeTokens.includes(key)) fail(code, `$.visual.theme.${key}`);
    theme[key] = normalizeHexColor(rawTheme[key], `$.visual.theme.${key}`, code);
  }

  const rawSizes = assertObject(visual.sizes, '$.visual.sizes', code);
  const sizes: Record<string, string> = {};
  for (const key of Object.keys(rawSizes)) {
    if (!facts.sizeKeys.includes(key)) fail(code, `$.visual.sizes.${key}`);
    sizes[key] = assertEnum(rawSizes[key], FRONTEND_SIZE_STEPS, `$.visual.sizes.${key}`, code);
  }

  const density: Density = visual.density === undefined
    ? 'comfortable'
    : assertEnum(visual.density, ['compact', 'comfortable'] as const, '$.visual.density', code);

  return {
    theme: theme as VisualSpec['theme'],
    sizes: sizes as VisualSpec['sizes'],
    density,
  };
}

function parseRequirementPages(
  raw: unknown,
  facts: FrontendFacts,
  options: RequirementValidationOptions,
  code: FrontendErrorCode,
): { pages: RequirementPage[]; regionIds: Set<string> } {
  const rawPages = assertArray(raw, '$.pages', code, 0, FRONTEND_LIMITS.maxPages);
  const pages: RequirementPage[] = [];
  const regionIds = new Set<string>();
  let previousOrder = -1;
  for (let index = 0; index < rawPages.length; index += 1) {
    const path = `$.pages[${index}]`;
    const page = assertObject(rawPages[index], path, code);
    assertExactKeys(page, PAGE_KEYS, path, code);
    if (typeof page.pageId !== 'string' || !(FRONTEND_TARGET_PAGES as readonly string[]).includes(page.pageId)) {
      fail(code, `${path}.pageId`);
    }
    const pageId = page.pageId as FrontendTargetPageId;
    if (pages.some((existing) => existing.pageId === pageId)) fail(code, `${path}.pageId`);
    if (!facts.pageIds.includes(pageId)) fail(code, `${path}.pageId`);
    if (options.targetPages !== undefined && !options.targetPages.includes(pageId)) {
      fail(code, `${path}.pageId`);
    }
    const order = assertInteger(page.order, `${path}.order`, code, 0, 99);
    if (order <= previousOrder) fail(code, `${path}.order`);
    previousOrder = order;
    const layout = assertEnum(page.layout, FRONTEND_LAYOUT_KINDS, `${path}.layout`, code);

    const targetSize = assertObject(page.targetSize, `${path}.targetSize`, code);
    assertExactKeys(targetSize, TARGET_SIZE_KEYS, `${path}.targetSize`, code);
    const width = assertInteger(targetSize.width, `${path}.targetSize.width`, code, 320, 1024);
    const height = assertInteger(targetSize.height, `${path}.targetSize.height`, code, 320, 4096);

    const rawRegions = assertArray(
      page.regions,
      `${path}.regions`,
      code,
      0,
      FRONTEND_LIMITS.maxRegionsPerPage,
    );
    const regions: RegionNode[] = [];
    let previousRegionOrder = -1;
    for (let regionIndex = 0; regionIndex < rawRegions.length; regionIndex += 1) {
      const region = parseRegion(rawRegions[regionIndex], `${path}.regions[${regionIndex}]`, 0, {
        ids: regionIds,
        count: 0,
        code,
      });
      if (region.order <= previousRegionOrder) fail(code, `${path}.regions[${regionIndex}].order`);
      previousRegionOrder = region.order;
      regions.push(region);
    }

    pages.push({ pageId, order, layout, targetSize: { width, height }, regions });
  }
  return { pages, regionIds };
}

function parseBindings(
  raw: unknown,
  facts: FrontendFacts,
  regionIds: Set<string>,
  code: FrontendErrorCode,
): RequirementBinding[] {
  const rawBindings = assertArray(raw, '$.bindings', code, 0, FRONTEND_LIMITS.maxBindings);
  const out: RequirementBinding[] = [];
  for (let index = 0; index < rawBindings.length; index += 1) {
    const path = `$.bindings[${index}]`;
    const binding = assertObject(rawBindings[index], path, code);
    assertExactKeys(binding, BINDING_KEYS, path, code);
    const regionId = assertPattern(binding.regionId, REGION_ID_PATTERN, `${path}.regionId`, code);
    if (!regionIds.has(regionId)) fail(code, `${path}.regionId`);
    const status = assertEnum(binding.status, ['bound', 'unknown'] as const, `${path}.status`, code);

    if (status === 'unknown') {
      if (binding.dataPath !== undefined || binding.eventName !== undefined) fail(code, path);
      out.push({ regionId, status });
      continue;
    }

    const hasDataPath = binding.dataPath !== undefined;
    const hasEventName = binding.eventName !== undefined;
    if (hasDataPath === hasEventName) fail(code, path);
    if (hasDataPath) {
      const dataPath = assertPattern(binding.dataPath, DATA_PATH_PATTERN, `${path}.dataPath`, code);
      if (!facts.dataPaths.includes(dataPath)) fail(code, `${path}.dataPath`);
      out.push({ regionId, dataPath, status });
    } else {
      const eventName = assertPattern(binding.eventName, ACTION_PATTERN, `${path}.eventName`, code);
      if (!facts.actions.includes(eventName)) fail(code, `${path}.eventName`);
      out.push({ regionId, eventName, status });
    }
  }
  return out;
}

function parseUnknownRegions(
  raw: unknown,
  regionIds: Set<string>,
  code: FrontendErrorCode,
): UnknownRegion[] {
  const rawItems = assertArray(raw, '$.unknownRegions', code, 0, FRONTEND_LIMITS.maxUnknownRegions);
  const out: UnknownRegion[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.unknownRegions[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, UNKNOWN_REGION_KEYS, path, code);
    const outItem: UnknownRegion = {
      label: assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars }),
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
    };
    if (item.regionId !== undefined) {
      outItem.regionId = assertPattern(item.regionId, REGION_ID_PATTERN, `${path}.regionId`, code);
      if (!regionIds.has(outItem.regionId)) fail(code, `${path}.regionId`);
    }
    out.push(outItem);
  }
  return out;
}

function parseLowConfidence(
  raw: unknown,
  regionIds: Set<string>,
  code: FrontendErrorCode,
): LowConfidenceRegion[] {
  const rawItems = assertArray(raw, '$.lowConfidence', code, 0, FRONTEND_LIMITS.maxLowConfidence);
  const out: LowConfidenceRegion[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.lowConfidence[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, LOW_CONFIDENCE_KEYS, path, code);
    const regionId = assertPattern(item.regionId, REGION_ID_PATTERN, `${path}.regionId`, code);
    if (!regionIds.has(regionId)) fail(code, `${path}.regionId`);
    out.push({
      regionId,
      confidence: assertNumber(item.confidence, `${path}.confidence`, code, 0, 1),
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
    });
  }
  return out;
}

/**
 * `inferredInteractions` 只描述“看到了什么可交互”，不能携带任何动作/路由名。
 * 否则模型可以把 `home.goMenu` 之类能力名塞进自由文本，绕过绑定事实校验。
 */
function assertNoActionReference(
  text: string,
  path: string,
  facts: FrontendFacts,
  code: FrontendErrorCode,
): void {
  for (const action of facts.actions) {
    if (text.includes(action)) fail(code, path);
  }
  const lowered = text.toLowerCase();
  for (const token of INFERRED_FORBIDDEN_TOKENS) {
    if (lowered.includes(token)) fail(code, path);
  }
}

function parseInferredInteractions(
  raw: unknown,
  facts: FrontendFacts,
  regionIds: Set<string>,
  code: FrontendErrorCode,
): InferredInteraction[] {
  const rawItems = assertArray(raw, '$.inferredInteractions', code, 0, FRONTEND_LIMITS.maxInferredInteractions);
  const out: InferredInteraction[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.inferredInteractions[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, INFERRED_KEYS, path, code);
    const regionId = assertPattern(item.regionId, REGION_ID_PATTERN, `${path}.regionId`, code);
    if (!regionIds.has(regionId)) fail(code, `${path}.regionId`);
    const label = assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars });
    const reason = assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars });
    assertNoActionReference(label, `${path}.label`, facts, code);
    assertNoActionReference(reason, `${path}.reason`, facts, code);
    out.push({ regionId, label, reason });
  }
  return out;
}

function parseUnsupported(
  raw: unknown,
  facts: FrontendFacts,
  code: FrontendErrorCode,
): UnsupportedRequirement[] {
  const rawItems = assertArray(raw, '$.unsupported', code, 0, FRONTEND_LIMITS.maxUnsupported);
  const capabilityIds = new Set(buildFrontendCapabilityIds(facts));
  const out: UnsupportedRequirement[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.unsupported[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, UNSUPPORTED_KEYS, path, code);
    const outItem: UnsupportedRequirement = {
      label: assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars }),
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
    };
    if (item.capability !== undefined) {
      outItem.capability = assertPattern(item.capability, CAPABILITY_PATTERN, `${path}.capability`, code);
      if (!capabilityIds.has(outItem.capability)) fail(code, `${path}.capability`);
    }
    out.push(outItem);
  }
  return out;
}

function parseDegradations(
  raw: unknown,
  regionIds: Set<string>,
  code: FrontendErrorCode,
): Degradation[] {
  const rawItems = assertArray(raw, '$.degradations', code, 0, FRONTEND_LIMITS.maxDegradations);
  const out: Degradation[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.degradations[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, DEGRADATION_KEYS, path, code);
    const outItem: Degradation = {
      label: assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars }),
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
      severity: assertEnum(item.severity, ['info', 'warn'] as const, `${path}.severity`, code),
    };
    if (item.regionId !== undefined) {
      outItem.regionId = assertPattern(item.regionId, REGION_ID_PATTERN, `${path}.regionId`, code);
      if (!regionIds.has(outItem.regionId)) fail(code, `${path}.regionId`);
    }
    out.push(outItem);
  }
  return out;
}

/**
 * 校验 UiRequirement + VisualSpec。`facts` 是服务端注入事实，所有绑定都以其为准。
 * `options.targetPages` 给出时，pages 必须落在目标页内，mustKeep 必须保留每个目标页。
 */
export function validateUiRequirement(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
  options: RequirementValidationOptions = {},
): UiRequirement {
  const facts = validateFrontendFacts(rawFacts);
  const code: FrontendErrorCode = 'FRONTEND_REQUIREMENT_INVALID';
  const root = assertObject(raw, '$', code);
  assertExactKeys(root, REQUIREMENT_KEYS, '$', code);

  const summary = assertPlainText(root.summary, '$.summary', code, { max: FRONTEND_LIMITS.maxSummaryChars });
  const mustKeep = parseMustKeep(root.mustKeep, facts, code);
  const { pages, regionIds } = parseRequirementPages(root.pages, facts, options, code);
  const visual = parseVisual(root.visual, facts, code);
  const bindings = parseBindings(root.bindings, facts, regionIds, code);
  const unknownRegions = parseUnknownRegions(root.unknownRegions, regionIds, code);
  const lowConfidence = parseLowConfidence(root.lowConfidence, regionIds, code);
  const inferredInteractions = parseInferredInteractions(root.inferredInteractions, facts, regionIds, code);
  const unsupported = parseUnsupported(root.unsupported, facts, code);
  const degradations = parseDegradations(root.degradations, regionIds, code);

  if (options.targetPages !== undefined) {
    for (const pageId of options.targetPages) {
      if (!mustKeep.some((item) => item.kind === 'page' && item.ref === `page:${pageId}`)) {
        fail(code, '$.mustKeep');
      }
    }
  }

  return {
    summary,
    mustKeep,
    pages,
    visual,
    bindings,
    unknownRegions,
    lowConfidence,
    inferredInteractions,
    unsupported,
    degradations,
  };
}

// ---------------------------------------------------------------------------
// CapabilityCoverageReport
// ---------------------------------------------------------------------------

const COVERAGE_KEYS = [
  'status',
  'requiredCapabilities',
  'missingCapabilities',
  'coveredBy',
  'risks',
  'degradations',
] as const;
const COVERAGE_RISK_KEYS = ['capability', 'reason'] as const;
const COVERAGE_DEGRADATION_KEYS = ['label', 'reason', 'severity'] as const;

/**
 * 校验能力覆盖报告。
 * 关键防伪造规则：
 * - `covered`/`partial` 时 required 必须全部由同 id 的真实事实覆盖，missing 必须为空；
 * - `rejected` 时必须给出至少一个 missing capability；
 * - `partial` 必须至少有一个可见降级项；
 * - coveredBy 只允许自映射到事实能力 id。
 */
export function validateCapabilityCoverageReport(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
): CapabilityCoverageReport {
  const facts = validateFrontendFacts(rawFacts);
  const code: FrontendErrorCode = 'FRONTEND_COVERAGE_INVALID';
  const root = assertObject(raw, '$', code);
  assertExactKeys(root, COVERAGE_KEYS, '$', code);

  const status = assertEnum(
    root.status,
    ['covered', 'partial', 'rejected'] as const,
    '$.status',
    code,
  );
  const requiredCapabilities = uniqueStrings(
    root.requiredCapabilities,
    '$.requiredCapabilities',
    code,
    CAPABILITY_PATTERN,
    1,
    FRONTEND_LIMITS.maxRequiredCapabilities,
  );
  const missingCapabilities = uniqueStrings(
    root.missingCapabilities,
    '$.missingCapabilities',
    code,
    CAPABILITY_PATTERN,
    0,
    FRONTEND_LIMITS.maxRequiredCapabilities,
  );
  const required = new Set(requiredCapabilities);
  for (const missing of missingCapabilities) {
    if (!required.has(missing)) fail(code, '$.missingCapabilities');
  }

  const rawCoveredBy = assertObject(root.coveredBy, '$.coveredBy', code);
  const factIds = new Set(buildFrontendCapabilityIds(facts));
  const coveredBy: Record<string, string> = {};
  for (const key of Object.keys(rawCoveredBy)) {
    const keyPath = `$.coveredBy.${key}`;
    if (!CAPABILITY_PATTERN.test(key)) fail(code, keyPath);
    if (!required.has(key)) fail(code, keyPath);
    const value = assertPattern(rawCoveredBy[key], CAPABILITY_PATTERN, keyPath, code);
    // 当前能力事实没有别名：required capability 只能由同 id 的事实覆盖。
    if (value !== key) fail(code, keyPath);
    if (!factIds.has(value)) fail(code, keyPath);
    coveredBy[key] = value;
  }

  const rawRisks = assertArray(root.risks, '$.risks', code, 0, FRONTEND_LIMITS.maxCoverageRisks);
  const risks: CoverageRisk[] = [];
  for (let index = 0; index < rawRisks.length; index += 1) {
    const path = `$.risks[${index}]`;
    const item = assertObject(rawRisks[index], path, code);
    assertExactKeys(item, COVERAGE_RISK_KEYS, path, code);
    const capability = assertPattern(item.capability, CAPABILITY_PATTERN, `${path}.capability`, code);
    if (!required.has(capability)) fail(code, `${path}.capability`);
    risks.push({
      capability,
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
    });
  }

  const rawDegradations = assertArray(
    root.degradations,
    '$.degradations',
    code,
    0,
    FRONTEND_LIMITS.maxDegradations,
  );
  const degradations: CoverageDegradation[] = [];
  for (let index = 0; index < rawDegradations.length; index += 1) {
    const path = `$.degradations[${index}]`;
    const item = assertObject(rawDegradations[index], path, code);
    assertExactKeys(item, COVERAGE_DEGRADATION_KEYS, path, code);
    degradations.push({
      label: assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars }),
      reason: assertPlainText(item.reason, `${path}.reason`, code, { max: FRONTEND_LIMITS.maxReasonChars }),
      severity: assertEnum(item.severity, ['info', 'warn'] as const, `${path}.severity`, code),
    });
  }

  if (status === 'covered') {
    if (missingCapabilities.length > 0) fail(code, '$.missingCapabilities');
    if (degradations.length > 0) fail(code, '$.degradations');
    for (const capability of requiredCapabilities) {
      if (coveredBy[capability] === undefined) fail(code, '$.coveredBy');
    }
  } else if (status === 'partial') {
    if (missingCapabilities.length > 0) fail(code, '$.missingCapabilities');
    if (degradations.length === 0) fail(code, '$.degradations');
    for (const capability of requiredCapabilities) {
      if (coveredBy[capability] === undefined) fail(code, '$.coveredBy');
    }
  } else if (missingCapabilities.length === 0) {
    fail(code, '$.missingCapabilities');
  }

  return {
    status,
    requiredCapabilities,
    missingCapabilities,
    coveredBy,
    risks,
    degradations,
  };
}

// ---------------------------------------------------------------------------
// FrontendPackDraft DSL
// ---------------------------------------------------------------------------

interface DraftParseContext {
  facts: FrontendFacts;
  /** 页面级事实；提供时与 P2 loadPageFacts 同源地按页校验组件/插槽/数据路径/动作前缀。 */
  pageFacts?: FrontendPageFacts;
  pageId: FrontendTargetPageId;
  nodeCount: number;
  code: FrontendErrorCode;
}

function assertPageDataPath(
  dataPath: string,
  path: string,
  pageFacts: FrontendPageFacts | undefined,
  code: FrontendErrorCode,
): void {
  if (pageFacts !== undefined && !pageFacts.dataPaths.includes(dataPath)) fail(code, path);
}

function assertPageAction(
  action: string,
  path: string,
  pageId: FrontendTargetPageId,
  pageFacts: FrontendPageFacts | undefined,
  code: FrontendErrorCode,
): void {
  // 与 P2 一致：动作必须属于当前页面；只有提供页面事实时才启用该规则，
  // 以便 P0 契约级单测（2 参）继续只校验全局事实。
  if (pageFacts !== undefined && action.split('.')[0] !== pageId) fail(code, path);
}

function parsePropBinding(
  raw: unknown,
  path: string,
  facts: FrontendFacts,
  pageFacts: FrontendPageFacts | undefined,
  code: FrontendErrorCode,
): DraftPropBinding {
  const binding = assertObject(raw, path, code);
  if (binding.kind === 'data') {
    assertExactKeys(binding, DATA_PROP_KEYS, path, code);
    const dataPath = assertPattern(binding.dataPath, DATA_PATH_PATTERN, `${path}.dataPath`, code);
    if (!facts.dataPaths.includes(dataPath)) fail(code, `${path}.dataPath`);
    assertPageDataPath(dataPath, `${path}.dataPath`, pageFacts, code);
    return { kind: 'data', dataPath };
  }
  if (binding.kind === 'literal') {
    assertExactKeys(binding, LITERAL_PROP_KEYS, path, code);
    const value = binding.value;
    if (value === null || typeof value === 'boolean') return { kind: 'literal', value };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(code, `${path}.value`);
      return { kind: 'literal', value };
    }
    if (typeof value === 'string') {
      return {
        kind: 'literal',
        value: assertPlainText(value, `${path}.value`, code, {
          max: FRONTEND_LIMITS.maxDraftStringChars,
          allowEmpty: true,
        }),
      };
    }
    fail(code, `${path}.value`);
  }
  fail(code, `${path}.kind`);
}

function parseLayoutStyle(
  raw: unknown,
  path: string,
  facts: FrontendFacts,
  code: FrontendErrorCode,
): DraftContainerStyle {
  const style = assertObject(raw, path, code);
  assertExactKeys(style, LAYOUT_STYLE_KEYS, path, code);
  if (Object.keys(style).length === 0) fail(code, path);
  const out: DraftContainerStyle = {};
  if (style.direction !== undefined) {
    out.direction = assertEnum(style.direction, ['row', 'column'] as const, `${path}.direction`, code);
  }
  if (style.align !== undefined) {
    out.align = assertEnum(style.align, ['start', 'center', 'end', 'stretch'] as const, `${path}.align`, code);
  }
  if (style.justify !== undefined) {
    out.justify = assertEnum(
      style.justify,
      ['start', 'center', 'end', 'between', 'around'] as const,
      `${path}.justify`,
      code,
    );
  }
  if (style.gap !== undefined) {
    out.gap = assertEnum(style.gap, ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const, `${path}.gap`, code);
  }
  if (style.padding !== undefined) {
    out.padding = assertEnum(
      style.padding,
      ['none', 'xs', 'sm', 'md', 'lg', 'xl'] as const,
      `${path}.padding`,
      code,
    );
  }
  if (style.radius !== undefined) {
    out.radius = assertEnum(style.radius, ['none', 'sm', 'md', 'lg', 'full'] as const, `${path}.radius`, code);
  }
  if (style.width !== undefined) {
    if (style.width === 'auto' || style.width === 'full') {
      out.width = style.width;
    } else {
      out.width = assertInteger(style.width, `${path}.width`, code, 40, 750);
    }
  }
  if (style.minHeight !== undefined) {
    out.minHeight = assertInteger(style.minHeight, `${path}.minHeight`, code, 0, 2000);
  }
  if (style.backgroundColorToken !== undefined) {
    out.backgroundColorToken = assertEnum(
      style.backgroundColorToken,
      facts.themeTokens as FrontendThemeTokenKey[],
      `${path}.backgroundColorToken`,
      code,
    );
  }
  if (style.borderColorToken !== undefined) {
    out.borderColorToken = assertEnum(
      style.borderColorToken,
      facts.themeTokens as FrontendThemeTokenKey[],
      `${path}.borderColorToken`,
      code,
    );
  }
  return out;
}

function parseTextStyle(
  raw: unknown,
  path: string,
  facts: FrontendFacts,
  code: FrontendErrorCode,
): DraftTextStyle {
  const style = assertObject(raw, path, code);
  assertExactKeys(style, TEXT_STYLE_KEYS, path, code);
  if (Object.keys(style).length === 0) fail(code, path);
  const out: DraftTextStyle = {};
  if (style.size !== undefined) {
    out.size = assertEnum(style.size, FRONTEND_SIZE_STEPS, `${path}.size`, code);
  }
  if (style.weight !== undefined) {
    const weight = style.weight;
    if (weight !== 400 && weight !== 500 && weight !== 600 && weight !== 700) {
      fail(code, `${path}.weight`);
    }
    out.weight = weight;
  }
  if (style.colorToken !== undefined) {
    out.colorToken = assertEnum(
      style.colorToken,
      facts.themeTokens as FrontendThemeTokenKey[],
      `${path}.colorToken`,
      code,
    );
  }
  return out;
}

function parseDraftNode(
  raw: unknown,
  path: string,
  depth: number,
  context: DraftParseContext,
): FrontendDraftNode {
  const { facts, code } = context;
  const node = assertObject(raw, path, code);
  context.nodeCount += 1;
  if (context.nodeCount > FRONTEND_LIMITS.maxDraftNodesPerPage) fail(code, path);
  if (depth > FRONTEND_LIMITS.maxDraftDepth) fail(code, path);
  const type = assertEnum(node.type, FRONTEND_DRAFT_NODE_TYPES, `${path}.type`, code);

  switch (type) {
    case 'component': {
      assertExactKeys(node, COMPONENT_KEYS, path, code);
      const componentId = assertPattern(node.componentId, LOWERCASE_ID_PATTERN, `${path}.componentId`, code);
      const component = facts.components[componentId];
      if (component === undefined) fail(code, `${path}.componentId`);
      // 页面级事实（P2 usingComponents）：home 不能用只在 menu 声明的 cart-bar。
      if (context.pageFacts !== undefined && !context.pageFacts.components.includes(componentId)) {
        fail(code, `${path}.componentId`);
      }

      const rawProps = assertObject(node.props, `${path}.props`, code);
      if (Object.keys(rawProps).length > FRONTEND_LIMITS.maxComponentProps) fail(code, `${path}.props`);
      const props: Record<string, DraftPropBinding> = {};
      for (const propName of Object.keys(rawProps)) {
        if (!component.props.includes(propName)) fail(code, `${path}.props.${propName}`);
        props[propName] = parsePropBinding(
          rawProps[propName],
          `${path}.props.${propName}`,
          facts,
          context.pageFacts,
          code,
        );
      }

      const rawEvents = assertObject(node.events, `${path}.events`, code);
      if (Object.keys(rawEvents).length > FRONTEND_LIMITS.maxComponentEvents) fail(code, `${path}.events`);
      const events: Record<string, string> = {};
      for (const eventName of Object.keys(rawEvents)) {
        if (!component.events.includes(eventName)) fail(code, `${path}.events.${eventName}`);
        const action = assertPattern(rawEvents[eventName], ACTION_PATTERN, `${path}.events.${eventName}`, code);
        if (!facts.actions.includes(action)) fail(code, `${path}.events.${eventName}`);
        assertPageAction(action, `${path}.events.${eventName}`, context.pageId, context.pageFacts, code);
        events[eventName] = action;
      }

      return {
        type,
        componentId,
        props,
        events,
      } satisfies DraftComponentNode;
    }
    case 'slot': {
      assertExactKeys(node, SLOT_KEYS, path, code);
      const slotId = assertPattern(node.slotId, LOWERCASE_ID_PATTERN, `${path}.slotId`, code);
      if (!facts.slots.includes(slotId)) fail(code, `${path}.slotId`);
      if (context.pageFacts !== undefined && !context.pageFacts.slots.includes(slotId)) {
        fail(code, `${path}.slotId`);
      }
      return { type, slotId } satisfies DraftSlotNode;
    }
    case 'container': {
      assertExactKeys(node, CONTAINER_KEYS, path, code);
      const children = assertArray(
        node.children,
        `${path}.children`,
        code,
        1,
        FRONTEND_LIMITS.maxContainerChildren,
      );
      const style = node.style === undefined
        ? undefined
        : parseLayoutStyle(node.style, `${path}.style`, facts, code);
      const parsedChildren: FrontendDraftNode[] = [];
      for (let index = 0; index < children.length; index += 1) {
        parsedChildren.push(parseDraftNode(children[index], `${path}.children[${index}]`, depth + 1, context));
      }
      return { type, style, children: parsedChildren } satisfies DraftContainerNode;
    }
    case 'text': {
      assertExactKeys(node, TEXT_KEYS, path, code);
      const textToken = assertPattern(node.textToken, DATA_PATH_PATTERN, `${path}.textToken`, code);
      if (!facts.dataPaths.includes(textToken)) fail(code, `${path}.textToken`);
      assertPageDataPath(textToken, `${path}.textToken`, context.pageFacts, code);
      const style = node.style === undefined
        ? undefined
        : parseTextStyle(node.style, `${path}.style`, facts, code);
      return { type, textToken, style } satisfies DraftTextNode;
    }
    case 'button': {
      assertExactKeys(node, BUTTON_KEYS, path, code);
      const label = assertPlainText(node.label, `${path}.label`, code, {
        max: FRONTEND_LIMITS.maxButtonLabelChars,
      });
      const action = assertPattern(node.action, ACTION_PATTERN, `${path}.action`, code);
      if (!facts.actions.includes(action)) fail(code, `${path}.action`);
      assertPageAction(action, `${path}.action`, context.pageId, context.pageFacts, code);
      const style = node.style === undefined
        ? undefined
        : parseTextStyle(node.style, `${path}.style`, facts, code);
      return { type, label, action, style } satisfies DraftButtonNode;
    }
    default:
      fail(code, `${path}.type`);
  }
}

function parsePageJson(raw: unknown, path: string, code: FrontendErrorCode): DraftPageJson {
  const pageJson = assertObject(raw, path, code);
  assertExactKeys(pageJson, PAGE_JSON_KEYS, path, code);
  const out: DraftPageJson = {};
  if (pageJson.navigationBarTitleText !== undefined) {
    out.navigationBarTitleText = assertPlainText(pageJson.navigationBarTitleText, `${path}.navigationBarTitleText`, code, {
      max: FRONTEND_LIMITS.maxNavTitleChars,
    });
  }
  if (pageJson.navigationBarBackgroundColor !== undefined) {
    out.navigationBarBackgroundColor = normalizeHexColor(
      pageJson.navigationBarBackgroundColor,
      `${path}.navigationBarBackgroundColor`,
      code,
    );
  }
  if (pageJson.navigationBarTextStyle !== undefined) {
    out.navigationBarTextStyle = assertEnum(
      pageJson.navigationBarTextStyle,
      ['black', 'white'] as const,
      `${path}.navigationBarTextStyle`,
      code,
    );
  }
  if (pageJson.backgroundColor !== undefined) {
    out.backgroundColor = normalizeHexColor(pageJson.backgroundColor, `${path}.backgroundColor`, code);
  }
  if (pageJson.enablePullDownRefresh !== undefined) {
    out.enablePullDownRefresh = assertBoolean(
      pageJson.enablePullDownRefresh,
      `${path}.enablePullDownRefresh`,
      code,
    );
  }
  return out;
}

/**
 * 校验 FrontendPackDraft。所有 component/slot/dataPath/action/theme token 必须命中注入事实；
 * 未知节点类型、原文模板/脚本/URL、路径穿越、未知键、过深/过多节点全部拒绝。
 *
 * 第三参 `rawPageFacts` 提供时（P1 端点/工具/响应校验必须提供），额外执行与桌面 P2
 * `loadPageFacts` 同源的页面级校验：组件/插槽/数据路径必须属于本页，
 * 组件事件与 button 动作必须以本页 pageId 为前缀。
 */
export function validateFrontendPackDraft(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
  rawPageFacts?: FrontendPageFactsMap | unknown,
): FrontendPackDraft {
  const facts = validateFrontendFacts(rawFacts);
  const pageFacts: FrontendPageFactsMap | undefined = rawPageFacts === undefined
    ? undefined
    : validateFrontendPageFactsMap(rawPageFacts);
  const code: FrontendErrorCode = 'FRONTEND_DRAFT_INVALID';
  const root = assertObject(raw, '$', code);
  assertExactKeys(root, DRAFT_KEYS, '$', code);

  if (root.schemaVersion !== FRONTEND_PACK_DRAFT_SCHEMA_VERSION) fail(code, '$.schemaVersion');
  const displayName = assertPlainText(root.displayName, '$.displayName', code, {
    max: FRONTEND_LIMITS.maxDisplayNameChars,
  });

  const rawPages = assertArray(root.pages, '$.pages', code, 1, FRONTEND_LIMITS.maxDraftPages);
  const pages: DraftPage[] = [];
  const pageIds: string[] = [];
  for (let index = 0; index < rawPages.length; index += 1) {
    const path = `$.pages[${index}]`;
    const page = assertObject(rawPages[index], path, code);
    assertExactKeys(page, DRAFT_PAGE_KEYS, path, code);
    if (typeof page.pageId !== 'string' || !(FRONTEND_TARGET_PAGES as readonly string[]).includes(page.pageId)) {
      fail(code, `${path}.pageId`);
    }
    const pageId = page.pageId as FrontendTargetPageId;
    if (pageIds.includes(pageId)) fail(code, `${path}.pageId`);
    if (!facts.pageIds.includes(pageId)) fail(code, `${path}.pageId`);
    pageIds.push(pageId);

    const rawStyles = assertArray(page.styles, `${path}.styles`, code, 0, 0);
    void rawStyles;
    const rawNodes = assertArray(
      page.nodes,
      `${path}.nodes`,
      code,
      1,
      FRONTEND_LIMITS.maxDraftNodesPerPage,
    );
    const context: DraftParseContext = {
      facts,
      ...(pageFacts === undefined ? {} : { pageFacts: pageFacts[pageId] }),
      pageId,
      nodeCount: 0,
      code,
    };
    if (pageFacts !== undefined && pageFacts[pageId] === undefined) fail(code, `${path}.pageId`);
    const nodes: FrontendDraftNode[] = [];
    for (let nodeIndex = 0; nodeIndex < rawNodes.length; nodeIndex += 1) {
      nodes.push(parseDraftNode(rawNodes[nodeIndex], `${path}.nodes[${nodeIndex}]`, 0, context));
    }
    const pageJson = parsePageJson(page.pageJson, `${path}.pageJson`, code);
    pages.push({ pageId, nodes, styles: [], pageJson });
  }

  return {
    schemaVersion: FRONTEND_PACK_DRAFT_SCHEMA_VERSION,
    displayName,
    pages,
  };
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

const RESPONSE_KEYS = [
  'contractVersion',
  'runId',
  'status',
  'requirement',
  'coverage',
  'draft',
  'questions',
  'trace',
  'meta',
] as const;
const QUESTION_KEYS = ['field', 'label', 'text'] as const;
const TRACE_KEYS = ['modelCalls', 'toolCalls', 'stopReason', 'degraded'] as const;
const TOOL_CALL_KEYS = ['name', 'ok'] as const;
const META_KEYS = ['provider', 'model', 'mock', 'latencyMs'] as const;

function parseQuestions(raw: unknown, code: FrontendErrorCode): FrontendQuestion[] {
  const rawItems = assertArray(raw, '$.questions', code, 0, FRONTEND_LIMITS.maxQuestions);
  const out: FrontendQuestion[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const path = `$.questions[${index}]`;
    const item = assertObject(rawItems[index], path, code);
    assertExactKeys(item, QUESTION_KEYS, path, code);
    out.push({
      field: assertPattern(item.field, QUESTION_FIELD_PATTERN, `${path}.field`, code),
      label: assertPlainText(item.label, `${path}.label`, code, { max: FRONTEND_LIMITS.maxLabelChars }),
      text: assertPlainText(item.text, `${path}.text`, code, { max: FRONTEND_LIMITS.maxQuestionChars }),
    });
  }
  return out;
}

function parseTrace(raw: unknown, code: FrontendErrorCode): FrontendTrace {
  const trace = assertObject(raw, '$.trace', code);
  assertExactKeys(trace, TRACE_KEYS, '$.trace', code);
  const modelCalls = assertInteger(
    trace.modelCalls,
    '$.trace.modelCalls',
    code,
    0,
    FRONTEND_LIMITS.maxModelCalls,
  );
  const rawToolCalls = assertArray(
    trace.toolCalls,
    '$.trace.toolCalls',
    code,
    0,
    FRONTEND_LIMITS.maxTraceToolCalls,
  );
  const toolCalls: FrontendTraceToolCall[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const path = `$.trace.toolCalls[${index}]`;
    const item = assertObject(rawToolCalls[index], path, code);
    assertExactKeys(item, TOOL_CALL_KEYS, path, code);
    toolCalls.push({
      name: assertEnum(item.name, FRONTEND_TOOL_NAMES, `${path}.name`, code),
      ok: assertBoolean(item.ok, `${path}.ok`, code),
    });
  }
  return {
    modelCalls,
    toolCalls,
    stopReason: assertEnum(trace.stopReason, FRONTEND_STOP_REASONS, '$.trace.stopReason', code),
    degraded: assertBoolean(trace.degraded, '$.trace.degraded', code),
  };
}

function parseMeta(raw: unknown, code: FrontendErrorCode): FrontendMeta {
  const meta = assertObject(raw, '$.meta', code);
  assertExactKeys(meta, META_KEYS, '$.meta', code);
  const provider = assertPattern(meta.provider, PROVIDER_PATTERN, '$.meta.provider', code);
  const mock = assertBoolean(meta.mock, '$.meta.mock', code);
  let model: string | null = null;
  if (meta.model !== null) {
    model = assertPattern(meta.model, MODEL_PATTERN, '$.meta.model', code);
  } else if (!mock) {
    // 真实 provider 调用必须如实给出实际模型名，不能填 null 冒充。
    fail(code, '$.meta.model');
  }
  return {
    provider,
    model,
    mock,
    latencyMs: assertInteger(meta.latencyMs, '$.meta.latencyMs', code, 0, FRONTEND_LIMITS.maxWallClockMs),
  };
}

/**
 * 统计 FrontendPackDraft 真正用到的能力 id（page/component/slot/action/data）。
 * 供 planned 响应的交叉校验使用，避免“coverage 声称 covered、draft 却删掉了功能”。
 */
export function collectFrontendDraftCapabilities(draft: FrontendPackDraft): Set<string> {
  const used = new Set<string>();
  const walk = (nodes: readonly FrontendDraftNode[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'component': {
          used.add(`component:${node.componentId}`);
          for (const binding of Object.values(node.props)) {
            if (binding.kind === 'data') used.add(`data:${binding.dataPath}`);
          }
          for (const action of Object.values(node.events)) used.add(`action:${action}`);
          break;
        }
        case 'slot': {
          used.add(`slot:${node.slotId}`);
          break;
        }
        case 'container': {
          walk(node.children);
          break;
        }
        case 'text': {
          used.add(`data:${node.textToken}`);
          break;
        }
        case 'button': {
          used.add(`action:${node.action}`);
          break;
        }
        default:
          break;
      }
    }
  };
  for (const page of draft.pages) {
    used.add(`page:${page.pageId}`);
    walk(page.nodes);
  }
  return used;
}

/**
 * C1：planned 响应的交叉校验（P1 契约硬化，t3 复核 medium）。
 *
 * 仅仅“结构合法”不足以证明候选保留了用户要求：
 * - `requirement.mustKeep` 的页面/动作/数据必须真的出现在 draft 里，
 *   不能因为截图没画按钮就静默删掉 Base 关键功能；
 * - `coverage.requiredCapabilities` 每一项都必须被 draft 使用，
 *   服务端计算出的覆盖结论不能和草稿脱节。
 *
 * 违反时以 `FRONTEND_RESPONSE_INVALID`（502）拒绝：这是“组合后的响应不合约”，
 * 与“单字段非法”（422 的 REQUIREMENT/DRAFT/COVERAGE 错误）区分开。
 */
export function assertFrontendPlannedConsistency(
  requirement: UiRequirement,
  coverage: CapabilityCoverageReport,
  draft: FrontendPackDraft,
): void {
  const code: FrontendErrorCode = 'FRONTEND_RESPONSE_INVALID';
  // T16-F1：coverage.requiredCapabilities 必须是 requirement 自身需求的超集。
  // required 由 mustKeep + pages + bindings 的 data/action 重算，模型/服务端都不能漏项。
  const requiredFromRequirement = new Set<string>();
  for (const keep of requirement.mustKeep) requiredFromRequirement.add(keep.ref);
  for (const page of requirement.pages) requiredFromRequirement.add(`page:${page.pageId}`);
  for (const binding of requirement.bindings) {
    if (binding.dataPath !== undefined) requiredFromRequirement.add(`data:${binding.dataPath}`);
    if (binding.eventName !== undefined) requiredFromRequirement.add(`action:${binding.eventName}`);
  }
  const coverageRequired = new Set(coverage.requiredCapabilities);
  const coverageMissing = new Set(coverage.missingCapabilities);
  for (const capability of requiredFromRequirement) {
    if (coverageRequired.has(capability)) continue;
    // rejected 时允许以 missingCapabilities 如实表达“不具备该必需能力”。
    if (coverage.status === 'rejected' && coverageMissing.has(capability)) continue;
    fail(code, '$.coverage.requiredCapabilities');
  }

  const used = collectFrontendDraftCapabilities(draft);
  for (const keep of requirement.mustKeep) {
    if (!used.has(keep.ref)) fail(code, '$.draft');
  }
  for (const capability of coverage.requiredCapabilities) {
    if (!used.has(capability)) fail(code, '$.draft');
  }
}

/**
 * 校验端点响应。`draft` 仅 planned 存在；needs-input 必须有具体问题；
 * rejected 必须由 coverage=rejected 与缺失能力支撑，且绝不携带草稿。
 *
 * C2（P1 契约硬化，t3 复核 medium）：requirement 的视觉降级必须体现在
 * coverage.status 上——covered 不允许携带 degradations；只要存在降级就必须是
 * partial，且 trace.degraded 必须为 true，让桌面端明确“不自动采用/需显式确认”。
 */
export function validateFrontendReconstructResponse(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
  options: RequirementValidationOptions = {},
): FrontendReconstructResponse {
  const facts = validateFrontendFacts(rawFacts);
  const code: FrontendErrorCode = 'FRONTEND_RESPONSE_INVALID';
  // T16-F1：targetPages 是响应交叉校验的必需上下文，缺省/空数组一律 fail closed，
  // 不能因为调用方省略参数就跳过 pages/mustKeep 与 coverage/draft 的一致性检查。
  if (!Array.isArray(options.targetPages) || options.targetPages.length === 0) {
    fail(code, '$.targetPages');
  }
  const root = assertObject(raw, '$', code);
  assertExactKeys(root, RESPONSE_KEYS, '$', code);

  if (root.contractVersion !== FRONTEND_RECONSTRUCT_CONTRACT_VERSION) {
    fail(code, '$.contractVersion');
  }
  const runId = assertPattern(root.runId, RUN_ID_PATTERN, '$.runId', code);
  const status = assertEnum(root.status, FRONTEND_RESPONSE_STATUSES, '$.status', code);
  const requirement = validateUiRequirement(root.requirement, facts, options);
  const coverage = validateCapabilityCoverageReport(root.coverage, facts);
  const questions = parseQuestions(root.questions, code);
  const trace = parseTrace(root.trace, code);
  const meta = parseMeta(root.meta, code);
  const pageFacts = options.pageFacts === undefined
    ? undefined
    : validateFrontendPageFactsMap(options.pageFacts);

  // C2：covered 不允许夹带视觉降级；有降级时 coverage 只能是 partial。
  if (coverage.status === 'covered' && requirement.degradations.length > 0) {
    fail(code, '$.coverage.degradations');
  }

  let draft: FrontendPackDraft | null = null;
  if (status === 'planned') {
    if (root.draft === null || root.draft === undefined) fail(code, '$.draft');
    draft = validateFrontendPackDraft(root.draft, facts, pageFacts);
    if (requirement.pages.length === 0) fail(code, '$.requirement.pages');
    if (coverage.status === 'rejected') fail(code, '$.coverage.status');
    const requirementPages = requirement.pages.map((page) => page.pageId);
    const draftPages = draft.pages.map((page) => page.pageId);
    if (requirementPages.length !== draftPages.length) fail(code, '$.draft.pages');
    for (const pageId of draftPages) {
      if (!requirementPages.includes(pageId)) fail(code, '$.draft.pages');
    }
    // C1：mustKeep 与 coverage.requiredCapabilities 必须真的落在 draft 里。
    assertFrontendPlannedConsistency(requirement, coverage, draft);
    // C2：partial 必须显式标记 degraded，桌面端据此要求用户二次确认。
    if (coverage.status === 'partial' && trace.degraded !== true) fail(code, '$.trace.degraded');
    if (questions.length > 0) fail(code, '$.questions');
  } else {
    if (root.draft !== null) fail(code, '$.draft');
    if (status === 'needs-input' && questions.length === 0) fail(code, '$.questions');
    if (status === 'rejected' && coverage.status !== 'rejected') fail(code, '$.coverage.status');
  }

  return {
    contractVersion: FRONTEND_RECONSTRUCT_CONTRACT_VERSION,
    runId,
    status: status as FrontendResponseStatus,
    requirement,
    coverage,
    draft,
    questions,
    trace,
    meta,
  };
}

/**
 * P1 执行入口的页面事实强制（T20-F2）：
 * 纯契约校验（P0 contract fixture）允许只传全局事实，但 P1 端点/工具/响应组装
 * **必须**通过下面三个 `*ForP1` 入口，缺省 pageFacts 直接 FRONTEND_FACTS_INVALID，
 * 不允许退回“只看全局事实”而接受 P2 会拒绝的跨页草稿。
 */
export function requireFrontendPageFactsForP1(rawPageFacts: unknown): FrontendPageFactsMap {
  if (rawPageFacts === undefined || rawPageFacts === null) {
    throw frontendError('FRONTEND_FACTS_INVALID');
  }
  return validateFrontendPageFactsMap(rawPageFacts);
}

/** P1 草稿执行入口：必须提供页面级事实（与 P2 loadPackagedFacts 同源）。 */
export function validateFrontendPackDraftForP1(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
  rawPageFacts: unknown,
): FrontendPackDraft {
  const pageFacts = requireFrontendPageFactsForP1(rawPageFacts);
  return validateFrontendPackDraft(raw, rawFacts, pageFacts);
}

/** P1 响应组装入口：必须提供页面级事实，否则 fail closed。 */
export function validateFrontendReconstructResponseForP1(
  raw: unknown,
  rawFacts: FrontendFacts | unknown,
  options: RequirementValidationOptions,
): FrontendReconstructResponse {
  const pageFacts = requireFrontendPageFactsForP1(options.pageFacts);
  return validateFrontendReconstructResponse(raw, rawFacts, { ...options, pageFacts });
}

/** 供上层做状态名合法性检查（避免把任意字符串写入运行状态）。 */
export function isFrontendStateName(value: unknown): value is (typeof FRONTEND_STATES)[number] {
  return typeof value === 'string' && (FRONTEND_STATES as readonly string[]).includes(value);
}
