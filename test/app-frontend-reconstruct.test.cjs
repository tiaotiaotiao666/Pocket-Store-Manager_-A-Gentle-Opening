'use strict';

/**
 * P4：候选前端状态机 / 视图模型 / 服务层与 App 接线的定向测试。
 *
 * 只读源码 + 纯函数调用，不渲染 React、不联网、不启动 Electron。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const APP_PATH = path.join(REPO, 'src', 'App.jsx');
const PANEL_PATH = path.join(REPO, 'src', 'components', 'screenRef', 'FrontendCandidatePanel.jsx');
const COMPAT_PANEL_PATH = path.join(REPO, 'src', 'components', 'screenRef', 'ScreenReferencePanel.jsx');
const SMOKE_PATH = path.join(REPO, 'scripts', 'agent-smoke.cjs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

async function loadDomain() {
  return import('../src/domain/frontendReconstruct.mjs');
}

function referenceImage(overrides) {
  return {
    name: 'shot.png',
    mediaType: 'image/png',
    // 合法 base64（"PNG" 的近似字节），体积远小于 400KB。
    dataBase64: 'aGVsbG8td29ybGQ=',
    bytes: 14,
    previewUrl: 'data:image/png;base64,aGVsbG8td29ybGQ=',
    ...(overrides || {}),
  };
}

function plannedResponse(overrides) {
  return {
    contractVersion: 'frontend-reconstruct.v1',
    runId: 'frun-server-1',
    status: 'planned',
    requirement: {
      summary: '首页更紧凑，保留下单入口',
      mustKeep: [{ kind: 'action', ref: 'home.goMenu' }],
      pages: [{
        pageId: 'home',
        order: 0,
        layout: 'single-column',
        targetSize: { width: 375, height: 812 },
        regions: [
          { id: 'hdr', type: 'header', order: 0, children: [], confidence: 0.92 },
          { id: 'hero', type: 'hero', order: 1, children: [{ id: 'hero-cta', type: 'card', order: 0, children: [], confidence: 0.8 }], confidence: 0.88 },
        ],
      }],
      visual: { theme: { primaryColor: '#112233' }, sizes: { homeHero: 'lg' }, density: 'compact' },
      bindings: [],
      unsupported: [{ label: '地图选座', reason: '没有对应组件' }],
      degradations: [{ label: '圆角', reason: '只能近似' }],
      unknownRegions: [{ label: '右下角浮层', reason: '看不出来是什么' }],
      lowConfidence: [{ regionId: 'hero', confidence: 0.4, reason: '截图很模糊' }],
      inferredInteractions: [{ regionId: 'hero', label: '点击跳转', reason: '常见做法' }],
    },
    coverage: {
      status: 'covered',
      requiredCapabilities: ['page:home', 'action:home.goMenu'],
      missingCapabilities: [],
      coveredBy: { 'page:home': 'ordering-base' },
      risks: [],
      degradations: [],
    },
    draft: {
      schemaVersion: 'frontend-pack-draft.v1',
      displayName: '参考图首页候选',
      pages: [{ pageId: 'home', nodes: [{ type: 'slot', slotId: 'home-hero' }], styles: [], pageJson: {} }],
    },
    questions: [],
    trace: { modelCalls: 2, toolCalls: [{ name: 'get_frontend_capabilities', ok: true }], stopReason: 'final_answer', degraded: false },
    meta: { provider: 'deepseek', model: 'deepseek-chat', mock: false, latencyMs: 1234 },
    ...(overrides || {}),
  };
}

function buildResult(overrides) {
  return {
    ok: true,
    staticPass: true,
    code: 'FRONTEND_CANDIDATE_READY',
    message: '候选已生成并通过静态门禁',
    candidate: {
      candidateId: 'cand-home-1',
      candidateVersion: '1.0.0',
      attempt: 1,
      status: 'committed',
      pages: ['home'],
      files: 14,
      digest: 'sha256:' + 'b'.repeat(64),
      degradations: [{ label: '圆角', reason: '只能近似' }],
    },
    verification: {
      static: {
        ok: true,
        code: null,
        summary: 'dry-run 通过；mini:check=通过；consistency=通过',
        checks: [
          { id: 'mini-check', status: 'pass', message: '小程序静态校验通过' },
          { id: 'consistency', status: 'pass', message: '产物与 Lock/报告一致' },
        ],
        issues: [],
      },
      repairs: 0,
      repairStatus: 'not_needed',
    },
    artifacts: {
      attemptRelative: 'projects/p_abc/frontend-runs/frun-1/attempts/attempt-1',
      outputRelative: 'verification/dry-run-1/candidate',
    },
    ...(overrides || {}),
  };
}

function verifyResult(overrides) {
  return {
    ok: true,
    status: 'PASS',
    code: 'PASS',
    message: '微信真实编译与关键页面验证通过',
    summary: '微信运行时 PASS：页面 2/2 通过，交互 1/1 通过，截图 2 张',
    screenshots: [
      { name: 'home-1.png', bytes: 2048 },
      { name: 'menu-1.png', bytes: 1820 },
    ],
    pages: [{ route: 'pages/home/index', label: '首页', status: 'PASS' }],
    interactions: [{ label: '开始点餐', status: 'PASS', detail: '进入 pages/menu/index' }],
    ...(overrides || {}),
  };
}

/** 采用/放弃/复核/取消动作的完整身份（t10-F1：reducer 会严格校验）。 */
function identityOf(state) {
  const candidate = state.candidate;
  return {
    runId: state.runId,
    revision: state.revision,
    ...(candidate
      ? { candidateId: candidate.candidateId, attempt: candidate.attempt }
      : {}),
  };
}

async function stateAfterPlanning(domain, runId = 'frun-test-plan') {
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', utterance: '按截图重构首页' });
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  state = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_SUCCESS',
    runId,
    revision: state.revision,
    response: plannedResponse(),
  });
  return { state, runId };
}

async function stateAfterBuild(domain, options = {}) {
  const { frontendReducer } = domain;
  const planned = await stateAfterPlanning(domain, options.runId || 'frun-test-plan');
  let state = frontendReducer(planned.state, { type: 'FRONTEND_BUILD_REQUEST' });
  state = frontendReducer(state, {
    type: 'FRONTEND_BUILD_SUCCESS',
    runId: planned.runId,
    revision: state.revision,
    result: buildResult(options.buildOverrides),
  });
  return { state, runId: planned.runId };
}

test('P4 初始状态：没有截图时不能分析，视图模型给出可读文案', async () => {
  const domain = await loadDomain();
  const state = domain.createInitialFrontendReconstructState();
  const view = domain.buildFrontendReconstructView(state);
  assert.equal(state.status, domain.FRONTEND_STATUS.IDLE);
  assert.equal(view.canAnalyze, false);
  assert.equal(view.canBuild, false);
  assert.equal(view.canAdopt, false);
  assert.match(view.body, /上传一张参考截图/);
  assert.equal(view.request.targetPageOptions.length, 2);
  assert.equal(view.request.targetPageOptions[0].checked, true);
});

test('P4 旧响应整包丢弃：途中改输入后迟到结果不改任何字段', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
  const runId = 'frun-stale-1';
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  const requestRevision = state.revision;
  assert.equal(state.status, domain.FRONTEND_STATUS.ANALYZING);

  // 用户改了要求：revision 前进，这轮请求作废。
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', utterance: '换一个更紧凑的布局' });
  assert.ok(state.revision > requestRevision);
  assert.equal(state.status, domain.FRONTEND_STATUS.IDLE);

  const stale = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_SUCCESS',
    runId,
    revision: requestRevision,
    response: plannedResponse(),
  });
  assert.equal(stale, state, '旧响应必须原样返回同一个 state 对象');
  const staleFailure = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_FAILURE',
    runId,
    revision: requestRevision,
    error: { code: 'FRONTEND_ANALYZE_FAILED', message: '迟到的失败' },
  });
  assert.equal(staleFailure, state);
});

test('P4 重复点击：分析中再来一次 REQUEST 是 no-op，构建中也拒绝第二次', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
  const runId = 'frun-dup-1';
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  const duplicate = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId: 'frun-dup-2', revision: state.revision });
  assert.equal(duplicate, state);
  const buildWhileAnalyzing = frontendReducer(state, { type: 'FRONTEND_BUILD_REQUEST' });
  assert.equal(buildWhileAnalyzing, state);
});

