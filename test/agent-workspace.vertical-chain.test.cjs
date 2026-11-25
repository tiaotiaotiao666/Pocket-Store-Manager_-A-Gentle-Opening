'use strict';

/**
 * E0-W2 垂直闭环（X4/X5/X6/X7 一起验收）：**无 UI**，全部经 `WorkspaceRunCoordinator`。
 *
 * 链路（rev15 §14.5）：
 *   init/adopt 基线版本 → startRun（8 页枚举）→ write_files →
 *   run_check source.check（attempt 树）→ run_check composer.dry-run（先平台派生 source-bundle，再 compose）→
 *   run_check mini.check / output.consistency（只查派生导出树）→ submit_candidate（静态门禁 + 摘要绑定）→
 *   adoptAttempt（B2 + 证据绑定，partial 必须显式确认）→ 版本/undo/redo/reopen/导出同源。
 *
 * 断言重点：
 * - `source-bundle.json` 由平台派生并落进候选树；模型调不到派生工具、也写不了清单；
 * - 证据只认 attempt/导出树主体；改一行后旧证据立刻变陈旧（门禁拒绝，不是“看起来还行”）；
 * - 采用后的版本内容与候选树同源（导出树摘要一致），导出走真实 Composer。
 *
 * 只写 os.tmpdir()；不写 templates/miniprogram/contracts。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const h = require('./agent-workspace.helpers.cjs');

const REPO = h.REPO;
const PROJECT_ID = 'p_e0w2chain';
const SOURCE_BUNDLE_MODULE = path.join(REPO, 'desktop', 'agent-workspace', 'source-bundle.cjs');

/** rev15 §9.1 + §14.9 冻结的 progress stage 白名单（测试侧独立列出，防止实现偷偷加名字）。 */
const PROGRESS_STAGE_WHITELIST = Object.freeze([
  'analyze', 'read-context', 'plan', 'edit', 'write', 'materialize', 'validate', 'render',
  'workspace', 'verify', 'compose', 'mini-check', 'consistency', 'observable', 'wechat',
  'repair', 'adopt', 'done', 'queue', 'image', 'bundle', 'submit',
]);

const versionsMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'versions.cjs'));
const workspaceMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'workspace.cjs'));
const manifestMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'manifest.cjs'));
const checksMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'));
const sourceBundle = require(SOURCE_BUNDLE_MODULE);
const { createRunCoordinator, PROGRESS_STAGES } = require(path.join(REPO, 'desktop', 'agent-workspace', 'run-coordinator.cjs'));
const toolsIpc = require(path.join(REPO, 'desktop', 'agent-tools-ipc.cjs'));

