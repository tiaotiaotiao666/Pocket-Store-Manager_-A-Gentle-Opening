'use strict';

/**
 * E0 真实 Flash 最小源码闭环（人工执行取证，不冒充自动门禁）。
 *
 * 一次真实多模态回合：真实页面参考图 → Flash 读源码 → write_files →
 * 平台四项检查 → submit → partial adopt → undo/redo。
 *
 * 只写系统临时 userData，结束删除；证据不含 Key、data URL、prompt 原文或绝对路径。
 * 用法（PowerShell，Key 只进环境变量）：
 *   $env:DEEPSEEK_API_KEY='sk-...'
 *   node docs/evidence/workspace-agent/e0-v1/run-real-chain.cjs
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const credentialsMod = require(path.join(ROOT, 'desktop', 'model-credentials.cjs'));
const versionsMod = require(path.join(ROOT, 'desktop', 'agent-workspace', 'versions.cjs'));
const { createCheckRegistry } = require(path.join(ROOT, 'desktop', 'agent-workspace', 'checks.cjs'));
const { createRunCoordinator } = require(path.join(ROOT, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));
const { createDirectWorkspaceRuntime, createModelChat } = require(path.join(ROOT, 'desktop', 'agent-runtime'));

const PROJECT_ID = 'p_e0realchain';
const MODEL = process.env.E0_REAL_MODEL || 'deepseek-flash';
const REFERENCE = path.join(ROOT, 'docs', 'evidence', 'm7', 'wechat', 'order-classic-home.png');
const OUT = path.join(__dirname, 'real-chain.json');
const UTTERANCE = [
  '参考图是一张微信小程序首页截图。请先调用 get_context 和 read_file 读取 pages/menu/index.wxml，',
  '然后用 write_files 在同一页末尾、最后一个 </view> 之前插入',
  '<view class="e0-real-note">参考图样式已应用</view>。',
  '只改这一处，不要调用 run_check（平台稍后统一检查）。写完用一句简体中文说明你改了什么。',
].join('');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

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

function seedAsset(userDataDir) {
  const bytes = fs.readFileSync(REFERENCE);
  const digest = sha256(bytes);
  const fileName = digest.slice(0, 16) + '.png';
  const assetId = 'a_' + digest.slice(0, 16);
  const dir = path.join(userDataDir, 'projects', PROJECT_ID, 'assets', 'images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), bytes);
  const projectFile = path.join(userDataDir, 'projects', PROJECT_ID, 'project.json');
  let doc = { id: PROJECT_ID };
  if (fs.existsSync(projectFile)) {
    try { doc = JSON.parse(fs.readFileSync(projectFile, 'utf8')); } catch { /* rebuild */ }
  }
  doc.assets = {
    ...(doc.assets || {}),
    images: [{
      assetId, fileName, originalName: 'order-classic-home.png', mime: 'image/png',
      bytes: bytes.length, width: 750, height: 1624, sha256: 'sha256:' + digest,
      createdAt: new Date().toISOString(), source: 'user-upload',
    }],
  };
  fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
  return { assetId, sha256: digest, bytes: bytes.length, width: 750, height: 1624 };
}

