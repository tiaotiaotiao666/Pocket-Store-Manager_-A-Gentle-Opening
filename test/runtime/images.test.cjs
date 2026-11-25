'use strict';

/**
 * E0-R2：图片资产解析与真实多模态消息（X2 / rev15 §14.8）。
 *
 * 全部静态用例（fake 模型 + fake Coordinator + 临时 userDataDir，零真实上游）：
 * - `resolveAssetImage` 只认 assetId：canonical 在项目资产根内、拒 symlink/junction/越界；
 * - 魔数 + 真实 MIME（PNG/JPEG/WebP）+ 解码校验 + 单张 ≤2 MiB + E0 只 1 张；
 * - `buildMultimodalContent` 产出真实 `image_url` data URL，顺序稳定；
 * - data URL 只进调用内存：结果/trace/落盘全量扫描都不得出现；
 * - 无视觉能力 → AGENT_VISION_UNAVAILABLE（needs_input），绝不静默退化成纯文本；
 * - 缺图/坏图/超限/路径/base64 输入 → AGENT_IMAGE_INVALID，且**一次上游调用都不发**。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const runtime = require('../../desktop/agent-runtime');
const {
  createDirectWorkspaceRuntime,
  createModelChat,
  resolveAssetImage,
  resolveAssetImages,
  buildMultimodalContent,
  resolveVisionSupport,
  validateImageStructure,
  sniffImageMime,
  RUNTIME_CODES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} = runtime;

const { makeProbePng, makeNoisePng, sha256Of } = require('../../docs/evidence/workspace-agent/e0-r2/probe-tools.cjs');

const EVIDENCE_DIR = path.resolve(__dirname, '..', '..', 'docs', 'evidence', 'workspace-agent', 'e0-r2');
const CONTEXT = Object.freeze({
  projectId: 'p_r2asset01',
  runId: 'frun-r2',
  turnId: 'fturn-r2',
  attemptId: 'att-r2',
  subject: { kind: 'attempt', attemptId: 'att-r2' },
});

/* ------------------------------ 夹具 ------------------------------ */

const tempRoots = [];
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0r2-'));
  tempRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一个真实项目资产：`projects/<pid>/assets/images/<16hex>.png` + project.json 里的 images 元数据。
 * 元数据形状与 `desktop/asset-store.cjs` 一致（assetId / fileName / mime / bytes / sha256 / w / h）。
 */
function makeProjectAsset(options) {
  const opts = options || {};
  const userDataDir = opts.userDataDir || makeUserDataDir();
  const projectId = opts.projectId || CONTEXT.projectId;
  const buffer = opts.buffer || makeProbePng();
  const sha = sha256Of(buffer);
  const fileName = opts.fileName || `${sha.slice(0, 16)}.png`;
  const assetId = opts.assetId || `a_${sha.slice(0, 16)}`;
  const assetsDir = path.join(userDataDir, 'projects', projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  if (opts.fileContent !== undefined) {
    fs.writeFileSync(path.join(assetsDir, fileName), opts.fileContent);
  } else if (opts.materialize !== false) {
    fs.writeFileSync(path.join(assetsDir, fileName), buffer);
  }
  const meta = {
    assetId,
    fileName,
    originalName: 'reference.png',
    mime: opts.mime || 'image/png',
    bytes: opts.metaBytes === undefined ? buffer.length : opts.metaBytes,
    width: 96,
    height: 96,
    sha256: opts.metaSha256 === undefined ? `sha256:${sha}` : opts.metaSha256,
    createdAt: '2026-11-25T00:00:00Z',
  };
  const projectFile = path.join(userDataDir, 'projects', projectId, 'project.json');
  fs.writeFileSync(projectFile, JSON.stringify({ id: projectId, assets: { images: [meta] } }, null, 2), 'utf8');
  return { userDataDir, projectId, assetId, fileName, buffer, sha256: sha, assetsDir, projectFile, meta };
}

function makeModelChat(script, options) {
  const opts = options || {};
  const calls = [];
  let index = 0;
  return {
    calls,
    describe: () => ({
      transport: 'direct',
      wired: true,
      supportsVision: opts.supportsVision === true,
    }),
    chat: async (payload) => {
      calls.push(payload);
      const step = script[index] || { content: '收到。' };
      index += 1;
      return {
        model: opts.model || 'fake-vision-model',
        content: typeof step.content === 'string' ? step.content : '',
        toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls : [],
        usage: { promptTokens: 100, completionTokens: 20 },
        finishReason: step.finishReason === undefined ? 'stop' : step.finishReason,
        truncated: step.finishReason === 'length',
        maxTokens: 6000,
        profile: 'direct-edit',
      };
    },
  };
}

function makeCoordinator() {
  const calls = [];
  return {
    calls,
    invokeTool: async (input) => {
      calls.push(input);
      return { ok: true, data: { echoed: input.tool } };
    },
    assertRunActive: () => ({ ok: true }),
  };
}

function expectImageInvalid(fn) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, RUNTIME_CODES.IMAGE_INVALID, '必须是 AGENT_IMAGE_INVALID，实际 ' + error.code);
    return error;
  }
  throw new assert.AssertionError({ message: '应当抛 AGENT_IMAGE_INVALID，但没有抛' });
}