function userData(t) {
  const dir = h.userDataWith(t, 'chain');
  const init = versionsMod.initProject({ userDataDir: dir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, JSON.stringify(init));
  return dir;
}

function coordinatorFor(userDataDir, extra) {
  const events = [];
  const opts = extra || {};
  const coordinator = createRunCoordinator({
    userDataDir,
    checks: checksMod.createCheckRegistry({ userDataDir, ...(opts.runner ? { runner: opts.runner } : {}) }),
    directRuntime: null,
    emitProgress: (payload) => events.push(payload),
  });
  return { coordinator, events };
}

function attemptDirOf(userDataDir, run) {
  return path.join(
    userDataDir, 'projects', PROJECT_ID, 'agent-workspace',
    'runs', run.runId, 'turns', run.turnId, 'attempts', run.attemptId,
  );
}

function ctxOf(run) {
  return {
    projectId: PROJECT_ID,
    runId: run.runId,
    turnId: run.turnId,
    attemptId: run.attemptId,
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 往菜单页追加一段可辨认的改动（真实 write_files 事务）。 */
async function writeMenuNote(coordinator, ctx, note) {
  const original = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  assert.strictEqual(original.ok, true, JSON.stringify(original));
  const patched = original.data.content.replace(/<\/view>\s*$/, `  <view class="menu-note">${note}</view>\n</view>\n`);
  assert.notStrictEqual(patched, original.data.content, '必须真的改动目标页');
  const written = await coordinator.invokeTool({
    ...ctx,
    tool: 'write_files',
    args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
}

/** 跑齐 submit 门禁所需的两条检查（source.check + composer.dry-run）。 */
async function runGateChecks(coordinator, ctx) {
  const sourceCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(sourceCheck.data.status, 'PASS', JSON.stringify(sourceCheck.data.issues.slice(0, 3)));
  const dryRun = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  assert.strictEqual(dryRun.data.status, 'PASS', JSON.stringify(dryRun.data.issues.slice(0, 3)));
  const miniCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(miniCheck.data.status, 'PASS', JSON.stringify(miniCheck.data.issues.slice(0, 3)));
  const consistency = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'output.consistency' } });
  assert.strictEqual(consistency.data.status, 'PASS', JSON.stringify(consistency.data.issues.slice(0, 3)));
  return { sourceCheck, dryRun, miniCheck, consistency };
}

/** 建一个可提交的 attempt：startRun → 真实写入 → source.check + composer.dry-run。 */
async function buildSubmittable(userDataDir, coordinator, targetPage) {
  const run = coordinator.startRun({
    projectId: PROJECT_ID,
    targetPage: targetPage || 'menu',
    operation: 'edit-menu',
    utterance: '改菜单页',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = ctxOf(run);
  await writeMenuNote(coordinator, ctx, 'repair-' + run.attemptId);
  const checks = await runGateChecks(coordinator, ctx);
  return { run, ctx, checks, attemptDir: attemptDirOf(userDataDir, run) };
}

test('E0-W2 垂直闭环：写入 → 派生 → 检查 → 提交 → 采用 → 版本同源（真实 Composer）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator, events } = coordinatorFor(userDataDir);

  /* 1. 8 页枚举（X5）：startRun 只接受 SourceFacts 的 8 页，get_context 回同一枚举。 */
  assert.deepStrictEqual([...sourceBundle.PAGE_IDS], [
    'home', 'menu', 'checkout', 'orders', 'order-detail', 'product-detail', 'mine', 'merchant-orders',
  ]);
  for (const bad of ['settings', 'home2', '', 'MENU', 'pages/menu']) {
    const rejected = coordinator.startRun({
      projectId: PROJECT_ID, targetPage: bad, operation: 'edit-menu', utterance: '改菜单页',
    });
    assert.strictEqual(rejected.ok, false, bad);
    assert.strictEqual(rejected.code, 'AGENT_TARGET_PAGE_UNSUPPORTED', bad);
  }

  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '把菜单页的说明行加粗',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = ctxOf(run);

  const context = await coordinator.invokeTool({ ...ctx, tool: 'get_context', args: {} });
  assert.strictEqual(context.ok, true, JSON.stringify(context));
  assert.deepStrictEqual(context.data.targetPages.map((page) => page.id), [...sourceBundle.PAGE_IDS]);
  assert.strictEqual(context.data.targetPages.length, 8);
  for (const page of context.data.targetPages) {
    assert.strictEqual(typeof page.enabled, 'boolean', page.id);
    assert.ok(Array.isArray(page.reasons));
    assert.notStrictEqual(page.enabled, undefined);
  }
  assert.ok(context.data.targetPages.every((page) => page.enabled === true), '基线候选树里 8 页 index.json/index.wxml 齐全');

  /* 2. 平台专用派生工具：模型调不到（X6 的“模型永不调用派生”）。 */
  const deriveAsModel = await coordinator.invokeTool({ ...ctx, tool: 'derive_source_bundle', args: {} });
  assert.strictEqual(deriveAsModel.ok, false);
  assert.strictEqual(deriveAsModel.code, 'AGENT_TOOL_NOT_ALLOWED');
  const modelWritesBundle = await coordinator.invokeTool({
    ...ctx,
    tool: 'write_files',
    args: { changes: [{ path: 'source-bundle.json', content: '{"schemaVersion":"evil"}' }] },
  });
  // 清单只能由平台派生，模型写入必须在事务前拒绝。
  assert.strictEqual(modelWritesBundle.ok, false, JSON.stringify(modelWritesBundle));
  assert.strictEqual(modelWritesBundle.code, 'AGENT_PAYLOAD_INVALID');
  const modelDeletesBundle = await coordinator.invokeTool({
    ...ctx,
    tool: 'delete_files',
    args: { paths: [{ path: 'source-bundle.json' }] },
  });
  assert.strictEqual(modelDeletesBundle.ok, false, JSON.stringify(modelDeletesBundle));
  assert.strictEqual(modelDeletesBundle.code, 'AGENT_PAYLOAD_INVALID');

  /* 3. 真实写入目标页（读 → 改 → 写完整内容）。 */
  const original = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  assert.strictEqual(original.ok, true, JSON.stringify(original));
  const patched = original.data.content.replace(/<\/view>\s*$/, '  <view class="menu-note">E0-W2</view>\n</view>\n');
  assert.notStrictEqual(patched, original.data.content, '必须真的改动目标页');
  const written = await coordinator.invokeTool({
    ...ctx,
    tool: 'write_files',
    args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));
  const attemptDir = attemptDirOf(userDataDir, run);
  assert.ok(fs.existsSync(path.join(attemptDir, 'candidate', 'pages', 'menu', 'index.wxml')));

  /* 4. source.check：真跑在 attempt 候选树上；平台顺手派生 source-bundle（模型写的假清单被覆盖）。 */
  const sourceCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(sourceCheck.ok, true, JSON.stringify(sourceCheck));
  assert.strictEqual(sourceCheck.data.status, 'PASS', JSON.stringify(sourceCheck.data.issues.slice(0, 3)));
  assert.strictEqual(sourceCheck.data.subjectKind, 'attempt');
  // 验收 11：run_check.data 必须含 {checkId,status,treeDigest|exportTreeDigest,subjectKind,attemptId,at,issues[]}
  assert.strictEqual(sourceCheck.data.checkId, 'source.check');
  assert.strictEqual(sourceCheck.data.attemptId, run.attemptId);
  assert.ok(typeof sourceCheck.data.at === 'string' && !Number.isNaN(Date.parse(sourceCheck.data.at)), String(sourceCheck.data.at));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(String(sourceCheck.data.treeDigest)));
  assert.ok(Array.isArray(sourceCheck.data.issues));
  const bundleFile = path.join(attemptDir, 'candidate', 'source-bundle.json');
  assert.ok(fs.existsSync(bundleFile), '平台必须派生 source-bundle.json 进候选树');
  const bundle = readJson(bundleFile);
  assert.strictEqual(bundle.schemaVersion, 'frontend-source-bundle.v1');
  assert.deepStrictEqual(bundle.targetPages, ['menu']);
  assert.ok(bundle.files.some((file) => file.path === 'pages/menu/index.wxml'), JSON.stringify(bundle.files));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(bundle.base.treeSha256), bundle.base.treeSha256);
  assert.ok(!String(JSON.stringify(bundle)).includes('evil'), '模型不得写入假清单');

  /* 5. composer.dry-run：真实 Composer 导出到 attempt/verification/dry-run，并登记导出树摘要。 */
  const dryRun = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  assert.strictEqual(dryRun.ok, true, JSON.stringify(dryRun));
  assert.strictEqual(dryRun.data.status, 'PASS', JSON.stringify(dryRun.data.issues.slice(0, 3)));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(String(dryRun.data.exportTreeDigest)), String(dryRun.data.exportTreeDigest));
  assert.strictEqual(dryRun.data.exportRelative, 'verification/dry-run');
  const exportRoot = path.join(attemptDir, 'verification', 'dry-run');
  assert.ok(fs.existsSync(path.join(exportRoot, 'app.json')), '导出树必须真实存在');
  const exportedWxml = fs.readFileSync(path.join(exportRoot, 'pages', 'menu', 'index.wxml'), 'utf8');
  assert.ok(exportedWxml.includes('E0-W2'), '导出树必须包含本次候选改动（不是仓库镜像）');

  /* 6. 导出树级检查：只认这段派生导出（不是 miniprogram/ 镜像）。 */
  const miniCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(miniCheck.data.status, 'PASS', JSON.stringify(miniCheck.data.issues.slice(0, 3)));
  assert.strictEqual(miniCheck.data.subjectKind, 'export');
  const consistency = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'output.consistency' } });
  assert.strictEqual(consistency.data.status, 'PASS', JSON.stringify(consistency.data.issues.slice(0, 3)));
  // 证据文件落盘且有导出树绑定。
  const dryEvidence = readJson(path.join(attemptDir, 'verification', 'checks', 'composer.dry-run.json'));
  assert.strictEqual(dryEvidence.exportRelative, 'verification/dry-run');
  assert.strictEqual(dryEvidence.exportTreeDigest, dryRun.data.exportTreeDigest);
  assert.strictEqual(dryEvidence.treeDigest, dryRun.data.treeDigest);
  const miniEvidence = readJson(path.join(attemptDir, 'verification', 'checks', 'mini.check.json'));
  assert.strictEqual(miniEvidence.exportTreeDigest, dryRun.data.exportTreeDigest, 'mini.check 必须绑定同一次导出树');

  /* 7. 模型给平台字段一律拒绝：params.root/exportRoot（X4 的“模型给路径即非法”）。 */
  for (const params of [{ root: exportRoot }, { exportRoot }, { attempt: 'attempt-1' }, { versionId: 'v1' }]) {
    const rejected = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check', params } });
    assert.strictEqual(rejected.ok, false, JSON.stringify(params));
    assert.strictEqual(rejected.code, 'AGENT_PAYLOAD_INVALID', JSON.stringify(params));
  }

  /* 8. 提交 + 证据绑定（F1 返回体 / F3 不派生）：提交后再改一行 → AGENT_EVIDENCE_STALE + rerun-checks。 */
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu', summary: 'E0-W2 闭环' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  assert.strictEqual(submitted.status, 'submitted');
  // F-T5-05：本机 wechat.verify 恒 BLOCKED/NOT_RUN → 提交必然 partial（partial ≠ 通过），必须钉死。
  assert.strictEqual(submitted.partial, true, 'wechat.verify BLOCKED/NOT_RUN → partial 必须为 true');
  // F1：成功返回体固定含六项 + 相对路径的 exportRelative。
  assert.strictEqual(submitted.candidateId, run.attemptId);
  assert.ok(Number.isInteger(submitted.revision) && submitted.revision >= 1, String(submitted.revision));
  assert.strictEqual(submitted.treeDigest, consistency.data.treeDigest);
  assert.strictEqual(submitted.targetPage, 'menu');
  assert.strictEqual(submitted.exportRelative, 'verification/dry-run');
  assert.strictEqual(submitted.exportTreeDigest, dryRun.data.exportTreeDigest);
  assert.ok(!path.isAbsolute(String(submitted.exportRelative)), 'exportRelative 必须是相对路径');
  // F3：submit 不得派生/改树 —— 提交前后候选树摘要一致，且不再有 bundle* 字段。
  assert.strictEqual(submitted.treeDigest, consistency.data.treeDigest);
  assert.strictEqual(submitted.bundleDerivedAtSubmit, undefined);
  const submission = readJson(path.join(attemptDir, 'verification', 'submission.json'));
  assert.strictEqual(submission.treeDigest, submitted.treeDigest);
  assert.strictEqual(submission.exportTreeDigest, dryRun.data.exportTreeDigest);
  assert.strictEqual(submission.exportRelative, 'verification/dry-run');
  assert.ok(Array.isArray(submission.checks) && submission.checks.some((check) => check.checkId === 'source.check'));

  // 未显式确认 partial（wechat.verify BLOCKED/NOT_RUN）→ 必须拒绝，不允许默默采用（F4：新鲜度先过）。
  const adoptWithoutConfirm = coordinator.adoptAttempt({ ...ctx });
  assert.strictEqual(adoptWithoutConfirm.ok, false, JSON.stringify(adoptWithoutConfirm));
  assert.strictEqual(adoptWithoutConfirm.code, 'AGENT_PARTIAL_CONFIRM_REQUIRED');
  assert.strictEqual(adoptWithoutConfirm.nextAction, 'confirm-partial');

  /* 9. 采用（B2 adoptAttempt）：版本内容与候选同源。 */
  const adopted = coordinator.adoptAttempt({ ...ctx, partialConfirmed: true });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.ok(/^v/.test(String(adopted.adoptedVersionId)), String(adopted.adoptedVersionId));
  assert.strictEqual(adopted.treeDigest, submitted.treeDigest);

  const state = coordinator.getAttemptState({ ...ctx });
  assert.strictEqual(state.ok, true, JSON.stringify(state));
  assert.ok(['submitted', 'adopted'].includes(state.status), state.status);
  // 证据链完整：source.check/composer.dry-run/mini.check/output.consistency 都在。
  const evidenceIds = state.verification.checks.map((entry) => entry.checkId);
  for (const checkId of ['source.check', 'composer.dry-run', 'mini.check', 'output.consistency']) {
    assert.ok(evidenceIds.includes(checkId), checkId + ' 证据缺失');
  }
  assert.strictEqual(state.verification.submission.treeDigest, submitted.treeDigest);

  /* 10. 版本/undo/redo/reopen 同源 + 导出同源。 */
  const reopened = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopened.ok, true, JSON.stringify(reopened));
  assert.strictEqual(reopened.currentVersionId, adopted.adoptedVersionId);

  const adoptedSource = versionsMod.resolveVersionSource({
    userDataDir, projectId: PROJECT_ID, versionId: adopted.adoptedVersionId,
  });
  assert.strictEqual(adoptedSource.ok, true, JSON.stringify(adoptedSource));
  const versionManifest = manifestMod.buildManifest(adoptedSource.sourceRoot, { limits: undefined });
  assert.strictEqual(versionManifest.ok, true, JSON.stringify(versionManifest));
  const candidateManifest = manifestMod.buildManifest(path.join(attemptDir, 'candidate'), { limits: undefined });
  assert.strictEqual(candidateManifest.ok, true, JSON.stringify(candidateManifest));
  assert.strictEqual(versionManifest.manifest.treeDigest, candidateManifest.manifest.treeDigest, '采用版本必须与候选树逐字节同源');

  const undo = versionsMod.undoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(undo.ok, true, JSON.stringify(undo));
  const redo = versionsMod.redoVersion({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(redo.ok, true, JSON.stringify(redo));
  const reopenedAgain = versionsMod.reopenProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(reopenedAgain.ok, true);
  assert.strictEqual(reopenedAgain.currentVersionId, adopted.adoptedVersionId);

  /* 11. 进度事件只用白名单 stage，且不泄漏路径/源码。 */
  assert.ok(events.length > 0);
  assert.deepStrictEqual([...PROGRESS_STAGES].sort(), [...PROGRESS_STAGE_WHITELIST].sort(),
    'PROGRESS_STAGES 必须与 rev15 §9.1+§14.9 冻结白名单一致');
  for (const event of events) {
    // F-T5-04：stage 必须真的在白名单内；不得用 `|| typeof stage === 'string'` 让断言恒真。
    assert.ok(PROGRESS_STAGE_WHITELIST.includes(event.stage), 'stage 不在白名单：' + String(event.stage));
    assert.ok(!String(event.message).includes(REPO));
    assert.ok(!String(event.message).includes(userDataDir));
  }
  assert.ok(events.some((event) => event.stage === 'bundle'), '派生应发出 bundle 进度');
  assert.ok(events.some((event) => event.stage === 'submit'), '提交应发出 submit 进度');
});

