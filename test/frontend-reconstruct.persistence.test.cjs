'use strict';

/**
 * P5：候选采用 / 撤销 / 持久化 / 重开校验 / 正式导出同源。
 *
 * 真实验证链路：
 * materialize（真实 P1 快照 + Base）→ 项目快照白名单 → planFromSession 带 frontendPack
 * → Composer 用**同一个私有 overlay** 导出 → 产物/报告里出现 candidate 标记
 * → 删除/篡改 overlay 后重开与导出都安全回退并给出提示。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const { materializeCandidate } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'materialize.cjs'));
const { verifyOverlay } = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'registry-overlay.cjs'));
const adoption = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'adoption.cjs'));
const { createComposerIpc } = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));
const { createProjectIpc } = require(path.join(REPO, 'desktop', 'project-ipc.cjs'));
const { inspectOutput } = require(path.join(REPO, 'desktop', 'output-consistency.cjs'));
const { compose, validateComposition } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { validatePlan } = require(path.join(REPO, 'scripts', 'composer', 'schema.cjs'));

async function loadSnapshot() {
  return import(pathToFileURL(path.join(REPO, 'src', 'domain', 'projectSnapshot.mjs')).href);
}
async function loadPlan() {
  return import(pathToFileURL(path.join(REPO, 'src', 'composition', 'planFromSession.mjs')).href);
}
async function loadExportService() {
  return import(pathToFileURL(path.join(REPO, 'src', 'services', 'exportService.js')).href);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-' + prefix + '-'));
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

/** 真实物化一个候选 attempt，返回快照可用的候选引用。 */
function materializeOnce(t, userDataDir, suffix) {
  const projectId = 'p_p5' + String(suffix || 'a').replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(6, 'x');
  const runId = 'frun-p5-' + (suffix || 'a');
  const materialized = materializeCandidate({ userDataDir, projectId, runId, draft: draftFixture() });
  assert.strictEqual(materialized.ok, true, JSON.stringify(materialized));
  const attemptRelative = 'projects/' + projectId + '/frontend-runs/' + runId + '/attempts/attempt-' + materialized.attempt;
  return {
    projectId,
    runId,
    attempt: materialized.attempt,
    candidateId: materialized.candidate.id,
    candidateVersion: materialized.candidate.version,
    integrity: materialized.candidate.integrity,
    registryDigest: materialized.overlay.registryDigest,
    overlayDir: materialized.overlayDir,
    attemptDir: materialized.attemptDir,
    attemptRelative,
    overlayRelative: attemptRelative + '/overlay',
    expectedSlots: materialized.candidate.requiresSlots,
  };
}

/**
 * B1：导出闸门要求 attempt 下同时有 adopted.json 与「绑定同一候选」的最新运行时证据。
 * 这里按 adoptCandidate 的真实写入形状落盘（测试不需要真跑微信验证）。
 */
function seedAdoption(candidate, options) {
  const opts = options || {};
  const runtimeStatus = opts.runtimeStatus || 'NOT_RUN';
  const dirName = opts.dirName || 'runtime';
  const generatedAt = opts.generatedAt || '2026-11-17T00:00:00.000Z';
  const evidenceDir = path.join(candidate.attemptDir, 'verification', dirName);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'frontend-runtime.json'), JSON.stringify({
    schemaVersion: 'frontend-runtime.v1',
    generatedAt,
    status: runtimeStatus,
    code: null,
    summary: 'seed',
    screenshots: [],
    candidate: {
      id: opts.candidateId || candidate.candidateId,
      version: opts.candidateVersion || candidate.candidateVersion,
      integrity: opts.integrity || candidate.integrity,
    },
  }, null, 2));
  const record = {
    schemaVersion: 'frontend-adoption.v1',
    status: 'adopted',
    projectId: candidate.projectId,
    runId: candidate.runId,
    attempt: candidate.attempt,
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    staticGates: 'pass',
    runtimeStatus,
    partialConfirmed: runtimeStatus === 'PASS' ? false : opts.partialConfirmed !== false,
    evidence: { dirName, generatedAt },
    adoptedAt: '2026-11-17T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(candidate.attemptDir, 'adopted.json'), JSON.stringify(record, null, 2));
  return record;
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

function candidateSlice(candidate, snapshot, overrides) {
  return {
    schemaVersion: 'frontend-candidate-adoption.v1',
    status: 'adopted',
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    runId: candidate.runId,
    projectId: candidate.projectId,
    attempt: candidate.attempt,
    overlayRelative: candidate.overlayRelative,
    attemptRelative: candidate.attemptRelative,
    registryDigest: candidate.registryDigest,
    plan: {
      planId: 'order-warm-home',
      planVersion: '1.0.0',
      frontendPack: { id: candidate.candidateId, version: candidate.candidateVersion },
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
    },
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0, screenshots: 0, checkedAt: '2026-11-17T00:00:00.000Z' },
    evidence: { dryRunRelative: candidate.attemptRelative + '/verification/dry-run', runtimeRelative: null },
    adoptedAt: '2026-11-17T00:00:00.000Z',
    verified: snapshot ? Boolean(snapshot.verified) : false,
    ...(overrides || {}),
  };
}

