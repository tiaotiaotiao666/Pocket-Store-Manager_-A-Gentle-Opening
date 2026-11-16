import { HttpException, HttpStatus } from '@nestjs/common';
import { validateAgentImages } from './agent-image.validator';
import type { ValidatedAgentImages } from './agent-image.validator';
import type { ContractDraft } from './agent.types';

/**
 * `screen-reference.v1`：别人的小程序截图 → 可复用布局/组件识别（P3）。
 *
 * 设计边界：
 * - 复用 `/api/v1/agent/turn` 与 `validateAgentImages`（`kind='reference'`），
 *   不新开图片上传通路；
 * - 客户端必须带白名单目录（catalog），模型只能从中挑 id；
 * - 服务端对模型输出做**白名单裁剪**：未知 id / 未知样式键一律丢弃并计入 `rejected`，
 *   绝不把模型文本当组件、样式或代码使用；
 * - 视觉能力不可用时（`visionAnalyzed !== true`）返回 `status: 'unavailable'`，
 *   不返回任何编造的识别结果。
 */

export const SCREEN_REFERENCE_CONTRACT_VERSION = 'screen-reference.v1';

/** 请求体允许的顶层键：未知键整包拒绝。 */
const ALLOWED_REQUEST_KEYS: readonly string[] = Object.freeze([
  'contractVersion',
  'utterance',
  'draft',
  'images',
  'client',
  'projectId',
  'catalog',
  'catalogVersion',
  'requestId',
]);

const MAX_CATALOG_ENTRIES = 64;
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,39}$/;
const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const SIZE_STEPS: readonly string[] = Object.freeze(['sm', 'md', 'lg']);
const SIZE_KEYS: readonly string[] = Object.freeze(['homeHero', 'productCard', 'carousel']);
const MAX_APPROXIMATE = 6;
const MAX_UNSUPPORTED = 8;
const MAX_TEXT = 240;

export interface ScreenReferenceCatalog {
  version: string;
  recipeIds: string[];
  featureIds: string[];
  themeKeys: string[];
}

export interface ParsedScreenReferenceRequest {
  images: ValidatedAgentImages;
  catalog: ScreenReferenceCatalog;
}

export interface ScreenReferenceItem {
  id: string;
  reason?: string;
}

export interface ScreenReferenceRecognition {
  layouts: string[];
  components: string[];
  style: { theme: Record<string, string>; sizes: Record<string, string> };
  approximate: ScreenReferenceItem[];
  unsupported: ScreenReferenceItem[];
  notes: string;
}

export interface ScreenReferenceRejection {
  id: string;
  reason: string;
  source: 'layout' | 'component' | 'style' | 'recognition';
}

export interface ScreenReferenceResponse {
  contractVersion: string;
  /** ok = 有识别结果；unavailable = 视觉能力不可用，不编造结果。 */
  status: 'ok' | 'unavailable';
  recognition: ScreenReferenceRecognition | null;
  rejected: ScreenReferenceRejection[];
  meta: {
    analyzed: boolean;
    model: string | null;
    latencyMs: number | null;
    runId: string;
    totalBytes: number;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectRequest(message: string): never {
  throw new HttpException({ code: 'AGENT_REQUEST_INVALID', message }, HttpStatus.BAD_REQUEST);
}

function readStringArray(value: unknown, field: string, limit: number, pattern: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) rejectRequest(`${field} 必须是字符串数组。`);
  if (value.length > limit) rejectRequest(`${field} 条目过多。`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      rejectRequest(`${field} 存在非法条目。`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * 解析 `screen-reference.v1` 请求：严格白名单 + 恰好一张参考截图。
 */
export function parseScreenReferenceRequest(raw: unknown): ParsedScreenReferenceRequest {
  if (!isPlainObject(raw)) rejectRequest('请求体必须是 JSON 对象。');
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REQUEST_KEYS.includes(key)) rejectRequest('请求体包含未知字段。');
  }
  if (raw.contractVersion !== SCREEN_REFERENCE_CONTRACT_VERSION) {
    rejectRequest('contractVersion 必须是 screen-reference.v1。');
  }
  const rawCatalog = raw.catalog;
  if (!isPlainObject(rawCatalog)) rejectRequest('缺少白名单目录 catalog。');

  const catalog: ScreenReferenceCatalog = {
    version: typeof rawCatalog.version === 'string' ? rawCatalog.version.slice(0, 40) : '',
    recipeIds: readStringArray(rawCatalog.recipeIds, 'catalog.recipeIds', MAX_CATALOG_ENTRIES, ID_PATTERN),
    featureIds: readStringArray(rawCatalog.featureIds, 'catalog.featureIds', MAX_CATALOG_ENTRIES, ID_PATTERN),
    themeKeys: readStringArray(rawCatalog.themeKeys, 'catalog.themeKeys', MAX_CATALOG_ENTRIES, /^[a-zA-Z][a-zA-Z0-9.]{0,39}$/),
  };
  if (catalog.recipeIds.length === 0 || catalog.featureIds.length === 0) {
    rejectRequest('catalog 不能为空。');
  }

  const images = validateAgentImages(raw.images);
  if (images.referenceImages !== 1 || images.images.length !== 1) {
    rejectRequest('参考截图必须且只能 1 张（kind="reference"）。');
  }

  return { images, catalog };
}

/** 识别提示词：只允许从白名单挑 id，且必须输出固定 JSON 形状。 */
export function buildScreenReferenceUtterance(catalog: ScreenReferenceCatalog): string {
  return [
    '任务：参考截图分析（只做布局与组件识别，不复刻文案、图片、品牌素材）。',
    `可选布局 id（layouts）：${catalog.recipeIds.join(', ')}`,
    `可选组件 id（components）：${catalog.featureIds.join(', ')}`,
    `可选主题色键（style.theme）：${catalog.themeKeys.join(', ')}（值必须是 #RRGGBB）`,
    `可选尺寸档位（style.sizes）：${SIZE_KEYS.join(', ')}，取值 ${SIZE_STEPS.join('/')}`,
    '只输出 JSON：{"layouts":[],"components":[],"style":{"theme":{},"sizes":{}},"approximate":[{"id":"","reason":""}],"unsupported":[{"id":"","reason":""}],"notes":""}',
    '无法用现有组件表达的部分放 unsupported；能对上但只能近似的放 approximate；不要输出任何代码。',
  ].join('\n');
}

export const SCREEN_REFERENCE_EMPTY_DRAFT: ContractDraft = {
  storeName: '',
  category: '',
  businessHours: '',
  fulfillment: { dineIn: false, takeaway: false },
  dishes: [],
};

function clipText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function collectIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, limit)) {
    const id = typeof entry === 'string'
      ? entry
      : isPlainObject(entry) && typeof entry.id === 'string'
        ? entry.id
        : '';
    if (id) out.push(id);
  }
  return out;
}