/** 目录快照（相对路径 → 字节数+sha256），用于断言拒绝路径零写入。 */
function snapshotTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out[relative] = 'link';
      } else if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        out[relative] = `${fs.statSync(full).size}:${sha256Of(fs.readFileSync(full))}`;
      }
    }
  };
  walk(root, '');
  return out;
}

/* ------------------------ 1) resolveAssetImage ------------------------ */

test('resolveAssetImage：按 assetId 解析出 mime/bytes/sha256/dataUrl，字段恰好是冻结形状', () => {
  const asset = makeProjectAsset();
  const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
  assert.deepEqual(Object.keys(image).sort(), ['assetId', 'bytes', 'dataUrl', 'mime', 'sha256']);
  assert.equal(image.assetId, asset.assetId);
  assert.equal(image.mime, 'image/png');
  assert.equal(image.bytes, asset.buffer.length);
  assert.equal(image.sha256, asset.sha256);
  assert.ok(image.dataUrl.startsWith('data:image/png;base64,'));
  const roundTrip = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
  assert.equal(roundTrip.length, asset.buffer.length, 'base64 解码后字节数必须与文件一致');
  assert.ok(roundTrip.equals(asset.buffer), 'base64 必须与文件逐字节一致');
});

test('resolveAssetImage：assetId 形状非法（路径 / base64 / 简写）一律 AGENT_IMAGE_INVALID', () => {
  const asset = makeProjectAsset();
  const bad = [
    '../../etc/passwd',
    'a_0123456789ABCDEF', // 大写不接受
    'a_0123456789abcde', // 15 位
    'data:image/png;base64,AAAA',
    'C:\\Windows\\win.ini',
    '',
  ];
  for (const assetId of bad) {
    const error = expectImageInvalid(() => resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId }));
    assert.equal(error.reason, 'asset_id_invalid', assetId + ' → ' + error.reason);
  }
  const missingProject = expectImageInvalid(() => resolveAssetImage({ userDataDir: asset.userDataDir, projectId: '../x', assetId: asset.assetId }));
  assert.equal(missingProject.reason, 'project_id_invalid');
  const missingRoot = expectImageInvalid(() => resolveAssetImage({ userDataDir: '', projectId: asset.projectId, assetId: asset.assetId }));
  assert.equal(missingRoot.reason, 'user_data_dir_missing');
});

test('resolveAssetImage：assetId 不在项目资产里 → asset_not_found', () => {
  const asset = makeProjectAsset();
  const error = expectImageInvalid(() => resolveAssetImage({
    userDataDir: asset.userDataDir,
    projectId: asset.projectId,
    assetId: 'a_0000000000000000',
  }));
  assert.equal(error.reason, 'asset_not_found');
});

test('resolveAssetImage：project.json 里 fileName 越界（../）→ asset_file_invalid', () => {
  const userDataDir = makeUserDataDir();
  const asset = makeProjectAsset({ userDataDir, fileName: '../escape.png' });
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId: asset.projectId, assetId: asset.assetId }));
  assert.equal(error.reason, 'asset_file_invalid');
});

test('resolveAssetImage：assets/images 整目录做成 junction 指向外部 → asset_root_outside_project', (t) => {
  const userDataDir = makeUserDataDir();
  const outsideDir = makeUserDataDir();
  const buffer = makeProbePng();
  const sha = sha256Of(buffer);
  const fileName = `${sha.slice(0, 16)}.png`;
  const assetId = `a_${sha.slice(0, 16)}`;
  fs.writeFileSync(path.join(outsideDir, fileName), buffer);
  const projectDir = path.join(userDataDir, 'projects', CONTEXT.projectId);
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
  try {
    fs.symlinkSync(outsideDir, path.join(projectDir, 'assets', 'images'), 'junction');
  } catch (error) {
    t.skip('本机无法创建 junction：' + error.code);
    return;
  }
  fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
    id: CONTEXT.projectId,
    assets: { images: [{ assetId, fileName, mime: 'image/png', bytes: buffer.length, sha256: 'sha256:' + sha }] },
  }), 'utf8');
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId: CONTEXT.projectId, assetId }));
  assert.equal(error.reason, 'asset_root_outside_project');
});