test('E0-W2 / F2：缺 subject 绑定或导出根时先拒后跑（runner 调用次数必须为 0）', async (t) => {
  const userDataDir = userData(t);
  const calls = [];
  const countingRunner = async (request) => {
    calls.push(request);
    return { ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 1 };
  };

  // (a) 注册表没有 definitions → 平台无法确认主体 → AGENT_CHECK_UNKNOWN，且一次都不跑。
  const blindRegistry = { runCheck: async () => { throw new Error('不应被调用'); }, verifyWechat: async () => ({ ok: false }) };
  const blind = createRunCoordinator({
    userDataDir,
    checks: blindRegistry,
    directRuntime: null,
    emitProgress: () => {},
  });
  const blindRun = blind.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单',
  });
  assert.strictEqual(blindRun.ok, true, JSON.stringify(blindRun));
  const blindResult = await blind.invokeTool({
    projectId: PROJECT_ID, runId: blindRun.runId, turnId: blindRun.turnId, attemptId: blindRun.attemptId,
    tool: 'run_check', args: { checkId: 'capabilities.check' },
  });
  assert.strictEqual(blindResult.ok, false, JSON.stringify(blindResult));
  assert.strictEqual(blindResult.code, 'AGENT_CHECK_UNKNOWN');
  assert.ok(/definitions/.test(String(blindResult.message)), String(blindResult.message));

  // (b) definitions 里没有这个 checkId → 同样先拒。
  const partialRegistry = {
    definitions: { 'source.check': { subject: 'attempt' } },
    runCheck: async () => { throw new Error('不应被调用'); },
    verifyWechat: async () => ({ ok: false }),
  };
  const partial = createRunCoordinator({ userDataDir, checks: partialRegistry, directRuntime: null, emitProgress: () => {} });
  const partialRun = partial.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单',
  });
  assert.strictEqual(partialRun.ok, true, JSON.stringify(partialRun));
  const partialCtx = { projectId: PROJECT_ID, runId: partialRun.runId, turnId: partialRun.turnId, attemptId: partialRun.attemptId };
  const unknownCheck = await partial.invokeTool({ ...partialCtx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(unknownCheck.ok, false);
  assert.strictEqual(unknownCheck.code, 'AGENT_CHECK_UNKNOWN');

  // (c) 真实注册表 + 计数 runner：导出树级检查在缺 dry-run 证据时 AGENT_CHECK_UNKNOWN，runner 调用 0 次。
  const { coordinator } = coordinatorFor(userDataDir, { runner: countingRunner });
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = { projectId: PROJECT_ID, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  calls.length = 0;
  const noRoot = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(noRoot.ok, false, JSON.stringify(noRoot));
  assert.strictEqual(noRoot.code, 'AGENT_CHECK_UNKNOWN');
  assert.strictEqual(calls.length, 0, '缺导出根时不得调用 runner');
  const attemptCheckMissingId = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'no.such.check' } });
  assert.strictEqual(attemptCheckMissingId.code, 'AGENT_CHECK_UNKNOWN');
  assert.strictEqual(calls.length, 0);
  // 仓库级检查仍然可以跑（只有它没有 attempt/export 主体）。
  const repoCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'capabilities.check' } });
  assert.strictEqual(repoCheck.ok, true, JSON.stringify(repoCheck));
  assert.strictEqual(calls.length, 1, '仓库级检查应恰好调用 runner 一次');
});

