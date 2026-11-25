'use strict';

/**
 * C 组（E0-V1a 增量）：对 **t1 E0-W1 `run-coordinator.cjs`** 的独立执行断言。
 *
 * 判定对象：X1 / X3（桌面侧）。依据：rev15 §14.2（不变量 1–6）、§14.3（工具面）、
 * §14.5（submit/adopt 证据）、§14.9（码与 stage）、§14.12（Q1 三分码 / Q2 句柄一致性）。
 *
 * 纪律：
 *  - 只调用 Coordinator 的公开导出（`createRunCoordinator` 及其返回的方法），不复制任何实现逻辑；
 *  - 需要“检查注册表 / direct 通道”时一律用**注入**方式（`options.checks` / `options.directRuntime`），
 *    因为这两个下游模块属 t5/t6 范围，本任务只判 Coordinator 自己是否把它们接对、把结果用对；
 *  - 每条用例都断言“拒绝 + 具体码 + 目录指纹不变（零落盘）”，不接受“只要 ok:false 就算过”。
 */

const fs = require('node:fs');
const path = require('node:path');

const { assert, assertEqual, assertRejected } = require('../lib/harness.cjs');
const { openProject } = require('../chains/preconditions.cjs');

const COORDINATOR_REQUIRES = ['run-coordinator', 'workspace', 'files', 'manifest', 'versions'];

const TARGET_PAGE = 'menu';
const OPERATION = 'edit-menu';
const UTTERANCE = '把招牌菜改成红烧肉，价格改成 28 元';

/** 建一个项目（v1 = import-base）并返回常用句柄。 */
function setupProject(ctx, projectId) {
  const project = openProject(ctx, projectId);
  const workspacePaths = project.workspace.workspacePaths({ userDataDir: ctx.temp.real, projectId });
  assert(workspacePaths.ok, 'workspacePaths 失败：' + JSON.stringify(workspacePaths.code));
  const versionRead = project.versions.readVersion({ userDataDir: ctx.temp.real, projectId, versionId: 'v1' });
  assert(versionRead.ok, 'readVersion v1 失败：' + JSON.stringify(versionRead.code));
  return {
    ...project,
    paths: workspacePaths,
    v1TreeDigest: versionRead.version.treeDigest,
    runsDir: path.join(workspacePaths.workspaceDir, 'runs'),
  };
}

/** 建 Coordinator 实例（checks / directRuntime 由用例注入）。 */
function newCoordinator(ctx, extra) {
  const mod = ctx.frozen.requireStrict('run-coordinator');
  return mod.createRunCoordinator(Object.assign({ userDataDir: ctx.temp.real }, extra || {}));
}

/**
 * 检查注册表替身：**definitions/listChecks 用真实 `checks.cjs` 的那份**（checkId→subject 是平台表，
 * 不允许验证器自己编），只把“跑子进程”这一步换掉。这样 subject 路由/root 注入/导出树绑定
 * 走的都是产品代码自身的判定。
 */
/** 真实平台表 checkId→subject（来自 `checks.cjs` 的注册表实例）。 */
function realDefinitions(ctx) {
  const mod = ctx.frozen.requireOrNull ? ctx.frozen.requireOrNull('checks') : null;
  if (mod && typeof mod.createCheckRegistry === 'function') {
    const real = mod.createCheckRegistry({});
    if (real && real.definitions) return real.definitions;
  }
  if (mod && mod.CHECK_DEFINITIONS) return mod.CHECK_DEFINITIONS;
  return {};
}

function makeRegistry(ctx, handler) {
  const definitions = realDefinitions(ctx);
  const calls = [];
  return {
    definitions,
    calls,
    hasRealDefinitions: Object.keys(definitions).length > 0,
    async runCheck(request) {
      calls.push({
        checkId: request.checkId,
        root: request.root === undefined ? null : request.root,
        exportRoot: request.exportRoot === undefined ? null : request.exportRoot,
        exportParentDir: request.exportParentDir === undefined ? null : request.exportParentDir,
        subject: request.subject === undefined ? null : request.subject,
        subjectKind: request.subjectKind === undefined ? null : request.subjectKind,
        projectId: request.projectId,
        attemptId: request.attemptId,
        params: request.params,
      });
      return handler(request);
    },
  };
}

/** 直通 PASS 的检查结果（`subjectKind` 由下游注册表声明，Coordinator 只照抄/降级）。 */
function passResult(checkId, subjectKind) {
  return {
    ok: true,
    checkId,
    status: 'PASS',
    durationMs: 1,
    issues: [],
    ...(subjectKind === undefined ? {} : { subjectKind }),
  };
}

/**
 * composer.dry-run 的替身行为：真的在 `exportParentDir` 下产出一棵导出树并给出摘要，
 * 因为 submit 门禁要求 dry-run 证据带“导出根相对引用 + 导出树摘要”（rev15 §14.4/§14.5）。
 */
function dryRunResult(checkId, request, options) {
  const opts = options || {};
  const subjectKind = Object.prototype.hasOwnProperty.call(opts, 'subjectKind') ? opts.subjectKind : 'attempt';
  const exportTreeDigest = opts.exportTreeDigest === undefined ? 'sha256:' + 'd'.repeat(64) : opts.exportTreeDigest;
  const parent = typeof request.exportParentDir === 'string' ? request.exportParentDir : null;
  if (!parent) return passResult(checkId, subjectKind);
  const exportRoot = path.join(parent, 'export-tree');
  fs.mkdirSync(path.join(exportRoot, 'pages', 'menu'), { recursive: true });
  fs.writeFileSync(path.join(exportRoot, 'app.json'), '{"pages":["pages/menu/index"]}\n', 'utf8');
  fs.writeFileSync(path.join(exportRoot, 'pages', 'menu', 'index.js'), '// exported by verifier stub\n', 'utf8');
  return {
    ...passResult(checkId, subjectKind),
    exportedRoot: exportRoot,
    ...(exportTreeDigest === null ? {} : { exportTreeDigest }),
  };
}