test('resolveAssetImage：projects/<A> junction 到 projects/<B> → project_identity_mismatch（目标零写）', (t) => {
  const userDataDir = makeUserDataDir();
  const targetProject = 'p_r2junc0002';
  const linkedProject = 'p_r2junc0001';
  const asset = makeProjectAsset({ userDataDir, projectId: targetProject });
  // 目标 project.json 故意写坏：若实现先读工程文件再判身份，会得到 project_unreadable；
  // 期望先做项目身份校验并拒绝（project_identity_mismatch），证明链接目标未被当作工程文件读取。
  fs.writeFileSync(asset.projectFile, '{ invalid json', 'utf8');
  const targetDir = path.join(userDataDir, 'projects', targetProject);
  const before = snapshotTree(targetDir);
  try {
    fs.symlinkSync(targetDir, path.join(userDataDir, 'projects', linkedProject), 'junction');
  } catch (error) {
    t.skip('本机无法创建目录 junction：' + error.code);
    return;
  }
  const error = expectImageInvalid(() => resolveAssetImage({
    userDataDir,
    projectId: linkedProject,
    assetId: asset.assetId,
  }));
  assert.equal(error.reason, 'project_identity_mismatch');
  assert.deepEqual(snapshotTree(targetDir), before, '拒绝后链接目标不得被改写（零写入）');
});

test('resolveAssetImage：资产文件本身是 symlink → asset_symlink_rejected', (t) => {
  const userDataDir = makeUserDataDir();
  const outsideDir = makeUserDataDir();
  const buffer = makeProbePng();
  const sha = sha256Of(buffer);
  const fileName = `${sha.slice(0, 16)}.png`;
  const assetId = `a_${sha.slice(0, 16)}`;
  const outsideFile = path.join(outsideDir, 'real.png');
  fs.writeFileSync(outsideFile, buffer);
  const assetsDir = path.join(userDataDir, 'projects', CONTEXT.projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  try {
    fs.symlinkSync(outsideFile, path.join(assetsDir, fileName), 'file');
  } catch (error) {
    t.skip('本机无法创建文件 symlink（需要开发者模式）：' + error.code);
    return;
  }
  fs.writeFileSync(path.join(userDataDir, 'projects', CONTEXT.projectId, 'project.json'), JSON.stringify({
    id: CONTEXT.projectId,
    assets: { images: [{ assetId, fileName, mime: 'image/png', bytes: buffer.length, sha256: 'sha256:' + sha }] },
  }), 'utf8');
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId: CONTEXT.projectId, assetId }));
  assert.equal(error.reason, 'asset_symlink_rejected');
});

test('resolveAssetImage：声明 MIME 与魔数不一致 → mime_mismatch（不信任扩展名/元数据）', () => {
  const asset = makeProjectAsset({ mime: 'image/jpeg' });
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId }));
  assert.equal(error.reason, 'mime_mismatch');
});

test('resolveAssetImage：非图片内容 → unsupported_type', () => {
  const userDataDir = makeUserDataDir();
  const text = Buffer.from('这不是图片，只是一段文本内容，用来验证魔数校验。');
  const asset = makeProjectAsset({ userDataDir, buffer: text, fileName: 'aaaaaaaaaaaaaaaa.png', mime: 'image/png' });
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId: asset.projectId, assetId: asset.assetId }));
  assert.equal(error.reason, 'unsupported_type');
});

test('resolveAssetImage：PNG 被截断（缺 IEND）→ 解码校验拒绝', () => {
  const userDataDir = makeUserDataDir();
  const full = makeProbePng();
  const truncated = full.subarray(0, full.length - 20);
  const asset = makeProjectAsset({ userDataDir, buffer: truncated, fileName: 'bbbbbbbbbbbbbbbb.png' });
  const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId: asset.projectId, assetId: asset.assetId }));
  assert.ok(['png_chunk_truncated', 'png_missing_iend', 'png_missing_idat'].includes(error.reason), error.reason);
});

