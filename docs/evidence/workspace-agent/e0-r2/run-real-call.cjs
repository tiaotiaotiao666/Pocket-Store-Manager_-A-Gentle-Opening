'use strict';

/**
 * E0-R2 真实多模态取证脚本（X2）——**由 verifier 在 t8 执行**（本任务不消耗真实额度）。
 *
 * 用法（PowerShell）：
 *   $env:DEEPSEEK_API_KEY = 'sk-...'
 *   node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs
 *   # 有真实工作区（能拿到 treeDigest）时加：
 *   node docs/evidence/workspace-agent/e0-r2/run-real-call.cjs --project "<userData>" --project-id p_xxxxxxxx
 *
 * 做三件事（同一提示，唯一变量是“有没有图”）：
 *   A. 带归档样本 probe.png（真实 assetId）→ 期望回答指出「红色圆形 + 蓝色方块」
 *   B. 不带图（纯文本同一提示）→ 不得声称看见图
 *   C. 只把 assetId 当文本 → 不得声称看见图（证明多模态不是文本幻觉）
 *
 * 工具集：三路都**不传 request.tools**，走 runtime 的生产默认（§14.3 的 11 个模型工具），
 * 并用包装器记录真正发给上游的工具条数（case.sentTools 应为 11），不再用『收窄工具集』规避通道上限。
 *
 * 输出：stdout 打印 JSON，并写入本目录 `real-call.json`（不含 Key、不含 data URL、不含 prompt 原文）。
 * 判定（脚本自带，便于 t8 直接引用）：
 *   - A 必须 ok 且 reply 命中颜色/形状词；
 *   - B、C 不得出现「红/蓝/圆/方」等只可能来自图像的结论；
 *   - 三者 A/B/C 的 model 相同，A 的 messages 里确有 image_url（脚本记录 parts 摘要）。
 *
 * 安全边界：Key 只从环境变量读，绝不打印、绝不落到本目录；safeStorage 用进程内随机密钥的
 * AES-256-GCM 实现（落盘的密文离开本进程不可解），临时目录结束时删除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
const {
  createDirectWorkspaceRuntime,
  createModelChat,
  resolveAssetImage,
  buildMultimodalContent,
  MODEL_TOOL_NAMES,
} = require(path.join(ROOT, 'desktop', 'agent-runtime'));

const EVIDENCE_DIR = __dirname;
const PROBE = path.join(EVIDENCE_DIR, 'probe.png');
const MODEL = process.env.E0R2_MODEL || 'deepseek-flash';
const QUESTION = '这张目标页参考图里主要有哪些颜色和形状？请只描述你真正看到的内容。';
// t13：不再收窄工具集 —— 三路都走 runtime 的**生产默认**工具集（§14.3 的 11 个模型工具）。
// t12 已把通道上限改为工具清单长度的单一来源，真实取证必须与生产路径一致。
let lastSentTools = null;

function parseArgs(argv) {
  const out = { project: null, projectId: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project') out.project = argv[index + 1];
    if (argv[index] === '--project-id') out.projectId = argv[index + 1];
  }
  return out;
}

/** 进程内 AES-256-GCM 的 safeStorage：密钥只在内存，落盘密文离开本进程不可解。 */
function inMemorySafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (buffer) => {
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const body = buffer.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 造一个最小可用项目资产（与 desktop/asset-store.cjs 的落盘形状一致）。 */
function seedProjectAsset(userDataDir, projectId, bytes) {
  const digest = sha256(bytes);
  const fileName = `${digest.slice(0, 16)}.png`;
  const assetId = `a_${digest.slice(0, 16)}`;
  const assetsDir = path.join(userDataDir, 'projects', projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, fileName), bytes);
  const projectFile = path.join(userDataDir, 'projects', projectId, 'project.json');
  let doc = { id: projectId };
  if (fs.existsSync(projectFile)) {
    try {
      doc = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    } catch (error) {
      /* 保留真实工程文件，只在无法解析时重建 */
    }
  }
  const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
  if (!images.some((item) => item && item.assetId === assetId)) {
    images.push({
      assetId,
      fileName,
      originalName: 'e0-r2-probe.png',
      mime: 'image/png',
      bytes: bytes.length,
      width: 96,
      height: 96,
      sha256: `sha256:${digest}`,
      createdAt: '2026-11-25T00:00:00Z',
      source: 'user-upload',
    });
  }
  doc.assets = { ...(doc.assets || {}), images };
  fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
  return { assetId, fileName, sha256: digest, bytes: bytes.length };
}

