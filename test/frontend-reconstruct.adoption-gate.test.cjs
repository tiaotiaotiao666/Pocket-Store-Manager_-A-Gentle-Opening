'use strict';

/**
 * B1：候选采用与导出门禁（负向回归）。
 *
 * 只验证一件事：正式导出只在「当前 attempt 已被采用 + 最新真实运行时证据属于同一候选 +
 * 不是 FAIL」时才放行；渲染层自报的 runtimeStatus 一律忽略；普通 Base 导出不受影响。
 *
 * 覆盖：
 * 1. 未采用 → 拒绝且不调 Composer；
 * 2. FAIL + partialConfirmed=true → 采用与导出都拒绝（确认不能覆盖 FAIL）；
 * 3. BLOCKED + 显式确认 → 允许部分采用，并如实记录状态/时间/证据，不称验收通过；
 * 4. 采用记录与候选/版本不一致、证据属于别的候选或已过期 → 结构化拒绝；
 * 5. 渲染层伪造 PASS → 仍以磁盘证据为准；
 * 6. 普通 Base 导出不回归（没有 frontendPack 时不需要采用记录）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const { createComposerIpc } = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));
const { createFrontendReconstructIpc, CODES } = require(path.join(REPO, 'desktop', 'frontend-reconstruct-ipc.cjs'));
const { compose, validateComposition } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));

async function loadSnapshot() {
  return import(pathToFileURL(path.join(REPO, 'src', 'domain', 'projectSnapshot.mjs')).href);
}
async function loadPlan() {
  return import(pathToFileURL(path.join(REPO, 'src', 'composition', 'planFromSession.mjs')).href);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-' + prefix + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return dir;
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

/** 走真实 IPC 构建一个候选 attempt（含 dry-run 证据与 run.json 登记）。 */
async function buildCandidate(harness, projectId, runId) {
  const built = await harness.reconstruct.handlers['frontend:build-candidate'](harness.event, {
    projectId,
    runId,
    draft: draftFixture(),
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  const attempt = built.candidate.attempt || 1;
  const attemptDir = path.join(harness.userDataDir, 'projects', projectId, 'frontend-runs', runId, 'attempts', 'attempt-' + attempt);
  const meta = JSON.parse(fs.readFileSync(path.join(attemptDir, 'attempt.json'), 'utf8'));
  const attemptRelative = 'projects/' + projectId + '/frontend-runs/' + runId + '/attempts/attempt-' + attempt;
  return {
    projectId,
    runId,
    attempt,
    candidateId: meta.candidate.id,
    candidateVersion: meta.candidate.version,
    integrity: meta.candidate.integrity,
    registryDigest: meta.overlay && meta.overlay.registryDigest,
    attemptRelative,
    overlayRelative: attemptRelative + '/overlay',
    attemptDir,
  };
}

function sessionState(overrides) {
  return {
    store: {
      name: '松月食堂',
      type: '社区餐馆',
      address: '上海市静安区示例路 8 号',
      phone: '13800000000',
      notes: '社区家常菜',
    },
    features: { selected: ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking'] },
    build: { selectedId: 'warm-bistro' },
    visual: { styleId: 'fresh' },
    agentDraft: {
      storeName: '松月食堂',
      category: '社区餐馆',
      businessHours: '10:00-14:00,17:00-21:00',
      fulfillment: { dineIn: true, takeaway: false },
      dishes: [
        { name: '宫保鸡丁', priceCents: 2800, priceText: '28.00', description: '微辣' },
        { name: '番茄炒蛋', priceCents: 1600, priceText: '16.00', description: '' },
        { name: '米饭', priceCents: 300, priceText: '3.00', description: '' },
      ],
    },
    presentation: { templateId: 'warm-bistro', patch: { theme: { primaryColor: '#116644' } } },
    ...overrides,
  };
}

/** 写一次「微信运行时证据」，形状与 verify-runtime 的 wrapper 一致（含候选身份）。 */
function writeRuntimeEvidence(candidate, options) {
  const opts = options || {};
  const dirName = opts.dirName || 'runtime';
  const dir = path.join(candidate.attemptDir, 'verification', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const wrapper = {
    schemaVersion: 'frontend-runtime.v1',
    generatedAt: opts.generatedAt || '2026-11-17T00:00:00.000Z',
    status: opts.status || 'NOT_RUN',
    code: null,
    summary: 'seed',
    screenshots: [],
    candidate: {
      id: opts.candidateId || candidate.candidateId,
      version: opts.candidateVersion || candidate.candidateVersion,
      integrity: opts.integrity || candidate.integrity,
    },
  };
  fs.writeFileSync(path.join(dir, 'frontend-runtime.json'), JSON.stringify(wrapper, null, 2));
  return wrapper;
}

/** 用真实 planFromSession 生成带 frontendPack 的导出 Plan。 */
async function candidatePlan(candidate) {
  const snapshot = await loadSnapshot();
  const planModule = await loadPlan();
  const record = snapshot.buildFrontendAdoption({
    candidate,
    plan: {
      planId: 'order-warm-home',
      planVersion: '1.0.0',
      frontendPack: { id: candidate.candidateId, version: candidate.candidateVersion },
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
    },
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0, screenshots: 0, checkedAt: '2026-11-17T00:00:00.000Z' },
    adoptedAt: '2026-11-17T00:00:00.000Z',
  });
  const built = planModule.buildExportPlanFromSession(sessionState({ frontendCandidate: { ...record, verified: true } }));
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  return built.plan;
}

function overlayOf(candidate) {
  return {
    projectId: candidate.projectId,
    runId: candidate.runId,
    attempt: candidate.attempt,
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    runtimeStatus: 'NOT_RUN',
    repairs: 0,
  };
}

function createHarness(t, userDataDir, exportParent) {
  const composeCalls = [];
  const composer = createComposerIpc({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [exportParent] }) },
    shell: { openPath: async () => '' },
    compose: async (payload) => {
      composeCalls.push(payload);
      return compose(payload);
    },
    validateComposition,
    userDataDir,
    defaultParentDir: exportParent,
    commitRetryDelays: [1],
    enableCommitFallback: false,
  });
  const reconstruct = createFrontendReconstructIpc({ userDataDir });
  const event = { senderFrame: { url: 'http://127.0.0.1:5173/' }, sender: { send: () => {} } };
  return {
    composer,
    reconstruct,
    event,
    composeCalls,
    userDataDir,
    exportWith: (plan, candidateOverlay, projectName) => composer.handlers['composer:export'](event, {
      parentDir: exportParent,
      plan,
      projectName: projectName || 'b1-demo',
      ...(candidateOverlay ? { candidateOverlay } : {}),
    }),
    adopt: (candidate, partialConfirmed) => reconstruct.handlers['frontend:adopt-candidate'](event, {
      projectId: candidate.projectId,
      runId: candidate.runId,
      attempt: candidate.attempt,
      partialConfirmed: partialConfirmed === true,
    }),
  };
}