test('resolveAssetImage：内容与登记摘要/大小不一致 → 拒绝（防篡改）', () => {
  const digestCase = makeProjectAsset({ metaSha256: 'sha256:' + 'f'.repeat(64) });
  const digestError = expectImageInvalid(() => resolveAssetImage({
    userDataDir: digestCase.userDataDir,
    projectId: digestCase.projectId,
    assetId: digestCase.assetId,
  }));
  assert.equal(digestError.reason, 'asset_digest_mismatch');

  const sizeCase = makeProjectAsset({ metaBytes: 999999 });
  const sizeError = expectImageInvalid(() => resolveAssetImage({
    userDataDir: sizeCase.userDataDir,
    projectId: sizeCase.projectId,
    assetId: sizeCase.assetId,
  }));
  assert.equal(sizeError.reason, 'asset_size_mismatch');
});

test('resolveAssetImage：单张 ≤2 MiB 生效（1.40 MiB 通过、2.32 MiB 拒绝）', () => {
  const under = makeProjectAsset({ buffer: makeNoisePng({ size: 700, level: 0 }) });
  const okImage = resolveAssetImage({ userDataDir: under.userDataDir, projectId: under.projectId, assetId: under.assetId });
  assert.ok(okImage.bytes <= MAX_IMAGE_BYTES);
  assert.equal(okImage.mime, 'image/png');

  const over = makeProjectAsset({ buffer: makeNoisePng({ size: 900, level: 0 }) });
  assert.ok(over.buffer.length > MAX_IMAGE_BYTES, '样本必须大于 2 MiB，实际 ' + over.buffer.length);
  const error = expectImageInvalid(() => resolveAssetImage({
    userDataDir: over.userDataDir,
    projectId: over.projectId,
    assetId: over.assetId,
  }));
  assert.equal(error.reason, 'image_too_large');

  // 调用方也不许把上限抬高到 2 MiB 以上。
  const raised = expectImageInvalid(() => resolveAssetImage({
    userDataDir: over.userDataDir,
    projectId: over.projectId,
    assetId: over.assetId,
    limits: { maxBytes: 50 * 1024 * 1024 },
  }));
  assert.equal(raised.reason, 'image_too_large');
});

test('resolveAssetImages：E0 只接受 1 张目标页参考图（2 张 → too_many_images）', () => {
  const asset = makeProjectAsset();
  const single = resolveAssetImages({
    userDataDir: asset.userDataDir,
    projectId: asset.projectId,
    assetIds: [asset.assetId],
  });
  assert.equal(single.images.length, 1);
  assert.equal(MAX_IMAGES_PER_TURN, 1);
  assert.deepEqual(Object.keys(single.meta[0]).sort(), ['assetId', 'bytes', 'mime', 'sha256'], 'meta 不得含 dataUrl');
  const error = expectImageInvalid(() => resolveAssetImages({
    userDataDir: asset.userDataDir,
    projectId: asset.projectId,
    assetIds: [asset.assetId, asset.assetId],
  }));
  assert.equal(error.reason, 'too_many_images');
});

test('JPEG / WebP 的魔数与结构校验（非法样本拒绝、结构合法样本识别出真实宽高）', () => {
  // 结构合法但语义极简的 JPEG 头（SOI + APP0 + SOF0(2×2) + SOS + EOI）
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.alloc(9, 0),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.alloc(140, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(sniffImageMime(jpeg), 'image/jpeg');
  const jpegInfo = validateImageStructure(jpeg, 'image/jpeg');
  assert.deepEqual({ width: jpegInfo.width, height: jpegInfo.height }, { width: 2, height: 2 });
  expectImageInvalid(() => validateImageStructure(jpeg.subarray(0, 40), 'image/jpeg'));

  // WebP：RIFF/WEBP + VP8X（含画布尺寸）
  const vp8xPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // flags + reserved
    Buffer.from([0x3f, 0x00, 0x00]), // width-1 = 63
    Buffer.from([0x3f, 0x00, 0x00]), // height-1 = 63
    Buffer.from([0x00, 0x00]), // 补足到 32 字节以上的合法块
  ]);
  const vp8x = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8X', 'ascii'),
    Buffer.alloc(4),
    vp8xPayload,
  ]);
  vp8x.writeUInt32LE(4 + 8 + vp8xPayload.length, 4);
  vp8x.writeUInt32LE(vp8xPayload.length, 16);
  assert.equal(sniffImageMime(vp8x), 'image/webp');
  const webpInfo = validateImageStructure(vp8x, 'image/webp');
  assert.deepEqual({ width: webpInfo.width, height: webpInfo.height }, { width: 64, height: 64 });
  // RIFF 长度与文件长度不符 → 拒绝
  const brokenWebp = Buffer.from(vp8x);
  brokenWebp.writeUInt32LE(9999, 4);
  expectImageInvalid(() => validateImageStructure(brokenWebp, 'image/webp'));
});

