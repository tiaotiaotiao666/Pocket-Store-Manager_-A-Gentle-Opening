'use strict';

/**
 * V 组：E0-V1 无 UI 垂直链（V01–V15）。
 *
 * 依据：计划 §4 E0-V1 的链路 + rev15 §14.2–§14.5/§14.9/§14.11。
 * 纪律：
 *  - 只调用冻结模块公开导出（Coordinator / checks / versions / source-bundle / agent-runtime），
 *    检查一律用**真实注册表 + 真实子进程/进程内实现**（`checks.createCheckRegistry({})`），不用替身跑绿；
 *  - V03 的“模型”是**确定性 fake upstream**（mock），只替换上游补全，工具循环/写盘/证据都是真实产品代码；
 *    证据里必须标注 mock，不得当真实模型结果；
 *  - 一切断言针对“当前 attempt / 其派生导出树”的 treeDigest / exportTreeDigest，不用 Base/miniprogram 镜像冒充。
 */

const fs = require('node:fs');
const path = require('node:path');

const { assert, assertEqual } = require('../lib/harness.cjs');
const { REPO_ROOT } = require('../lib/env.cjs');
const {
  setupProject,
  newCoordinator,
  realRegistry,
  startRun,
  handleOf,
  readTextOrNull,
  assertRejectedWith,
} = require('./coordinator.cjs');

const V_REQUIRES = ['run-coordinator', 'workspace', 'files', 'manifest', 'versions', 'checks'];

function attemptPaths(project, run) {
  const attemptDir = path.join(project.paths.workspaceDir, 'runs', run.runId, 'turns', run.turnId,
    'attempts', run.attemptId);
  return {
    attemptDir,
    candidateDir: path.join(attemptDir, 'candidate'),
    verificationDir: path.join(attemptDir, 'verification'),
    checksDir: path.join(attemptDir, 'verification', 'checks'),
    attemptFile: path.join(attemptDir, 'attempt.json'),
  };
}

function readEvidence(attemptDirAbs, checkId) {
  const dir = path.join(attemptDirAbs, 'verification', 'checks');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!value || value.checkId !== checkId) continue;
    if (!latest || String(value.at || '') >= String(latest.at || '')) latest = value;
  }
  return latest;
}

async function writeText(coord, handle, relative, content) {
  return coord.invokeTool({ ...handle, tool: 'write_files', args: { changes: [{ path: relative, content }] } });
}

async function runCheck(coord, handle, checkId) {
  return coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
}

/** 真实检查链到“可提交”：写改已由调用方完成；这里跑 source.check + dry-run（真实实现）。 */
async function realChecks(coord, handle) {
  const sourceCheck = await runCheck(coord, handle, 'source.check');
  if (!sourceCheck.ok) return { ok: false, stage: 'source.check', result: sourceCheck };
  const dryRun = await runCheck(coord, handle, 'composer.dry-run');
  if (!dryRun.ok) return { ok: false, stage: 'composer.dry-run', result: dryRun };
  return { ok: true, sourceCheck, dryRun };
}

function probeAssetBytes() {
  return fs.readFileSync(path.join(REPO_ROOT, 'docs', 'evidence', 'workspace-agent', 'e0-r2', 'probe.png'));
}

/** 在临时 userData 里登记一张真实 PNG 资产（与 asset-store 的落盘形状一致）。 */
function seedImageAsset(ctx, projectId) {
  const crypto = require('node:crypto');
  const bytes = probeAssetBytes();
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const fileName = digest.slice(0, 16) + '.png';
  const assetId = 'a_' + digest.slice(0, 16);
  const assetsDir = path.join(ctx.temp.real, 'projects', projectId, 'assets', 'images');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, fileName), bytes);
  const projectFile = path.join(ctx.temp.real, 'projects', projectId, 'project.json');
  let doc = { id: projectId };
  if (fs.existsSync(projectFile)) {
    try { doc = JSON.parse(fs.readFileSync(projectFile, 'utf8')); } catch { /* 重建 */ }
  }
  const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
  images.push({
    assetId, fileName, originalName: 'probe.png', mime: 'image/png', bytes: bytes.length,
    width: 96, height: 96, sha256: 'sha256:' + digest, createdAt: '2026-11-25T00:00:00Z', source: 'user-upload',
  });
  doc.assets = { ...(doc.assets || {}), images };
  fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
  return { assetId, sha256: digest, bytes: bytes.length };
}

/** fake upstream：按脚本返回 tool_calls / 最终答复；证据里标注 mock。 */
function fakeModelChat(ctx, script) {
  const runtime = ctx.frozen.requireStrict('agent-runtime');
  let index = 0;
  const calls = [];
  const chat = async (payload) => {
    calls.push({
      index,
      messageCount: payload.messages.length,
      toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      maxTokens: payload.maxTokens === undefined ? null : payload.maxTokens,
    });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return typeof step === 'function' ? step(payload, index) : step;
  };
  return { modelChat: runtime.createModelChat({ chat }), calls };
}

function createRuntime(ctx, coord, modelChat, options) {
  const runtime = ctx.frozen.requireStrict('agent-runtime');
  return runtime.createDirectWorkspaceRuntime(Object.assign({ coordinator: coord, modelChat }, options || {}));
}