// ---------------------------------------------------------------------------

test('P5 快照：采用记录只落白名单字段（无 base64/绝对路径/大错误），旧快照兼容', async (t) => {
  const snapshot = await loadSnapshot();
  const userDataDir = tempDir(t, 'snapshot');
  const candidate = materializeOnce(t, userDataDir, 'snap');
  const record = snapshot.buildFrontendAdoption({
    candidate,
    plan: {
      planId: 'order-warm-home',
      planVersion: '1.0.0',
      frontendPack: { id: candidate.candidateId, version: candidate.candidateVersion },
      baseTemplate: { id: 'ordering-base', version: '1.0.0' },
      registryDigest: candidate.registryDigest,
    },
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0, screenshots: 2, checkedAt: '2026-11-17T00:00:00.000Z' },
    adoptedAt: '2026-11-17T00:00:00.000Z',
    previous: {
      status: 'adopted',
      candidateId: 'fr-previous0001',
      candidateVersion: '1.0.0',
      integrity: 'sha256:' + 'c'.repeat(64),
      runId: 'frun-previous-1',
      attempt: 1,
      overlayRelative: 'projects/p_prev1234/frontend-runs/frun-previous-1/attempts/attempt-1/overlay',
      verification: { static: 'pass', runtime: 'BLOCKED' },
      // 下面这些都必须被剥离
      imageBase64: 'AAAA'.repeat(4000),
      trace: { raw: 'x'.repeat(2000) },
      overlayAbsolute: 'C:/Users/me/AppData/overlay',
    },
  });
  assert.strictEqual(record.status, 'adopted');
  assert.strictEqual(record.candidateId, candidate.candidateId);
  assert.match(record.integrity, /^sha256:[0-9a-f]{64}$/);

  const state = {
    ...sessionState(),
    frontendCandidate: {
      ...record,
      imageBase64: 'AAAA'.repeat(4000),
      rawTrace: { calls: ['x'.repeat(5000)] },
      overlayAbsolute: 'C:/Users/me/AppData/overlay',
      previous: {
        ...record.previous,
        imageBase64: 'BBBB'.repeat(4000),
        previousAbsolute: 'D:/private/overlay',
      },
    },
  };
  const doc = snapshot.toDocument(state, { projectId: candidate.projectId, createdAt: '2026-11-17T00:00:00.000Z' });
  assert.ok(snapshot.KNOWN_TOP_KEYS.includes('frontendCandidate'));
  assert.strictEqual(doc.frontendCandidate.status, 'adopted');
  assert.strictEqual(doc.frontendCandidate.candidateId, candidate.candidateId);
  assert.strictEqual(doc.frontendCandidate.overlayRelative, candidate.overlayRelative);
  assert.strictEqual(doc.frontendCandidate.attempt, 1);
  assert.strictEqual(doc.frontendCandidate.verification.runtime, 'NOT_RUN');
  assert.strictEqual(doc.frontendCandidate.previous.candidateId, 'fr-previous0001');
  assert.strictEqual(doc.frontendCandidate.previous.previous, null, '只保留一层上一版本');
  const serialized = JSON.stringify(doc.frontendCandidate);
  assert.strictEqual(serialized.includes('AAAA'), false, '不得写入 base64');
  assert.strictEqual(serialized.includes('C:/'), false, '不得写入本机绝对路径');
  assert.strictEqual(serialized.includes('D:/'), false);
  assert.ok(serialized.length < 4000, '候选记录必须有界，实际 ' + serialized.length);
  assert.strictEqual(snapshot.collectUnknown(doc).frontendCandidate, undefined, '不能落进 unmappedFields');

  // 旧快照（没有这个键）→ status=none，不崩、不提示错误。
  const legacy = { ...doc };
  delete legacy.frontendCandidate;
  const hydratedLegacy = snapshot.fromDocument(legacy);
  assert.strictEqual(hydratedLegacy.frontendCandidate.status, 'none');
  assert.strictEqual(hydratedLegacy.frontendCandidateNotice, null);

  // 没有 candidateCheck 的重开：保留 adopted 但 verified=false，提示导出前会校验。
  const restored = snapshot.fromDocument(doc);
  assert.strictEqual(restored.frontendCandidate.status, 'adopted');
  assert.strictEqual(restored.frontendCandidate.verified, false);
  assert.match(restored.frontendCandidateNotice, /校验/);

  // 校验通过的重开：verified=true，提示消失。
  const verified = snapshot.fromDocument(doc, { candidateCheck: { ok: true, verification: { runtime: 'PASS', repairs: 1 } } });
  assert.strictEqual(verified.frontendCandidate.verified, true);
  assert.strictEqual(verified.frontendCandidate.status, 'adopted');
  assert.strictEqual(verified.frontendCandidate.verification.runtime, 'PASS');
  assert.strictEqual(verified.frontendCandidate.verification.repairs, 1);
  assert.strictEqual(verified.frontendCandidateNotice, null);

  // 校验失败的重开：安全回退为 unavailable 并提示；再存盘也只会写 unavailable。
  const drifted = snapshot.fromDocument(doc, {
    candidateCheck: { ok: false, code: 'FRONTEND_DIGEST_MISMATCH', message: '候选 overlay 摘要与快照不一致，已回退到 Base 页面。' },
  });
  assert.strictEqual(drifted.frontendCandidate.status, 'unavailable');
  assert.strictEqual(drifted.frontendCandidate.verified, false);
  assert.match(drifted.frontendCandidateNotice, /摘要/);
  const savedAgain = snapshot.toDocument({ ...state, frontendCandidate: drifted.frontendCandidate }, { projectId: candidate.projectId });
  assert.strictEqual(savedAgain.frontendCandidate.status, 'unavailable');
});