/**
 * 白名单裁剪模型输出。
 *
 * 任何不在 catalog 里的 id、任何非 #RRGGBB 颜色、任何未知尺寸键都会被丢掉，
 * 并记录到 `rejected`（前端会展示成「未采纳」），不做静默替换。
 */
export function validateScreenReferenceRecognition(
  raw: unknown,
  catalog: ScreenReferenceCatalog,
): { recognition: ScreenReferenceRecognition; rejected: ScreenReferenceRejection[] } {
  const input = isPlainObject(raw) ? raw : {};
  const rejected: ScreenReferenceRejection[] = [];
  const recipeIds = new Set(catalog.recipeIds);
  const featureIds = new Set(catalog.featureIds);
  const themeKeys = new Set(catalog.themeKeys);

  const layouts: string[] = [];
  for (const id of collectIds(input.layouts, 8)) {
    if (!recipeIds.has(id)) {
      rejected.push({ id, reason: '不在已验证布局白名单', source: 'layout' });
      continue;
    }
    if (!layouts.includes(id)) layouts.push(id);
  }

  const components: string[] = [];
  for (const id of collectIds(input.components, 32)) {
    if (!featureIds.has(id)) {
      rejected.push({ id, reason: '不在已验证组件白名单', source: 'component' });
      continue;
    }
    if (!components.includes(id)) components.push(id);
  }

  const theme: Record<string, string> = {};
  const sizes: Record<string, string> = {};
  const rawStyle = isPlainObject(input.style) ? input.style : {};
  const rawTheme = isPlainObject(rawStyle.theme) ? rawStyle.theme : {};
  for (const key of Object.keys(rawTheme)) {
    if (!themeKeys.has(key)) {
      rejected.push({ id: `theme.${key}`, reason: '不在样式白名单', source: 'style' });
      continue;
    }
    const value = rawTheme[key];
    if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
      rejected.push({ id: `theme.${key}`, reason: '颜色必须是 #RRGGBB', source: 'style' });
      continue;
    }
    theme[key] = value.toUpperCase();
  }
  const rawSizes = isPlainObject(rawStyle.sizes) ? rawStyle.sizes : {};
  for (const key of Object.keys(rawSizes)) {
    if (!SIZE_KEYS.includes(key)) {
      rejected.push({ id: `sizes.${key}`, reason: '不在尺寸白名单', source: 'style' });
      continue;
    }
    const value = rawSizes[key];
    if (typeof value !== 'string' || !SIZE_STEPS.includes(value)) {
      rejected.push({ id: `sizes.${key}`, reason: '尺寸只能是 sm/md/lg', source: 'style' });
      continue;
    }
    sizes[key] = value;
  }

  const readItems = (value: unknown, limit: number): ScreenReferenceItem[] => {
    if (!Array.isArray(value)) return [];
    const out: ScreenReferenceItem[] = [];
    for (const entry of value.slice(0, limit)) {
      const id = clipText(isPlainObject(entry) ? (entry.id ?? entry.label) : entry);
      const reason = clipText(isPlainObject(entry) ? entry.reason : '');
      if (!id && !reason) continue;
      out.push({ id: id || '未命名项', reason: reason || '当前模板体系里没有对应实现。' });
    }
    return out;
  };

  if (layouts.length === 0 && components.length === 0 && rejected.length === 0) {
    rejected.push({
      id: 'recognition',
      reason: '模型没有按识别契约返回任何可用 id',
      source: 'recognition',
    });
  }

  return {
    recognition: {
      layouts,
      components,
      style: { theme, sizes },
      approximate: readItems(input.approximate, MAX_APPROXIMATE),
      unsupported: readItems(input.unsupported, MAX_UNSUPPORTED),
      notes: clipText(input.notes),
    },
    rejected,
  };
}
