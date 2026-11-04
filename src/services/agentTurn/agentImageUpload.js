/**
 * 浏览器端图片压缩与 `AgentImageDraft` 生成（`C-VISION-UPLOADER@1` 的 DOM 实现部分）。
 *
 * 契约（plan.md 2.2.6）：
 * - 长边压缩到 `maxEdgePx`（1280），输出 JPEG；
 * - 质量从 0.72 起逐级降到 0.55，单张解码后仍 > 400 KiB 时报 `AGENT_IMAGE_TOO_LARGE`；
 * - MIME 非白名单报 `AGENT_IMAGE_TYPE_UNSUPPORTED`；
 * - 解码/编码失败报 `AGENT_IMAGE_DECODE_FAILED`。
 *
 * 所有 DOM 依赖（createImageBitmap / canvas / FileReader）都通过 `adapters` 注入，
 * 默认实现从 globalThis 惰性读取，因此本模块可以在 `node --test` 中注入假实现运行。
 */

import {
  AGENT_IMAGE_ERROR_CODES,
  AGENT_IMAGE_KINDS,
  AGENT_IMAGE_LIMITS,
  AGENT_IMAGE_MEDIA_TYPES,
  estimateBase64Bytes,
} from '../../domain/agentImageInput.mjs';
import { createAgentTurnError } from './agentTurnError.js';

/** 输出统一转 JPEG，保证压缩链路可预测。 */
export const AGENT_IMAGE_OUTPUT_MEDIA_TYPE = 'image/jpeg';

/** 0.72 → 0.55 的逐级降质序列；第一档即契约默认质量。 */
export const AGENT_IMAGE_JPEG_QUALITIES = Object.freeze([0.72, 0.64, 0.55]);

const DATA_URL_PREFIX = /^data:[^;]+;base64,/i;

let imageDraftCounter = 0;

function buildImageError(code, message, details = null) {
  return createAgentTurnError(code, { message, details, retryable: false });
}

function nextImageId(kind) {
  imageDraftCounter += 1;
  return `agent-image-${kind}-${imageDraftCounter}`;
}

/**
 * 默认 `loadBitmap`：优先 createImageBitmap，退化到 Image + objectURL。
 * 统一返回 `{ width, height, drawable, close }`，方便 canvas.drawImage 直接使用。
 */
async function defaultLoadBitmap(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await globalThis.createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawable: bitmap,
      close: () => {
        if (typeof bitmap.close === 'function') bitmap.close();
      },
    };
  }

  const hasImage = typeof globalThis.Image === 'function';
  const hasObjectUrl = typeof globalThis.URL?.createObjectURL === 'function';
  if (!hasImage || !hasObjectUrl) {
    throw new Error('当前环境不支持图片解码');
  }

  return new Promise((resolve, reject) => {
    const objectUrl = globalThis.URL.createObjectURL(file);
    const image = new globalThis.Image();
    const cleanup = () => {
      if (typeof globalThis.URL.revokeObjectURL === 'function') {
        globalThis.URL.revokeObjectURL(objectUrl);
      }
    };
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        drawable: image,
        close: cleanup,
      });
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('图片解码失败'));
    };
    image.src = objectUrl;
  });
}

function defaultCreateCanvas(width, height) {
  if (typeof globalThis.document?.createElement !== 'function') {
    throw new Error('当前环境不支持 canvas');
  }
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultCanvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      reject(new Error('当前环境不支持 canvas 编码'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('canvas 编码结果为空'));
      }
    }, type, quality);
  });
}

function defaultReadAsDataUrl(blob) {
  if (typeof globalThis.FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new globalThis.FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  }

  const hasBuffer = typeof globalThis.Buffer !== 'undefined';
  if (blob && typeof blob.arrayBuffer === 'function' && hasBuffer) {
    return blob.arrayBuffer().then((buffer) => {
      const base64 = globalThis.Buffer.from(buffer).toString('base64');
      const type = typeof blob.type === 'string' && blob.type ? blob.type : AGENT_IMAGE_OUTPUT_MEDIA_TYPE;
      return `data:${type};base64,${base64}`;
    });
  }

  return Promise.reject(new Error('当前环境不支持读取图片数据'));
}

/**
 * 合并注入的适配器与默认实现。
 * 只覆盖调用方显式提供的函数，缺省项继续使用浏览器实现。
 */
function resolveAdapters(adapters = {}) {
  const source = adapters && typeof adapters === 'object' ? adapters : {};
  return {
    loadBitmap: typeof source.loadBitmap === 'function' ? source.loadBitmap : defaultLoadBitmap,
    createCanvas: typeof source.createCanvas === 'function' ? source.createCanvas : defaultCreateCanvas,
    canvasToBlob: typeof source.canvasToBlob === 'function' ? source.canvasToBlob : defaultCanvasToBlob,
    readAsDataUrl: typeof source.readAsDataUrl === 'function' ? source.readAsDataUrl : defaultReadAsDataUrl,
  };
}

function stripDataUrlPrefix(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  return dataUrl.replace(DATA_URL_PREFIX, '').trim();
}

function calculateTargetSize(width, height, maxEdgePx) {
  const longestEdge = Math.max(width, height);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) return null;
  if (longestEdge <= maxEdgePx) return { width, height };
  const scale = maxEdgePx / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 把用户选择的文件压缩为可直接发送的 `AgentImageDraft`。
 *
 * @param {File|Blob} file 浏览器文件对象（必须带 `type` 与 `name`）
 * @param {{kind: 'menu'|'store', id?: string, name?: string}} options
 * @param {{
 *   loadBitmap?: (file: File|Blob) => Promise<{width: number, height: number, drawable?: unknown, close?: () => void}>,
 *   createCanvas?: (width: number, height: number) => object,
 *   canvasToBlob?: (canvas: object, type: string, quality: number) => Promise<Blob>,
 *   readAsDataUrl?: (blob: Blob) => Promise<string>,
 * }} [adapters] 仅测试注入，生产环境留空
 * @returns {Promise<{
 *   id: string,
 *   kind: 'menu'|'store',
 *   name: string,
 *   mediaType: string,
 *   dataBase64: string,
 *   previewDataUrl: string,
 *   bytes: number,
 * }>}
 */