test('P4 取消：状态 terminated、输入保留、迟到的成功响应被丢弃', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage(), utterance: '保留这句话' });
  const runId = 'frun-cancel-1';
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  const cancelIdentity = identityOf(state);
  state = frontendReducer(state, { type: 'FRONTEND_CANCEL_REQUEST', ...cancelIdentity });
  assert.equal(state.cancelRequested, true);
  state = frontendReducer(state, { type: 'FRONTEND_CANCELLED', ...cancelIdentity });
  assert.equal(state.status, domain.FRONTEND_STATUS.CANCELLED);
  assert.equal(state.request.utterance, '保留这句话');
  assert.ok(state.request.image);
  const late = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_SUCCESS',
    runId,
    revision: state.revision,
    response: plannedResponse(),
  });
  assert.equal(late, state);
});

test('P4 失败保留输入且不产生候选：清空输入只能是用户主动行为', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage(), utterance: '别把我清掉' });
  const runId = 'frun-fail-1';
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  state = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_FAILURE',
    runId,
    revision: state.revision,
    error: { code: 'FRONTEND_ANALYZE_FAILED', message: '后端没起来' },
  });
  assert.equal(state.status, domain.FRONTEND_STATUS.FAILED);
  assert.equal(state.candidate, null);
  assert.equal(state.request.utterance, '别把我清掉');
  assert.ok(state.request.image);
  assert.equal(state.error.code, 'FRONTEND_ANALYZE_FAILED');
  const view = domain.buildFrontendReconstructView(state);
  assert.equal(view.canRetry, true);
  assert.match(view.error.message, /后端没起来/);
});

test('P4 切页/改目标页：分析结果与候选作废，但输入保留', async () => {
  const domain = await loadDomain();
  const planned = await stateAfterPlanning(domain);
  let state = planned.state;
  assert.equal(state.status, domain.FRONTEND_STATUS.PLANNING);
  const before = state.revision;
  state = domain.frontendReducer(state, { type: 'FRONTEND_INPUT_SET', targetPages: ['home', 'menu'] });
  assert.equal(state.status, domain.FRONTEND_STATUS.IDLE);
  assert.equal(state.analysis, null);
  assert.equal(state.candidate, null);
  assert.ok(state.revision > before);
  assert.deepEqual(state.request.targetPages, ['home', 'menu']);
  assert.equal(state.request.utterance, '按截图重构首页');
  assert.ok(state.request.image);
});

test('P4 只允许在目标页范围内选择；非法页被过滤或回落首页', async () => {
  const domain = await loadDomain();
  let state = domain.createInitialFrontendReconstructState();
  state = domain.frontendReducer(state, { type: 'FRONTEND_INPUT_SET', targetPages: ['settings', 'menu'] });
  assert.deepEqual(state.request.targetPages, ['menu']);
  // 全部非法时不留下「零目标页」，回落首页而不是接受未知页面。
  state = domain.frontendReducer(state, { type: 'FRONTEND_INPUT_SET', targetPages: ['settings'] });
  assert.deepEqual(state.request.targetPages, ['home']);
});

test('P4 计划结果：分区/近似/不支持/能力报告/问题都进入视图模型', async () => {
  const domain = await loadDomain();
  const planned = await stateAfterPlanning(domain);
  const view = domain.buildFrontendReconstructView(planned.state);
  assert.equal(view.status, domain.FRONTEND_STATUS.PLANNING);
  assert.equal(view.analysis.sectionCount, 2, '两个顶层分区（子分区在 children 里）');
  assert.equal(view.analysis.pages[0].layoutLabel, '单列');
  assert.equal(view.analysis.approximate.length, 1);
  assert.equal(view.analysis.unsupported.length, 1);
  assert.equal(view.analysis.unknownRegions.length, 1);
  assert.equal(view.analysis.lowConfidence.length, 1);
  assert.equal(view.analysis.inferredInteractions.length, 1);
  assert.equal(view.analysis.coverage.statusLabel, '能力已覆盖');
  assert.equal(view.analysis.style.densityLabel, '紧凑');
  assert.equal(view.analysis.hasDraft, true);
  assert.equal(view.canBuild, true);
  assert.equal(view.canAdopt, false);
  assert.equal(view.request.image.name, 'shot.png');
});

test('P4 静态门禁通过但未跑微信：status=partial，必须单独确认才能采用', async () => {
  const domain = await loadDomain();
  const built = await stateAfterBuild(domain);
  const state = built.state;
  assert.equal(state.status, domain.FRONTEND_STATUS.PARTIAL);
  assert.equal(state.candidate.candidateId, 'cand-home-1');
  assert.equal(state.staticVerification.ok, true);
  assert.equal(state.runtimeVerification, null);

  const view = domain.buildFrontendReconstructView(state);
  assert.equal(view.canAdopt, true);
  assert.equal(view.adoptNeedsPartialConfirm, true);
  assert.match(view.partialNote, /微信验证未完成/);
  assert.equal(view.verification.requiresPartialConfirmation, true);
  assert.equal(view.verification.repairs, 0);
  assert.match(view.verification.repairNote, /自动修复 0 轮/);

  const identity = identityOf(state);
  const rejected = domain.frontendReducer(state, { type: 'FRONTEND_ADOPT_REQUEST', ...identity, partialConfirmed: false });
  assert.equal(rejected.status, domain.FRONTEND_STATUS.PARTIAL, '未确认时必须停住');
  assert.equal(rejected.error.code, 'FRONTEND_PARTIAL_CONFIRM_REQUIRED');

  let adopting = domain.frontendReducer(state, { type: 'FRONTEND_ADOPT_REQUEST', ...identity, partialConfirmed: true });
  assert.equal(adopting.status, domain.FRONTEND_STATUS.VALIDATING);
  adopting = domain.frontendReducer(adopting, {
    type: 'FRONTEND_ADOPT_SUCCESS',
    ...identity,
    adoption: { candidateId: 'cand-home-1', attempt: 1, runtimeStatus: 'NOT_RUN', partialConfirmed: true, adoptedAt: '2026-11-17T00:00:00.000Z' },
  });
  assert.equal(adopting.status, domain.FRONTEND_STATUS.ADOPTED);
  assert.equal(adopting.adoption.partialConfirmed, true);
  const adoptedView = domain.buildFrontendReconstructView(adopting);
  assert.equal(adoptedView.canAdopt, false);
  assert.match(adoptedView.body, /当前版本已切换/);
});

test('P4 微信验证 PASS 才进入 ready；BLOCKED 仍然只能 partial', async () => {
  const domain = await loadDomain();
  const built = await stateAfterBuild(domain);
  let state = domain.frontendReducer(built.state, { type: 'FRONTEND_VERIFY_REQUEST' });
  assert.equal(state.status, domain.FRONTEND_STATUS.VERIFYING);
  state = domain.frontendReducer(state, {
    type: 'FRONTEND_VERIFY_SUCCESS',
    runId: built.runId,
    revision: state.revision,
    result: verifyResult(),
  });
  assert.equal(state.status, domain.FRONTEND_STATUS.READY);
  let view = domain.buildFrontendReconstructView(state);
  assert.equal(view.verification.runtimePass, true);
  assert.equal(view.adoptNeedsPartialConfirm, false);
  assert.equal(view.verification.runtime.screenshots.length, 2);

  let blocked = domain.frontendReducer(built.state, { type: 'FRONTEND_VERIFY_REQUEST' });
  blocked = domain.frontendReducer(blocked, {
    type: 'FRONTEND_VERIFY_SUCCESS',
    runId: built.runId,
    revision: blocked.revision,
    result: verifyResult({ status: 'BLOCKED', code: 'CLI_MISSING', message: '微信开发者工具不可用', screenshots: [] }),
  });
  assert.equal(blocked.status, domain.FRONTEND_STATUS.PARTIAL);
  view = domain.buildFrontendReconstructView(blocked);
  assert.equal(view.verification.runtimePass, false);
  assert.equal(view.verification.runtime.statusLabel, '微信验证未完成（工具/证据不可用）');
  assert.equal(view.adoptNeedsPartialConfirm, true);
  assert.equal(view.canAdopt, true, 'partial 仍可查看/确认采用，但不是自动通过');
});

