import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * agent-turn.v2 图片入参校验（对应契约 C-AGENT-TURN-V2@1 / 计划 2.2.7）。
 *
 * 安全要点：
 * - 只相信服务端用 `Buffer.from(data, 'base64')` 解码后的真实字节数，
 *   绝不读取客户端可能伪造的 `bytes` 字段；
 * - 任一图片不合规 → 整包拒绝（422/400），调用方因此拿不到任何部分草稿；
 * - 校验失败的错误体只包含稳定错误码与固定中文文案，不回填客户端内容，
 *   以免把 base64 或超长字段名反射到日志/响应里。
 */

/** v2 允许的图片来源类型。 */
export const AGENT_IMAGE_KINDS = ['menu', 'store'] as const;
export type AgentImageKind = (typeof AGENT_IMAGE_KINDS)[number];

/** 图片张数 / 体积上限（字节均为解码后的真实大小）。 */
export const AGENT_IMAGE_LIMITS = Object.freeze({
  maxMenuImages: 2,
  maxStoreImages: 1,
  maxTotalImages: 3,
  maxImageBytes: 409600,
  maxTotalBytes: 1048576,
  maxBodyBytes: 2097152,
});

/** 允许的 MIME 白名单。 */
export const AGENT_IMAGE_MEDIA_TYPES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** 严格 base64：仅允许标准字符表与 0–2 个尾部填充，长度必须是 4 的倍数。 */
export const AGENT_IMAGE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 图片元素允许出现的键；出现其他键视为整包非法。 */
const ALLOWED_IMAGE_KEYS: readonly string[] = Object.freeze([
  'kind',
  'mediaType',
  'data',
  'dataBase64',
]);

/** 校验通过后的图片描述，直接用于构造多模态 content。 */
export interface ValidatedAgentImage {
  kind: AgentImageKind;
  mediaType: string;
  /** 纯 base64（不含 `data:` 前缀）。 */
  data: string;
  /** 解码后的真实字节数。 */
  bytes: number;
}

export interface ValidatedAgentImages {
  images: ValidatedAgentImage[];
  menuImages: number;
  storeImages: number;
  totalBytes: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reject(code: string, message: string, status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY): never {
  throw new HttpException({ code, message }, status);
}

function emptyResult(): ValidatedAgentImages {
  return { images: [], menuImages: 0, storeImages: 0, totalBytes: 0 };
}

const COUNT_MESSAGE = '图片数量超出限制：菜单照最多 2 张、环境照最多 1 张、合计最多 3 张。';
const TYPE_MESSAGE = '仅支持 JPEG、PNG、WebP 图片。';
const INVALID_MESSAGE = '图片数据不是合法的 base64。';
const TOO_LARGE_MESSAGE = '图片过大，请压缩后重试。';

function readImageData(item: Record<string, unknown>): string | null {
  const hasData = typeof item.data === 'string';
  const hasAlias = typeof item.dataBase64 === 'string';
  // 同时给两个字段会让“以哪个为准”变得不确定，直接整包拒绝。
  if (hasData && hasAlias) {
    reject('AGENT_REQUEST_INVALID', '请求体包含不支持的图片字段组合。', HttpStatus.BAD_REQUEST);
  }
  if (hasData) return item.data as string;
  if (hasAlias) return item.dataBase64 as string;
  return null;
}

/**
 * 校验 v2 请求里的 `images`。
 *
 * - `undefined` / `null` 视为没有图片，返回空结构（v2 允许只发文字）；
 * - 非数组、元素非对象、未知键、未知 kind → 400 `AGENT_REQUEST_INVALID`；
 * - 张数超限 → 422 `AGENT_IMAGE_COUNT_EXCEEDED`；
 * - MIME 不在白名单 → 422 `AGENT_IMAGE_TYPE_UNSUPPORTED`；
 * - base64 非严格合法 → 422 `AGENT_IMAGE_INVALID`；
 * - 单张或合计解码超限 → 422 `AGENT_IMAGE_TOO_LARGE`。
 */
export function validateAgentImages(raw: unknown): ValidatedAgentImages {
  if (raw === undefined || raw === null) return emptyResult();
  if (!Array.isArray(raw)) {
    reject('AGENT_REQUEST_INVALID', 'images 必须是数组。', HttpStatus.BAD_REQUEST);
  }

  const items: Record<string, unknown>[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) {
      reject('AGENT_REQUEST_INVALID', 'images 的每一项都必须是对象。', HttpStatus.BAD_REQUEST);
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_IMAGE_KEYS.includes(key)) {
        reject('AGENT_REQUEST_INVALID', 'images 包含未知字段。', HttpStatus.BAD_REQUEST);
      }
    }
    items.push(entry);
  }

  // 1) 先做张数校验（契约表格顺序：张数 → MIME → base64 → 单张 → 合计）。
  let menuImages = 0;
  let storeImages = 0;
  const kinds: AgentImageKind[] = [];
  for (const item of items) {
    const kind = item.kind;
    if (kind !== 'menu' && kind !== 'store') {
      reject('AGENT_REQUEST_INVALID', 'images.kind 只能是 "menu" 或 "store"。', HttpStatus.BAD_REQUEST);
    }
    kinds.push(kind);
    if (kind === 'menu') menuImages += 1;
    else storeImages += 1;
  }
  if (
    menuImages > AGENT_IMAGE_LIMITS.maxMenuImages
    || storeImages > AGENT_IMAGE_LIMITS.maxStoreImages
    || items.length > AGENT_IMAGE_LIMITS.maxTotalImages
  ) {
    reject('AGENT_IMAGE_COUNT_EXCEEDED', COUNT_MESSAGE);
  }

  // 2) 逐张校验 MIME / base64 / 单张大小，同时累计合计大小。
  const images: ValidatedAgentImage[] = [];
  let totalBytes = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const mediaType = item.mediaType;
    if (typeof mediaType !== 'string' || !AGENT_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      reject('AGENT_IMAGE_TYPE_UNSUPPORTED', TYPE_MESSAGE);
    }

    const data = readImageData(item);
    if (
      data === null
      || data.length === 0
      || data.length % 4 !== 0
      || !AGENT_IMAGE_BASE64_PATTERN.test(data)
    ) {
      reject('AGENT_IMAGE_INVALID', INVALID_MESSAGE);
    }

    // 只用真实解码字节数判断大小；客户端的任何“声明大小”一律忽略。
    const buffer = Buffer.from(data, 'base64');
    if (buffer.byteLength > AGENT_IMAGE_LIMITS.maxImageBytes) {
      reject('AGENT_IMAGE_TOO_LARGE', TOO_LARGE_MESSAGE);
    }
    totalBytes += buffer.byteLength;
    images.push({ kind: kinds[index], mediaType, data, bytes: buffer.byteLength });
  }

  if (totalBytes > AGENT_IMAGE_LIMITS.maxTotalBytes) {
    reject('AGENT_IMAGE_TOO_LARGE', TOO_LARGE_MESSAGE);
  }

  return { images, menuImages, storeImages, totalBytes };
}