test('E0-W2 / §14.12-Q2：projectId ↔ 私有根强一致（伪造/搬迁 → 明确拒绝且零落盘）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单文案',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = ctxOf(run);
  const attemptDir = attemptDirOf(userDataDir, run);
  const before = manifestMod.buildManifest(path.join(attemptDir, 'candidate'), { limits: undefined });
  assert.strictEqual(before.ok, true, JSON.stringify(before));

  // (1) 伪造 projectId（该名下没有这个 run）→ fail-closed 的 RUN_NOT_FOUND，绝不跨项目猜目录。
  const foreign = await coordinator.invokeTool({
    ...ctx, projectId: 'p_other9999', tool: 'write_files',
    args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }] },
  });
  assert.strictEqual(foreign.ok, false, JSON.stringify(foreign));
  assert.strictEqual(foreign.code, 'AGENT_RUN_NOT_FOUND');

  // (1b) 搬迁/伪造私有根：把 run 目录复制到另一个合法 projectId 下，再按那个 projectId 调用
  //      → run.json 里的 projectId 与句柄不一致 → AGENT_PROJECT_MISMATCH（且不写任何东西）。
  const otherProjectId = 'p_other0001';
  const otherInit = versionsMod.initProject({ userDataDir, projectId: otherProjectId });
  assert.strictEqual(otherInit.ok, true, JSON.stringify(otherInit));
  const otherOpened = workspaceMod.openWorkspace({ userDataDir, projectId: otherProjectId });
  assert.strictEqual(otherOpened.ok, true, JSON.stringify(otherOpened));
  const otherRunsDir = otherOpened.workspace.runsDir;
  fs.mkdirSync(otherRunsDir, { recursive: true });
  const sourceRunDir = path.join(workspaceMod.workspacePaths({ userDataDir, projectId: PROJECT_ID }).runsDir, run.runId);
  const hijackRunDir = path.join(otherRunsDir, path.basename(sourceRunDir));
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(src, dst);
      else if (entry.isFile()) fs.copyFileSync(src, dst);
    }
  };
  copyTree(sourceRunDir, hijackRunDir);
  t.after(() => {
    try {
      fs.rmSync(hijackRunDir, { recursive: true, force: true });
    } catch (error) {
      /* noop */
    }
  });
  const mismatched = await coordinator.invokeTool({
    ...ctx, projectId: otherProjectId, tool: 'write_files',
    args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }] },
  });
  assert.strictEqual(mismatched.ok, false, JSON.stringify(mismatched));
  assert.strictEqual(mismatched.code, 'AGENT_PROJECT_MISMATCH');
  // 伪造副本未被写入（零落盘）。
  const hijackedPage = path.join(hijackRunDir, 'turns', run.turnId, 'attempts', run.attemptId, 'candidate', 'pages', 'menu', 'index.wxml');
  assert.ok(!fs.readFileSync(hijackedPage, 'utf8').includes('hijack'), '被拒请求不得写入伪造副本');

  // (2) run 级 vs turn/attempt 级码表（§14.13-5）：runId 非法 → RUN_NOT_FOUND；turn/attempt 伪造 → ATTEMPT_NOT_FOUND。
  const badRun = await coordinator.invokeTool({
    ...ctx, runId: 'frun-does-not-exist', tool: 'get_context', args: {},
  });
  assert.strictEqual(badRun.code, 'AGENT_RUN_NOT_FOUND');
  const badTurn = await coordinator.invokeTool({
    ...ctx, turnId: 'turn-9', tool: 'get_context', args: {},
  });
  assert.strictEqual(badTurn.code, 'AGENT_ATTEMPT_NOT_FOUND');
  const badAttempt = await coordinator.invokeTool({
    ...ctx, attemptId: 'attempt-7', tool: 'get_context', args: {},
  });
  assert.strictEqual(badAttempt.code, 'AGENT_ATTEMPT_NOT_FOUND');

  // (3) 搬迁 run 目录（伪造私有根）：run 不再位于本 projectId 下 → AGENT_RUN_NOT_FOUND，不回退猜测。
  const runDir = path.join(workspaceMod.workspacePaths({ userDataDir, projectId: PROJECT_ID }).runsDir, run.runId);
  const stash = path.join(path.dirname(runDir), 'stashed-run');
  fs.renameSync(runDir, stash);
  t.after(() => {
    try {
      if (fs.existsSync(stash)) fs.renameSync(stash, runDir);
    } catch (error) {
      /* noop */
    }
  });
  const moved = await coordinator.invokeTool({ ...ctx, tool: 'get_context', args: {} });
  assert.strictEqual(moved.ok, false, JSON.stringify(moved));
  assert.strictEqual(moved.code, 'AGENT_RUN_NOT_FOUND');

  // (4) 零落盘：把 run 放回去后，候选树摘要必须与伪造前逐字节一致（没有任何“幽灵写入”）。
  fs.renameSync(stash, runDir);
  const after = manifestMod.buildManifest(path.join(attemptDir, 'candidate'), { limits: undefined });
  assert.strictEqual(after.ok, true, JSON.stringify(after));
  assert.strictEqual(after.manifest.treeDigest, before.manifest.treeDigest, '被拒请求不得改动候选树');
  assert.ok(!fs.readFileSync(path.join(attemptDir, 'candidate', 'pages', 'menu', 'index.wxml'), 'utf8').includes('hijack'));
});