test('P4 静态门禁失败：候选可放弃但绝不允许采用', async () => {
  const domain = await loadDomain();
  const planned = await stateAfterPlanning(domain);
  let state = domain.frontendReducer(planned.state, { type: 'FRONTEND_BUILD_REQUEST' });
  const failed = buildResult({
    ok: true,
    staticPass: false,
    code: 'SLOT_ANCHOR_MISSING',
    message: '静态门禁未通过：slot 锚点缺失',
    verification: {
      static: {
        ok: false,
        code: 'SLOT_ANCHOR_MISSING',
        summary: '可观察项对照未通过',
        checks: [{ id: 'observable', status: 'fail', message: '缺少 slot fallback 锚点' }],
        issues: [{ code: 'SLOT_ANCHOR_MISSING', path: '$.pages[0].nodes[0].slotId', message: '缺少锚点' }],
      },
      repairs: 2,
      repairStatus: 'exhausted',
    },
  });
  state = domain.frontendReducer(state, {
    type: 'FRONTEND_BUILD_SUCCESS',
    runId: planned.runId,
    revision: state.revision,
    result: failed,
  });
  assert.equal(state.status, domain.FRONTEND_STATUS.FAILED);
  const view = domain.buildFrontendReconstructView(state);
  assert.equal(view.canAdopt, false);
  assert.equal(view.canDiscard, true);
  assert.equal(view.error.code, 'SLOT_ANCHOR_MISSING');
  assert.match(view.adoptBlockedReason, /静态门禁未通过/);
  assert.equal(view.verification.repairs, 2);
  assert.match(view.verification.repairNote, /自动修复 2 轮/);
  assert.equal(view.error.issues[0].path, '$.pages[0].nodes[0].slotId');
});

test('P4 rejected / needs-input 响应：不产生草稿，不显示可构建', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  for (const [status, expectedState] of [['rejected', domain.FRONTEND_STATUS.REJECTED], ['needs-input', domain.FRONTEND_STATUS.NEEDS_INPUT]]) {
    let state = createInitialFrontendReconstructState();
    state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
    const runId = 'frun-' + status;
    state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
    state = frontendReducer(state, {
      type: 'FRONTEND_ANALYZE_SUCCESS',
      runId,
      revision: state.revision,
      response: plannedResponse({
        status,
        draft: null,
        coverage: { status: 'rejected', requiredCapabilities: ['page:menu'], missingCapabilities: ['page:menu'], coveredBy: {}, risks: [], degradations: [] },
        questions: status === 'needs-input' ? [{ field: 'hero', label: '首屏', text: '首屏想放什么？' }] : [],
      }),
    });
    assert.equal(state.status, expectedState);
    assert.equal(state.candidate, null);
    const view = domain.buildFrontendReconstructView(state);
    assert.equal(view.canBuild, false);
    assert.equal(view.canAdopt, false);
    if (status === 'needs-input') assert.equal(view.analysis.questions.length, 1);
    if (status === 'rejected') assert.equal(view.analysis.coverage.missingCount, 1);
  }
});

test('P4 服务端响应契约/草稿异常时明确报错，不进入 planning', async () => {
  const domain = await loadDomain();
  const { frontendReducer, createInitialFrontendReconstructState } = domain;
  const base = {
    contractVersion: 'frontend-reconstruct.v1',
    runId: 'frun-x',
    status: 'planned',
    requirement: plannedResponse().requirement,
    coverage: plannedResponse().coverage,
    draft: null,
    questions: [],
    trace: plannedResponse().trace,
    meta: plannedResponse().meta,
  };
  const parsed = domain.parseFrontendAnalyzeResponse(base);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'FRONTEND_DRAFT_MISSING');
  assert.equal(domain.parseFrontendAnalyzeResponse({ ...base, contractVersion: 'v2' }).code, 'FRONTEND_CONTRACT_MISMATCH');

  let state = createInitialFrontendReconstructState();
  state = frontendReducer(state, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
  const runId = 'frun-mismatch';
  state = frontendReducer(state, { type: 'FRONTEND_ANALYZE_REQUEST', runId, revision: state.revision });
  state = frontendReducer(state, {
    type: 'FRONTEND_ANALYZE_SUCCESS',
    runId,
    revision: state.revision,
    response: { ...base, contractVersion: 'v9' },
  });
  assert.equal(state.status, domain.FRONTEND_STATUS.FAILED);
  assert.equal(state.error.code, 'FRONTEND_CONTRACT_MISMATCH');
  assert.ok(state.request.image);
});

test('P4 t10-F1：迟到 ADOPT_SUCCESS 不能把旧候选的 adopted 套到新候选', async () => {
  const domain = await loadDomain();
  const a = await stateAfterBuild(domain, { runId: 'frun-adopt-a' });
  const idA = identityOf(a.state);
  const adoptingA = domain.frontendReducer(a.state, { type: 'FRONTEND_ADOPT_REQUEST', ...idA, partialConfirmed: true });
  assert.equal(adoptingA.status, domain.FRONTEND_STATUS.VALIDATING);
  assert.equal(adoptingA.pendingOp, 'adopt');

  const b = await stateAfterBuild(domain, {
    runId: 'frun-adopt-b',
    buildOverrides: { candidate: { ...buildResult().candidate, candidateId: 'cand-home-2' } },
  });
  assert.notEqual(b.state.candidate.candidateId, a.state.candidate.candidateId);

  const lateSuccess = domain.frontendReducer(b.state, {
    type: 'FRONTEND_ADOPT_SUCCESS',
    ...idA,
    adoption: { candidateId: 'cand-home-1', attempt: 1, runtimeStatus: 'NOT_RUN', partialConfirmed: true },
  });
  assert.equal(lateSuccess, b.state, '旧候选/旧 run 的采用成功回包必须整包丢弃');
  assert.equal(lateSuccess.candidate.candidateId, 'cand-home-2');
  assert.equal(lateSuccess.adoption, null);
  assert.equal(lateSuccess.status, domain.FRONTEND_STATUS.PARTIAL);

  const lateFailure = domain.frontendReducer(b.state, {
    type: 'FRONTEND_ADOPT_FAILURE',
    ...idA,
    error: { code: 'FRONTEND_ADOPT_FAILED', message: '迟到的失败' },
  });
  assert.equal(lateFailure, b.state, '旧候选的采用失败回包同样丢弃');

  const adopted = domain.frontendReducer(adoptingA, {
    type: 'FRONTEND_ADOPT_SUCCESS',
    ...idA,
    adoption: { candidateId: 'cand-home-1', attempt: 1, runtimeStatus: 'NOT_RUN', partialConfirmed: true },
  });
  assert.equal(adopted.status, domain.FRONTEND_STATUS.ADOPTED, '同一个候选/run/revision 的回包仍然生效');
  assert.equal(adopted.pendingOp, null);
});

test('P4 t10-F1：迟到 DISCARD_SUCCESS 不能清掉新候选；pendingOp 阻止 VALIDATING 串台', async () => {
  const domain = await loadDomain();
  const a = await stateAfterBuild(domain, { runId: 'frun-discard-a' });
  const idA = identityOf(a.state);

  const discardingA = domain.frontendReducer(a.state, { type: 'FRONTEND_DISCARD_REQUEST', ...idA });
  assert.equal(discardingA.status, domain.FRONTEND_STATUS.VALIDATING);
  assert.equal(discardingA.pendingOp, 'discard');

  // 同一候选、但 VALIDATING 来自 adopt：DISCARD_SUCCESS 不能把采用流程的候选清掉。
  const adoptingA = domain.frontendReducer(a.state, { type: 'FRONTEND_ADOPT_REQUEST', ...idA, partialConfirmed: true });
  const crossed = domain.frontendReducer(adoptingA, { type: 'FRONTEND_DISCARD_SUCCESS', ...idA });
  assert.equal(crossed, adoptingA, 'pendingOp 不匹配的终态必须忽略');

  const b = await stateAfterBuild(domain, {
    runId: 'frun-discard-b',
    buildOverrides: { candidate: { ...buildResult().candidate, candidateId: 'cand-home-2' } },
  });
  const late = domain.frontendReducer(b.state, { type: 'FRONTEND_DISCARD_SUCCESS', ...idA });
  assert.equal(late, b.state, '旧 run 的放弃成功回包必须丢弃');
  assert.equal(late.candidate.candidateId, 'cand-home-2');
  const lateFailure = domain.frontendReducer(b.state, {
    type: 'FRONTEND_DISCARD_FAILURE',
    ...idA,
    error: { code: 'FRONTEND_DISCARD_FAILED', message: '迟到的失败' },
  });
  assert.equal(lateFailure, b.state);

  const discarded = domain.frontendReducer(discardingA, { type: 'FRONTEND_DISCARD_SUCCESS', ...idA });
  assert.equal(discarded.status, domain.FRONTEND_STATUS.IDLE);
  assert.equal(discarded.candidate, null);
});

