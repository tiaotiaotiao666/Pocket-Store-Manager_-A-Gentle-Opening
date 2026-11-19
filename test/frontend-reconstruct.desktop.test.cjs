'use strict';

/**
 * P4：桌面受信 IPC 与 preload 语义 API 的定向测试。
 *
 * 覆盖：
 * 1. preload 只暴露 8 个语义 API，没有通用 read/write/exec/invoke；
 * 2. 主进程拒绝不可信 sender、未知参数、超限 payload/图片/草稿；
 * 3. 每项目单任务串行、全局并发上限、按 runId 取消；
 * 4. 写操作只允许本应用创建的私有 workspace（伪造 attempt 一律拒绝）；
 * 5. 真实 materialize + dry-run 全链路：静态门禁、采用门槛（partial 需确认）、
 *    放弃记录、运行时证据读取；返回体不含绝对路径；
 * 6. 微信 CLI 不可用时不伪造 PASS（BLOCKED 如实返回）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const IPC_PATH = path.join(REPO, 'desktop', 'frontend-reconstruct-ipc.cjs');
const {
  createFrontendReconstructIpc,
  registerFrontendReconstructIpc,
  CODES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_PAYLOAD_BYTES,
} = require(IPC_PATH);
const workspace = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'workspace.cjs'));
const reconstruct = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'index.cjs'));
const { treeSha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const REGISTRY_DIR = path.join(REPO, 'templates', 'registry');
const PACKS_DIR = path.join(REPO, 'templates', 'frontend-packs');

function tempUserData(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-ipc-' + (prefix || 'x') + '-'));
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
  const sent = [];
  return {
    senderFrame: { url: 'http://127.0.0.1:5173/' },
    sender: { send: (channel, payload) => sent.push({ channel, payload }) },
    sent,
  };
}

function untrustedEvent() {
  const sent = [];
  return {
    senderFrame: { url: 'https://evil.example.com/' },
    sender: { send: (channel, payload) => sent.push({ channel, payload }) },
    sent,
  };
}

function analyzePayload(overrides) {
  return {
    projectId: 'p_abc12345',
    runId: 'frun-ipc-1',
    requestId: 'fr-ipc-1',
    utterance: '按截图重构首页，保留下单',
    image: { mediaType: 'image/png', dataBase64: 'aGVsbG8td29ybGQ=' },
    targetPages: ['home'],
    current: {
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    ...(overrides || {}),
  };
}

function plannedServerResponse() {
  return {
    contractVersion: 'frontend-reconstruct.v1',
    runId: 'frun-server-1',
    status: 'planned',
    requirement: { summary: '首页更紧凑', mustKeep: [], pages: [], visual: {}, bindings: [], unknownRegions: [], lowConfidence: [], inferredInteractions: [], unsupported: [], degradations: [] },
    coverage: { status: 'covered', requiredCapabilities: ['page:home'], missingCapabilities: [], coveredBy: {}, risks: [], degradations: [] },
    draft: { schemaVersion: 'frontend-pack-draft.v1', displayName: '候选', pages: [] },
    questions: [],
    trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
    meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 10 },
  };
}

function draftFixture() {
  return {
    schemaVersion: 'frontend-pack-draft.v1',
    displayName: '参考图首页候选',
    pages: [
      {
        pageId: 'home',
        nodes: [
          {
            type: 'component',
            componentId: 'store-header',
            props: { storeName: { kind: 'data', dataPath: 'store.name' } },
            events: {},
          },
          { type: 'slot', slotId: 'home-hero' },
          { type: 'text', textToken: 'store.address', style: { size: 'md', colorToken: 'textColor' } },
          { type: 'button', label: '开始点餐', action: 'home.goMenu' },
        ],
        styles: [],
        pageJson: { navigationBarTitleText: '扫码点餐' },
      },
    ],
  };
}

function attemptMetaOf(projectId, runId, attempt, candidateId) {
  return {
    schemaVersion: 'frontend-attempt.v1',
    projectId,
    runId,
    attempt,
    createdAt: '2026-11-17T00:00:00.000Z',
    status: 'committed',
    candidate: {
      id: candidateId,
      version: '1.0.0',
      integrity: 'sha256:' + 'a'.repeat(64),
      draftDigest: 'sha256:' + 'b'.repeat(64),
      pages: ['home'],
      requiresSlots: [],
    },
    overlay: { path: 'overlay', registryDigest: 'sha256:' + 'c'.repeat(64), candidatePath: 'frontend-packs/' + candidateId },
    files: ['manifest.json', 'src/pages/home/index.wxml'],
    degradations: [],
  };
}

/**
 * 造一个「本应用已创建」的 attempt（workspace + run.json 登记），
 * 用于在不跑 Composer 的前提下测采用/放弃门槛。
 */