test('E0-W2：非 menu 页（checkout）同样能走完整门禁并提交（8 页一视同仁）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'checkout', operation: 'edit-checkout', utterance: '结算页按钮文案改短',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = ctxOf(run);
  const original = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/checkout/index.wxml' } });
  assert.strictEqual(original.ok, true, JSON.stringify(original));
  const patched = original.data.content.replace(/<\/view>\s*$/, '  <view class="checkout-note">E0-W2</view>\n</view>\n');
  assert.notStrictEqual(patched, original.data.content);
  const written = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/checkout/index.wxml', content: patched }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));

  const sourceCheck = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(sourceCheck.data.status, 'PASS', JSON.stringify(sourceCheck.data.issues.slice(0, 3)));
  const bundle = readJson(path.join(attemptDirOf(userDataDir, run), 'candidate', 'source-bundle.json'));
  assert.deepStrictEqual(bundle.targetPages, ['checkout'], '派生清单必须记录本次目标页');
  const dryRun = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  assert.strictEqual(dryRun.data.status, 'PASS', JSON.stringify(dryRun.data.issues.slice(0, 3)));
  for (const checkId of ['mini.check', 'output.consistency']) {
    const checked = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId } });
    assert.strictEqual(checked.data.status, 'PASS', JSON.stringify(checked.data.issues.slice(0, 3)));
  }

  // 与 run 目标页不一致的页同样被拒（不能拿 checkout 的证据去提交 menu）。
  const wrongPage = coordinator.submitAttempt({ ...ctx, projectId: PROJECT_ID, targetPage: 'menu' });
  assert.strictEqual(wrongPage.ok, false, JSON.stringify(wrongPage));
  assert.strictEqual(wrongPage.code, 'AGENT_TARGET_PAGE_UNSUPPORTED');

  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'checkout' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  assert.strictEqual(submitted.targetPage, 'checkout');
  assert.strictEqual(submitted.exportRelative, 'verification/dry-run');
});