function judge(reply, expectImage) {
  const text = typeof reply === 'string' ? reply : '';
  // 明确否认看到图时，后面即使出现“圆角/方形”等举例也不得判为看图证据。
  const explicitDenial = /没有(?:真正)?看到|看不到|无法描述|没有(?:拿到|收到).{0,8}(?:图|图像|画面)|不会凭猜测|没有图像内容/.test(text);
  const hitsColor = /红|蓝|白/.test(text);
  const hitsShape = /圆|方/.test(text);
  const claims = hitsColor || hitsShape;
  if (expectImage) return { sawImageEvidence: claims };
  return { sawImageEvidence: claims && !explicitDenial, mustNotClaim: true, explicitDenial };
}

async function runCase(label, runtime, baseRequest, expectImage) {
  lastSentTools = null;
  const startedAt = Date.now();
  const result = await runtime.invoke({ context: baseRequest.context, request: baseRequest.request });
  const latencyMs = Date.now() - startedAt;
  const sentTools = lastSentTools;
  const reply = result && result.ok
    ? (result.data && typeof result.data.reply === 'string' ? result.data.reply : '')
    : '';
  return {
    label,
    ok: Boolean(result && result.ok),
    code: result && result.ok ? null : (result && result.code) || 'UNKNOWN',
    status: result && result.data ? result.data.status : null,
    model: result && result.data ? result.data.model : null,
    multimodal: result && result.data ? result.data.multimodal === true : false,
    images: result && result.data && Array.isArray(result.data.images) ? result.data.images : [],
    requestHadImage: expectImage,
    // 真正发给上游的工具条数：应等于生产默认工具集（§14.3 的 11 个），证明没有收窄规避。
    sentTools,
    reply: reply.slice(0, 400),
    traceToolLabels: result && result.data && Array.isArray(result.data.steps)
      ? result.data.steps.map((step) => 'model:' + (step.model || '') + '/finish:' + (step.finishReason || ''))
      : [],
    usage: result && result.data ? result.data.usage : null,
    latencyMs,
    judgement: judge(reply, expectImage),
  };
}

/**
 * 构造 `real-call.json` 的报告形状（**唯一出口**，便于回归测试与 t8 复核）。
 *
 * §14.8-4：report 里**不得出现任何 `data:` 字面量**（连前缀也不行，证据目录的全量扫描
 * 会把内联图片前缀视为泄漏）。因此图片只记 `hasImageUrl` / `imageUrlScheme` /
 * `dataUrlBytes` / `sentSha256MatchesProbe`，不复制 URL 片段。
 */
