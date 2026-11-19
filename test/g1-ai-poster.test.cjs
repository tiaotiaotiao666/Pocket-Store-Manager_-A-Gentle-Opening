'use strict';

/**
 * G1 证据：真实 AI 生图结果如何落进项目、导出时来源如何标注、状态机如何区分「AI 生成 / 用户上传」。
 *
 * 覆盖：
 * 1. saveGeneratedImage：只收 PNG data URL，落盘后 meta.source=ai-generated，readAsset 能带回来源；
 * 2. 同一字节不同来源各自留一条元数据，不互相覆盖；
 * 3. 超过 2 MB 且没有缩图适配器时明确失败，不静默交付超限图；
 * 4. 有 resizePng 适配器时自动收敛到产品上限内；
 * 5. poster-media 依据资产来源标注 ai-generated / user-provided；
 * 6. sessionMachine：SET_POSTER_ASSET(ai) → APPROVE_IMAGE 记录「已选用 AI 生成图片」，跳过则清引用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.join(__dirname, '..');
const { createProjectStore } = require(path.join(REPO, 'desktop', 'project-store.cjs'));
const { createAssetStore } = require(path.join(REPO, 'desktop', 'asset-store.cjs'));
const { createPosterMediaResolver } = require(path.join(REPO, 'desktop', 'poster-media.cjs'));

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

/** 生成真实可解析的 PNG；noise 让压缩后体积可控（用于模拟「AI 原图 1.5~2.4 MB」）。 */
function makePng(width, height, options = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  const noise = options.noise === true;
  for (let x = 0; x < width; x += 1) {
    const value = noise ? (x * 2654435761) % 256 : 255;
    row[1 + x * 4] = value;
    row[2 + x * 4] = (value * 7) % 256;
    row[3 + x * 4] = (value * 13) % 256;
    row[4 + x * 4] = 255;
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(pixels, { level: options.raw === true ? 0 : 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function dataUrlOf(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function setupProject(options = {}) {
  const userDataDir = tempDir(options.prefix || 'g1-');
  const store = createProjectStore({ userDataDir });
  const assets = createAssetStore({ userDataDir, imageAdapter: options.imageAdapter || null });
  const created = await store.createProject({ name: '云栖小馆' });
  return { userDataDir, store, assets, projectId: created.projectId };
}

test('G1-1 AI 生成图落盘：只收 PNG，meta 记 ai-generated，readAsset 能带回来源', async () => {
  const ctx = await setupProject();
  const png = makePng(1024, 1024);
  const saved = await ctx.assets.saveGeneratedImage(ctx.projectId, {
    dataUrl: dataUrlOf(png),
    source: 'ai-generated',
    provider: 'imagelfk',
    model: 'gpt-image-2.6',
  });

  assert.ok(saved.asset.assetId.startsWith('a_'));
  assert.equal(saved.asset.mime, 'image/png');
  assert.equal(saved.asset.source, 'ai-generated');
  assert.equal(saved.asset.provider, 'imagelfk');
  assert.equal(saved.asset.model, 'gpt-image-2.6');
  assert.equal(saved.asset.width, 1024);
  assert.equal(saved.asset.height, 1024);

  const read = await ctx.assets.readAsset(ctx.projectId, saved.asset.assetId, 480);
  assert.match(read.dataUrl, /^data:image\/png;base64,/);
  assert.equal(read.source, 'ai-generated');
  // 重开项目后仍然能按 assetId 读回完整字节（导出链路用的是这一份）。
  const bytes = await ctx.assets.readAssetBytes(ctx.projectId, saved.asset.assetId);
  assert.equal(bytes.buffer.length, saved.asset.bytes);
});

test('G1-2 非 PNG data URL 一律拒绝', async () => {
  const ctx = await setupProject();
  await assert.rejects(
    () => ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: 'data:image/jpeg;base64,AAAA' }),
    /PNG/,
  );
  await assert.rejects(
    () => ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: 'data:image/png;base64,bm90LWEtcG5n' }),
    /PNG/,
  );
});

test('G1-3 超过 2 MB 且没有缩图适配器时明确失败', async () => {
  const ctx = await setupProject();
  const big = makePng(1024, 1024, { noise: true, raw: true });
  assert.ok(big.length > 2 * 1024 * 1024, '构造的大图应超过 2 MB');
  await assert.rejects(
    () => ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: dataUrlOf(big), source: 'ai-generated' }),
    /2 MB/,
  );
});

test('G1-4 有 resizePng 适配器时收敛到产品上限内并保持 PNG', async () => {
  const resizeCalls = [];
  const imageAdapter = {
    resizePng(buffer, maxWidth) {
      resizeCalls.push(maxWidth);
      // 模拟无损缩图：宽度减半，体积随之下降。
      return { buffer: makePng(Math.round(maxWidth / 2), Math.round(maxWidth / 2)), mime: 'image/png' };
    },
  };
  const ctx = await setupProject({ imageAdapter });
  const big = makePng(1024, 1024, { noise: true, raw: true });
  const saved = await ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: dataUrlOf(big), source: 'ai-generated' });

  assert.ok(resizeCalls.length > 0, '应当调用缩图适配器');
  assert.ok(saved.asset.bytes <= 2 * 1024 * 1024, '落盘体积必须在 2 MB 内');
  assert.equal(saved.asset.mime, 'image/png');
});