test('E0-W2：提交门禁拒绝“只跑了一半”的候选（缺 dry-run / 缺 source.check）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const run = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单文案',
  });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const ctx = ctxOf(run);
  const attemptDir = attemptDirOf(userDataDir, run);
  const original = await coordinator.invokeTool({ ...ctx, tool: 'read_file', args: { path: 'pages/menu/index.wxml' } });
  assert.strictEqual(original.ok, true);
  const patched = original.data.content.replace(/<\/view>\s*$/, '  <view class="menu-note">half</view>\n</view>\n');
  const written = await coordinator.invokeTool({
    ...ctx, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: patched }] },
  });
  assert.strictEqual(written.ok, true, JSON.stringify(written));

  // 只有 source.check，没有 composer.dry-run → 门禁必须拒绝（AGENT_STATIC_GATE_FAILED）。
  const onlySource = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(onlySource.data.status, 'PASS', JSON.stringify(onlySource.data.issues.slice(0, 3)));
  const blocked = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(blocked.ok, false, JSON.stringify(blocked));
  assert.strictEqual(blocked.code, 'AGENT_STATIC_GATE_FAILED');
  assert.ok(/composer\.dry-run/.test(String(blocked.message)), String(blocked.message));

  // 导出树级检查在没有 dry-run 证据时直接 AGENT_CHECK_UNKNOWN（不猜、不回落镜像）。
  const miniWithoutDryRun = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(miniWithoutDryRun.ok, false, JSON.stringify(miniWithoutDryRun));
  assert.strictEqual(miniWithoutDryRun.code, 'AGENT_CHECK_UNKNOWN');

  // 补上 dry-run 后：source.check 的旧证据因为树变了（新增 source-bundle.json）而自动重跑才通过。
  const dryRun = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  assert.strictEqual(dryRun.data.status, 'PASS', JSON.stringify(dryRun.data.issues.slice(0, 3)));
  const sourceAgain = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(sourceAgain.data.status, 'PASS');

  // 检查通过后再改一行 → 旧证据立刻陈旧：F3 要求 AGENT_EVIDENCE_STALE + EVIDENCE_STALE_RERUN_CHECKS，
  // 而且平台**不得**自动补派生、不得静默放行。
  const secondEdit = await coordinator.invokeTool({
    ...ctx,
    tool: 'write_files',
    args: {
      changes: [{
        path: 'pages/menu/index.wxml',
        content: patched.replace('menu-note">half', 'menu-note">half-again'),
      }],
    },
  });
  assert.strictEqual(secondEdit.ok, true, JSON.stringify(secondEdit));
  const bundleBeforeStaleSubmit = fs.readFileSync(path.join(attemptDir, 'candidate', 'source-bundle.json'), 'utf8');
  const staleSubmit = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(staleSubmit.ok, false, JSON.stringify(staleSubmit));
  assert.strictEqual(staleSubmit.code, 'AGENT_EVIDENCE_STALE');
  assert.strictEqual(staleSubmit.nextAction, 'rerun-checks');
  assert.ok(staleSubmit.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'), JSON.stringify(staleSubmit.issues));
  // F3：submit 完全不碰候选树（清单内容与提交前逐字节相同）。
  assert.strictEqual(
    fs.readFileSync(path.join(attemptDir, 'candidate', 'source-bundle.json'), 'utf8'),
    bundleBeforeStaleSubmit,
    'submit 不得派生/改 source-bundle',
  );
  // 陈旧证据也不能被 adopt 吞掉：adopt 先报陈旧（F4）。
  const staleAdopt = coordinator.adoptAttempt({ ...ctx, partialConfirmed: true });
  assert.strictEqual(staleAdopt.ok, false, JSON.stringify(staleAdopt));
  assert.strictEqual(staleAdopt.code, 'AGENT_ADOPTION_FAILED');

  // 重新跑齐检查（派生是幂等的，dry-run 会重导出）→ 门禁放行。
  const sourceFinal = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'source.check' } });
  assert.strictEqual(sourceFinal.data.status, 'PASS');
  const dryFinal = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
  assert.strictEqual(dryFinal.data.status, 'PASS', JSON.stringify(dryFinal.data.issues.slice(0, 3)));
  for (const checkId of ['mini.check', 'output.consistency']) {
    const checked = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId } });
    assert.strictEqual(checked.data.status, 'PASS', JSON.stringify(checked.data.issues.slice(0, 3)));
  }
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
});