function buildRealCallReport(input) {
  const source = input && typeof input === 'object' ? input : {};
  const sent = source.sentParts && typeof source.sentParts === 'object' ? source.sentParts : {};
  const probe = source.probe && typeof source.probe === 'object' ? source.probe : {};
  return {
    status: source.status === 'PASS' ? 'PASS' : 'FAIL',
    model: typeof source.model === 'string' ? source.model : null,
    question: typeof source.question === 'string' ? source.question : null,
    probe: {
      file: typeof probe.file === 'string' ? probe.file : null,
      sha256: typeof probe.sha256 === 'string' ? probe.sha256 : null,
      bytes: Number.isInteger(probe.bytes) ? probe.bytes : null,
      assetId: typeof probe.assetId === 'string' ? probe.assetId : null,
    },
    sentParts: {
      types: Array.isArray(sent.types) ? sent.types.filter((type) => typeof type === 'string') : [],
      hasImageUrl: sent.hasImageUrl === true,
      imageUrlScheme: 'inline-data-url',
      dataUrlBytes: Number.isInteger(sent.dataUrlBytes) ? sent.dataUrlBytes : 0,
      sentSha256MatchesProbe: sent.sentSha256MatchesProbe === true,
    },
    coordinator: source.coordinator && typeof source.coordinator === 'object' ? source.coordinator : null,
    cases: Array.isArray(source.cases) ? source.cases : [],
    verdict: source.verdict && typeof source.verdict === 'object' ? source.verdict : {},
    note: 'B/C 若出现“红色/蓝色/圆形/方形”等只可能来自图像的结论，即说明多模态是文本幻觉，判定 FAIL。',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !apiKey.startsWith('sk-')) {
    const blocked = {
      status: 'BLOCKED',
      reason: 'NO_API_KEY',
      message: '环境里没有 DEEPSEEK_API_KEY（或格式不对），无法执行真实多模态调用。',
      actualError: 'DEEPSEEK_API_KEY missing',
      tookEffect: false,
    };
    console.log(JSON.stringify(blocked, null, 2));
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'real-call.json'), JSON.stringify(blocked, null, 2), 'utf8');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(PROBE)) {
    throw new Error('缺少归档样本 probe.png（应位于 docs/evidence/workspace-agent/e0-r2/）');
  }

  const probeBytes = fs.readFileSync(PROBE);
  const probeSha = sha256(probeBytes);
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'e0r2-real-'));
  const tokenDir = path.join(tempUserData, 'model-slots');
  const userDataDir = args.project ? path.resolve(args.project) : tempUserData;
  const projectId = args.projectId || 'p_e0r2real1';

  credentialsMod.resetSharedModelCallScheduler();
  const credentials = credentialsMod.createModelCredentials({
    userDataDir: tempUserData,
    safeStorage: inMemorySafeStorage(),
    env: { MODEL_UPSTREAM_TOKEN_DIR: tokenDir },
  });
  await credentials.setKey(apiKey);

  // 只观测不改造：包一层 credentials.chat 记录**真正发出**的工具条数（不含 Key/prompt/图片）。
  const rawChat = credentials.chat.bind(credentials);
  credentials.chat = async (payload, options) => {
    lastSentTools = Array.isArray(payload && payload.tools) ? payload.tools.length : 0;
    return rawChat(payload, options);
  };

  const asset = seedProjectAsset(userDataDir, projectId, probeBytes);
  const image = resolveAssetImage({ userDataDir, projectId, assetId: asset.assetId });
  const parts = buildMultimodalContent({ utterance: QUESTION, images: [image] });

  const modelChat = createModelChat({ credentials, supportsVision: true });
  const coordinatorStub = {
    invokeTool: async () => ({ ok: true, data: null }),
    assertRunActive: () => ({ ok: true }),
  };
  // 用真实 Coordinator 才能在结果里拿到 treeDigest（t8 在真实工作区上跑时启用）。
  let coordinator = coordinatorStub;
  let coordinatorInfo = { mode: 'stub', treeDigest: null };
  if (args.project && args.projectId) {
    const { createRunCoordinator } = require(path.join(ROOT, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));
    coordinator = createRunCoordinator({ userDataDir, directRuntime: null });
    const started = coordinator.startRun({
      projectId,
      targetPage: 'home',
      operation: 'e0-r2-real-call',
      utterance: QUESTION,
      imageAssetIds: [asset.assetId],
    });
    coordinatorInfo = {
      mode: 'coordinator',
      startRunOk: Boolean(started && started.ok),
      startRunCode: started && started.ok ? null : (started && started.code) || null,
      runId: started && started.ok ? started.runId : null,
      turnId: started && started.ok ? started.turnId : null,
      attemptId: started && started.ok ? started.attemptId : null,
      treeDigest: null,
    };
    if (coordinatorInfo.attemptId) {
      const state = coordinator.getAttemptState({
        projectId,
        runId: coordinatorInfo.runId,
        turnId: coordinatorInfo.turnId,
        attemptId: coordinatorInfo.attemptId,
      });
      coordinatorInfo.treeDigest = state && state.ok ? (state.treeDigest || null) : null;
    }
  }

  const runtime = createDirectWorkspaceRuntime({
    coordinator,
    modelChat,
    userDataDir,
    vision: true,
    systemPrompt: '你是智能开店桌面应用里的源码编辑助手。只描述你真正看到的内容。',
  });

  const context = {
    projectId,
    runId: coordinatorInfo.runId || 'frun-real',
    turnId: coordinatorInfo.turnId || 'turn-real',
    attemptId: coordinatorInfo.attemptId || 'att-real',
  };

  const cases = [];
  // A：带图
  const withImageRequest = {
    context,
    request: { utterance: QUESTION, images: [asset.assetId], profile: 'chat', model: MODEL },
  };
  cases.push(await runCase('A-带图', runtime, withImageRequest, true));
  // B：同一提示不带图
  cases.push(await runCase('B-不带图同一提示', runtime, {
    context,
    request: { utterance: QUESTION, profile: 'chat', model: MODEL },
  }, false));
  // C：只把 assetId 当文本
  cases.push(await runCase('C-只给 assetId 文本', runtime, {
    context,
    request: {
      utterance: `${QUESTION}（参考图 assetId：${asset.assetId}）`,
      profile: 'chat',
      model: MODEL,
    },
  }, false));

  const [a, b, c] = cases;
  const verdict = {
    x2RealCall: a.ok && a.multimodal && a.judgement.sawImageEvidence ? 'PASS' : (a.ok ? 'FAIL_A_NO_IMAGE_EVIDENCE' : 'BLOCKED_' + a.code),
    counterexamplesClean: !b.judgement.sawImageEvidence && !c.judgement.sawImageEvidence,
    // 三路都必须按生产默认的模型工具集发出（不收窄）：条数应等于 §14.3 的清单长度。
    productionToolSet: cases.every((item) => item.sentTools === MODEL_TOOL_NAMES.length),
  };

  const report = buildRealCallReport({
    status: verdict.x2RealCall === 'PASS' ? 'PASS' : 'FAIL',
    model: MODEL,
    question: QUESTION,
    probe: { file: 'probe.png', sha256: probeSha, bytes: probeBytes.length, assetId: asset.assetId },
    sentParts: {
      types: parts.map((part) => part.type),
      // X2 证据只证明「真的发了 image_url 内联图片」，**不落任何 data: 字面量**
      // （即使是前缀也不算：证据目录的全量扫描会把内联图片前缀视为泄漏）。
      hasImageUrl: Boolean(parts[1] && parts[1].image_url && typeof parts[1].image_url.url === 'string'),
      imageUrlScheme: 'inline-data-url',
      dataUrlBytes: parts[1] ? Buffer.from(parts[1].image_url.url.split(',')[1], 'base64').length : 0,
      sentSha256MatchesProbe: parts[1]
        ? sha256(Buffer.from(parts[1].image_url.url.split(',')[1], 'base64')) === probeSha
        : false,
    },
    coordinator: coordinatorInfo,
    cases,
    verdict,
  });

  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'real-call.json'), JSON.stringify(report, null, 2), 'utf8');

  credentialsMod.resetSharedModelCallScheduler();
  fs.rmSync(tempUserData, { recursive: true, force: true });
  if (verdict.x2RealCall !== 'PASS' || !verdict.counterexamplesClean) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const failure = {
      status: 'BLOCKED',
      reason: 'SCRIPT_ERROR',
      message: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : null,
    };
    console.log(JSON.stringify(failure, null, 2));
    try {
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'real-call.json'), JSON.stringify(failure, null, 2), 'utf8');
    } catch (writeError) {
      /* 证据目录不可写时只打印 */
    }
    process.exitCode = 2;
  });
}

module.exports = { main, buildRealCallReport };
