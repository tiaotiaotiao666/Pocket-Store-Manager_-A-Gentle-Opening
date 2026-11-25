'use strict';

/**
 * t15 独立复核探针（verifier2）。
 * 只读仓库模块，只写 os.tmpdir()；不写仓库任何文件。
 * 目的：用自己的手法复验 E0-W2 的 X4/X5/X6/X7 + F1–F4 行为，而不是引用 t5 自带测试的断言。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = 'E:\\智能开店app';
const load = (relative) => require(path.join(REPO, relative));
const versions = load('desktop/agent-workspace/versions.cjs');
const checksMod = load('desktop/agent-workspace/checks.cjs');
const sourceBundle = load('desktop/agent-workspace/source-bundle.cjs');
const manifestMod = load('desktop/agent-workspace/manifest.cjs');
const sourceFacts = load('scripts/agent-source-facts.cjs');
const { createRunCoordinator } = load('desktop/agent-workspace/run-coordinator.cjs');
const { createDirectWorkspaceRuntime } = load('desktop/agent-workspace/direct-runtime.cjs');
const ipcMod = load('desktop/agent-tools-ipc.cjs');

const PROJECT_ID = 'p_t15probe';
const results = [];
function rec(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail: detail === undefined ? null : detail });
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function mkUserData(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-' + tag + '-'));
  const init = versions.initProject({ userDataDir: dir, projectId: PROJECT_ID });
  if (!init.ok) throw new Error('initProject 失败：' + JSON.stringify(init));
  return dir;
}
function attemptDirOf(userDataDir, run) {
  return path.join(userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', run.runId,
    'turns', run.turnId, 'attempts', run.attemptId);
}
function ctxOf(run) {
  return { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
}
function candidateDigest(attemptDir) {
  const built = manifestMod.buildManifest(path.join(attemptDir, 'candidate'), {});
  return built.ok ? built.manifest.treeDigest : null;
}
function recordingRegistry(userDataDir, calls, runner) {
  const real = checksMod.createCheckRegistry({ userDataDir, ...(runner ? { runner } : {}) });
  return {
    definitions: real.definitions,
    listChecks: real.listChecks,
    verifyWechat: real.verifyWechat,
    runCheck: async (request) => {
      calls.push(request);
      return real.runCheck(request);
    },
  };
}
async function tool(coordinator, ctx, name, args) {
  return coordinator.invokeTool({ ...ctx, tool: name, args: args || {} });
}

/* ------------------------------------------------------------------ */
/* A：真实链路 + 检查主体/证据字段/F1/F3 submit bytes + F4 partial     */
/* ------------------------------------------------------------------ */