/** 让一条 run 走到“可提交”的证据状态（source.check + composer.dry-run 都是 attempt 主体 PASS）。 */
async function driveToSubmittable(ctx, coord, run) {
  const registry = makeRegistry(ctx, (request) => (
    request.checkId === 'composer.dry-run'
      ? dryRunResult(request.checkId, request)
      : passResult(request.checkId, 'attempt')
  ));
  const handle = { projectId: run.projectId === undefined ? undefined : run.projectId, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
  // 重新建实例：注册表在 Coordinator 构造时注入。
  const withChecks = newCoordinator(ctx, { checks: registry });
  for (const checkId of ['source.check', 'composer.dry-run']) {
    const result = await withChecks.invokeTool({
      projectId: handle.projectId, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId,
      tool: 'run_check', args: { checkId },
    });
    assert(result.ok === true, 'run_check ' + checkId + ' 失败：' + JSON.stringify(result.code));
  }
  return { coord: withChecks, registry };
}

function startRun(coord, projectId, patch) {
  return coord.startRun(Object.assign({
    projectId, targetPage: TARGET_PAGE, operation: OPERATION, utterance: UTTERANCE,
  }, patch || {}));
}

function handleOf(projectId, run) {
  return { projectId, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
}

function fileOf(dir, rel) {
  return path.join(dir, ...rel.split('/'));
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 必须被拒（ok:false）且码落在 allowed 内。 */
function assertRejectedWith(result, allowed, label) {
  assert(result && result.ok === false, label + '：应被拒绝，实际 ' + JSON.stringify(result && result.ok));
  const codes = Array.isArray(allowed) ? allowed : [allowed];
  assert(codes.includes(result.code), label + '：期望码 ' + codes.join('|') + '，实际 ' + result.code);
  return result.code;
}

const CASES = [
  {
    id: 'C01',
    group: 'C Coordinator（X1/X3）',
    title: 'startRun 从 currentVersionId 复制 attempt 树（runId/turnId/attemptId/base 摘要/revision/subject）',
    x: ['X1'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2 不变量 1/2（唯一执行所有者；attempt 工作树来自当前版本）',
    expected: 'ok:true；runId 形如 frun-…；turnId=turn-1；attemptId=attempt-1；baseVersionId=v1；'
      + 'baseTreeDigest=versions/v1 摘要；revision=1；subject={kind:"attempt",attemptId}；'
      + '候选树重算摘要=baseTreeDigest；versions/v1 指纹不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c01');
      const coord = newCoordinator(ctx);
      const v1Before = ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1'));

      const run = startRun(coord, 'e0v1-c01');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify({ code: run.code, message: run.message }));
      assert(/^frun-[a-z0-9-]+$/.test(run.runId), 'runId 形状不符：' + run.runId);
      assertEqual(run.turnId, 'turn-1', 'turnId 应为 turn-1');
      assertEqual(run.attemptId, 'attempt-1', 'attemptId 应为 attempt-1');
      assertEqual(run.baseVersionId, 'v1', 'baseVersionId 应为当前版本 v1');
      assertEqual(run.baseTreeDigest, project.v1TreeDigest, 'baseTreeDigest 应等于 versions/v1 摘要');
      assertEqual(run.revision, 1, 'revision 应为 1');
      assertEqual(run.subject && run.subject.kind, 'attempt', 'subject.kind 应为 attempt');
      assertEqual(run.subject.attemptId, 'attempt-1', 'subject.attemptId 应为 attempt-1');

      const attemptDir = path.join(project.runsDir, run.runId, 'turns', run.turnId, 'attempts', run.attemptId);
      assert(fs.existsSync(attemptDir), 'attempt 目录不存在：' + attemptDir);
      const candidateDir = path.join(attemptDir, 'candidate');
      assert(fs.existsSync(candidateDir), 'candidate 目录不存在');

      const manifest = ctx.frozen.requireStrict('manifest');
      const built = manifest.buildManifest(candidateDir);
      assert(built.ok === true, 'buildManifest 失败：' + JSON.stringify(built.code));
      assertEqual(built.manifest.treeDigest, project.v1TreeDigest, '候选树摘要应等于 base 版本摘要（逐文件复制）');

      const v1After = ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1'));
      assertEqual(v1After.digest, v1Before.digest, 'startRun 不得改动 versions/v1');

      return {
        status: 'PASS',
        observed: { runId: run.runId, baseVersionId: run.baseVersionId, treeDigest: run.baseTreeDigest, revision: run.revision },
        detail: 'startRun 复制当前版本树建 attempt，返回冻结字段，版本零写入',
      };
    },
  },
  {
    id: 'C02',
    group: 'C Coordinator（X1/X3）',
    title: '无可用版本 / baseVersionId 不存在 → AGENT_VERSION_NOT_FOUND 且零建目录（不回落 Base）',
    x: ['X1'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2 不变量 2（版本指针缺失 fail-closed）',
    expected: 'baseVersionId=v99 → AGENT_VERSION_NOT_FOUND；未知项目 → AGENT_VERSION_NOT_FOUND；'
      + '两种情况 runs/ 目录指纹都不变，且不为未知项目创建 agent-workspace 目录',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c02');
      const coord = newCoordinator(ctx);
      const runsBefore = ctx.env.fingerprintDir(project.runsDir);

      const missingVersion = startRun(coord, 'e0v1-c02', { baseVersionId: 'v99' });
      assertRejectedWith(missingVersion, 'AGENT_VERSION_NOT_FOUND', 'baseVersionId 不存在');
      assertEqual(missingVersion.ok, false, '缺失版本必须失败');

      const unknownProject = startRun(coord, 'e0v1-c02-missing');
      assertRejectedWith(unknownProject, 'AGENT_VERSION_NOT_FOUND', '未知项目');

      const runsAfter = ctx.env.fingerprintDir(project.runsDir);
      assertEqual(runsAfter.digest, runsBefore.digest, '失败的 startRun 不得创建任何 run 目录');

      const unknownProjectDir = path.join(ctx.temp.real, 'projects', 'e0v1-c02-missing', 'agent-workspace');
      assert(!fs.existsSync(unknownProjectDir), '未知项目不得被创建 agent-workspace 目录');

      const state = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-c02' });
      assertEqual(state.state.currentVersionId, 'v1', '失败后当前版本仍应为 v1');

      return {
        status: 'PASS',
        observed: { missingVersionCode: missingVersion.code, unknownProjectCode: unknownProject.code },
        detail: '缺版本/未知项目均 AGENT_VERSION_NOT_FOUND，零建目录，不回落 Base',
      };
    },
  },
  {
    id: 'C03',
    group: 'C Coordinator（X1/X3）',
    title: 'subject 固定为 attempt：写入不接受 subject 覆盖；read_file 的 version 覆盖只读',
    x: ['X3'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.3（工具上下文固定注入 subject:{kind:"attempt"}；写入永不接受 version subject）',
    expected: 'getAttemptState.subject.kind=attempt；write_files 带 subject/subjectOverride=version → AGENT_PAYLOAD_INVALID；'
      + 'read_file subjectOverride={kind:"version"} → ok 且内容=versions/v1/source 同路径；版本与候选指纹都不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c03');
      const coord = newCoordinator(ctx);
      const run = startRun(coord, 'e0v1-c03');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c03', run);

      const state = coord.getAttemptState(handle);
      assert(state.ok === true, 'getAttemptState 失败：' + JSON.stringify(state.code));
      assertEqual(state.subject.kind, 'attempt', 'getAttemptState.subject.kind 应为 attempt');
      assertEqual(state.subject.attemptId, 'attempt-1', 'getAttemptState.subject.attemptId 应为 attempt-1');

      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const treeBefore = state.treeDigest;

      const versionSubject = { kind: 'version', versionId: 'v1' };
      const writeWithSubject = await coord.invokeTool({
        ...handle, tool: 'write_files',
        subject: versionSubject,
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'subject-probe\n' }] },
      });
      assertRejectedWith(writeWithSubject, 'AGENT_PAYLOAD_INVALID', '写入带 subject');

      const writeWithOverride = await coord.invokeTool({
        ...handle, tool: 'write_files',
        subjectOverride: versionSubject,
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'override-probe\n' }] },
      });
      assertRejectedWith(writeWithOverride, 'AGENT_PAYLOAD_INVALID', '写入带 subjectOverride');

      const afterWrite = coord.getAttemptState(handle);
      assertEqual(afterWrite.treeDigest, treeBefore, '被拒的写入不得改变候选树');

      const readVersion = await coord.invokeTool({
        ...handle, tool: 'read_file', args: { path: 'app.json', subjectOverride: versionSubject },
      });
      assert(readVersion.ok === true, 'read_file(version) 应允许只读：' + JSON.stringify(readVersion.code));
      const versionAppJson = readTextOrNull(fileOf(path.join(v1Dir, 'source'), 'app.json'));
      assert(versionAppJson !== null, 'versions/v1/source/app.json 应存在');
      assertEqual(readVersion.data.content, versionAppJson, 'read_file(version) 应读到版本文件内容');

      const v1After = ctx.env.fingerprintDir(v1Dir);
      assertEqual(v1After.digest, v1Before.digest, '读版本不得改动版本目录');

      return {
        status: 'PASS',
        observed: { subjectKind: state.subject.kind, writeRejections: [writeWithSubject.code, writeWithOverride.code] },
        detail: '写入拒绝 version subject，read_file 版本覆盖只读且版本零写入',
      };
    },
  },
  {
    id: 'C04',
    group: 'C Coordinator（X1/X3）',
    title: '写入只落 attempt：revision+1、treeDigest 重算、内容可读回、版本零写入',
    x: ['X1', 'X3'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2 不变量 3/4（写只落 attempt；每次写事务 revision+1 并重算 treeDigest）',
    expected: 'write_files → ok、revision=2、treeDigest 变化；getAttemptState 同步；read_file 读回新内容；'
      + '候选磁盘文件=提交内容；versions/v1 指纹不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c04');
      const coord = newCoordinator(ctx);
      const run = startRun(coord, 'e0v1-c04');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c04', run);

      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const before = coord.getAttemptState(handle);

      const content = '<!-- menu edited by verifier C04 -->\n<view class="menu">红烧肉 28 元</view>\n';
      const written = await coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content }] },
      });
      assert(written.ok === true, 'write_files 失败：' + JSON.stringify(written.code));
      assertEqual(written.data.revision, 2, 'revision 应递增到 2');
      assert(written.data.treeDigest !== before.treeDigest, 'treeDigest 应变化');
      assertEqual(written.data.subject.kind, 'attempt', '写入结果 subject 应为 attempt');

      const after = coord.getAttemptState(handle);
      assertEqual(after.revision, 2, 'getAttemptState.revision 应为 2');
      assertEqual(after.treeDigest, written.data.treeDigest, 'getAttemptState.treeDigest 应与写入结果一致');

      const readBack = await coord.invokeTool({
        ...handle, tool: 'read_file', args: { path: 'pages/menu/index.wxml' },
      });
      assert(readBack.ok === true, 'read_file 失败：' + JSON.stringify(readBack.code));
      assertEqual(readBack.data.content, content, 'read_file 应读回新内容');

      const candidateFile = fileOf(path.join(project.runsDir, run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'candidate'), 'pages/menu/index.wxml');
      assertEqual(readTextOrNull(candidateFile), content, '候选磁盘文件应为新内容');

      const manifest = ctx.frozen.requireStrict('manifest');
      const candidateDir = path.join(project.runsDir, run.runId, 'turns', run.turnId, 'attempts', run.attemptId, 'candidate');
      const built = manifest.buildManifest(candidateDir);
      assertEqual(built.manifest.treeDigest, after.treeDigest, '平台重算候选摘要应等于 attempt 记录摘要');

      const v1After = ctx.env.fingerprintDir(v1Dir);
      assertEqual(v1After.digest, v1Before.digest, '写入不得改动 versions/v1');

      return {
        status: 'PASS',
        observed: { revisionBefore: before.revision, revisionAfter: after.revision, digestBefore: before.treeDigest, digestAfter: after.treeDigest },
        detail: '写事务 revision+1、摘要重算与磁盘一致、版本零写入',
      };
    },
  },
  {
    id: 'C05',
    group: 'C Coordinator（X1/X3）',
    title: '工具面固定：平台专用 3 名与未知名一律 AGENT_TOOL_NOT_ALLOWED',
    x: ['X1', 'X3'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.3（11 个模型可见工具；derive_source_bundle/adopt_attempt/attach_image_asset 平台专用）',
    expected: '模型工具表恰 11 个且不含平台专用名；derive_source_bundle/adopt_attempt/attach_image_asset/shell/write_file → AGENT_TOOL_NOT_ALLOWED',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c05');
      const coord = newCoordinator(ctx);
      const mod = ctx.frozen.requireStrict('run-coordinator');
      const run = startRun(coord, 'e0v1-c05');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c05', run);

      assertEqual(mod.MODEL_TOOL_NAMES.length, 11, '模型可见工具应为 11 个');
      for (const name of mod.PLATFORM_ONLY_TOOL_NAMES) {
        assert(!mod.MODEL_TOOL_NAMES.includes(name), '平台专用工具不得出现在模型工具表：' + name);
      }
      const treeBefore = coord.getAttemptState(handle).treeDigest;
      const codes = {};
      for (const tool of ['derive_source_bundle', 'adopt_attempt', 'attach_image_asset', 'shell', 'write_file', 'child_process']) {
        const result = await coord.invokeTool({ ...handle, tool, args: {} });
        codes[tool] = assertRejectedWith(result, 'AGENT_TOOL_NOT_ALLOWED', '工具 ' + tool);
      }
      const treeAfter = coord.getAttemptState(handle).treeDigest;
      assertEqual(treeAfter, treeBefore, '被拒工具不得改动候选树');

      return {
        status: 'PASS',
        observed: { modelToolCount: mod.MODEL_TOOL_NAMES.length, platformOnly: mod.PLATFORM_ONLY_TOOL_NAMES.slice(), codes },
        detail: '平台专用与未知工具全部 AGENT_TOOL_NOT_ALLOWED，候选树不变',
      };
    },
  },
  {
    id: 'C06',
    group: 'C Coordinator（X1/X3）',
    title: 'submit 静态门禁：完全没有检查证据 → AGENT_STATIC_GATE_FAILED，状态仍 open',
    x: ['X7'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.5（submit 需要 source.check + composer.dry-run 证据）',
    expected: 'submitAttempt → AGENT_STATIC_GATE_FAILED；getAttemptState.status 仍 open、runState 仍 running；'
      + '窗口内树摘要与 run.json 状态不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c06');
      const coord = newCoordinator(ctx);
      const run = startRun(coord, 'e0v1-c06');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c06', run);

      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '无证据 submit');
      assert(/source\.check/.test(submitted.message), '拒绝信息应点出缺失的检查：' + submitted.message);

      const state = coord.getAttemptState(handle);
      assertEqual(state.status, 'open', '失败后 attempt 状态应为 open');
      assertEqual(state.runState, 'running', '失败后 run 状态应为 running');
      assertEqual(state.verification.submission, null, '失败后不得写 submission 证据');

      return {
        status: 'PASS',
        observed: { code: submitted.code, message: submitted.message, status: state.status },
        detail: '缺证据 submit 被静态门禁拒绝，状态与证据均未变化',
      };
    },
  },
  {
    id: 'C07',
    group: 'C Coordinator（X1/X3）',
    title: 'run_check 路由由平台表决定：root=attempt 由平台注入，注册表不声明 attempt 主体的 PASS 不能放行 submit',
    x: ['X4', 'X7'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.4（checkId→subject 平台表；root/导出根只由平台填）/§14.5（证据主体必须是 attempt）',
    expected: '注册表收到的 root=attempt/candidateDir、subject={kind:attempt}、subjectKind=attempt；'
      + '即使注册表返回 PASS，只要没声明 attempt 主体，证据就降级为 version，submit 仍 AGENT_STATIC_GATE_FAILED',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c07');
      const registry = makeRegistry(ctx, (request) => (
        request.checkId === 'composer.dry-run'
          ? dryRunResult(request.checkId, request, { subjectKind: undefined })
          : passResult(request.checkId, undefined)
      ));
      assert(registry.hasRealDefinitions, 'checks.cjs 应导出 definitions（checkId→subject 平台表）');
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-c07');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c07', run);

      const candidateDir = path.join(project.runsDir, run.runId, 'turns', run.turnId, 'attempts', run.attemptId, 'candidate');
      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      assert(sourceCheck.ok === true, 'run_check source.check 失败：' + JSON.stringify(sourceCheck.code));
      assertEqual(sourceCheck.data.subjectKind, 'version', '注册表未声明 attempt 主体时证据必须降级为 version');

      const call = registry.calls.find((item) => item.checkId === 'source.check');
      assert(call, '注册表应被调用');
      assertEqual(ctx.env.normalizeForCompare(call.root), ctx.env.normalizeForCompare(candidateDir),
        'run_check 的 root 必须由平台填成 attempt/candidate');
      assertEqual(call.subject && call.subject.kind, 'attempt', 'run_check 的 subject 必须是 attempt');
      assertEqual(call.subjectKind, 'attempt', 'source.check 的平台主体应为 attempt（definitions 声明）');

      const composer = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(composer.ok === true, 'run_check composer.dry-run 失败：' + JSON.stringify(composer.code));
      const dryCall = registry.calls.find((item) => item.checkId === 'composer.dry-run');
      assert(dryCall && typeof dryCall.exportParentDir === 'string',
        'composer.dry-run 必须由平台给出导出父目录（模型不可指定）');

      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', 'version 主体证据 submit');
      assert(/主体/.test(submitted.message), '拒绝信息应说明证据主体不符：' + submitted.message);

      return {
        status: 'PASS',
        observed: {
          rootInjected: true,
          subjectKindFromRegistry: sourceCheck.data.subjectKind,
          platformSubjectKind: call.subjectKind,
          exportParentInjected: true,
          submitCode: submitted.code,
          submitMessage: submitted.message,
        },
        detail: '平台注入 root/subject/导出父目录；证据主体降级后门禁拒绝',
      };
    },
  },
  {
    id: 'C08',
    group: 'C Coordinator（X1/X3）',
    title: '可提交路径：attempt 主体 PASS 证据 → submitted（partial）；其后写入 AGENT_ATTEMPT_IMMUTABLE、重复提交与取消 too-late',
    x: ['X3', 'X7'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.5（submit）+ §14.2 不变量 6（提交后只读）+ §14.9（重复提交/取消三态）',
    expected: 'submit → ok、status=submitted、partial=true、candidateId=attempt-1；随后 write_files → AGENT_ATTEMPT_IMMUTABLE 且摘要不变；'
      + '再次 submit → AGENT_RUN_ALREADY_SUBMITTED；cancelRun → state=too-late、cancelled=false、runState 仍 submitted',
    async run(ctx) {
      setupProject(ctx, 'e0v1-c08');
      const coord = newCoordinator(ctx);
      const run = startRun(coord, 'e0v1-c08');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c08', run);

      const driven = await driveToSubmittable(ctx, coord, handle);
      const beforeSubmit = driven.coord.getAttemptState(handle);
      const submitted = driven.coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 失败：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      assertEqual(submitted.status, 'submitted', 'submit 返回 status 应为 submitted');
      assertEqual(submitted.partial, true, '缺 mini/wechat 证据时应标 partial');
      assertEqual(submitted.candidateId, 'attempt-1', 'candidateId 应为 attempt-1');
      assertEqual(submitted.treeDigest, beforeSubmit.treeDigest, 'submit 不得改动候选树');
      // rev15 §14.13-F1：成功返回体必须自带六个绑定字段；缺 exportTreeDigest 即不可 adopt。
      for (const key of ['candidateId', 'revision', 'treeDigest', 'exportRelative', 'exportTreeDigest', 'targetPage']) {
        assert(Object.prototype.hasOwnProperty.call(submitted, key), 'submit 返回体缺少 ' + key + '（§14.13-F1）');
      }
      assert(typeof submitted.exportRelative === 'string' && !path.isAbsolute(submitted.exportRelative)
        && !/^[A-Za-z]:/.test(submitted.exportRelative) && !submitted.exportRelative.startsWith('/')
        && !submitted.exportRelative.includes('..'),
        'submit 的 exportRelative 必须是 attempt 内相对路径，实际 ' + String(submitted.exportRelative));
      assert(typeof submitted.exportTreeDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(submitted.exportTreeDigest),
        'submit 的 exportTreeDigest 必须是 sha256 摘要，实际 ' + String(submitted.exportTreeDigest));
      assertEqual(submitted.targetPage, TARGET_PAGE, 'submit 应回传 targetPage');

      const writeAfterSubmit = await driven.coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'late-write\n' }] },
      });
      assertRejectedWith(writeAfterSubmit, 'AGENT_ATTEMPT_IMMUTABLE', '提交后写入');

      const stateAfter = driven.coord.getAttemptState(handle);
      assertEqual(stateAfter.treeDigest, beforeSubmit.treeDigest, '提交后写入被拒，摘要不得变化');
      assertEqual(stateAfter.status, 'submitted', '状态应为 submitted');
      assert(stateAfter.verification.submission, '应写入 submission 证据');
      assertEqual(stateAfter.verification.submission.treeDigest, beforeSubmit.treeDigest, 'submission 证据摘要应等于候选摘要');

      const resubmit = driven.coord.submitAttempt(handle);
      assertRejectedWith(resubmit, 'AGENT_RUN_ALREADY_SUBMITTED', '重复提交');

      const cancel = driven.coord.cancelRun({ projectId: 'e0v1-c08', runId: run.runId });
      assert(cancel.ok === true, 'cancelRun 失败：' + JSON.stringify(cancel.code));
      assertEqual(cancel.state, 'too-late', '已提交的 run 取消应为 too-late');
      assertEqual(cancel.cancelled, false, 'too-late 不得声称已取消');
      assertEqual(driven.coord.getAttemptState(handle).runState, 'submitted', '取消 too-late 后 run 状态仍应为 submitted');

      return {
        status: 'PASS',
        observed: {
          submitCode: submitted.code || 'ok',
          partial: submitted.partial,
          exportRelative: submitted.exportRelative,
          exportTreeDigestHead: String(submitted.exportTreeDigest || '').slice(0, 16),
          lateWriteCode: writeAfterSubmit.code,
          resubmitCode: resubmit.code,
          cancelState: cancel.state,
        },
        detail: '提交后可写拒绝、重复提交拒绝、取消 too-late；F1 六个绑定字段齐全且 exportRelative 为相对路径',
      };
    },
  },
  {
    id: 'C09',
    group: 'C Coordinator（X1/X3）',
    title: 'adopt 三分码实测：未提交→AGENT_ADOPTION_FAILED+NOT_SUBMITTED；摘要不符→AGENT_EVIDENCE_STALE；未确认 partial→AGENT_PARTIAL_CONFIRM_REQUIRED',
    x: ['X7'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.12-1（三分不得互相顶替）',
    expected: '① 未提交 adopt → AGENT_ADOPTION_FAILED 且 issues[].code=NOT_SUBMITTED、不生成新版本；'
      + '② 已提交但 submission.treeDigest 被改写 → AGENT_EVIDENCE_STALE（不得报 PARTIAL_CONFIRM_REQUIRED）；'
      + '③ 已提交 partial 且未确认 → AGENT_PARTIAL_CONFIRM_REQUIRED；partialConfirmed:true 后才 adopt 成功并推进版本',
    async run(ctx) {
      // ① 未提交
      const projectA = setupProject(ctx, 'e0v1-c09a');
      const coordA = newCoordinator(ctx);
      const runA = startRun(coordA, 'e0v1-c09a');
      assert(runA.ok === true, 'startRun(A) 失败');
      const versionsBefore = ctx.env.fingerprintDir(projectA.paths.versionsDir);
      const adoptEarly = coordA.adoptAttempt(handleOf('e0v1-c09a', runA));
      assertRejectedWith(adoptEarly, 'AGENT_ADOPTION_FAILED', '未提交 adopt');
      const issueCodes = (adoptEarly.issues || []).map((item) => item.code);
      assert(issueCodes.includes('NOT_SUBMITTED'), 'issues 应含 NOT_SUBMITTED，实际 ' + JSON.stringify(issueCodes));
      assertEqual(ctx.env.fingerprintDir(projectA.paths.versionsDir).digest, versionsBefore.digest,
        '未提交 adopt 不得生成新版本目录');
      const stateA = projectA.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-c09a' });
      assertEqual(stateA.state.currentVersionId, 'v1', '未提交 adopt 后当前版本仍应为 v1');

      // ② 已提交但证据摘要被改写
      const projectB = setupProject(ctx, 'e0v1-c09b');
      const coordB = newCoordinator(ctx);
      const runB = startRun(coordB, 'e0v1-c09b');
      assert(runB.ok === true, 'startRun(B) 失败');
      const handleB = handleOf('e0v1-c09b', runB);
      const drivenB = await driveToSubmittable(ctx, coordB, handleB);
      const submitB = drivenB.coord.submitAttempt(handleB);
      assert(submitB.ok === true, 'submit(B) 失败：' + JSON.stringify(submitB.code));
      const submissionFile = path.join(projectB.paths.workspaceDir, 'runs', runB.runId, 'turns', runB.turnId,
        'attempts', runB.attemptId, 'verification', 'submission.json');
      const tampered = JSON.parse(fs.readFileSync(submissionFile, 'utf8'));
      tampered.treeDigest = 'sha256:' + '0'.repeat(64);
      fs.writeFileSync(submissionFile, JSON.stringify(tampered, null, 2), 'utf8');
      const adoptStale = drivenB.coord.adoptAttempt(handleB);
      assertRejectedWith(adoptStale, 'AGENT_EVIDENCE_STALE', '摘要不符 adopt');

      // ③ partial 未确认 → 需确认；确认后成功
      const projectC = setupProject(ctx, 'e0v1-c09c');
      const coordC = newCoordinator(ctx);
      const runC = startRun(coordC, 'e0v1-c09c');
      assert(runC.ok === true, 'startRun(C) 失败');
      const handleC = handleOf('e0v1-c09c', runC);
      const drivenC = await driveToSubmittable(ctx, coordC, handleC);
      const submitC = drivenC.coord.submitAttempt(handleC);
      assert(submitC.ok === true, 'submit(C) 失败：' + JSON.stringify(submitC.code));
      assertEqual(submitC.partial, true, 'C 例必须落在 partial=true 分支');

      const adoptUnconfirmed = drivenC.coord.adoptAttempt(handleC);
      assertRejectedWith(adoptUnconfirmed, 'AGENT_PARTIAL_CONFIRM_REQUIRED', '未确认 partial adopt');

      const adoptConfirmed = drivenC.coord.adoptAttempt({ ...handleC, partialConfirmed: true });
      assert(adoptConfirmed.ok === true, '确认后 adopt 应成功：' + JSON.stringify({ code: adoptConfirmed.code, message: adoptConfirmed.message }));
      assertEqual(adoptConfirmed.previousVersionId, 'v1', 'adopt 后 previous 版本应为 v1');
      assertEqual(adoptConfirmed.adoptedVersionId, 'v2', 'adopt 应生成 v2');
      const stateC = projectC.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-c09c' });
      assertEqual(stateC.state.currentVersionId, 'v2', 'adopt 后当前版本应为 v2');
      assertEqual(drivenC.coord.getAttemptState(handleC).status, 'adopted', 'adopt 后 attempt 状态应为 adopted');

      return {
        status: 'PASS',
        observed: {
          notSubmitted: { code: adoptEarly.code, issueCodes },
          stale: { code: adoptStale.code },
          partialConfirm: { code: adoptUnconfirmed.code, adoptedVersionId: adoptConfirmed.adoptedVersionId },
        },
        detail: '三分码各自命中且不互相顶替；确认后才推进版本',
      };
    },
  },
  {
    id: 'C10',
    group: 'C Coordinator（X1/X3）',
    title: 'Coordinator 层句柄拒绝：跨项目 / 跨 run / 跨 turn / 伪造 attempt / 磁盘 projectId 篡改 → 拒绝且目录指纹不变',
    x: ['X1', 'X3'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2 不变量 5 + §14.12-2（Coordinator 句柄校验层必须拒绝伪造 projectId）',
    expected: '跨项目 → AGENT_RUN_NOT_FOUND/AGENT_PROJECT_MISMATCH；伪造 attemptId/跨 turn → AGENT_ATTEMPT_NOT_FOUND；'
      + 'attempt.json 的 projectId 被篡改 → AGENT_PROJECT_MISMATCH；以上全部零落盘（两个项目树指纹不变）',
    async run(ctx) {
      const projectA = setupProject(ctx, 'e0v1-c10a');
      const projectB = setupProject(ctx, 'e0v1-c10b');
      const coord = newCoordinator(ctx);
      const runA = startRun(coord, 'e0v1-c10a');
      assert(runA.ok === true, 'startRun(A) 失败');
      const runB = startRun(coord, 'e0v1-c10b');
      assert(runB.ok === true, 'startRun(B) 失败');
      const handleA = handleOf('e0v1-c10a', runA);

      const beforeA = ctx.env.fingerprintDir(path.join(projectA.paths.workspaceDir, 'runs'));
      const beforeB = ctx.env.fingerprintDir(path.join(projectB.paths.workspaceDir, 'runs'));

      const crossProject = await coord.invokeTool({
        projectId: 'e0v1-c10b', runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
        tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'cross\n' }] },
      });
      const crossProjectCode = assertRejectedWith(crossProject,
        ['AGENT_RUN_NOT_FOUND', 'AGENT_ATTEMPT_NOT_FOUND', 'AGENT_PROJECT_MISMATCH'], '跨项目句柄');

      const forgedAttempt = await coord.invokeTool({
        ...handleA, attemptId: 'attempt-2', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'forged\n' }] },
      });
      const forgedCode = assertRejectedWith(forgedAttempt, 'AGENT_ATTEMPT_NOT_FOUND', '伪造 attemptId');

      const crossTurn = await coord.invokeTool({
        ...handleA, turnId: 'turn-2', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'cross-turn\n' }] },
      });
      const crossTurnCode = assertRejectedWith(crossTurn, 'AGENT_ATTEMPT_NOT_FOUND', '跨 turn');

      const crossRun = await coord.invokeTool({
        ...handleA, runId: runB.runId, tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'cross-run\n' }] },
      });
      const crossRunCode = assertRejectedWith(crossRun,
        ['AGENT_ATTEMPT_NOT_FOUND', 'AGENT_PROJECT_MISMATCH', 'AGENT_RUN_NOT_FOUND'], '跨 run');

      // §14.12-Q2：磁盘上把 attempt.json 的 projectId 改成别的项目 → Coordinator 必须 AGENT_PROJECT_MISMATCH。
      const attemptFile = path.join(projectA.paths.workspaceDir, 'runs', runA.runId, 'turns', runA.turnId,
        'attempts', runA.attemptId, 'attempt.json');
      const original = fs.readFileSync(attemptFile, 'utf8');
      let tamperedCode = null;
      try {
        const meta = JSON.parse(original);
        meta.projectId = 'e0v1-c10b';
        fs.writeFileSync(attemptFile, JSON.stringify(meta, null, 2), 'utf8');
        const tampered = await coord.invokeTool({
          ...handleA, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'tamper\n' }] },
        });
        tamperedCode = assertRejectedWith(tampered,
          ['AGENT_PROJECT_MISMATCH', 'AGENT_ATTEMPT_NOT_FOUND'], '磁盘 projectId 篡改');
      } finally {
        fs.writeFileSync(attemptFile, original, 'utf8');
      }

      const afterA = ctx.env.fingerprintDir(path.join(projectA.paths.workspaceDir, 'runs'));
      const afterB = ctx.env.fingerprintDir(path.join(projectB.paths.workspaceDir, 'runs'));
      assertEqual(afterA.digest, beforeA.digest, 'A 项目 runs/ 必须零落盘');
      assertEqual(afterB.digest, beforeB.digest, 'B 项目 runs/ 必须零落盘');
      assertEqual(coord.getAttemptState(handleA).status, 'open', 'A 的 attempt 应仍为 open');

      return {
        status: 'PASS',
        observed: { crossProjectCode, forgedCode, crossTurnCode, crossRunCode, tamperedCode },
        detail: 'Coordinator 层句柄拒绝全部命中具体码，两个项目树零落盘',
      };
    },
  },
  {
    id: 'C11',
    group: 'C Coordinator（X1/X3）',
    title: '取消三态与迟到调用：requested→cancelled、取消后不再调注册表/direct、迟到 run_check 结果零落盘',
    x: ['X3', 'X8'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2 不变量 5/6 + §14.9（cancel 三态）+ 计划 §4（取消后不得再发上游）',
    expected: '在途取消 → state=requested；迟到 run_check 结果 → AGENT_CANCELLED 且不写证据、run 落 cancelled；'
      + '取消后再调 run_check/direct → AGENT_CANCELLED 且注册表/direct 调用计数不增；无在途取消 → cancelled；再取消幂等',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c11');
      let resolveCheck = null;
      let registryCalls = 0;
      const registry = {
        calls: [],
        // 用真实平台表（checkId→subject），让 source.check 走 attempt 主体；只把执行换成可控 Promise。
        definitions: realDefinitions(ctx),
        async runCheck(request) {
          registryCalls += 1;
          registry.calls.push({ checkId: request.checkId });
          await new Promise((resolve) => { resolveCheck = resolve; });
          return passResult(request.checkId, 'attempt');
        },
      };
      let directCalls = 0;
      const directRuntime = {
        async invoke() {
          directCalls += 1;
          return { ok: true, data: { text: 'should-not-be-called-after-cancel' } };
        },
      };
      const coord = newCoordinator(ctx, { checks: registry, directRuntime });
      const run = startRun(coord, 'e0v1-c11');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-c11', run);

      // 在途 run_check
      const pending = coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      while (registryCalls === 0) await new Promise((resolve) => setImmediate(resolve));

      const cancelInFlight = coord.cancelRun({ projectId: 'e0v1-c11', runId: run.runId });
      assertEqual(cancelInFlight.ok, true, '在途取消应 ok');
      assertEqual(cancelInFlight.state, 'requested', '有在途调用时应先返回 requested');
      assertEqual(cancelInFlight.cancelled, false, 'requested 不得声称已取消');

      resolveCheck();
      const lateResult = await pending;
      assertRejectedWith(lateResult, 'AGENT_CANCELLED', '迟到 run_check 结果');

      const evidenceDir = path.join(project.paths.workspaceDir, 'runs', run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'verification', 'checks');
      const evidenceFiles = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : [];
      assertEqual(evidenceFiles.length, 0, '迟到检查结果不得写证据文件，实际 ' + JSON.stringify(evidenceFiles));
      assertEqual(coord.getAttemptState(handle).runState, 'cancelled', '在途结束后 run 应落 cancelled');

      // 取消后：注册表与 direct 都不再被调用
      const callsBefore = registryCalls;
      const afterCancelCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assertRejectedWith(afterCancelCheck, 'AGENT_CANCELLED', '取消后 run_check');
      assertEqual(registryCalls, callsBefore, '取消后不得再调检查注册表');

      const afterCancelDirect = await coord.invokeDirect({ ...handle, request: { utterance: 'hi' } });
      assertRejectedWith(afterCancelDirect, 'AGENT_CANCELLED', '取消后 direct');
      assertEqual(directCalls, 0, '取消后不得再发起 direct 调用');

      // 无在途取消 → cancelled；再取消幂等
      setupProject(ctx, 'e0v1-c11b');
      const coord2 = newCoordinator(ctx);
      const run2 = startRun(coord2, 'e0v1-c11b');
      assert(run2.ok === true, 'startRun(b) 失败');
      const first = coord2.cancelRun({ projectId: 'e0v1-c11b', runId: run2.runId });
      assertEqual(first.state, 'cancelled', '无在途时应直接 cancelled');
      assertEqual(first.cancelled, true, '无在途时 cancelled 应为 true');
      const second = coord2.cancelRun({ projectId: 'e0v1-c11b', runId: run2.runId });
      assertEqual(second.state, 'cancelled', '重复取消应幂等返回 cancelled');

      return {
        status: 'PASS',
        observed: {
          inFlight: cancelInFlight.state,
          lateCode: lateResult.code,
          postCancelCheckCode: afterCancelCheck.code,
          postCancelDirectCode: afterCancelDirect.code,
          registryCallsAfterCancel: registryCalls,
          directCalls,
          idleCancel: first.state,
        },
        detail: 'requested/cancelled 两态与迟到丢弃成立；取消后不再调注册表/direct，零落盘',
      };
    },
  },
  {
    id: 'C12',
    group: 'C Coordinator（X1/X3）',
    title: 'progress 事件：stage 在白名单内、status 合法、payload 无绝对路径/源码/base64',
    x: ['X10'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §9.1/§14.9（agent:progress 只允许白名单 stage；payload 不得含目录/源码/base64）',
    expected: '每个 event 的 stage ∈ PROGRESS_STAGES、status ∈ {running,succeeded,failed,cancelled}；'
      + 'message 不含盘符绝对路径、不含 data:image、不含 200+ 连续 base64；含 projectId/runId/attemptId 与 at',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c12');
      const events = [];
      const registry = makeRegistry(ctx, (request) => passResult(request.checkId, 'attempt'));
      const coord = newCoordinator(ctx, { checks: registry, emitProgress: (event) => events.push(event) });
      const run = startRun(coord, 'e0v1-c12');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-c12', run);
      await coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>ok</view>\n' }] },
      });
      await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });

      const mod = ctx.frozen.requireStrict('run-coordinator');
      const allowedStages = mod.PROGRESS_STAGES instanceof Set ? mod.PROGRESS_STAGES : new Set(mod.PROGRESS_STAGES);
      assert(events.length >= 3, '应至少收到 start/tool/check 三条进度，实际 ' + events.length);
      const stages = new Set();
      const statuses = new Set();
      for (const event of events) {
        assert(allowedStages.has(event.stage), 'stage 不在白名单：' + event.stage);
        assert(['running', 'succeeded', 'failed', 'cancelled'].includes(event.status), 'status 非法：' + event.status);
        assertEqual(typeof event.at, 'string', 'event.at 应为 ISO 字符串');
        stages.add(event.stage);
        statuses.add(event.status);
        const message = String(event.message || '');
        assert(!/[A-Za-z]:[\\/]/.test(message), 'message 不得含盘符绝对路径：' + message);
        assert(!/data:image/i.test(message), 'message 不得含 data:image');
        assert(!/[A-Za-z0-9+/]{200,}/.test(message), 'message 不得含长 base64');
        assert(!message.includes(ctx.temp.real), 'message 不得含私有根绝对路径');
      }

      return {
        status: 'PASS',
        observed: { eventCount: events.length, stages: Array.from(stages), statuses: Array.from(statuses) },
        detail: 'progress stage/status 合法且已脱敏',
      };
    },
  },
  {
    id: 'C13',
    group: 'C Coordinator（X1/X3）',
    title: 'getRun / getAttemptState 视图：状态机 open→submitted 与 revision/treeDigest 一致',
    x: ['X1'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.2（getRun/getAttemptState 为冻结签名；无 UI 垂直链的读取面）',
    expected: 'getRun 返回 turns/attempts 列表且含 attempt-1 + status/revision/treeDigest；'
      + 'submit 后 getRun 的 attempt 状态变 submitted、run.state 变 submitted',
    async run(ctx) {
      setupProject(ctx, 'e0v1-c13');
      const coord = newCoordinator(ctx);
      const run = startRun(coord, 'e0v1-c13');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-c13', run);

      const view = coord.getRun({ projectId: 'e0v1-c13', runId: run.runId });
      assert(view.ok === true, 'getRun 失败：' + JSON.stringify(view.code));
      assertEqual(view.state || view.runState, 'running', 'getRun 的 run 状态应为 running');
      const attempts = view.attempts || (view.turns && view.turns[0] && view.turns[0].attempts) || [];
      assert(attempts.length >= 1, 'getRun 应列出 attempt');
      const first = attempts[0];
      assertEqual(first.attemptId || first.id, 'attempt-1', '第一个 attempt 应是 attempt-1');
      assertEqual(first.status, 'open', 'attempt 初始状态应为 open');
      assertEqual(first.revision, 1, 'attempt 初始 revision 应为 1');
      assert(typeof first.treeDigest === 'string' && first.treeDigest.startsWith('sha256:'), 'attempt 应带 treeDigest');

      const driven = await driveToSubmittable(ctx, coord, handle);
      const submitted = driven.coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 失败：' + JSON.stringify(submitted.code));
      const viewAfter = driven.coord.getRun({ projectId: 'e0v1-c13', runId: run.runId });
      assertEqual(viewAfter.state || viewAfter.runState, 'submitted', 'submit 后 run 状态应为 submitted');
      const attemptsAfter = viewAfter.attempts || (viewAfter.turns && viewAfter.turns[0] && viewAfter.turns[0].attempts) || [];
      assertEqual(attemptsAfter[0].status, 'submitted', 'submit 后 attempt 状态应为 submitted');

      return {
        status: 'PASS',
        observed: {
          initialState: first.status,
          afterSubmit: { runState: viewAfter.state || viewAfter.runState, attemptStatus: attemptsAfter[0].status },
        },
        detail: 'getRun/getAttemptState 反映同一磁盘事实',
      };
    },
  },
  {
    id: 'C14',
    group: 'C Coordinator（X1/X3）',
    title: 'startRun 入参校验：targetPage/operation/utterance/imageAssetIds 非法一律拒绝且零建目录',
    x: ['X1'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.3（imageAssetIds 只接受 assetId，不接受路径/base64）+ §14.9 码表',
    expected: 'targetPage 非法 → AGENT_TARGET_PAGE_UNSUPPORTED；operation 非法/utterance 空 → AGENT_PAYLOAD_INVALID；'
      + 'imageAssetIds 传路径或 dataURL → AGENT_PAYLOAD_INVALID；全部零建 runs 目录',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c14');
      const coord = newCoordinator(ctx);
      const before = ctx.env.fingerprintDir(project.runsDir);

      const badTarget = startRun(coord, 'e0v1-c14', { targetPage: 'Pages/Menu/Index' });
      assertRejectedWith(badTarget, 'AGENT_TARGET_PAGE_UNSUPPORTED', 'targetPage 非法');

      const badOperation = startRun(coord, 'e0v1-c14', { operation: '1bad op' });
      assertRejectedWith(badOperation, 'AGENT_PAYLOAD_INVALID', 'operation 非法');

      const emptyUtterance = startRun(coord, 'e0v1-c14', { utterance: '   ' });
      assertRejectedWith(emptyUtterance, 'AGENT_PAYLOAD_INVALID', 'utterance 空');

      const pathAsAsset = startRun(coord, 'e0v1-c14', { imageAssetIds: ['C:/Users/x/ref.png'] });
      assertRejectedWith(pathAsAsset, 'AGENT_PAYLOAD_INVALID', 'imageAssetIds 传路径');

      const dataUrlAsAsset = startRun(coord, 'e0v1-c14', { imageAssetIds: ['data:image/png;base64,AAAA'] });
      assertRejectedWith(dataUrlAsAsset, 'AGENT_PAYLOAD_INVALID', 'imageAssetIds 传 dataURL');

      const tooMany = startRun(coord, 'e0v1-c14', { imageAssetIds: ['a1', 'a2', 'a3', 'a4', 'a5'] });
      assertRejectedWith(tooMany, 'AGENT_PAYLOAD_INVALID', 'imageAssetIds 超过 4 项');

      const after = ctx.env.fingerprintDir(project.runsDir);
      assertEqual(after.digest, before.digest, '非法入参不得创建 run 目录');

      return {
        status: 'PASS',
        observed: {
          codes: {
            targetPage: badTarget.code,
            operation: badOperation.code,
            utterance: emptyUtterance.code,
            pathAsset: pathAsAsset.code,
            dataUrlAsset: dataUrlAsAsset.code,
            tooManyAssets: tooMany.code,
          },
        },
        detail: '入参校验全部命中码，零建目录',
      };
    },
  },
  {
    id: 'C15',
    group: 'C Coordinator（X1/X3）',
    title: '注册表漂移（未声明 definitions）时 run_check 必须**先拒后跑**（runner 0 次调用）且不抛异常',
    x: ['X3', 'X4'],
    requires: COORDINATOR_REQUIRES,
    basis: 'rev15 §14.4（checkId→subject 来自平台表）+ §14.13-F2（缺 subject/root/definitions 先拒后跑，runner 调用次数 0）',
    expected: '注入一个没有 definitions 的注册表：source.check → AGENT_CHECK_UNKNOWN 且**检查 runner 被调用 0 次**；'
      + 'composer.dry-run 同样先拒；随后 submit 必须 AGENT_STATIC_GATE_FAILED；全过程不得抛未捕获异常（抛异常=IPC 层会 500）',
    async run(ctx) {
      setupProject(ctx, 'e0v1-c15');
      const calls = [];
      const registry = {
        calls,
        // 故意不提供 definitions：模拟旧/漂移注册表。
        async runCheck(request) {
          calls.push({ checkId: request.checkId, root: request.root === undefined ? null : request.root });
          return passResult(request.checkId, 'attempt');
        },
      };
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-c15');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-c15', run);

      let thrown = null;
      let checkResult = null;
      let dryRunResult2 = null;
      try {
        checkResult = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
        dryRunResult2 = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      } catch (error) {
        thrown = error;
      }
      assert(!thrown, '注册表未声明 definitions 时 run_check 不得抛异常（应返回错误码）：' + (thrown && thrown.message));
      // §14.13-F2：先拒后跑 —— runner 一次都不能被调用。
      assertEqual(calls.length, 0, '缺 definitions 时检查 runner 必须 0 次调用（§14.13-F2），实际 ' + calls.length + ' 次');
      assertRejectedWith(checkResult, 'AGENT_CHECK_UNKNOWN', '缺 definitions 的 source.check');
      assertRejectedWith(dryRunResult2, 'AGENT_CHECK_UNKNOWN', '缺 definitions 的 composer.dry-run');

      let submitThrown = null;
      let submitted = null;
      try {
        submitted = coord.submitAttempt(handle);
      } catch (error) {
        submitThrown = error;
      }
      assert(!submitThrown, '注册表漂移时 submit 不得抛异常：' + (submitThrown && submitThrown.message));
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '漂移注册表下 submit');

      return {
        status: 'PASS',
        observed: {
          runCheckCode: checkResult.code || null,
          dryRunCode: dryRunResult2 && (dryRunResult2.code || 'ok'),
          runnerCalls: calls.length,
          submitCode: submitted.code,
        },
        detail: '缺 definitions 时先拒后跑（runner 0 次），submit 仍被静态门禁拒绝，全程无异常',
      };
    },
  },
  {
    id: 'C16',
    group: 'C Coordinator（X1/X3）',
    title: '真实检查链（无替身）：写改 → 平台派生 bundle → source.check PASS → composer.dry-run PASS → submit(partial) → adopt 推进 v2',
    x: ['X1', 'X3', 'X4', 'X7'],
    requires: COORDINATOR_REQUIRES.concat(['checks', 'source-check']),
    basis: 'rev15 §14.5 合法链路顺序（write → derive → source.check → dry-run → submit → adopt）',
    expected: '全程用**真实注册表与真实子进程检查**（不注入替身）：source.check/composer.dry-run 均 PASS 且 subjectKind=attempt、'
      + 'dry-run 给出导出根与导出树摘要；submit → submitted+partial；adopt 未确认被拒、确认后生成 v2 且候选内容进版本；'
      + 'v1 源目录字节不变。若子进程检查不可用（沙箱/工具缺失）则记 BLOCKED，不记 PASS',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c16');
      const coord = newCoordinator(ctx); // 不注入 checks：走真实注册表 + 真实子进程
      const run = startRun(coord, 'e0v1-c16');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-c16', run);
      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);

      const marker = 'E0V1-C16 真实链路修改';
      const original = readTextOrNull(fileOf(path.join(project.runsDir, run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'candidate'), 'pages/menu/index.wxml'));
      assert(typeof original === 'string', '候选树应含 pages/menu/index.wxml');
      const edited = original + '\n<!-- ' + marker + ' -->\n';
      const written = await coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: edited }] },
      });
      assert(written.ok === true, 'write_files 失败：' + JSON.stringify(written.code));

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) {
        const blocked = String(sourceCheck.code || '').startsWith('AGENT_RUNTIME')
          || sourceCheck.code === 'AGENT_CHECK_UNKNOWN';
        return {
          status: blocked ? 'BLOCKED' : 'FAIL',
          observed: { code: sourceCheck.code || null, message: sourceCheck.message || null },
          detail: '真实 source.check 不可用（' + String(sourceCheck.code) + '），真实链路无法在本环境判定',
        };
      }
      assertEqual(sourceCheck.data.status, 'PASS', '真实 source.check 应 PASS');
      assertEqual(sourceCheck.data.subjectKind, 'attempt', '真实 source.check 证据主体应为 attempt');

      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, '真实 composer.dry-run 调用失败：' + JSON.stringify(dryRun.code));
      assertEqual(dryRun.data.status, 'PASS', '真实 composer.dry-run 应 PASS：'
        + JSON.stringify((dryRun.data.issues || []).map((item) => item.code)));
      assertEqual(dryRun.data.subjectKind, 'attempt', 'dry-run 证据主体应为 attempt');
      assert(typeof dryRun.data.exportRelative === 'string' && dryRun.data.exportRelative.length > 0,
        'dry-run 应给出导出根相对引用');
      assert(typeof dryRun.data.exportTreeDigest === 'string', 'dry-run 应给出导出树摘要');

      const candidateBeforeSubmit16 = ctx.env.fingerprintDir(path.join(project.paths.workspaceDir, 'runs', run.runId,
        'turns', run.turnId, 'attempts', run.attemptId, 'candidate'));

      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, '真实链路 submit 应通过：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      assertEqual(submitted.status, 'submitted', 'submit 后状态应为 submitted');
      assertEqual(submitted.partial, true, '缺 mini/output/wechat 证据时应为 partial');
      const candidateDir16 = path.join(project.paths.workspaceDir, 'runs', run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'candidate');
      const submissionFile = path.join(project.paths.workspaceDir, 'runs', run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'verification', 'submission.json');
      const submission = JSON.parse(fs.readFileSync(submissionFile, 'utf8'));
      assertEqual(submission.treeDigest, submitted.treeDigest, 'submission 证据摘要应等于候选摘要');
      assertEqual(submission.exportTreeDigest, dryRun.data.exportTreeDigest,
        'submission 证据应绑定 dry-run 的导出树摘要');
      assertEqual(submission.exportRelative, dryRun.data.exportRelative, 'submission 证据应带上导出根相对引用');
      // rev15 §14.13-F1：返回体六个绑定字段齐全，且与磁盘证据同值。
      for (const key of ['candidateId', 'revision', 'treeDigest', 'exportRelative', 'exportTreeDigest', 'targetPage']) {
        assert(Object.prototype.hasOwnProperty.call(submitted, key), 'submit 返回体缺少 ' + key + '（§14.13-F1）');
      }
      assertEqual(submitted.exportTreeDigest, submission.exportTreeDigest,
        '返回体 exportTreeDigest 应等于 submission 证据值（F1）');
      assertEqual(submitted.exportRelative, submission.exportRelative,
        '返回体 exportRelative 应等于 submission 证据值（F1）');
      assertEqual(ctx.env.fingerprintDir(candidateDir16).digest, candidateBeforeSubmit16.digest,
        '§14.13-F3：submit 期间候选目录不得被写入（不得再派生）');

      const adoptUnconfirmed = coord.adoptAttempt(handle);
      assertRejectedWith(adoptUnconfirmed, 'AGENT_PARTIAL_CONFIRM_REQUIRED', 'partial 未确认 adopt');
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === true, '确认后 adopt 应成功：' + JSON.stringify({ code: adopted.code, message: adopted.message }));
      assertEqual(adopted.adoptedVersionId, 'v2', 'adopt 应生成 v2');

      const stateProject = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-c16' });
      assertEqual(stateProject.state.currentVersionId, 'v2', '当前版本应为 v2');
      const v2Source = fileOf(path.join(project.paths.versionsDir, 'v2', 'source'), 'pages/menu/index.wxml');
      const adoptedContent = readTextOrNull(v2Source);
      assert(typeof adoptedContent === 'string' && adoptedContent.includes(marker),
        'v2 源目录应包含本次修改');
      assertEqual(ctx.env.fingerprintDir(v1Dir).digest, v1Before.digest, 'v1 源目录必须字节不变');

      return {
        status: 'PASS',
        observed: {
          sourceCheck: { status: sourceCheck.data.status, subjectKind: sourceCheck.data.subjectKind },
          dryRun: {
            status: dryRun.data.status,
            subjectKind: dryRun.data.subjectKind,
            exportRelative: dryRun.data.exportRelative,
            exportTreeDigest: dryRun.data.exportTreeDigest,
          },
          submit: { status: submitted.status, partial: submitted.partial, treeDigest: submitted.treeDigest },
          adopt: { adoptedVersionId: adopted.adoptedVersionId, previousVersionId: adopted.previousVersionId },
        },
        detail: '真实检查链跑通 desktop 侧闭环：写改→派生→双检查 PASS→submit(partial)→确认后 adopt 生成 v2',
      };
    },
  },
  {
    id: 'C17',
    group: 'C Coordinator（X1/X3）',
    title: '检查后再写入：submit 不得再派生 → AGENT_EVIDENCE_STALE + issue EVIDENCE_STALE_RERUN_CHECKS + nextAction',
    x: ['X4', 'X6', 'X7'],
    requires: COORDINATOR_REQUIRES.concat(['checks']),
    basis: 'rev15 §14.5 顺序（derive 只发生在检查阶段）+ §14.13-F3（stale 三要素，不得自动补派生）',
    expected: '顺序 = 写 → source.check → composer.dry-run → **再写** → submit：'
      + 'submit 必须返回 AGENT_EVIDENCE_STALE、issues 含 EVIDENCE_STALE_RERUN_CHECKS、nextAction=rerun-checks；'
      + '并且 submit 期间候选目录零写入（不派生 bundle、不改摘要），attempt 仍 open、无 submission 证据',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-c17');
      const registry = makeRegistry(ctx, (request) => (
        request.checkId === 'composer.dry-run'
          ? dryRunResult(request.checkId, request)
          : passResult(request.checkId, 'attempt')
      ));
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-c17');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-c17', run);
      const candidateDir = path.join(project.paths.workspaceDir, 'runs', run.runId, 'turns', run.turnId,
        'attempts', run.attemptId, 'candidate');

      const first = await coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>v1</view>\n' }] },
      });
      assert(first.ok === true, '第一次写入失败');
      for (const checkId of ['source.check', 'composer.dry-run']) {
        const result = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
        assert(result.ok === true, 'run_check ' + checkId + ' 失败：' + JSON.stringify(result.code));
      }
      const afterChecks = coord.getAttemptState(handle);

      const second = await coord.invokeTool({
        ...handle, tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: '<view>v2 改了第二次</view>\n' }] },
      });
      assert(second.ok === true, '第二次写入失败');
      const candidateBeforeSubmit = ctx.env.fingerprintDir(candidateDir);

      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === false, '带陈旧证据的 submit 不得通过');
      // §14.13-F3：唯一合法结论是 stale + 专门 issue + rerun-checks 指令。
      assertRejectedWith(submitted, 'AGENT_EVIDENCE_STALE', '检查后再写 submit');
      const issueCodes = (submitted.issues || []).map((item) => item.code);
      assert(issueCodes.includes('EVIDENCE_STALE_RERUN_CHECKS'),
        'issues 应含 EVIDENCE_STALE_RERUN_CHECKS（§14.13-F3），实际 ' + JSON.stringify(issueCodes));
      assertEqual(submitted.nextAction, 'rerun-checks', 'nextAction 应为 rerun-checks（§14.13-F3）');
      // submit 不得再派生：候选目录必须逐字节不变。
      assertEqual(ctx.env.fingerprintDir(candidateDir).digest, candidateBeforeSubmit.digest,
        'submit 期间候选目录不得被写入（不得再派生 bundle）');

      const stateAfter = coord.getAttemptState(handle);
      assertEqual(stateAfter.status, 'open', '被拒后 attempt 应仍为 open');
      assert(stateAfter.verification.submission === null || stateAfter.verification.submission === undefined,
        '被拒后不得写 submission 证据');

      return {
        status: 'PASS',
        observed: {
          digestAfterChecks: afterChecks.treeDigest,
          digestAfterSecondWrite: second.data.treeDigest,
          submitCode: submitted.code,
          issues: issueCodes,
          nextAction: submitted.nextAction,
          candidateUnchangedBySubmit: true,
          attemptStatus: stateAfter.status,
        },
        detail: '陈旧证据三要素齐全（AGENT_EVIDENCE_STALE + EVIDENCE_STALE_RERUN_CHECKS + rerun-checks），且 submit 未再派生',
      };
    },
  },
];

/** 真实检查注册表（**零替身**：执行真实编排/子进程）。用于 A11O 复核与真实链路用例。 */
function realRegistry(ctx) {
  const mod = ctx.frozen.requireStrict('checks');
  if (!mod || typeof mod.createCheckRegistry !== 'function') {
    throw new Error('checks.createCheckRegistry 不可用，无法做零替身复核');
  }
  return mod.createCheckRegistry({});
}

module.exports = {
  CASES,
  COORDINATOR_REQUIRES,
  // 供 W 组（E0-V1b）复用：同一套临时工程/注册表/断言工具，避免两套语义。
  TARGET_PAGE,
  OPERATION,
  UTTERANCE,
  setupProject,
  newCoordinator,
  realDefinitions,
  realRegistry,
  makeRegistry,
  passResult,
  dryRunResult,
  driveToSubmittable,
  startRun,
  handleOf,
  fileOf,
  readTextOrNull,
  assertRejectedWith,
};
