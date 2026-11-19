'use strict';

/**
 * UX0b：主进程**受控海报媒体解析器**。
 *
 * 边界（对齐「不让渲染进程读磁盘」）：
 * - 渲染进程只能传两个受控引用：projectId + posterAssetId；
 *   多传任何字段（dataUrl / 路径 / Buffer / mime）一律拒绝。
 * - 真实字节由主进程从 asset-store 读取，并自行校验归属、扩展名、真实类型、
 *   大小、尺寸与摘要；渲染进程无法伪造任何一项。
 * - 校验失败就阻断本次导出，绝不"静默忽略图片后仍报告已使用"。
 */

const path = require('node:path');

const { detectMime, readImageSize } = require('./asset-store.cjs');
const { sha256 } = require('../scripts/composer/digest.cjs');

/** 产品限制：海报素材 2 MB（沿用 UX0a 口径，比 Composer 自身上限更严）。 */
const MAX_POSTER_BYTES = 2 * 1024 * 1024;
const POSTER_MIME = 'image/png';
const POSTER_EXTENSION = '.png';
const ASSET_ID_RE = /^a_[0-9a-f]{16}$/;
const ALLOWED_REQUEST_KEYS = Object.freeze(['projectId', 'posterAssetId']);

function fail(code, message) {
  return { ok: false, code, message };
}

function createPosterMediaResolver(options) {
  const opts = options || {};
  const assets = opts.assets;
  if (!assets || typeof assets.readAssetBytes !== 'function') {
    throw new Error('createPosterMediaResolver 需要提供 assets.readAssetBytes');
  }
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_POSTER_BYTES;

  return async function resolvePosterMedia(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return fail('MEDIA_REQUEST_INVALID', '海报素材请求不合法');
    }
    const extraKeys = Object.keys(request).filter((key) => !ALLOWED_REQUEST_KEYS.includes(key));
    if (extraKeys.length > 0) {
      return fail('MEDIA_REQUEST_INVALID', '只接受 projectId 与 posterAssetId 两个受控引用');
    }

    const posterAssetId = request.posterAssetId;
    if (posterAssetId === undefined || posterAssetId === null || posterAssetId === '') {
      // 明确"本次没有海报"：不构造 homeBackground，也不补占位图。
      return { ok: true, media: null, poster: { included: false } };
    }
    if (typeof posterAssetId !== 'string' || !ASSET_ID_RE.test(posterAssetId)) {
      return fail('MEDIA_ASSET_ID_INVALID', '海报素材标识不合法');
    }
    const projectId = request.projectId;
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return fail('MEDIA_PROJECT_MISSING', '缺少项目标识，无法读取海报素材');
    }

    let read;
    try {
      read = await assets.readAssetBytes(projectId, posterAssetId);
    } catch (error) {
      const code = error && error.code;
      if (code === 'ASSET_NOT_FOUND') return fail('MEDIA_ASSET_NOT_IN_PROJECT', '海报素材不存在或不属于当前项目');
      if (code === 'PROJECT_NOT_FOUND') return fail('MEDIA_PROJECT_NOT_FOUND', '项目不存在或已被删除');
      return fail('MEDIA_ASSET_READ_FAILED', '海报素材读取失败');
    }

    const meta = read.meta || {};
    const buffer = read.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return fail('MEDIA_ASSET_READ_FAILED', '海报素材读取失败');
    }

    // 1) 扩展名与登记 MIME 都必须是 PNG。
    const extension = typeof meta.fileName === 'string' ? path.extname(meta.fileName).toLowerCase() : '';
    if (extension !== POSTER_EXTENSION || meta.mime !== POSTER_MIME) {
      return fail('MEDIA_TYPE_UNSUPPORTED', '海报素材目前只支持 PNG 图片');
    }
    // 2) 真实类型按 magic bytes 判定，不信任扩展名。
    if (detectMime(buffer) !== POSTER_MIME) {
      return fail('MEDIA_TYPE_MISMATCH', '海报素材文件不是有效的 PNG');
    }
    // 3) 产品体积上限。
    if (buffer.length > maxBytes) {
      return fail('MEDIA_SIZE_INVALID', '海报素材不能超过 2 MB');
    }
    // 4) 尺寸：必须能读出，且与资产登记信息一致。
    const size = readImageSize(buffer) || {};
    if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1) {
      return fail('MEDIA_DIMENSION_INVALID', '无法识别海报素材尺寸');
    }
    if ((Number.isInteger(meta.width) && meta.width !== size.width)
      || (Number.isInteger(meta.height) && meta.height !== size.height)) {
      return fail('MEDIA_DIMENSION_MISMATCH', '海报素材尺寸与登记信息不一致');
    }

    // 5) 摘要以真实字节为准，不从渲染进程接收。
    const digest = sha256(buffer);
    // 6) 来源以资产元数据为准：AI 生成的那张标成 ai-generated，用户上传的仍是 user-provided。
    const assetSource = typeof meta.source === 'string' ? meta.source : 'user-upload';
    const source = assetSource === 'ai-generated'
      ? {
        kind: 'ai-generated',
        provider: (typeof meta.provider === 'string' && meta.provider.trim()) ? meta.provider.trim().slice(0, 60) : 'third-party-image-api',
        ...(typeof meta.model === 'string' && meta.model.trim() ? { model: meta.model.trim().slice(0, 60) } : {}),
      }
      : { kind: 'user-provided', provider: 'user-upload' };
    return {
      ok: true,
      media: {
        homeBackground: {
          mime: POSTER_MIME,
          sha256: digest,
          width: size.width,
          height: size.height,
          source,
          data: buffer,
        },
      },
      poster: {
        included: true,
        width: size.width,
        height: size.height,
        bytes: buffer.length,
        sha256: digest,
      },
    };
  };
}

module.exports = {
  createPosterMediaResolver,
  MAX_POSTER_BYTES,
  POSTER_MIME,
  POSTER_EXTENSION,
  ALLOWED_REQUEST_KEYS,
};
