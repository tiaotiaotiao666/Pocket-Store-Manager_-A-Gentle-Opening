'use strict';

/**
 * E0-R2：图片真的进了**上游请求体**（X2 / rev15 §14.8）。
 *
 * 这一层比 `images.test.cjs` 更靠外一环：走真实的 `model-credentials.cjs#requestChat`，
 * 用 fake fetch 捕获**实际发出的 HTTP body**，断言：
 * - `messages[last].content` 是 parts 数组，含 `image_url` 且 data URL 前缀/mime 正确；
 * - base64 解码后的字节数与本机文件一致（不是占位、不是空串）；
 * - 请求体里没有把 assetId 当图片（只接受真实 data URL）；
 * - 通道自身的更严上限（单张 400 KiB）会通过 `assertChannelAccepts` 提前变成
 *   `AGENT_IMAGE_INVALID`，而不是事后 `MODEL_REQUEST_INVALID`，也绝不静默丢图。
 *
 * 真实上游调用 0 次。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
const { createModelCredentials } = credentialsMod;
const {
  resolveAssetImage,
  buildMultimodalContent,
  assertChannelAccepts,
  createModelChat,
  createDirectWorkspaceRuntime,
  RUNTIME_CODES,
} = require(path.join(ROOT, 'desktop', 'agent-runtime'));
const { makeProbePng, makeNoisePng, sha256Of } = require(path.join(ROOT, 'docs', 'evidence', 'workspace-agent', 'e0-r2', 'probe-tools.cjs'));

const API_KEY = 'sk-test-0123456789abcdef';
const BASE_URL = 'https://api.deepseek.com';
const PROJECT_ID = 'p_r2upstr01';

/** 模块级令牌目录（调度器是单例，目录不能在用例之间被删）。 */
const TOKEN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e0r2-upstream-slots-'));

test.after(() => {
  try {
    credentialsMod.resetSharedModelCallScheduler();
  } catch (error) {
    /* 清理不影响断言结果 */
  }
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buffer) => {
      const raw = buffer.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

function makeUpstream() {
  const bodies = [];
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek-flash',
          choices: [{ message: { content: '图里是红色圆形和蓝色方块。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 12 },
        }),
      };
    },
  };
}

async function makeCredentials(upstream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0r2-upstream-'));
  credentialsMod.resetSharedModelCallScheduler();
  const credentials = createModelCredentials({
    userDataDir: dir,
    safeStorage: fakeSafeStorage(),
    fetchImpl: upstream.fetchImpl,
    env: { MODEL_UPSTREAM_TOKEN_DIR: TOKEN_DIR },
  });
  await credentials.setKey(API_KEY);
  return { credentials, dir };
}

/** 造一个真实项目资产（与 asset-store 的形状一致）。 */
function makeProjectAsset(buffer) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0r2-data-'));
  const bytes = buffer || makeProbePng();
  const sha = sha256Of(bytes);
  const fileName = `${sha.slice(0, 16)}.png`;
  const assetId = `a_${sha.slice(0, 16)}`;
  const assetsDir = path.join(userDataDir, 'projects', PROJECT_ID, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, fileName), bytes);
  fs.writeFileSync(
    path.join(userDataDir, 'projects', PROJECT_ID, 'project.json'),
    JSON.stringify({
      id: PROJECT_ID,
      assets: { images: [{ assetId, fileName, mime: 'image/png', bytes: bytes.length, sha256: 'sha256:' + sha }] },
    }),
    'utf8',
  );
  return { userDataDir, assetId, sha256: sha, bytes };
}

test('fake 上游断言：真实请求体里有 image_url data URL，前缀/mime/字节数全部对得上', async () => {
  const asset = makeProjectAsset();
  const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: PROJECT_ID, assetId: asset.assetId });
  const parts = buildMultimodalContent({ utterance: '这张参考图的主色是什么？', images: [image] });
  const upstream = makeUpstream();
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const result = await credentials.chat({
      baseUrl: BASE_URL,
      model: 'deepseek-flash',
      profile: 'direct-edit',
      messages: [
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: parts },
      ],
    });
    assert.equal(result.content.length > 0, true);

    assert.equal(upstream.bodies.length, 1, '一次 chat 只发一次上游请求');
    const body = upstream.bodies[0];
    const userMessage = body.messages.find((message) => message.role === 'user');
    assert.ok(Array.isArray(userMessage.content), '上游请求体里的用户消息必须是 parts 数组');
    const textPart = userMessage.content.find((part) => part.type === 'text');
    const imagePart = userMessage.content.find((part) => part.type === 'image_url');
    assert.ok(textPart && textPart.text.includes('主色'), '文本块必须保留用户指令');
    assert.ok(imagePart, '必须真的有 image_url 块');
    assert.equal(typeof imagePart.image_url.url, 'string');
    assert.ok(imagePart.image_url.url.startsWith('data:image/png;base64,'), 'mime 前缀必须是 image/png');
    const sentBytes = Buffer.from(imagePart.image_url.url.split(',')[1], 'base64');
    assert.equal(sentBytes.length, asset.bytes.length, '发送字节数必须与本机文件一致');
    assert.equal(sha256Of(sentBytes), asset.sha256, '发送内容摘要必须与本机文件一致');
    // 请求体里没有任何 assetId 冒充图片
    assert.ok(!JSON.stringify(body).includes(asset.assetId), '不得把 assetId 当视觉输入发给上游');
    // 图片只在内存：请求体之外没有落盘文件
    const strayFiles = [];
    const walk = (root) => {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) walk(full);
        else strayFiles.push(full);
      }
    };
    walk(dir);
    walk(asset.userDataDir);
    for (const file of strayFiles) {
      const text = fs.readFileSync(file, 'latin1');
      assert.ok(!text.includes('data:image/'), '落盘文件不得出现 data URL：' + file);
    }
  } finally {
    credentials?.schedulerStats && credentials.schedulerStats();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(asset.userDataDir, { recursive: true, force: true });
  }
});

