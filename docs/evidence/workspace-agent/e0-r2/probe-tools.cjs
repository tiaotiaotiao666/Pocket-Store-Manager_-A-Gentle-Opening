'use strict';

/**
 * E0-R2 证据用 PNG 生成器（无第三方依赖，纯 zlib）。
 *
 * 只做两件事：
 * - `makeProbePng()`：可复核的「真实小图」——96×96、白底 + 红色圆 + 蓝色方块（非纯色探针），
 *   用于证明多模态调用依赖图像内容；
 * - `makeNoisePng({size, level})`：确定性噪声图，用来造「≤2 MiB 通过 / >2 MiB 拒绝」的边界样本。
 *
 * 生成结果完全确定（不含时间戳、不含随机源），因此 sha256 可写进证据并逐次复核。
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  throw new Error('当前 Node 不支持 zlib.crc32');
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** RGB8（colorType=2, bitDepth=8, interlace=0），`pixel(x, y) => [r, g, b]`。 */
function encodePng({ width, height, pixel, level }) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: Number.isInteger(level) ? level : 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = [255, 255, 255];
const RED = [214, 32, 32];
const BLUE = [32, 64, 208];

/**
 * 真实小图探针：白底 + 中心偏左的红色实心圆 + 右下角蓝色方块。
 * 语义上「主色是红色（圆）+ 蓝色（方块）」，可用于验证回答是否依赖图像内容。
 */
function makeProbePng() {
  const size = 96;
  return encodePng({
    width: size,
    height: size,
    pixel: (x, y) => {
      const dx = x - 38;
      const dy = y - 38;
      if (dx * dx + dy * dy <= 24 * 24) return RED;
      if (x >= 56 && x <= 78 && y >= 56 && y <= 78) return BLUE;
      return WHITE;
    },
  });
}

/** 确定性噪声图（LCG），用于尺寸边界样本。`level` 默认 0（store，最坏压缩、跑得快）。 */
function makeNoisePng(options) {
  const opts = options || {};
  const size = Number.isInteger(opts.size) ? opts.size : 64;
  let seed = Number.isInteger(opts.seed) ? opts.seed : 20261125;
  const nextByte = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) & 0xff;
  };
  return encodePng({
    width: size,
    height: size,
    level: Number.isInteger(opts.level) ? opts.level : 0,
    pixel: () => [nextByte(), nextByte(), nextByte()],
  });
}

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { makeProbePng, makeNoisePng, encodePng, sha256Of };
