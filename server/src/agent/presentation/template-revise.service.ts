import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ContractDraft, ContractDish } from '../agent.types';
import { DeepseekPresentationProvider } from './template-revise.provider';
import type { PresentationImageInput, PresentationReviseInput } from './template-revise.provider';
import {
  countCodePoints,
  mergePresentationPatch,
  validatePresentationPatch,
} from './presentation-patch';
import type {
  PresentationChangeItem,
  PresentationPatch,
  PresentationPatchContext,
  PresentationPatchDetail,
  PresentationPatchResult,
  SlotPlacementPatch,
} from './presentation-patch';

/**
 * `agent-template-revise.v1` 服务（plan.md 2.2.8）。
 *
 * 关键安全点：服务端只把模型输出当成“候选补丁”，
 * 必须与 basePatch 合并后再用 C-PRESENTATION-PATCH@1 规则重新校验，
 * 并且 changes 完全由服务端 `diffPresentationPatch` 重算；
 * 模型自述的 changes / patch 之外的字段一律丢弃。
 *
 * 本服务不写数据库、不发布会话状态、不执行模型给出的代码。
 */

export const TEMPLATE_REVISE_CONTRACT_VERSION = 'agent-template-revise.v1';

export const TEMPLATE_IDS = Object.freeze(['warm-bistro', 'modern-coffee', 'signature-kitchen'] as const);
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type TemplateLayout = 'menu' | 'catalog' | 'editorial';

/** 3 套模板与 layout 的固定对应关系（与前端 TEMPLATE_LAYOUTS 一致）。 */
export const TEMPLATE_LAYOUTS: Readonly<Record<TemplateId, TemplateLayout>> = Object.freeze({
  'warm-bistro': 'menu',
  'modern-coffee': 'catalog',
  'signature-kitchen': 'editorial',
});

/** 当前唯一可移动 feature；kind 与 poster-carousel manifest 一致。 */
export const SUPPORTED_FEATURE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  'poster-carousel': 'feature-pack',
});

/** 允许的目标插槽 → 所属页面（plan.md 2.2.2 落位表）。 */
const SLOT_PAGE: Readonly<Record<string, string>> = Object.freeze({
  'home-hero': 'home',
  'home-marketing': 'home',
  'menu-hero': 'menu',
  'menu-aside': 'menu',
});

const IMAGE_MEDIA_TYPES: readonly string[] = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAX_UTTERANCE_LENGTH = 500;
const MAX_PLAN_FEATURES = 3;
const MAX_IMAGES = 1;
const MAX_IMAGE_BYTES = 409600;
const MAX_IMAGE_TOTAL_BYTES = 1048576;
const MAX_BASE_DRAFT_DISHES = 50;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const REQUEST_KEYS = new Set<string>([
  'contractVersion',
  'utterance',
  'candidate',
  'planFeatures',
  'basePatch',
  'baseDraft',
  'images',
  'client',
  'projectId',
]);

export interface TemplateReviseRequest {
  contractVersion: typeof TEMPLATE_REVISE_CONTRACT_VERSION;
  utterance: string;
  candidate: { templateId: TemplateId; layout: TemplateLayout };
  planFeatures: SlotPlacementPatch[];
  basePatch: PresentationPatch;
  baseDraft: ContractDraft;
  images: PresentationImageInput[];
  client: { surface: 'desktop'; phase: 'template-pick' };
  projectId: null;
}

export interface TemplateReviseResponse {
  contractVersion: typeof TEMPLATE_REVISE_CONTRACT_VERSION;
  turnId: string;
  reply: string;
  patch: PresentationPatch;
  changes: PresentationChangeItem[];
  meta: {
    transport: 'http';
    provider: string;
    mock: false;
    model: string | null;
    latencyMs: number;
  };
}