const CASES = [
  {
    id: 'V01',
    group: 'V 垂直链（E0-V1）',
    title: 'startRun 创建 run/turn/attempt，工作树来自当前版本 source；无版本 → AGENT_VERSION_NOT_FOUND 且不建目录',
    x: ['X1', 'X3'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.2 不变量 1–3',
    expected: 'runId 平台生成（frun-…）、attempt-1；baseVersionId=currentVersionId；baseTreeDigest=该版本摘要；'
      + 'attempt 目录位于 <userData>/projects/<projectId>/agent-workspace/runs/…；无 currentVersionId → AGENT_VERSION_NOT_FOUND 且零建目录（不回落 Base）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v01');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const v1Before = ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1'));
      const run = startRun(coord, 'e0v1-v01');
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify({ code: run.code, message: run.message }));
      assert(/^frun-[a-z0-9-]+$/.test(run.runId), 'runId 形状不符：' + run.runId);
      assertEqual(run.attemptId, 'attempt-1', 'attemptId 应为 attempt-1');
      assertEqual(run.baseVersionId, 'v1', 'baseVersionId 应为 currentVersionId');
      assertEqual(run.baseTreeDigest, project.v1TreeDigest, 'baseTreeDigest 应等于当前版本摘要');
      const paths = attemptPaths(project, run);
      assert(ctx.env.isInside(project.paths.workspaceDir, paths.attemptDir), 'attempt 目录应在私有根 runs/ 下');
      const manifest = ctx.frozen.requireStrict('manifest');
      const built = manifest.buildManifest(paths.candidateDir);
      assertEqual(built.manifest.treeDigest, project.v1TreeDigest, '候选树摘要应等于 base 版本摘要');
      assertEqual(ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1')).digest, v1Before.digest,
        'startRun 不得改动 versions/v1');

      const runsBefore = ctx.env.fingerprintDir(project.runsDir);
      const missing = startRun(coord, 'e0v1-v01', { baseVersionId: 'v99' });
      assertRejectedWith(missing, 'AGENT_VERSION_NOT_FOUND', '不存在的 baseVersionId');
      assertEqual(ctx.env.fingerprintDir(project.runsDir).digest, runsBefore.digest, '失败的 startRun 不得建 run 目录');
      return {
        status: 'PASS',
        observed: {
          runId: run.runId, attemptId: run.attemptId, baseVersionId: run.baseVersionId,
          baseTreeDigest: run.baseTreeDigest, revision: run.revision, missingVersionCode: missing.code,
        },
        detail: 'startRun 从当前版本复制 attempt，平台生成 id；缺版本零建目录',
      };
    },
  },
  {
    id: 'V02',
    group: 'V 垂直链（E0-V1）',
    title: '工具上下文固定 subject={kind:"attempt"}；返回 envelope 带 run/turn/attempt；base 版本只读，写入拒绝 version subject',
    x: ['X3'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.3',
    expected: 'invokeTool 返回 envelope 携带 runId/turnId/attemptId；read_file(subjectOverride:version) 只读成功；'
      + 'write_files 传 version subject → AGENT_PAYLOAD_INVALID/AGENT_TOOL_NOT_ALLOWED 且零落盘',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v02');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v02');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v02', run);
      const read = await coord.invokeTool({ ...handle, tool: 'read_file', args: { path: 'app.json' } });
      assert(read.ok === true, 'read_file 失败：' + JSON.stringify(read.code));
      assert(read.meta && typeof read.meta === 'object', 'envelope 应带 meta（§3.3）');
      assertEqual(read.meta.runId, run.runId, 'envelope.meta 应携带 runId');
      assertEqual(read.meta.turnId, run.turnId, 'envelope.meta 应携带 turnId');
      assertEqual(read.meta.attemptId, run.attemptId, 'envelope.meta 应携带 attemptId');

      const state = coord.getAttemptState(handle);
      assertEqual(state.subject.kind, 'attempt', 'subject 固定 attempt');
      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const versionSubject = { kind: 'version', versionId: 'v1' };
      const write1 = await coord.invokeTool({
        ...handle, tool: 'write_files', subject: versionSubject,
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'probe\n' }] },
      });
      assertRejectedWith(write1, ['AGENT_PAYLOAD_INVALID', 'AGENT_TOOL_NOT_ALLOWED'], '写入带 subject');
      const write2 = await coord.invokeTool({
        ...handle, tool: 'write_files', subjectOverride: versionSubject,
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'probe\n' }] },
      });
      assertRejectedWith(write2, ['AGENT_PAYLOAD_INVALID', 'AGENT_TOOL_NOT_ALLOWED'], '写入带 subjectOverride');
      const versionRead = await coord.invokeTool({
        ...handle, tool: 'read_file', args: { path: 'app.json', subjectOverride: versionSubject },
      });
      assert(versionRead.ok === true, 'read_file(version) 应允许只读');
      assertEqual(versionRead.data.content, readTextOrNull(path.join(v1Dir, 'source', 'app.json')),
        'read_file(version) 内容应来自 versions/v1/source');
      assertEqual(ctx.env.fingerprintDir(v1Dir).digest, v1Before.digest, '版本目录必须零写入');
      return {
        status: 'PASS',
        observed: { writeRejections: [write1.code, write2.code], versionReadOnly: true, subjectKind: state.subject.kind },
        detail: 'subject 固定 attempt；写入拒绝 version；版本只读且零写入',
      };
    },
  },
  {
    id: 'V03',
    group: 'V 垂直链（E0-V1）',
    title: 'fake model（mock upstream）读 menu 事实并写真实修改：落 attempt/candidate、revision+1、treeDigest 变化、版本零写入',
    x: ['X1', 'X3'],
    requires: V_REQUIRES.concat(['agent-runtime']),
    basis: '计划 §4 E0-V1 链第 4 步（mock 只替换上游补全，工具循环/写盘真实）',
    expected: 'direct runtime 调 get_context/read_file/write_files 真实落地；候选树含模型写入内容；revision 递增；'
      + '当前版本 source 逐字节不变；trace 只含工具标签与相对路径',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v03');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v03');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v03', run);
      const paths = attemptPaths(project, run);
      const baseWxml = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert(typeof baseWxml === 'string', '候选树应含 pages/menu/index.wxml');
      const marker = '<!-- E0V1-V03 fake-model 写入 -->';
      const writes = [{ path: 'pages/menu/index.wxml', content: baseWxml + '\n' + marker + '\n' }];

      const fake = fakeModelChat(ctx, [
        {
          model: 'fake-upstream-model', finishReason: 'tool_calls', content: '',
          toolCalls: [
            { id: 'c1', name: 'get_context', arguments: '{}' },
            { id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'pages/menu/index.wxml' }) },
            { id: 'c3', name: 'write_files', arguments: JSON.stringify({ changes: writes }) },
          ],
        },
        { model: 'fake-upstream-model', finishReason: 'stop', content: '已写入候选修改。', toolCalls: [] },
      ]);
      const runtime = createRuntime(ctx, coord, fake.modelChat, { userDataDir: ctx.temp.real, vision: false });
      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const before = coord.getAttemptState(handle);
      const result = await runtime.invoke({ context: handle, request: { utterance: '把菜单标题改一下', profile: 'chat' } });
      assert(result.ok === true, 'runtime.invoke 失败：' + JSON.stringify({ code: result.code, message: result.message }));
      assertEqual(result.data.status, 'completed', 'runtime 状态应为 completed');
      const after = coord.getAttemptState(handle);
      assert(after.revision > before.revision, 'revision 应递增：' + before.revision + ' → ' + after.revision);
      assert(after.treeDigest !== before.treeDigest, 'treeDigest 应变化');
      const written = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert(written.includes(marker), '候选树必须含 fake model 写入内容');
      assertEqual(ctx.env.fingerprintDir(v1Dir).digest, v1Before.digest, '当前版本 source 必须字节不变');
      const toolLabels = (result.data.toolCalls || []).map((item) => item.name);
      for (const name of ['get_context', 'read_file', 'write_files']) assert(toolLabels.includes(name),
        'trace 应含 ' + name + '，实际 ' + JSON.stringify(toolLabels));
      const wire = JSON.stringify(result.data);
      assert(!/data:image|sk-[A-Za-z0-9]{8}/.test(wire), 'trace/结果不得含 data URL 或密钥');
      return {
        status: 'PASS',
        observed: {
          mock: 'fake upstream completion（确定性脚本）', revision: [before.revision, after.revision],
          treeDigest: [before.treeDigest, after.treeDigest], toolLabels,
          modelCalls: fake.calls.length, versionWrites: false,
        },
        detail: 'mock upstream 驱动真实工具循环：get_context/read_file/write_files 落 attempt，版本零写入',
      };
    },
  },
  {
    id: 'V04',
    group: 'V 垂直链（E0-V1）',
    title: 'source-bundle 由平台派生（frontend-source-bundle.v1，最终完整内容 + 显式 deleted），模型不可调用派生',
    x: ['X6'],
    requires: V_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.5 / §4.1 source-bundle 形状',
    expected: 'source.check 阶段派生 attempt/candidate/source-bundle.json：schemaVersion=frontend-source-bundle.v1、'
      + 'files[] 最终完整内容摘要、deleted 显式数组、base.treeSha256、targetPages 含目标页；模型调用 derive_source_bundle → AGENT_TOOL_NOT_ALLOWED',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v04');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v04');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v04', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const write = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V04 -->\n');
      assert(write.ok === true, '写入失败');
      const check = await runCheck(coord, handle, 'source.check');
      if (!check.ok) return { status: 'BLOCKED', observed: { code: check.code }, detail: '真实 source.check 不可用' };
      assertEqual(check.data.status, 'PASS', 'source.check 应 PASS');
      const bundleFile = path.join(paths.candidateDir, bundleMod.BUNDLE_FILE);
      assert(fs.existsSync(bundleFile), '检查阶段必须派生 source-bundle.json');
      const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
      assertEqual(bundle.schemaVersion, 'frontend-source-bundle.v1', 'bundle schema 不符');
      assert(Array.isArray(bundle.files) && bundle.files.some((item) => item.path === 'pages/menu/index.wxml'),
        'bundle.files 必须含本次改动文件');
      assert(Array.isArray(bundle.deleted), 'deleted 必须显式数组');
      assert(bundle.base && typeof bundle.base.treeSha256 === 'string', 'base.treeSha256 必须存在');
      assert(Array.isArray(bundle.targetPages) && bundle.targetPages.includes('menu'), 'targetPages 应含 menu');
      const forbidden = await coord.invokeTool({ ...handle, tool: 'derive_source_bundle', args: {} });
      assertRejectedWith(forbidden, 'AGENT_TOOL_NOT_ALLOWED', '模型调用 derive_source_bundle');
      return {
        status: 'PASS',
        observed: { bundleFile: bundleMod.BUNDLE_FILE, fileCount: bundle.files.length, deleted: bundle.deleted.length,
          modelDeriveRejected: forbidden.code },
        detail: 'bundle 由平台在检查阶段派生；模型调用派生工具被拒',
      };
    },
  },
  {
    id: 'V05',
    group: 'V 垂直链（E0-V1）',
    title: 'source.check 必须检查 attempt 树：候选内埋入非法 JSON → FAIL 且 issues[].file 指向该 attempt；Base/版本里同一文件仍合法',
    x: ['X4'],
    requires: V_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.4 第一行 + X4',
    expected: '证据 {checkId,status,treeDigest=attempt 摘要,subjectKind:"attempt",attemptId,at,issues[]}；'
      + '候选 pages/menu/index.json 写成非法 JSON → status=FAIL、issues[].file=pages/menu/index.json；'
      + 'versions/v1 里的同一文件仍是合法 JSON（证明检查对象是 attempt，不是 Base/版本）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v05');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v05');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v05', run);
      const paths = attemptPaths(project, run);
      const versionIndex = path.join(project.paths.versionsDir, 'v1', 'source', 'pages', 'menu', 'index.json');
      JSON.parse(readTextOrNull(versionIndex)); // 前置：版本文件合法
      const broken = await writeText(coord, handle, 'pages/menu/index.json', '{ "navigationBarTitleText": ');
      assert(broken.ok === true, '写入失败');
      const check = await runCheck(coord, handle, 'source.check');
      if (!check.ok) return { status: 'BLOCKED', observed: { code: check.code }, detail: '真实 source.check 不可用' };
      assertEqual(check.data.status, 'FAIL', '非法 JSON 应让 source.check FAIL');
      assertEqual(check.data.subjectKind, 'attempt', '证据主体必须是 attempt');
      const state = coord.getAttemptState(handle);
      assertEqual(check.data.treeDigest, state.treeDigest, '证据 treeDigest 必须等于当前 attempt 摘要');
      const files = (check.data.issues || []).map((item) => String(item.file || '').split(path.sep).join('/'));
      assert(files.some((file) => file === 'pages/menu/index.json' || file.endsWith('/pages/menu/index.json')),
        'issues[].file 应指向 attempt 里的 pages/menu/index.json，实际 ' + JSON.stringify(files.slice(0, 5)));
      const evidence = readEvidence(paths.attemptDir, 'source.check');
      assert(evidence, '应落盘 source.check 证据');
      assertEqual(evidence.subjectKind, 'attempt', '落盘证据 subjectKind=attempt');
      assertEqual(evidence.attemptId, run.attemptId, '落盘证据绑定 attemptId');
      JSON.parse(readTextOrNull(versionIndex)); // 版本里的同一文件仍合法
      return {
        status: 'PASS',
        observed: { status: check.data.status, subjectKind: check.data.subjectKind, treeDigest: check.data.treeDigest,
          issueFiles: files.slice(0, 3), versionFileStillValid: true },
        detail: 'source.check 真实执行于 attempt；候选违法被命中，版本同文件未被牵连',
      };
    },
  },
  {
    id: 'V06',
    group: 'V 垂直链（E0-V1）',
    title: 'composer.dry-run 以当前 attempt 为输入，导出树落 attempt/verification/dry-run/，内容含本次改动且摘要稳定',
    x: ['X4', 'X6'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.4 第二行 / §14.5',
    expected: '返回相对 exportRelative（含 verification/、不含 miniprogram/）+ exportTreeDigest；导出树包含本次写入标记；'
      + '两次 dry-run 的导出树摘要一致；仓库 miniprogram/ 逐字节不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v06');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v06');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v06', run);
      const paths = attemptPaths(project, run);
      const mirrorBefore = ctx.env.fingerprintDir(path.join(REPO_ROOT, 'miniprogram'));
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const marker = 'E0V1-V06 导出树标记';
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- ' + marker + ' -->\n')).ok === true, '写入失败');
      const first = await runCheck(coord, handle, 'composer.dry-run');
      if (!first.ok) return { status: 'BLOCKED', observed: { code: first.code }, detail: '真实 composer.dry-run 不可用' };
      assertEqual(first.data.status, 'PASS', 'dry-run 应 PASS：' + JSON.stringify((first.data.issues || []).map((item) => item.code)));
      assertEqual(first.data.subjectKind, 'attempt', 'dry-run 证据主体必须是 attempt');
      const exportRelative = first.data.exportRelative;
      assert(typeof exportRelative === 'string' && exportRelative.includes('verification/'),
        '导出根应在 attempt/verification/ 下，实际 ' + exportRelative);
      assert(!exportRelative.includes('miniprogram'), '导出根不得是仓库镜像');
      const exportAbs = path.join(paths.attemptDir, ...exportRelative.split('/'));
      assert(fs.existsSync(exportAbs), '导出树必须存在');
      assert(readTextOrNull(path.join(exportAbs, 'pages', 'menu', 'index.wxml')).includes(marker),
        '导出树必须包含本次 attempt 改动');
      assert(/^sha256:[0-9a-f]{64}$/.test(String(first.data.exportTreeDigest)), '应返回 sha256 导出树摘要');
      const second = await runCheck(coord, handle, 'composer.dry-run');
      assert(second.ok === true, '第二次 dry-run 失败');
      assertEqual(second.data.exportTreeDigest, first.data.exportTreeDigest, '两次 compose 的导出树摘要应一致');
      assertEqual(ctx.env.fingerprintDir(path.join(REPO_ROOT, 'miniprogram')).digest, mirrorBefore.digest,
        'dry-run 不得写仓库镜像 miniprogram/');
      return {
        status: 'PASS',
        observed: { exportRelative, exportTreeDigest: first.data.exportTreeDigest, twoDryRunsEqual: true },
        detail: 'dry-run 以 attempt 为输入、导出树落 verification/，两次摘要一致，仓库镜像零写入',
      };
    },
  },
  {
    id: 'V07',
    group: 'V 垂直链（E0-V1）',
    title: 'mini.check / output.consistency 只查本 attempt 派生导出树；无导出树 → AGENT_CHECK_UNKNOWN；root 指向 miniprogram/ 被拒',
    x: ['X4'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.4 第三/四行 + “绝不回落仓库 miniprogram/”',
    expected: '未跑 dry-run 时 mini.check → AGENT_CHECK_UNKNOWN；root 参数指向 miniprogram → AGENT_PAYLOAD_INVALID 且 runner 0 调用；'
      + '跑过 dry-run 后两条检查以 exportRoot=该导出树执行，证据 exportTreeDigest 对齐；status 只用四态',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v07');
      const real = realRegistry(ctx);
      const calls = [];
      const registry = {
        definitions: real.definitions,
        async runCheck(request) {
          calls.push({ checkId: request.checkId, root: request.root || null, exportRoot: request.exportRoot || null });
          return real.runCheck(request);
        },
      };
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-v07');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v07', run);
      const paths = attemptPaths(project, run);
      const before = await runCheck(coord, handle, 'mini.check');
      const beforeCode = assertRejectedWith(before, 'AGENT_CHECK_UNKNOWN', '无导出树时 mini.check');
      assertEqual(calls.length, 0, '缺导出树必须先拒，runner 调用 0 次');

      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V07 -->\n')).ok === true, '写入失败');
      const sourceCheck = await runCheck(coord, handle, 'source.check');
      assert(sourceCheck.ok === true, 'source.check 失败：' + JSON.stringify(sourceCheck.code));
      const dryRun = await runCheck(coord, handle, 'composer.dry-run');
      if (!dryRun.ok) return { status: 'BLOCKED', observed: { code: dryRun.code }, detail: 'dry-run 不可用' };
      const exportedAbs = path.join(paths.attemptDir, ...String(dryRun.data.exportRelative).split('/'));
      const mini = await runCheck(coord, handle, 'mini.check');
      assert(mini.ok === true, 'mini.check 失败：' + JSON.stringify(mini.code));
      const miniCall = calls.filter((item) => item.checkId === 'mini.check').pop();
      assertEqual(miniCall.exportRoot, exportedAbs, 'mini.check exportRoot 必须等于本 attempt dry-run 导出树');
      if (mini.data.exportTreeDigest) {
        assertEqual(mini.data.exportTreeDigest, dryRun.data.exportTreeDigest, 'mini.check 导出摘要应与 dry-run 一致');
      }
      assert(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(mini.data.status), 'status 必须四态之一');
      const consistency = await runCheck(coord, handle, 'output.consistency');
      assert(consistency.ok === true, 'output.consistency 失败：' + JSON.stringify(consistency.code));
      assert(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(consistency.data.status), 'status 必须四态之一');
      const rootInjection = await coord.invokeTool({
        ...handle, tool: 'run_check', args: { checkId: 'mini.check', root: path.join(REPO_ROOT, 'miniprogram') },
      });
      assertRejectedWith(rootInjection, ['AGENT_PAYLOAD_INVALID', 'AGENT_CHECK_UNKNOWN'], '模型注入 root 指向镜像');
      return {
        status: 'PASS',
        observed: { beforeCode, miniStatus: mini.data.status, miniSubjectKind: mini.data.subjectKind,
          consistencyStatus: consistency.data.status, rootInjection: rootInjection.code, exportRootPinned: true },
        detail: '导出树级检查绑定本 attempt 的 dry-run 导出树；缺树先拒，root 注入被拒，不回落镜像',
      };
    },
  },
  {
    id: 'V08',
    group: 'V 垂直链（E0-V1）',
    title: 'submitAttempt 静态门禁 + 证据绑定：缺证据/旧摘要/非法页均不置 submitted；成功返回体含 F1 六项',
    x: ['X7'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.5 submit 静态门禁 + §14.13-F1',
    expected: '缺 source.check/dry-run → AGENT_STATIC_GATE_FAILED；检查后再写 → AGENT_EVIDENCE_STALE；'
      + '非法 targetPage → AGENT_TARGET_PAGE_UNSUPPORTED；齐全时 status=submitted 且返回 candidateId/revision/treeDigest/'
      + 'exportRelative/exportTreeDigest/targetPage/status',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v08');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v08');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v08', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V08 -->\n')).ok === true, '写入失败');

      const noEvidence = coord.submitAttempt(handle);
      assertRejectedWith(noEvidence, 'AGENT_STATIC_GATE_FAILED', '无检查证据 submit');
      assertEqual(coord.getAttemptState(handle).status, 'open', '缺证据不得置 submitted');

      const checks = await realChecks(coord, handle);
      if (!checks.ok) return { status: 'BLOCKED', observed: { stage: checks.stage, code: checks.result.code }, detail: '真实检查链不可用' };
      assertEqual(checks.sourceCheck.data.status, 'PASS', 'source.check 应 PASS');
      assertEqual(checks.dryRun.data.status, 'PASS', 'dry-run 应 PASS');
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V08 第二次写入 -->\n')).ok === true,
        '第二次写入失败');
      const stale = coord.submitAttempt(handle);
      assertRejectedWith(stale, 'AGENT_EVIDENCE_STALE', '检查后再写 submit');
      const issueCodes = (stale.issues || []).map((item) => item.code);
      assert(issueCodes.includes('EVIDENCE_STALE_RERUN_CHECKS'), '应带 EVIDENCE_STALE_RERUN_CHECKS');
      assertEqual(stale.nextAction, 'rerun-checks', 'nextAction 应为 rerun-checks');

      // 重新按顺序跑检查并提交，成功后校验 F1 返回体。
      const recheck = await realChecks(coord, handle);
      assert(recheck.ok === true, '重跑检查失败：' + JSON.stringify(recheck.stage));
      const badPage = coord.submitAttempt({ ...handle, targetPage: 'not-a-page' });
      assertRejectedWith(badPage, 'AGENT_TARGET_PAGE_UNSUPPORTED', '非法 targetPage');
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, '齐全证据后 submit 应成功：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      assertEqual(submitted.status, 'submitted', '状态只能是 submitted');
      for (const field of ['candidateId', 'revision', 'treeDigest', 'exportRelative', 'exportTreeDigest', 'targetPage', 'status']) {
        assert(submitted[field] !== undefined && submitted[field] !== null, 'F1：返回体缺字段 ' + field);
      }
      assertEqual(submitted.treeDigest, coord.getAttemptState(handle).treeDigest, '提交摘要应等于当前 attempt 摘要');
      assertEqual(submitted.exportTreeDigest, recheck.dryRun.data.exportTreeDigest, '提交导出摘要应等于 dry-run 摘要');
      assert(!/^[A-Za-z]:/.test(String(submitted.exportRelative)), 'exportRelative 必须是相对路径');
      return {
        status: 'PASS',
        observed: {
          noEvidence: noEvidence.code, stale: stale.code, issues: issueCodes, badPage: badPage.code,
          submitted: { status: submitted.status, treeDigest: submitted.treeDigest, exportTreeDigest: submitted.exportTreeDigest,
            targetPage: submitted.targetPage, partial: submitted.partial },
        },
        detail: '静态门禁三路拒绝命中；齐全后 submitted 且 F1 字段逐项存在',
      };
    },
  },
  {
    id: 'V09',
    group: 'V 垂直链（E0-V1）',
    title: 'submitted 后该 attempt 只读；重复 submit 拒绝；repair 不覆盖已提交候选（新 run/attempt 承接）',
    x: ['X3', 'X7'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.2 不变量 4',
    expected: 'submitted 后 write_files/delete_files → AGENT_ATTEMPT_IMMUTABLE 且零落盘；再次 submit → AGENT_RUN_ALREADY_SUBMITTED；'
      + '已提交 attempt 指纹不变；后续修改只能落在新 run 的新 attempt',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v09');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v09');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v09', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V09 -->\n')).ok === true, '写入失败');
      const checks = await realChecks(coord, handle);
      if (!checks.ok) return { status: 'BLOCKED', observed: { code: checks.result.code }, detail: '真实检查链不可用' };
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功：' + JSON.stringify(submitted.code));
      const candidateBefore = ctx.env.fingerprintDir(paths.candidateDir);
      const writeAfter = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- 迟到写入 -->\n');
      assertRejectedWith(writeAfter, 'AGENT_ATTEMPT_IMMUTABLE', '提交后写入');
      const deleteAfter = await coord.invokeTool({ ...handle, tool: 'delete_files', args: { paths: [{ path: 'pages/menu/index.wxml' }] } });
      assertRejectedWith(deleteAfter, 'AGENT_ATTEMPT_IMMUTABLE', '提交后删除');
      const again = coord.submitAttempt(handle);
      assertRejectedWith(again, 'AGENT_RUN_ALREADY_SUBMITTED', '重复提交');
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, candidateBefore.digest, '提交后候选目录必须零写入');

      const repairRun = startRun(coord, 'e0v1-v09', { operation: 'repair-menu', utterance: '修复菜单' });
      assert(repairRun.ok === true, 'repair 新 run 失败：' + JSON.stringify(repairRun.code));
      assert(repairRun.runId !== run.runId, 'repair 必须是新 run');
      const repairHandle = handleOf('e0v1-v09', repairRun);
      const repairWrite = await writeText(coord, repairHandle, 'pages/menu/index.wxml', current + '\n<!-- repair -->\n');
      assert(repairWrite.ok === true, 'repair 新 attempt 写入应成功');
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, candidateBefore.digest,
        'repair 不得覆盖已提交 attempt-1');
      return {
        status: 'PASS',
        observed: { writeAfter: writeAfter.code, deleteAfter: deleteAfter.code, again: again.code,
          repairRunId: repairRun.runId, repairAttemptId: repairRun.attemptId, submittedAttemptUnchanged: true },
        detail: '提交后只读/重复提交拒绝；repair 由新 run 承接，已提交候选字节不变',
      };
    },
  },
  {
    id: 'V10',
    group: 'V 垂直链（E0-V1）',
    title: 'adoptAttempt 读磁盘 submitted + verification 证据并校验摘要绑定：成功生成 parent=当前版本的新版本；陈旧/未确认被拒',
    x: ['X7'],
    requires: V_REQUIRES,
    basis: 'rev15 §14.5 adopt-attempt 段 + §14.12-Q1',
    expected: '成功路径 adoptedVersionId=v2、previous=v1、adoption.sourceKind=agent-edit、verification 四态落 version.json；'
      + '未确认 partial → AGENT_PARTIAL_CONFIRM_REQUIRED；篡改 submission.treeDigest → AGENT_EVIDENCE_STALE',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v10');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v10');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v10', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const marker = '<!-- V10 -->';
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n' + marker + '\n')).ok === true, '写入失败');
      const checks = await realChecks(coord, handle);
      if (!checks.ok) return { status: 'BLOCKED', observed: { code: checks.result.code }, detail: '真实检查链不可用' };
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功：' + JSON.stringify(submitted.code));
      assertEqual(submitted.partial, true, 'wechat.verify 未跑时应为 partial');
      const unconfirmed = coord.adoptAttempt(handle);
      assertRejectedWith(unconfirmed, 'AGENT_PARTIAL_CONFIRM_REQUIRED', '未确认 partial');
      const versionsBefore = ctx.env.fingerprintDir(project.paths.versionsDir);
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === true, '确认后 adopt 应成功：' + JSON.stringify({ code: adopted.code, message: adopted.message }));
      assertEqual(adopted.adoptedVersionId, 'v2', '应生成 v2');
      assertEqual(adopted.previousVersionId, 'v1', 'parent 应为 v1');
      assert(adopted.adoption && adopted.adoption.sourceKind === 'agent-edit', 'adoption.sourceKind 应为 agent-edit');
      assertEqual(ctx.env.fingerprintDir(project.paths.versionsDir).digest !== versionsBefore.digest, true, '应新增版本目录');
      const v2Source = path.join(project.paths.versionsDir, 'v2', 'source', 'pages', 'menu', 'index.wxml');
      assert(readTextOrNull(v2Source).includes(marker), 'v2 源应含本次修改');
      const versionRead = project.versions.readVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v10', versionId: 'v2' });
      assert(versionRead.ok === true, 'readVersion(v2) 失败');
      const verification = versionRead.version.verification || {};
      assert(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(verification.runtime), 'version.verification.runtime 应为四态，实际 '
        + JSON.stringify(verification.runtime));
      return {
        status: 'PASS',
        observed: { unconfirmed: unconfirmed.code, adoptedVersionId: adopted.adoptedVersionId,
          previousVersionId: adopted.previousVersionId, sourceKind: adopted.adoption.sourceKind,
          runtimeVerification: verification.runtime, treeDigest: adopted.treeDigest },
        detail: 'adopt 读磁盘证据：未确认 partial 被拒，确认后生成 parent=v1 的 v2 且 verification 四态落盘',
      };
    },
  },
  {
    id: 'V11',
    group: 'V 垂直链（E0-V1）',
    title: 'undo/redo/reopen：指针语义成立；篡改当前版本 source 后 reopen → AGENT_VERSION_CONFLICT 且不回退 Base',
    x: ['X7', 'X11'],
    requires: ['versions', 'run-coordinator', 'workspace', 'files', 'manifest'],
    basis: 'B2 §2.2 + rev15 §14.2',
    expected: 'undo→v1(redo=v2)；redo→v2(redo=null)；versions/ 目录集合不变；篡改 v2 source 后 reopen → AGENT_VERSION_CONFLICT，指针仍 v2',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v11');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v11');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v11', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V11 -->\n')).ok === true, '写入失败');
      const checks = await realChecks(coord, handle);
      if (!checks.ok) return { status: 'BLOCKED', observed: { code: checks.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handle).ok === true, 'submit 失败');
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === true, 'adopt 失败：' + JSON.stringify(adopted.code));
      const dirsBefore = fs.readdirSync(project.paths.versionsDir).slice().sort();
      const undone = project.versions.undoVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assert(undone.ok === true, 'undo 失败：' + JSON.stringify(undone.code));
      const afterUndo = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assertEqual(afterUndo.state.currentVersionId, 'v1', 'undo 后应为 v1');
      assertEqual(afterUndo.state.redoVersionId, 'v2', 'undo 后 redo 应为 v2');
      const redone = project.versions.redoVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assert(redone.ok === true, 'redo 失败');
      const afterRedo = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assertEqual(afterRedo.state.currentVersionId, 'v2', 'redo 后应为 v2');
      assertEqual(afterRedo.state.redoVersionId, null, 'redo 后 redo 指针应清空');
      assertEqual(JSON.stringify(fs.readdirSync(project.paths.versionsDir).slice().sort()), JSON.stringify(dirsBefore),
        'undo/redo 不得新增/删除版本目录');

      const currentSourceFile = path.join(project.paths.versionsDir, 'v2', 'source', 'app.json');
      const original = fs.readFileSync(currentSourceFile, 'utf8');
      fs.writeFileSync(currentSourceFile, original + '\n// drift\n', 'utf8');
      const conflict = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assertRejectedWith(conflict, 'AGENT_VERSION_CONFLICT', '篡改当前版本后 reopen');
      fs.writeFileSync(currentSourceFile, original, 'utf8');
      const recovered = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assert(recovered.ok === true, '恢复后 reopen 应回绿：' + JSON.stringify(recovered.code));
      const finalState = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-v11' });
      assertEqual(finalState.state.currentVersionId, 'v2', 'reopen 冲突不得回退版本指针');
      return {
        status: 'PASS',
        observed: { undo: 'v1', redo: 'v2', conflict: conflict.code, versionDirs: dirsBefore.length },
        detail: 'undo/redo 只动指针；漂移 reopen fail-closed 且不回退 Base',
      };
    },
  },
  {
    id: 'V12',
    group: 'V 垂直链（E0-V1）',
    title: '导出同源：verifyExportIdentity PASS；导出源 = versions/<current>/source；逐文件摘要与索引一致；漂移不回落 Base',
    x: ['X6', 'X7'],
    requires: ['versions', 'run-coordinator', 'workspace', 'files', 'manifest'],
    basis: 'B2 §2.4 + rev15 §14.5',
    expected: 'verifyExportIdentity 当前版本 PASS；resolveVersionSource.sourceRoot=versions/<current>/source；重算摘要=索引摘要；'
      + '篡改 source 后 verifyExportIdentity → AGENT_EXPORT_IDENTITY_MISMATCH',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v12');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v12');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v12', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V12 -->\n')).ok === true, '写入失败');
      const checks = await realChecks(coord, handle);
      if (!checks.ok) return { status: 'BLOCKED', observed: { code: checks.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handle).ok === true, 'submit 失败');
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === true, 'adopt 失败：' + JSON.stringify(adopted.code));
      assert(project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: 'e0v1-v12' }).ok === true, 'reopen 失败');
      const identity = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: 'e0v1-v12' });
      assert(identity.ok === true, 'verifyExportIdentity 失败：' + JSON.stringify(identity.code));
      const resolved = project.versions.resolveVersionSource({ userDataDir: ctx.temp.real, projectId: 'e0v1-v12' });
      assert(resolved.ok === true, 'resolveVersionSource 失败');
      assertEqual(ctx.env.normalizeForCompare(resolved.sourceRoot),
        ctx.env.normalizeForCompare(path.join(project.paths.versionsDir, 'v2', 'source')), '导出源不是当前版本 source');
      const manifest = ctx.frozen.requireStrict('manifest');
      const rebuilt = manifest.buildManifest(resolved.sourceRoot);
      assertEqual(rebuilt.manifest.treeDigest, resolved.treeDigest, '重算摘要应等于索引 treeDigest');
      assertEqual(rebuilt.manifest.treeDigest, adopted.treeDigest, '导出摘要应等于 adopt 的版本摘要');
      const driftFile = path.join(resolved.sourceRoot, 'app.json');
      const original = fs.readFileSync(driftFile, 'utf8');
      fs.writeFileSync(driftFile, original + '\n// drift\n', 'utf8');
      const drift = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: 'e0v1-v12' });
      assertRejectedWith(drift, 'AGENT_EXPORT_IDENTITY_MISMATCH', '篡改 source 后 verifyExportIdentity');
      fs.writeFileSync(driftFile, original, 'utf8');
      const recovered = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: 'e0v1-v12' });
      assert(recovered.ok === true, '恢复后 verifyExportIdentity 应 PASS');
      return {
        status: 'PASS',
        observed: { versionId: resolved.versionId, sourceRoot: path.basename(path.dirname(resolved.sourceRoot)),
          treeDigest: resolved.treeDigest, drift: drift.code },
        detail: '导出同源 + 摘要一致；漂移 fail-closed 不回落 Base',
      };
    },
  },
  {
    id: 'V13',
    group: 'V 垂直链（E0-V1）',
    title: 'cancelRun 三态与迟到工具：取消后 direct 不再发上游、工具不落盘；取消后调用返回 AGENT_CANCELLED',
    x: ['X8', 'X12'],
    requires: V_REQUIRES.concat(['model-call-scheduler']),
    basis: 'rev15 §14.2 不变量 6 / §14.6 第 7 条 / §3.3',
    expected: '在途 cancel=requested，停止后查询=cancelled；已完成/未知=too-late 且 cancelled=false；'
      + '取消后 invokeTool/invokeDirect 均 AGENT_CANCELLED，fake 上游调用 0 次，attempt 摘要不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v13');
      let resolveCheck = null;
      let registryCalls = 0;
      let interceptOnce = true;
      const baseRegistry = realRegistry(ctx);
      const registry = {
        definitions: baseRegistry.definitions,
        async runCheck(request) {
          if (request.checkId === 'source.check' && interceptOnce) {
            interceptOnce = false;
            registryCalls += 1;
            await new Promise((resolve) => { resolveCheck = resolve; });
            return { ok: true, checkId: request.checkId, status: 'PASS', durationMs: 1, issues: [], subjectKind: 'attempt' };
          }
          return baseRegistry.runCheck(request);
        },
      };
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-v13');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v13', run);
      const paths = attemptPaths(project, run);
      const before = coord.getAttemptState(handle);

      // 在途 run_check：等它真正进入注册表后取消 → requested；迟到结果被丢弃且零落盘。
      const pending = coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      while (registryCalls === 0) await new Promise((resolve) => setImmediate(resolve));
      const first = coord.cancelRun({ ...handle, reason: 'user' });
      assert(first.ok === true, '首次 cancel 失败：' + JSON.stringify(first.code));
      assertEqual(first.state, 'requested', '在途 cancel 应为 requested');
      assertEqual(first.cancelled, false, 'requested 不得声称已取消');
      // 取消请求发出时的树摘要（run_check 的平台派生发生在等待注册表之前，属取消前已提交的写）。
      const digestAtCancel = coord.getAttemptState(handle).treeDigest;
      resolveCheck();
      const lateCheck = await pending;
      assertRejectedWith(lateCheck, 'AGENT_CANCELLED', '迟到的 run_check 结果');
      assertEqual(coord.getAttemptState(handle).runState, 'cancelled', '在途结束后 run 应落 cancelled');
      const evidenceDir = paths.checksDir;
      const lateEvidence = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : [];
      assertEqual(lateEvidence.length, 0, '迟到检查结果不得写证据，实际 ' + JSON.stringify(lateEvidence));

      const lateTool = await writeText(coord, handle, 'pages/menu/index.wxml', '迟到写入\n');
      assertRejectedWith(lateTool, 'AGENT_CANCELLED', '取消后工具调用');
      assertEqual(coord.getAttemptState(handle).treeDigest, digestAtCancel, '迟到工具调用不得改变 attempt 摘要');
      const second = coord.getRun({ projectId: 'e0v1-v13', runId: run.runId });
      assertEqual(second.state, 'cancelled', '取消后 run 状态应为 cancelled');
      const again = coord.cancelRun({ ...handle, reason: 'user' });
      assertEqual(again.state, 'cancelled', '重复取消应为 cancelled（幂等）');
      assertEqual(again.cancelled, true, '重复取消 cancelled=true');

      // 取消后 direct 不得再发上游（fake 上游调用计数必须为 0）。
      let upstreamCalls = 0;
      const runtime = ctx.frozen.requireStrict('agent-runtime');
      const fake = runtime.createModelChat({
        chat: async () => { upstreamCalls += 1; return { content: '迟到答案', finishReason: 'stop', toolCalls: [] }; },
      });
      const direct = runtime.createDirectWorkspaceRuntime({ coordinator: coord, modelChat: fake, userDataDir: ctx.temp.real });
      const lateDirect = await direct.invoke({ context: handle, request: { utterance: '继续改' } });
      assert(lateDirect.ok === false, '取消后 direct 不得成功');
      assert(['AGENT_CANCELLED'].includes(lateDirect.code), '取消后 direct 应 AGENT_CANCELLED，实际 ' + lateDirect.code);
      assertEqual(upstreamCalls, 0, '取消后不得发起上游调用');

      const run2 = startRun(coord, 'e0v1-v13', { operation: 'edit-menu', utterance: '第二次' });
      assert(run2.ok === true, '第二个 run 失败');
      const submitRun = handleOf('e0v1-v13', run2);
      const current = readTextOrNull(path.join(attemptPaths(project, run2).candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, submitRun, 'pages/menu/index.wxml', current + '\n<!-- V13 -->\n')).ok === true, '写入失败');
      const checks = await realChecks(coord, submitRun);
      if (!checks.ok) return { status: 'BLOCKED', observed: { code: checks.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(submitRun).ok === true, 'submit 失败');
      const tooLate = coord.cancelRun(submitRun);
      assertEqual(tooLate.state, 'too-late', '已提交后 cancel 应为 too-late');
      assertEqual(tooLate.cancelled, false, 'too-late 不得显示为已取消/失败');
      return {
        status: 'PASS',
        observed: { first: first.state, lateCheck: lateCheck.code, lateTool: lateTool.code, runState: second.state,
          tooLate: tooLate.state, upstreamCalls, lateEvidenceCount: lateEvidence.length },
        detail: '在途 requested → cancelled；迟到检查/工具零落盘；取消后 direct 0 次上游；已提交 too-late',
      };
    },
  },
  {
    id: 'V14',
    group: 'V 垂直链（E0-V1）',
    title: 'progress 事件只发白名单 stage/status，payload 无绝对路径/源码/base64/prompt/Key，未知 stage 不静默丢步',
    x: ['X10'],
    requires: ['run-coordinator', 'workspace', 'files', 'manifest', 'versions', 'checks'],
    basis: 'rev15 §14.9 / §9.1',
    expected: 'emitProgress 收到的 stage ∈ PROGRESS_STAGES，status ∈ {running,succeeded,failed,cancelled}；'
      + 'payload 无盘符路径/data:image/长 base64/私有根；未知 stage 缺省为 workspace 而不是丢事件',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v14');
      const events = [];
      const coord = newCoordinator(ctx, {
        checks: realRegistry(ctx),
        emitProgress: (event) => events.push(event),
      });
      const run = startRun(coord, 'e0v1-v14');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v14', run);
      const current = readTextOrNull(path.join(attemptPaths(project, run).candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- V14 -->\n')).ok === true, '写入失败');
      const coordMod = ctx.frozen.requireStrict('run-coordinator');
      const stages = coordMod.PROGRESS_STAGES;
      assert(stages && typeof stages.has === 'function', 'PROGRESS_STAGES 应是 Set');
      assert(events.length > 0, '应至少发出 1 条 progress 事件');
      for (const event of events) {
        assert(stages.has(event.stage), '未登记 stage：' + event.stage);
        assert(['running', 'succeeded', 'failed', 'cancelled'].includes(event.status), '非法 status：' + event.status);
        const wire = JSON.stringify(event);
        assert(!/[A-Za-z]:\\/.test(wire), 'progress 不得含盘符路径');
        assert(!/data:image|base64,/.test(wire), 'progress 不得含图片 data URL');
        assert(!wire.includes(ctx.temp.real), 'progress 不得含私有根绝对路径');
        assert(!/sk-[A-Za-z0-9]{8}/.test(wire), 'progress 不得含密钥');
      }
      return {
        status: 'PASS',
        observed: { eventCount: events.length, stages: Array.from(new Set(events.map((item) => item.stage))),
          statuses: Array.from(new Set(events.map((item) => item.status))) },
        detail: 'progress stage/status 白名单 + 脱敏成立（' + events.length + ' 条）',
      };
    },
  },
  {
    id: 'V15',
    group: 'V 垂直链（E0-V1 全链）',
    title: '完整垂直链（单 attempt）：init/adopt base → run/attempt → 真实写改 → derive bundle → source.check → dry-run → mini/output → submit → adopt → undo/redo/reopen/export',
    x: ['X1', 'X3', 'X4', 'X5', 'X6', 'X7', 'X11'],
    requires: V_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: '计划 §4 E0-V1 主链 + rev15 §14.11 通过条件（全部断言绑定当前 attempt/导出树摘要）',
    expected: '每一步都成功且摘要对齐：source.check.treeDigest=当前 attempt；dry-run.exportTreeDigest 固定；'
      + 'mini/output 只查该导出树；submit.treeDigest=当前 attempt；adopt 生成的版本摘要=提交摘要；'
      + 'undo/redo/reopen/verifyExportIdentity 全部成立；版本 v1 字节不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-v15');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-v15', { targetPage: 'menu', operation: 'edit-menu', utterance: '把招牌菜改成红烧肉' });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-v15', run);
      const paths = attemptPaths(project, run);
      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const menuJson = path.join(paths.candidateDir, 'pages', 'menu', 'index.json');
      const baseJson = readTextOrNull(menuJson);
      assert(typeof baseJson === 'string', '候选树应含 pages/menu/index.json');
      const title = 'E0V1 全链招牌菜';
      const nextJson = JSON.stringify({ ...JSON.parse(baseJson), navigationBarTitleText: title }, null, 2) + '\n';
      const write = await writeText(coord, handle, 'pages/menu/index.json', nextJson);
      assert(write.ok === true, '写入失败：' + JSON.stringify(write.code));
      const afterWrite = coord.getAttemptState(handle);

      const sourceCheck = await runCheck(coord, handle, 'source.check');
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: '真实 source.check 不可用' };
      assertEqual(sourceCheck.data.status, 'PASS', 'source.check 应 PASS：'
        + JSON.stringify((sourceCheck.data.issues || []).map((item) => item.code)));
      // 检查阶段平台会派生 source-bundle 并重算 treeDigest；证据必须绑定派生后的“当前 attempt”摘要。
      const afterCheck = coord.getAttemptState(handle);
      assertEqual(sourceCheck.data.treeDigest, afterCheck.treeDigest, 'source.check 摘要必须等于检查后的当前 attempt 摘要');
      const bundleFile = path.join(paths.candidateDir, 'source-bundle.json');
      assert(fs.existsSync(bundleFile), '检查阶段必须派生 source-bundle.json');

      const dryRun = await runCheck(coord, handle, 'composer.dry-run');
      assert(dryRun.ok === true, 'dry-run 失败：' + JSON.stringify(dryRun.code));
      assertEqual(dryRun.data.status, 'PASS', 'dry-run 应 PASS');
      const exportRelative = dryRun.data.exportRelative;
      const exportAbs = path.join(paths.attemptDir, ...exportRelative.split('/'));
      assert(readTextOrNull(path.join(exportAbs, 'pages', 'menu', 'index.json')).includes(title),
        '导出树必须含本次真实改动');

      const mini = await runCheck(coord, handle, 'mini.check');
      assert(mini.ok === true, 'mini.check 失败：' + JSON.stringify(mini.code));
      const consistency = await runCheck(coord, handle, 'output.consistency');
      assert(consistency.ok === true, 'output.consistency 失败：' + JSON.stringify(consistency.code));
      for (const item of [mini, consistency]) {
        assert(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(item.data.status), '导出级检查 status 必须四态');
        if (item.data.exportTreeDigest) {
          assertEqual(item.data.exportTreeDigest, dryRun.data.exportTreeDigest, '导出级证据摘要应绑定同一导出树');
        }
      }
      assertEqual([mini.data.status, consistency.data.status].includes('FAIL'), false, '导出级检查不得 FAIL');

      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 失败：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      assertEqual(submitted.treeDigest, afterCheck.treeDigest, '提交摘要必须等于当前 attempt 摘要');
      assertEqual(submitted.exportTreeDigest, dryRun.data.exportTreeDigest, '提交导出摘要必须等于 dry-run 摘要');
      assertEqual(submitted.status, 'submitted', '状态应为 submitted');

      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === true, 'adopt 失败：' + JSON.stringify(adopted.code));
      assertEqual(adopted.adoptedVersionId, 'v2', 'adopt 应生成 v2');
      const v2File = path.join(project.paths.versionsDir, 'v2', 'source', 'pages', 'menu', 'index.json');
      assert(readTextOrNull(v2File).includes(title), 'v2 源应含本次改动');
      const v2Read = project.versions.readVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15', versionId: 'v2' });
      assertEqual(v2Read.version.treeDigest, submitted.treeDigest, 'v2 摘要必须等于提交的候选摘要');
      assertEqual(ctx.env.fingerprintDir(v1Dir).digest, v1Before.digest, 'v1 必须字节不变');

      assert(project.versions.undoVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15' }).ok === true, 'undo 失败');
      assert(project.versions.redoVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15' }).ok === true, 'redo 失败');
      const reopened = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15' });
      assert(reopened.ok === true, 'reopen 失败：' + JSON.stringify(reopened.code));
      const identity = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15' });
      assert(identity.ok === true, 'verifyExportIdentity 失败：' + JSON.stringify(identity.code));
      const resolved = project.versions.resolveVersionSource({ userDataDir: ctx.temp.real, projectId: 'e0v1-v15' });
      assertEqual(resolved.treeDigest, adopted.treeDigest, '导出身份摘要应等于 adopt 摘要');

      return {
        status: 'PASS',
        observed: {
          runId: run.runId, attemptId: run.attemptId, treeAfterWrite: afterWrite.treeDigest,
          treeAfterCheck: afterCheck.treeDigest,
          sourceCheck: { status: sourceCheck.data.status, treeDigest: sourceCheck.data.treeDigest },
          exportRelative, exportTreeDigest: dryRun.data.exportTreeDigest,
          mini: mini.data.status, consistency: consistency.data.status,
          submit: { status: submitted.status, treeDigest: submitted.treeDigest, partial: submitted.partial },
          adopt: { adoptedVersionId: adopted.adoptedVersionId, previousVersionId: adopted.previousVersionId,
            treeDigest: adopted.treeDigest },
          reopen: true, exportIdentity: true, v1Unchanged: true,
        },
        detail: '无 UI 全链闭环：所有检查/提交/采用摘要均绑定当前 attempt 及其派生导出树',
      };
    },
  },
];

module.exports = { CASES, V_REQUIRES, seedImageAsset, fakeModelChat, createRuntime, attemptPaths };
