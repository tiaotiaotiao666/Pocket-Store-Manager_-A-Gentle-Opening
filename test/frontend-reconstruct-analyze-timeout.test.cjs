'use strict';

/**
 * 截图识别的超时与失败复盘（2026-11-19）。
 *
 * 背景：`frontend:analyze` 曾复用设置的 `agentTimeoutMs`。用户把对话超时设成
 * 12000ms 后，视觉链路（deepseek-flash 单次实测 3–23 秒、至少 2 轮）必然被提前掐断，
 * 界面只显示「识别超时（12000ms）」。这里锁定两个行为：
 * 1. 识别有独立超时，缺省至少 120 秒，且不受 agentTimeoutMs 变小影响；
 * 2. 识别失败把 code/message/时间写进 run.json.lastAnalyze，便于复盘且不落图片。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const IPC_PATH = path.join(REPO, 'desktop', 'frontend-reconstruct-ipc.cjs');
const {
  createFrontendReconstructIpc,
  resolveAnalyzeTimeoutMs,
  ANALYZE_MIN_TIMEOUT_MS,
  ANALYZE_MAX_TIMEOUT_MS,
  CODES,
} = require(IPC_PATH);

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-timeout-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return dir;
}

function trustedEvent() {
  return {
    senderFrame: { url: 'http://127.0.0.1:5173/' },
    sender: { send: () => {} },
  };
}

function stubCredentials() {
  return {
    getAuthorization: async () => ({ ok: true, authorization: 'Bearer ds_stub', expiresAt: null }),
    invalidate: () => {},
    describe: () => ({ hasToken: true, expiresAt: null, lastFailureCode: null }),
  };
}

function analyzePayload() {
  const dataBase64 = 'aGVsbG8td29ybGQ=';
  return {
    projectId: 'p_abc12345',
    runId: 'frun-ipc-1',
    requestId: 'fr-ipc-1',
    utterance: '按截图重构首页，保留下单',
    image: { mediaType: 'image/png', dataBase64 },
    targetPages: ['home'],
    current: {
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    consent: {
      confirmedAt: new Date().toISOString(),
      imageDigest: 'sha256:' + crypto.createHash('sha256').update(dataBase64, 'utf8').digest('hex'),
      host: '127.0.0.1:3000',
      purpose: 'frontend-reconstruct',
    },
  };
}

test('识别超时解析：agentTimeoutMs=12000 时仍给到 120 秒，独立配置优先', () => {
  assert.strictEqual(resolveAnalyzeTimeoutMs({ agentTimeoutMs: 12000 }), 120000);
  assert.strictEqual(resolveAnalyzeTimeoutMs({ agentTimeoutMs: 30000 }), 120000);
  assert.strictEqual(resolveAnalyzeTimeoutMs({ agentTimeoutMs: 120000 }), ANALYZE_MAX_TIMEOUT_MS);
  assert.strictEqual(resolveAnalyzeTimeoutMs({}), 120000);
  assert.strictEqual(
    resolveAnalyzeTimeoutMs({ analyzeTimeoutMs: 60000, agentTimeoutMs: 12000 }),
    60000,
    '独立配置必须优先于对话超时',
  );
  assert.strictEqual(resolveAnalyzeTimeoutMs({ analyzeTimeoutMs: 1000 }), ANALYZE_MIN_TIMEOUT_MS);
  assert.strictEqual(resolveAnalyzeTimeoutMs({ analyzeTimeoutMs: 999999 }), ANALYZE_MAX_TIMEOUT_MS);
});

test('识别超时：配置为 12000ms 时实际按 120 秒等待，并写入可复盘的 lastAnalyze', async (t) => {
  const userDataDir = tempUserData(t);
  const created = createFrontendReconstructIpc({
    userDataDir,
    credentials: stubCredentials(),
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
    resolveConfig: async () => ({
      apiBaseUrl: 'http://127.0.0.1:3000/api/v1',
      agentTransport: 'http',
      agentTimeoutMs: 12000,
    }),
  });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, CODES.ANALYZE_TIMEOUT);
  assert.match(result.message, /已等待 120 秒/, '实际等待时间必须是 120 秒而不是 12 秒');

  const runFile = path.join(
    userDataDir,
    'projects',
    'p_abc12345',
    'frontend-runs',
    'frun-ipc-1',
    'run.json',
  );
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.strictEqual(run.lastAnalyze.ok, false);
  assert.strictEqual(run.lastAnalyze.code, CODES.ANALYZE_TIMEOUT);
  assert.ok(typeof run.lastAnalyze.at === 'string' && run.lastAnalyze.at.length > 0);
  assert.deepStrictEqual(run.attempts, [], '识别失败不得伪造候选 attempt');
  assert.ok(!JSON.stringify(run).includes('aGVsbG8td29ybGQ='), 'run.json 不得包含图片 base64');
});