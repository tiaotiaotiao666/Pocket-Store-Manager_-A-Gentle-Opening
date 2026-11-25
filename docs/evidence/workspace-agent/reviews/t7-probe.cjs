'use strict';

/**
 * t17（Review-t7）独立探针：直接 require 被复核实现（images.cjs / multimodal.cjs / workspace-runtime.cjs 的图片分支），
 * 用临时 userData + fake 模型/Coordinator 复核安全边界；**不引用 t7 的测试断言**（PNG 生成器复用证据目录的
 * 确定性生成器，仅用于造样本，不参与校验逻辑）。
 *
 * 运行：node docs/evidence/workspace-agent/reviews/t7-probe.cjs
 * 退出码：0 = 产品侧 probe 全部成立（observations 单独列出）；1 = 产品侧至少一条不成立；2 = 探针自身错误。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RUNTIME_DIR = path.join(ROOT, 'desktop', 'agent-runtime');
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'evidence', 'workspace-agent', 'e0-r2');
const runtime = require(RUNTIME_DIR);
const { makeProbePng, makeNoisePng, sha256Of } = require(path.join(EVIDENCE_DIR, 'probe-tools.cjs'));

const {
  resolveAssetImage,
  resolveAssetImages,
  buildMultimodalContent,
  createDirectWorkspaceRuntime,
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
    if (error && error.code === 'PROBE_SKIP') record(id, 'skip', error.message);
    else record(id, 'fail', (error && error.message) || String(error));
  }
}
function skip(message) {
  const error = new Error(message);
  error.code = 'PROBE_SKIP';
  return error;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoots = [];
function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't17-review-'));
  tempRoots.push(dir);
  return dir;
}

function seedAsset(userDataDir, options) {
  const opts = options || {};
  const projectId = opts.projectId || 'p_t17probe';
  const buffer = opts.buffer || makeProbePng();
  const sha = sha256Of(buffer);
  const fileName = opts.fileName || `${sha.slice(0, 16)}.${opts.ext || 'png'}`;
  const assetId = opts.assetId || `a_${sha.slice(0, 16)}`;
  const assetsDir = path.join(userDataDir, 'projects', projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  if (opts.materialize !== false) fs.writeFileSync(path.join(assetsDir, fileName), buffer);
  const meta = {
    assetId,
    fileName,
    mime: opts.mime || 'image/png',
    bytes: opts.metaBytes === undefined ? buffer.length : opts.metaBytes,
    width: 96,
    height: 96,
    sha256: opts.metaSha256 === undefined ? `sha256:${sha}` : opts.metaSha256,
  };
  fs.writeFileSync(path.join(userDataDir, 'projects', projectId, 'project.json'),
    JSON.stringify({ id: projectId, assets: { images: [meta] } }, null, 2), 'utf8');
  return { userDataDir, projectId, buffer, sha, fileName, assetId, assetsDir, meta };
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

function makeCoordinator() {
  const calls = [];
  return {
    calls,
    invokeTool: async (input) => {
      calls.push(input);
      return { ok: true, data: {} };
    },
    assertRunActive: () => ({ ok: true }),
  };
}

function expectImageInvalid(fn) {
  try {
    fn();
  } catch (error) {
    assert(error && error.code === RUNTIME_CODES.IMAGE_INVALID,
      '应为 AGENT_IMAGE_INVALID，实际 ' + (error && error.code));
    return error;
  }
  throw new Error('应当抛 AGENT_IMAGE_INVALID，但没有抛');
}

function scanForImageLeaks(root, needle) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const text = fs.readFileSync(file, 'latin1');
    if (text.includes('data:image/')) hits.push(file + ':data-url');
    if (needle && text.includes(needle)) hits.push(file + ':base64');
  }
  return hits;
}

async function main() {
  const probeBytes = fs.readFileSync(path.join(EVIDENCE_DIR, 'probe.png'));
  const probeSha = sha256Of(probeBytes);

  try {
    /* -------------------- 源码边界 -------------------- */
    await check('S1-no-write-or-exec-in-images-multimodal', () => {
      const writeApis = /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmSync|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|writeSync)\b/;
      for (const name of ['images.cjs', 'multimodal.cjs']) {
        const source = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
        assert(!writeApis.test(source), name + ' 含写盘 API');
        assert(!/require\(['"](node:)?child_process['"]\)/.test(source), name + ' 含 child_process');
        assert(!/\b(spawnSync|execSync|execFileSync)\b/.test(source), name + ' 含同步执行命令');
      }
      return 'images/multimodal 均 0 写盘/0 子进程';
    });

    /* -------------------- 输入只认 assetId -------------------- */
    await check('A1-resolve-only-assetId', () => {
      const asset = seedAsset(makeUserDataDir());
      const inputs = [
        ['绝对路径', path.join(asset.assetsDir, asset.fileName)],
        ['相对路径', 'assets/images/x.png'],
        ['data URL', 'data:image/png;base64,iVBORw0KGgo='],
        ['裸 base64', 'aGVsbG8='],
        ['对象路径', { path: 'C:\\x.png' }],
        ['空串', ''],
      ];
      for (const [label, value] of inputs) {
        const error = expectImageInvalid(() => resolveAssetImage({
          userDataDir: asset.userDataDir,
          projectId: asset.projectId,
          assetId: value,
        }));
        assert(error.reason === 'asset_id_invalid', label + ' → ' + error.reason);
      }
      // 路径指向一个真实存在的图片，也必须在正则阶段拒绝（证明不会读该路径）
      const realPath = path.join(asset.assetsDir, asset.fileName);
      const pathError = expectImageInvalid(() => resolveAssetImage({
        userDataDir: asset.userDataDir,
        projectId: asset.projectId,
        assetId: realPath,
      }));
      assert(pathError.reason === 'asset_id_invalid');
      return '6 类非 assetId 输入全部 asset_id_invalid（含真实路径）';
    });

    await check('A2-resolve-happy-path-frozen-shape', () => {
      const asset = seedAsset(makeUserDataDir());
      const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
      assert(JSON.stringify(Object.keys(image).sort()) === JSON.stringify(['assetId', 'bytes', 'dataUrl', 'mime', 'sha256']),
        '返回键不符：' + Object.keys(image).join(','));
      assert(image.mime === 'image/png');
      assert(image.bytes === probeBytes.length);
      assert(image.sha256 === probeSha);
      assert(image.dataUrl === `data:image/png;base64,${probeBytes.toString('base64')}`);
      return '5 键冻结形状 + 摘要/字节与归档样本一致';
    });

    /* -------------------- realpath / junction 换根 -------------------- */
    await check('P1-root-junction-outside-project', () => {
      const userDataDir = makeUserDataDir();
      const outsideDir = makeUserDataDir();
      const projectId = 'p_t17junction';
      const buffer = makeProbePng();
      const sha = sha256Of(buffer);
      const fileName = `${sha.slice(0, 16)}.png`;
      const assetId = `a_${sha.slice(0, 16)}`;
      fs.writeFileSync(path.join(outsideDir, fileName), buffer);
      const projectDir = path.join(userDataDir, 'projects', projectId);
      fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
      try {
        fs.symlinkSync(outsideDir, path.join(projectDir, 'assets', 'images'), 'junction');
      } catch (error) {
        throw skip('本机无法创建 junction：' + error.code);
      }
      fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
        id: projectId,
        assets: { images: [{ assetId, fileName, mime: 'image/png', bytes: buffer.length, sha256: 'sha256:' + sha }] },
      }), 'utf8');
      const error = expectImageInvalid(() => resolveAssetImage({ userDataDir, projectId, assetId }));
      assert(error.reason === 'asset_root_outside_project', error.reason);
      return 'assets/images → 外部 junction 被拒（asset_root_outside_project）';
    });

    await check('P2-project-dir-junction-outside-userdata', () => {
      const userDataDir = makeUserDataDir();
      const outsideProject = path.join(makeUserDataDir(), 'projects', 'p_t17projlink');
      const assetsDir = path.join(outsideProject, 'assets', 'images');
      fs.mkdirSync(assetsDir, { recursive: true });
      const buffer = makeProbePng();
      const sha = sha256Of(buffer);
      const fileName = `${sha.slice(0, 16)}.png`;
      const assetId = `a_${sha.slice(0, 16)}`;
      fs.writeFileSync(path.join(assetsDir, fileName), buffer);
      fs.writeFileSync(path.join(outsideProject, 'project.json'), JSON.stringify({
        id: 'p_t17projlink',
        assets: { images: [{ assetId, fileName, mime: 'image/png', bytes: buffer.length, sha256: 'sha256:' + sha }] },
      }), 'utf8');
      const linkPath = path.join(userDataDir, 'projects', 'p_t17projlink');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try {
        fs.symlinkSync(outsideProject, linkPath, 'junction');
      } catch (error) {
        throw skip('本机无法创建 junction：' + error.code);
      }
      const error = expectImageInvalid(() => resolveAssetImage({
        userDataDir,
        projectId: 'p_t17projlink',
        assetId,
      }));
      assert(error.reason === 'asset_root_outside_project', error.reason);
      return '整个项目目录 → 外部 junction 被拒（项目不在 userData 内）';
    });

    await check('P3-file-symlink-rejected', () => {
      const asset = seedAsset(makeUserDataDir(), { materialize: false });
      const outsideFile = path.join(makeUserDataDir(), 'real.png');
      fs.writeFileSync(outsideFile, probeBytes);
      try {
        fs.symlinkSync(outsideFile, path.join(asset.assetsDir, asset.fileName), 'file');
      } catch (error) {
        throw skip('本机无法创建文件 symlink（需要开发者模式）：' + error.code);
      }
      const error = expectImageInvalid(() => resolveAssetImage({
        userDataDir: asset.userDataDir,
        projectId: asset.projectId,
        assetId: asset.assetId,
      }));
      assert(error.reason === 'asset_symlink_rejected', error.reason);
      return '文件 symlink 被拒（asset_symlink_rejected）';
    });

    await check('P4-fileName-escape-rejected', () => {
      const asset = seedAsset(makeUserDataDir());
      const projectFile = path.join(asset.userDataDir, 'projects', asset.projectId, 'project.json');
      const doc = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      doc.assets.images[0].fileName = '../' + asset.fileName;
      fs.writeFileSync(projectFile, JSON.stringify(doc), 'utf8');
      const error = expectImageInvalid(() => resolveAssetImage({
        userDataDir: asset.userDataDir,
        projectId: asset.projectId,
        assetId: asset.assetId,
      }));
      assert(error.reason === 'asset_file_invalid', error.reason);
      return 'fileName 含 ../ → asset_file_invalid';
    });

    /* -------------------- MIME / 解码 / 防篡改 -------------------- */
    await check('V1-mime-mismatch-and-bad-magic', () => {
      const mismatch = seedAsset(makeUserDataDir(), { mime: 'image/jpeg' });
      const e1 = expectImageInvalid(() => resolveAssetImage({
        userDataDir: mismatch.userDataDir, projectId: mismatch.projectId, assetId: mismatch.assetId,
      }));
      assert(e1.reason === 'mime_mismatch', e1.reason);

      const text = Buffer.from('这不是图片，只是文本。');
      const bad = seedAsset(makeUserDataDir(), { buffer: text, mime: 'image/png', fileName: 'aaaaaaaaaaaaaaaa.png' });
      const e2 = expectImageInvalid(() => resolveAssetImage({
        userDataDir: bad.userDataDir, projectId: bad.projectId, assetId: bad.assetId,
      }));
      assert(e2.reason === 'unsupported_type', e2.reason);
      return '声明的 image/jpeg 与 PNG 魔数不一致 → mime_mismatch；纯文本 → unsupported_type';
    });

    await check('V2-truncated-png-rejected', () => {
      const truncated = makeProbePng().subarray(0, 100);
      const asset = seedAsset(makeUserDataDir(), { buffer: truncated, fileName: 'bbbbbbbbbbbbbbbb.png' });
      const error = expectImageInvalid(() => resolveAssetImage({
        userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId,
      }));
      assert(['png_truncated', 'png_chunk_truncated', 'png_missing_iend', 'png_missing_idat'].includes(error.reason),
        error.reason);
      return '截断 PNG 被真解码拒绝（' + error.reason + '）';
    });

    await check('V3-digest-and-size-mismatch-rejected', () => {
      const digestCase = seedAsset(makeUserDataDir(), { metaSha256: 'sha256:' + 'f'.repeat(64) });
      const e1 = expectImageInvalid(() => resolveAssetImage({
        userDataDir: digestCase.userDataDir, projectId: digestCase.projectId, assetId: digestCase.assetId,
      }));
      assert(e1.reason === 'asset_digest_mismatch', e1.reason);
      const sizeCase = seedAsset(makeUserDataDir(), { metaBytes: 999999 });
      const e2 = expectImageInvalid(() => resolveAssetImage({
        userDataDir: sizeCase.userDataDir, projectId: sizeCase.projectId, assetId: sizeCase.assetId,
      }));
      assert(e2.reason === 'asset_size_mismatch', e2.reason);
      return '登记 sha256 / bytes 不符 → 拒绝（防篡改）';
    });

    /* -------------------- 大小口径 -------------------- */
    await check('Z1-platform-2MiB-boundary', () => {
      const under = seedAsset(makeUserDataDir(), { buffer: makeNoisePng({ size: 700, level: 0 }) });
      const image = resolveAssetImage({ userDataDir: under.userDataDir, projectId: under.projectId, assetId: under.assetId });
      assert(image.bytes <= MAX_IMAGE_BYTES);
      const over = seedAsset(makeUserDataDir(), { buffer: makeNoisePng({ size: 900, level: 0 }) });
      assert(over.buffer.length > MAX_IMAGE_BYTES, '样本必须 >2 MiB，实际 ' + over.buffer.length);
      const error = expectImageInvalid(() => resolveAssetImage({
        userDataDir: over.userDataDir, projectId: over.projectId, assetId: over.assetId,
      }));
      assert(error.reason === 'image_too_large', error.reason);
      // 调用方不能抬高上限
      const raised = expectImageInvalid(() => resolveAssetImage({
        userDataDir: over.userDataDir,
        projectId: over.projectId,
        assetId: over.assetId,
        limits: { maxBytes: 50 * 1024 * 1024 },
      }));
      assert(raised.reason === 'image_too_large');
      return '1.4 MiB 通过 / 2.3 MiB 拒绝 / limits 不能抬高';
    });

    await check('Z2-one-image-per-turn', () => {
      const asset = seedAsset(makeUserDataDir());
      const single = resolveAssetImages({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetIds: [asset.assetId] });
      assert(single.meta.length === 1);
      assert(JSON.stringify(Object.keys(single.meta[0]).sort()) === JSON.stringify(['assetId', 'bytes', 'mime', 'sha256']),
        'meta 不得含 dataUrl');
      const error = expectImageInvalid(() => resolveAssetImages({
        userDataDir: asset.userDataDir,
        projectId: asset.projectId,
        assetIds: [asset.assetId, asset.assetId],
      }));
      assert(error.reason === 'too_many_images');
      assert(MAX_IMAGES_PER_TURN === 1);
      return '1 张通过、meta 无 dataUrl、2 张 → too_many_images';
    });

    await check('Z3-effective-channel-400KiB-in-runtime', async () => {
      const big = makeNoisePng({ size: 480, level: 0 });
      assert(big.length > 400 * 1024 && big.length <= MAX_IMAGE_BYTES,
        '样本必须 >400 KiB 且 ≤2 MiB，实际 ' + big.length);
      const asset = seedAsset(makeUserDataDir(), { buffer: big });
      const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: true });
      const coordinator = makeCoordinator();
      const run = createDirectWorkspaceRuntime({
        coordinator,
        modelChat,
        userDataDir: asset.userDataDir,
      });
      const result = await run.invoke({
        context: { projectId: asset.projectId, runId: 'frun-z3', turnId: 'fturn-z3', attemptId: 'att-z3' },
        request: { utterance: '看这张大图', images: [asset.assetId] },
      });
      assert(result.ok === false, '应被拒');
      assert(result.code === RUNTIME_CODES.IMAGE_INVALID, 'code=' + result.code);
      assert(result.data && result.data.status === 'needs_input', 'status=' + (result.data && result.data.status));
      assert(result.issues && result.issues[0] && result.issues[0].code === 'channel_rejected',
        'issues=' + JSON.stringify(result.issues));
      assert(modelChat.calls.length === 0, '不得发上游，实际 ' + modelChat.calls.length);
      assert(coordinator.calls.length === 0, '不得执行工具');
      return '≈660 KiB（>400KiB、<2MiB）在 runtime 被 channel_rejected 拦下：上游 0 次、工具 0 次';
    });

    /* -------------------- 多模态消息/顺序 -------------------- */
    await check('M1-build-parts-stable', () => {
      const asset = seedAsset(makeUserDataDir());
      const image = resolveAssetImage({ userDataDir: asset.userDataDir, projectId: asset.projectId, assetId: asset.assetId });
      const first = buildMultimodalContent({ utterance: '主色是什么？', images: [image] });
      const second = buildMultimodalContent({ utterance: '主色是什么？', images: [image] });
      assert(JSON.stringify(first) === JSON.stringify(second), '两次构造必须逐字节一致');
      assert(first.length === 2 && first[0].type === 'text' && first[1].type === 'image_url');
      const sent = Buffer.from(first[1].image_url.url.split(',')[1], 'base64');
      assert(sent.length === probeBytes.length && sha256Of(sent) === probeSha);
      const textOnly = buildMultimodalContent({ utterance: '只改文案' });
      assert(textOnly.length === 1 && textOnly[0].type === 'text');
      const e1 = expectImageInvalid(() => buildMultimodalContent({ utterance: 'x', images: ['aGVsbG8='] }));
      assert(e1.reason === 'raw_base64_rejected');
      const e2 = expectImageInvalid(() => buildMultimodalContent({
        utterance: 'x',
        images: [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }],
      }));
      assert(e2.reason === 'data_url_invalid');
      return 'text→image_url 顺序稳定；data URL 解码=样本；裸 base64/SVG 拒绝';
    });

    /* -------------------- runtime 失败路径 0 上游 -------------------- */
    await check('R1-vision-fail-closed', async () => {
      const asset = seedAsset(makeUserDataDir());
      const cases = [
        ['auto + 未声明', { supportsVision: false }],
        ['显式 vision:false', { supportsVision: true, vision: false }],
      ];
      for (const [label, options] of cases) {
        const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: options.supportsVision });
        const run = createDirectWorkspaceRuntime({
          coordinator: makeCoordinator(),
          modelChat,
          userDataDir: asset.userDataDir,
          ...(options.vision === undefined ? {} : { vision: options.vision }),
        });
        const result = await run.invoke({
          context: { projectId: asset.projectId, runId: 'frun-v', turnId: 'fturn-v', attemptId: 'att-v' },
          request: { utterance: '看图', images: [asset.assetId] },
        });
        assert(result.code === RUNTIME_CODES.VISION_UNAVAILABLE, label + ' code=' + result.code);
        assert(result.data.status === 'needs_input', label + ' status');
        assert(result.data.stopReason === 'vision_unavailable', label + ' stopReason');
        assert(modelChat.calls.length === 0, label + ' 不得发上游');
      }
      return '无视觉能力 → VISION_UNAVAILABLE + needs_input，上游 0 次（两种声明）';
    });

    await check('R2-image-input-failures-zero-upstream', async () => {
      const asset = seedAsset(makeUserDataDir());
      const cases = [
        ['不存在 assetId', ['a_0000000000000000']],
        ['路径', [path.join(asset.assetsDir, asset.fileName)]],
        ['data URL', ['data:image/png;base64,iVBORw0KGgo=']],
        ['对象无 assetId', [{ path: 'C:\\x.png' }]],
        ['不是数组', 'a_0000000000000000'],
      ];
      for (const [label, images] of cases) {
        const modelChat = makeModelChat([{ content: '不该被调用' }], { supportsVision: true });
        const run = createDirectWorkspaceRuntime({
          coordinator: makeCoordinator(),
          modelChat,
          userDataDir: asset.userDataDir,
        });
        const result = await run.invoke({
          context: { projectId: asset.projectId, runId: 'frun-i', turnId: 'fturn-i', attemptId: 'att-i' },
          request: { utterance: '看图', images },
        });
        assert(result.code === RUNTIME_CODES.IMAGE_INVALID, label + ' code=' + result.code);
        assert(modelChat.calls.length === 0, label + ' 不得发上游');
      }
      // 坏图 / 超 2MiB 同样 0 上游
      const broken = seedAsset(makeUserDataDir(), {
        buffer: makeProbePng().subarray(0, 100),
        fileName: 'cccccccccccccccc.png',
      });
      const brokenRun = createDirectWorkspaceRuntime({
        coordinator: makeCoordinator(),
        modelChat: makeModelChat([{}], { supportsVision: true }),
        userDataDir: broken.userDataDir,
      });
      const brokenResult = await brokenRun.invoke({
        context: { projectId: broken.projectId, runId: 'frun-b', turnId: 'fturn-b', attemptId: 'att-b' },
        request: { utterance: '看图', images: [broken.assetId] },
      });
      assert(brokenResult.code === RUNTIME_CODES.IMAGE_INVALID);
      const over = seedAsset(makeUserDataDir(), { buffer: makeNoisePng({ size: 900, level: 0 }) });
      const overModel = makeModelChat([{}], { supportsVision: true });
      const overRun = createDirectWorkspaceRuntime({
        coordinator: makeCoordinator(), modelChat: overModel, userDataDir: over.userDataDir,
      });
      const overResult = await overRun.invoke({
        context: { projectId: over.projectId, runId: 'frun-o', turnId: 'fturn-o', attemptId: 'att-o' },
        request: { utterance: '看图', images: [over.assetId] },
      });
      assert(overResult.code === RUNTIME_CODES.IMAGE_INVALID);
      assert(overModel.calls.length === 0);
      return '缺图/路径/base64/坏图/超 2MiB → IMAGE_INVALID 且上游 0 次';
    });

    await check('R3-success-result-trace-no-image', async () => {
      const asset = seedAsset(makeUserDataDir());
      const progress = [];
      const modelChat = makeModelChat([{ content: '图里是红色圆形与蓝色方块。' }], { supportsVision: true });
      const run = createDirectWorkspaceRuntime({
        coordinator: makeCoordinator(),
        modelChat,
        userDataDir: asset.userDataDir,
        onProgress: (event) => progress.push(event),
      });
      const result = await run.invoke({
        context: { projectId: asset.projectId, runId: 'frun-ok', turnId: 'fturn-ok', attemptId: 'att-ok' },
        request: { utterance: '看图说颜色', images: [asset.assetId] },
      });
      assert(result.ok === true, JSON.stringify(result));
      const userMessage = modelChat.calls[0].messages.find((message) => message.role === 'user');
      assert(Array.isArray(userMessage.content) && userMessage.content[1].type === 'image_url');
      assert(JSON.stringify(result).indexOf('data:image') === -1, '结果不得含 data URL');
      assert(JSON.stringify(result).indexOf(probeBytes.toString('base64').slice(0, 64)) === -1, '结果不得含 base64');
      assert(JSON.stringify(progress).indexOf('data:image') === -1, '进度不得含 data URL');
      assert(JSON.stringify(result.data.images) === JSON.stringify([{
        assetId: asset.assetId, mime: 'image/png', bytes: probeBytes.length, sha256: probeSha,
      }]), 'images 元数据形状不符');
      const leaks = scanForImageLeaks(asset.userDataDir, probeBytes.toString('base64').slice(0, 64));
      assert(leaks.length === 0, 'userData 落盘泄漏：' + leaks.join(','));
      return '结果/进度只含元数据；userData 全量扫描无 data:image/base64';
    });

    /* -------------------- 归档样本 -------------------- */
    await check('E1-probe-sample-sha256', () => {
      assert(probeBytes.length === 341, 'bytes=' + probeBytes.length);
      assert(probeSha === '5dae3842d7bfe72cc97883cfdc6424a1774acd10fc958432d63125b4395eea34', probeSha);
      const info = runtime.validateImageStructure(probeBytes, 'image/png');
      assert(info.width === 96 && info.height === 96, JSON.stringify(info));
      return 'probe.png 341 B / sha256 5dae3842…ea34 / 96×96 真解码';
    });

    /* -------------------- observations（不参与 exit code） -------------------- */
    const realScript = fs.readFileSync(path.join(EVIDENCE_DIR, 'run-real-call.cjs'), 'utf8');
    if (realScript.includes('dataUrlPrefix') && realScript.includes('.slice(0, 24)')) {
      const wouldWrite = 'data:image/png;base64,'.slice(0, 24);
      obs('O1-real-call-evidence-prefix',
        'medium',
        `run-real-call.cjs 在 PASS 时会把 24 字符前缀写进 real-call.json（实际值以 "data:image/" 开头：`
        + `${JSON.stringify(wouldWrite)}）。这会让 test/runtime/images.test.cjs 的`
        + `“证据目录全量扫描（data:image/）”在 t8 真实调用之后失败，也弱化“data URL 不落盘”的判据。`
        + `建议改写成 hasImageUrl:true / mime+bytes，避免任何 data: 字面量。`);
    }
    const scanNow = scanForImageLeaks(EVIDENCE_DIR, probeBytes.toString('base64').slice(0, 64));
    if (scanNow.length > 0) {
      obs('O2-current-evidence-dir-leak', 'high', '当前证据目录已含 data:image/base64：' + scanNow.join(','));
    }
    const upstreamTest = fs.readFileSync(path.join(ROOT, 'test', 'runtime', 'multimodal-upstream.test.cjs'), 'utf8');
    const blockStart = upstreamTest.indexOf('通道上限（400 KiB）');
    const blockEnd = blockStart === -1 ? -1 : upstreamTest.indexOf('\ntest(', blockStart + 10);
    const channelBlock = blockStart === -1 ? '' : upstreamTest.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
    if (blockStart !== -1 && channelBlock.includes('runtime 层也不会发出任何上游调用')
      && !channelBlock.includes('createDirectWorkspaceRuntime')) {
      obs('O2-test-claims-runtime-but-only-preflight',
        'medium',
        'test/runtime/multimodal-upstream.test.cjs 的“通道上限（400 KiB）”用例注释声称 runtime 层 0 上游，'
        + '但该用例没有创建 runtime（只调 assertChannelAccepts + 一个从未使用的 createModelChat），'
        + '所以“runtime 0 上游”实际未被测试覆盖；产品行为正确（本探针 Z3 已独立证实）。');
    }
    obs('O3-resolver-2MiB-vs-channel-400KiB',
      'low',
      'images.cjs 的解析上限是 §14.8 的 2 MiB；通道 400 KiB 只在 runtime 调 assertChannelAccepts 时生效'
      + '（探针 Z3 证实 660 KiB 在 runtime 被 channel_rejected、0 上游）。若未来有调用方绕过 runtime 直接用'
      + 'resolveAssetImage 的 dataUrl，就会跳过 400 KiB 通道口径；E0 当前唯一消费方是 runtime，故不阻塞。');
  } finally {
    for (const dir of tempRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (error) { /* ignore */ }
    }
  }

  const failed = results.filter((item) => item.status === 'fail');
  const skipped = results.filter((item) => item.status === 'skip');
  console.log(JSON.stringify({
    probe: 't7-review-probe.v1',
    at: new Date().toISOString(),
    passed: results.length - failed.length - skipped.length,
    failed: failed.length,
    skipped: skipped.length,
    results,
    observations,
  }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    probe: 't7-review-probe.v1',
    error: (error && error.message) || String(error),
    stack: error && error.stack ? String(error.stack).split('\n').slice(1, 5) : [],
  }, null, 2));
  process.exitCode = 2;
});
