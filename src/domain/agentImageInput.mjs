/**
 * Agent 图片输入的纯校验模块（`C-VISION-UPLOADER@1` 的纯函数部分）。
 *
 * 约束（见 plan.md 2.2.6 / 2.2.7）：
 * - 菜单/菜品照 ≤ 2 张，门店环境照 ≤ 1 张，合计 ≤ 3 张；
 * - 单张解码后 ≤ 400 KiB，合计 ≤ 1 MiB；
 * - 仅允许 JPEG / PNG / WebP，dataBase64 不含 `data:` 前缀；
 * - 本模块不依赖 DOM、File、Blob、Buffer，浏览器与 Node 均可运行。
 */

export const AGENT_IMAGE_LIMITS = Object.freeze({
  maxMenuImages: 2,
  maxStoreImages: 1,
  maxTotalImages: 3,
  maxDecodedBytesPerImage: 409600,
  maxDecodedBytesTotal: 1048576,
  maxEdgePx: 1280,
  jpegQuality: 0.72,
});

export const AGENT_IMAGE_KINDS = Object.freeze(['menu', 'store']);

export const AGENT_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** 与 2.2.7 的限制表保持一致的稳定错误码。 */
export const AGENT_IMAGE_ERROR_CODES = Object.freeze({
  count: 'AGENT_IMAGE_COUNT_EXCEEDED',
  type: 'AGENT_IMAGE_TYPE_UNSUPPORTED',
  invalid: 'AGENT_IMAGE_INVALID',
  tooLarge: 'AGENT_IMAGE_TOO_LARGE',
  decode: 'AGENT_IMAGE_DECODE_FAILED',
});

/** 严格 base64：仅 A-Za-z0-9+/，末尾最多两个 `=`。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 纯算术估算 base64 解码后的字节数，避免依赖 Buffer。
 * 调用方应先通过格式校验，本函数对非法输入返回 0。
 */
export function estimateBase64Bytes(data) {
  if (typeof data !== 'string' || data.length === 0) return 0;
  const length = data.length;
  let padding = 0;
  if (data[length - 1] === '=') padding += 1;
  if (length > 1 && data[length - 2] === '=') padding += 1;
  return Math.floor((length * 3) / 4) - padding;
}

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 校验一份 AgentImageDraft 列表。
 * 返回统一结构，调用方据此决定是否允许发请求。
 *
 * @param {Array<{kind: string, mediaType: string, dataBase64: string}>} images
 * @returns {{ok: true, stats: {menuImages: number, storeImages: number, totalBytes: number}}
 *   | {ok: false, code: string, message: string}}
 */
export function validateAgentImages(images) {
  if (!Array.isArray(images)) {
    return fail(AGENT_IMAGE_ERROR_CODES.invalid, '图片列表必须是数组');
  }

  const counts = { menu: 0, store: 0 };
  let totalBytes = 0;

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index];
    const position = index + 1;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(AGENT_IMAGE_ERROR_CODES.invalid, `第 ${position} 张图片结构不合法`);
    }

    const { kind, mediaType, dataBase64 } = item;

    if (!AGENT_IMAGE_KINDS.includes(kind)) {
      return fail(AGENT_IMAGE_ERROR_CODES.invalid, `第 ${position} 张图片用途不合法`);
    }

    if (!AGENT_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      return fail(AGENT_IMAGE_ERROR_CODES.type, '仅支持 JPEG、PNG 或 WebP 图片');
    }

    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return fail(AGENT_IMAGE_ERROR_CODES.invalid, `第 ${position} 张图片数据为空`);
    }

    if (!BASE64_PATTERN.test(dataBase64) || dataBase64.length % 4 !== 0) {
      return fail(AGENT_IMAGE_ERROR_CODES.invalid, `第 ${position} 张图片不是合法的 base64`);
    }

    const bytes = estimateBase64Bytes(dataBase64);
    if (bytes > AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage) {
      return fail(
        AGENT_IMAGE_ERROR_CODES.tooLarge,
        `第 ${position} 张图片超过 ${AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage} 字节`,
      );
    }

    counts[kind] += 1;
    totalBytes += bytes;
  }

  if (counts.menu > AGENT_IMAGE_LIMITS.maxMenuImages) {
    return fail(
      AGENT_IMAGE_ERROR_CODES.count,
      `菜单照最多 ${AGENT_IMAGE_LIMITS.maxMenuImages} 张`,
    );
  }

  if (counts.store > AGENT_IMAGE_LIMITS.maxStoreImages) {
    return fail(
      AGENT_IMAGE_ERROR_CODES.count,
      `门店环境照最多 ${AGENT_IMAGE_LIMITS.maxStoreImages} 张`,
    );
  }

  if (counts.menu + counts.store > AGENT_IMAGE_LIMITS.maxTotalImages) {
    return fail(
      AGENT_IMAGE_ERROR_CODES.count,
      `图片合计最多 ${AGENT_IMAGE_LIMITS.maxTotalImages} 张`,
    );
  }

  if (totalBytes > AGENT_IMAGE_LIMITS.maxDecodedBytesTotal) {
    return fail(
      AGENT_IMAGE_ERROR_CODES.tooLarge,
      `图片合计超过 ${AGENT_IMAGE_LIMITS.maxDecodedBytesTotal} 字节`,
    );
  }

  return {
    ok: true,
    stats: {
      menuImages: counts.menu,
      storeImages: counts.store,
      totalBytes,
    },
  };
}