test('P5 撤销：采用前保存上一版本，撤销恢复上一版候选引用与展示补丁', async (t) => {
  const snapshot = await loadSnapshot();
  const userDataDir = tempDir(t, 'undo');
  const first = materializeOnce(t, userDataDir, 'undo-a');
  const secondCandidate = materializeOnce(t, userDataDir, 'undo-b');

  const previousRecord = snapshot.buildFrontendAdoption({
    candidate: first,
    plan: { planId: 'order-warm-home', planVersion: '1.0.0', frontendPack: { id: first.candidateId, version: first.candidateVersion } },
    verification: { static: 'pass', runtime: 'NOT_RUN' },
    adoptedAt: '2026-11-17T00:00:00.000Z',
  });
  const currentRecord = snapshot.buildFrontendAdoption({
    candidate: secondCandidate,
    plan: { planId: 'order-warm-home', planVersion: '1.0.0', frontendPack: { id: secondCandidate.candidateId, version: secondCandidate.candidateVersion } },
    verification: { static: 'pass', runtime: 'PASS' },
    adoptedAt: '2026-11-17T01:00:00.000Z',
    previous: previousRecord,
  });
  assert.strictEqual(currentRecord.previous.candidateId, first.candidateId);

  const undone = snapshot.undoFrontendAdoption(currentRecord);
  assert.strictEqual(undone.restored, true);
  assert.strictEqual(undone.adoption.status, 'adopted');
  assert.strictEqual(undone.adoption.candidateId, first.candidateId);
  assert.strictEqual(undone.undone.candidateId, secondCandidate.candidateId);
  assert.strictEqual(snapshot.undoFrontendAdoption(snapshot.createEmptyFrontendCandidateState()).restored, false);

  // 撤销后存盘：候选引用回到上一版，展示补丁仍在。
  const state = sessionState({ frontendCandidate: undone.adoption });
  const doc = snapshot.toDocument(state, { projectId: first.projectId });
  assert.strictEqual(doc.frontendCandidate.candidateId, first.candidateId);
  assert.deepStrictEqual(doc.presentation.patch, { theme: { primaryColor: '#116644' } });
  assert.strictEqual(snapshot.fromDocument(doc).presentation.patch.theme.primaryColor, '#116644');
});