/* ---------------------- 2) buildMultimodalContent ---------------------- */

test('buildMultimodalContent：text 在前、image_url 在后，顺序稳定且 data URL 真实', () => {
  const asset = makeProjectAsset();
  const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
  const first = buildMultimodalContent({ utterance: '这张参考图的主色是什么？', images: [image] });
  const second = buildMultimodalContent({ utterance: '这张参考图的主色是什么？', images: [image] });
  assert.deepEqual(first, second, '同一输入必须得到完全相同的 parts');
  assert.equal(first.length, 2);
  assert.equal(first[0].type, 'text');
  assert.equal(first[0].text, '这张参考图的主色是什么？');
  assert.equal(first[1].type, 'image_url');
  assert.ok(first[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(
    Buffer.from(first[1].image_url.url.split(',')[1], 'base64').length,
    asset.buffer.length,
    '发给上游的 data URL 字节数必须与文件一致',
  );
  // 无图时退化为单 text 块（不是空数组，也不是占位图片）
  assert.deepEqual(
    buildMultimodalContent({ utterance: '只改文案' }),
    [{ type: 'text', text: '只改文案' }],
  );
  // 有图但没给指令 → 固定引导语，保证 text 块非空
  const imageOnly = buildMultimodalContent({ utterance: '   ', images: [image] });
  assert.equal(imageOnly[0].type, 'text');
  assert.ok(imageOnly[0].text.trim().length > 0);
});

test('buildMultimodalContent：拒绝裸 base64 / 非受支持 MIME / 2 张图', () => {
  const asset = makeProjectAsset();
  const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
  expectImageInvalid(() => buildMultimodalContent({ utterance: 'x', images: ['aGVsbG8='] }));
  expectImageInvalid(() => buildMultimodalContent({
    utterance: 'x',
    images: [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
  }));
  const tooMany = expectImageInvalid(() => buildMultimodalContent({ utterance: 'x', images: [image, image] }));
  assert.equal(tooMany.reason, 'too_many_images');
});

test('resolveVisionSupport：只有显式 true 才算有视觉能力（默认 fail-closed）', () => {
  assert.equal(resolveVisionSupport({ vision: true }).ok, true);
  const disabled = resolveVisionSupport({ vision: false });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.code, RUNTIME_CODES.VISION_UNAVAILABLE);
  const undeclared = resolveVisionSupport({ modelDescribe: { transport: 'direct' } });
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.error.reason, 'vision_unsupported');
  assert.equal(resolveVisionSupport({ modelDescribe: { supportsVision: true } }).ok, true);
  // createModelChat 把 supportsVision 带进 describe()
  assert.equal(createModelChat({ chat: async () => ({}), supportsVision: true }).describe().supportsVision, true);
  assert.equal(createModelChat({ chat: async () => ({}) }).describe().supportsVision, false);
});

/* ------------------------- 3) runtime 集成 ------------------------- */

test('direct 回合带图：消息里真的出现 image_url data URL，并回传只含元数据的 images', async () => {
  const asset = makeProjectAsset();
  const modelChat = makeModelChat([{ content: '图里有一个红色圆形和一个蓝色方块。' }], { supportsVision: true });
  const coordinator = makeCoordinator();
  const run = createDirectWorkspaceRuntime({ coordinator, modelChat, userDataDir: asset.userDataDir });
  const result = await run.invoke({
    context: CONTEXT,
    request: { utterance: '这张图里有哪些形状和颜色？', images: [asset.assetId] },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(modelChat.calls.length, 1);
  const sent = modelChat.calls[0].messages;
  assert.equal(sent[0].role, 'system');
  const userMessage = sent.find((message) => message.role === 'user');
  assert.ok(Array.isArray(userMessage.content), '带图消息的 content 必须是 parts 数组');
  assert.equal(userMessage.content[0].type, 'text');
  assert.equal(userMessage.content[1].type, 'image_url');
  const dataUrl = userMessage.content[1].image_url.url;
  assert.ok(dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(dataUrl.split(',')[1], 'base64').length, asset.buffer.length);
  // 结果只带元数据（sha256 供证据复核），绝不含 data URL / base64
  assert.deepEqual(result.data.images, [{
    assetId: asset.assetId,
    mime: 'image/png',
    bytes: asset.buffer.length,
    sha256: asset.sha256,
  }]);
  assert.equal(result.data.multimodal, true);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('data:image'), '结果里不得出现 data URL');
  assert.ok(!serialized.includes(asset.buffer.toString('base64').slice(0, 64)), '结果里不得出现图片 base64');
});

test('无视觉能力：AGENT_VISION_UNAVAILABLE + needs_input，且一次上游调用都不发', async () => {
  const asset = makeProjectAsset();
  for (const [label, options] of [
    ['模型未声明视觉（auto）', { supportsVision: false }],
    ['显式声明不支持', { supportsVision: true, visionOption: false }],
  ]) {
    const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: options.supportsVision });
    const run = createDirectWorkspaceRuntime({
      coordinator: makeCoordinator(),
      modelChat,
      userDataDir: asset.userDataDir,
      ...(options.visionOption === undefined ? {} : { vision: options.visionOption }),
    });
    const result = await run.invoke({ context: CONTEXT, request: { utterance: '看看这张图', images: [asset.assetId] } });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, RUNTIME_CODES.VISION_UNAVAILABLE, label);
    assert.equal(result.data.status, 'needs_input', label);
    assert.equal(result.data.stopReason, 'vision_unavailable', label);
    assert.equal(modelChat.calls.length, 0, label + '：不得静默按纯文本发送');
  }
});

