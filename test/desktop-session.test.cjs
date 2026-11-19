'use strict';

/**
 * B2：桌面端凭证与 401/429 分流的回归用例（Electron 主进程侧）。
 *
 * 覆盖点：
 * 1. 主进程自动申领短期桌面会话，并用 `Authorization: Bearer` 代发识别请求；
 * 2. token 只在主进程内存与 HTTP 头里：不出现在 IPC 返回体、不进 describe()、不落盘；
 * 3. 401 → 会话失效（可重试），并清掉缓存；429 → 限流（可重试）；
 * 4. 拿不到凭证时**不发起识别请求**（绝不静默匿名回退），也不把 401 说成「模型不可用」。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createFrontendReconstructIpc, CODES } = require('../desktop/frontend-reconstruct-ipc.cjs');
const { createDesktopCredentialProvider, TOKEN_PATTERN } = require('../desktop/desktop-session.cjs');

const REPO = path.resolve(__dirname, '..');
const API_BASE = 'http://127.0.0.1:3000/api/v1';
const TOKEN_A = 'ds_' + 'a'.repeat(48);
const TOKEN_B = 'ds_' + 'b'.repeat(48);

function tempUserData(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-desktop-' + label + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trustedEvent() {
  const sent = [];
  return {
    senderFrame: { url: 'file://' + path.join(REPO, 'dist', 'index.html') },
    sender: { send: (channel, payload) => sent.push({ channel, payload }) },
    sent,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** 记录每次 fetch 的 (url, init)，按 url 后缀分派响应。 */
function scriptedFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const key = Object.keys(handlers).find((suffix) => String(url).endsWith(suffix));
    if (!key) throw new Error('unexpected url: ' + url);
    const handler = handlers[key];
    return typeof handler === 'function' ? handler(url, init) : handler;
  };
  return { impl, calls };
}

function sessionOk(token, expiresInSeconds, baseNowMs) {
  const ttl = expiresInSeconds || 900;
  const base = typeof baseNowMs === 'number' ? baseNowMs : Date.now();
  return jsonResponse(200, {
    contract: 'desktop-session.v1',
    token,
    expiresAt: new Date(base + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
  });
}

/**
 * B5：截图外发确认。桌面上必须先有一次「这张图 + 这个接收方」的确认，
 * 主进程才肯代发；这里的用例关心会话行为，所以统一带一份合法确认。
 */
function consentFor(dataBase64, overrides) {
  return {
    confirmedAt: new Date().toISOString(),
    imageDigest: 'sha256:' + crypto.createHash('sha256').update(dataBase64, 'utf8').digest('hex'),
    host: '127.0.0.1:3000',
    purpose: 'frontend-reconstruct',
    ...(overrides || {}),
  };
}

function analyzePayload(overrides) {
  const image = { mediaType: 'image/png', dataBase64: 'aGVsbG8td29ybGQ=' };
  return {
    projectId: 'p_abc12345',
    runId: 'frun-b2-1',
    requestId: 'fr-b2-1',
    utterance: '按截图重构首页，保留下单',
    image,
    targetPages: ['home'],
    current: {
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      frontendPack: null,
      presentationPatch: {},
    },
    consent: consentFor(image.dataBase64),
    ...(overrides || {}),
  };
}

function plannedServerResponse() {
  return {
    contractVersion: 'frontend-reconstruct.v1',
    runId: 'frun-server-1',
    status: 'planned',
    requirement: {
      summary: '首页更紧凑',
      mustKeep: [],
      pages: [],
      visual: {},
      bindings: [],
      unknownRegions: [],
      lowConfidence: [],
      inferredInteractions: [],
      unsupported: [],
      degradations: [],
    },
    coverage: {
      status: 'covered',
      requiredCapabilities: ['page:home'],
      missingCapabilities: [],
      coveredBy: {},
      risks: [],
      degradations: [],
    },
    draft: { schemaVersion: 'frontend-pack-draft.v1', displayName: '候选', pages: [] },
    questions: [],
    trace: { modelCalls: 1, toolCalls: [], stopReason: 'final_answer', degraded: false },
    meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 10 },
  };
}

function makeIpc(options) {
  const clock = options.clock || { now: () => Date.now() };
  const credentials = createDesktopCredentialProvider({
    fetchImpl: options.fetchImpl,
    now: () => clock.now(),
  });
  const created = createFrontendReconstructIpc({
    userDataDir: options.userDataDir,
    credentials,
    now: () => clock.now(),
    fetchImpl: options.fetchImpl,
    resolveConfig: () => ({
      apiBaseUrl: API_BASE,
      agentTransport: 'deepseek',
      agentEndpoint: '/agent/frontend-reconstruct',
      agentTimeoutMs: 5000,
    }),
  });
  return { created, credentials, clock };
}

// ---------------------------------------------------------------------------
// 凭证持有者
// ---------------------------------------------------------------------------