function readAdopted(candidate) {
  return JSON.parse(fs.readFileSync(path.join(candidate.attemptDir, 'adopted.json'), 'utf8'));
}

function writeAdopted(candidate, patch) {
  const file = path.join(candidate.attemptDir, 'adopted.json');
  let base;
  try {
    base = readAdopted(candidate);
  } catch (error) {
    // 允许直接伪造一份「看起来已采用」的记录（用于证明闸门不认界面或伪造状态）。
    base = {
      schemaVersion: 'frontend-adoption.v1',
      status: 'adopted',
      projectId: candidate.projectId,
      runId: candidate.runId,
      attempt: candidate.attempt,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      integrity: candidate.integrity,
      staticGates: 'pass',
      adoptedAt: '2026-11-17T00:00:00.000Z',
    };
  }
  const record = { ...base, ...patch };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

// ---------------------------------------------------------------------------

test('B1 未采用：导出结构化拒绝，绝不调用 Composer', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const candidate = await buildCandidate(harness, 'p_b1notadopt', 'frun-b1-notadopt');
  writeRuntimeEvidence(candidate, { status: 'PASS' });
  const plan = await candidatePlan(candidate);

  const blocked = await harness.exportWith(plan, overlayOf(candidate));
  assert.strictEqual(blocked.ok, false, JSON.stringify(blocked));
  assert.strictEqual(blocked.code, 'FRONTEND_CANDIDATE_NOT_ADOPTED');
  assert.strictEqual(harness.composeCalls.length, 0, '未采用时不得进入 Composer');
  assert.strictEqual(fs.existsSync(path.join(exportParent, 'b1-demo')), false, '不得留下可被误认为成果的目录');
});