async function scenarioA() {
  const userDataDir = mkUserData('a');
  const calls = [];
  let coordinator = null;
  const directRuntime = createDirectWorkspaceRuntime({
    coordinator: () => coordinator,
    credentials: {
      chat: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], model: 'deepseek-chat' }),
    },
  });
  coordinator = createRunCoordinator({
    userDataDir,
    checks: recordingRegistry(userDataDir, calls),
    directRuntime,
    emitProgress: () => {},
  });

  // A01：8 页枚举来自 SourceFacts（同一数组），非法页拒绝
  const pageIdsEqual = JSON.stringify([...sourceBundle.PAGE_IDS]) === JSON.stringify([...sourceFacts.PAGE_IDS]);
  const badPage = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'settings', operation: 'edit-menu', utterance: 'x' });
  rec('A01-page-ids-single-source', pageIdsEqual && badPage.ok === false && badPage.code === 'AGENT_TARGET_PAGE_UNSUPPORTED',
    { pageIds: [...sourceBundle.PAGE_IDS], badPageCode: badPage.code });

  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '把菜单说明行加粗' });
  rec('A01b-startRun-ok', run.ok === true, run.ok ? null : run);
  if (!run.ok) return;
  const ctx = ctxOf(run);
  const attemptDir = attemptDirOf(userDataDir, run);

  // A02：get_context 的 targetPages 是派生结构
  const context = await tool(coordinator, ctx, 'get_context');
  const pages = context.ok ? context.data.targetPages : [];
  rec('A02-get-context-derived', context.ok === true
    && pages.length === 8
    && JSON.stringify(pages.map((p) => p.id)) === JSON.stringify([...sourceFacts.PAGE_IDS])
    && pages.every((p) => typeof p.enabled === 'boolean' && Array.isArray(p.reasons)),
    context.ok ? pages.map((p) => p.id + ':' + p.enabled) : context);

  // A03：模型调 derive / adopt 平台专用工具 → AGENT_TOOL_NOT_ALLOWED
  const deriveAsModel = await tool(coordinator, ctx, 'derive_source_bundle');
  const adoptAsModel = await tool(coordinator, ctx, 'adopt_attempt');
  rec('A03-platform-tools-hidden', deriveAsModel.ok === false && deriveAsModel.code === 'AGENT_TOOL_NOT_ALLOWED'
    && adoptAsModel.code === 'AGENT_TOOL_NOT_ALLOWED', { derive: deriveAsModel.code, adopt: adoptAsModel.code });

  // A04：真实写入（含一行假 source-bundle 清单）
  const original = await tool(coordinator, ctx, 'read_file', { path: 'pages/menu/index.wxml' });
  const patched = original.data.content.replace(/<\/view>\s*$/, '  <view class="t15">E0-W2-T15</view>\n</view>\n');
  const written = await tool(coordinator, ctx, 'write_files', {
    changes: [
      { path: 'pages/menu/index.wxml', content: patched },
      { path: 'source-bundle.json', content: '{"schemaVersion":"evil","files":[{"path":"x","sha256":"y"}]}' },
    ],
  });
  rec('A04-write-ok', written.ok === true && patched !== original.data.content, written.ok ? null : written);

  // A05：source.check 的 root 必须是 attempt 候选树（记录注册表实际收到的请求）
  const sourceCheck = await tool(coordinator, ctx, 'run_check', { checkId: 'source.check' });
  const call0 = calls[0] || {};
  rec('A05-source-check-subject', sourceCheck.ok === true && sourceCheck.data.status === 'PASS'
    && path.resolve(String(call0.root)) === path.resolve(path.join(attemptDir, 'candidate'))
    && call0.exportRoot === undefined
    && call0.subject && call0.subject.kind === 'attempt' && call0.subjectKind === 'attempt',
  { recorded: { root: call0.root, exportRoot: call0.exportRoot, subjectKind: call0.subjectKind }, status: sourceCheck.data && sourceCheck.data.status });

  // A06：证据文件字段（UI 能证明“查的是本次候选”）
  const sourceEvidence = readJson(path.join(attemptDir, 'verification', 'checks', 'source.check.json'));
  const curDigest = candidateDigest(attemptDir);
  rec('A06-evidence-fields', sourceEvidence.checkId === 'source.check'
    && sourceEvidence.status === 'PASS'
    && sourceEvidence.subjectKind === 'attempt'
    && sourceEvidence.attemptId === run.attemptId
    && typeof sourceEvidence.at === 'string' && !Number.isNaN(Date.parse(sourceEvidence.at))
    && Array.isArray(sourceEvidence.issues)
    && sourceEvidence.treeDigest === curDigest,
  { treeDigest: sourceEvidence.treeDigest, curDigest });

  // A07：平台派生覆盖模型写的假清单；派生 shape 与 §4.1 一致
  const bundleFile = path.join(attemptDir, 'candidate', 'source-bundle.json');
  const bundle = readJson(bundleFile);
  const bundleText = fs.readFileSync(bundleFile, 'utf8');
  rec('A07-bundle-derived', bundle.schemaVersion === 'frontend-source-bundle.v1'
    && JSON.stringify(bundle.targetPages) === JSON.stringify(['menu'])
    && /^sha256:[0-9a-f]{64}$/.test(bundle.base.treeSha256)
    && bundle.files.some((f) => f.path === 'pages/menu/index.wxml')
    && Array.isArray(bundle.deleted) && Array.isArray(bundle.components) && Array.isArray(bundle.assets)
    && !bundleText.includes('evil'),
  { targetPages: bundle.targetPages, fileCount: bundle.files.length, base: bundle.base });

  // A08：composer.dry-run 导出到 attempt/verification/dry-run，并登记摘要
  const dryRun = await tool(coordinator, ctx, 'run_check', { checkId: 'composer.dry-run' });
  const call1 = calls[1] || {};
  const exportRoot = path.join(attemptDir, 'verification', 'dry-run');
  const exportedWxml = fs.existsSync(path.join(exportRoot, 'pages', 'menu', 'index.wxml'))
    ? fs.readFileSync(path.join(exportRoot, 'pages', 'menu', 'index.wxml'), 'utf8') : '';
  rec('A08-dryrun-export-tree', dryRun.ok === true && dryRun.data.status === 'PASS'
    && dryRun.data.exportRelative === 'verification/dry-run'
    && /^sha256:[0-9a-f]{64}$/.test(String(dryRun.data.exportTreeDigest))
    && exportedWxml.includes('E0-W2-T15')
    && path.resolve(String(call1.root)) === path.resolve(path.join(attemptDir, 'candidate'))
    && path.resolve(String(call1.exportParentDir)) === path.resolve(path.join(attemptDir, 'verification')),
  { exportRelative: dryRun.data && dryRun.data.exportRelative, treeHasMarker: exportedWxml.includes('E0-W2-T15'), recorded: { root: call1.root, exportParentDir: call1.exportParentDir } });

  // A09：mini.check/output.consistency 只查这棵派生导出树
  const mini = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check' });
  const consist = await tool(coordinator, ctx, 'run_check', { checkId: 'output.consistency' });
  const call2 = calls[2] || {};
  const miniEvidence = readJson(path.join(attemptDir, 'verification', 'checks', 'mini.check.json'));
  rec('A09-export-scoped', mini.ok === true && mini.data.status === 'PASS'
    && consist.ok === true && consist.data.status === 'PASS'
    && path.resolve(String(call2.exportRoot)) === path.resolve(exportRoot)
    && String(call2.exportRoot).toLowerCase().indexOf(path.join(REPO, 'miniprogram').toLowerCase()) === -1
    && miniEvidence.exportTreeDigest === dryRun.data.exportTreeDigest,
  { recordedExportRoot: call2.exportRoot, expected: exportRoot, miniDigestEqualsDryRun: miniEvidence.exportTreeDigest === dryRun.data.exportTreeDigest });

  // A10：submit 前后 source-bundle.json 与整棵候选树逐字节不变（F3：submit 不派生）
  const bundleBefore = sha256(fs.readFileSync(bundleFile));
  const digestBefore = candidateDigest(attemptDir);
  const revisionBefore = readJson(path.join(attemptDir, 'attempt.json')).revision;
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu', summary: 't15' });
  const bundleAfter = sha256(fs.readFileSync(bundleFile));
  const digestAfter = candidateDigest(attemptDir);
  const revisionAfter = readJson(path.join(attemptDir, 'attempt.json')).revision;
  rec('A10-submit-no-derive', submitted.ok === true && bundleBefore === bundleAfter
    && digestBefore === digestAfter && revisionBefore === revisionAfter
    && submitted.bundleDerivedAtSubmit === undefined,
  { bundleSame: bundleBefore === bundleAfter, digestSame: digestBefore === digestAfter, revisionBefore, revisionAfter });

  // A11：F1 返回体六项 + exportRelative 是相对路径 + 绑定当前候选树
  const f1Fields = ['candidateId', 'revision', 'treeDigest', 'exportRelative', 'exportTreeDigest', 'targetPage'];
  rec('A11-submit-return-F1', submitted.ok === true
    && f1Fields.every((key) => Object.prototype.hasOwnProperty.call(submitted, key))
    && submitted.status === 'submitted'
    && submitted.candidateId === run.attemptId
    && submitted.treeDigest === digestAfter
    && !path.isAbsolute(String(submitted.exportRelative))
    && submitted.exportTreeDigest === dryRun.data.exportTreeDigest,
  { returned: f1Fields.reduce((acc, key) => { acc[key] = submitted[key]; return acc; }, {}), status: submitted.status });

  // A12：adopt 的 partial 语义（本机 wechat 不可用 → partial 必须显式确认）
  const adoptNoConfirm = coordinator.adoptAttempt({ ...ctx });
  const adoptOk = coordinator.adoptAttempt({ ...ctx, partialConfirmed: true });
  rec('A12-adopt-partial-then-adopt', adoptNoConfirm.ok === false
    && adoptNoConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED'
    && adoptNoConfirm.nextAction === 'confirm-partial'
    && adoptOk.ok === true,
  { noConfirm: adoptNoConfirm.code, nextAction: adoptNoConfirm.nextAction, adoptOk: adoptOk.ok });

  // A13：direct 通道接线后 invokeDirect 不再 AGENT_RUNTIME_TOOL_MISSING
  const directResult = await coordinator.invokeDirect({
    ...ctx,
    request: { messages: [{ role: 'user', content: '你好' }] },
  });
  rec('A13-direct-wired', directResult.ok === true && directResult.code !== 'AGENT_RUNTIME_TOOL_MISSING',
    { ok: directResult.ok, code: directResult.code || null });

  // A14：未接线时该码仍显式
  const run2 = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const unWired = createRunCoordinator({ userDataDir, checks: checksMod.createCheckRegistry({ userDataDir }), directRuntime: null, emitProgress: () => {} });
  const unWiredResult = await unWired.invokeDirect({
    projectId: PROJECT_ID, runId: run2.runId, turnId: run2.turnId, attemptId: run2.attemptId,
    request: { messages: [{ role: 'user', content: '你好' }] },
  });
  rec('A14-direct-unwired-explicit', unWiredResult.ok === false && unWiredResult.code === 'AGENT_RUNTIME_TOOL_MISSING',
    { code: unWiredResult.code });

  fs.rmSync(userDataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* B：F2 先拒后跑 / 错误根负例 / 8 页派生 / F3 / F4 优先级             */
/* ------------------------------------------------------------------ */

async function scenarioB() {
  const userDataDir = mkUserData('b');

  // B01：注册表没有 definitions → AGENT_CHECK_UNKNOWN，runCheck 一次都不被调用
  let blindCalls = 0;
  const blind = createRunCoordinator({
    userDataDir,
    checks: { runCheck: async () => { blindCalls += 1; throw new Error('不得被调用'); }, verifyWechat: async () => ({ ok: false }) },
    directRuntime: null,
    emitProgress: () => {},
  });
  const blindRun = blind.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const blindResult = await tool(blind, ctxOf(blindRun), 'run_check', { checkId: 'capabilities.check' });
  rec('B01-no-definitions-refuse-first', blindResult.ok === false && blindResult.code === 'AGENT_CHECK_UNKNOWN'
    && blindCalls === 0 && /definitions/.test(String(blindResult.message)),
  { code: blindResult.code, blindCalls, message: blindResult.message });

  // B02：definitions 里没有该 checkId → 同样先拒
  let partialCalls = 0;
  const partialRegistry = createRunCoordinator({
    userDataDir,
    checks: {
      definitions: { 'source.check': { subject: 'attempt' } },
      runCheck: async () => { partialCalls += 1; return { ok: true, status: 'PASS', issues: [], durationMs: 1 }; },
      verifyWechat: async () => ({ ok: false }),
    },
    directRuntime: null,
    emitProgress: () => {},
  });
  const partialRun = partialRegistry.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const unknownId = await tool(partialRegistry, ctxOf(partialRun), 'run_check', { checkId: 'mini.check' });
  rec('B02-missing-definition-refuse-first', unknownId.ok === false && unknownId.code === 'AGENT_CHECK_UNKNOWN' && partialCalls === 0,
  { code: unknownId.code, calls: partialCalls });

  // B03：导出树级检查缺根 → AGENT_CHECK_UNKNOWN 且 runner 0 次（真实注册表 + 计数 runner）
  let runnerCalls = 0;
  const countingRunner = async () => { runnerCalls += 1; return { ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 1 }; };
  const countingRegistry = checksMod.createCheckRegistry({ userDataDir, runner: countingRunner });
  const coordinator = createRunCoordinator({ userDataDir, checks: countingRegistry, directRuntime: null, emitProgress: () => {} });
  const run = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const ctx = ctxOf(run);
  const attemptDir = attemptDirOf(userDataDir, run);
  const noRoot = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check' });
  rec('B03-export-check-missing-root', noRoot.ok === false && noRoot.code === 'AGENT_CHECK_UNKNOWN' && runnerCalls === 0,
    { code: noRoot.code, runnerCalls });

  // B04：模型给 root/exportRoot → AGENT_PAYLOAD_INVALID 且 runner 0 次
  const forbidden = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check', params: { root: 'E:\\x' } });
  const forbidden2 = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check', params: { exportRoot: 'E:\\x' } });
  rec('B04-model-path-forbidden', forbidden.ok === false && forbidden.code === 'AGENT_PAYLOAD_INVALID'
    && forbidden2.code === 'AGENT_PAYLOAD_INVALID' && runnerCalls === 0,
  { codes: [forbidden.code, forbidden2.code], runnerCalls });

  // B05：错误根负例 —— 伪造 dry-run 证据把导出根指向仓库 miniprogram/（越界）或缺目录 → 必须拒（不回落镜像）
  const write1 = await tool(coordinator, ctx, 'write_files', { changes: [{ path: 'pages/menu/index.wxml', content: '<view>t15-b</view>\n' }] });
  const curDigest = candidateDigest(attemptDir);
  const evidenceFile = path.join(attemptDir, 'verification', 'checks', 'composer.dry-run.json');
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  const forged = (exportRelative) => ({
    checkId: 'composer.dry-run', status: 'PASS', durationMs: 1, treeDigest: curDigest,
    subjectKind: 'attempt', attemptId: run.attemptId, at: new Date().toISOString(),
    issues: [], exportRelative, exportTreeDigest: 'sha256:' + 'a'.repeat(64),
  });
  fs.writeFileSync(evidenceFile, JSON.stringify(forged('../../../../miniprogram')), 'utf8');
  const escapeRoot = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check' });
  fs.writeFileSync(evidenceFile, JSON.stringify(forged('verification/does-not-exist')), 'utf8');
  const missingRoot = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check' });
  fs.writeFileSync(evidenceFile, JSON.stringify(forged('E:\\智能开店app\\miniprogram')), 'utf8');
  const absoluteRoot = await tool(coordinator, ctx, 'run_check', { checkId: 'mini.check' });
  rec('B05-wrong-root-rejected', escapeRoot.code === 'AGENT_CHECK_UNKNOWN'
    && missingRoot.code === 'AGENT_CHECK_UNKNOWN'
    && absoluteRoot.code === 'AGENT_CHECK_UNKNOWN'
    && runnerCalls === 0,
  { escape: escapeRoot.code, missing: missingRoot.code, absolute: absoluteRoot.code, runnerCalls });
  fs.rmSync(evidenceFile, { force: true });

  // B06：8 页 enabled 由候选树派生（删掉 mine 页面文件 → 只有 mine=false + 原因）
  const beforePages = await tool(coordinator, ctx, 'get_context');
  const deleted = await tool(coordinator, ctx, 'delete_files', { paths: [{ path: 'pages/mine/index.wxml' }] });
  const afterPages = await tool(coordinator, ctx, 'get_context');
  const mineAfter = afterPages.ok ? afterPages.data.targetPages.find((p) => p.id === 'mine') : null;
  const othersTrue = afterPages.ok ? afterPages.data.targetPages.filter((p) => p.id !== 'mine').every((p) => p.enabled === true) : false;
  rec('B06-pages-enabled-derived', beforePages.ok === true && beforePages.data.targetPages.every((p) => p.enabled === true)
    && deleted.ok === true && mineAfter && mineAfter.enabled === false
    && mineAfter.reasons.some((reason) => reason.includes('pages/mine/index.wxml'))
    && othersTrue,
  { deleteOk: deleted.ok, deleteCode: deleted.code || null, mine: mineAfter });

  // B07：非 menu 页（checkout）可提交；非法页/与 run 不一致的页拒绝；派生清单记录本次目标页
  const coRun = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'checkout', operation: 'edit-checkout', utterance: 'x' });
  const coCtx = ctxOf(coRun);
  const coDir = attemptDirOf(userDataDir, coRun);
  const coRead = await tool(coordinator, coCtx, 'read_file', { path: 'pages/checkout/index.wxml' });
  const coWrite = await tool(coordinator, coCtx, 'write_files', {
    changes: [{ path: 'pages/checkout/index.wxml', content: coRead.data.content.replace(/<\/view>\s*$/, '  <view class="t15co">T15</view>\n</view>\n') }],
  });
  const coSource = await tool(coordinator, coCtx, 'run_check', { checkId: 'source.check' });
  const coBundle = readJson(path.join(coDir, 'candidate', 'source-bundle.json'));
  const coDry = await tool(coordinator, coCtx, 'run_check', { checkId: 'composer.dry-run' });
  const wrongPage = coordinator.submitAttempt({ ...coCtx, targetPage: 'menu' });
  const illegalPage = coordinator.submitAttempt({ ...coCtx, targetPage: 'settings' });
  const coSubmit = coordinator.submitAttempt({ ...coCtx, targetPage: 'checkout' });
  rec('B07-non-menu-page-submit', coWrite.ok === true && coSource.data.status === 'PASS'
    && JSON.stringify(coBundle.targetPages) === JSON.stringify(['checkout'])
    && coDry.data.status === 'PASS'
    && wrongPage.code === 'AGENT_TARGET_PAGE_UNSUPPORTED'
    && illegalPage.code === 'AGENT_TARGET_PAGE_UNSUPPORTED'
    && coSubmit.ok === true && coSubmit.targetPage === 'checkout',
  { bundlePages: coBundle.targetPages, wrongPage: wrongPage.code, illegalPage: illegalPage.code, submitted: coSubmit.ok });

  // B08：F3 写→检查→再写→submit：AGENT_EVIDENCE_STALE + issue + nextAction，且 submit 不动树
  const sRun = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const sCtx = ctxOf(sRun);
  const sDir = attemptDirOf(userDataDir, sRun);
  await tool(coordinator, sCtx, 'write_files', { changes: [{ path: 'pages/menu/index.wxml', content: '<view>s1</view>\n' }] });
  await tool(coordinator, sCtx, 'run_check', { checkId: 'source.check' });
  await tool(coordinator, sCtx, 'run_check', { checkId: 'composer.dry-run' });
  await tool(coordinator, sCtx, 'run_check', { checkId: 'mini.check' });
  const sBundleFile = path.join(sDir, 'candidate', 'source-bundle.json');
  const sBundleBefore = sha256(fs.readFileSync(sBundleFile));
  const sDigestBefore = candidateDigest(sDir);
  const sRevBefore = readJson(path.join(sDir, 'attempt.json')).revision;
  await tool(coordinator, sCtx, 'write_files', { changes: [{ path: 'pages/menu/index.wxml', content: '<view>s2</view>\n' }] });
  const sBundleBeforeSubmit = sha256(fs.readFileSync(sBundleFile));
  const sRevBeforeSubmit = readJson(path.join(sDir, 'attempt.json')).revision;
  const staleSubmit = coordinator.submitAttempt({ ...sCtx, targetPage: 'menu' });
  const sBundleAfterSubmit = sha256(fs.readFileSync(sBundleFile));
  const sRevAfterSubmit = readJson(path.join(sDir, 'attempt.json')).revision;
  rec('B08-stale-submit', staleSubmit.ok === false
    && staleSubmit.code === 'AGENT_EVIDENCE_STALE'
    && staleSubmit.nextAction === 'rerun-checks'
    && Array.isArray(staleSubmit.issues) && staleSubmit.issues.some((i) => i.code === 'EVIDENCE_STALE_RERUN_CHECKS')
    && sBundleBeforeSubmit === sBundleAfterSubmit
    && sRevBeforeSubmit === sRevAfterSubmit
    && sDigestBefore !== sRevBeforeSubmit,
  { code: staleSubmit.code, nextAction: staleSubmit.nextAction, issues: (staleSubmit.issues || []).map((i) => i.code), bundleSame: sBundleBeforeSubmit === sBundleAfterSubmit, revBeforeSubmit: sRevBeforeSubmit, revAfterSubmit: sRevAfterSubmit });

  // B09：F4 adopt 陈旧优先于 partial（已提交 + 证据陈旧 + 未确认 partial → EVIDENCE_STALE）
  const fRun = coordinator.startRun({ projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: 'x' });
  const fCtx = ctxOf(fRun);
  const fDir = attemptDirOf(userDataDir, fRun);
  await tool(coordinator, fCtx, 'write_files', { changes: [{ path: 'pages/menu/index.wxml', content: '<view>f1</view>\n' }] });
  await tool(coordinator, fCtx, 'run_check', { checkId: 'source.check' });
  await tool(coordinator, fCtx, 'run_check', { checkId: 'composer.dry-run' });
  await tool(coordinator, fCtx, 'run_check', { checkId: 'mini.check' });
  const fSubmit = coordinator.submitAttempt({ ...fCtx, targetPage: 'menu' });
  const submissionFile = path.join(fDir, 'verification', 'submission.json');
  const submission = readJson(submissionFile);
  const submissionOrig = fs.readFileSync(submissionFile, 'utf8');
  submission.treeDigest = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(submissionFile, JSON.stringify(submission), 'utf8');
  const staleAdoptNoConfirm = coordinator.adoptAttempt({ ...fCtx });
  fs.writeFileSync(submissionFile, submissionOrig, 'utf8');
  const dryEvidenceFile = path.join(fDir, 'verification', 'checks', 'composer.dry-run.json');
  const dryOrig = fs.readFileSync(dryEvidenceFile, 'utf8');
  const dryTampered = JSON.parse(dryOrig);
  dryTampered.exportTreeDigest = 'sha256:' + 'b'.repeat(64);
  fs.writeFileSync(dryEvidenceFile, JSON.stringify(dryTampered), 'utf8');
  const staleExportAdoptNoConfirm = coordinator.adoptAttempt({ ...fCtx });
  fs.writeFileSync(dryEvidenceFile, dryOrig, 'utf8');
  const partialNoConfirm = coordinator.adoptAttempt({ ...fCtx });
  const confirmed = coordinator.adoptAttempt({ ...fCtx, partialConfirmed: true });
  rec('B09-adopt-stale-before-partial', fSubmit.ok === true && fSubmit.partial === true
    && staleAdoptNoConfirm.code === 'AGENT_EVIDENCE_STALE'
    && staleAdoptNoConfirm.nextAction === 'rerun-checks'
    && staleExportAdoptNoConfirm.code === 'AGENT_EVIDENCE_STALE'
    && partialNoConfirm.code === 'AGENT_PARTIAL_CONFIRM_REQUIRED'
    && partialNoConfirm.nextAction === 'confirm-partial'
    && confirmed.ok === true,
  { partial: fSubmit.partial, staleTree: staleAdoptNoConfirm.code, staleExport: staleExportAdoptNoConfirm.code, noConfirm: partialNoConfirm.code, confirmed: confirmed.ok });

  fs.rmSync(userDataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* C：IPC 层（adopt-attempt 只转调 Coordinator / run-check 先拒 / F1） */
/* ------------------------------------------------------------------ */

async function scenarioC() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-ipc-'));
  const ipcCalls = [];
  const stubCoordinator = {
    submitAttempt: (payload) => {
      ipcCalls.push({ fn: 'submitAttempt', payload });
      return {
        ok: true, candidateId: payload.attemptId, revision: 7,
        treeDigest: 'sha256:' + 'c'.repeat(64), exportRelative: 'verification/dry-run',
        exportTreeDigest: 'sha256:' + 'd'.repeat(64), targetPage: payload.targetPage,
        status: 'submitted', partial: true,
      };
    },
    adoptAttempt: (payload) => {
      ipcCalls.push({ fn: 'adoptAttempt', payload });
      return {
        ok: false, code: 'AGENT_EVIDENCE_STALE', message: '证据陈旧',
        issues: [{ code: 'EVIDENCE_STALE_RERUN_CHECKS', severity: 'high', message: '重跑检查', source: 'coordinator' }],
        nextAction: 'rerun-checks',
      };
    },
  };
  const fakeChecks = {
    definitions: { 'source.check': { subject: 'attempt' }, 'capabilities.check': { subject: 'repo' } },
    runCheck: async () => { ipcCalls.push({ fn: 'checksRun' }); return { ok: true, status: 'PASS', issues: [], durationMs: 1 }; },
    verifyWechat: async () => ({ ok: false, code: 'AGENT_RUNTIME_TOOL_MISSING' }),
  };
  const ipc = ipcMod.createAgentToolsIpc({ userDataDir, checks: fakeChecks, coordinator: stubCoordinator, emitProgress: () => {} });

  const base = { projectId: PROJECT_ID, runId: 'frun-t15abc', turnId: 'turn-1', attemptId: 'attempt-1' };

  // C01：命令面包含 agent:adopt-attempt（只追加）
  rec('C01-adopt-channel-present', Array.isArray(ipc.commandNames) && ipc.commandNames.includes('agent:adopt-attempt')
    && ipc.commandNames.length === 20,
  { count: ipc.commandNames.length });

  // C02：adopt-attempt 只转调 Coordinator，失败码/nextAction 原样透出
  const adoptRes = await ipc.invoke('agent:adopt-attempt', { ...base, targetPage: 'menu', partialConfirmed: false });
  const adoptCall = ipcCalls.find((c) => c.fn === 'adoptAttempt');
  rec('C02-adopt-delegates', adoptRes.ok === false && adoptRes.code === 'AGENT_EVIDENCE_STALE'
    && adoptRes.nextAction === 'rerun-checks'
    && adoptCall && adoptCall.payload.partialConfirmed === false
    && adoptCall.payload.projectId === PROJECT_ID && adoptCall.payload.attemptId === 'attempt-1',
  { code: adoptRes.code, nextAction: adoptRes.nextAction, delegated: Boolean(adoptCall), payload: adoptCall && adoptCall.payload });

  // C03：未注入 Coordinator → AGENT_RUNTIME_TOOL_MISSING（不静默降级）
  const ipcNoCoordinator = ipcMod.createAgentToolsIpc({ userDataDir, checks: fakeChecks, emitProgress: () => {} });
  const noCoordinator = await ipcNoCoordinator.invoke('agent:adopt-attempt', { ...base, targetPage: 'menu' });
  rec('C03-adopt-no-coordinator', noCoordinator.ok === false && noCoordinator.code === 'AGENT_RUNTIME_TOOL_MISSING',
    { code: noCoordinator.code });

  // C04：IPC run-check 对 attempt/export 级 checkId 先拒（不跑检查）
  const before = ipcCalls.filter((c) => c.fn === 'checksRun').length;
  const ipcRunCheck = await ipc.invoke('agent:run-check', { ...base, checkId: 'source.check' });
  const after = ipcCalls.filter((c) => c.fn === 'checksRun').length;
  rec('C04-ipc-run-check-scoped-refuse', ipcRunCheck.ok === false && ipcRunCheck.code === 'AGENT_CHECK_UNKNOWN' && after === before,
    { code: ipcRunCheck.code, checksRanBefore: before, checksRanAfter: after });

  // C05：submit-candidate 非法页拒绝，且不转调 Coordinator
  const submitBefore = ipcCalls.filter((c) => c.fn === 'submitAttempt').length;
  const badSubmit = await ipc.invoke('agent:submit-candidate', { ...base, targetPage: 'settings' });
  const submitAfter = ipcCalls.filter((c) => c.fn === 'submitAttempt').length;
  rec('C05-submit-illegal-page', badSubmit.ok === false && badSubmit.code === 'AGENT_TARGET_PAGE_UNSUPPORTED' && submitAfter === submitBefore,
    { code: badSubmit.code });

  // C06：submit-candidate 成功时 F1 六项从 Coordinator 透出
  const goodSubmit = await ipc.invoke('agent:submit-candidate', { ...base, targetPage: 'checkout' });
  rec('C06-submit-return-F1', goodSubmit.ok === true
    && goodSubmit.data && goodSubmit.data.exportRelative === 'verification/dry-run'
    && goodSubmit.data.exportTreeDigest === 'sha256:' + 'd'.repeat(64)
    && goodSubmit.data.candidateId === 'attempt-1'
    && goodSubmit.data.status === 'submitted',
  goodSubmit.ok ? goodSubmit.data : goodSubmit);

  // C07：IPC get-context 的 targetPages 形状（记录事实：无 attempt 上下文时全部派生为 false）
  const ctxRes = await ipc.invoke('agent:get-context', { projectId: PROJECT_ID, runId: 'frun-t15abc', turnId: 'turn-1' });
  const pages = ctxRes.ok ? ctxRes.data.targetPages : [];
  rec('C07-ipc-get-context-pages-shape', ctxRes.ok === true && pages.length === 8
    && pages.every((p) => typeof p.id === 'string' && typeof p.enabled === 'boolean' && Array.isArray(p.reasons))
    && pages.every((p) => p.enabled === false),
  { enabled: pages.map((p) => p.id + ':' + p.enabled), exampleReasons: pages[0] && pages[0].reasons });

  fs.rmSync(userDataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* D：静态字节检查（不让“测试绿”替代源码事实）                        */
/* ------------------------------------------------------------------ */

function scenarioD() {
  const read = (relative) => fs.readFileSync(path.join(REPO, relative), 'utf8');
  const checksSrc = read('desktop/agent-workspace/checks.cjs');
  const coordinatorSrc = read('desktop/agent-workspace/run-coordinator.cjs');
  const ipcSrc = read('desktop/agent-tools-ipc.cjs');
  const dispatcherSrc = read('scripts/agent-checks/run-check.cjs');
  const mainSrc = read('desktop/main.cjs');
  const preloadSrc = read('desktop/preload.cjs');

  rec('D01-checks-no-repo-miniprogram-fallback',
    !/path\.join\(\s*REPO_ROOT\s*,\s*['"]miniprogram['"]/.test(checksSrc)
    && !/REPO_ROOT\s*,\s*['"]miniprogram['"]/.test(dispatcherSrc));

  rec('D02-no-v1-target-pages-import',
    !/contract\.generated[^\n]*TARGET_PAGES/.test(coordinatorSrc)
    && !/TARGET_PAGES/.test(coordinatorSrc)
    && !/TARGET_PAGES/.test(ipcSrc));

  rec('D03-dispatcher-no-source-check-derive',
    !/'source\.check'/.test(dispatcherSrc)
    && !/'composer\.dry-run'/.test(dispatcherSrc)
    && /'capabilities\.check'/.test(dispatcherSrc));

  rec('D04-main-direct-wiring',
    /createDirectWorkspaceRuntime\(/.test(mainSrc)
    && /coordinator:\s*\(\)\s*=>\s*workspaceRunCoordinator/.test(mainSrc)
    && /credentials:\s*modelCredentials/.test(mainSrc)
    && !/directRuntime:\s*null/.test(mainSrc)
    && /registerAgentToolsIpc\(/.test(mainSrc)
    && /coordinator:\s*workspaceRunCoordinator/.test(mainSrc));

  rec('D05-preload-adopt-additive',
    /adoptAttempt:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('agent:adopt-attempt',\s*payload\)/.test(preloadSrc)
    && /Object\.freeze\(\{\s*\n\s*getContext/.test(preloadSrc)
    && (preloadSrc.match(/ipcRenderer\.invoke\('agent:/g) || []).length === 20);

  rec('D06-coordinator-submit-no-derive',
    // submitAttempt 函数体内不得出现 deriveAttemptBundle
    (() => {
      const start = coordinatorSrc.indexOf('function submitAttempt(');
      const end = coordinatorSrc.indexOf('function adoptAttempt(');
      const body = coordinatorSrc.slice(start, end);
      return start > 0 && end > start && !body.includes('deriveAttemptBundle') && body.includes('evaluateStaticGate');
    })());

  rec('D07-bundle-page-ids-single-source',
    /const PAGE_IDS = Object\.freeze\(\[\.\.\.sourceFacts\.PAGE_IDS\]\)/.test(read('desktop/agent-workspace/source-bundle.cjs'))
    && !/const PAGE_IDS = Object\.freeze\(\[\s*'home'/.test(read('desktop/agent-workspace/source-bundle.cjs')));
}

/* ------------------------------------------------------------------ */

(async () => {
  const failures = [];
  try {
    await scenarioA();
  } catch (error) {
    rec('A-scenario-error', false, String(error && error.stack || error).slice(0, 600));
  }
  try {
    await scenarioB();
  } catch (error) {
    rec('B-scenario-error', false, String(error && error.stack || error).slice(0, 600));
  }
  try {
    await scenarioC();
  } catch (error) {
    rec('C-scenario-error', false, String(error && error.stack || error).slice(0, 600));
  }
  try {
    scenarioD();
  } catch (error) {
    rec('D-scenario-error', false, String(error && error.stack || error).slice(0, 600));
  }
  for (const item of results) {
    if (!item.ok) failures.push(item.id);
    console.log((item.ok ? 'PASS ' : 'FAIL ') + item.id + (item.ok ? '' : ' :: ' + JSON.stringify(item.detail)));
  }
  console.log('---');
  console.log('TOTAL=' + results.length + ' FAILED=' + failures.length + (failures.length ? ' [' + failures.join(',') + ']' : ''));
  fs.writeFileSync(path.join(__dirname, 'probe-result.json'), JSON.stringify(results, null, 2), 'utf8');
  process.exitCode = failures.length === 0 ? 0 : 1;
})();