function toolSummary(result) {
  return Array.isArray(result && result.data && result.data.toolCalls)
    ? result.data.toolCalls.map((call) => ({
      name: call.name,
      ok: call.ok === true,
      code: call.code || null,
      path: call.path || null,
    }))
    : [];
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !apiKey.startsWith('sk-')) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'NO_API_KEY' }, null, 2));
    process.exitCode = 2;
    return;
  }
  const startedAt = Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0-real-chain-'));
  const report = {
    schemaVersion: 'e0-real-chain.v1',
    status: 'FAIL',
    model: MODEL,
    reference: null,
    steps: {},
    cleanup: false,
  };
  try {
    const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
    if (!init.ok) throw new Error('initProject: ' + init.code);
    const asset = seedAsset(userDataDir);
    report.reference = { file: 'docs/evidence/m7/wechat/order-classic-home.png', sha256: asset.sha256, bytes: asset.bytes, assetId: asset.assetId };

    credentialsMod.resetSharedModelCallScheduler();
    const credentials = credentialsMod.createModelCredentials({
      userDataDir,
      safeStorage: inMemorySafeStorage(),
      env: { MODEL_UPSTREAM_TOKEN_DIR: path.join(userDataDir, 'model-slots') },
    });
    await credentials.setKey(apiKey);
    const modelChat = createModelChat({ credentials, supportsVision: true });
    let coordinator = null;
    const runtime = createDirectWorkspaceRuntime({
      coordinator: () => coordinator,
      modelChat,
      userDataDir,
      vision: true,
    });
    coordinator = createRunCoordinator({
      userDataDir,
      checks: createCheckRegistry({ userDataDir }),
      directRuntime: runtime,
      emitProgress: () => {},
    });

    const run = coordinator.startRun({
      projectId: PROJECT_ID,
      targetPage: 'menu',
      operation: 'e0-real-chain',
      utterance: UTTERANCE,
      imageAssetIds: [asset.assetId],
    });
    if (!run.ok) throw new Error('startRun: ' + run.code);
    const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
    report.steps.startRun = { ok: true, targetPage: run.targetPage, baseVersionId: run.baseVersionId };

    const direct = await coordinator.invokeDirect({
      ...ctx,
      request: { utterance: UTTERANCE, images: [asset.assetId], model: MODEL, profile: 'direct-edit' },
    });
    report.steps.direct = {
      ok: Boolean(direct && direct.ok),
      code: direct && direct.code ? direct.code : null,
      message: direct && typeof direct.message === 'string' ? direct.message.slice(0, 300) : null,
      issues: direct && Array.isArray(direct.issues) ? direct.issues.slice(0, 8) : [],
      status: direct && direct.data ? direct.data.status : null,
      stopReason: direct && direct.data ? direct.data.stopReason : null,
      modelCalls: direct && direct.data ? direct.data.modelCalls : null,
      truncated: direct && direct.data ? direct.data.truncated === true : null,
      multimodal: direct && direct.data ? direct.data.multimodal === true : null,
      images: direct && direct.data && Array.isArray(direct.data.images)
        ? direct.data.images.map((item) => ({ assetId: item.assetId, bytes: item.bytes, sha256: item.sha256 }))
        : [],
      toolCalls: toolSummary(direct),
      reply: direct && direct.data && typeof direct.data.reply === 'string' ? direct.data.reply.slice(0, 400) : '',
    };
    if (!direct || !direct.ok) throw new Error('direct: ' + (direct && direct.code));

    const state = coordinator.getAttemptState(ctx);
    report.steps.attempt = state && state.ok ? {
      revision: state.revision, treeDigest: state.treeDigest, status: state.status,
    } : { code: state && state.code };
    const read = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
    const wroteMarker = Boolean(read.ok && read.data.content.includes('e0-real-note'));
    report.steps.source = { hasMarker: wroteMarker, revision: read.ok ? read.data.sha256 : null };
    if (!wroteMarker) throw new Error('MODEL_DID_NOT_WRITE_MARKER');

    const checkResults = [];
    for (const checkId of ['source.check', 'composer.dry-run', 'mini.check', 'output.consistency']) {
      const checked = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId } });
      checkResults.push({
        checkId,
        ok: Boolean(checked && checked.ok),
        status: checked && checked.data ? checked.data.status : null,
        issues: checked && checked.data && Array.isArray(checked.data.issues) ? checked.data.issues.slice(0, 10).map((i) => i.code) : [],
      });
      if (!checked || !checked.ok || checked.data.status !== 'PASS') break;
    }
    report.steps.checks = checkResults;
    if (checkResults.length !== 4 || checkResults.some((item) => item.status !== 'PASS')) throw new Error('CHECKS_NOT_PASS');

    const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
    report.steps.submit = submitted && submitted.ok ? {
      candidateId: submitted.candidateId, revision: submitted.revision,
      treeDigest: submitted.treeDigest, partial: submitted.partial,
      exportRelative: submitted.exportRelative, exportTreeDigest: submitted.exportTreeDigest,
    } : { ok: false, code: submitted && submitted.code, message: submitted && submitted.message };
    if (!submitted || !submitted.ok) throw new Error('submit: ' + (submitted && submitted.code));

    const blockedAdopt = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu' });
    const confirmed = coordinator.adoptAttempt({ ...ctx, targetPage: 'menu', partialConfirmed: true });
    report.steps.adopt = {
      withoutConfirm: { ok: Boolean(blockedAdopt && blockedAdopt.ok), code: blockedAdopt && blockedAdopt.code || null, nextAction: blockedAdopt && blockedAdopt.nextAction || null },
      confirmed: confirmed && confirmed.ok ? {
        adoptedVersionId: confirmed.adoptedVersionId, currentVersionId: confirmed.currentVersionId,
        treeDigest: confirmed.treeDigest,
      } : { ok: false, code: confirmed && confirmed.code, message: confirmed && confirmed.message },
    };
    if (!confirmed || !confirmed.ok) throw new Error('adopt: ' + (confirmed && confirmed.code));

    const undo = versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
    const redo = versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID });
    report.steps.undoRedo = {
      undo: undo.ok ? undo.currentVersionId : undo.code,
      redo: redo.ok ? redo.currentVersionId : redo.code,
    };
    report.status = 'PASS';
    report.verdict = {
      realImageSent: report.steps.direct.multimodal === true,
      realToolLoop: report.steps.direct.toolCalls.some((call) => call.name === 'write_files' && call.ok),
      sourceEdited: wroteMarker,
      fourChecksPass: true,
      partialConfirmed: report.steps.adopt.withoutConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED',
      adoptedNewVersion: true,
      undoRedo: Boolean(undo.ok && redo.ok),
      runtimeStatus: 'wechat BLOCKED/NOT_RUN (真实微信未跑)',
    };
    report.durationMs = Date.now() - startedAt;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = report.steps.direct ? 'FAIL' : 'BLOCKED';
    report.failure = { message: error && error.message ? error.message : String(error), code: error && error.code ? error.code : null };
    report.durationMs = Date.now() - startedAt;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      credentialsMod.resetSharedModelCallScheduler();
    } catch {
      /* 清理调度器失败不掩盖主结果 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      report.cleanup = !fs.existsSync(userDataDir);
    } catch {
      report.cleanup = false;
    }
    try {
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
      console.log('报告：' + path.relative(ROOT, OUT));
    } catch (error) {
      console.error('报告写入失败：' + (error && error.message));
      process.exitCode = 2;
    }
  }
}

if (require.main === module) {
  main()
    .then(() => {
      // Windows 上调度器/token 目录的句柄可能让进程迟迟不退出；报告已落盘，这里显式结束。
      process.exit(process.exitCode || 0);
    })
    .catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(2);
    });
}

module.exports = { main };
