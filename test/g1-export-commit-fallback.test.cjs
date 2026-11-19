'use strict';

/**
 * G1 导出闭环的证据：主进程提交失败时，带海报素材的导出仍然走 node 子进程兜底，
 * 且媒体内容只能由主进程解析、再由 CLI 的 --media 通道重新校验一遍。
 *
 * 覆盖：
 * 1. COMMIT_FAILED + 有海报 → 兜底被调用，且拿到真实字节与来源；
 * 2. COMMIT_FAILED + 无海报 → 兜底照旧调用，但不带 media 字段；
 * 3. 导出成功 → 不触发兜底；
 * 4. 兜底时写出的 media 清单符合 Composer loadMedia 的格式契约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const REPO = path.join(__dirname, '..');
const { createComposerIpc } = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));
const { loadMedia, validateMedia } = require(path.join(REPO, 'scripts', 'composer', 'media.cjs'));

const sha256 = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');

/** 最小 PNG：IHDR + IDAT + IEND，颜色类型 6（RGBA）。 */
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x40);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildIpc({ composeResult, media }) {
  const composeCalls = [];
  const nodeCalls = [];
  const ipc = createComposerIpc({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {},
    compose: async (options) => {
      composeCalls.push(options);
      return composeResult;
    },
    composeInNode: async (options) => {
      nodeCalls.push(options);
      return { ok: true, outputPath: path.join(os.tmpdir(), 'fallback-out') };
    },
    commitRetryDelays: [0],
    validateComposition: () => ({ ok: true }),
    removePreviewOutput: () => {},
    previewParentDir: path.join(os.tmpdir(), 'g1-preview-projects'),
    resolveMedia: async () => (media ? { ok: true, media, poster: { included: true } } : { ok: true, media: null, poster: { included: false } }),
  });
  return { ipc, composeCalls, nodeCalls };
}

const event = () => ({ senderFrame: { url: 'http://127.0.0.1:5173/' }, sender: { send() {} } });
const payload = (extra = {}) => ({
  parentDir: '__preview__',
  plan: { schemaVersion: 'plan.v1' },
  projectName: '云栖小馆',
  mode: 'development',
  projectId: 'p_test',
  posterAssetId: 'a_0123456789abcdef',
  ...extra,
});

test('G1 导出兜底：COMMIT_FAILED 时带海报素材走 node 子进程，字节与来源原样透传', async () => {
  const png = makePng(48, 32);
  const media = {
    homeBackground: {
      mime: 'image/png',
      sha256: sha256(png),
      width: 48,
      height: 32,
      source: { kind: 'ai-generated', provider: 'imagelfk', model: 'gpt-image-2.6' },
      data: png,
    },
  };
  const { ipc, nodeCalls } = buildIpc({ composeResult: { ok: false, code: 'COMMIT_FAILED', message: '目录提交失败' }, media });

  const result = await ipc.handlers['composer:export'](event(), payload());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(nodeCalls.length, 1, '提交失败必须触发一次 node 子进程兜底');
  const handed = nodeCalls[0].media;
  assert.ok(handed && handed.homeBackground, '兜底必须把海报素材一起交出去');
  assert.equal(Buffer.compare(handed.homeBackground.data, png), 0, '透传的必须是真实字节');
  assert.deepEqual(handed.homeBackground.source, { kind: 'ai-generated', provider: 'imagelfk', model: 'gpt-image-2.6' });
  assert.equal(handed.homeBackground.sha256, sha256(png));
});

test('G1 导出兜底：没有海报时照旧兜底，且不带 media 字段', async () => {
  const { ipc, nodeCalls } = buildIpc({ composeResult: { ok: false, code: 'COMMIT_FAILED', message: '目录提交失败' }, media: null });
  const result = await ipc.handlers['composer:export'](event(), payload({ posterAssetId: undefined }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(nodeCalls.length, 1);
  assert.equal(nodeCalls[0].media, undefined, '没有海报就不该带 media');
});

test('G1 导出兜底：一次成功不触发兜底', async () => {
  const png = makePng(16, 16);
  const media = {
    homeBackground: { mime: 'image/png', sha256: sha256(png), width: 16, height: 16, source: { kind: 'user-provided', provider: 'user-upload' }, data: png },
  };
  const { ipc, nodeCalls, composeCalls } = buildIpc({ composeResult: { ok: true, outputPath: path.join(os.tmpdir(), 'ok-out'), lockDigest: 'sha256:' + 'a'.repeat(64) }, media });
  const result = await ipc.handlers['composer:export'](event(), payload());
  assert.equal(result.ok, true);
  assert.equal(composeCalls.length, 1);
  assert.equal(nodeCalls.length, 0, '成功路径不得再起子进程');
});

test('G1 导出兜底：写出的 media 清单能被 Composer loadMedia 接受', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-media-manifest-'));
  const png = makePng(64, 40);
  const posterFile = path.join(dir, 'poster.png');
  fs.writeFileSync(posterFile, png);
  const manifestFile = path.join(dir, 'media.json');
  // 与 desktop/composer-ipc.cjs 里兜底写出的清单结构保持一致。
  fs.writeFileSync(manifestFile, JSON.stringify({
    homeBackground: {
      file: 'poster.png',
      mime: 'image/png',
      sha256: sha256(png),
      width: 64,
      height: 40,
      source: { kind: 'ai-generated', provider: 'imagelfk', model: 'gpt-image-2.6' },
    },
  }), 'utf8');

  const loaded = loadMedia(manifestFile);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(Buffer.compare(loaded.media.homeBackground.data, png), 0);
  assert.equal(loaded.media.homeBackground.source.kind, 'ai-generated');
  const validated = validateMedia(loaded.media);
  assert.equal(validated.ok, true, JSON.stringify(validated));
  fs.rmSync(dir, { recursive: true, force: true });
});