test('通道上限（400 KiB）比 §14.8 更严：预检把它变成 AGENT_IMAGE_INVALID，而不是静默丢图', async () => {
  const bigBuffer = makeNoisePng({ size: 480, level: 0 }); // ≈660 KiB：> 400 KiB 通道上限，< 2 MiB §14.8 上限
  const asset = makeProjectAsset(bigBuffer);
  try {
    assert.ok(bigBuffer.length <= 2 * 1024 * 1024, '样本必须仍在 §14.8 的 2 MiB 之内');
    assert.ok(bigBuffer.length > 400 * 1024, '样本必须超过通道的 400 KiB 上限');
    const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: PROJECT_ID, assetId: asset.assetId });
    assert.equal(image.bytes, bigBuffer.length, '§14.8 的 2 MiB 解析器应当接受它');
    const parts = buildMultimodalContent({ utterance: '看这张大图', images: [image] });
    let mapped = null;
    try {
      assertChannelAccepts([{ role: 'user', content: parts }]);
    } catch (error) {
      mapped = error;
    }
    assert.ok(mapped, '必须被预检拦下（而不是等上游 400）');
    assert.equal(mapped.code, RUNTIME_CODES.IMAGE_INVALID);
    assert.equal(mapped.reason, 'channel_rejected');

    // runtime 层也必须真的 0 上游调用：用同一个超限 asset 走完整的 run.invoke。
    const calls = [];
    const modelChat = createModelChat({
      chat: async (payload) => {
        calls.push(payload);
        return { model: 'deepseek-flash', content: '不该被调用', finishReason: 'stop' };
      },
      supportsVision: true,
    });
    const coordinator = {
      invokeTool: async () => ({ ok: true, data: null }),
      assertRunActive: () => ({ ok: true }),
    };
    const run = createDirectWorkspaceRuntime({
      coordinator,
      modelChat,
      userDataDir: asset.userDataDir,
    });
    const result = await run.invoke({
      context: { projectId: PROJECT_ID, runId: 'frun-big', turnId: 'fturn-big', attemptId: 'att-big' },
      request: { utterance: '看这张大图', images: [asset.assetId] },
    });
    assert.equal(result.ok, false, '超 400 KiB 的图必须在 runtime 层被拒');
    assert.equal(result.code, RUNTIME_CODES.IMAGE_INVALID);
    assert.equal(result.issues[0].code, 'channel_rejected');
    assert.equal(result.data && result.data.status, 'needs_input');
    assert.equal(calls.length, 0, 'runtime 层不得发出任何上游调用');
  } finally {
    fs.rmSync(asset.userDataDir, { recursive: true, force: true });
  }
});

test('runtime 带图回合：走真实 credentials + fake fetch，上游收到的就是 image_url data URL', async () => {
  const asset = makeProjectAsset();
  const upstream = makeUpstream();
  const { credentials, dir } = await makeCredentials(upstream);
  try {
    const modelChat = createModelChat({ credentials, supportsVision: true });
    const coordinator = { invokeTool: async () => ({ ok: true, data: null }), assertRunActive: () => ({ ok: true }) };
    const run = createDirectWorkspaceRuntime({ coordinator, modelChat, userDataDir: asset.userDataDir });
    const result = await run.invoke({
      context: { projectId: PROJECT_ID, runId: 'frun-up', turnId: 'fturn-up', attemptId: 'att-up' },
      request: {
        utterance: '图里有什么形状？',
        images: [asset.assetId],
        maxTokens: 6000,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(upstream.bodies.length, 1);
    const body = upstream.bodies[0];
    // t13：本用例不再收窄工具集，出站 body 必须带全 §14.3 的 11 个模型工具（生产默认路径）。
    assert.equal(Array.isArray(body.tools) ? body.tools.length : 0, 11);
    const userMessage = body.messages.find((message) => message.role === 'user');
    const imagePart = userMessage.content.find((part) => part.type === 'image_url');
    assert.ok(imagePart && imagePart.image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(
      sha256Of(Buffer.from(imagePart.image_url.url.split(',')[1], 'base64')),
      asset.sha256,
      '上游收到的图片摘要必须与归档样本一致',
    );
    assert.deepEqual(result.data.images, [
      { assetId: asset.assetId, mime: 'image/png', bytes: asset.bytes.length, sha256: asset.sha256 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(asset.userDataDir, { recursive: true, force: true });
  }
});
