'use strict';

/**
 * Agent 图片输入纯校验契约测试（plan.md 2.2.6 / 2.2.7 限制表）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadImages() {
  return import('../src/domain/agentImageInput.mjs');
}

/** 构造恰好覆盖 `bytes` 字节的 base64 字符串（内容全为 A，只用于体积判定）。 */
function base64OfBytes(bytes) {
  const length = Math.ceil(bytes / 3) * 4;
  return 'A'.repeat(length);
}

function draft(kind, bytes, mediaType = 'image/jpeg') {
  return { kind, mediaType, dataBase64: base64OfBytes(bytes) };
}

test('合法：2 张菜单照 + 1 张环境照', async () => {
  const { validateAgentImages } = await loadImages();
  const result = validateAgentImages([
    draft('menu', 1024),
    draft('menu', 2048),
    draft('store', 4096, 'image/png'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stats.menuImages, 2);
  assert.equal(result.stats.storeImages, 1);
  assert.ok(result.stats.totalBytes > 0);
});

test('空数组合法', async () => {
  const { validateAgentImages } = await loadImages();
  const result = validateAgentImages([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { menuImages: 0, storeImages: 0, totalBytes: 0 });
});

test('非数组返回 AGENT_IMAGE_INVALID', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages(null);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.invalid);
});

test('菜单照 3 张返回 AGENT_IMAGE_COUNT_EXCEEDED', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([draft('menu', 64), draft('menu', 64), draft('menu', 64)]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.count);
});

test('环境照 2 张返回 AGENT_IMAGE_COUNT_EXCEEDED', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([draft('store', 64), draft('store', 64)]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.count);
});

test('未知用途返回 AGENT_IMAGE_INVALID', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([{ kind: 'logo', mediaType: 'image/png', dataBase64: 'AAAA' }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.invalid);
});

test('GIF 返回 AGENT_IMAGE_TYPE_UNSUPPORTED', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([draft('menu', 64, 'image/gif')]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.type);
});

test('非严格 base64 返回 AGENT_IMAGE_INVALID', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([
    { kind: 'menu', mediaType: 'image/jpeg', dataBase64: 'AA-_' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.invalid);
});

test('长度不是 4 的倍数返回 AGENT_IMAGE_INVALID', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([
    { kind: 'menu', mediaType: 'image/jpeg', dataBase64: 'AAAAA' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.invalid);
});

test('单张 500 KiB 返回 AGENT_IMAGE_TOO_LARGE', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([draft('menu', 512000)]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.tooLarge);
});

test('单张 400 KiB 边界内合法', async () => {
  const { validateAgentImages } = await loadImages();
  const result = validateAgentImages([draft('menu', 409500)]);
  assert.equal(result.ok, true);
});

test('合计超过 1 MiB 返回 AGENT_IMAGE_TOO_LARGE', async () => {
  const { validateAgentImages, AGENT_IMAGE_ERROR_CODES } = await loadImages();
  const result = validateAgentImages([
    draft('menu', 358400),
    draft('menu', 358400),
    draft('store', 358400),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_IMAGE_ERROR_CODES.tooLarge);
});

test('estimateBase64Bytes 纯算术正确', async () => {
  const { estimateBase64Bytes } = await loadImages();
  assert.equal(estimateBase64Bytes(''), 0);
  assert.equal(estimateBase64Bytes('AAAA'), 3);
  assert.equal(estimateBase64Bytes('AAA='), 2);
  assert.equal(estimateBase64Bytes('AA=='), 1);
  assert.equal(estimateBase64Bytes(123), 0);
});

test('限制常量与契约一致', async () => {
  const { AGENT_IMAGE_LIMITS } = await loadImages();
  assert.deepEqual(AGENT_IMAGE_LIMITS, {
    maxMenuImages: 2,
    maxStoreImages: 1,
    maxTotalImages: 3,
    maxDecodedBytesPerImage: 409600,
    maxDecodedBytesTotal: 1048576,
    maxEdgePx: 1280,
    jpegQuality: 0.72,
  });
});