export async function prepareImageFile(file, options = {}, adapters = {}) {
  const kind = options.kind;
  if (!AGENT_IMAGE_KINDS.includes(kind)) {
    throw buildImageError(
      AGENT_IMAGE_ERROR_CODES.invalid,
      '图片用途必须是菜单照或门店环境照。',
      { field: 'kind' },
    );
  }

  if (!file || typeof file !== 'object') {
    throw buildImageError(
      AGENT_IMAGE_ERROR_CODES.decode,
      '无法读取所选图片，请重新选择。',
      { field: 'file' },
    );
  }

  const inputMediaType = String(file.type ?? '').toLowerCase();
  if (!AGENT_IMAGE_MEDIA_TYPES.includes(inputMediaType)) {
    throw buildImageError(
      AGENT_IMAGE_ERROR_CODES.type,
      '仅支持 JPEG、PNG 或 WebP 图片。',
      { field: 'type', mediaType: inputMediaType || null },
    );
  }

  const resolved = resolveAdapters(adapters);

  let bitmap;
  try {
    bitmap = await resolved.loadBitmap(file);
  } catch (error) {
    throw buildImageError(
      AGENT_IMAGE_ERROR_CODES.decode,
      '图片解码失败，请换一张图片重试。',
      { field: 'file' },
    );
  }

  try {
    const sourceWidth = Math.round(Number(bitmap?.width));
    const sourceHeight = Math.round(Number(bitmap?.height));
    const target = calculateTargetSize(sourceWidth, sourceHeight, AGENT_IMAGE_LIMITS.maxEdgePx);
    if (!target) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.decode,
        '图片尺寸无法识别，请换一张图片重试。',
        { field: 'file' },
      );
    }

    let canvas;
    let context;
    try {
      canvas = resolved.createCanvas(target.width, target.height);
      context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    } catch (error) {
      canvas = null;
      context = null;
    }
    if (!canvas || !context) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.decode,
        '图片处理失败，请换一张图片重试。',
        { field: 'file' },
      );
    }
    context.drawImage(bitmap?.drawable ?? bitmap, 0, 0, target.width, target.height);

    let encodedBlob = null;
    for (const quality of AGENT_IMAGE_JPEG_QUALITIES) {
      let candidate;
      try {
        candidate = await resolved.canvasToBlob(
          canvas,
          AGENT_IMAGE_OUTPUT_MEDIA_TYPE,
          quality,
        );
      } catch (error) {
        throw buildImageError(
          AGENT_IMAGE_ERROR_CODES.decode,
          '图片压缩失败，请换一张图片重试。',
          { field: 'file', quality },
        );
      }
      if (!candidate) continue;
      encodedBlob = candidate;
      if (Number(candidate.size) <= AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage) break;
    }

    if (!encodedBlob) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.decode,
        '图片压缩结果为空，请换一张图片重试。',
        { field: 'file' },
      );
    }

    if (Number(encodedBlob.size) > AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.tooLarge,
        `图片压缩后仍超过 ${Math.round(AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage / 1024)} KiB，请换一张更小的图片。`,
        {
          field: 'file',
          limitBytes: AGENT_IMAGE_LIMITS.maxDecodedBytesPerImage,
          actualBytes: Number(encodedBlob.size),
        },
      );
    }

    let dataUrl;
    try {
      dataUrl = await resolved.readAsDataUrl(encodedBlob);
    } catch (error) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.decode,
        '图片读取失败，请重新选择。',
        { field: 'file' },
      );
    }

    const dataBase64 = stripDataUrlPrefix(dataUrl);
    if (!dataBase64 || dataBase64.length % 4 !== 0) {
      throw buildImageError(
        AGENT_IMAGE_ERROR_CODES.decode,
        '图片数据转换失败，请重新选择。',
        { field: 'file' },
      );
    }

    const declaredName = String(options.name ?? file.name ?? '').trim();
    return {
      id: String(options.id ?? '').trim() || nextImageId(kind),
      kind,
      name: declaredName || `${kind}-${Date.now()}.jpg`,
      mediaType: AGENT_IMAGE_OUTPUT_MEDIA_TYPE,
      dataBase64,
      previewDataUrl: dataUrl.startsWith('data:')
        ? dataUrl
        : `data:${AGENT_IMAGE_OUTPUT_MEDIA_TYPE};base64,${dataBase64}`,
      bytes: Number.isFinite(Number(encodedBlob.size))
        ? Number(encodedBlob.size)
        : estimateBase64Bytes(dataBase64),
    };
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close();
      } catch (error) {
        // close 失败不影响已完成的压缩结果。
      }
    }
  }
}

/**
 * 把 `AgentImageDraft[]` 映射为 `AgentTurnV2Request.images` 的线上格式。
 * 只保留 kind / mediaType / data，绝不携带预览地址或文件名。
 *
 * @param {Array<{kind: string, mediaType: string, dataBase64: string}>} drafts
 * @returns {Array<{kind: string, mediaType: string, data: string}>}
 */
export function toAgentTurnImages(drafts) {
  if (!Array.isArray(drafts)) return [];
  return drafts
    .filter((draft) => draft && typeof draft === 'object')
    .map((draft) => ({
      kind: draft.kind,
      mediaType: draft.mediaType,
      data: draft.dataBase64,
    }));
}