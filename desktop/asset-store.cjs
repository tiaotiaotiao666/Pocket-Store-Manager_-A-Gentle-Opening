'use strict';

/**
 * 图片资产存储（Electron 主进程）。
 *
 * 设计要点（见实现方案 4.3）：
 * - 两段式选择：pick 只返回元数据 + 临时 token，attach 才读文件落盘。
 *   渲染进程永远拿不到任意外部绝对路径。
 * - 文件名 = sha256 前 16 位 + 真实扩展名，内容相同自动去重。
 * - 只解析文件头读取宽高，不引入 sharp 等运行时依赖。
 * - 缩略图由可选 imageAdapter 生成；Node 测试环境不传 adapter，直接返回原图 dataUrl。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeFileAtomic, ProjectStoreError, assertProjectId, PROJECT_ID_RE } = require('./project-store.cjs');

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ASSETS_PER_ATTACH = 6;
const MAX_READ_BYTES = 1.5 * 1024 * 1024;
const PICK_TOKEN_TTL_MS = 300 * 1000;
const ASSET_ID_RE = /^a_[0-9a-f]{16}$/;
const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

function sha256Prefix(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionFromMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '';
}

/** 只按 magic number 判定真实类型，不信任扩展名。 */
function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** PNG：IHDR 宽高位于 16/20（大端 32 位）。 */
function readPngSize(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** JPEG：遍历段，找 SOF0/SOF2 等包含尺寸的帧头。 */
function readJpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (offset + 9 >= buffer.length) return null;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP：VP8X 直接给 24 位宽高；VP8 / VP8L 有各自的头。 */
function readWebpSize(buffer) {
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readImageSize(buffer) {
  const mime = detectMime(buffer);
  try {
    if (mime === 'image/png') return readPngSize(buffer);
    if (mime === 'image/jpeg') return readJpegSize(buffer);
    if (mime === 'image/webp') return readWebpSize(buffer);
  } catch (error) {
    return null;
  }
  return null;
}

function createAssetStore(options) {
  const opts = options || {};
  if (typeof opts.userDataDir !== 'string' || !opts.userDataDir) {
    throw new Error('createAssetStore 需要 userDataDir');
  }
  const userDataDir = path.resolve(opts.userDataDir);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : crypto.randomBytes;
  const imageAdapter = opts.imageAdapter || null;
  const pendingTokens = new Map();

  function projectDirectory(projectId) {
    assertProjectId(projectId);
    const resolved = path.resolve(userDataDir, 'projects', projectId);
    if (resolved !== path.join(userDataDir, 'projects', projectId)) {
      throw new ProjectStoreError('PROJECT_INVALID_ID', '项目标识无效');
    }
    return resolved;
  }

  function assetsDirectory(projectId) {
    return path.join(projectDirectory(projectId), 'assets', 'images');
  }

  function projectConfigPath(projectId) {
    return path.join(projectDirectory(projectId), 'project.json');
  }

  async function readProjectDocument(projectId) {
    try {
      const raw = await fsp.readFile(projectConfigPath(projectId), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ProjectStoreError('PROJECT_NOT_FOUND', '项目不存在或已被删除');
      throw new ProjectStoreError('PROJECT_READ_FAILED', '项目文件无法读取', { cause: error.code });
    }
  }

  async function writeProjectDocument(projectId, doc) {
    await writeFileAtomic(projectConfigPath(projectId), `${JSON.stringify(doc, null, 2)}\n`);
  }

  function cleanupExpired(nowMs) {
    for (const [token, item] of pendingTokens) {
      if (nowMs - item.createdAt > PICK_TOKEN_TTL_MS) pendingTokens.delete(token);
    }
  }

  /**
   * 第一段：弹系统对话框，只返回元数据。
   * pending 表每次选择整体替换，避免用户反复选择导致 token 无限增长。
   */
  async function pickImages(dialog, payload) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const max = input.max === 1 ? 1 : MAX_ASSETS_PER_ATTACH;
    const picked = await dialog.showOpenDialog({
      title: max === 1 ? '选择一张图片' : '选择门店图片（最多 6 张）',
      properties: max === 1 ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (!picked || picked.canceled) return { items: [] };

    const nowMs = now();
    cleanupExpired(nowMs);
    pendingTokens.clear();

    const items = [];
    for (const filePath of (picked.filePaths || []).slice(0, max)) {
      try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_ASSET_BYTES) continue;
        const handle = await fsp.open(filePath, 'r');
        let header;
        try {
          const buffer = Buffer.alloc(64);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          header = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        const mime = detectMime(header);
        if (!mime) continue;
        const size = readImageSize(header) || {};
        const token = randomBytes(16).toString('hex');
        pendingTokens.set(token, { filePath, createdAt: nowMs, mime });
        items.push({
          token,
          name: path.basename(filePath),
          bytes: stat.size,
          mime,
          width: size.width,
          height: size.height,
        });
      } catch (error) {
        /* 单张读取失败不影响其余图片 */
      }
    }
    return { items };
  }

  /** 第二段：校验 token → 读文件 → 摘要去重 → 落盘 → 返回接口元数据。 */
  async function attachImages(projectId, tokens) {
    assertProjectId(projectId);
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) return { assets: [] };
    if (list.length > MAX_ASSETS_PER_ATTACH) {
      throw new ProjectStoreError('ASSET_COUNT_EXCEEDED', '最多保留 6 张门店图片');
    }

    const doc = await readProjectDocument(projectId);
    const known = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
    const directory = assetsDirectory(projectId);
    await fsp.mkdir(directory, { recursive: true });

    const assets = [];
    const total = { bytes: 0 };
    const nowIso = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

    for (const token of list) {
      const entry = pendingTokens.get(token);
      if (!entry) {
        throw new ProjectStoreError('ASSET_TOKEN_UNKNOWN', '请重新选择图片');
      }
      if (now() - entry.createdAt > PICK_TOKEN_TTL_MS) {
        pendingTokens.delete(token);
        throw new ProjectStoreError('ASSET_TOKEN_EXPIRED', '所选图片授权已过期，请重新选择');
      }

      let buffer;
      try {
        buffer = await fsp.readFile(entry.filePath);
      } catch (error) {
        throw new ProjectStoreError('ASSET_READ_FAILED', '无法读取所选图片', { cause: error.code });
      }
      if (buffer.length > MAX_ASSET_BYTES) {
        throw new ProjectStoreError('ASSET_TOO_LARGE', '单张图片不能超过 10 MB');
      }
      total.bytes += buffer.length;
      if (total.bytes > MAX_ASSET_TOTAL_BYTES) {
        throw new ProjectStoreError('ASSET_TOO_LARGE', '一次最多导入 40 MB 图片');
      }

      const mime = detectMime(buffer);
      if (!mime) {
        throw new ProjectStoreError('ASSET_UNSUPPORTED_TYPE', '仅支持 PNG / JPG / WebP');
      }
      const extension = extensionFromMime(mime);
      const digest = sha256Prefix(buffer);
      const assetId = `a_${digest.slice(0, 16)}`;
      const fileName = `${digest.slice(0, 16)}${extension}`;
      const existing = known.find((item) => item.assetId === assetId);
      const size = readImageSize(buffer) || {};

      if (!existing) {
        const target = path.join(directory, fileName);
        let alreadyOnDisk = false;
        try {
          const stat = await fsp.stat(target);
          alreadyOnDisk = stat.size === buffer.length;
        } catch (error) {
          alreadyOnDisk = false;
        }
        if (!alreadyOnDisk) {
          try {
            await fsp.writeFile(target, buffer, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') {
              throw new ProjectStoreError('ASSET_READ_FAILED', '保存图片失败', { cause: error.code });
            }
          }
        }
        const meta = {
          assetId,
          fileName,
          originalName: String(path.basename(entry.filePath)).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120),
          mime,
          bytes: buffer.length,
          width: size.width,
          height: size.height,
          sha256: `sha256:${digest}`,
          createdAt: nowIso,
        };
        known.push(meta);
        assets.push(meta);
      } else {
        assets.push(existing);
      }
    }

    doc.assets = { ...(doc.assets || {}), images: known };
    await writeProjectDocument(projectId, doc);
    pendingTokens.clear();
    return { assets };
  }

  async function readAsset(projectId, assetId, payload) {
    assertProjectId(projectId);
    if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) {
      throw new ProjectStoreError('PROJECT_INVALID_ID', '资产标识无效');
    }
    const doc = await readProjectDocument(projectId);
    const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
    const meta = images.find((item) => item.assetId === assetId);
    if (!meta || typeof meta.fileName !== 'string' || !/^[0-9a-f]{16}\.(png|jpg|jpeg|webp)$/.test(meta.fileName)) {
      throw new ProjectStoreError('PROJECT_NOT_FOUND', '图片资产不存在');
    }
    const file = path.join(assetsDirectory(projectId), meta.fileName);
    let buffer;
    try {
      buffer = await fsp.readFile(file);
    } catch (error) {
      throw new ProjectStoreError('ASSET_READ_FAILED', '图片文件无法读取', { cause: error.code });
    }

    let output = buffer;
    let mime = meta.mime;
    const maxWidth = payload && Number.isFinite(payload.maxWidth) ? Math.max(64, Math.min(1024, payload.maxWidth)) : 320;
    if (imageAdapter && typeof imageAdapter.resize === 'function') {
      const resized = imageAdapter.resize(buffer, maxWidth);
      if (resized && resized.buffer) {
        output = resized.buffer;
        mime = resized.mime || mime;
      }
    }
    if (output.length > MAX_READ_BYTES) {
      throw new ProjectStoreError('ASSET_TOO_LARGE', '图片缩略图超过 1.5 MB 上限');
    }
    return {
      assetId,
      mime,
      width: meta.width,
      height: meta.height,
      bytes: output.length,
      dataUrl: `data:${mime};base64,${output.toString('base64')}`,
    };
  }

  /** 删除资产：仍被业务字段引用时只报告引用，不静默删除。 */
  async function removeAsset(projectId, assetId) {
    assertProjectId(projectId);
    if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) {
      throw new ProjectStoreError('PROJECT_INVALID_ID', '资产标识无效');
    }
    const doc = await readProjectDocument(projectId);
    const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
    const meta = images.find((item) => item.assetId === assetId);
    if (!meta) return { removed: false, affectedRefs: [] };

    const refs = [];
    if (doc.store && doc.store.logoAssetId === assetId) refs.push('store.logoAssetId');
    if (doc.store && Array.isArray(doc.store.imageAssetIds) && doc.store.imageAssetIds.includes(assetId)) {
      refs.push('store.imageAssetIds');
    }
    if (doc.visual && doc.visual.imageAssetId === assetId) refs.push('visual.imageAssetId');
    if (doc.visual && Array.isArray(doc.visual.imageRounds)) {
      doc.visual.imageRounds.forEach((round, index) => {
        if (round && round.assetId === assetId) refs.push(`visual.imageRounds[${index}].assetId`);
      });
    }
    if (refs.length > 0) return { removed: false, affectedRefs: refs };

    doc.assets = { ...(doc.assets || {}), images: images.filter((item) => item.assetId !== assetId) };
    await writeProjectDocument(projectId, doc);
    try {
      await fsp.unlink(path.join(assetsDirectory(projectId), meta.fileName));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new ProjectStoreError('ASSET_READ_FAILED', '图片索引已移除，但文件删除失败', { cause: error.code });
      }
    }
    return { removed: true, affectedRefs: [] };
  }

  return {
    pickImages,
    attachImages,
    readAsset,
    removeAsset,
    assetsDirectory,
    pendingCount: () => pendingTokens.size,
  };
}

module.exports = {
  createAssetStore,
  detectMime,
  readImageSize,
  PICK_TOKEN_TTL_MS,
  MAX_ASSET_BYTES,
  MAX_ASSET_TOTAL_BYTES,
  MAX_READ_BYTES,
};