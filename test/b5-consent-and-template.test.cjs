'use strict';

/**
 * B5：参考截图外发告知 / 确认、模板卡「点击预览 vs 明确采用」，
 * 以及微信验证脚本的命令参数与证据脱敏、新页面 CSP。
 *
 * 这里既有源码层断言（仓库既有风格），也有真实调用：
 * - 渲染进程规则（src/domain/screenConsent.mjs）与服务层（frontendReconstructService）真跑；
 * - 主进程 IPC（desktop/frontend-reconstruct-ipc.cjs）用桩 fetch 真跑，
 *   断言「不确认 / 换图 / 换接收方 / 过期」都零请求，正常路径只请求一次并留下 consent.json。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const {
  createFrontendReconstructIpc,
  CODES,
} = require(path.join(REPO, 'desktop', 'frontend-reconstruct-ipc.cjs'));

const IMAGE_BASE64 = 'aGVsbG8td29ybGQ=';

function sha256OfBase64(dataBase64) {
  return 'sha256:' + crypto.createHash('sha256').update(dataBase64, 'utf8').digest('hex');
}

function tempUserData(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-consent-' + label + '-'));
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
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  };
  return { impl, calls };
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

function consentFor(dataBase64, overrides) {
  return {
    confirmedAt: new Date().toISOString(),
    imageDigest: sha256OfBase64(dataBase64),
    host: '127.0.0.1:3000',
    purpose: 'frontend-reconstruct',
    ...(overrides || {}),
  };
}

function analyzePayload(overrides) {
  return {
    projectId: 'p_b5consent',
    runId: 'frun-b5-1',
    requestId: 'fr-b5-1',
    utterance: '按截图重构首页',
    image: { mediaType: 'image/png', dataBase64: IMAGE_BASE64 },
    targetPages: ['home'],
    current: { baseTemplate: { id: 'ordering-base', version: '1.0.0' }, frontendPack: null, presentationPatch: {} },
    consent: consentFor(IMAGE_BASE64),
    ...(overrides || {}),
  };
}

function makeIpc(t, label, options) {
  const opts = options || {};
  const userDataDir = tempUserData(t, label);
  const fetch = fakeFetch(opts.response || plannedServerResponse());
  const created = createFrontendReconstructIpc({
    userDataDir,
    credentials: stubCredentials(),
    fetchImpl: fetch.impl,
    resolveConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:3000/api/v1', agentTransport: 'http', agentTimeoutMs: 8000 }),
  });
  return { userDataDir, fetch, created };
}

// --------------------------------------------------------------------------- 1. 告知与确认绑定

test('B5 告知文案：说清哪张图、做什么用、发给哪个 host，且不含图片内容', async () => {
  const domain = await import('../src/domain/screenConsent.mjs');
  const notice = domain.describeScreenSendNotice({
    image: { name: 'shop-home.png', bytes: 2048, dataBase64: IMAGE_BASE64 },
    baseUrl: 'http://127.0.0.1:3000/api/v1',
  });
  const text = notice.lines.join('\n');
  assert.equal(notice.title, '要把这张截图发给模型识别吗？');
  assert.equal(notice.imageName, 'shop-home.png');
  assert.equal(notice.host, '127.0.0.1:3000');
  assert.match(text, /shop-home\.png/);
  assert.match(text, /2 KB/);
  assert.match(text, /用途/);
  assert.match(text, /127\.0\.0\.1:3000/);
  assert.match(text, /取消不影响当前项目和普通模板流程/);
  assert.ok(!text.includes(IMAGE_BASE64), '告知文案不得带图片内容');
  assert.equal(notice.confirmLabel, '确认发送');
  assert.equal(notice.cancelLabel, '取消，不发');
});

test('B5 确认绑定：换图 / 换接收方 / 超时都要重新确认，不做永久覆盖', async () => {
  const domain = await import('../src/domain/screenConsent.mjs');
  const base = Date.parse('2026-11-19T06:00:00.000Z');
  const digest = sha256OfBase64(IMAGE_BASE64);
  const consent = domain.createScreenConsent({ imageDigest: digest, host: '127.0.0.1:3000', now: base });
  assert.equal(consent.purpose, 'frontend-reconstruct');
  assert.equal(consent.confirmedAt, '2026-11-19T06:00:00.000Z');
  assert.ok(!JSON.stringify(consent).includes(IMAGE_BASE64), '确认凭据不得包含图片内容');

  const ok = domain.isScreenConsentUsable(consent, { imageDigest: digest, host: '127.0.0.1:3000', now: base + 60 * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, null);

  const otherImage = domain.isScreenConsentUsable(consent, {
    imageDigest: sha256OfBase64('YW5vdGhlci1pbWFnZQ=='),
    host: '127.0.0.1:3000',
    now: base + 1000,
  });
  assert.equal(otherImage.ok, false);
  assert.equal(otherImage.code, 'FRONTEND_CONSENT_SCOPE_MISMATCH');

  const otherHost = domain.isScreenConsentUsable(consent, { imageDigest: digest, host: '10.0.0.5:3000', now: base + 1000 });
  assert.equal(otherHost.ok, false);
  assert.equal(otherHost.code, 'FRONTEND_CONSENT_SCOPE_MISMATCH');

  const expired = domain.isScreenConsentUsable(consent, { imageDigest: digest, host: '127.0.0.1:3000', now: base + 16 * 60 * 1000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'FRONTEND_CONSENT_EXPIRED');

  const missing = domain.isScreenConsentUsable(null, { imageDigest: digest, host: '127.0.0.1:3000', now: base });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'FRONTEND_CONSENT_REQUIRED');

  // 已经算好的 host 不能再被当成 URL 解析（localhost:3001 会被误读成协议）。
  assert.equal(domain.normalizeHost('localhost:3001'), 'localhost:3001');
  assert.equal(domain.normalizeHost('http://127.0.0.1:3000/api/v1'), '127.0.0.1:3000');
});

// --------------------------------------------------------------------------- 2. 服务层：无确认零请求

test('B5 服务层：没有本次确认时一个 IPC 请求都不发', async () => {
  const service = await import('../src/services/frontendReconstruct/frontendReconstructService.js');
  const calls = [];
  const api = {
    isDesktop: true,
    analyzeFrontend: async (payload) => { calls.push(payload); return { ok: true, response: plannedServerResponse() }; },
    buildCandidate: async () => ({ ok: true }),
    validateCandidate: async () => ({ ok: true }),
    verifyCandidate: async () => ({ ok: true }),
    adoptCandidate: async () => ({ ok: true }),
    discardCandidate: async () => ({ ok: true }),
    cancelFrontendRun: async () => ({ ok: false, code: 'FRONTEND_NO_ACTIVE_RUN', message: '没有可取消的任务' }),
    onFrontendProgress: () => () => {},
  };
  const created = service.createFrontendReconstructService({ api });
  const { image } = service.buildFrontendAnalyzePayload({
    runId: 'frun-b5-no-consent',
    projectId: 'p_b5consent',
    image: { mediaType: 'image/png', dataBase64: IMAGE_BASE64, bytes: 11 },
    targetPages: ['home'],
  }).payload;

  const denied = await created.analyze({ runId: 'frun-b5-no-consent', projectId: 'p_b5consent', image, targetPages: ['home'] });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'FRONTEND_CONSENT_REQUIRED');
  assert.match(denied.message, /确认/);
  assert.equal(calls.length, 0, '没有确认不得发起任何请求');

  const malformed = await created.analyze({
    runId: 'frun-b5-bad-consent',
    projectId: 'p_b5consent',
    image,
    targetPages: ['home'],
    consent: { confirmedAt: 'not-a-date', imageDigest: 'sha256:zz', host: '', purpose: 'frontend-reconstruct' },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'FRONTEND_CONSENT_REQUIRED');
  assert.equal(calls.length, 0);

  const allowed = await created.analyze({
    runId: 'frun-b5-with-consent',
    projectId: 'p_b5consent',
    image,
    targetPages: ['home'],
    consent: consentFor(IMAGE_BASE64),
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].consent.host, '127.0.0.1:3000');
  assert.equal(calls[0].consent.purpose, 'frontend-reconstruct');
});

// --------------------------------------------------------------------------- 3. 主进程门禁

test('B5 主进程：缺确认 / 换图 / 换接收方 / 过期一律零请求，不建工作区', async (t) => {
  const cases = [
    ['missing', (payload) => delete payload.consent, CODES.CONSENT_REQUIRED],
    ['bad-digest', (payload) => { payload.consent = consentFor('YW5vdGhlci1pbWFnZQ=='); }, CODES.CONSENT_SCOPE_MISMATCH],
    ['other-image-same-consent', (payload) => { payload.image = { mediaType: 'image/png', dataBase64: 'YW5vdGhlci1pbWFnZQ==' }; }, CODES.CONSENT_SCOPE_MISMATCH],
    ['other-host', (payload) => { payload.consent = consentFor(IMAGE_BASE64, { host: '10.0.0.5:3000' }); }, CODES.CONSENT_SCOPE_MISMATCH],
    ['other-purpose', (payload) => { payload.consent = consentFor(IMAGE_BASE64, { purpose: 'other' }); }, CODES.CONSENT_SCOPE_MISMATCH],
    ['expired', (payload) => { payload.consent = consentFor(IMAGE_BASE64, { confirmedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }); }, CODES.CONSENT_EXPIRED],
    ['future', (payload) => { payload.consent = consentFor(IMAGE_BASE64, { confirmedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }); }, CODES.CONSENT_EXPIRED],
    ['bad-timestamp', (payload) => { payload.consent = consentFor(IMAGE_BASE64, { confirmedAt: 'yesterday' }); }, CODES.CONSENT_REQUIRED],
  ];
  for (const [label, mutate, code] of cases) {
    const { userDataDir, fetch, created } = makeIpc(t, label);
    const payload = analyzePayload();
    mutate(payload);
    const result = await created.handlers['frontend:analyze'](trustedEvent(), payload);
    assert.equal(result.ok, false, label + ' 应被拒绝');
    assert.equal(result.code, code, label);
    assert.equal(fetch.calls.length, 0, label + ' 不得发出请求');
    assert.ok(!JSON.stringify(result).includes(IMAGE_BASE64), label + ' 失败结果不得回显图片内容');
    assert.equal(fs.existsSync(path.join(userDataDir, 'projects')), false, label + ' 不应创建工作区');
  }
});

test('B5 主进程：确认通过才请求一次，consent.json 只记时间/摘要/接收方', async (t) => {
  const { userDataDir, fetch, created } = makeIpc(t, 'ok');
  const event = trustedEvent();
  const result = await created.handlers['frontend:analyze'](event, analyzePayload());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:3000/api/v1/agent/frontend-reconstruct');

  // 回执只带摘要短号与接收方，不带图片内容 / token。
  const echoed = JSON.stringify(result);
  assert.ok(!echoed.includes(IMAGE_BASE64), '返回体不得包含 base64');
  assert.ok(!echoed.includes('ds_stub'), '返回体不得包含 token');
  assert.equal(result.consent.host, '127.0.0.1:3000');
  assert.match(result.consent.imageDigestShort, /^[0-9a-f]{12}$/);
  assert.match(result.consent.recordRelative, /consent\.json$/);
  assert.ok(!path.isAbsolute(result.consent.recordRelative), '证据路径必须是相对路径');

  // 请求体本身要带图片（否则没法识别），但授权头与图片都只出现在这一层。
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.images.length, 1);
  const headerText = JSON.stringify(fetch.calls[0].init.headers || {});
  assert.ok(!headerText.includes(IMAGE_BASE64));

  const consentFile = path.join(
    userDataDir,
    'projects',
    'p_b5consent',
    'frontend-runs',
    'frun-b5-1',
    'consent.json',
  );
  assert.ok(fs.existsSync(consentFile), '确认必须留痕');
  const raw = fs.readFileSync(consentFile, 'utf8');
  assert.ok(!raw.includes(IMAGE_BASE64), 'consent.json 不得包含 base64');
  assert.ok(!raw.includes('ds_stub'), 'consent.json 不得包含 token');
  const record = JSON.parse(raw);
  assert.equal(record.schemaVersion, 'frontend-consent.v1');
  assert.equal(record.purpose, 'frontend-reconstruct');
  assert.equal(record.host, '127.0.0.1:3000');
  assert.equal(record.imageDigest, sha256OfBase64(IMAGE_BASE64));
  assert.equal(record.scope.kind, 'one-image-one-recipient');
  assert.equal(record.scope.contractVersion, 'frontend-reconstruct.v1');
  assert.equal(record.runId, 'frun-b5-1');
  assert.equal(record.projectId, 'p_b5consent');
});

test('B5 主进程：二次识别必须重新确认，不会复用上一轮的确认', async (t) => {
  const { fetch, created } = makeIpc(t, 'reuse');
  const event = trustedEvent();
  const first = await created.handlers['frontend:analyze'](event, analyzePayload({ runId: 'frun-b5-2' }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fetch.calls.length, 1);

  // 第二次调用：渲染进程若忘了重新确认（consent 缺失），主进程必须再问一次而不是放行。
  const secondPayload = analyzePayload({ runId: 'frun-b5-3' });
  delete secondPayload.consent;
  const second = await created.handlers['frontend:analyze'](event, secondPayload);
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.CONSENT_REQUIRED);
  assert.equal(fetch.calls.length, 1, '被拒绝的第二次不得发请求');
});

test('B5 参考截图面板：确认卡片跟着候选面板走，上传入口不能被包坏', async () => {
  const app = fs.readFileSync(path.join(REPO, 'src', 'App.jsx'), 'utf8');
  const panel = fs.readFileSync(path.join(REPO, 'src', 'components', 'screenRef', 'FrontendCandidatePanel.jsx'), 'utf8');
  const reference = fs.readFileSync(path.join(REPO, 'src', 'components', 'screenRef', 'ScreenReferencePanel.jsx'), 'utf8');

  // ScreenReferencePanel 用 cloneElement 把 uploadSlot 注进 frontendPanel：
  // 若 App 把它包成 <></>，上传入口会整块消失（B5 走查实际踩到过）。
  assert.match(reference, /cloneElement\(frontendPanel, \{ uploadSlot \}\)/);
  assert.match(app, /const frontendCandidatePanel = \(\s*<FrontendCandidatePanel/);
  assert.doesNotMatch(app, /const frontendCandidatePanel = \(\s*<>/);

  // 确认卡片由候选面板渲染，展示与回调都来自 App 的确认状态。
  assert.match(panel, /import ScreenSendConsent from '\.\/ScreenSendConsent\.jsx'/);
  assert.match(panel, /<ScreenSendConsent notice=\{consentNotice\}/);
  assert.match(app, /consentNotice=\{screenConsentPrompt \? screenConsentPrompt\.notice : null\}/);
  assert.match(app, /onConsentConfirm=\{handleScreenSendConfirm\}/);
  assert.match(app, /onConsentCancel=\{handleScreenSendCancel\}/);
});

// --------------------------------------------------------------------------- 4. 模板卡：预览 vs 采用

test('B5 模板卡：点卡片只预览，「就用这套」才换当前使用', async () => {
  const source = fs.readFileSync(path.join(REPO, 'src', 'components', 'flow', 'TemplateGallery.jsx'), 'utf8');
  // 点击卡片只改预览态，不再直接改变当前使用。
  assert.match(source, /const \[previewId, setPreviewId\] = useState\(null\)/);
  assert.match(source, /onClick=\{\(\) => setPreviewId\(item\.id\)\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => onSelect\(item\.id\)\}/, '点卡片不得直接采用');
  // 采用是显式动作。
  assert.match(source, /就用这套/);
  assert.match(source, /onSelect\?\.\(selected\.id\)/);
  assert.match(source, /setPreviewId\(null\)/);
  // 文案要说清「预览不等于已采用」。
  assert.match(source, /点卡片只是预览/);
  assert.match(source, /这只是预览，当前使用仍是/);
  assert.match(source, /预览中（还没换掉当前版本）/);
  // 满意度打分只对「当前版本」有意义，预览态下不要误当成评价当前版本。
  assert.match(source, /disabled=\{!selectedId \|\| refining \|\| isPreviewing\}/);
  const app = fs.readFileSync(path.join(REPO, 'src', 'App.jsx'), 'utf8');
  assert.match(app, /onSelect=\{\(id\) => dispatch\(\{ type: 'SELECT_TEMPLATE', id \}\)\}/, '采用仍走 SELECT_TEMPLATE');
});

// --------------------------------------------------------------------------- 5. 微信验证脚本

test('B5 微信脚本：cli 调用走 shell:false + 参数数组，证据里不再写整条本机路径', () => {
  const runner = require(path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'));
  const source = fs.readFileSync(path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'), 'utf8');
  assert.doesNotMatch(source, /shell:\s*true/, '不得再用 shell:true');

  const batPath = 'C:\\Program Files\\Tencent\\devtools\\cli.bat';
  const invocation = runner.buildCliInvocation(batPath, ['open', '--project', 'C:\\tmp\\out dir']);
  if (process.platform === 'win32') {
    // .bat 只能由 cmd 解释执行：显式起 cmd，参数仍以数组传入并逐个加引号。
    assert.match(invocation.file, /cmd\.exe$/i);
    assert.deepStrictEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(invocation.args.length, 4);
    assert.equal(invocation.verbatim, true);
    assert.ok(invocation.args[3].includes('"C:\\Program Files\\Tencent\\devtools\\cli.bat"'));
    assert.ok(invocation.args[3].includes('"--project"'));
    assert.ok(invocation.args[3].startsWith('""'), 'cmd /s 需要外层引号才能正确剥壳');
  } else {
    assert.equal(invocation.file, batPath);
    assert.deepStrictEqual(invocation.args, ['open', '--project', 'C:\\tmp\\out dir']);
  }

  const exe = runner.buildCliInvocation('C:\\tools\\cli.exe', ['islogin']);
  assert.equal(exe.file, 'C:\\tools\\cli.exe');
  assert.deepStrictEqual(exe.args, ['islogin']);
  assert.equal(exe.verbatim, false);

  // 引号/换行一律拒绝，避免 cmd 重新解析出第二条命令。
  assert.throws(() => runner.buildCliInvocation(batPath, ['open', 'a"b']), /引号/);
  assert.throws(() => runner.buildCliInvocation(batPath, ['open', 'a\nb']), /引号|换行/);

  // 证据：只留可核对的尾部，不泄露整条本机路径。
  const masked = runner.maskLocalPath('C:\\Users\\someone\\AppData\\Local\\Temp\\out');
  assert.ok(!/[A-Za-z]:/.test(masked), '脱敏后不应再有盘符');
  assert.match(masked, /out$/);
  const command = runner.displayCommand(batPath, ['open', '--project', 'C:\\tmp\\out']);
  assert.ok(!command.includes('C:\\Program Files'), '命令展示不写完整安装路径');
  assert.equal(command.split(' ')[0], 'cli.bat');
  assert.match(command, /…/);
});

// --------------------------------------------------------------------------- 6. CSP 与既有入口

test('B5 CSP：只在新页面构建产物里注入，且不放宽脚本与远程连接', async () => {
  const plugin = await import('../scripts/vite-csp-plugin.mjs');
  const policy = plugin.CSP_POLICY;
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /connect-src[^;]*127\.0\.0\.1/);
  assert.doesNotMatch(policy, /connect-src[^;]*\*[^;]*$/, 'connect-src 不能是通配');
  assert.doesNotMatch(policy, /https:\/\/(?!127)/, '不允许任意公网源');

  const instance = plugin.injectCspMeta();
  assert.equal(instance.apply, 'build', '开发态（HMR 内联脚本）不注入 CSP');
  const html = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>';
  const injected = instance.transformIndexHtml(html);
  assert.equal((injected.match(/Content-Security-Policy/g) || []).length, 1);
  assert.ok(injected.includes('script-src'), '注入内容必须是完整策略');
  assert.equal(instance.transformIndexHtml(injected), injected, '重复注入不应叠加');

  // 既有 Electron 入口不放宽：上下文隔离、沙箱、外链白名单都保持原样。
  const main = fs.readFileSync(path.join(REPO, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /openExternalLink\(url, \{ shell \}\)/);
});