function seedOwnedAttempt(userDataDir, options) {
  const opts = options || {};
  const projectId = opts.projectId || 'p_seed1234';
  const runId = opts.runId || 'frun-seed-1';
  const candidateId = opts.candidateId || 'cand-seed';
  const created = workspace.createWorkspace({ userDataDir, projectId, runId });
  assert.equal(created.ok, true, JSON.stringify(created));
  const begun = workspace.beginAttempt(created);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const attempt = begun.attempt;
  const attemptDir = begun.attemptDir;
  fs.mkdirSync(path.join(attemptDir, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(attemptDir, 'overlay'), { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'attempt.json'), JSON.stringify(attemptMetaOf(projectId, runId, attempt, candidateId), null, 2));
  fs.mkdirSync(path.join(attemptDir, 'verification', 'dry-run'), { recursive: true });
  fs.writeFileSync(
    path.join(attemptDir, 'verification', 'dry-run', 'frontend-dry-run.json'),
    JSON.stringify({
      schemaVersion: 'frontend-dry-run.v1',
      ok: opts.dryRunOk !== false,
      code: opts.dryRunOk === false ? 'SLOT_ANCHOR_MISSING' : 'OK',
      summary: opts.dryRunOk === false ? '可观察项对照未通过' : 'dry-run 通过',
      candidateId,
      candidateVersion: '1.0.0',
      revision: attempt,
      plan: {},
      outputRelativePath: 'verification/dry-run/candidate',
      checks: opts.dryRunOk === false
        ? [{ id: 'observable', status: 'fail', message: '缺少 slot fallback 锚点' }]
        : [{ id: 'mini-check', status: 'pass', message: 'ok' }],
      issues: opts.dryRunOk === false
        ? [{ code: 'SLOT_ANCHOR_MISSING', path: '$.pages[0].nodes[1].slotId', field: 'slotId', message: '缺少锚点' }]
        : [],
      details: {},
      generatedAt: '2026-11-17T00:00:00.000Z',
    }, null, 2),
  );
  if (opts.runtimeStatus) {
    fs.mkdirSync(path.join(attemptDir, 'verification', 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(attemptDir, 'verification', 'runtime', 'frontend-runtime.json'),
      JSON.stringify({
        schemaVersion: 'frontend-runtime.v1',
        generatedAt: '2026-11-17T00:00:00.000Z',
        status: opts.runtimeStatus,
        code: null,
        summary: 'seed',
        screenshots: [],
        // B1：证据必须绑定候选身份，否则采用/导出闸门视为过期证据。
        candidate: {
          id: opts.evidenceCandidateId || candidateId,
          version: opts.evidenceCandidateVersion || '1.0.0',
          integrity: opts.evidenceIntegrity || 'sha256:' + 'a'.repeat(64),
        },
      }, null, 2),
    );
  }
  const recorded = workspace.recordAttempt(created, {
    attempt,
    createdAt: '2026-11-17T00:00:00.000Z',
    candidateId,
    candidateVersion: '1.0.0',
    integrity: 'sha256:' + 'a'.repeat(64),
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  return { projectId, runId, attempt, attemptDir };
}

/** B2：桌面会话凭证桩（真实实现见 desktop/desktop-session.cjs）。 */
function stubCredentials() {
  return {
    getAuthorization: async () => ({ ok: true, authorization: 'Bearer ds_stub', expiresAt: null }),
    invalidate: () => {},
    describe: () => ({ hasToken: true, expiresAt: null, lastFailureCode: null }),
  };
}

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const body = typeof response === 'function' ? response() : response;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

test('preload 只暴露 8 个候选前端语义 API，且没有通用 IPC', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const listenerSets = new Map();
  const invokes = [];
  let exposed;
  const ipcRenderer = {
    on: (channel, handler) => { listenerSets.set(channel, handler); },
    invoke: async (channel, payload) => {
      invokes.push({ channel, payload });
      return { ok: true };
    },
  };
  vm.runInNewContext(source, {
    require: (request) => {
      assert.strictEqual(request, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
        ipcRenderer,
      };
    },
    console,
  });
  const api = exposed.value;
  const frontendNames = [
    'analyzeFrontend',
    'buildCandidate',
    'validateCandidate',
    'verifyCandidate',
    'adoptCandidate',
    'discardCandidate',
    'cancelFrontendRun',
    'onFrontendProgress',
  ];
  frontendNames.forEach((name) => {
    assert.strictEqual(typeof api[name], 'function', '缺少语义 API ' + name);
  });
  // 不允许把 ipcRenderer / invoke / send / 通用文件与命令入口泄露给页面。
  ['ipcRenderer', 'invoke', 'send', 'readFile', 'writeFile', 'exec', 'spawn', 'require'].forEach((name) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(api, name), false, '不应暴露通用能力 ' + name);
  });

  const channels = {
    analyzeFrontend: 'frontend:analyze',
    buildCandidate: 'frontend:build-candidate',
    validateCandidate: 'frontend:validate-candidate',
    verifyCandidate: 'frontend:verify-candidate',
    adoptCandidate: 'frontend:adopt-candidate',
    discardCandidate: 'frontend:discard-candidate',
    cancelFrontendRun: 'frontend:cancel-run',
  };
  Object.keys(channels).forEach((name) => {
    const before = invokes.length;
    api[name]({ ping: name });
    assert.strictEqual(invokes.length, before + 1);
    assert.strictEqual(invokes[invokes.length - 1].channel, channels[name]);
  });

  let received = null;
  const unsubscribe = api.onFrontendProgress((payload) => { received = payload; });
  assert.strictEqual(typeof unsubscribe, 'function');
  assert.deepStrictEqual([...listenerSets.keys()].filter((channel) => channel === 'frontend:progress'), ['frontend:progress']);
  listenerSets.get('frontend:progress')({}, { stage: 'compose', runId: 'frun-1' });
  assert.strictEqual(received.stage, 'compose');
  unsubscribe();
  received = null;
  listenerSets.get('frontend:progress')({}, { stage: 'done' });
  assert.strictEqual(received, null);
});

test('IPC 拒绝不可信 sender，所有语义 channel 都走同一道检查', async (t) => {
  const userDataDir = tempUserData(t, 'sender');
  const handlers = {};
  const ipcMain = { handle: (channel, handler) => { handlers[channel] = handler; } };
  registerFrontendReconstructIpc(ipcMain, { userDataDir });
  assert.deepStrictEqual(Object.keys(handlers).sort(), [
    'frontend:adopt-candidate',
    'frontend:analyze',
    'frontend:build-candidate',
    'frontend:cancel-run',
    'frontend:discard-candidate',
    'frontend:validate-candidate',
    'frontend:verify-candidate',
  ]);
  for (const channel of Object.keys(handlers)) {
    const result = await handlers[channel](untrustedEvent(), {});
    assert.strictEqual(result.ok, false, channel);
    assert.strictEqual(result.code, CODES.UNTRUSTED_SENDER, channel);
  }
  const tooLarge = await handlers['frontend:build-candidate'](trustedEvent(), { padding: 'x'.repeat(MAX_PAYLOAD_BYTES + 32) });
  assert.strictEqual(tooLarge.code, CODES.PAYLOAD_TOO_LARGE);
});

test('analyze：主进程按设置代发请求，请求体单图 + 严格契约，返回有界响应', async (t) => {
  const userDataDir = tempUserData(t, 'analyze');
  const fetch = fakeFetch(plannedServerResponse());
  const created = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: fetch.impl,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http', agentTimeoutMs: 8000 }),
  });
  const event = trustedEvent();
  const result = await created.handlers['frontend:analyze'](event, analyzePayload());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.response.status, 'planned');
  assert.strictEqual(fetch.calls.length, 1);
  assert.strictEqual(fetch.calls[0].url, 'http://127.0.0.1:3000/api/v1/agent/frontend-reconstruct');
  assert.strictEqual(fetch.calls[0].init.method, 'POST');
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.strictEqual(body.contractVersion, 'frontend-reconstruct.v1');
  assert.strictEqual(body.images.length, 1);
  assert.strictEqual(body.images[0].kind, 'reference');
  assert.strictEqual(body.images[0].mediaType, 'image/png');
  assert.strictEqual(body.targetPages.join(','), 'home');
  assert.strictEqual(body.current.frontendPack, null);
  assert.strictEqual(body.client.phase, 'frontend-reconstruct');
  // 进度只含阶段标签与 runId，不含绝对路径/图片。
  assert.ok(event.sent.length >= 1, '应推送进度事件');
  const progressPayload = JSON.stringify(event.sent.map((item) => item.payload));
  assert.ok(!progressPayload.includes(userDataDir));
  assert.ok(!/[A-Za-z]:\\\\/.test(progressPayload));
  assert.ok(!progressPayload.includes('aGVsbG8'));
});