test('E0-W2 / F4 + §14.13-1：已提交 + 篡改/缺失摘要 → AGENT_EVIDENCE_STALE（先于 partial）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const { ctx, run } = await buildSubmittable(userDataDir, coordinator);
  const submitted = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  assert.strictEqual(submitted.partial, true, 'wechat.verify BLOCKED/NOT_RUN → partial');

  const submissionFile = path.join(attemptDirOf(userDataDir, run), 'verification', 'submission.json');
  const original = readJson(submissionFile);

  // (a) F-T5-03：已提交 + 篡改 treeDigest + **未** partialConfirmed → 陈旧，不是 PARTIAL_CONFIRM_REQUIRED。
  fs.writeFileSync(submissionFile, JSON.stringify({ ...original, treeDigest: 'sha256:' + '0'.repeat(64) }, null, 2));
  const tamperedTree = coordinator.adoptAttempt({ ...ctx });
  assert.strictEqual(tamperedTree.ok, false, JSON.stringify(tamperedTree));
  assert.strictEqual(tamperedTree.code, 'AGENT_EVIDENCE_STALE', JSON.stringify(tamperedTree));
  assert.notStrictEqual(tamperedTree.code, 'AGENT_PARTIAL_CONFIRM_REQUIRED');
  assert.strictEqual(tamperedTree.nextAction, 'rerun-checks');
  assert.ok(tamperedTree.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'));

  // (b) F-T5-02：已提交 + 缺 exportTreeDigest（旧格式/伪造）→ 仍必须陈旧，不得跳过导出树校验。
  const withoutDigest = { ...original };
  delete withoutDigest.exportTreeDigest;
  fs.writeFileSync(submissionFile, JSON.stringify(withoutDigest, null, 2));
  const missingDigest = coordinator.adoptAttempt({ ...ctx, partialConfirmed: true });
  assert.strictEqual(missingDigest.ok, false, JSON.stringify(missingDigest));
  assert.strictEqual(missingDigest.code, 'AGENT_EVIDENCE_STALE', JSON.stringify(missingDigest));
  assert.ok(missingDigest.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'));

  // (c) 非字符串 exportTreeDigest 同样按陈旧处理（不静默视为一致）。
  fs.writeFileSync(submissionFile, JSON.stringify({ ...original, exportTreeDigest: 123 }, null, 2));
  const nonStringDigest = coordinator.adoptAttempt({ ...ctx, partialConfirmed: true });
  assert.strictEqual(nonStringDigest.ok, false, JSON.stringify(nonStringDigest));
  assert.strictEqual(nonStringDigest.code, 'AGENT_EVIDENCE_STALE', JSON.stringify(nonStringDigest));
});

test('E0-W2 / F-T5-07：PASS 证据缺 exportTreeDigest → 记 stale（fail-closed，不放行 submit）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const { ctx, attemptDir } = await buildSubmittable(userDataDir, coordinator);
  const mini = await coordinator.invokeTool({ ...ctx, tool: 'run_check', args: { checkId: 'mini.check' } });
  assert.strictEqual(mini.data.status, 'PASS', JSON.stringify(mini.data.issues.slice(0, 3)));
  const evidenceFile = path.join(attemptDir, 'verification', 'checks', 'mini.check.json');
  const evidence = readJson(evidenceFile);
  assert.ok(typeof evidence.exportTreeDigest === 'string', '正常 mini.check 证据必须带导出树摘要');
  delete evidence.exportTreeDigest;
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  const blocked = coordinator.submitAttempt({ ...ctx, targetPage: 'menu' });
  assert.strictEqual(blocked.ok, false, JSON.stringify(blocked));
  assert.strictEqual(blocked.code, 'AGENT_EVIDENCE_STALE', JSON.stringify(blocked));
  assert.ok(blocked.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'));
});

test('E0-W2 / F-T5-01：IPC → 真实 Coordinator 端到端（submit F1 六项 + adopt 三分码）', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const ipc = toolsIpc.createAgentToolsIpc({ userDataDir, coordinator });
  const base = (ctx) => ({
    projectId: PROJECT_ID,
    runId: ctx.runId,
    turnId: ctx.turnId,
    attemptId: ctx.attemptId,
  });

  // 1) 未提交就 adopt → AGENT_ADOPTION_FAILED + issue NOT_SUBMITTED。
  const idleRun = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '未提交就 adopt',
  });
  assert.strictEqual(idleRun.ok, true, JSON.stringify(idleRun));
  const idleAdopt = await ipc.invoke('agent:adopt-attempt', { ...base(ctxOf(idleRun)), targetPage: 'menu' });
  assert.strictEqual(idleAdopt.ok, false, JSON.stringify(idleAdopt));
  assert.strictEqual(idleAdopt.code, 'AGENT_ADOPTION_FAILED', JSON.stringify(idleAdopt));
  assert.ok(idleAdopt.issues.some((issue) => issue.code === 'NOT_SUBMITTED'));

  // 2) 写 → source.check → composer.dry-run → IPC submit：F1 六项 + 相对 exportRelative。
  const first = await buildSubmittable(userDataDir, coordinator);
  const submitted = await ipc.invoke('agent:submit-candidate', {
    ...base(first.ctx), targetPage: 'menu', summary: 'ipc e2e',
  });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  const data = submitted.data;
  assert.strictEqual(data.candidateId, first.ctx.attemptId);
  assert.ok(Number.isInteger(data.revision) && data.revision >= 1, String(data.revision));
  assert.match(String(data.treeDigest), /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(data.exportRelative, 'verification/dry-run');
  assert.match(String(data.exportTreeDigest), /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(data.targetPage, 'menu');
  assert.strictEqual(data.status, 'submitted');
  assert.strictEqual(data.partial, true, 'wechat.verify BLOCKED/NOT_RUN → partial');
  assert.ok(!path.isAbsolute(String(data.exportRelative)));

  // 3) partial 未确认 → PARTIAL_CONFIRM_REQUIRED；确认后 adopt 成功。
  const partial = await ipc.invoke('agent:adopt-attempt', { ...base(first.ctx), targetPage: 'menu' });
  assert.strictEqual(partial.ok, false, JSON.stringify(partial));
  assert.strictEqual(partial.code, 'AGENT_PARTIAL_CONFIRM_REQUIRED');
  assert.strictEqual(partial.nextAction, 'confirm-partial');
  const adopted = await ipc.invoke('agent:adopt-attempt', {
    ...base(first.ctx), targetPage: 'menu', partialConfirmed: true,
  });
  assert.strictEqual(adopted.ok, true, JSON.stringify(adopted));
  assert.match(String(adopted.data.adoptedVersionId), /^v/);

  // 4) 陈旧：第二个 run 提交后篡改 submission.treeDigest → IPC adopt 必须 EVIDENCE_STALE + rerun-checks。
  const second = await buildSubmittable(userDataDir, coordinator);
  const submittedAgain = await ipc.invoke('agent:submit-candidate', { ...base(second.ctx), targetPage: 'menu' });
  assert.strictEqual(submittedAgain.ok, true, JSON.stringify(submittedAgain));
  const submissionFile = path.join(attemptDirOf(userDataDir, second.run), 'verification', 'submission.json');
  const submission = readJson(submissionFile);
  fs.writeFileSync(submissionFile, JSON.stringify({ ...submission, treeDigest: 'sha256:' + '1'.repeat(64) }, null, 2));
  const stale = await ipc.invoke('agent:adopt-attempt', {
    ...base(second.ctx), targetPage: 'menu', partialConfirmed: true,
  });
  assert.strictEqual(stale.ok, false, JSON.stringify(stale));
  assert.strictEqual(stale.code, 'AGENT_EVIDENCE_STALE', JSON.stringify(stale));
  assert.strictEqual(stale.nextAction, 'rerun-checks');
  assert.ok(stale.issues.some((issue) => issue.code === 'EVIDENCE_STALE_RERUN_CHECKS'));
});