test('P5 Plan：候选 overlay 已确认才写 frontendPack；未确认/缺失不回落 Base', async (t) => {
  const planModule = await loadPlan();
  const userDataDir = tempDir(t, 'plan');
  const candidate = materializeOnce(t, userDataDir, 'plan');
  const slice = candidateSlice(candidate, { verified: true });

  const built = planModule.buildPlanFromSession(sessionState({ frontendCandidate: slice }));
  assert.deepStrictEqual(built.plan.frontendPack, { id: candidate.candidateId, version: candidate.candidateVersion });
  assert.strictEqual(built.frontendCandidate.status, 'adopted');
  assert.ok(built.warnings.some((item) => item.includes('候选前端')), built.warnings.join(' / '));
  assert.strictEqual(validatePlan(built.plan).ok, true, 'Composer 契约必须接受 frontendPack');

  // 渲染层已确认（verified）→ 导出入口放行。
  const exportable = planModule.buildExportPlanFromSession(sessionState({ frontendCandidate: slice }));
  assert.strictEqual(exportable.ok, true, JSON.stringify(exportable));
  assert.strictEqual(exportable.plan.frontendPack.id, candidate.candidateId);

  // 未确认（重开后未校验）→ 导出入口直接阻断，且 Plan 不带 frontendPack。
  const unverifiedSlice = candidateSlice(candidate, { verified: false });
  const unverifiedPlan = planModule.buildPlanFromSession(sessionState({ frontendCandidate: unverifiedSlice }));
  assert.strictEqual(unverifiedPlan.plan.frontendPack, undefined);
  assert.strictEqual(unverifiedPlan.frontendCandidate.status, 'unavailable');
  const blocked = planModule.buildExportPlanFromSession(sessionState({ frontendCandidate: unverifiedSlice }));
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.code, 'FRONTEND_CANDIDATE_UNVERIFIED');
  assert.strictEqual(blocked.plan, null);

  // 明确 unavailable（缺失/漂移）→ 结构化失败。
  const unavailableSlice = candidateSlice(candidate, { verified: false }, {
    status: 'unavailable',
    issue: { code: 'FRONTEND_CANDIDATE_MISSING', message: '候选 overlay 已不存在' },
  });
  const missing = planModule.buildExportPlanFromSession(sessionState({ frontendCandidate: unavailableSlice }));
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'FRONTEND_CANDIDATE_MISSING');
  assert.strictEqual(missing.plan, null);

  // 没有候选 → 保持与历史完全一致（无 frontendPack，candidate=null）。
  const base = planModule.buildPlanFromSession(sessionState());
  assert.strictEqual(base.plan.frontendPack, undefined);
  assert.strictEqual(base.frontendCandidate, null);
  assert.strictEqual(validatePlan(base.plan).ok, true);
});

test('P5 导出服务：缺 overlay 阻断；带 overlay 只传受控 id 并回传候选状态', async (t) => {
  const service = await loadExportService();
  const calls = [];
  global.window = {
    smartStore: {
      isDesktop: true,
      composerExport: async (payload) => {
        calls.push(payload);
        return {
          ok: true,
          outputPath: 'C:/exports/demo',
          lockDigest: 'sha256:' + 'a'.repeat(64),
          candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0', integrity: 'sha256:' + 'b'.repeat(64), runtimeStatus: 'NOT_RUN', usedOverlay: true },
        };
      },
      composerValidate: async (payload) => { calls.push(payload); return { ok: true, warnings: [] }; },
    },
  };
  t.after(() => { delete global.window; });

  const planWithCandidate = {
    schemaVersion: 'composition.v1',
    planId: 'order-warm-home',
    frontendPack: { id: 'fr-abcdef012345', version: '1.0.0' },
  };
  const overlay = {
    projectId: 'p_p5export',
    runId: 'frun-p5-export',
    attempt: 1,
    candidateId: 'fr-abcdef012345',
    candidateVersion: '1.0.0',
    integrity: 'sha256:' + 'b'.repeat(64),
    runtimeStatus: 'NOT_RUN',
    repairs: 0,
    // 路径类字段绝不能透传
    overlayRoot: 'C:/Users/me/AppData/overlay',
    overlayAbsolute: 'C:/Users/me/AppData/overlay',
  };

  const blocked = await service.exportProject({ parentDir: 'C:/exports', plan: planWithCandidate, projectName: 'demo' });
  assert.strictEqual(blocked.status, 'failed');
  assert.strictEqual(blocked.code, 'FRONTEND_OVERLAY_MISSING');
  assert.strictEqual(calls.length, 0, '缺 overlay 时不应调用主进程导出');

  const mismatched = await service.exportProject({
    parentDir: 'C:/exports',
    plan: planWithCandidate,
    projectName: 'demo',
    candidateOverlay: { ...overlay, candidateId: 'fr-other0000000' },
  });
  assert.strictEqual(mismatched.code, 'FRONTEND_OVERLAY_MISMATCH');
  assert.strictEqual(calls.length, 0);

  const exported = await service.exportProject({
    parentDir: 'C:/exports',
    plan: planWithCandidate,
    projectName: 'demo',
    candidateOverlay: overlay,
  });
  assert.strictEqual(exported.status, 'ok');
  assert.strictEqual(calls.length, 1);
  const sent = calls[0].candidateOverlay;
  assert.deepStrictEqual(Object.keys(sent).sort(), [
    'attempt', 'candidateId', 'candidateVersion', 'integrity', 'projectId', 'repairs', 'runId', 'runtimeStatus',
  ]);
  assert.strictEqual(sent.overlayRoot, undefined);
  assert.strictEqual(sent.overlayAbsolute, undefined);
  const described = service.describeExportCandidate(exported.result);
  assert.strictEqual(described.candidateId, 'fr-abcdef012345');
  assert.match(described.runtimeLabel, /微信验证未完成/);
  assert.strictEqual(described.usedOverlay, true);

  const validated = await service.validatePlan(planWithCandidate, { candidateOverlay: overlay });
  assert.strictEqual(validated.status, 'ok');
  assert.strictEqual(calls[1].candidateOverlay.candidateId, 'fr-abcdef012345');

  // 主进程返回的摘要漂移错误 → 映射为可读中文，不暴露技术细节。
  global.window.smartStore.composerExport = async () => ({ ok: false, code: 'FRONTEND_DIGEST_MISMATCH', message: 'raw internal detail' });
  const drift = await service.exportProject({ parentDir: 'C:/exports', plan: planWithCandidate, projectName: 'demo', candidateOverlay: overlay });
  assert.strictEqual(drift.code, 'FRONTEND_DIGEST_MISMATCH');
  assert.match(drift.message, /摘要/);
  assert.strictEqual(drift.message.includes('raw internal'), false);
});