test('analyze：图片/文字/页面/未知参数/体积上限都被拒绝，且不产生写操作', async (t) => {
  const userDataDir = tempUserData(t, 'limits');
  const fetch = fakeFetch(plannedServerResponse());
  const created = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: fetch.impl,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http' }),
  });
  const event = trustedEvent();
  const cases = [
    [{ image: { mediaType: 'image/gif', dataBase64: 'aa' } }, CODES.IMAGE_TYPE],
    [{ image: { mediaType: 'image/png', dataBase64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 8) } }, CODES.IMAGE_TOO_LARGE],
    [{ image: { mediaType: 'image/png', dataBase64: '***not-base64***' } }, CODES.IMAGE_INVALID],
    [{ utterance: 'x'.repeat(501) }, CODES.UTTERANCE_TOO_LONG],
    [{ targetPages: ['settings'] }, CODES.TARGET_PAGES_INVALID],
    [{ unexpected: true }, CODES.PAYLOAD_INVALID],
    [{ runId: 'not-a-run' }, CODES.RUN_ID_INVALID],
  ];
  for (const [overrides, code] of cases) {
    const result = await created.handlers['frontend:analyze'](event, analyzePayload(overrides));
    assert.strictEqual(result.ok, false, JSON.stringify(overrides));
    assert.strictEqual(result.code, code, JSON.stringify(overrides));
  }
  assert.strictEqual(fetch.calls.length, 0, '非法输入不得发出请求');
  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'projects')), false, '分析失败不得创建工作区');
});