test('缺图 / 坏图 / 超限 / 路径 / base64 输入：AGENT_IMAGE_INVALID，且一次上游调用都不发', async () => {
  const asset = makeProjectAsset();
  const cases = [
    { label: '不存在的 assetId', images: ['a_0000000000000000'], status: 'needs_input' },
    { label: '路径输入', images: [path.join(asset.assetsDir, asset.fileName)], status: 'failed' },
    { label: 'base64 输入', images: ['data:image/png;base64,iVBORw0KGgo='], status: 'failed' },
    { label: '对象但无 assetId', images: [{ path: 'C:\\x.png' }], status: 'failed' },
    { label: 'images 不是数组', images: 'a_0000000000000000', status: 'failed' },
  ];
  for (const item of cases) {
    const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: true });
    const run = createDirectWorkspaceRuntime({ coordinator: makeCoordinator(), modelChat, userDataDir: asset.userDataDir });
    const result = await run.invoke({ context: CONTEXT, request: { utterance: '看看这张图', images: item.images } });
    assert.equal(result.ok, false, item.label);
    assert.equal(result.code, RUNTIME_CODES.IMAGE_INVALID, item.label + ' → ' + result.code);
    assert.equal(result.data.status, item.status, item.label);
    assert.equal(modelChat.calls.length, 0, item.label + '：不得因缺图悄悄跑纯文本');
  }

  // 坏图（截断）/超限同样走 IMAGE_INVALID
  const userDataDir = makeUserDataDir();
  const brokenBuffer = makeProbePng().subarray(0, 100);
  const broken = makeProjectAsset({ userDataDir, buffer: brokenBuffer, fileName: 'cccccccccccccccc.png' });
  const brokenRun = createDirectWorkspaceRuntime({
    coordinator: makeCoordinator(),
    modelChat: makeModelChat([{}], { supportsVision: true }),
    userDataDir,
  });
  const brokenResult = await brokenRun.invoke({ context: CONTEXT, request: { utterance: '看看', images: [broken.assetId] } });
  assert.equal(brokenResult.code, RUNTIME_CODES.IMAGE_INVALID);

  const overUserData = makeUserDataDir();
  const over = makeProjectAsset({ buffer: makeNoisePng({ size: 900, level: 0 }), userDataDir: overUserData });
  const overModel = makeModelChat([{}], { supportsVision: true });
  const overRun = createDirectWorkspaceRuntime({
    coordinator: makeCoordinator(),
    modelChat: overModel,
    userDataDir: overUserData,
  });
  const overResult = await overRun.invoke({ context: CONTEXT, request: { utterance: '看看', images: [over.assetId] } });
  assert.equal(overResult.code, RUNTIME_CODES.IMAGE_INVALID);
  assert.equal(overModel.calls.length, 0);
});