test('P5 正式导出：Composer 使用同一 overlay，报告与产物都带候选，缺/篡改都被阻断', async (t) => {
  const snapshot = await loadSnapshot();
  const planModule = await loadPlan();
  const userDataDir = tempDir(t, 'userdata');
  const exportParent = tempDir(t, 'exports');
  const candidate = materializeOnce(t, userDataDir, 'export');
  seedAdoption(candidate);
  const slice = candidateSlice(candidate, { verified: true });
  const built = planModule.buildExportPlanFromSession(sessionState({ frontendCandidate: slice }));
  assert.strictEqual(built.ok, true, JSON.stringify(built));

  const created = createComposerIpc({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [exportParent] }) },
    shell: { openPath: async () => '' },
    compose,
    validateComposition,
    userDataDir,
    defaultParentDir: exportParent,
    commitRetryDelays: [1],
    enableCommitFallback: false,
  });
  const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: () => {} } };
  const overlay = {
    projectId: candidate.projectId,
    runId: candidate.runId,
    attempt: candidate.attempt,
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    runtimeStatus: 'NOT_RUN',
    repairs: 0,
  };

  const exported = await created.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: built.plan,
    projectName: 'p5-candidate-export',
    mode: 'development',
    candidateOverlay: overlay,
  });
  assert.strictEqual(exported.ok, true, JSON.stringify(exported));
  assert.strictEqual(exported.candidate.candidateId, candidate.candidateId);
  assert.strictEqual(exported.candidate.usedOverlay, true);
  const outputPath = exported.outputPath;
  const storeConfig = fs.readFileSync(path.join(outputPath, 'config', 'store.generated.js'), 'utf8');
  assert.ok(storeConfig.includes(candidate.candidateId), '产物配置必须引用候选 FrontendPack');
  const report = JSON.parse(fs.readFileSync(path.join(outputPath, 'generation-report.json'), 'utf8'));
  const candidateLine = report.unresolved.find((item) => typeof item === 'string' && item.startsWith('candidate:'));
  assert.ok(candidateLine, JSON.stringify(report.unresolved));
  assert.ok(candidateLine.includes(candidate.candidateId + '@' + candidate.candidateVersion));
  assert.ok(candidateLine.includes('static=pass'));
  assert.ok(candidateLine.includes('runtime=NOT_RUN'));
  const consistency = inspectOutput(outputPath, {
    candidate: { candidateId: candidate.candidateId, candidateVersion: candidate.candidateVersion },
  });
  assert.strictEqual(consistency.ok, true, JSON.stringify(consistency.problems));

  // 缺 overlay → 阻断且不产生新目录。
  const before = fs.readdirSync(exportParent).sort();
  const missing = await created.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: built.plan,
    projectName: 'p5-candidate-missing',
    mode: 'development',
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'FRONTEND_OVERLAY_MISSING');
  assert.deepStrictEqual(fs.readdirSync(exportParent).sort(), before);

  // 伪造候选 id → overlay 与 Plan 不一致。
  const forged = await created.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: built.plan,
    projectName: 'p5-candidate-forged',
    candidateOverlay: { ...overlay, candidateId: 'fr-forged000000' },
  });
  assert.strictEqual(forged.ok, false);
  assert.strictEqual(forged.code, 'FRONTEND_OVERLAY_MISMATCH');

  // 渲染进程尝试传路径 → 只接受受控 id。
  const withPath = await created.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: built.plan,
    projectName: 'p5-candidate-path',
    candidateOverlay: { ...overlay, overlayRoot: 'C:/evil' },
  });
  assert.strictEqual(withPath.ok, false);
  assert.strictEqual(withPath.code, 'FRONTEND_CANDIDATE_INVALID');

  // 篡改 overlay 资产 → 摘要漂移，导出被阻断（不会用 Base 顶替）。
  const manifestFile = path.join(candidate.overlayDir, 'assets', 'frontend-packs', candidate.candidateId, candidate.candidateVersion, 'manifest.json');
  fs.appendFileSync(manifestFile, '\n');
  const drifted = await created.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: built.plan,
    projectName: 'p5-candidate-drift',
    candidateOverlay: overlay,
  });
  assert.strictEqual(drifted.ok, false);
  assert.strictEqual(drifted.code, 'FRONTEND_DIGEST_MISMATCH');
  assert.strictEqual(fs.existsSync(path.join(exportParent, 'p5-candidate-drift')), false);
});