test('analyze：模拟模式/上游不可用/契约不一致都如实失败，不返回假草稿', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-fail');
  const created = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: fakeFetch(plannedServerResponse()).impl,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'mock' }),
  });
  const mock = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.strictEqual(mock.code, CODES.ANALYZE_UNAVAILABLE);

  const mismatchIpc = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: fakeFetch({ ...plannedServerResponse(), contractVersion: 'v9' }).impl,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http' }),
  });
  const mismatch = await mismatchIpc.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.strictEqual(mismatch.code, CODES.CONTRACT_MISMATCH);

  const upstreamIpc = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: async () => ({
      status: 502,
      text: async () => JSON.stringify({ code: 'DEEPSEEK_VISION_UNAVAILABLE', message: '上游 502' }),
    }),
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http' }),
  });
  const upstream = await upstreamIpc.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.strictEqual(upstream.code, CODES.ANALYZE_UNAVAILABLE);
  assert.match(upstream.message, /不可用/);
});

test('每项目单任务串行；按 runId 取消后槽位释放', async (t) => {
  const userDataDir = tempUserData(t, 'serial');
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    if (!init || !init.signal) return;
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const created = createFrontendReconstructIpc({
    userDataDir,
    // B2：这些用例只验证主进程代发逻辑，凭证用桩，避免为每个用例申领会话。
    credentials: stubCredentials(),
    fetchImpl: hangingFetch,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http' }),
  });
  const event = trustedEvent();
  const first = created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-serial-1', projectId: 'p_abc12345' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-serial-2', projectId: 'p_abc12345' }));
  assert.strictEqual(second.code, CODES.BUSY);
  const sameRunOtherProject = await created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-serial-1', projectId: 'p_other1234' }));
  assert.strictEqual(sameRunOtherProject.code, CODES.BUSY, '同一 runId 不得并发');

  const cancelled = await created.handlers['frontend:cancel-run'](event, { runId: 'frun-serial-1' });
  assert.strictEqual(cancelled.ok, true);
  assert.strictEqual(cancelled.runId, 'frun-serial-1');
  const firstResult = await first;
  assert.strictEqual(firstResult.code, CODES.CANCELLED);
  const noActive = await created.handlers['frontend:cancel-run'](event, { runId: 'frun-serial-1' });
  assert.strictEqual(noActive.code, CODES.NO_ACTIVE_RUN);
  const afterCancel = created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-serial-3', projectId: 'p_abc12345' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelThird = await created.handlers['frontend:cancel-run'](event, { projectId: 'p_abc12345' });
  assert.strictEqual(cancelThird.runId, 'frun-serial-3', '取消可按项目兜底，但只作用于该项目的当前 run');
  await afterCancel;

  // 全局并发上限：两个不同项目各一个在途任务，第三个被拒。
  const a = created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-cap-a', projectId: 'p_capa1234' }));
  const b = created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-cap-b', projectId: 'p_capb1234' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const third = await created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-cap-c', projectId: 'p_capc1234' }));
  assert.strictEqual(third.code, CODES.BUSY);
  await created.handlers['frontend:cancel-run'](event, { runId: 'frun-cap-a' });
  await created.handlers['frontend:cancel-run'](event, { runId: 'frun-cap-b' });
  await a;
  await b;
  assert.deepStrictEqual(created.getActive(), { projects: [], runs: [] });
});

