'use strict';

/**
 * 按 assetId 的受控图片资产解析（rev15 §14.8 / X2，E0-R2）。
 *
 * 冻结约束逐条落在这里：
 * 1. **输入只有 assetId**（`a_<16 hex>`，既有 `project:pick-images`/`attach-images` 的产物）；
 *    本模块不接受任何路径、不接受 base64 文本。
 * 2. 从 assetId → `project.json` 的 `assets.images[]` → `fileName` → 项目资产根内路径；
 *    再做 canonical 校验（`realpath` 必须等于「资产根 realpath + fileName」，拒 symlink / junction / 越界）。
 *    项目身份绑定（E0-Fix2 / OBS-B）：项目目录 realpath 必须严格等于 `userDataReal/projects/<projectId>`，
 *    资产根 realpath 必须严格等于该目录下 `assets/images`；`projects/<A>` junction 到 `projects/<B>`
 *    在读取 project.json 之前就拒绝，链接目标零内容读取/写入。
 * 3. 魔数判真实类型（PNG/JPEG/WebP），并与元数据声明的 MIME 一致；做结构解码校验
 *    （PNG：逐 chunk CRC + IDAT inflate + 扫描行长度一致性 = 真解码；JPEG/WebP：段结构/RIFF 长度/EOI 完整性）；
 *    单张 ≤2 MiB；E0 只接受 **1 张**目标页参考图。
 * 4. 返回的 `dataUrl` **只存在于调用内存**：本模块不写任何文件、不打日志、不进 trace。
 * 5. 缺图/坏图/超限 → `AGENT_IMAGE_INVALID`（带机器可读 reason，不静默）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { RUNTIME_CODES } = require('./constants.cjs');
// projectId 的形状只认项目存储这一份定义，避免第二份正则。
const { PROJECT_ID_RE } = require('../project-store.cjs');

/** §14.8：单张 ≤2 MiB（硬上限，不允许调用方抬高）。 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** §14.8：E0 只接受 1 张目标页参考图。 */
const MAX_IMAGES_PER_TURN = 1;
/** assetId 形状（与 asset-store 的 `^a_[0-9a-f]{16}$` 一致）。 */
const ASSET_ID_PATTERN = /^a_[0-9a-f]{16}$/;
/** 只接受资产根下「16 位 hex + 受支持扩展名」的文件名，杜绝 `../`、绝对路径、ADS。 */
const ASSET_FILE_PATTERN = /^[0-9a-f]{16}\.(png|jpg|jpeg|webp)$/;
const MAX_PROJECT_DOC_BYTES = 4 * 1024 * 1024;
const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