test('E0-W2 / OBS-4：legacy 写入不得绕过 submitted 只读；cancel-run 必须落盘 run.json', async (t) => {
  const userDataDir = userData(t);
  const { coordinator } = coordinatorFor(userDataDir);
  const ipc = toolsIpc.createAgentToolsIpc({ userDataDir, coordinator });

  // A) 未提交 run：IPC cancel → 返回 cancelled，且 run.json 与返回一致（不是只改内存）。
  const cancellable = coordinator.startRun({
    projectId: PROJECT_ID, targetPage: 'menu', operation: 'edit-menu', utterance: '取消我',
  });
  assert.strictEqual(cancellable.ok, true, JSON.stringify(cancellable));
  const cancellableFile = path.join(
    userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', cancellable.runId, 'run.json',
  );
  assert.strictEqual(readJson(cancellableFile).state, 'running');
  const cancelled = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: cancellable.runId });
  assert.strictEqual(cancelled.ok, true, JSON.stringify(cancelled));
  assert.strictEqual(cancelled.data.state, 'cancelled');
  assert.strictEqual(cancelled.data.cancelled, true);
  assert.strictEqual(readJson(cancellableFile).state, 'cancelled', 'cancel 必须落盘 run.json');

  // B) 已提交 run：legacy write/delete 必须被 Coordinator 拒绝且零落盘；cancel 是 too-late 且不改盘。
  const submittable = await buildSubmittable(userDataDir, coordinator);
  const submitted = coordinator.submitAttempt({ ...submittable.ctx, targetPage: 'menu' });
  assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
  const attemptDir = attemptDirOf(userDataDir, submittable.run);
  const candidateDir = path.join(attemptDir, 'candidate');
  const before = manifestMod.buildManifest(candidateDir, { limits: undefined });
  assert.strictEqual(before.ok, true, JSON.stringify(before));

  const legacyWrite = await ipc.invoke('agent:write-files', {
    projectId: PROJECT_ID,
    runId: submittable.ctx.runId,
    turnId: submittable.ctx.turnId,
    changes: [{ path: 'pages/menu/index.wxml', content: '<view>hijack</view>' }],
  });
  assert.strictEqual(legacyWrite.ok, false, JSON.stringify(legacyWrite));
  assert.strictEqual(legacyWrite.code, 'AGENT_ATTEMPT_IMMUTABLE', JSON.stringify(legacyWrite));

  const legacyDelete = await ipc.invoke('agent:delete-files', {
    projectId: PROJECT_ID,
    runId: submittable.ctx.runId,
    turnId: submittable.ctx.turnId,
    paths: [{ path: 'pages/menu/index.wxml' }],
  });
  assert.strictEqual(legacyDelete.ok, false, JSON.stringify(legacyDelete));
  assert.strictEqual(legacyDelete.code, 'AGENT_ATTEMPT_IMMUTABLE', JSON.stringify(legacyDelete));

  const after = manifestMod.buildManifest(candidateDir, { limits: undefined });
  assert.strictEqual(after.ok, true, JSON.stringify(after));
  assert.strictEqual(after.manifest.treeDigest, before.manifest.treeDigest, '提交后 legacy 写入/删除必须零落盘');
  assert.ok(!fs.readFileSync(path.join(candidateDir, 'pages', 'menu', 'index.wxml'), 'utf8').includes('hijack'));

  const submittedRunFile = path.join(
    userDataDir, 'projects', PROJECT_ID, 'agent-workspace', 'runs', submittable.run.runId, 'run.json',
  );
  assert.strictEqual(readJson(submittedRunFile).state, 'submitted');
  const lateCancel = await ipc.invoke('agent:cancel-run', { projectId: PROJECT_ID, runId: submittable.run.runId });
  assert.strictEqual(lateCancel.ok, true, JSON.stringify(lateCancel));
  assert.strictEqual(lateCancel.data.state, 'too-late');
  assert.strictEqual(readJson(submittedRunFile).state, 'submitted', '提交后取消不得改盘');
});