test('凭证持有者：自动申领一次并复用，Authorization 形如 Bearer ds_*', async (t) => {
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => sessionOk(TOKEN_A, 900),
  });
  const provider = createDesktopCredentialProvider({ fetchImpl: impl });

  const first = await provider.getAuthorization(API_BASE);
  assert.equal(first.ok, true);
  assert.match(first.authorization, /^Bearer ds_[0-9a-f]{48}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].url.endsWith('/api/v1/desktop/session'));

  const second = await provider.getAuthorization(API_BASE);
  assert.equal(second.ok, true);
  assert.equal(calls.length, 1, '未过期时不重复申领');
  t.diagnostic('provider 只在本地内存缓存 token');
});

test('凭证持有者：并发调用是单飞，只申领一次', async () => {
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => sessionOk(TOKEN_A, 900),
  });
  const provider = createDesktopCredentialProvider({ fetchImpl: impl });
  const [a, b, c] = await Promise.all([
    provider.getAuthorization(API_BASE),
    provider.getAuthorization(API_BASE),
    provider.getAuthorization(API_BASE),
  ]);
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.equal(calls.length, 1);
});

test('凭证持有者：临期自动重领，失效后 invalidate 会重新申领', async () => {
  let current = Date.now();
  const clock = { now: () => current };
  let issued = 0;
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => {
      issued += 1;
      return sessionOk(issued === 1 ? TOKEN_A : TOKEN_B, 900, current);
    },
  });
  const provider = createDesktopCredentialProvider({ fetchImpl: impl, now: () => clock.now() });

  const first = await provider.getAuthorization(API_BASE);
  assert.equal(first.authorization, 'Bearer ' + TOKEN_A);

  // 推进到「提前 60 秒视为临期」之外
  current += 900 * 1000;
  const refreshed = await provider.getAuthorization(API_BASE);
  assert.equal(refreshed.authorization, 'Bearer ' + TOKEN_B);
  assert.equal(calls.length, 2);

  provider.invalidate();
  assert.equal(provider.describe().hasToken, false);
  await provider.getAuthorization(API_BASE);
  assert.equal(calls.length, 3);
});

test('凭证持有者：403/404/429/网络失败/契约不符都如实失败且不抛异常', async () => {
  const cases = [
    { handler: () => jsonResponse(403, { code: 'DESKTOP_SESSION_LOOPBACK_ONLY' }), code: 'DESKTOP_SESSION_LOOPBACK_ONLY' },
    { handler: () => jsonResponse(404, {}), code: 'DESKTOP_SESSION_UNSUPPORTED' },
    { handler: () => jsonResponse(429, {}), code: 'DESKTOP_SESSION_RATE_LIMITED' },
    {
      handler: async () => {
        throw new Error('ECONNREFUSED');
      },
      code: 'DESKTOP_SESSION_UNAVAILABLE',
    },
    { handler: () => jsonResponse(200, { contract: 'wrong', token: TOKEN_A }), code: 'DESKTOP_SESSION_INVALID_RESPONSE' },
    { handler: () => jsonResponse(200, { contract: 'desktop-session.v1', token: 'BOGUS' }), code: 'DESKTOP_SESSION_INVALID_RESPONSE' },
    { handler: () => jsonResponse(500, {}), code: 'DESKTOP_SESSION_UNAVAILABLE' },
  ];
  for (const entry of cases) {
    const { impl } = scriptedFetch({ '/desktop/session': entry.handler });
    const provider = createDesktopCredentialProvider({ fetchImpl: impl });
    const result = await provider.getAuthorization(API_BASE);
    assert.equal(result.ok, false, entry.code);
    assert.equal(result.code, entry.code);
    assert.equal(typeof result.message, 'string');
    assert.ok(!JSON.stringify(result).includes('ds_'), '失败结果里不能出现 token');
  }
});

test('凭证持有者：describe() 只暴露布尔与时间，永不回传 token', async () => {
  const { impl } = scriptedFetch({ '/desktop/session': () => sessionOk(TOKEN_A, 900) });
  const provider = createDesktopCredentialProvider({ fetchImpl: impl });
  await provider.getAuthorization(API_BASE);
  const described = JSON.stringify(provider.describe());
  assert.equal(described.includes(TOKEN_A), false);
  assert.equal(described.includes('ds_'), false);
  assert.equal(provider.describe().hasToken, true);
  assert.match(TOKEN_A, TOKEN_PATTERN);
});

// ---------------------------------------------------------------------------
// analyze：Authorization 注入与 401/429 分流
// ---------------------------------------------------------------------------