test('B1 FAIL：partial 确认不能覆盖，采用与导出都拒绝', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const candidate = await buildCandidate(harness, 'p_b1fail', 'frun-b1-fail');
  writeRuntimeEvidence(candidate, { status: 'FAIL' });

  const refusedPartial = await harness.adopt(candidate, true);
  assert.strictEqual(refusedPartial.ok, false, JSON.stringify(refusedPartial));
  assert.strictEqual(refusedPartial.code, CODES.RUNTIME_FAILED);
  assert.strictEqual(fs.existsSync(path.join(candidate.attemptDir, 'adopted.json')), false, 'FAIL 不得写采用记录');

  const refusedPlain = await harness.adopt(candidate, false);
  assert.strictEqual(refusedPlain.code, CODES.RUNTIME_FAILED);

  // 即使绕过 IPC 手写一份「已采用 + 确认过 partial」的记录，导出仍必须拒绝。
  const plan = await candidatePlan(candidate);
  writeAdopted(candidate, {
    status: 'adopted',
    runtimeStatus: 'FAIL',
    partialConfirmed: true,
    evidence: { dirName: 'runtime', generatedAt: '2026-11-17T00:00:00.000Z' },
  });
  const exported = await harness.exportWith(plan, overlayOf(candidate));
  assert.strictEqual(exported.ok, false, JSON.stringify(exported));
  assert.strictEqual(exported.code, 'FRONTEND_RUNTIME_FAILED');
  assert.strictEqual(harness.composeCalls.length, 0);
});

test('B1 BLOCKED：显式确认后允许部分采用并如实记录，不称验收通过', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const candidate = await buildCandidate(harness, 'p_b1blocked', 'frun-b1-blocked');
  writeRuntimeEvidence(candidate, { status: 'BLOCKED' });

  const noConfirm = await harness.adopt(candidate, false);
  assert.strictEqual(noConfirm.ok, false);
  assert.strictEqual(noConfirm.code, CODES.PARTIAL_CONFIRM_REQUIRED);
  assert.strictEqual(noConfirm.details.runtimeStatus, 'BLOCKED');

  const adopted = await harness.adopt(candidate, true);
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.strictEqual(adopted.adoption.runtimeStatus, 'BLOCKED');
  assert.strictEqual(adopted.adoption.partialConfirmed, true);
  assert.match(adopted.message, /部分采用/);
  assert.strictEqual(adopted.message.includes('验收通过'), true);
  assert.strictEqual(/微信验证 PASS/.test(adopted.message), false);

  const record = readAdopted(candidate);
  assert.strictEqual(record.status, 'adopted');
  assert.strictEqual(record.runtimeStatus, 'BLOCKED');
  assert.strictEqual(record.partialConfirmed, true);
  assert.match(record.adoptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(record.evidence.dirName, 'runtime');
  assert.strictEqual(record.evidence.generatedAt, '2026-11-17T00:00:00.000Z');

  const plan = await candidatePlan(candidate);
  const exported = await harness.exportWith(plan, overlayOf(candidate), 'b1-blocked');
  assert.strictEqual(exported.ok, true, JSON.stringify(exported));
  assert.strictEqual(harness.composeCalls.length, 1);
  assert.strictEqual(exported.candidate.runtimeStatus, 'BLOCKED');
  assert.strictEqual(exported.candidate.partialConfirmed, true);
  const report = JSON.parse(fs.readFileSync(path.join(exported.outputPath, 'generation-report.json'), 'utf8'));
  const line = report.unresolved.find((item) => item.startsWith('candidate:'));
  assert.ok(line, '报告里必须记录候选状态');
  assert.match(line, /runtime=BLOCKED/);
  assert.match(line, /partial=confirmed/);
});