test('P4 t10-F1：VALIDATE 需身份+pendingOp；迟到回包丢弃、正常链路生效', async () => {
  const domain = await loadDomain();
  const a = await stateAfterBuild(domain, { runId: 'frun-validate' });
  const idA = identityOf(a.state);

  assert.equal(domain.frontendReducer(a.state, { type: 'FRONTEND_VALIDATE_REQUEST' }), a.state, '缺身份必须 no-op');
  assert.equal(
    domain.frontendReducer(a.state, { type: 'FRONTEND_VALIDATE_REQUEST', ...idA, revision: idA.revision - 1 }),
    a.state,
    '旧 revision 必须 no-op',
  );
  assert.equal(
    domain.frontendReducer(a.state, { type: 'FRONTEND_VALIDATE_REQUEST', ...idA, candidateId: 'cand-old' }),
    a.state,
    '旧候选必须 no-op',
  );

  const validating = domain.frontendReducer(a.state, { type: 'FRONTEND_VALIDATE_REQUEST', ...idA });
  assert.equal(validating.status, domain.FRONTEND_STATUS.VALIDATING);
  assert.equal(validating.pendingOp, 'validate');

  const stale = domain.frontendReducer(validating, {
    type: 'FRONTEND_VALIDATE_SUCCESS',
    ...idA,
    candidateId: 'cand-old',
    result: buildResult(),
  });
  assert.equal(stale, validating, '旧候选的复核回包必须丢弃');
  const staleFailure = domain.frontendReducer(validating, {
    type: 'FRONTEND_VALIDATE_FAILURE',
    ...idA,
    revision: idA.revision + 1,
    error: { code: 'FRONTEND_VERIFICATION_MISSING', message: '迟到失败' },
  });
  assert.equal(staleFailure, validating);

  const validated = domain.frontendReducer(validating, { type: 'FRONTEND_VALIDATE_SUCCESS', ...idA, result: buildResult() });
  assert.equal(validated.status, domain.FRONTEND_STATUS.PARTIAL);
  assert.equal(validated.pendingOp, null);
  assert.equal(validated.staticVerification.ok, true);

  let failing = domain.frontendReducer(a.state, { type: 'FRONTEND_VALIDATE_REQUEST', ...idA });
  failing = domain.frontendReducer(failing, {
    type: 'FRONTEND_VALIDATE_FAILURE',
    ...idA,
    error: { code: 'FRONTEND_VERIFICATION_MISSING', message: '没有证据' },
  });
  assert.equal(failing.status, domain.FRONTEND_STATUS.PARTIAL);
  assert.equal(failing.error.code, 'FRONTEND_VERIFICATION_MISSING');
  assert.equal(failing.pendingOp, null);
  assert.equal(failing.candidate.candidateId, a.state.candidate.candidateId);
});