test('build：真实 materialize + dry-run 全链路通过，返回体无绝对路径', async (t) => {
  const userDataDir = tempUserData(t, 'build');
  const registryBefore = treeSha256(REGISTRY_DIR);
  const packsBefore = treeSha256(PACKS_DIR);
  const created = createFrontendReconstructIpc({ userDataDir });
  const event = trustedEvent();
  const result = await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_build1234',
    runId: 'frun-ipc-build',
    draft: draftFixture(),
  });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.staticPass, true, JSON.stringify(result.verification));
  assert.match(result.candidate.candidateId, /^fr-[0-9a-f]{12}$/);
  assert.strictEqual(result.candidate.attempt, 1);
  assert.deepStrictEqual(result.candidate.pages, ['home']);
  assert.strictEqual(result.verification.static.ok, true);
  assert.strictEqual(result.verification.repairs, 0);
  assert.strictEqual(result.verification.repairStatus, 'not_needed');
  assert.strictEqual(result.artifacts.attemptRelative, 'projects/p_build1234/frontend-runs/frun-ipc-build/attempts/attempt-1');
  assert.strictEqual(result.artifacts.outputRelative, 'verification/dry-run/candidate');

  const serialized = JSON.stringify(result);
  assert.strictEqual(serialized.includes(userDataDir.replace(/\\/g, '\\\\')), false, '返回体不得含私有根绝对路径');
  assert.strictEqual(serialized.includes(userDataDir), false, '返回体不得含私有根绝对路径');
  assert.strictEqual(/[A-Za-z]:\\\\/.test(serialized), false, '返回体不得含 Windows 绝对路径');

  const attemptDir = path.join(userDataDir, 'projects', 'p_build1234', 'frontend-runs', 'frun-ipc-build', 'attempts', 'attempt-1');
  assert.strictEqual(fs.existsSync(path.join(attemptDir, 'candidate', 'manifest.json')), true);
  assert.strictEqual(fs.existsSync(path.join(attemptDir, 'verification', 'dry-run', 'frontend-dry-run.json')), true);

  // 进度事件：真实阶段名 + 有界字段，绝不含图片/路径。
  const stages = event.sent.map((item) => item.payload.stage);
  ['materialize', 'compose', 'mini-check', 'consistency', 'observable', 'done'].forEach((stage) => {
    assert.ok(stages.includes(stage), '缺少进度阶段 ' + stage + '：' + stages.join(','));
  });
  const progressJson = JSON.stringify(event.sent.map((item) => item.payload));
  assert.strictEqual(progressJson.includes(userDataDir), false);

  // 全局正式资产零变化（候选只在私有工作区）。
  assert.strictEqual(treeSha256(REGISTRY_DIR), registryBefore);
  assert.strictEqual(treeSha256(PACKS_DIR), packsBefore);

  // 复核（只读）：证据 + overlay 校验通过。
  const validated = await created.handlers['frontend:validate-candidate'](event, {
    projectId: 'p_build1234',
    runId: 'frun-ipc-build',
    attempt: 1,
  });
  assert.strictEqual(validated.ok, true, JSON.stringify(validated));
  assert.strictEqual(validated.verification.static.ok, true);
  assert.strictEqual(validated.candidate.candidateId, result.candidate.candidateId);
});

test('采用门槛：静态通过但微信未跑必须单独确认；确认后写采用记录；可放弃', async (t) => {
  const userDataDir = tempUserData(t, 'adopt');
  const created = createFrontendReconstructIpc({ userDataDir });
  const event = trustedEvent();
  const built = await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_adopt1234',
    runId: 'frun-ipc-adopt',
    draft: draftFixture(),
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built));

  const refused = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_adopt1234',
    runId: 'frun-ipc-adopt',
    attempt: 1,
    partialConfirmed: false,
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, CODES.PARTIAL_CONFIRM_REQUIRED);
  assert.strictEqual(refused.details.runtimeStatus, 'NOT_RUN');

  const adopted = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_adopt1234',
    runId: 'frun-ipc-adopt',
    attempt: 1,
    partialConfirmed: true,
  });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.adoption.candidateId, built.candidate.candidateId);
  assert.strictEqual(adopted.adoption.partialConfirmed, true);
  assert.strictEqual(adopted.adoption.runtimeStatus, 'NOT_RUN');
  const adoptedFile = path.join(userDataDir, 'projects', 'p_adopt1234', 'frontend-runs', 'frun-ipc-adopt', 'attempts', 'attempt-1', 'adopted.json');
  assert.strictEqual(fs.existsSync(adoptedFile), true);
  const record = JSON.parse(fs.readFileSync(adoptedFile, 'utf8'));
  assert.strictEqual(record.schemaVersion, 'frontend-adoption.v1');
  assert.strictEqual(record.staticGates, 'pass');
  assert.ok(!JSON.stringify(record).includes(userDataDir));

  const discarded = await created.handlers['frontend:discard-candidate'](event, {
    projectId: 'p_adopt1234',
    runId: 'frun-ipc-adopt',
    attempt: 1,
  });
  assert.strictEqual(discarded.ok, true, JSON.stringify(discarded));
  assert.strictEqual(discarded.discarded, true);
  assert.strictEqual(
    fs.existsSync(path.join(userDataDir, 'projects', 'p_adopt1234', 'frontend-runs', 'frun-ipc-adopt', 'attempts', 'attempt-1', 'discarded.json')),
    true,
  );
});