test('G1-5 同一字节不同来源各留一条元数据，来源不互相覆盖', async () => {
  const ctx = await setupProject();
  const png = makePng(320, 320);
  const ai = await ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: dataUrlOf(png), source: 'ai-generated' });
  const upload = await ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: dataUrlOf(png), source: 'user-upload' });

  assert.notEqual(ai.asset.assetId, upload.asset.assetId);
  assert.equal(ai.asset.source, 'ai-generated');
  assert.equal(upload.asset.source, 'user-upload');
  // 重复保存同来源同字节：命中已有元数据，不新增。
  const again = await ctx.assets.saveGeneratedImage(ctx.projectId, { dataUrl: dataUrlOf(png), source: 'ai-generated' });
  assert.equal(again.asset.assetId, ai.asset.assetId);
});

test('G1-6 导出解析器按资产来源标注 ai-generated / user-provided', async () => {
  const ctx = await setupProject();
  const png = makePng(512, 512);
  const ai = await ctx.assets.saveGeneratedImage(ctx.projectId, {
    dataUrl: dataUrlOf(png),
    source: 'ai-generated',
    provider: 'imagelfk',
    model: 'gpt-image-2.6',
  });
  const uploaded = await ctx.assets.saveGeneratedImage(ctx.projectId, {
    dataUrl: dataUrlOf(makePng(512, 513)),
    source: 'user-upload',
  });

  const resolve = createPosterMediaResolver({ assets: ctx.assets });
  const aiResult = await resolve({ projectId: ctx.projectId, posterAssetId: ai.asset.assetId });
  assert.equal(aiResult.ok, true);
  assert.equal(aiResult.media.homeBackground.source.kind, 'ai-generated');
  assert.equal(aiResult.media.homeBackground.source.provider, 'imagelfk');
  assert.equal(aiResult.media.homeBackground.source.model, 'gpt-image-2.6');

  const uploadResult = await resolve({ projectId: ctx.projectId, posterAssetId: uploaded.asset.assetId });
  assert.equal(uploadResult.ok, true);
  assert.equal(uploadResult.media.homeBackground.source.kind, 'user-provided');
  assert.equal(uploadResult.media.homeBackground.source.provider, 'user-upload');
});

test('G1-7 状态机：AI 生成图选用后摘要写明来源，跳过则解除引用', async () => {
  const machine = await import('../src/state/sessionMachine.mjs');
  const base = machine.createInitialState();

  const withAi = {
    ...base,
    store: { ...base.store, name: '云栖小馆' },
    visual: {
      ...base.visual,
      imageAssetId: 'a_0123456789abcdef',
      imageMeta: { provider: 'ai-generated', note: '这张图由第三方生图服务真实生成', width: 1024, height: 1024 },
      image: { dataUrl: 'data:image/png;base64,AAAA', provider: 'ai-generated', note: '这张图由第三方生图服务真实生成' },
    },
  };
  const entered = machine.reducer(withAi, { type: 'APPROVE_IMAGE', material: 'ai-generated' });
  const deploySession = entered.sessions.find((item) => item.id === entered.activeSessionId);
  const summary = deploySession.messages.map((message) => message.text || '').join('\n');
  assert.match(summary, /已选用 AI 生成图片/);
  assert.equal(entered.visual.imageAssetId, 'a_0123456789abcdef');

  // 上传来源仍然写「用户提供」，不会被 AI 文案覆盖。
  const withUpload = {
    ...withAi,
    visual: {
      ...withAi.visual,
      imageMeta: { provider: 'user-upload' },
      image: { dataUrl: 'data:image/png;base64,AAAA', provider: 'user-upload' },
    },
  };
  const uploadedEntered = machine.reducer(withUpload, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  const uploadedSession = uploadedEntered.sessions.find((item) => item.id === uploadedEntered.activeSessionId);
  assert.match(uploadedSession.messages.map((message) => message.text || '').join('\n'), /已选用上传图片/);

  // 跳过：引用被清空，导出不会带上没选用的图。
  const skipped = machine.reducer(withAi, { type: 'APPROVE_IMAGE', material: 'skipped' });
  assert.equal(skipped.visual.imageAssetId, null);
  const skippedSession = skipped.sessions.find((item) => item.id === skipped.activeSessionId);
  assert.match(skippedSession.messages.map((message) => message.text || '').join('\n'), /未添加/);
});

test('G1-8 状态机：SET_POSTER_ASSET 按 meta.provider 记录来源，预览回读保留 AI 标记', async () => {
  const machine = await import('../src/state/sessionMachine.mjs');
  const base = machine.createInitialState();
  const stored = machine.reducer(base, {
    type: 'SET_POSTER_ASSET',
    assetId: 'a_0123456789abcdef',
    meta: { provider: 'ai-generated', width: 1024, height: 1024, model: 'gpt-image-2.6' },
    preview: 'data:image/png;base64,AAAA',
  });
  assert.equal(stored.visual.image.provider, 'ai-generated');
  assert.equal(stored.visual.imageMeta.provider, 'ai-generated');
  assert.equal(stored.visual.imageMeta.model, 'gpt-image-2.6');
  assert.match(stored.visual.image.note, /第三方生图服务/);

  const reopened = machine.reducer(stored, {
    type: 'SET_POSTER_PREVIEW',
    dataUrl: 'data:image/png;base64,BBBB',
    provider: 'ai-generated',
  });
  assert.equal(reopened.visual.image.provider, 'ai-generated');
  assert.equal(reopened.visual.imageAssetId, 'a_0123456789abcdef');
});
