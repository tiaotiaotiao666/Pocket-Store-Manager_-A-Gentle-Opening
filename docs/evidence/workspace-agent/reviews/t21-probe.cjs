'use strict';

/**
 * t21（Review-t7 round 2）独立探针。
 *
 * 只读复核 t7/E0-R2 的产品实现与 t20 的两条修复：
 * - F1：真实取证脚本的 PASS 报告不得出现任何 `data:` 字面量；证据目录扫描必须保持干净；
 * - F2：“通道上限 400 KiB”用例必须真的构造 runtime 并断言上游调用 0 次。
 *
 * 另独立复核 §14.8 的关键安全边界（assetId 唯一入口、canonical/junction、魔数+真解码、
 * 摘要/大小防篡改、单图、视觉 fail-closed、失败 0 上游、落盘无 data URL/base64），
 * 以及真实 Coordinator attempt/run.json 的落盘扫描。**不引用 t7 测试断言**；
 * PNG 样本复用证据目录的确定性生成器，仅用于造样本。
 *
 * 运行：node docs/evidence/workspace-agent/reviews/t21-probe.cjs
 * 退出码：0 = 全部成立；1 = 至少一条不成立；2 = 探针自身错误。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RUNTIME_DIR = path.join(ROOT, 'desktop', 'agent-runtime');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'workspace-agent', 'e0-r2');
const runtime = require(RUNTIME_DIR);
const versions = require(path.join(ROOT, 'desktop', 'agent-workspace', 'versions.cjs'));
const { createRunCoordinator } = require(path.join(ROOT, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
const { makeProbePng, makeNoisePng, sha256Of } = require(path.join(EVIDENCE_DIR, 'probe-tools.cjs'));

const {
  resolveAssetImage,
  resolveAssetImages,
  buildMultimodalContent,
  createDirectWorkspaceRuntime,
  validateImageStructure,
  RUNTIME_CODES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} = runtime;

const results = [];
const observations = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
}
function obs(id, severity, detail) {
  observations.push({ id, severity, detail });
}
async function check(id, fn) {
  try {
    const detail = await fn();
    record(id, 'pass', detail === undefined ? 'ok' : detail);
  } catch (error) {
    record(id, 'fail', (error && error.message) || String(error));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoots = [];
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't21-review-'));
  tempRoots.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (error) { /* ignore */ }
  }
}

function walkFiles(root, out) {
  const files = out || [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function scanForPayload(root, needles) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const text = fs.readFileSync(file, 'latin1');
    for (const needle of needles) {
      if (text.includes(needle)) hits.push(file + ':' + needle.slice(0, 24));
    }
  }
  return hits;
}

function seedAsset(userDataDir, options) {
  const opts = options || {};
  const projectId = opts.projectId || 'p_t21probe';
  const buffer = opts.buffer || makeProbePng();
  const sha = sha256Of(buffer);
  const fileName = opts.fileName || `${sha.slice(0, 16)}.${opts.ext || 'png'}`;
  const assetId = opts.assetId || `a_${sha.slice(0, 16)}`;
  const assetsDir = path.join(userDataDir, 'projects', projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, fileName), buffer);
  const meta = {
    assetId,
    fileName,
    mime: opts.mime || 'image/png',
    bytes: opts.metaBytes === undefined ? buffer.length : opts.metaBytes,
    width: 96,
    height: 96,
    sha256: opts.metaSha256 === undefined ? `sha256:${sha}` : opts.metaSha256,
  };
  fs.writeFileSync(
    path.join(userDataDir, 'projects', projectId, 'project.json'),
    JSON.stringify({ id: projectId, assets: { images: [meta] } }, null, 2),
    'utf8',
  );
  return { userDataDir, projectId, buffer, sha, fileName, assetId, assetsDir, meta };
}

function makeModelChat(script, options) {
  const opts = options || {};
  const calls = [];
  let index = 0;
  return {
    calls,
    describe: () => ({ transport: 'direct', wired: true, supportsVision: opts.supportsVision === true }),
    chat: async (payload) => {
      calls.push(payload);
      const step = script[index] || { content: '收到。' };
      index += 1;
      return {
        model: 'probe-model',
        content: typeof step.content === 'string' ? step.content : '',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
        truncated: false,
      };
    },
  };
}

function expectThrows(fn, label) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error(label + '：应当抛错但未抛');
}