test('analyze：主进程带 Bearer 调识别接口，返回体与日志不含 token', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-ok');
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => sessionOk(TOKEN_A, 900),
    '/agent/frontend-reconstruct': () => jsonResponse(200, plannedServerResponse()),
  });
  const { created } = makeIpc({ userDataDir, fetchImpl: impl });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.ok, true, JSON.stringify(result));

  const sessionCall = calls.find((call) => call.url.endsWith('/desktop/session'));
  const analyzeCall = calls.find((call) => call.url.endsWith('/agent/frontend-reconstruct'));
  assert.ok(sessionCall && analyzeCall);
  assert.equal(sessionCall.init.headers.Authorization, undefined, '申领会话不需要旧凭证');
  assert.equal(analyzeCall.init?.headers?.Authorization || analyzeCall.init.headers.authorization, 'Bearer ' + TOKEN_A);
  assert.equal(JSON.stringify(result).includes(TOKEN_A), false, 'IPC 返回体不得含 token');
});

test('analyze：401 走会话失效（可重试），不说成模型不可用，并清掉缓存', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-401');
  let analyzeHits = 0;
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => sessionOk(TOKEN_A, 900),
    '/agent/frontend-reconstruct': () => {
      analyzeHits += 1;
      return jsonResponse(401, { code: 'AUTH_SESSION_EXPIRED', message: '本地会话已失效' });
    },
  });
  const { created, credentials } = makeIpc({ userDataDir, fetchImpl: impl });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.ANALYZE_AUTH_REQUIRED);
  assert.notEqual(result.code, CODES.ANALYZE_UNAVAILABLE);
  assert.match(result.message, /会话|重新连接/);
  assert.equal(result.details.retryable, true);
  assert.equal(credentials.describe().hasToken, false, '401 后必须清缓存');

  // 重试会重新申领会话（不会拿旧 token 硬撞）
  const retry = created.handlers['frontend:analyze'](trustedEvent(), analyzePayload({ runId: 'frun-b2-2' }));
  await retry;
  const sessionCalls = calls.filter((call) => call.url.endsWith('/desktop/session'));
  assert.ok(sessionCalls.length >= 2, '401 之后应重新申领会话');
  assert.equal(analyzeHits, 2);
});

test('analyze：429 走限流（可重试），不会重复打模型', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-429');
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => sessionOk(TOKEN_A, 900),
    '/agent/frontend-reconstruct': () => jsonResponse(429, { code: 'AGENT_RATE_LIMITED' }),
  });
  const { created } = makeIpc({ userDataDir, fetchImpl: impl });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.ANALYZE_RATE_LIMITED);
  assert.equal(result.details.retryable, true);
  const analyzeCalls = calls.filter((call) => call.url.endsWith('/agent/frontend-reconstruct'));
  assert.equal(analyzeCalls.length, 1, '只发一次请求');
});

test('analyze：拿不到凭证时根本不发识别请求（无静默匿名回退）', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-no-cred');
  const { impl, calls } = scriptedFetch({
    '/desktop/session': () => jsonResponse(500, { code: 'BOOM' }),
  });
  const { created } = makeIpc({ userDataDir, fetchImpl: impl });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.ANALYZE_AUTH_REQUIRED);
  assert.equal(result.details.retryable, true);
  assert.equal(result.details.reason, 'DESKTOP_SESSION_UNAVAILABLE');
  assert.equal(
    calls.filter((call) => call.url.endsWith('/agent/frontend-reconstruct')).length,
    0,
    '没有凭证就不许调模型接口',
  );
});

test('analyze：注入空凭证持有者时同样拒绝，绝不以匿名身份请求', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-empty-cred');
  const { impl, calls } = scriptedFetch({
    '/agent/frontend-reconstruct': () => jsonResponse(200, plannedServerResponse()),
  });
  const created = createFrontendReconstructIpc({
    userDataDir,
    fetchImpl: impl,
    credentials: { getAuthorization: async () => ({ ok: false, code: 'DESKTOP_SESSION_UNAVAILABLE' }) },
    resolveConfig: () => ({ apiBaseUrl: API_BASE, agentTransport: 'deepseek', agentTimeoutMs: 5000 }),
  });

  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.code, CODES.ANALYZE_AUTH_REQUIRED);
  assert.equal(
    calls.filter((call) => call.url.endsWith('/agent/frontend-reconstruct')).length,
    0,
  );
});

test('analyze：设置里的 mock 模式仍然直接拒绝（与 B2 无关的行为不回归）', async (t) => {
  const userDataDir = tempUserData(t, 'analyze-mock');
  const { impl, calls } = scriptedFetch({ '/desktop/session': () => sessionOk(TOKEN_A, 900) });
  const created = createFrontendReconstructIpc({
    userDataDir,
    fetchImpl: impl,
    credentials: createDesktopCredentialProvider({ fetchImpl: impl }),
    resolveConfig: () => ({ apiBaseUrl: API_BASE, agentTransport: 'mock' }),
  });
  const result = await created.handlers['frontend:analyze'](trustedEvent(), analyzePayload());
  assert.equal(result.code, CODES.ANALYZE_UNAVAILABLE);
  assert.equal(calls.filter((call) => call.url.endsWith('/agent/frontend-reconstruct')).length, 0);
});