test('P4 t10-F1：CANCELLED 在 runId 为空或身份过期时整包忽略', async () => {
  const domain = await loadDomain();
  let fresh = domain.createInitialFrontendReconstructState();
  fresh = domain.frontendReducer(fresh, { type: 'FRONTEND_INPUT_SET', image: referenceImage() });
  assert.equal(
    domain.frontendReducer(fresh, { type: 'FRONTEND_CANCELLED', runId: 'frun-ghost', revision: fresh.revision }),
    fresh,
    'current.runId 为空时旧 CANCELLED 必须忽略',
  );

  const analyzing = domain.frontendReducer(fresh, {
    type: 'FRONTEND_ANALYZE_REQUEST',
    runId: 'frun-live',
    revision: fresh.revision,
  });
  const live = identityOf(analyzing);
  assert.equal(domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCELLED', runId: 'frun-old', revision: live.revision }), analyzing);
  assert.equal(domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCELLED', runId: live.runId, revision: live.revision + 1 }), analyzing);
  assert.equal(domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCELLED', runId: live.runId }), analyzing, '缺 revision 也必须忽略');

  const requested = domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCEL_REQUEST', ...live });
  assert.equal(requested.cancelRequested, true);
  assert.equal(domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCEL_REQUEST' }), analyzing, 'CANCEL_REQUEST 缺身份不生效');

  const cancelled = domain.frontendReducer(analyzing, { type: 'FRONTEND_CANCELLED', ...live });
  assert.equal(cancelled.status, domain.FRONTEND_STATUS.CANCELLED);
  assert.ok(cancelled.request.image, '取消仍然保留输入');
});

test('P4 t10-F1：ADOPT/DISCARD_REQUEST 缺身份或旧身份不进入 VALIDATING', async () => {
  const domain = await loadDomain();
  const built = await stateAfterBuild(domain, { runId: 'frun-request-guard' });
  const id = identityOf(built.state);
  for (const type of ['FRONTEND_ADOPT_REQUEST', 'FRONTEND_DISCARD_REQUEST']) {
    assert.equal(domain.frontendReducer(built.state, { type, partialConfirmed: true }), built.state, type + ' 缺身份必须 no-op');
    assert.equal(
      domain.frontendReducer(built.state, { type, ...id, revision: id.revision - 1, partialConfirmed: true }),
      built.state,
      type + ' 旧 revision 必须 no-op',
    );
    assert.equal(
      domain.frontendReducer(built.state, { type, ...id, candidateId: 'cand-other', partialConfirmed: true }),
      built.state,
      type + ' 旧 candidate 必须 no-op',
    );
  }
  assert.equal(domain.frontendReducer(built.state, { type: 'FRONTEND_ADOPT_REQUEST', ...id, partialConfirmed: true }).status, domain.FRONTEND_STATUS.VALIDATING);
  assert.equal(domain.frontendReducer(built.state, { type: 'FRONTEND_DISCARD_REQUEST', ...id }).status, domain.FRONTEND_STATUS.VALIDATING);
  assert.equal(domain.buildFrontendReconstructView(built.state).canValidate, true);
});

test('P4 放弃候选与重置：只清候选，不覆盖当前版本也不清输入', async () => {
  const domain = await loadDomain();
  const built = await stateAfterBuild(domain);
  const identity = identityOf(built.state);
  let state = domain.frontendReducer(built.state, { type: 'FRONTEND_DISCARD_REQUEST', ...identity });
  assert.equal(state.status, domain.FRONTEND_STATUS.VALIDATING);
  state = domain.frontendReducer(state, { type: 'FRONTEND_DISCARD_SUCCESS', ...identity });
  assert.equal(state.status, domain.FRONTEND_STATUS.IDLE);
  assert.equal(state.candidate, null);
  assert.equal(state.request.utterance, '按截图重构首页');
  assert.ok(state.discardedAt);

  const reset = domain.frontendReducer(built.state, { type: 'FRONTEND_RESET', keepImage: true });
  assert.equal(reset.status, domain.FRONTEND_STATUS.IDLE);
  assert.equal(reset.candidate, null);
  assert.ok(reset.request.image, '重置默认保留截图，避免用户重选');
  const hardReset = domain.frontendReducer(built.state, { type: 'FRONTEND_RESET', keepImage: false });
  assert.equal(hardReset.request.image, null);
  assert.equal(hardReset.request.utterance, '');
});

test('P4 输入校验复用旧参考截图口径：类型/体积/空图都给出可读错误', async () => {
  const domain = await loadDomain();
  assert.equal(domain.normalizeFrontendImage({ mediaType: 'image/gif', dataBase64: 'aa' }).ok, false);
  assert.equal(domain.normalizeFrontendImage({ mediaType: 'image/png', dataBase64: '' }).ok, false);
  const tooLarge = domain.normalizeFrontendImage({
    mediaType: 'image/png',
    dataBase64: 'A'.repeat(560000),
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'SCREEN_REF_IMAGE_TOO_LARGE');
  const ok = domain.normalizeFrontendImage(referenceImage());
  assert.equal(ok.ok, true);
  assert.equal(ok.image.mediaType, 'image/png');
  const requestCheck = domain.validateFrontendRequest({ utterance: '', image: null });
  assert.equal(requestCheck.ok, false);
  assert.equal(requestCheck.code, 'FRONTEND_IMAGE_INVALID');
});

test('P4 服务层请求体：严格契约键、单图、受控页与 base 版本', async () => {
  const service = await import('../src/services/frontendReconstruct/frontendReconstructService.js');
  const built = service.buildFrontendAnalyzePayload({
    runId: 'frun-payload-1',
    projectId: 'p_abc12345',
    utterance: '按图改首页',
    image: referenceImage(),
    targetPages: ['home', 'menu', 'settings'],
    baseTemplate: { id: 'ordering-base', version: '1.0.0' },
    presentationPatch: {},
  }, { requestId: 'fr-1' });
  assert.equal(built.ok, true);
  assert.equal(built.payload.contractVersion, 'frontend-reconstruct.v1');
  assert.equal(built.payload.image.mediaType, 'image/png');
  assert.equal(built.payload.image.bytes, 11);
  assert.equal(built.payload.images, undefined, '渲染进程只传单图，由主进程组装 images[]');
  assert.equal(built.payload.targetPages.join(','), 'home,menu');
  assert.equal(built.payload.client.surface, 'desktop');
  assert.equal(built.payload.current.frontendPack, null);
  assert.equal(built.payload.requestId, 'fr-1');

  const noImage = service.buildFrontendAnalyzePayload({ runId: 'frun-x', image: null });
  assert.equal(noImage.ok, false);
  assert.equal(noImage.code, 'FRONTEND_IMAGE_INVALID');
  const tooLong = service.buildFrontendAnalyzePayload({ runId: 'frun-x', image: referenceImage(), utterance: 'x'.repeat(501) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'FRONTEND_UTTERANCE_TOO_LONG');
});

test('P4 服务层：浏览器模式如实 DESKTOP_REQUIRED，不伪造本地生成', async () => {
  const service = await import('../src/services/frontendReconstruct/frontendReconstructService.js');
  const created = service.createFrontendReconstructService({ api: null });
  assert.equal(created.mode, 'browser');
  const result = await created.buildCandidate({ projectId: 'p_abc12345', runId: 'frun-x', draft: { pages: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DESKTOP_REQUIRED');
  const unsubscribe = created.onProgress(() => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});

test('P4 服务层：桌面桥接只调用 8 个语义 API，并把失败归一化', async () => {
  const service = await import('../src/services/frontendReconstruct/frontendReconstructService.js');
  const calls = [];
  const api = {
    isDesktop: true,
    analyzeFrontend: async (payload) => { calls.push(['analyze', payload]); return { ok: true, response: plannedResponse() }; },
    buildCandidate: async (payload) => { calls.push(['build', payload]); return buildResult(); },
    validateCandidate: async () => ({ ok: true }),
    verifyCandidate: async () => verifyResult(),
    adoptCandidate: async () => ({ ok: true, adoption: { candidateId: 'cand-home-1' } }),
    discardCandidate: async () => ({ ok: true }),
    cancelFrontendRun: async () => ({ ok: false, code: 'FRONTEND_NO_ACTIVE_RUN', message: '没有可取消的任务' }),
    onFrontendProgress: () => () => {},
  };
  const created = service.createFrontendReconstructService({ api });
  assert.equal(created.mode, 'desktop');
  const analyzed = await created.analyze({
    runId: 'frun-bridge-1',
    projectId: 'p_abc12345',
    image: referenceImage(),
    targetPages: ['home'],
    // B5：没有确认不发请求；这里带一份合法确认，验证它被原样带到主进程。
    consent: {
      confirmedAt: '2026-11-19T06:00:00.000Z',
      imageDigest: 'sha256:' + 'a'.repeat(64),
      host: '127.0.0.1:3000',
      purpose: 'frontend-reconstruct',
    },
  });
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.response.status, 'planned');
  assert.equal(calls[0][1].contractVersion, 'frontend-reconstruct.v1');
  assert.equal(calls[0][1].client.phase, 'frontend-reconstruct');
  // B5：确认凭据必须原样交给主进程（主进程再按图摘要/接收方/时效复核）。
  assert.equal(calls[0][1].consent.purpose, 'frontend-reconstruct');
  assert.equal(calls[0][1].consent.host, '127.0.0.1:3000');
  assert.equal(calls[0][1].consent.confirmedAt, '2026-11-19T06:00:00.000Z');

  const built = await created.buildCandidate({ runId: 'frun-bridge-1', projectId: 'p_abc12345', draft: plannedResponse().draft });
  assert.equal(built.ok, true);
  assert.equal(calls[1][0], 'build');

  const cancel = await created.cancelRun({ runId: 'frun-bridge-1' });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.code, 'FRONTEND_NO_ACTIVE_RUN');
  assert.match(cancel.message, /没有可取消的任务/);
});

test('P4 App.jsx 只做组合根：导入 domain 与服务，并把 frontendPanel 交给旧面板', () => {
  const source = read(APP_PATH);
  assert.match(source, /import\s+FrontendCandidatePanel\s+from\s+'\.\/components\/screenRef\/FrontendCandidatePanel\.jsx'/);
  assert.match(source, /from\s+'\.\/domain\/frontendReconstruct\.mjs'/);
  assert.match(source, /createFrontendReconstructService/);
  assert.match(source, /buildFrontendReconstructView\(frontendState\)/);
  assert.match(source, /frontendPanel=\{frontendCandidatePanel\}/);
  assert.match(source, /<ScreenReferencePanel[\s\S]*?view=\{state\.screenRef\.view\}/, '旧识别兼容区必须保留');
  // 业务判断不能在 App 里另起一套：采用门槛只能来自 view。
  assert.match(source, /frontendView\.canAdopt/);
  assert.match(source, /frontendView\.adoptNeedsPartialConfirm/);
  // t10-F1：adopt/discard/validate/cancel 的 dispatch 必须带 runId/revision/candidateId/attempt。
  assert.match(
    source,
    /const identity = \{ runId, revision, candidateId: candidate\.candidateId, attempt: candidate\.attempt \};/,
  );
  assert.match(source, /type: 'FRONTEND_VERIFY_REQUEST', \.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_VALIDATE_REQUEST', \.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_VALIDATE_SUCCESS', \.\.\.identity, result/);
  assert.match(source, /type: 'FRONTEND_VALIDATE_FAILURE',[\s\S]{0,80}\.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_ADOPT_REQUEST', \.\.\.identity, partialConfirmed/);
  assert.match(source, /type: 'FRONTEND_ADOPT_SUCCESS', \.\.\.identity, adoption/);
  assert.match(source, /type: 'FRONTEND_ADOPT_FAILURE',[\s\S]{0,80}\.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_DISCARD_REQUEST', \.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_DISCARD_SUCCESS', \.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_DISCARD_FAILURE',[\s\S]{0,80}\.\.\.identity/);
  assert.match(source, /type: 'FRONTEND_CANCEL_REQUEST', runId, revision/);
  assert.match(source, /type: 'FRONTEND_CANCELLED', runId, revision/);
  assert.match(source, /onValidate=\{handleFrontendValidate\}/);
  // 不得在渲染进程直接碰 IPC channel 名或主进程模块。
  assert.doesNotMatch(source, /ipcRenderer|require\('\.\.\/desktop/);
  assert.doesNotMatch(source, /frontend:(analyze|build-candidate)/);
});

test('P4 ScreenReferencePanel 保留旧链路并承载新面板；新控件名称唯一且可读', () => {
  const compat = read(COMPAT_PANEL_PATH);
  ['onPickFile', 'onPick', 'onRecognize', 'onConfirm', 'onCreateCandidate', 'onAdopt', 'onDiscard', 'onRetry', 'onReset']
    .forEach((name) => {
      assert.match(compat, new RegExp(name), '旧面板仍必须保留 ' + name);
    });
  assert.match(compat, /cloneElement\(frontendPanel, \{ uploadSlot \}\)/);
  assert.match(compat, /\{candidatePanel\}/);
  assert.match(compat, /id="screen-ref-upload-button"/);
  assert.match(compat, /id="screen-ref-panel"/);
  assert.match(compat, /aria-label="参考小程序截图"/);

  const panel = read(PANEL_PATH);
  const ids = [...panel.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(ids.length >= 8, '关键控件都应有稳定 id');
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复：' + ids.join(','));
  const labels = [...panel.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(labels).size, labels.length, 'aria-label 不能重复：' + labels.join(','));
  ['识别并生成候选方案', '构建候选工程', '验证候选工程（微信）', '复核候选前端（只读）', '采用候选前端', '放弃此候选前端', '取消候选前端任务'].forEach((name) => {
    assert.ok(panel.includes(name), '缺少可读控件名：' + name);
  });
  assert.match(panel, /aria-label="我已知悉微信验证未完成，仍要采用候选前端"/);
  assert.match(panel, /role="progressbar"/);
  assert.match(panel, /aria-label="能力覆盖报告"/);
  assert.match(panel, /aria-label="验证报告"/);
  assert.match(panel, /aria-label="微信截图清单"/);
  assert.match(panel, /微信验证未完成/);
  // 沿用旧面板的按钮名会导致 AMBIGUOUS_TARGET：不能重复出现。
  ['开始识别', '确认识别结果', '生成候选模板', '采用这个候选', '放弃候选'].forEach((name) => {
    assert.ok(!panel.includes(name), '新面板复用了旧面板控件名：' + name);
  });
});

test('P4 agent:smoke 增加候选前端主链 UIA 断言（不伪造通过）', () => {
  const source = read(SMOKE_PATH);
  assert.match(source, /FRONTEND_PANEL_TEXTS/);
  assert.match(source, /'门店经营资料'/);
  assert.match(source, /'风格与图片素材'/);
  assert.match(source, /'识别菜品并回写'/);
  assert.match(source, /'添加环境图片'/);
  assert.match(source, /'上传截图'/);
  assert.match(source, /'识别并生成候选方案'/);
  assert.match(source, /'补充要求'/);
  assert.match(source, /'目标页面：首页'/);
  assert.match(source, /function assertFrontendPanel/);
  assert.match(source, /NOT_VISIBLE/);
  assert.match(source, /assertSnap\(snap, FRONTEND_PANEL_TEXTS, '候选前端主链控件'\)/);
});

test('P5 接线 adoptionBridge：采用记录带 overlay/摘要/上一版，撤销恢复上一版', async () => {
  const bridge = await import('../src/services/frontendReconstruct/adoptionBridge.js');

  const paths = bridge.deriveAttemptPaths('projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json');
  assert.equal(paths.attemptRelative, 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2');
  assert.equal(paths.overlayRelative, paths.attemptRelative + '/overlay');
  assert.deepEqual(bridge.deriveAttemptPaths('C:/absolute/adopted.json'), { attemptRelative: null, overlayRelative: null });
  assert.deepEqual(bridge.deriveAttemptPaths('projects/p_x/../escape/adopted.json'), { attemptRelative: null, overlayRelative: null });

  const previous = { status: 'adopted', candidateId: 'fr-previous0001', candidateVersion: '1.0.0', integrity: 'sha256:' + 'c'.repeat(64), runId: 'frun-prev-1', projectId: 'p_abc12345', attempt: 1, overlayRelative: 'projects/p_abc12345/frontend-runs/frun-prev-1/attempts/attempt-1/overlay', verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0 }, previous: { status: 'none' }, verified: true };
  const record = bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, digest: 'sha256:' + 'b'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-test-1',
    adoptionResult: {
      candidateId: 'fr-abcdef012345',
      candidateVersion: '1.0.0',
      attempt: 2,
      runtimeStatus: 'PASS',
      partialConfirmed: false,
      adoptedAt: '2026-11-17T02:00:00.000Z',
      recordRelative: 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json',
    },
    runtimeVerification: { status: 'PASS', repairs: 1, screenshots: [{ name: 'a.png' }, { name: 'b.png' }] },
    plan: { planId: 'order-warm-home', planVersion: '1.0.0', frontendPack: { id: 'fr-abcdef012345', version: '1.0.0' }, baseTemplate: { id: 'ordering-base', version: '1.0.0' } },
    previous,
  });
  assert.equal(record.status, 'adopted');
  assert.equal(record.verified, true);
  assert.equal(record.candidateId, 'fr-abcdef012345');
  assert.equal(record.integrity, 'sha256:' + 'b'.repeat(64));
  assert.equal(record.attemptRelative, 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2');
  assert.equal(record.overlayRelative, record.attemptRelative + '/overlay');
  assert.deepEqual(record.plan.frontendPack, { id: 'fr-abcdef012345', version: '1.0.0' });
  assert.equal(record.verification.runtime, 'PASS');
  assert.equal(record.verification.repairs, 1);
  assert.equal(record.verification.screenshots, 2);
  assert.equal(record.previous.candidateId, 'fr-previous0001');
  assert.equal(record.previous.previous, null, '上一版只保留一层');
  assert.equal(record.previous.verified, true, '上一版 verified 必须按来源保留（true）');

  const overlay = bridge.candidateOverlayFromAdoption(record);
  assert.deepEqual(Object.keys(overlay).sort(), ['attempt', 'candidateId', 'candidateVersion', 'integrity', 'projectId', 'repairs', 'runId', 'runtimeStatus']);
  assert.equal(overlay.overlayRelative, undefined, '导出只传受控 id，不传路径');
  assert.equal(overlay.runtimeStatus, 'PASS');
  assert.equal(bridge.candidateOverlayFromAdoption({ status: 'unavailable' }), null);

  const undone = bridge.undoAdoptionRecord(record);
  assert.equal(undone.restored, true);
  assert.equal(undone.adoption.candidateId, 'fr-previous0001');
  assert.equal(undone.adoption.verified, true, '上一版原本 verified=true：撤销后保留 true');
  assert.equal(bridge.undoAdoptionRecord({ status: 'none' }).restored, false);

  // 上一版未校验（verified=false）时，撤销必须保留 false，绝不“顺手置 true”。
  const unverifiedPreviousRecord = bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, digest: 'sha256:' + 'b'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-test-1',
    adoptionResult: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, recordRelative: 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json' },
    previous: { ...previous, verified: false },
  });
  assert.equal(unverifiedPreviousRecord.previous.verified, false);
  const undoneUnverified = bridge.undoAdoptionRecord(unverifiedPreviousRecord);
  assert.equal(undoneUnverified.restored, true);
  assert.equal(undoneUnverified.adoption.candidateId, 'fr-previous0001');
  assert.equal(undoneUnverified.adoption.verified, false, '未校验的上一版不得被撤销置为 true');

  // 上一版已漂移（unavailable）时，撤销恢复的是 unavailable，而不是“修好”。
  const driftedPreviousRecord = bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, digest: 'sha256:' + 'b'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-test-1',
    adoptionResult: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, recordRelative: 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json' },
    previous: {
      status: 'unavailable',
      candidateId: 'fr-previous0001',
      candidateVersion: '1.0.0',
      issue: { code: 'FRONTEND_DIGEST_MISMATCH', message: '候选 overlay 摘要不一致，已回退到 Base 页面。' },
    },
  });
  const undoneDrifted = bridge.undoAdoptionRecord(driftedPreviousRecord);
  assert.equal(undoneDrifted.restored, true);
  assert.equal(undoneDrifted.adoption.status, 'unavailable');
  assert.equal(undoneDrifted.adoption.verified, false);

  // 没有上一版：撤销回到 Base（记录为 null）。
  const firstAdoption = bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, digest: 'sha256:' + 'b'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-test-1',
    adoptionResult: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, recordRelative: 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json' },
  });
  const undoneToBase = bridge.undoAdoptionRecord(firstAdoption);
  assert.equal(undoneToBase.restored, true);
  assert.equal(undoneToBase.adoption, null);

  assert.match(bridge.adoptionNotice(record), /已采用候选前端 fr-abcdef012345@1\.0\.0/);
  assert.match(bridge.adoptionNotice({ status: 'unavailable', issue: { code: 'FRONTEND_CANDIDATE_MISSING', message: '候选 overlay 已不存在，已回退到 Base 页面。' } }), /已不存在/);
  assert.match(bridge.adoptionNotice({ ...record, verified: false }), /导出前/);
  assert.equal(bridge.adoptionNotice(null), null);
});

test('P5 t33 回归：撤销到未校验的上一版仍被导出阻断，不会被置 true 放行', async () => {
  const bridge = await import('../src/services/frontendReconstruct/adoptionBridge.js');
  const planModule = await import('../src/composition/planFromSession.mjs');
  const previous = {
    status: 'adopted',
    candidateId: 'fr-previous0001',
    candidateVersion: '1.0.0',
    integrity: 'sha256:' + 'c'.repeat(64),
    runId: 'frun-prev-1',
    projectId: 'p_abc12345',
    attempt: 1,
    overlayRelative: 'projects/p_abc12345/frontend-runs/frun-prev-1/attempts/attempt-1/overlay',
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0 },
    verified: false,
  };
  const build = (prev) => bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, digest: 'sha256:' + 'b'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-test-1',
    adoptionResult: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 2, recordRelative: 'projects/p_abc12345/frontend-runs/frun-test-1/attempts/attempt-2/adopted.json' },
    previous: prev,
  });
  const baseState = {
    store: { name: '松月食堂' },
    features: { selected: ['scan-order'] },
    build: { selectedId: 'warm-bistro' },
    visual: { styleId: 'fresh' },
    agentDraft: { storeName: '松月食堂', dishes: [] },
  };

  const current = build(previous);
  const undone = bridge.undoAdoptionRecord(current);
  assert.equal(undone.restored, true);
  assert.equal(undone.adoption.verified, false, '未校验的上一版不得在撤销时被置为 verified');

  const blocked = planModule.buildExportPlanFromSession({ ...baseState, frontendCandidate: undone.adoption });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'FRONTEND_CANDIDATE_UNVERIFIED');
  assert.match(blocked.message, /导出会被阻断|不会静默回退 Base/);
  assert.equal(blocked.plan, null, '被阻断时不得返回可用 Plan');
  assert.match(bridge.adoptionNotice(undone.adoption), /导出前/);

  // 对照：上一版原本 verified=true 时，撤销保留 true，导出计划可用（不是一刀切阻断）。
  const verifiedUndo = bridge.undoAdoptionRecord(build({ ...previous, verified: true }));
  assert.equal(verifiedUndo.adoption.verified, true);
  const allowed = planModule.buildExportPlanFromSession({ ...baseState, frontendCandidate: verifiedUndo.adoption });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.deepEqual(allowed.plan.frontendPack, { id: 'fr-previous0001', version: '1.0.0' });

  // 上一版已漂移：撤销保持 unavailable，导出按 issue code 阻断并提示。
  const drifted = bridge.undoAdoptionRecord(build({
    status: 'unavailable',
    candidateId: 'fr-previous0001',
    candidateVersion: '1.0.0',
    issue: { code: 'FRONTEND_DIGEST_MISMATCH', message: '候选 overlay 摘要不一致，已回退到 Base 页面。' },
  }));
  assert.equal(drifted.adoption.status, 'unavailable');
  assert.equal(drifted.adoption.verified, false);
  const driftBlocked = planModule.buildExportPlanFromSession({ ...baseState, frontendCandidate: drifted.adoption });
  assert.equal(driftBlocked.ok, false);
  assert.equal(driftBlocked.code, 'FRONTEND_DIGEST_MISMATCH');
  assert.match(driftBlocked.message, /摘要不一致|不可用/);
});

test('P5 接线 App：project:load 传 candidateCheck，自动保存带候选，采用/撤销写快照并可提示失败', () => {
  const source = read(APP_PATH);
  // 打开/重开：candidateCheck 必须传给 fromDocument，并把校验结论落到候选记录与提示。
  assert.match(source, /fromDocument\(result\.doc, \{ candidateCheck: result\.candidateCheck \}\)/);
  assert.match(source, /setFrontendCandidateRecord\(openedCandidate\)/);
  assert.match(source, /adoptionNotice\(openedCandidate\) \|\| hydrated\.frontendCandidateNotice/);
  assert.match(source, /hydrated\.frontendCandidate\.status !== 'none'/);
  // 自动保存：候选记录随 toDocument 落盘，并触发依赖。
  assert.match(source, /frontendCandidate: adoptionStateSlice\(frontendCandidateRecord\)/);
  assert.match(source, /frontendCandidateRecord,\s*\n\s*state\.settings\.config\?\.autoSaveEnabled/);
  assert.match(source, /候选已采用，但项目保存失败/);
  // 采用：buildAdoptionRecord + previous 一层；写盘失败保留 UI（只 setNotice，不 dispatch 回滚）。
  assert.match(source, /buildAdoptionRecord\(\{/);
  assert.match(source, /previous: frontendCandidateRecord/);
  assert.match(source, /runtimeVerification: frontendState\.runtimeVerification/);
  // 撤销：走 undoAdoptionRecord，并经全局「撤销」入口优先处理。
  assert.match(source, /undoAdoptionRecord\(frontendCandidateRecord\)/);
  assert.match(source, /if \(handleFrontendUndoAdoption\(\)\) return;/);
  assert.match(source, /frontendDispatch\(\{ type: 'FRONTEND_RESET', keepImage: true \}\)/);
  // 导出/预览/体检：候选 overlay 缺失即阻断，且导出带候选 overlay。
  const exportPlanCalls = [...source.matchAll(/buildExportPlanFromSession\(frontendStateWithCandidate\)/g)].length;
  assert.ok(exportPlanCalls >= 5, '预览/导出/体检入口都应走 buildExportPlanFromSession，实际 ' + exportPlanCalls);
  assert.ok([...source.matchAll(/candidateOverlay: frontendCandidateOverlay/g)].length >= 2);
  assert.match(source, /validatePlan\(exportPlan\.plan, \{ candidateOverlay: frontendCandidateOverlay \}\)/);
  assert.match(source, /if \(!exportPlan\.ok\)[\s\S]{0,400}setNotice\(/);
  // 项目生命周期：新建/重置/删除当前项目要清空候选记录。
  assert.ok([...source.matchAll(/setFrontendCandidateRecord\(null\)/g)].length >= 3);
  // 写盘失败只提示、不回滚：失败分支里绝不能 clear 候选记录（保留当前 UI 状态）。
  const saveFailIndex = source.indexOf('候选已采用，但项目保存失败');
  assert.ok(saveFailIndex > 0);
  const saveFailSpan = source.slice(saveFailIndex - 200, saveFailIndex + 600);
  assert.strictEqual(saveFailSpan.includes('setFrontendCandidateRecord(null)'), false, '保存失败不得把已采用状态清掉');
  assert.match(saveFailSpan, /setNotice\(/);
  // 撤销只切候选记录、不动展示补丁（Plan 由 domain 重算；presentation 原样保留）。
  const undoIndex = source.indexOf('const handleFrontendUndoAdoption');
  assert.ok(undoIndex > 0);
  const undoSpan = source.slice(undoIndex, undoIndex + 2200);
  assert.match(undoSpan, /undoAdoptionRecord\(frontendCandidateRecord\)/);
  assert.match(undoSpan, /setFrontendCandidateRecord\(undone\.adoption\)/);
  assert.match(undoSpan, /展示补丁保持不变/);
  assert.doesNotMatch(undoSpan, /SET_STYLE|PRESENTATION_|CONFIRM_TEMPLATE/, '撤销候选不得改写展示补丁');
  // t33：撤销不得把上一版 verified 无条件置 true；未校验/漂移要有单独的阻断提示。
  assert.match(undoSpan, /restored\.status !== 'adopted'/);
  assert.match(undoSpan, /该版本还没有校验 overlay 摘要，导出会被阻断/);
  const bridgeSource = read(path.join(REPO, 'src', 'services', 'frontendReconstruct', 'adoptionBridge.js'));
  assert.match(bridgeSource, /previousSource/);
  assert.doesNotMatch(bridgeSource, /\.\.\.undone\.adoption,\s*verified: true/, '撤销禁止无条件置 verified=true');
  assert.match(bridgeSource, /verified: previousSource \? previousSource\.verified === true : false/);
  assert.match(bridgeSource, /撤销不是重新校验/);
});

test('P5 重开项目：candidateCheck 通过就不再永久“未校验”，漂移则阻断导出', async () => {
  const snapshot = await import('../src/domain/projectSnapshot.mjs');
  const planModule = await import('../src/composition/planFromSession.mjs');
  const bridge = await import('../src/services/frontendReconstruct/adoptionBridge.js');

  const record = bridge.buildAdoptionRecord({
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', attempt: 1, digest: 'sha256:' + 'd'.repeat(64) },
    projectId: 'p_abc12345',
    runId: 'frun-reopen-1',
    adoptionResult: {
      candidateId: 'fr-abcdef012345',
      candidateVersion: '1.0.0',
      attempt: 1,
      runtimeStatus: 'NOT_RUN',
      recordRelative: 'projects/p_abc12345/frontend-runs/frun-reopen-1/attempts/attempt-1/adopted.json',
      adoptedAt: '2026-11-17T00:00:00.000Z',
    },
    plan: { planId: 'order-warm-home', planVersion: '1.0.0', frontendPack: { id: 'fr-abcdef012345', version: '1.0.0' }, baseTemplate: { id: 'ordering-base', version: '1.0.0' } },
  });
  const doc = snapshot.toDocument(
    {
      store: { name: '松月食堂' },
      features: { selected: ['scan-order'] },
      build: { selectedId: 'warm-bistro' },
      visual: { styleId: 'fresh' },
      agentDraft: { storeName: '松月食堂', dishes: [] },
      frontendCandidate: record,
    },
    { projectId: 'p_abc12345', createdAt: '2026-11-17T00:00:00.000Z' },
  );
  assert.equal(doc.frontendCandidate.verified, false, '落盘时不写 verified');

  // 未传 candidateCheck（旧调用）→ 仍会提示「导出前校验」（安全，不会静默放行）。
  const noCheck = snapshot.fromDocument(doc);
  assert.equal(noCheck.frontendCandidate.verified, false);
  assert.equal(planModule.buildExportPlanFromSession(noCheck).ok, false);

  // 主进程校验通过后传入 candidateCheck → verified，导出计划可用（不再永久未校验）。
  const verified = snapshot.fromDocument(doc, { candidateCheck: { ok: true, verification: { runtime: 'NOT_RUN', repairs: 0 } } });
  assert.equal(verified.frontendCandidate.verified, true);
  assert.equal(verified.frontendCandidateNotice, null);
  const exportable = planModule.buildExportPlanFromSession(verified);
  assert.equal(exportable.ok, true, JSON.stringify(exportable));
  assert.deepEqual(exportable.plan.frontendPack, { id: 'fr-abcdef012345', version: '1.0.0' });

  // 摘要漂移 → unavailable + 提示 + 导出阻断。
  const drifted = snapshot.fromDocument(doc, { candidateCheck: { ok: false, code: 'FRONTEND_DIGEST_MISMATCH', message: '候选 overlay 摘要不一致，已回退到 Base 页面。' } });
  assert.equal(drifted.frontendCandidate.status, 'unavailable');
  assert.match(drifted.frontendCandidateNotice, /摘要/);
  const blocked = planModule.buildExportPlanFromSession(drifted);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'FRONTEND_DIGEST_MISMATCH');
});

test('P6 接线 App：真实 trace/进度经 buildFrontendProcessView 传 ChatStream，无证据不显示', () => {
  const source = read(APP_PATH);
  assert.match(source, /import \{ buildFrontendProcessView \} from '\.\/domain\/agentRunProcess\.mjs'/);
  assert.match(source, /const frontendProcessSummary = useMemo\(/);
  // 只有真实 trace（modelCalls>0 或 toolCalls 非空）或主进程真实进度才生成视图。
  assert.match(source, /const hasTrace = Boolean\(trace && \(/);
  assert.match(source, /Array\.isArray\(trace\.toolCalls\) && trace\.toolCalls\.length > 0/);
  assert.match(source, /if \(!hasTrace && !progress\) return null;/);
  assert.match(source, /return view && view\.title \? view : null;/);
  // 输入只来自安全字段：runId/attempt/耗时/状态/trace/progress/error，不拼消息正文或 prompt。
  assert.match(source, /status: frontendState\.status,/);
  assert.match(source, /runId: frontendState\.runId,/);
  assert.match(source, /attempt: frontendState\.candidate \? frontendState\.candidate\.attempt : null,/);
  assert.match(source, /startedAt: timing \? timing\.startedAt : null,/);
  assert.match(source, /endedAt: timing \? timing\.endedAt : null,/);
  assert.match(source, /lastError: frontendState\.error,/);
  assert.doesNotMatch(source, /buildFrontendProcessView\(\{[\s\S]{0,400}(dataBase64|utterance|prompt\b)/);
  // 真实耗时：只在真实 runId 下计时，终态定格一次。
  assert.match(source, /const \[frontendTiming, setFrontendTiming\] = useState\(\{ runId: null, startedAt: null, endedAt: null \}\)/);
  assert.match(source, /FRONTEND_TERMINAL_STATUSES\.has\(frontendState\.status\)/);
  assert.match(source, /setFrontendTiming\(\(prev\) => \{/);
  // 只传给 ChatStream 一个安全视图，且限定「开店资料」阶段（P4 面板同阶段，避免全局串台）。
  assert.match(source, /process=\{phase === PHASES\.STORE_INFO \? frontendProcessSummary : null\}/);
  const chatStreamBlocks = [...source.matchAll(/<ChatStream\b[\s\S]*?>/g)].map((match) => match[0]);
  assert.equal(chatStreamBlocks.length, 1, 'App 只有一处 ChatStream');
  assert.equal([...chatStreamBlocks[0].matchAll(/\bprocess=\{/g)].length, 1, 'ChatStream 只接收一个 process 属性');
  assert.doesNotMatch(source, /<ChatStream[\s\S]{0,900}(frontendState\.progress|frontendState\.analysis|\.\.\.frontendView)/);

  // ChatStream 侧契约（只读检查，不改它）：无 title 不渲染；区块带可读名称与 aria-label。
  const chat = read(path.join(REPO, 'src/components/chat/ChatStream.jsx'));
  assert.match(chat, /if \(!process \|\| !process\.title\) return null;/);
  assert.match(chat, /aria-label=\{`本轮处理过程：\$\{process\.title\}`\}/);
  assert.match(chat, /aria-label="用时"/);
  assert.match(chat, /aria-label="处理步骤"/);
  // P4 面板自己的进度仍由 frontendView 提供，过程卡不接管它。
  assert.match(source, /<FrontendCandidatePanel[\s\S]{0,300}view=\{frontendView\}/);
});

test('P6 过程卡安全：只含受控标签/runId/attempt/状态/耗时，不泄漏源码/base64/prompt/密钥/绝对路径', async () => {
  const { buildFrontendProcessView } = await import('../src/domain/agentRunProcess.mjs');
  const view = buildFrontendProcessView({
    status: 'partial',
    trace: {
      modelCalls: 3,
      toolCalls: [
        { name: 'get_frontend_capabilities', ok: true },
        { name: 'propose_frontend_draft', ok: true },
        {
          name: 'internal_debug_tool',
          ok: false,
          args: { prompt: '完整提示词正文', source: '<view>{{secret}}</view>' },
          result: 'data:image/png;base64,AAAABBBBCCCC',
        },
      ],
      stopReason: 'final_answer',
      degraded: true,
    },
    progress: { stage: 'observable', attempt: 2, runId: 'frun-abc123' },
    runId: 'frun-abc123',
    attempt: 2,
    durationMs: 12345,
    lastError: 'C:\\Users\\me\\AppData\\secret.png apiKey=sk-abcdefghijklmnop data:image/png;base64,AAAABBBB 完整 prompt 内容',
  });

  // 工具标签受控：四个白名单工具翻译，未知工具折叠成「辅助步骤」且不回显真名。
  assert.deepEqual(view.steps.map((step) => step.label).slice(0, 3), ['读取页面能力', '生成候选页面', '辅助步骤']);
  assert.equal(view.steps.some((step) => step.label === '核对页面细节'), true, '主进程真实进度也要显示');
  assert.equal(view.meta.runId, 'frun-abc123');
  assert.equal(view.meta.attempt, 2);
  assert.equal(view.meta.status, 'partial');
  assert.equal(view.meta.durationLabel, '12.3s');
  // 界面只显示「用时」这类人话；运行标识/尝试次数/状态码仍保留在 meta 里供排查，不上屏。
  assert.ok(view.metaLines.some((line) => line.includes('用时 12.3s')));
  assert.ok(!view.metaLines.some((line) => line.includes('frun-abc123')), '界面不展示内部运行标识');
  assert.ok(!view.metaLines.some((line) => line.includes('第 2 次尝试')), '界面不展示内部尝试次数');

  const serialized = JSON.stringify(view);
  ['internal_debug_tool', '完整提示词正文', '<view>', 'data:image', 'AAAABBBB', 'sk-abcdefghijklmnop', 'C:\\\\Users', 'secret.png'].forEach((needle) => {
    assert.equal(serialized.includes(needle), false, '过程卡不得包含 ' + needle);
  });
  // 错误文本经脱敏：本机路径/密钥/图片改成占位符。
  assert.match(view.headline, /<local-path>/);
  assert.match(view.headline, /<secret>/);
  assert.match(view.headline, /<image>/);
  // 步骤只有受控字段，没有 args/result/源码。
  view.steps.forEach((step) => {
    assert.deepEqual(Object.keys(step).sort(), ['detail', 'id', 'label', 'state']);
  });

  // 无真实 trace/进度时 App 的守卫返回 null（见上一条静态断言）；
  // 这里补：空 trace + 空进度不会凭空产生工具步骤。
  const empty = buildFrontendProcessView({ status: 'idle', trace: null, progress: null });
  assert.deepEqual(empty.steps, []);
  assert.equal(empty.meta.runId, null);
  assert.equal(empty.meta.attempt, null);
  assert.equal(empty.meta.durationLabel, null);
});

test('P5 旧 screen-reference 兼容：识别解析与白名单行为不变', async () => {
  const compat = await import('../src/domain/screenReference.mjs');
  const parsed = compat.parseScreenReferenceResponse({
    contractVersion: 'screen-reference.v1',
    recognition: {
      layouts: [{ id: 'order-classic' }],
      components: [{ id: 'scan-order' }],
      style: { theme: { primaryColor: '#112233' }, sizes: { homeHero: 'lg' } },
      approximate: [],
      unsupported: [],
    },
    meta: { model: 'x', latencyMs: 1, analyzed: true, runId: 'r1' },
  });
  assert.equal(parsed.ok, true);
  const view = compat.buildScreenRefView({
    status: 'ready',
    recognition: parsed.recognition,
    image: { name: 'a.png', mediaType: 'image/png', previewUrl: 'data:,' },
    confirmedAt: null,
    candidate: null,
    adopted: false,
  });
  assert.equal(view.confirmable, true);
  assert.equal(view.recognition.groups.reusable.length, 2);
  const candidate = compat.buildCandidateRecipe({
    recognition: parsed.recognition,
    confirmedAt: '2026-11-17T00:00:00.000Z',
    draft: { storeName: '松月食堂', dishes: [{ id: 'd1', name: '面', priceCents: 100 }] },
    createdAt: '2026-11-17T00:00:00.000Z',
  });
  assert.equal(candidate.ok, true);
  assert.equal(candidate.candidate.storeSnapshot.dishes.length, 1);
});