export interface TemplateReviseContext {
  requestId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function reject(path: string, message: string): never {
  throw new HttpException(
    {
      code: 'AGENT_REQUEST_INVALID',
      message,
      details: [{ path, code: 'AGENT_REQUEST_INVALID', message }],
    },
    HttpStatus.BAD_REQUEST,
  );
}

/** 422：补丁任何一处不合法都整包失败，无部分应用。 */
function rejectPatch(result: { code: string; details: PresentationPatchDetail[] }): never {
  throw new HttpException(
    {
      code: result.code,
      message: result.details[0]?.message ?? '展示补丁不合法，请换一种说法重试。',
      details: result.details,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function normalizeCandidate(raw: unknown): { templateId: TemplateId; layout: TemplateLayout } {
  if (!isPlainObject(raw)) reject('candidate', 'candidate 必须是对象。');
  const rawTemplateId = raw.templateId;
  const templateId = typeof rawTemplateId === 'string' ? rawTemplateId : '';
  if (!TEMPLATE_IDS.includes(templateId as TemplateId)) {
    reject('candidate.templateId', 'candidate.templateId 不是已知模板。');
  }
  const expectedLayout = TEMPLATE_LAYOUTS[templateId as TemplateId];
  const rawLayout = raw.layout;
  const layout = typeof rawLayout === 'string' ? rawLayout : expectedLayout;
  if (layout !== expectedLayout) {
    reject('candidate.layout', 'candidate.layout 与 templateId 不匹配。');
  }
  return { templateId: templateId as TemplateId, layout: expectedLayout };
}

function normalizePlanFeatures(raw: unknown): SlotPlacementPatch[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) reject('planFeatures', 'planFeatures 必须是数组。');
  if (raw.length > MAX_PLAN_FEATURES) {
    reject('planFeatures', `planFeatures 最多 ${MAX_PLAN_FEATURES} 条。`);
  }

  const seen = new Set<string>();
  return raw.map((feature, index) => {
    if (!isPlainObject(feature)) reject(`planFeatures[${index}]`, 'planFeatures 每项必须是对象。');
    const featureId = typeof feature.featureId === 'string' ? feature.featureId : '';
    if (!hasOwn(SUPPORTED_FEATURE_KINDS, featureId)) {
      reject(`planFeatures[${index}].featureId`, `暂不支持的 feature：${featureId || '(空)'}。`);
    }
    if (seen.has(featureId)) {
      reject(`planFeatures[${index}].featureId`, `planFeatures 中 feature 重复：${featureId}。`);
    }
    seen.add(featureId);

    const pageId = typeof feature.pageId === 'string' ? feature.pageId : '';
    const slotId = typeof feature.slotId === 'string' ? feature.slotId : '';
    if (!hasOwn(SLOT_PAGE, slotId)) {
      reject(`planFeatures[${index}].slotId`, `未知插槽：${slotId || '(空)'}。`);
    }
    if (SLOT_PAGE[slotId] !== pageId) {
      reject(`planFeatures[${index}].pageId`, `插槽 ${slotId} 与页面 ${pageId || '(空)'} 不匹配。`);
    }

    return {
      featureId,
      pageId: pageId as SlotPlacementPatch['pageId'],
      slotId: slotId as SlotPlacementPatch['slotId'],
    };
  });
}

function normalizeBaseDraft(raw: unknown): ContractDraft {
  if (raw === undefined || raw === null) {
    return {
      storeName: '',
      category: '',
      businessHours: '',
      fulfillment: { dineIn: false, takeaway: false },
      dishes: [],
    };
  }
  if (!isPlainObject(raw)) reject('baseDraft', 'baseDraft 必须是对象。');

  const rawDishes = raw.dishes;
  if (rawDishes !== undefined && !Array.isArray(rawDishes)) {
    reject('baseDraft.dishes', 'baseDraft.dishes 必须是数组。');
  }
  const dishes: ContractDish[] = [];
  if (Array.isArray(rawDishes)) {
    if (rawDishes.length > MAX_BASE_DRAFT_DISHES) {
      reject('baseDraft.dishes', `baseDraft.dishes 最多 ${MAX_BASE_DRAFT_DISHES} 道菜。`);
    }
    rawDishes.forEach((dish, index) => {
      if (!isPlainObject(dish)) reject(`baseDraft.dishes[${index}]`, '菜品必须是对象。');
      const id = typeof dish.id === 'string' ? dish.id.normalize('NFC').trim() : '';
      if (!id) reject(`baseDraft.dishes[${index}].id`, '菜品必须包含字符串 id。');
      dishes.push({
        id,
        name: typeof dish.name === 'string' ? dish.name : '',
        priceCents: typeof dish.priceCents === 'number' ? dish.priceCents : null,
        description: typeof dish.description === 'string' ? dish.description : '',
      });
    });
  }

  const fulfillment = isPlainObject(raw.fulfillment) ? raw.fulfillment : {};
  return {
    storeName: typeof raw.storeName === 'string' ? raw.storeName : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    businessHours: typeof raw.businessHours === 'string' ? raw.businessHours : '',
    fulfillment: {
      dineIn: fulfillment.dineIn === true,
      takeaway: fulfillment.takeaway === true,
    },
    dishes,
  };
}

/** 解码 base64 并返回真实字节数；不使用客户端声明的 bytes。 */
function normalizeImages(raw: unknown): PresentationImageInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) reject('images', 'images 必须是数组。');
  if (raw.length > MAX_IMAGES) {
    throw new HttpException(
      { code: 'AGENT_IMAGE_COUNT_EXCEEDED', message: `本轮最多携带 ${MAX_IMAGES} 张门店环境照。` },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  let totalBytes = 0;
  return raw.map((image, index) => {
    if (!isPlainObject(image)) reject(`images[${index}]`, 'images 每项必须是对象。');
    if (image.kind !== 'store') {
      reject(`images[${index}].kind`, '本轮只允许门店环境照（kind=store）。');
    }
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType : '';
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
      throw new HttpException(
        { code: 'AGENT_IMAGE_TYPE_UNSUPPORTED', message: '图片类型不在白名单内。' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const data = typeof image.data === 'string' ? image.data : '';
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
      throw new HttpException(
        { code: 'AGENT_IMAGE_INVALID', message: '图片缺少合法的 base64 数据。' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const decoded = Buffer.from(data, 'base64');
    if (decoded.length < 1 || decoded.length > MAX_IMAGE_BYTES) {
      throw new HttpException(
        { code: 'AGENT_IMAGE_TOO_LARGE', message: '单张图片解码后不能超过 400 KiB。' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    totalBytes += decoded.length;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new HttpException(
        { code: 'AGENT_IMAGE_TOO_LARGE', message: '图片总大小不能超过 1 MiB。' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return {
      kind: 'store' as const,
      mediaType: mediaType as PresentationImageInput['mediaType'],
      data,
    };
  });
}

/** 严格解析请求；任一失败 → 400，不调用模型。 */
export function parseTemplateReviseRequest(raw: unknown): TemplateReviseRequest {
  if (!isPlainObject(raw)) reject('', '请求体必须是 JSON 对象。');

  for (const key of Object.keys(raw)) {
    if (!REQUEST_KEYS.has(key)) reject(key, `未知的请求字段：${key}。`);
  }

  if (raw.contractVersion !== TEMPLATE_REVISE_CONTRACT_VERSION) {
    reject('contractVersion', `contractVersion 必须为 ${TEMPLATE_REVISE_CONTRACT_VERSION}。`);
  }

  const utterance = typeof raw.utterance === 'string' ? raw.utterance.trim() : '';
  const utteranceLength = countCodePoints(utterance);
  if (utteranceLength < 1 || utteranceLength > MAX_UTTERANCE_LENGTH) {
    reject('utterance', `utterance 必须是 1–${MAX_UTTERANCE_LENGTH} 个字符的文本。`);
  }

  const candidate = normalizeCandidate(raw.candidate);
  const planFeatures = normalizePlanFeatures(raw.planFeatures);

  const basePatch: unknown = raw.basePatch === undefined ? {} : raw.basePatch;
  if (!isPlainObject(basePatch)) reject('basePatch', 'basePatch 必须是对象。');

  const baseDraft = normalizeBaseDraft(raw.baseDraft);
  const images = normalizeImages(raw.images);

  if (!isPlainObject(raw.client) || raw.client.surface !== 'desktop' || raw.client.phase !== 'template-pick') {
    reject('client', 'client 必须为 {"surface":"desktop","phase":"template-pick"}。');
  }

  if (raw.projectId !== null && raw.projectId !== undefined) {
    reject('projectId', '本轮 projectId 固定为 null。');
  }

  return {
    contractVersion: TEMPLATE_REVISE_CONTRACT_VERSION,
    utterance,
    candidate,
    planFeatures,
    basePatch: basePatch as PresentationPatch,
    baseDraft,
    images,
    client: { surface: 'desktop', phase: 'template-pick' },
    projectId: null,
  };
}

/** 由 planFeatures + baseDraft 构造 2.2.4 校验上下文。 */
export function buildTemplateRevisePatchContext(request: TemplateReviseRequest): PresentationPatchContext {
  return {
    occupiedFeatures: request.planFeatures.map((feature) => ({
      id: feature.featureId,
      kind: SUPPORTED_FEATURE_KINDS[feature.featureId] ?? '',
    })),
    hasCarousel: request.planFeatures.some((feature) => feature.featureId === 'poster-carousel'),
    baseDraft: { dishes: request.baseDraft.dishes.map((dish) => ({ id: dish.id })) },
  };
}

function ensurePatch(
  result: PresentationPatchResult,
): asserts result is Extract<PresentationPatchResult, { ok: true }> {
  if (!result.ok) rejectPatch(result);
}

@Injectable()
export class TemplateReviseService {
  private readonly logger = new Logger('TemplateReviseService');

  constructor(@Inject(DeepseekPresentationProvider) private readonly provider: DeepseekPresentationProvider) {}

  async revise(raw: unknown, context: TemplateReviseContext): Promise<TemplateReviseResponse> {
    const startedAt = Date.now();
    const request = parseTemplateReviseRequest(raw);
    const patchContext = buildTemplateRevisePatchContext(request);

    // 先校验当前已接受补丁；它不合法说明调用方状态已损坏，整包拒绝且不调用模型。
    const baseCheck = validatePresentationPatch(request.basePatch, patchContext);
    ensurePatch(baseCheck);

    const providerInput: PresentationReviseInput = {
      requestId: context.requestId,
      utterance: request.utterance,
      candidate: request.candidate,
      planFeatures: request.planFeatures,
      basePatch: baseCheck.patch,
      baseDraft: request.baseDraft,
      images: request.images,
    };
    const providerResult = await this.provider.revisePatch(providerInput);

    // 服务端合并 + 重新校验；模型自述的 changes 一律不采用。
    const mergeResult = mergePresentationPatch(baseCheck.patch, providerResult.modelPatch, patchContext);
    ensurePatch(mergeResult);

    const changes = mergeResult.changes;
    const turnId = `turn-${randomUUID()}`;
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const reply = providerResult.reply
      ? Array.from(providerResult.reply).slice(0, 200).join('')
      : `已更新 ${changes.length} 项展示。`;

    this.logger.log(
      `template revise requestId=${context.requestId} turnId=${turnId} model=${providerResult.model} latencyMs=${latencyMs} utteranceLength=${countCodePoints(request.utterance)} imageCount=${request.images.length} changeCount=${changes.length}`,
    );

    return {
      contractVersion: TEMPLATE_REVISE_CONTRACT_VERSION,
      turnId,
      reply,
      patch: mergeResult.patch,
      changes,
      meta: {
        transport: 'http',
        provider: this.provider.name,
        mock: false,
        model: providerResult.model,
        latencyMs,
      },
    };
  }
}