test('B1 候选不匹配 / 证据过期：一律结构化拒绝', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const candidate = await buildCandidate(harness, 'p_b1mismatch', 'frun-b1-mismatch');
  writeRuntimeEvidence(candidate, { status: 'PASS' });
  const adopted = await harness.adopt(candidate, false);
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  const plan = await candidatePlan(candidate);

  const original = JSON.parse(fs.readFileSync(path.join(candidate.attemptDir, 'adopted.json'), 'utf8'));
  const valid = await harness.exportWith(plan, overlayOf(candidate), 'b1-valid');
  assert.strictEqual(valid.ok, true, '先确认原始记录本身能通过校验');

  writeAdopted(candidate, { candidateId: 'fr-forged000000' });
  const wrongCandidate = await harness.exportWith(plan, overlayOf(candidate), 'b1-other-id');
  assert.strictEqual(wrongCandidate.ok, false);
  assert.strictEqual(wrongCandidate.code, 'FRONTEND_CANDIDATE_ADOPTION_MISMATCH', JSON.stringify(wrongCandidate));

  fs.writeFileSync(path.join(candidate.attemptDir, 'adopted.json'), JSON.stringify({ ...original, candidateVersion: '9.9.9' }, null, 2));
  const wrongVersion = await harness.exportWith(plan, overlayOf(candidate), 'b1-other-version');
  assert.strictEqual(wrongVersion.code, 'FRONTEND_CANDIDATE_ADOPTION_MISMATCH');

  fs.writeFileSync(path.join(candidate.attemptDir, 'adopted.json'), JSON.stringify({ ...original, integrity: 'sha256:' + 'd'.repeat(64) }, null, 2));
  const wrongDigest = await harness.exportWith(plan, overlayOf(candidate), 'b1-other-digest');
  assert.strictEqual(wrongDigest.code, 'FRONTEND_CANDIDATE_ADOPTION_MISMATCH');

  fs.writeFileSync(path.join(candidate.attemptDir, 'adopted.json'), JSON.stringify(original, null, 2));
  // 证据属于别的候选（重建后旧证据）→ 过期。
  writeRuntimeEvidence(candidate, { status: 'PASS', dirName: 'runtime-2', generatedAt: '2026-11-18T00:00:00.000Z', candidateId: 'fr-otherevidence' });
  const stale = await harness.exportWith(plan, overlayOf(candidate), 'b1-stale');
  assert.strictEqual(stale.code, 'FRONTEND_RUNTIME_EVIDENCE_STALE', JSON.stringify(stale));

  // 同一候选但采用之后又跑了新一次验证 → 证据与采用记录不再对应。
  writeRuntimeEvidence(candidate, { status: 'PASS', dirName: 'runtime-3', generatedAt: '2026-11-19T00:00:00.000Z' });
  const reran = await harness.exportWith(plan, overlayOf(candidate), 'b1-rerun');
  assert.strictEqual(reran.code, 'FRONTEND_RUNTIME_EVIDENCE_STALE', JSON.stringify(reran));
  assert.strictEqual(harness.composeCalls.length, 1, '只有最初那次合法导出进入 Composer');
});

test('B1 渲染层伪造 PASS：以磁盘证据为准', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const candidate = await buildCandidate(harness, 'p_b1forge', 'frun-b1-forge');
  writeRuntimeEvidence(candidate, { status: 'BLOCKED' });
  const adopted = await harness.adopt(candidate, true);
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  const plan = await candidatePlan(candidate);

  const forged = { ...overlayOf(candidate), runtimeStatus: 'PASS' };
  const exported = await harness.exportWith(plan, forged, 'b1-forge');
  assert.strictEqual(exported.ok, true, JSON.stringify(exported));
  assert.strictEqual(exported.candidate.runtimeStatus, 'BLOCKED', '自报 PASS 必须被忽略');

  // 证据翻转为 FAIL 后再伪造 PASS：仍然拒绝。
  writeRuntimeEvidence(candidate, { status: 'FAIL', dirName: 'runtime-2', generatedAt: '2026-11-18T00:00:00.000Z' });
  const failed = await harness.exportWith(plan, { ...overlayOf(candidate), runtimeStatus: 'PASS' }, 'b1-forge-fail');
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.code, 'FRONTEND_RUNTIME_FAILED');
});

test('B1 普通 Base 导出不回归：没有 frontendPack 时不要求采用记录', async (t) => {
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const harness = createHarness(t, userDataDir, exportParent);
  const planModule = await loadPlan();
  const built = planModule.buildExportPlanFromSession(sessionState());
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  assert.strictEqual(built.plan.frontendPack, undefined);

  const exported = await harness.exportWith(built.plan, null, 'b1-base');
  assert.strictEqual(exported.ok, true, JSON.stringify(exported));
  assert.strictEqual(harness.composeCalls.length, 1);
  assert.strictEqual(harness.composeCalls[0].registryRoot, undefined, 'Base 导出不得被塞进候选 overlay');
  assert.strictEqual(exported.candidate, undefined);

  // 反向：Plan 没有 frontendPack 却带 overlay，仍然结构化拒绝（不会偷偷用候选）。
  const stray = await harness.exportWith(built.plan, overlayOf({ projectId: 'p_x', runId: 'frun-x', attempt: 1, candidateId: 'fr-x', candidateVersion: '1.0.0', integrity: 'sha256:' + 'a'.repeat(64) }), 'b1-stray');
  assert.strictEqual(stray.ok, false);
  assert.strictEqual(stray.code, 'FRONTEND_OVERLAY_MISMATCH');
});