test('只给 assetId 文本（不放进 images）时是纯文本调用：content 是字符串，绝不产生多模态证据', async () => {
  const asset = makeProjectAsset();
  const modelChat = makeModelChat([{ content: '我看不到图，只能按你的文字描述处理。' }], { supportsVision: true });
  const run = createDirectWorkspaceRuntime({ coordinator: makeCoordinator(), modelChat, userDataDir: asset.userDataDir });
  const result = await run.invoke({
    context: CONTEXT,
    request: { utterance: `参考图 assetId 是 ${asset.assetId}，请按它调整配色。` },
  });
  assert.equal(result.ok, true);
  const userMessage = modelChat.calls[0].messages.find((message) => message.role === 'user');
  assert.equal(typeof userMessage.content, 'string', '把 assetId 当文本时不得构造 image_url');
  assert.equal(result.data.multimodal, false);
  assert.deepEqual(result.data.images, []);
});

test('多图请求（2 张）在 runtime 层被拒：AGENT_IMAGE_INVALID，不发上游', async () => {
  const asset = makeProjectAsset();
  const modelChat = makeModelChat([{}], { supportsVision: true });
  const run = createDirectWorkspaceRuntime({ coordinator: makeCoordinator(), modelChat, userDataDir: asset.userDataDir });
  const result = await run.invoke({
    context: CONTEXT,
    request: { utterance: '看看这两张', images: [asset.assetId, asset.assetId] },
  });
  assert.equal(result.code, RUNTIME_CODES.IMAGE_INVALID);
  assert.equal(modelChat.calls.length, 0);
});

test('进度回调出现 image 阶段（§14.9 stage 白名单），且 detail 不含图片内容', async () => {
  const asset = makeProjectAsset();
  const events = [];
  const run = createDirectWorkspaceRuntime({
    coordinator: makeCoordinator(),
    modelChat: makeModelChat([{ content: 'ok' }], { supportsVision: true }),
    userDataDir: asset.userDataDir,
    onProgress: (event) => events.push(event),
  });
  await run.invoke({ context: CONTEXT, request: { utterance: '看看它', images: [asset.assetId] } });
  const imageEvents = events.filter((event) => event.stage === 'image');
  assert.deepEqual(imageEvents.map((event) => event.status), ['running', 'succeeded']);
  for (const event of events) {
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes('data:image'), '进度事件不得带 data URL');
    assert.ok(!serialized.includes(asset.buffer.toString('base64').slice(0, 32)), '进度事件不得带图片 base64');
  }
});

test('data URL 只进调用内存：落盘扫描对真实内联图片载荷/样本 base64 均 0 命中', async () => {
  const asset = makeProjectAsset();
  const run = createDirectWorkspaceRuntime({
    coordinator: makeCoordinator(),
    modelChat: makeModelChat([{ content: '图里是红色圆形与蓝色方块。' }], { supportsVision: true }),
    userDataDir: asset.userDataDir,
  });
  const result = await run.invoke({ context: CONTEXT, request: { utterance: '看图说颜色', images: [asset.assetId] } });
  assert.equal(result.ok, true);

  const base64Needle = asset.buffer.toString('base64').slice(0, 48);
  const scan = (root) => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const text = fs.readFileSync(full, 'latin1');
        // 判据是**真实内联图片载荷**：完整 data URL 前缀或样本 base64。
        // 报告里的说明文字（例如“不得出现 data:image”本身）不是图片载荷，不能误报。
        if (/data:image\/(?:png|jpeg|webp);base64,/i.test(text) || text.includes(base64Needle)) found.push(full);
      }
    };
    walk(root);
    return found;
  };
  // userDataDir 下只应有 project.json 与原始 PNG（PNG 是二进制，不会出现内联 URL 文本）
  assert.deepEqual(scan(asset.userDataDir), [], 'userDataDir 里不得出现任意 data: 字面量 / base64');
  // 卫生规则只针对“证据输出”（json/md/txt/log）；可执行取证脚本中的普通 JS 字段如 data: null 不是图片载荷。
  const outputEvidence = scan(EVIDENCE_DIR).filter((file) => /\.(?:json|md|txt|log)$/i.test(file));
  assert.deepEqual(outputEvidence, [], 'e0-r2 证据输出里不得出现任意 data: 字面量 / base64');

  // 证据目录里的 real-call.json 单列断言（t21 OBS-E 的判据）
  const realCallFile = path.join(EVIDENCE_DIR, 'real-call.json');
  const realCallText = fs.readFileSync(realCallFile, 'latin1');
  // 模型回复可能出现普通 JSON 字段字样（data: null），不是图片载荷；只拒绝真实内联图片 URL。
  assert.ok(!/data:image\/(?:png|jpeg|webp);base64,/i.test(realCallText),
    'real-call.json 不得出现真实内联图片 URL');
  assert.ok(!realCallText.includes(base64Needle), 'real-call.json 不得出现样本 base64');

  // 项目文档与结果对象都没有被追加图片内容
  const doc = fs.readFileSync(asset.projectFile, 'utf8');
  assert.ok(!doc.includes('data:'));
  assert.ok(!doc.includes(base64Needle));
  assert.ok(!JSON.stringify(result).includes('data:image/'));
  assert.ok(!JSON.stringify(result).includes(base64Needle));
});