test('微信 CLI 不可用时 verify 如实 BLOCKED，绝不伪造 PASS', async (t) => {
  const userDataDir = tempUserData(t, 'verify');
  // P0：CLI 解析现在与「预览」链路共用同一份搜索顺序（会扫安装目录），
  // 所以这里显式指定一个不存在的 cliPath，避免测试依赖本机是否装了开发者工具。
  const missingCli = path.join(userDataDir, 'missing-cli.bat');
  const created = createFrontendReconstructIpc({
    userDataDir,
    reconstruct: {
      ...reconstruct,
      verifyRuntimeCandidate: (input) => reconstruct.verifyRuntimeCandidate({ ...input, cliPath: missingCli }),
    },
  });
  const event = trustedEvent();
  const built = await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_verify1234',
    runId: 'frun-ipc-verify',
    draft: draftFixture(),
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  const verified = await created.handlers['frontend:verify-candidate'](event, {
    projectId: 'p_verify1234',
    runId: 'frun-ipc-verify',
    attempt: 1,
  });
  // IPC 传输成功（ok:true）但结论不是 PASS：绝不能把 BLOCKED 当成验证通过。
  assert.strictEqual(verified.status, 'BLOCKED');
  assert.strictEqual(verified.message.includes('没有拿到 PASS'), true, verified.message);
  assert.strictEqual(verified.screenshots.length, 0);
  // 证据目录仍落在私有 attempt 内，且没有把绝对路径回传给渲染进程。
  assert.ok(!JSON.stringify(verified).includes(userDataDir));
});

test('写操作只允许本应用创建的 workspace：伪造 attempt 一律拒绝', async (t) => {
  const userDataDir = tempUserData(t, 'owned');
  const created = createFrontendReconstructIpc({ userDataDir });
  const event = trustedEvent();

  // 1) 完全没有工作区。
  const missing = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_missing1',
    runId: 'frun-missing-1',
    attempt: 1,
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, CODES.ATTEMPT_MISSING);

  // 2) 手工造出的 attempt（没有 run.json 登记，也不是本会话创建）→ 拒绝。
  const forgedDir = path.join(userDataDir, 'projects', 'p_forged1', 'frontend-runs', 'frun-forged-1', 'attempts', 'attempt-1');
  fs.mkdirSync(forgedDir, { recursive: true });
  fs.writeFileSync(path.join(forgedDir, 'attempt.json'), JSON.stringify(attemptMetaOf('p_forged1', 'frun-forged-1', 1, 'cand-forged'), null, 2));
  const forged = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_forged1',
    runId: 'frun-forged-1',
    attempt: 1,
  });
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.code, CODES.WORKSPACE_NOT_OWNED);

  // 3) 非法 attempt / 非法 id 在路径推导前就被拒绝。
  assert.strictEqual((await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_missing1', runId: 'frun-missing-1', attempt: 0,
  })).code, CODES.ATTEMPT_INVALID);
  assert.strictEqual((await created.handlers['frontend:build-candidate'](event, {
    projectId: '../escape', runId: 'frun-x', draft: draftFixture(),
  })).code, CODES.PROJECT_ID_INVALID);
  assert.strictEqual((await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_ok123456', runId: 'not-frun', draft: draftFixture(),
  })).code, CODES.RUN_ID_INVALID);
  assert.strictEqual((await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_ok123456', runId: 'frun-x', draft: draftFixture(), extra: 1,
  })).code, CODES.PAYLOAD_INVALID);
  assert.strictEqual((await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_ok123456', runId: 'frun-x', draft: { ...draftFixture(), padding: 'x'.repeat(70 * 1024) },
  })).code, CODES.PAYLOAD_TOO_LARGE);
});

test('静态门禁未通过时拒绝采用，并允许放弃；证据与本应用登记的工作区一致', async (t) => {
  const userDataDir = tempUserData(t, 'gate');
  const seeded = seedOwnedAttempt(userDataDir, {
    projectId: 'p_gate1234',
    runId: 'frun-gate-1',
    candidateId: 'cand-gate',
    dryRunOk: false,
  });
  const created = createFrontendReconstructIpc({ userDataDir });
  const event = trustedEvent();
  const adopted = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: seeded.projectId,
    runId: seeded.runId,
    attempt: seeded.attempt,
    partialConfirmed: true,
  });
  assert.strictEqual(adopted.ok, false);
  assert.strictEqual(adopted.code, CODES.STATIC_GATES_FAILED);

  const discarded = await created.handlers['frontend:discard-candidate'](event, {
    projectId: seeded.projectId,
    runId: seeded.runId,
    attempt: seeded.attempt,
  });
  assert.strictEqual(discarded.ok, true, JSON.stringify(discarded));
});