class RuntimeImageError extends Error {
  constructor(code, reason, message, cause) {
    super(message || '图片不可用。');
    this.name = 'RuntimeImageError';
    this.code = code;
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

function imageInvalid(reason, message, cause) {
  return new RuntimeImageError(RUNTIME_CODES.IMAGE_INVALID, reason, message, cause);
}

function visionUnavailable(reason, message) {
  return new RuntimeImageError(RUNTIME_CODES.VISION_UNAVAILABLE, reason, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只按魔数判真实类型，绝不信任扩展名或元数据声明。 */
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function crc32Of(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  // 极老 Node 的兜底：不支持时跳过 CRC（结构校验仍然生效）。
  return null;
}

const PNG_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const PNG_VALID_DEPTHS = Object.freeze({
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
});

/** PNG：逐 chunk 校验 CRC，IDAT 真正 inflate，非隔行图校验扫描行总长度 = 宽高自洽。 */
function validatePng(buffer) {
  if (buffer.length < 8 + 25 + 12) throw imageInvalid('png_truncated', 'PNG 文件不完整。');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idatChunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw imageInvalid('png_chunk_truncated', 'PNG 数据块被截断。');
    const declaredCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32Of(buffer.subarray(offset + 4, dataEnd));
    if (actualCrc !== null && declaredCrc !== actualCrc) {
      throw imageInvalid('png_chunk_crc', 'PNG 数据块校验失败（文件损坏）。');
    }
    if (type === 'IHDR') {
      if (length < 13) throw imageInvalid('png_ihdr_invalid', 'PNG 头信息不合法。');
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
      if (!(width > 0 && height > 0)) throw imageInvalid('png_size_invalid', 'PNG 尺寸不合法。');
      if (!PNG_VALID_DEPTHS[colorType] || !PNG_VALID_DEPTHS[colorType].includes(bitDepth)) {
        throw imageInvalid('png_ihdr_invalid', 'PNG 颜色类型/位深不合法。');
      }
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawIhdr) throw imageInvalid('png_missing_ihdr', 'PNG 缺少 IHDR。');
  if (idatChunks.length === 0) throw imageInvalid('png_missing_idat', 'PNG 缺少图像数据。');
  if (!sawIend) throw imageInvalid('png_missing_iend', 'PNG 缺少 IEND（文件不完整）。');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch (error) {
    throw imageInvalid('png_inflate_failed', 'PNG 图像数据无法解码。', error.message);
  }
  if (raw.length === 0) throw imageInvalid('png_empty_pixels', 'PNG 图像数据为空。');
  if (interlace === 0) {
    const bytesPerLine = Math.ceil((width * PNG_CHANNELS[colorType] * bitDepth) / 8);
    if (raw.length !== height * (bytesPerLine + 1)) {
      throw imageInvalid('png_scanline_mismatch', 'PNG 像素数据与声明的宽高不一致。');
    }
  }
  return { width, height };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG：走到 SOS 之前必须遇到带合法尺寸的 SOF，且文件尾部有 EOI。 */
function validateJpeg(buffer) {
  if (buffer.length < 128) throw imageInvalid('jpeg_truncated', 'JPEG 文件不完整。');
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw imageInvalid('jpeg_soi_missing', 'JPEG 缺少 SOI。');
  let offset = 2;
  let size = null;
  let sawScan = false;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) {
      throw imageInvalid('jpeg_segment_truncated', 'JPEG 段长度不合法（文件损坏）。');
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (!(width > 0 && height > 0)) throw imageInvalid('jpeg_size_invalid', 'JPEG 尺寸不合法。');
      size = { width, height };
    }
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    offset += 2 + length;
  }
  if (!size) throw imageInvalid('jpeg_missing_sof', 'JPEG 缺少尺寸帧头。');
  if (!sawScan) throw imageInvalid('jpeg_missing_sos', 'JPEG 缺少扫描数据。');
  const tail = buffer.subarray(Math.max(0, buffer.length - 16));
  let hasEoi = false;
  for (let index = 0; index + 1 < tail.length; index += 1) {
    if (tail[index] === 0xff && tail[index + 1] === 0xd9) hasEoi = true;
  }
  if (!hasEoi) throw imageInvalid('jpeg_missing_eoi', 'JPEG 缺少 EOI（文件不完整）。');
  return size;
}

/** WebP：RIFF 长度必须与文件长度自洽，且首个 chunk 是已知的 VP8 家族。 */
function validateWebp(buffer) {
  if (buffer.length < 32) throw imageInvalid('webp_truncated', 'WebP 文件不完整。');
  const riffSize = buffer.readUInt32LE(4);
  if (8 + riffSize !== buffer.length) {
    throw imageInvalid('webp_riff_size_mismatch', 'WebP RIFF 长度与文件长度不一致（文件损坏）。');
  }
  const fourcc = buffer.toString('ascii', 12, 16);
  const chunkSize = buffer.readUInt32LE(16);
  const dataStart = 20;
  if (dataStart + chunkSize > buffer.length) throw imageInvalid('webp_chunk_truncated', 'WebP 数据块被截断。');
  if (fourcc === 'VP8 ') {
    if (buffer.length < dataStart + 10) throw imageInvalid('webp_vp8_truncated', 'WebP VP8 头不完整。');
    if (!(buffer[dataStart + 3] === 0x9d && buffer[dataStart + 4] === 0x01 && buffer[dataStart + 5] === 0x2a)) {
      throw imageInvalid('webp_vp8_bad_startcode', 'WebP VP8 起始码不合法。');
    }
    const width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
    const height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
    if (!(width > 0 && height > 0)) throw imageInvalid('webp_size_invalid', 'WebP 尺寸不合法。');
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    if (buffer[dataStart] !== 0x2f) throw imageInvalid('webp_vp8l_bad_signature', 'WebP VP8L 签名不合法。');
    const bits = buffer.readUInt32LE(dataStart + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === 'VP8X') {
    if (chunkSize < 10) throw imageInvalid('webp_vp8x_truncated', 'WebP VP8X 头不完整。');
    const width = 1 + (buffer[dataStart + 4] | (buffer[dataStart + 5] << 8) | (buffer[dataStart + 6] << 16));
    const height = 1 + (buffer[dataStart + 7] | (buffer[dataStart + 8] << 8) | (buffer[dataStart + 9] << 16));
    return { width, height };
  }
  throw imageInvalid('webp_unknown_chunk', 'WebP 首块不是受支持的位流。');
}

/** 结构解码校验：返回 {width,height} 或抛 AGENT_IMAGE_INVALID。 */
function validateImageStructure(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw imageInvalid('empty_file', '图片内容为空。');
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) throw imageInvalid('unsupported_type', '仅支持 PNG / JPEG / WebP 图片。');
  if (mime && sniffed !== mime) {
    throw imageInvalid('mime_mismatch', '图片真实类型与声明的 MIME 不一致。');
  }
  if (sniffed === 'image/png') return { mime: sniffed, ...validatePng(buffer) };
  if (sniffed === 'image/jpeg') return { mime: sniffed, ...validateJpeg(buffer) };
  return { mime: sniffed, ...validateWebp(buffer) };
}

function projectDirectory(userDataDir, projectId) {
  return path.join(userDataDir, 'projects', projectId);
}

function assetsImageDirectory(userDataDir, projectId) {
  return path.join(projectDirectory(userDataDir, projectId), 'assets', 'images');
}

/** 只读 project.json（有大小上限），失败一律归入 AGENT_IMAGE_INVALID。 */
function readProjectDocument(userDataDir, projectId) {
  const file = path.join(projectDirectory(userDataDir, projectId), 'project.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw imageInvalid('project_missing', '找不到该项目的工程文件。', error.code);
  }
  if (!stat.isFile()) throw imageInvalid('project_missing', '找不到该项目的工程文件。');
  if (stat.size > MAX_PROJECT_DOC_BYTES) throw imageInvalid('project_too_large', '工程文件过大。');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw imageInvalid('project_unreadable', '工程文件无法解析。', error.message);
  }
}

function findImageMeta(doc, assetId) {
  const images = doc && doc.assets && Array.isArray(doc.assets.images) ? doc.assets.images : [];
  const meta = images.find((item) => isPlainObject(item) && item.assetId === assetId);
  if (!meta) throw imageInvalid('asset_not_found', '该图片不在项目资产里（assetId 不存在）。');
  return meta;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function dataUrlOf(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function realpathOf(target, reason, message) {
  try {
    return fs.realpathSync.native(target);
  } catch (error) {
    throw imageInvalid(reason, message || '无法解析资产路径。', error.code);
  }
}

/** Windows 的 realpath 会规范化盘符/大小写，比较必须忽略大小写（否则 8.3 短名会误判）。 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 解析一张参考图。
 *
 * @param {object} options
 * @param {string} options.userDataDir 应用私有根（主进程传入，不来自渲染进程）
 * @param {string} options.projectId   项目 id（形状只认 project-store 的定义）
 * @param {string} options.assetId     形如 `a_0123456789abcdef`
 * @param {object} [options.limits]    { maxBytes?, maxImages? }（maxBytes 不得高于 2 MiB）
 * @returns {{assetId: string, mime: string, bytes: number, sha256: string, dataUrl: string}}
 */
function resolveAssetImage(options) {
  const opts = isPlainObject(options) ? options : {};
  const limits = isPlainObject(opts.limits) ? opts.limits : {};

  if (typeof opts.userDataDir !== 'string' || opts.userDataDir.trim() === '') {
    throw imageInvalid('user_data_dir_missing', '缺少应用私有目录，无法读取图片。');
  }
  if (typeof opts.projectId !== 'string' || !PROJECT_ID_RE.test(opts.projectId)) {
    throw imageInvalid('project_id_invalid', '项目标识不合法。');
  }
  if (typeof opts.assetId !== 'string' || !ASSET_ID_PATTERN.test(opts.assetId)) {
    throw imageInvalid('asset_id_invalid', '图片标识不合法（只接受 assetId）。');
  }

  const limitMax = Number.isInteger(limits.maxBytes) && limits.maxBytes > 0
    ? Math.min(limits.maxBytes, MAX_IMAGE_BYTES)
    : MAX_IMAGE_BYTES;
  const maxImages = Number.isInteger(limits.maxImages) && limits.maxImages > 0
    ? Math.min(limits.maxImages, MAX_IMAGES_PER_TURN)
    : MAX_IMAGES_PER_TURN;
  if (maxImages < 1) throw imageInvalid('too_many_images', '本轮不接受额外图片。');

  const rootDir = assetsImageDirectory(opts.userDataDir, opts.projectId);
  const userDataReal = realpathOf(path.resolve(opts.userDataDir), 'user_data_dir_missing', '应用私有目录不可用。');
  // 项目身份绑定（E0-Fix2 / OBS-B）：项目目录的 realpath 必须严格等于
  // `userDataReal/projects/<projectId>`。这样 `projects/<A>` 被 junction 到
  // `projects/<B>` 时，在读取 project.json / 资产文件之前就拒绝，链接目标零内容读取。
  const expectedProjectReal = path.join(userDataReal, 'projects', opts.projectId);
  const expectedRootReal = path.join(expectedProjectReal, 'assets', 'images');
  const projectReal = realpathOf(
    projectDirectory(opts.userDataDir, opts.projectId),
    'project_missing',
    '找不到该项目目录。',
  );
  if (!samePath(projectReal, expectedProjectReal)) {
    throw imageInvalid('project_identity_mismatch', '项目目录身份与 projectId 不一致（疑似 projects 目录链接）。');
  }
  const rootReal = realpathOf(rootDir, 'asset_root_missing', '找不到项目图片目录。');
  // 资产根必须正好是同一项目真实目录下的 assets/images；任何链接换根都会落到别处。
  if (!samePath(rootReal, expectedRootReal)) {
    throw imageInvalid('asset_root_outside_project', '图片目录不在项目私有目录内（疑似链接或越界）。');
  }

  const doc = readProjectDocument(opts.userDataDir, opts.projectId);
  const meta = findImageMeta(doc, opts.assetId);
  const fileName = typeof meta.fileName === 'string' ? meta.fileName : '';
  if (!ASSET_FILE_PATTERN.test(fileName)) {
    throw imageInvalid('asset_file_invalid', '资产文件名不合法。');
  }

  const expectedReal = path.join(rootReal, fileName);
  const candidate = path.join(rootDir, fileName);
  if (path.dirname(candidate) !== rootDir) {
    throw imageInvalid('asset_escaped_root', '图片路径越出资产根。');
  }

  let linkStat;
  try {
    linkStat = fs.lstatSync(candidate);
  } catch (error) {
    throw imageInvalid('asset_file_missing', '图片文件不存在。', error.code);
  }
  if (linkStat.isSymbolicLink()) {
    throw imageInvalid('asset_symlink_rejected', '图片文件是链接（symlink/junction），已拒绝。');
  }
  if (!linkStat.isFile()) throw imageInvalid('asset_not_file', '图片不是普通文件。');

  // canonical：真实路径必须正好是「资产根 realpath + fileName」，
  // 任何 junction/symlink 祖先都会让它落在别处，从而被拒绝。
  const fileReal = realpathOf(candidate, 'asset_unresolvable', '无法解析图片真实路径。');
  if (!samePath(fileReal, expectedReal)) {
    throw imageInvalid('asset_outside_root', '图片真实路径不在项目资产根内（疑似链接或越界）。');
  }

  if (linkStat.size > limitMax) {
    throw imageInvalid('image_too_large', `单张图片不能超过 ${Math.floor(limitMax / 1024)} KiB。`);
  }
  if (linkStat.size === 0) throw imageInvalid('empty_file', '图片内容为空。');

  let buffer;
  try {
    buffer = fs.readFileSync(fileReal);
  } catch (error) {
    throw imageInvalid('asset_read_failed', '读取图片失败。', error.code);
  }
  if (buffer.length > limitMax) {
    throw imageInvalid('image_too_large', `单张图片不能超过 ${Math.floor(limitMax / 1024)} KiB。`);
  }

  const info = validateImageStructure(buffer, typeof meta.mime === 'string' ? meta.mime : undefined);
  const bufferSha = sha256Hex(buffer);
  if (typeof meta.sha256 === 'string' && meta.sha256.startsWith('sha256:')) {
    if (meta.sha256.slice(7) !== bufferSha) {
      throw imageInvalid('asset_digest_mismatch', '图片内容与登记的摘要不一致（文件被改动）。');
    }
  }
  if (Number.isInteger(meta.bytes) && meta.bytes !== buffer.length) {
    throw imageInvalid('asset_size_mismatch', '图片大小与登记信息不一致（文件被改动）。');
  }

  return {
    assetId: opts.assetId,
    mime: info.mime,
    bytes: buffer.length,
    sha256: bufferSha,
    dataUrl: dataUrlOf(info.mime, buffer),
  };
}

/**
 * 一次解析本轮全部参考图（E0 只允许 1 张）。
 * @returns {{images: Array, meta: Array}} images 供 buildMultimodalContent 用；meta 不含 dataUrl（可进 trace/报告）
 */
function resolveAssetImages(options) {
  const opts = isPlainObject(options) ? options : {};
  const assetIds = Array.isArray(opts.assetIds) ? opts.assetIds : [];
  const limits = isPlainObject(opts.limits) ? opts.limits : {};
  const maxImages = Number.isInteger(limits.maxImages) && limits.maxImages > 0
    ? Math.min(limits.maxImages, MAX_IMAGES_PER_TURN)
    : MAX_IMAGES_PER_TURN;
  if (assetIds.length === 0) return { images: [], meta: [] };
  if (assetIds.length > maxImages) {
    throw imageInvalid(
      'too_many_images',
      maxImages === 1 ? 'E0 每轮只接受 1 张目标页参考图。' : `本轮最多 ${maxImages} 张图片。`,
    );
  }
  const images = [];
  const meta = [];
  for (const assetId of assetIds) {
    const resolved = resolveAssetImage({ ...opts, assetId, limits });
    images.push(resolved);
    meta.push({
      assetId: resolved.assetId,
      mime: resolved.mime,
      bytes: resolved.bytes,
      sha256: resolved.sha256,
    });
  }
  return { images, meta };
}

/** 便于主进程复用一个解析器（本模块持有 state 是零：每次调用都重新做 canonical 校验）。 */
function createAssetImageResolver(defaults) {
  const base = isPlainObject(defaults) ? defaults : {};
  return {
    resolve: (request) => resolveAssetImage({ ...base, ...(isPlainObject(request) ? request : {}) }),
    resolveMany: (request) => resolveAssetImages({ ...base, ...(isPlainObject(request) ? request : {}) }),
    describe: () => ({
      maxBytes: MAX_IMAGE_BYTES,
      maxImagesPerTurn: MAX_IMAGES_PER_TURN,
      mimes: ['image/png', 'image/jpeg', 'image/webp'],
      canonicalCheck: 'realpath-in-asset-root',
    }),
  };
}

module.exports = {
  resolveAssetImage,
  resolveAssetImages,
  createAssetImageResolver,
  validateImageStructure,
  sniffImageMime,
  dataUrlOf,
  sha256Hex,
  RuntimeImageError,
  imageInvalid,
  visionUnavailable,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  ASSET_ID_PATTERN,
  ASSET_FILE_PATTERN,
  assetsImageDirectory,
};