test('run-real-call 的 PASS 报告构造不含任何 data: 字面量（X2 证据卫生）', () => {
  const { buildRealCallReport } = require('../../docs/evidence/workspace-agent/e0-r2/run-real-call.cjs');
  const probeBytes = fs.readFileSync(path.join(EVIDENCE_DIR, 'probe.png'));
  const probeSha = sha256Of(probeBytes);
  const report = buildRealCallReport({
    status: 'PASS',
    model: 'deepseek-flash',
    question: '这张参考图里主要有哪些颜色和形状？',
    probe: { file: 'probe.png', sha256: probeSha, bytes: probeBytes.length, assetId: `a_${probeSha.slice(0, 16)}` },
    sentParts: {
      types: ['text', 'image_url'],
      hasImageUrl: true,
      imageUrlScheme: 'inline-data-url',
      dataUrlBytes: probeBytes.length,
      sentSha256MatchesProbe: true,
    },
    coordinator: { mode: 'stub', treeDigest: null },
    cases: [{
      label: 'A-带图',
      ok: true,
      images: [{ assetId: `a_${probeSha.slice(0, 16)}`, mime: 'image/png', bytes: probeBytes.length, sha256: probeSha }],
    }],
    verdict: { x2RealCall: 'PASS', counterexamplesClean: true, productionToolSet: true },
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes('data:'), 'PASS 报告不得出现任何 data: 字面量（t8 真实调用后扫描用例必须仍绿）');
  assert.equal(report.status, 'PASS');
  assert.equal(report.sentParts.hasImageUrl, true);
  assert.equal(report.sentParts.imageUrlScheme, 'inline-data-url');
  assert.equal(report.sentParts.dataUrlBytes, probeBytes.length);
  assert.equal(report.cases[0].images[0].sha256, probeSha);
});

test('归档的真实样本可复核：docs/evidence/workspace-agent/e0-r2/probe.png 与报告里的 sha256 一致', () => {
  const probePath = path.join(EVIDENCE_DIR, 'probe.png');
  assert.ok(fs.existsSync(probePath), '真实样本必须归档到证据目录（不要事后清理唯一原件）');
  const buffer = fs.readFileSync(probePath);
  const info = validateImageStructure(buffer, 'image/png');
  assert.equal(info.mime, 'image/png');
  assert.ok(info.width >= 64 && info.height >= 64, '样本必须 ≥64×64，实际 ' + info.width + '×' + info.height);
  assert.deepEqual({ width: info.width, height: info.height }, { width: 96, height: 96 });
  assert.equal(sha256Of(buffer), sha256Of(makeProbePng()), '归档样本必须与生成器输出逐字节一致（可复现）');
  const report = fs.readFileSync(path.join(EVIDENCE_DIR, 'report.md'), 'utf8');
  assert.ok(report.includes(sha256Of(buffer)), '报告必须记录该样本的 sha256');
  assert.ok(!report.includes('data:image/'), '报告不得内联 data URL');
  // 解密回 PNG 后的像素确实不是纯色（真的是一张图，不是纯色探针）
  const distinct = new Set();
  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = require('node:zlib').inflateSync(Buffer.concat(idat));
  for (let index = 0; index < raw.length; index += 1) distinct.add(raw[index]);
  assert.ok(distinct.size > 5, '像素必须有多种取值（非纯色），实际 ' + distinct.size);
});

test('crypto 摘要与本地实现一致（样本 sha256 可被外部工具复核）', () => {
  const buffer = makeProbePng();
  assert.equal(sha256Of(buffer), crypto.createHash('sha256').update(buffer).digest('hex'));
  assert.equal(sniffImageMime(buffer), 'image/png');
});