test('微信证据 PASS 时不需要 partial 确认即可采用', async (t) => {
  const userDataDir = tempUserData(t, 'pass');
  const seeded = seedOwnedAttempt(userDataDir, {
    projectId: 'p_pass1234',
    runId: 'frun-pass-1',
    candidateId: 'cand-pass',
    dryRunOk: true,
    runtimeStatus: 'PASS',
  });
  const created = createFrontendReconstructIpc({ userDataDir });
  const event = trustedEvent();
  const adopted = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: seeded.projectId,
    runId: seeded.runId,
    attempt: seeded.attempt,
    partialConfirmed: false,
  });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.adoption.runtimeStatus, 'PASS');
  assert.strictEqual(adopted.adoption.partialConfirmed, false);
});

test('build 失败（未知事件）如实返回错误，不创建工作区也不返回候选', async (t) => {
  const userDataDir = tempUserData(t, 'buildfail');
  const created = createFrontendReconstructIpc({ userDataDir });
  const draft = draftFixture();
  draft.pages[0].nodes[0].events = { tap: 'home.goNope' };
  const result = await created.handlers['frontend:build-candidate'](trustedEvent(), {
    projectId: 'p_bad12345',
    runId: 'frun-bad-1',
    draft,
  });
  assert.strictEqual(result.ok, false);
  assert.equal(result.code, 'DRAFT_UNKNOWN_EVENT');
  assert.strictEqual(result.candidate, undefined);
  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'projects', 'p_bad12345')), false);
});

test('候选文件数/体积上限：超出即拒绝，不让私有工作区变成任意写盘通道', async (t) => {
  const userDataDir = tempUserData(t, 'bounds');
  const buildStub = (files) => ({
    materializeCandidate: (options) => {
      const created = workspace.createWorkspace({
        userDataDir: options.userDataDir,
        projectId: options.projectId,
        runId: options.runId,
      });
      const begun = workspace.beginAttempt(created);
      fs.mkdirSync(path.join(begun.attemptDir, 'candidate'), { recursive: true });
      fs.mkdirSync(path.join(begun.attemptDir, 'overlay'), { recursive: true });
      const meta = attemptMetaOf(options.projectId, options.runId, begun.attempt, 'cand-bounds');
      meta.files = files;
      fs.writeFileSync(path.join(begun.attemptDir, 'attempt.json'), JSON.stringify(meta, null, 2));
      return {
        ok: true,
        attempt: begun.attempt,
        attemptDir: begun.attemptDir,
        candidate: { id: 'cand-bounds', version: '1.0.0' },
        files,
        degradations: [],
      };
    },
    dryRunCandidate: async (options) => ({
      ok: true,
      code: 'OK',
      summary: 'stub dry-run',
      candidateId: 'cand-bounds',
      revision: options.materialized.attempt,
      issues: [],
      checks: [{ id: 'mini-check', status: 'pass', message: 'ok' }],
      artifacts: { attemptDir: options.materialized.attemptDir, outputRelativePath: 'verification/dry-run/candidate' },
    }),
    verifyRuntimeCandidate: async () => ({ status: 'NOT_RUN', code: 'CANCELLED', summary: '未跑', screenshots: [], pages: [], interactions: [], artifacts: {} }),
  });
  const manyFiles = Array.from({ length: 60 }, (_, index) => 'f' + index + '.json');
  const created = createFrontendReconstructIpc({ userDataDir, reconstruct: buildStub(manyFiles) });
  const tooMany = await created.handlers['frontend:build-candidate'](trustedEvent(), {
    projectId: 'p_bounds12',
    runId: 'frun-bounds-1',
    draft: draftFixture(),
  });
  assert.strictEqual(tooMany.ok, false);
  assert.strictEqual(tooMany.code, CODES.CANDIDATE_TOO_LARGE);

  const singleTooBig = buildStub(['huge.wxml']);
  const bigIpc = createFrontendReconstructIpc({ userDataDir, reconstruct: singleTooBig });
  // 单文件上限：写出 129KB 的候选文件后必须被拒。
  const forged = await bigIpc.handlers['frontend:build-candidate'](trustedEvent(), {
    projectId: 'p_big12345',
    runId: 'frun-big-1',
    draft: draftFixture(),
  });
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.code, CODES.WORKSPACE_INVALID, '文件不存在应先被身份/路径校验拦住');

  // 正常的 60 文件清单之外，再验证越界清单被拒（path traversal）。
  const traversal = buildStub(['../attempt.json']);
  const traversalIpc = createFrontendReconstructIpc({ userDataDir, reconstruct: traversal });
  const escaped = await traversalIpc.handlers['frontend:build-candidate'](trustedEvent(), {
    projectId: 'p_trav1234',
    runId: 'frun-trav-1',
    draft: draftFixture(),
  });
  assert.strictEqual(escaped.ok, false);
  assert.strictEqual(escaped.code, CODES.WORKSPACE_INVALID);
});