test('P5 产物一致性：期望候选但产物是 Base 时判不一致', async (t) => {
  const planModule = await loadPlan();
  const exportParent = tempDir(t, 'base-export');
  const basePlan = planModule.buildPlanFromSession(sessionState()).plan;
  assert.strictEqual(validatePlan(basePlan).ok, true);
  const result = await compose({
    plan: basePlan,
    parentDir: exportParent,
    projectName: 'base-only',
    mode: 'development',
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const inconsistent = inspectOutput(result.outputPath, {
    candidate: { candidateId: 'fr-abcdef012345', candidateVersion: '1.0.0' },
  });
  assert.strictEqual(inconsistent.ok, false);
  assert.strictEqual(inconsistent.code, 'CANDIDATE_OUTPUT_MISMATCH');
  assert.ok(inconsistent.problems.some((item) => /回落 Base|FrontendPack/.test(item.message)), JSON.stringify(inconsistent.problems));
});

test('P5 项目 IPC：保存剥离越界字段；重开校验摘要，缺失/漂移安全回退', async (t) => {
  const snapshot = await loadSnapshot();
  const userDataDir = tempDir(t, 'project-ipc');
  const candidate = materializeOnce(t, userDataDir, 'ipc');
  const projectId = candidate.projectId;
  const goodDoc = snapshot.toDocument(
    sessionState({ frontendCandidate: candidateSlice(candidate, { verified: true }) }),
    { projectId, createdAt: '2026-11-17T00:00:00.000Z' },
  );

  let savedDoc = null;
  const store = {
    userDataDir,
    loadProject: async () => ({ doc: JSON.parse(JSON.stringify(goodDoc)), assets: [], savedAt: null, bytes: 1, futureVersion: false, recoveredFrom: null, corrupt: false }),
    saveProject: async (_id, doc) => { savedDoc = doc; return { savedAt: 'now', bytes: 1 }; },
  };
  const created = createProjectIpc({
    store,
    assets: {},
    settings: {},
    diagnostics: null,
    probeDevtools: null,
    dialog: {},
    shell: {},
    userDataDir,
  });
  const event = { senderFrame: { url: 'file:///app/index.html' } };

  // 保存：越界/大文本被剥离，只留白名单。
  const dirtyDoc = JSON.parse(JSON.stringify(goodDoc));
  dirtyDoc.frontendCandidate.overlayAbsolute = 'C:/Users/me/AppData/overlay';
  dirtyDoc.frontendCandidate.imageBase64 = 'AAAA'.repeat(3000);
  dirtyDoc.frontendCandidate.rawTrace = { prompt: 'x'.repeat(5000) };
  dirtyDoc.frontendCandidate.issue = { code: 'X', message: 'y'.repeat(1000) };
  const saved = await created.handlers['project:save'](event, { projectId, doc: dirtyDoc });
  assert.strictEqual(saved.ok, true);
  const savedSerialized = JSON.stringify(savedDoc.frontendCandidate);
  assert.strictEqual(savedSerialized.includes('AAAA'), false);
  assert.strictEqual(savedSerialized.includes('C:/'), false);
  assert.strictEqual(savedSerialized.includes('x'.repeat(200)), false);
  assert.strictEqual(savedDoc.frontendCandidate.candidateId, candidate.candidateId);

  // 重开：overlay 完整 → candidateCheck.ok。
  const loaded = await created.handlers['project:load'](event, { projectId });
  assert.strictEqual(loaded.ok, true);
  assert.strictEqual(loaded.data.candidateCheck.ok, true);
  assert.strictEqual(loaded.data.doc.frontendCandidate.status, 'adopted');
  const hydrated = snapshot.fromDocument(loaded.data.doc, { candidateCheck: loaded.data.candidateCheck });
  assert.strictEqual(hydrated.frontendCandidate.verified, true);
  assert.strictEqual(hydrated.frontendCandidateNotice, null);

  // 删除 attempt → 重开回退 unavailable + 提示，磁盘文档不被改写。
  fs.rmSync(candidate.attemptDir, { recursive: true, force: true });
  const missing = await created.handlers['project:load'](event, { projectId });
  assert.strictEqual(missing.ok, true);
  assert.strictEqual(missing.data.candidateCheck.ok, false);
  assert.strictEqual(missing.data.candidateCheck.code, 'FRONTEND_CANDIDATE_MISSING');
  assert.strictEqual(missing.data.doc.frontendCandidate.status, 'unavailable');
  assert.match(missing.data.doc.frontendCandidate.issue.message, /不存在|重新生成/);
  const fallback = snapshot.fromDocument(missing.data.doc, { candidateCheck: missing.data.candidateCheck });
  assert.strictEqual(fallback.frontendCandidate.status, 'unavailable');
  assert.ok(fallback.frontendCandidateNotice);
  assert.strictEqual(goodDoc.frontendCandidate.status, 'adopted', '内存文档回退不得改写磁盘上的原文档');
});

test('P5 主进程白名单与渲染层同形（防漂移）', async (t) => {
  const snapshot = await loadSnapshot();
  const userDataDir = tempDir(t, 'parity');
  const candidate = materializeOnce(t, userDataDir, 'parity');
  const fixture = {
    schemaVersion: 'frontend-candidate-adoption.v1',
    status: 'adopted',
    candidateId: candidate.candidateId,
    candidateVersion: candidate.candidateVersion,
    integrity: candidate.integrity,
    runId: candidate.runId,
    projectId: candidate.projectId,
    attempt: candidate.attempt,
    overlayRelative: candidate.overlayRelative,
    attemptRelative: candidate.attemptRelative,
    registryDigest: candidate.registryDigest,
    plan: { planId: 'order-warm-home', planVersion: '1.0.0', frontendPack: { id: candidate.candidateId, version: candidate.candidateVersion } },
    verification: { static: 'pass', runtime: 'PASS', repairs: 1, screenshots: 2 },
    adoptedAt: '2026-11-17T00:00:00.000Z',
    previous: { status: 'unavailable', issue: { code: 'FRONTEND_CANDIDATE_MISSING', message: '旧候选已清理' } },
    overlayAbsolute: 'C:/abs',
    imageBase64: 'AAAA'.repeat(2000),
  };
  const renderer = snapshot.pickFrontendCandidate(fixture);
  const main = adoption.pickAdoption(fixture);
  assert.deepStrictEqual(main, renderer, '两侧白名单必须完全同形');
});

test('P5 端到端：采用→保存→重开（校验摘要）→正式导出，Plan/候选摘要一致', async (t) => {
  const snapshot = await loadSnapshot();
  const planModule = await loadPlan();
  const userDataDir = tempDir(t, 'e2e-userdata');
  const exportParent = tempDir(t, 'e2e-exports');
  const candidate = materializeOnce(t, userDataDir, 'e2e');
  seedAdoption(candidate);
  const planRef = {
    planId: 'order-warm-home',
    planVersion: '1.0.0',
    frontendPack: { id: candidate.candidateId, version: candidate.candidateVersion },
    baseTemplate: { id: 'ordering-base', version: '1.0.0' },
  };
  const record = snapshot.buildFrontendAdoption({
    candidate,
    plan: planRef,
    verification: { static: 'pass', runtime: 'NOT_RUN', repairs: 0, screenshots: 0, checkedAt: '2026-11-17T00:00:00.000Z' },
    adoptedAt: '2026-11-17T00:00:00.000Z',
  });
  const stateBefore = sessionState({ frontendCandidate: { ...record, verified: true } });
  const planBefore = planModule.buildExportPlanFromSession(stateBefore);
  assert.strictEqual(planBefore.ok, true, JSON.stringify(planBefore));
  const digestBefore = JSON.stringify(planBefore.plan);

  // 保存到 project.json → 模拟落盘再读回。
  const doc = snapshot.toDocument(stateBefore, { projectId: candidate.projectId, createdAt: '2026-11-17T00:00:00.000Z' });
  const diskDoc = JSON.parse(JSON.stringify(doc));

  // 重开：project-ipc 先校验 overlay 摘要，渲染层再用 candidateCheck 恢复。
  const created = createProjectIpc({
    store: {
      userDataDir,
      loadProject: async () => ({ doc: diskDoc, assets: [], savedAt: null, bytes: 1, futureVersion: false, recoveredFrom: null, corrupt: false }),
      saveProject: async () => ({ savedAt: 'now', bytes: 1 }),
    },
    assets: {},
    settings: {},
    diagnostics: null,
    probeDevtools: null,
    dialog: {},
    shell: {},
    userDataDir,
  });
  const loaded = await created.handlers['project:load']({ senderFrame: { url: 'file:///x' } }, { projectId: candidate.projectId });
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.strictEqual(loaded.data.candidateCheck.ok, true);
  const hydrated = snapshot.fromDocument(loaded.data.doc, { candidateCheck: loaded.data.candidateCheck });
  assert.strictEqual(hydrated.frontendCandidate.verified, true);
  assert.strictEqual(hydrated.frontendCandidate.candidateId, candidate.candidateId);

  // 重开后的 Plan 与保存前一致（同一 candidate/plan 引用）。
  const planAfter = planModule.buildExportPlanFromSession(hydrated);
  assert.strictEqual(planAfter.ok, true, JSON.stringify(planAfter));
  assert.strictEqual(JSON.stringify(planAfter.plan), digestBefore, '重开后的 Plan 必须与保存前一致');

  // 正式导出：同一 overlay、同一摘要，产物/报告都带候选。
  const composerIpc = createComposerIpc({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [exportParent] }) },
    shell: { openPath: async () => '' },
    compose,
    validateComposition,
    userDataDir,
    defaultParentDir: exportParent,
    commitRetryDelays: [1],
    enableCommitFallback: false,
  });
  const event = { senderFrame: { url: 'file:///app/index.html' }, sender: { send: () => {} } };
  // 导出前的只读校验也必须用同一 overlay（否则私有 frontendPack 会被当成未登记资产）。
  const validated = await composerIpc.handlers['composer:validate'](event, {
    plan: planAfter.plan,
    candidateOverlay: {
      projectId: candidate.projectId,
      runId: candidate.runId,
      attempt: candidate.attempt,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      integrity: candidate.integrity,
    },
  });
  assert.strictEqual(validated.ok, true, JSON.stringify(validated));
  assert.strictEqual(validated.candidate.candidateId, candidate.candidateId);
  const exported = await composerIpc.handlers['composer:export'](event, {
    parentDir: '__default__',
    plan: planAfter.plan,
    projectName: 'p5-e2e',
    mode: 'development',
    candidateOverlay: {
      projectId: candidate.projectId,
      runId: candidate.runId,
      attempt: candidate.attempt,
      candidateId: candidate.candidateId,
      candidateVersion: candidate.candidateVersion,
      integrity: candidate.integrity,
      runtimeStatus: hydrated.frontendCandidate.verification.runtime,
    },
  });
  assert.strictEqual(exported.ok, true, JSON.stringify(exported));
  assert.strictEqual(exported.candidate.candidateId, candidate.candidateId);
  assert.strictEqual(exported.candidate.integrity, candidate.integrity);
  assert.strictEqual(exported.candidate.runtimeStatus, 'NOT_RUN');
  const consistency = inspectOutput(exported.outputPath, {
    candidate: { candidateId: candidate.candidateId, candidateVersion: candidate.candidateVersion },
  });
  assert.strictEqual(consistency.ok, true, JSON.stringify(consistency.problems));
  const report = JSON.parse(fs.readFileSync(path.join(exported.outputPath, 'generation-report.json'), 'utf8'));
  assert.ok(report.unresolved.some((item) => item.startsWith('candidate:') && item.includes(candidate.candidateId)));
  // 摘要可复核：导出的 lock 与 compose 自算一致，且候选 integrity 未被改写。
  const lock = JSON.parse(fs.readFileSync(path.join(exported.outputPath, 'composition.lock.json'), 'utf8'));
  assert.strictEqual(lock.lockDigest, exported.lockDigest);
  const verifiedOverlay = verifyOverlay({ overlayRoot: candidate.overlayDir });
  assert.strictEqual(verifiedOverlay.ok, true);
  assert.strictEqual(verifiedOverlay.loaded.byKey.get(candidate.candidateId + '@' + candidate.candidateVersion).integrity, candidate.integrity);
});

test('P5 快照体积：常规项目 + 候选记录仍远低于 1 MiB', async (t) => {
  const snapshot = await loadSnapshot();
  const userDataDir = tempDir(t, 'size');
  const candidate = materializeOnce(t, userDataDir, 'size');
  const doc = snapshot.toDocument(
    sessionState({ frontendCandidate: candidateSlice(candidate, { verified: true }) }),
    { projectId: candidate.projectId, createdAt: '2026-11-17T00:00:00.000Z' },
  );
  assert.ok(snapshot.estimateBytes(doc) < 64 * 1024, '项目快照不应被候选记录放大：' + snapshot.estimateBytes(doc));
});