function imageInvalidWithReason(fn, reason, label) {
  const error = expectThrows(fn, label);
  assert(error && error.code === RUNTIME_CODES.IMAGE_INVALID,
    label + '：应为 AGENT_IMAGE_INVALID，实际 ' + (error && error.code));
  if (reason) assert(error.reason === reason, label + '：reason 应为 ' + reason + '，实际 ' + error.reason);
  return error;
}

function dataUrlForBytes(bytes) {
  return 'data:image/png;base64,' + Buffer.alloc(bytes, 0x41).toString('base64');
}

async function main() {
  const probeBytes = fs.readFileSync(path.join(EVIDENCE_DIR, 'probe.png'));
  const probeSha = sha256Of(probeBytes);
  const probeBase64Needle = probeBytes.toString('base64').slice(0, 64);
  const cleanNeedles = ['data:image/', probeBase64Needle];

  try {
    /* -------------------- F1：证据脚本 PASS 报告卫生 -------------------- */
    await check('F1a-buildRealCallReport-no-data-literal', () => {
      const { buildRealCallReport } = require(path.join(EVIDENCE_DIR, 'run-real-call.cjs'));
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
        cases: [{ label: 'A-带图', ok: true, images: [{ assetId: `a_${probeSha.slice(0, 16)}`, mime: 'image/png', bytes: probeBytes.length, sha256: probeSha }] }],
        verdict: { x2RealCall: 'PASS', counterexamplesClean: true, productionToolSet: true },
      });
      const text = JSON.stringify(report);
      assert(!text.includes('data:'), 'PASS 报告出现 data: 字面量');
      assert(!text.includes(probeBase64Needle), 'PASS 报告出现图片 base64');
      assert(report.status === 'PASS' && report.sentParts.hasImageUrl === true, '报告形状不符');
      return 'PASS 报告 0 data:/0 base64；hasImageUrl=true';
    });

    await check('F1b-evidence-dir-clean', () => {
      const hits = scanForPayload(EVIDENCE_DIR, cleanNeedles);
      assert(hits.length === 0, '证据目录命中：' + hits.join(','));
      const realCall = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, 'real-call.json'), 'utf8'));
      assert(realCall.status === 'BLOCKED', '当前 real-call.json 应为 BLOCKED，实际 ' + realCall.status);
      assert(!JSON.stringify(realCall).includes('data:'), 'real-call.json 含 data:');
      return '证据目录与 real-call.json 均无 data:image//图片 base64';
    });

    await check('F1c-real-script-no-prefix', () => {
      const source = fs.readFileSync(path.join(EVIDENCE_DIR, 'run-real-call.cjs'), 'utf8');
      assert(!source.includes('dataUrlPrefix'), 'run-real-call.cjs 仍有 dataUrlPrefix');
      assert(!source.includes('data:image/'), 'run-real-call.cjs 含 data:image/ 字面量');
      assert(source.includes('buildRealCallReport'), '缺少唯一报告出口 buildRealCallReport');
      assert(source.includes('require.main === module'), '缺少 require.main 守卫');
      return '已删 dataUrlPrefix/前缀；报告走 buildRealCallReport';
    });

    /* -------------------- F2：400 KiB 用例必须有真 runtime -------------------- */
    await check('F2a-test-channel-case-uses-real-runtime', () => {
      const source = fs.readFileSync(path.join(ROOT, 'test', 'runtime', 'multimodal-upstream.test.cjs'), 'utf8');
      const start = source.indexOf('通道上限（400 KiB）');
      assert(start !== -1, '找不到通道上限用例');
      const next = source.indexOf('\ntest(', start + 10);
      const block = source.slice(start, next === -1 ? undefined : next);
      assert(block.includes('createDirectWorkspaceRuntime('), '用例未构造真实 runtime');
      assert(/calls\.length,\s*0/.test(block), '用例未断言 modelChat 调用数为 0');
      assert(/result\.code,\s*RUNTIME_CODES\.IMAGE_INVALID/.test(block), '用例未断言 AGENT_IMAGE_INVALID');
      assert(!/upstream\.bodies/.test(block), '用例仍保留未被调用的 upstream 占位');
      return '通道上限用例：真 runtime + calls.length=0 + IMAGE_INVALID，无空 upstream 占位';
    });

    await check('F2b-660KiB-runtime-rejected-0-upstream', async () => {
      const bigBuffer = makeNoisePng({ size: 480, level: 0 }); // ≈660 KiB
      assert(bigBuffer.length > 400 * 1024 && bigBuffer.length <= MAX_IMAGE_BYTES,
        '样本尺寸不符：' + bigBuffer.length);
      const asset = seedAsset(makeUserDataDir(), { buffer: bigBuffer });
      const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
      assert(image.bytes === bigBuffer.length, '2 MiB 解析器应接受 660 KiB 样本');
      const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: true });
      const run = createDirectWorkspaceRuntime({
        coordinator: { invokeTool: async () => ({ ok: true, data: null }), assertRunActive: () => ({ ok: true }) },
        modelChat,
        userDataDir: asset.userDataDir,
      });
      const result = await run.invoke({
        context: { projectId: asset.projectId, runId: 'frun-big', turnId: 'turn-big', attemptId: 'attempt-1' },
        request: { utterance: '看这张大图', images: [asset.assetId] },
      });
      assert(result.ok === false && result.code === RUNTIME_CODES.IMAGE_INVALID, 'runtime 未拒绝 ' + JSON.stringify(result).slice(0, 200));
      assert(result.issues[0] && result.issues[0].code === 'channel_rejected', 'issue 不是 channel_rejected');
      assert(result.data && result.data.status === 'needs_input', 'status 不是 needs_input');
      assert(modelChat.calls.length === 0, '超 400 KiB 仍调用上游 ' + modelChat.calls.length + ' 次');
      return '660 KiB → AGENT_IMAGE_INVALID/channel_rejected/needs_input；上游 0 次';
    });

    /* -------------------- 400 KiB 通道边界/2 MiB 平台边界 -------------------- */
    await check('Z-channel-boundary-409600', () => {
      assert(MAX_IMAGE_BYTES === 2 * 1024 * 1024, '平台上限不是 2 MiB：' + MAX_IMAGE_BYTES);
      assert(MAX_IMAGES_PER_TURN === 1, 'E0 不是只接受 1 张');
      const normalize = (bytes) => credentialsMod.normalizeChatPayload({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            { type: 'image_url', image_url: { url: dataUrlForBytes(bytes) } },
          ],
        }],
      });
      normalize(409600);
      const error = expectThrows(() => normalize(409601), '409601 B');
      assert(error && error.code === 'MODEL_REQUEST_INVALID', '超 1 B 未按通道上限拒绝：' + (error && error.code));
      return '400 KiB 边界：409600 B 通过、409601 B 拒绝（MODEL_REQUEST_INVALID）；平台 2 MiB 不变';
    });

    /* -------------------- §14.8 安全边界（独立于 t7 测试） -------------------- */
    await check('A1-assetId-only', () => {
      const asset = seedAsset(makeUserDataDir());
      const inputs = [
        ['绝对路径', path.join(asset.assetsDir, asset.fileName)],
        ['相对路径', 'assets/images/x.png'],
        ['data URL', 'data:image/png;base64,iVBORw0KGgo='],
        ['裸 base64', 'aGVsbG8='],
        ['简写', 'a_1'],
      ];
      for (const [label, assetId] of inputs) {
        imageInvalidWithReason(() => resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId }),
          'asset_id_invalid', label);
      }
      return '路径/相对路径/data URL/裸 base64/简写 全部 asset_id_invalid';
    });

    await check('V1-magic-mime-digest-decode', () => {
      const png = seedAsset(makeUserDataDir());
      const normal = resolveAssetImage({
        userDataDir: png.userDataDir, projectId: png.projectId, assetId: png.assetId,
      });
      assert(normal.mime === 'image/png' && normal.bytes === probeBytes.length, '正常样本未通过');
      const wrongMime = seedAsset(makeUserDataDir(), { mime: 'image/jpeg' });
      imageInvalidWithReason(() => resolveAssetImage({
        userDataDir: wrongMime.userDataDir, projectId: wrongMime.projectId, assetId: wrongMime.assetId,
      }), 'mime_mismatch', 'MIME 与魔数不符');
      const wrongSha = seedAsset(makeUserDataDir(), { metaSha256: 'sha256:' + '0'.repeat(64) });
      imageInvalidWithReason(() => resolveAssetImage({
        userDataDir: wrongSha.userDataDir, projectId: wrongSha.projectId, assetId: wrongSha.assetId,
      }), 'asset_digest_mismatch', '摘要不符');
      const truncatedBuffer = makeProbePng().subarray(0, makeProbePng().length - 12);
      const truncated = seedAsset(makeUserDataDir(), { buffer: truncatedBuffer });
      const error = imageInvalidWithReason(() => resolveAssetImage({
        userDataDir: truncated.userDataDir, projectId: truncated.projectId, assetId: truncated.assetId,
      }), null, '截断 PNG');
      assert(/^png_/.test(error.reason), '截断 PNG reason 不符：' + error.reason);
      return '正常样本通过；jpeg MIME/错 sha/截断 PNG 均 AGENT_IMAGE_INVALID';
    });

    await check('M1-multimodal-order-real-url', () => {
      const asset = seedAsset(makeUserDataDir());
      const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
      const partsA = buildMultimodalContent({ utterance: '看图', images: [image] });
      const partsB = buildMultimodalContent({ utterance: '看图', images: [image] });
      assert(JSON.stringify(partsA) === JSON.stringify(partsB), '两次构造不一致');
      assert(partsA.length === 2 && partsA[0].type === 'text' && partsA[1].type === 'image_url', '顺序不是 text→image_url');
      assert(partsA[1].image_url.url.startsWith('data:image/png;base64,'), '不是真实 image/png data URL');
      const decoded = Buffer.from(partsA[1].image_url.url.split(',')[1], 'base64');
      assert(decoded.equals(probeBytes), 'data URL 解码后与 probe.png 不一致');
      return 'text→image_url 稳定；data URL 解码 = probe.png';
    });

    await check('R1-vision-fail-closed-0-upstream', async () => {
      const asset = seedAsset(makeUserDataDir());
      const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: false });
      const run = createDirectWorkspaceRuntime({
        coordinator: { invokeTool: async () => ({ ok: true, data: null }), assertRunActive: () => ({ ok: true }) },
        modelChat,
        userDataDir: asset.userDataDir,
      });
      const result = await run.invoke({
        context: { projectId: asset.projectId, runId: 'frun-v', turnId: 'turn-v', attemptId: 'attempt-1' },
        request: { utterance: '看图', images: [asset.assetId] },
      });
      assert(result.ok === false && result.code === RUNTIME_CODES.VISION_UNAVAILABLE, '未 fail-closed：' + JSON.stringify(result).slice(0, 160));
      assert(result.data && result.data.status === 'needs_input', 'status 不是 needs_input');
      assert(modelChat.calls.length === 0, '无视觉仍调用上游');
      return 'supportsVision=false → VISION_UNAVAILABLE/needs_input；上游 0 次';
    });

    await check('R2-bad-inputs-0-upstream', async () => {
      const asset = seedAsset(makeUserDataDir());
      const cases = [
        ['路径', [path.join(asset.assetsDir, asset.fileName)]],
        ['data URL', ['data:image/png;base64,iVBORw0KGgo=']],
        ['未知 assetId', ['a_ffffffffffffffff']],
      ];
      for (const [label, images] of cases) {
        const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: true });
        const run = createDirectWorkspaceRuntime({
          coordinator: { invokeTool: async () => ({ ok: true, data: null }), assertRunActive: () => ({ ok: true }) },
          modelChat,
          userDataDir: asset.userDataDir,
        });
        const result = await run.invoke({
          context: { projectId: asset.projectId, runId: 'frun-bad', turnId: 'turn-bad', attemptId: 'attempt-1' },
          request: { utterance: '看图', images },
        });
        assert(result.ok === false && result.code === RUNTIME_CODES.IMAGE_INVALID, label + ' 未 IMAGE_INVALID');
        assert(modelChat.calls.length === 0, label + ' 仍调用上游');
      }
      return '路径/data URL/未知 assetId → IMAGE_INVALID；上游 0 次';
    });

    await check('Z2-two-images-rejected', () => {
      const asset = seedAsset(makeUserDataDir());
      imageInvalidWithReason(() => resolveAssetImages({
        userDataDir: asset.userDataDir, projectId: asset.projectId, assetIds: [asset.assetId, asset.assetId],
      }), 'too_many_images', '2 张');
      return '2 张 → too_many_images';
    });

    await check('E1-probe-png-sha-and-report', () => {
      assert(probeBytes.length === 341, 'probe.png bytes=' + probeBytes.length);
      assert(probeSha === '5dae3842d7bfe72cc97883cfdc6424a1774acd10fc958432d63125b4395eea34', 'probe.png sha=' + probeSha);
      const info = validateImageStructure(probeBytes, 'image/png');
      assert(info.width === 96 && info.height === 96, 'probe.png 尺寸=' + JSON.stringify(info));
      const report = fs.readFileSync(path.join(EVIDENCE_DIR, 'report.md'), 'utf8');
      assert(report.includes(probeSha), 'report.md 未记录 probe.png sha256');
      assert(!report.includes('data:image/'), 'report.md 含 data:image/');
      return 'probe.png 341 B / 5dae3842…ea34 / 96×96；report.md 记录且无 data URL';
    });

    /* -------------------- 真实 Coordinator attempt/run 落盘扫描 -------------------- */
    await check('D1-no-data-url-in-attempt-run-project-evidence', async () => {
      const userDataDir = makeUserDataDir();
      const asset = seedAsset(userDataDir, { projectId: 'p_t21d1probe' });
      const init = versions.initProject({ userDataDir, projectId: asset.projectId });
      assert(init.ok === true, 'initProject 失败：' + JSON.stringify(init));
      const coordinator = createRunCoordinator({ userDataDir });
      const run = coordinator.startRun({
        projectId: asset.projectId,
        targetPage: 'home',
        operation: 'review-image',
        utterance: '图里有什么？',
        imageAssetIds: [asset.assetId],
      });
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run));
      const modelChat = makeModelChat([{ content: '图里是红色圆形和蓝色方块。' }], { supportsVision: true });
      const events = [];
      const directRuntime = createDirectWorkspaceRuntime({
        coordinator,
        modelChat,
        userDataDir,
        onProgress: (event) => events.push(event),
      });
      const result = await directRuntime.invoke({
        context: {
          projectId: asset.projectId,
          runId: run.runId,
          turnId: run.turnId,
          attemptId: run.attemptId,
        },
        request: { utterance: '图里有什么？', images: [asset.assetId] },
      });
      assert(result.ok === true, 'runtime 带图回合失败：' + JSON.stringify(result).slice(0, 240));
      assert(result.data.multimodal === true, 'multimodal 标记不为 true');
      assert(modelChat.calls.length === 1, '上游调用次数不是 1');
      const userMessage = modelChat.calls[0].messages.find((message) => message.role === 'user');
      const imagePart = userMessage && Array.isArray(userMessage.content)
        ? userMessage.content.find((part) => part.type === 'image_url') : null;
      assert(imagePart && imagePart.image_url.url.startsWith('data:image/png;base64,'), '内存消息里没有真实 image_url');
      assert(Buffer.from(imagePart.image_url.url.split(',')[1], 'base64').equals(probeBytes), '内存图片字节与 probe.png 不一致');

      const attemptDir = path.join(
        userDataDir, 'projects', asset.projectId, 'agent-workspace', 'runs', run.runId,
        'turns', run.turnId, 'attempts', run.attemptId,
      );
      const attemptFile = path.join(attemptDir, 'attempt.json');
      const runFile = path.join(userDataDir, 'projects', asset.projectId, 'agent-workspace', 'runs', run.runId, 'run.json');
      for (const file of [attemptFile, runFile]) {
        assert(fs.existsSync(file), '缺少 ' + file);
        const text = fs.readFileSync(file, 'utf8');
        for (const needle of cleanNeedles) {
          assert(!text.includes(needle), '落盘文件出现 ' + needle.slice(0, 24) + '：' + file);
        }
      }
      const hits = scanForPayload(userDataDir, cleanNeedles);
      assert(hits.length === 0, 'userData 落盘命中：' + hits.join(','));
      const serializedResult = JSON.stringify(result);
      const serializedEvents = JSON.stringify(events);
      for (const needle of cleanNeedles) {
        assert(!serializedResult.includes(needle), '结果对象出现 ' + needle.slice(0, 24));
        assert(!serializedEvents.includes(needle), '进度事件出现 ' + needle.slice(0, 24));
      }
      assert(JSON.stringify(result.data.images) === JSON.stringify([{
        assetId: asset.assetId, mime: 'image/png', bytes: probeBytes.length, sha256: probeSha,
      }]), 'result.data.images 形状不符：' + JSON.stringify(result.data.images));
      assert(events.some((event) => event.stage === 'image' && event.status === 'succeeded'), '缺少 image 进度');
      return 'attempt.json/run.json/project.json/整棵 userData/结果/进度/trace 均无 data:image//base64';
    });
  } finally {
    cleanup();
  }

  const failed = results.filter((item) => item.status === 'fail');
  console.log(JSON.stringify({
    probe: 't21-review-probe.v1',
    at: new Date().toISOString(),
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    observations,
  }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    probe: 't21-review-probe.v1',
    error: (error && error.message) || String(error),
    stack: error && error.stack ? String(error.stack).split('\n').slice(1, 5) : [],
  }, null, 2));
  process.exitCode = 2;
});