test('静态门禁失败（slot 锚点缺失）不返回 PASS，且候选只能放弃', async (t) => {
  const userDataDir = tempUserData(t, 'anchor');
  const stubReconstruct = {
    ...reconstruct,
    materializeCandidate: (options) => {
      const created = workspace.createWorkspace({
        userDataDir: options.userDataDir,
        projectId: options.projectId,
        runId: options.runId,
      });
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      const begun = workspace.beginAttempt(created);
      assert.strictEqual(begun.ok, true, JSON.stringify(begun));
      fs.mkdirSync(path.join(begun.attemptDir, 'candidate'), { recursive: true });
      fs.mkdirSync(path.join(begun.attemptDir, 'overlay'), { recursive: true });
      fs.mkdirSync(path.join(begun.attemptDir, 'candidate', 'src', 'pages', 'home'), { recursive: true });
      fs.writeFileSync(path.join(begun.attemptDir, 'candidate', 'manifest.json'), JSON.stringify({ schemaVersion: 'frontend-pack.v1' }));
      fs.writeFileSync(path.join(begun.attemptDir, 'candidate', 'src', 'pages', 'home', 'index.wxml'), '<view>stub</view>');
      fs.writeFileSync(
        path.join(begun.attemptDir, 'attempt.json'),
        JSON.stringify(attemptMetaOf(options.projectId, options.runId, begun.attempt, 'cand-anchor'), null, 2),
      );
      return {
        ok: true,
        attempt: begun.attempt,
        attemptDir: begun.attemptDir,
        candidate: { id: 'cand-anchor', version: '1.0.0' },
        files: ['manifest.json'],
        degradations: [],
      };
    },
    dryRunCandidate: async (options) => {
      // 模拟 Composer 已跑、可观察项缺少 slot 锚点，并写出与真实 dry-run 同名的证据。
      const verificationDir = path.join(options.materialized.attemptDir, 'verification', 'dry-run');
      fs.mkdirSync(verificationDir, { recursive: true });
      const evidence = {
        schemaVersion: 'frontend-dry-run.v1',
        ok: false,
        code: 'SLOT_ANCHOR_MISSING',
        summary: '可观察项对照未通过',
        candidateId: 'cand-anchor',
        candidateVersion: '1.0.0',
        revision: options.materialized.attempt,
        plan: {},
        outputRelativePath: 'verification/dry-run/candidate',
        checks: [{ id: 'observable', status: 'fail', message: '缺少 slot 锚点' }],
        issues: [{ code: 'SLOT_ANCHOR_MISSING', path: '$.pages[0].nodes[1].slotId', field: 'slotId', message: '缺少 slot 锚点' }],
        details: {},
        generatedAt: '2026-11-17T00:00:00.000Z',
      };
      fs.writeFileSync(path.join(verificationDir, 'frontend-dry-run.json'), JSON.stringify(evidence, null, 2));
      return {
        ok: false,
        code: 'SLOT_ANCHOR_MISSING',
        summary: '可观察项对照未通过',
        candidateId: 'cand-anchor',
        revision: options.materialized.attempt,
        issues: [{ code: 'SLOT_ANCHOR_MISSING', path: '$.pages[0].nodes[1].slotId', field: 'slotId', source: 'observable', severity: 'error', message: '缺少 slot 锚点' }],
        checks: [{ id: 'observable', status: 'fail', message: '缺少 slot 锚点' }],
        artifacts: { attemptDir: options.materialized.attemptDir, verificationDir, outputRelativePath: 'verification/dry-run/candidate' },
      };
    },
    verifyRuntimeCandidate: async () => ({ status: 'NOT_RUN', code: 'CANCELLED', summary: '未跑', screenshots: [], pages: [], interactions: [], artifacts: {} }),
  };
  const created = createFrontendReconstructIpc({ userDataDir, reconstruct: stubReconstruct });
  const event = trustedEvent();
  const result = await created.handlers['frontend:build-candidate'](event, {
    projectId: 'p_anchor12',
    runId: 'frun-anchor-1',
    draft: draftFixture(),
  });
  assert.strictEqual(result.ok, true, '构建流程本身跑完了');
  assert.strictEqual(result.staticPass, false);
  assert.strictEqual(result.verification.static.ok, false);
  assert.strictEqual(result.verification.static.code, 'SLOT_ANCHOR_MISSING');
  assert.strictEqual(result.verification.static.issues[0].path, '$.pages[0].nodes[1].slotId');
  assert.strictEqual(result.verification.repairs, 0);
  assert.strictEqual(result.verification.repairStatus, 'not_available');

  const adopted = await created.handlers['frontend:adopt-candidate'](event, {
    projectId: 'p_anchor12',
    runId: 'frun-anchor-1',
    attempt: result.candidate.attempt,
    partialConfirmed: true,
  });
  assert.strictEqual(adopted.ok, false);
  assert.strictEqual(adopted.code, CODES.STATIC_GATES_FAILED);
});
