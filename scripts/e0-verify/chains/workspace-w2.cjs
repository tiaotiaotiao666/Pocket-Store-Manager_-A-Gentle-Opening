'use strict';

/**
 * W 组（E0-V1b 增量）：对 **t5 E0-W2** 的独立复核。
 *
 * 判定对象：X4（检查目标绑定 attempt / 派生导出树）、X5（8 页单一来源）、X6（bundle 平台派生与不可变）、
 * X7（静态门禁 / 证据绑定 / 三分码 / F1–F4）、句柄身份、direct 接线。依据：rev15 §14.4/§14.5/§14.7/§14.12/§14.13。
 *
 * 纪律：
 *  - A11O/W01–W04、W05–W08 一律用**真实注册表 + 真实编排/子进程**（`checks.createCheckRegistry({})`），不用替身；
 *  - 只有“主体路由/root 注入”这类需要观察平台入参的断言，才用“记录入参后转交真实实现”的包装注册表；
 *  - 每条断言都写清“哪条不成立就说明 X 未关闭”，不接受“ok:false 就算过”；
 *  - 不写产品代码：本文件只读产品模块、只写临时 userData 与 docs/。
 */

const fs = require('node:fs');
const path = require('node:path');

const { assert, assertEqual } = require('../lib/harness.cjs');
const { REPO_ROOT } = require('../lib/env.cjs');
const {
  setupProject,
  newCoordinator,
  realDefinitions,
  realRegistry,
  makeRegistry,
  passResult,
  handleOf,
  readTextOrNull,
  assertRejectedWith,
} = require('./coordinator.cjs');

const W2_REQUIRES = ['run-coordinator', 'workspace', 'files', 'manifest', 'versions', 'checks'];

/** 记录平台入参后再**转交真实实现**：既不替身判定，又能断言“平台填了什么”。 */
function recordingRealRegistry(ctx) {
  const real = realRegistry(ctx);
  const calls = [];
  return {
    calls,
    definitions: real.definitions,
    async runCheck(request) {
      calls.push({
        checkId: request.checkId,
        root: request.root === undefined ? null : request.root,
        exportRoot: request.exportRoot === undefined ? null : request.exportRoot,
        exportParentDir: request.exportParentDir === undefined ? null : request.exportParentDir,
        subjectKind: request.subjectKind === undefined ? null : request.subjectKind,
        subjectKindKey: Object.prototype.hasOwnProperty.call(request, 'subjectKind'),
        attemptId: request.attemptId,
        projectId: request.projectId,
      });
      return real.runCheck(request);
    },
  };
}

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

function sha256File(file) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 在 `<root>/<top>` 下找第一个相对路径（用于“删一个真实资产”的攻击场景）。 */
function firstRelativeUnder(root, top) {
  const base = path.join(root, top);
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    const absolute = relative ? path.join(base, ...relative.split('/')) : base;
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        pending.push(childRelative);
        continue;
      }
      if (entry.isFile()) return top + '/' + childRelative.split('\\').join('/');
    }
  }
  return null;
}

/** 读 attempt/verification/checks/*.json 里某个 checkId 的最新证据。 */
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
  return coord.invokeTool({
    ...handle, tool: 'write_files', args: { changes: [{ path: relative, content }] },
  });
}

/** 新门禁：dry-run 后必须跑两项导出检查；source/dry-run 的旧证据会由平台刷新。 */
async function runExportGateChecks(coord, handle) {
  for (const checkId of ['mini.check', 'output.consistency']) {
    const result = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
    assert(result.ok === true && result.data.status === 'PASS', checkId + ' 失败：' + JSON.stringify(result));
  }
}

const CASES = [
  /* ---------------- X4 / A11O 复核：检查真的落在 attempt 与派生导出树 ---------------- */
  {
    id: 'W01',
    group: 'W t5 复核（X4）',
    title: 'A11O 复核：source.check 在 attempt 候选树上执行（埋入 attempt 独有的非法 JSON 必须在 issues 里命中）',
    x: ['X4'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.4（source.check 主体=attempt，root 只由平台填）+ §14.5（检查只针对当前 attempt）',
    expected: '注册表收到的 root=attempt/candidate（不是仓库/版本路径）；在候选里写入 pages/menu/index.json 的非法 JSON 后，'
      + 'source.check 必须 FAIL 且 issues[].file 指向该 attempt 相对路径；同时 versions/v1 里的同一文件仍是合法 JSON '
      + '（证明失败只可能来自 attempt 树，而不是仓库或已采用版本）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w01');
      const registry = recordingRealRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = coord.startRun({
        projectId: 'e0v1-w01', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败：' + JSON.stringify(run.code));
      const handle = handleOf('e0v1-w01', run);
      const paths = attemptPaths(project, run);

      const v1Index = path.join(project.paths.versionsDir, 'v1', 'source', 'pages', 'menu', 'index.json');
      const baseIndexText = readTextOrNull(v1Index);
      assert(typeof baseIndexText === 'string', 'versions/v1 应含 pages/menu/index.json');
      let baseParsed = true;
      try { JSON.parse(baseIndexText); } catch { baseParsed = false; }
      assert(baseParsed === true, '前置：已采用版本里的 index.json 必须是合法 JSON（否则本用例判据失效）');

      const broken = await writeText(coord, handle, 'pages/menu/index.json', '{ "navigationBarTitleText": ');
      assert(broken.ok === true, '写入非法 JSON 失败：' + JSON.stringify(broken.code));

      const result = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!result.ok) {
        return {
          status: 'BLOCKED',
          observed: { code: result.code || null, message: result.message || null },
          detail: '真实 source.check 不可用（' + String(result.code) + '），A11O 复核无法在本环境判定',
        };
      }
      const call = registry.calls.find((item) => item.checkId === 'source.check');
      assert(call, '检查注册表应收到 source.check 调用');
      assertEqual(call.root, paths.candidateDir, 'source.check 的 root 必须是 attempt 候选树（不能是仓库/版本路径）');
      assert(!String(call.root).includes(path.join('templates')), 'source.check 的 root 不得指向 templates/**');
      assertEqual(call.subjectKind, 'attempt', '平台必须以 subjectKind=attempt 调用 source.check');
      assertEqual(call.exportRoot, null, 'attempt 主体检查不得带导出根');

      assertEqual(result.data.status, 'FAIL', '非法 JSON 必须让 source.check FAIL：' + JSON.stringify(result.data.status));
      const files = (result.data.issues || []).map((item) => String(item.file || ''));
      assert(files.some((file) => file === 'pages/menu/index.json' || file.endsWith('/pages/menu/index.json')
        || file === 'pages/menu/index.json'.replace(/\//g, '\\')),
        'issues[].file 必须指向 attempt 里的 pages/menu/index.json，实际 ' + JSON.stringify(files.slice(0, 5)));
      assertEqual(result.data.subjectKind, 'attempt', '证据主体必须是 attempt');
      assertEqual(result.data.treeDigest, coord.getAttemptState(handle).treeDigest,
        '证据 treeDigest 必须等于当前候选摘要');

      const evidence = readEvidence(paths.attemptDir, 'source.check');
      assert(evidence, '应在 attempt/verification/checks 下落 source.check 证据');
      assertEqual(evidence.subjectKind, 'attempt', '落盘证据的 subjectKind 必须是 attempt');
      assertEqual(evidence.attemptId, run.attemptId, '落盘证据必须绑定 attemptId');
      assert(fs.existsSync(path.join(project.paths.versionsDir, 'v1', 'source', 'pages', 'menu', 'index.json')),
        '检查不得改动已采用版本的源树');

      return {
        status: 'PASS',
        observed: {
          rootIsCandidate: true,
          subjectKindFromRegistry: call.subjectKind,
          statusOnBrokenJson: result.data.status,
          issueFiles: files.slice(0, 3),
          evidenceSubjectKind: evidence.subjectKind,
        },
        detail: 'source.check 真实执行于 attempt 候选树：候选内非法 JSON 被命中，已采用版本不受影响',
      };
    },
  },
  {
    id: 'W02',
    group: 'W t5 复核（X4）',
    title: 'A11O 复核：composer.dry-run 的 compose 输入是当前 attempt，导出树落 attempt/verification/',
    x: ['X4', 'X6'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.4（导出根只由平台派生）+ §14.5（dry-run 在 attempt 内产出导出树）',
    expected: 'run_check 入参 root=attempt/candidate、exportParentDir=attempt/verification；'
      + '导出根相对引用落在 attempt 内（含 verification/，不含 miniprogram/ 或仓库路径）；'
      + '导出树里能读到本次 attempt 的改动（标记字符串）；仓库 miniprogram/ 逐字节不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w02');
      const registry = recordingRealRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = coord.startRun({
        projectId: 'e0v1-w02', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w02', run);
      const paths = attemptPaths(project, run);
      const mirrorBefore = ctx.env.fingerprintDir(path.join(REPO_ROOT, 'miniprogram'));

      const marker = 'E0V1B-W02 导出树必须含本次改动';
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert(typeof current === 'string', '候选树应含 pages/menu/index.wxml');
      const written = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- ' + marker + ' -->\n');
      assert(written.ok === true, '写入失败：' + JSON.stringify(written.code));

      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      if (!dryRun.ok) {
        const blocked = String(dryRun.code || '').startsWith('AGENT_RUNTIME')
          || dryRun.code === 'AGENT_CHECK_UNKNOWN';
        return {
          status: blocked ? 'BLOCKED' : 'FAIL',
          observed: { code: dryRun.code || null, message: dryRun.message || null },
          detail: '真实 composer.dry-run 不可用（' + String(dryRun.code) + '）',
        };
      }
      assertEqual(dryRun.data.status, 'PASS', '真实 composer.dry-run 应 PASS：'
        + JSON.stringify((dryRun.data.issues || []).map((item) => item.code)));
      assertEqual(dryRun.data.subjectKind, 'attempt', 'dry-run 证据主体必须是 attempt');

      const call = registry.calls.find((item) => item.checkId === 'composer.dry-run');
      assert(call, '注册表应收到 composer.dry-run 调用');
      assertEqual(call.root, paths.candidateDir, 'dry-run 的 compose 输入必须是 attempt 候选树');
      assertEqual(call.exportParentDir, paths.verificationDir, 'dry-run 的导出父目录必须是 attempt/verification');

      const exportRelative = dryRun.data.exportRelative;
      assert(typeof exportRelative === 'string' && exportRelative.length > 0, 'dry-run 应回导出根相对引用');
      // §14.4 冻结：导出树固定落 attempt/verification/dry-run/（不是 verification 下任意位置）。
      assertEqual(String(exportRelative).split('\\').join('/'), 'verification/dry-run',
        '导出根必须是 attempt/verification/dry-run（§14.4），实际 ' + exportRelative);
      assert(!exportRelative.includes('miniprogram'), '导出根不得是仓库镜像 miniprogram/，实际 ' + exportRelative);
      assert(!/^[A-Za-z]:/.test(exportRelative) && !exportRelative.startsWith('/'),
        '导出根必须是相对引用，实际 ' + exportRelative);
      const exportedAbs = path.join(paths.attemptDir, ...exportRelative.split('/'));
      assert(fs.existsSync(exportedAbs), '导出树必须真实存在：' + exportRelative);

      const exportedPage = readTextOrNull(path.join(exportedAbs, 'pages', 'menu', 'index.wxml'));
      assert(typeof exportedPage === 'string', '导出树应含 pages/menu/index.wxml');
      assert(exportedPage.includes(marker), '导出树必须包含本次 attempt 的改动（否则 compose 没用当前候选）');
      assert(typeof dryRun.data.exportTreeDigest === 'string'
        && /^sha256:[0-9a-f]{64}$/.test(dryRun.data.exportTreeDigest), 'dry-run 应给出 sha256 导出树摘要');
      // F3：派生的唯一合法位置是检查阶段 —— 没跑过 source.check 时，composer.dry-run 必须自己补派生。
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      assert(fs.existsSync(path.join(paths.candidateDir, bundleMod.BUNDLE_FILE)),
        'dry-run 阶段应补派生 source-bundle.json（§14.13-F3：派生只发生在检查阶段）');

      const mirrorAfter = ctx.env.fingerprintDir(path.join(REPO_ROOT, 'miniprogram'));
      assertEqual(mirrorAfter.digest, mirrorBefore.digest, 'dry-run 不得写仓库镜像 miniprogram/');

      return {
        status: 'PASS',
        observed: {
          rootIsCandidate: true,
          exportParentIsVerification: true,
          exportRelative,
          exportTreeDigestHead: dryRun.data.exportTreeDigest.slice(0, 19),
          exportedContainsAttemptEdit: true,
        },
        detail: 'dry-run 以 attempt 为输入、导出树落 attempt/verification/，仓库镜像零写入',
      };
    },
  },
  {
    id: 'W03',
    group: 'W t5 复核（X4）',
    title: 'A11O 复核：mini.check / output.consistency 只查本 attempt 的派生导出树，缺导出树即 AGENT_CHECK_UNKNOWN（不回落 miniprogram/）',
    x: ['X4'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.4（导出树级检查的 root 只能来自本 attempt 的 dry-run 证据）',
    expected: '未跑 dry-run 时 mini.check → AGENT_CHECK_UNKNOWN（不得回落到仓库 miniprogram/）；'
      + '跑过 dry-run 后 mini.check 以 exportRoot=该导出树执行，证据 subjectKind=export 且 exportTreeDigest 等于 dry-run 摘要；'
      + '把导出树删掉后再次 mini.check → 仍 AGENT_CHECK_UNKNOWN',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w03');
      const registry = recordingRealRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = coord.startRun({
        projectId: 'e0v1-w03', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w03', run);
      const paths = attemptPaths(project, run);

      const beforeDryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'mini.check' } });
      const beforeCode = assertRejectedWith(beforeDryRun,
        ['AGENT_CHECK_UNKNOWN', 'AGENT_EVIDENCE_STALE'], '未跑 dry-run 的 mini.check');
      assert(!registry.calls.some((item) => item.checkId === 'mini.check'),
        '缺导出树时必须先拒（注册表 0 次调用），实际 ' + JSON.stringify(registry.calls.map((item) => item.checkId)));

      const marker = 'E0V1B-W03 导出树标记';
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const written = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- ' + marker + ' -->\n');
      assert(written.ok === true, '写入失败');
      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      assert(sourceCheck.ok === true, 'source.check 失败：' + JSON.stringify(sourceCheck.code));
      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      if (!dryRun.ok) return { status: 'BLOCKED', observed: { code: dryRun.code }, detail: 'dry-run 不可用' };
      assertEqual(dryRun.data.status, 'PASS', 'dry-run 应 PASS');

      const mini = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'mini.check' } });
      assert(mini.ok === true, 'mini.check 调用失败：' + JSON.stringify({ code: mini.code, message: mini.message }));
      const miniCall = registry.calls.filter((item) => item.checkId === 'mini.check').pop();
      const exportedAbs = path.join(paths.attemptDir, ...String(dryRun.data.exportRelative).split('/'));
      assertEqual(miniCall.exportRoot, exportedAbs, 'mini.check 的 exportRoot 必须是本 attempt 的 dry-run 导出树');
      assertEqual(miniCall.subjectKind, 'export', 'mini.check 必须以 subjectKind=export 执行');
      assertEqual(mini.data.subjectKind, 'export', 'mini.check 证据主体应为 export');
      assertEqual(mini.data.exportTreeDigest, dryRun.data.exportTreeDigest,
        'mini.check 证据的 exportTreeDigest 必须等于 dry-run 的导出树摘要');

      const consistency = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'output.consistency' } });
      assert(consistency.ok === true, 'output.consistency 调用失败：' + JSON.stringify(consistency.code));
      assertEqual(consistency.data.subjectKind, 'export', 'output.consistency 证据主体应为 export');

      // 删掉导出树：导出树级检查必须报“缺根”，绝不回落仓库 miniprogram/。
      fs.rmSync(exportedAbs, { recursive: true, force: true });
      const afterDelete = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'mini.check' } });
      const afterDeleteCode = assertRejectedWith(afterDelete,
        ['AGENT_CHECK_UNKNOWN', 'AGENT_EVIDENCE_STALE'], '导出树被删后的 mini.check');

      return {
        status: 'PASS',
        observed: {
          miniWithoutDryRun: beforeCode,
          miniStatus: mini.data.status,
          miniSubjectKind: mini.data.subjectKind,
          consistencySubjectKind: consistency.data.subjectKind,
          afterExportRemoved: afterDeleteCode,
        },
        detail: '导出树级检查全部绑定本 attempt 的 dry-run 导出树；缺树先拒，不回落仓库镜像',
      };
    },
  },
  {
    id: 'W04',
    group: 'W t5 复核（X4）',
    title: 'A11O 复核：capabilities.check 是独立 repo 级检查（不冒名 source.check），run_check 不给它注入 attempt 根',
    x: ['X4'],
    requires: W2_REQUIRES,
    basis: 'rev15 §14.4（capabilities.check 为仓库级）+ §14.12-5（source.check 必须直连 frontend-source/check.cjs）',
    expected: 'definitions 里 source.check.subject=attempt 且 script=scripts/frontend-source/check.cjs；'
      + 'capabilities.check.subject=repo 且 script=scripts/frontend-capabilities.cjs（两者脚本不同，不得互相冒名）；'
      + '契约别名 capabilities.source-facts 与 canonical 指向同一实现（清理项，记录不阻塞）；'
      + 'run_check(capabilities.check) 时注册表收到的请求不带 root/exportRoot/subjectKind（repo 级不注入 attempt 路径）',
    async run(ctx) {
      setupProject(ctx, 'e0v1-w04');
      const definitions = realDefinitions(ctx);
      assert(definitions['source.check'], 'definitions 缺 source.check');
      assert(definitions['capabilities.check'], 'definitions 缺独立 capabilities.check');
      assertEqual(definitions['source.check'].subject, 'attempt', 'source.check 主体应为 attempt');
      assertEqual(definitions['capabilities.check'].subject, 'repo', 'capabilities.check 主体应为 repo');
      assertEqual(definitions['source.check'].script, 'scripts/frontend-source/check.cjs',
        'source.check 必须直连 scripts/frontend-source/check.cjs（§14.12-5）');
      assertEqual(definitions['capabilities.check'].script, 'scripts/frontend-capabilities.cjs',
        'capabilities.check 应指向 frontend-capabilities（仓库级）');
      assert(definitions['source.check'].script !== definitions['capabilities.check'].script,
        'source.check 与 capabilities.check 不得是同一实现（禁止冒名）');
      const aliasPresent = Boolean(definitions['capabilities.source-facts']);
      const aliasSame = aliasPresent
        && definitions['capabilities.source-facts'].script === definitions['capabilities.check'].script;

      const registry = makeRegistry(ctx, (request) => passResult(request.checkId, 'repo'));
      const coord = newCoordinator(ctx, { checks: registry });
      const run = coord.startRun({
        projectId: 'e0v1-w04', targetPage: 'menu', operation: 'edit-quality', utterance: '检查仓库能力快照',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w04', run);
      const result = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'capabilities.check' } });
      assert(result.ok === true, 'run_check(capabilities.check) 失败：' + JSON.stringify(result.code));
      const call = registry.calls.find((item) => item.checkId === 'capabilities.check');
      assert(call, '注册表应收到 capabilities.check 调用');
      assertEqual(call.root, null, 'repo 级检查不得注入 attempt 候选根');
      assertEqual(call.exportRoot, null, 'repo 级检查不得注入导出根');
      assertEqual(call.subjectKind, null, 'repo 级检查不得声明 subjectKind（不得冒名 attempt/export）');
      assertEqual(result.data.subjectKind, 'repo', 'capabilities.check 证据主体应为 repo');

      return {
        status: 'PASS',
        observed: {
          sourceCheckScript: definitions['source.check'].script,
          capabilitiesScript: definitions['capabilities.check'].script,
          aliasPresent,
          aliasSame,
          rootInjected: call.root,
          subjectKindInjected: call.subjectKind,
        },
        detail: 'capabilities.check 与 source.check 是两条独立检查；repo 级不注入 attempt 路径'
          + (aliasPresent ? '；别名 capabilities.source-facts 仍存在（清理项，见 finding）' : ''),
      };
    },
  },

  /* ---------------- X5：8 页单一来源 ---------------- */
  {
    id: 'W05',
    group: 'W t5 复核（X5）',
    title: 'X5：get_context.targetPages 是 [{id,enabled,reasons}] 派生（删掉候选里的页面文件必须立刻变为 enabled=false）',
    x: ['X5'],
    requires: W2_REQUIRES.concat(['source-bundle']),
    basis: 'rev15 §14.5（页枚举唯一事实源 SourceFacts，enabled 由候选树派生，不是 8 个硬编码 true）',
    expected: 'targetPages 长度=8、id 集合等于 source-bundle.PAGE_IDS、每项含布尔 enabled 与数组 reasons；'
      + '删掉候选里的 pages/mine/index.json + index.wxml 后，mine 必须 enabled=false 且 reasons 指出缺文件 '
      + '（若 8 个永远为 true，本用例失败）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w05');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx, { checks: makeRegistry(ctx, (request) => passResult(request.checkId, 'attempt')) });
      const run = coord.startRun({
        projectId: 'e0v1-w05', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w05', run);
      const paths = attemptPaths(project, run);

      const context1 = await coord.invokeTool({ ...handle, tool: 'get_context', args: {} });
      assert(context1.ok === true, 'get_context 失败：' + JSON.stringify(context1.code));
      const pages1 = context1.data.targetPages;
      assert(Array.isArray(pages1), 'get_context.targetPages 必须是数组');
      assertEqual(pages1.length, 8, 'targetPages 应覆盖 8 页');
      assertEqual(pages1.map((item) => item.id).join(','), bundleMod.PAGE_IDS.join(','),
        'targetPages 的 id 集合必须等于 SourceFacts.PAGE_IDS');
      for (const item of pages1) {
        assertEqual(typeof item.enabled, 'boolean', item.id + ' 的 enabled 必须是布尔');
        assert(Array.isArray(item.reasons), item.id + ' 的 reasons 必须是数组');
      }
      // X5 单一来源：source-bundle 的 8 页枚举必须逐项等于 SourceFacts，且每页有页面契约。
      const facts = require(path.join(REPO_ROOT, 'scripts', 'agent-source-facts.cjs'));
      assertEqual(bundleMod.PAGE_IDS.join(','), facts.PAGE_IDS.join(','),
        'source-bundle.PAGE_IDS 必须逐项等于 scripts/agent-source-facts.cjs#PAGE_IDS（单一来源）');
      assertEqual(pages1.map((item) => item.id).join(','), facts.PAGE_IDS.join(','),
        'get_context.targetPages 的顺序/集合必须来自 SourceFacts');
      for (const item of pages1) {
        assert(facts.PAGE_CONTRACTS && facts.PAGE_CONTRACTS[item.id],
          item.id + ' 必须在 SourceFacts.PAGE_CONTRACTS 里有页面契约');
      }
      const enabledBefore = pages1.filter((item) => item.enabled).map((item) => item.id);

      // 派生证明：删掉候选里的一个页面四件套，它必须立刻变 disabled 并给出原因。
      const target = 'mine';
      for (const extension of ['json', 'wxml']) {
        const removed = await coord.invokeTool({
          ...handle, tool: 'delete_files', args: { paths: [{ path: 'pages/' + target + '/index.' + extension }] },
        });
        assert(removed.ok === true, '删除 pages/' + target + '/index.' + extension + ' 失败：' + JSON.stringify(removed.code));
      }
      const context2 = await coord.invokeTool({ ...handle, tool: 'get_context', args: {} });
      assert(context2.ok === true, '第二次 get_context 失败');
      const mine = context2.data.targetPages.find((item) => item.id === target);
      assert(mine, 'targetPages 应仍包含 ' + target);
      assertEqual(mine.enabled, false, '删掉候选页面文件后 ' + target + ' 必须 enabled=false（派生，不是硬编码 true）');
      assert(mine.reasons.length > 0, target + ' 被禁用时必须给出 reasons');
      assert(mine.reasons.some((reason) => String(reason).includes('index.')), 'reasons 应指出缺失的页面文件，实际 '
        + JSON.stringify(mine.reasons));

      return {
        status: 'PASS',
        observed: {
          pageIds: pages1.map((item) => item.id),
          enabledBefore,
          enabledCountBefore: enabledBefore.length,
          mineAfterDelete: { enabled: mine.enabled, reasons: mine.reasons.slice(0, 3) },
          source: context1.data.targetPageEnumSource || null,
        },
        detail: '8 页枚举来自 SourceFacts 且 enabled 随候选树派生（删除页面后立刻禁用并给出原因）',
      };
    },
  },
  {
    id: 'W06',
    group: 'W t5 复核（X5）',
    title: 'X5：用非 menu 页（home）走真实检查链提交成功；非法页与跨 run 目标页 → AGENT_TARGET_PAGE_UNSUPPORTED',
    x: ['X5', 'X7'],
    requires: W2_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.5（targetPage 只认 8 页枚举，且必须是本次 run 的目标页且在候选中可用）',
    expected: 'startRun(targetPage=home) ok；submit(targetPage=menu) → AGENT_TARGET_PAGE_UNSUPPORTED（与 run 目标页不一致）；'
      + 'startRun(targetPage=not-a-page) → AGENT_TARGET_PAGE_UNSUPPORTED；'
      + 'home 页改完后真实 source.check + dry-run PASS → submit 成功且 targetPage=home',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w06');
      const coord = newCoordinator(ctx);
      const bad = coord.startRun({
        projectId: 'e0v1-w06', targetPage: 'not-a-page', operation: 'edit-home', utterance: '改首页',
      });
      const badCode = assertRejectedWith(bad, 'AGENT_TARGET_PAGE_UNSUPPORTED', '非法 targetPage');

      const run = coord.startRun({
        projectId: 'e0v1-w06', targetPage: 'home', operation: 'edit-home', utterance: '改首页文案',
      });
      assert(run.ok === true, 'startRun(home) 失败：' + JSON.stringify({ code: run.code, message: run.message }));
      assertEqual(run.targetPage, 'home', 'startRun 应回 targetPage=home');
      const handle = handleOf('e0v1-w06', run);
      const paths = attemptPaths(project, run);

      const mismatch = coord.submitAttempt({ ...handle, targetPage: 'menu' });
      const mismatchCode = assertRejectedWith(mismatch, 'AGENT_TARGET_PAGE_UNSUPPORTED', '与 run 目标页不一致的 submit');

      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'home', 'index.wxml'));
      assert(typeof current === 'string', '候选树应含 pages/home/index.wxml');
      const marker = 'E0V1B-W06 首页改动';
      const written = await writeText(coord, handle, 'pages/home/index.wxml', current + '\n<!-- ' + marker + ' -->\n');
      assert(written.ok === true, '写入 home 页失败：' + JSON.stringify(written.code));

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) {
        return {
          status: 'BLOCKED',
          observed: { code: sourceCheck.code, badPage: badCode, mismatch: mismatchCode },
          detail: '真实 source.check 不可用（' + String(sourceCheck.code) + '）',
        };
      }
      assertEqual(sourceCheck.data.status, 'PASS', 'home 页改动后 source.check 应 PASS：'
        + JSON.stringify((sourceCheck.data.issues || []).map((item) => item.code)));
      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败：' + JSON.stringify(dryRun.code));
      assertEqual(dryRun.data.status, 'PASS', 'home 页 dry-run 应 PASS');
      await runExportGateChecks(coord, handle);

      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'home 页 submit 应成功：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      assertEqual(submitted.targetPage, 'home', 'submit 应回传 targetPage=home');
      assertEqual(submitted.status, 'submitted', '状态应为 submitted');
      assertEqual(submitted.exportTreeDigest, dryRun.data.exportTreeDigest, '提交证据应绑定 dry-run 导出树摘要');

      return {
        status: 'PASS',
        observed: {
          badPageCode: badCode,
          mismatchedSubmitCode: mismatchCode,
          sourceCheck: sourceCheck.data.status,
          dryRun: dryRun.data.status,
          submittedTargetPage: submitted.targetPage,
        },
        detail: '非 menu 页（home）真实链路提交成功；非法页与跨 run 目标页均被拒',
      };
    },
  },

  /* ---------------- X6：bundle 平台派生 / 不可变 ---------------- */
  {
    id: 'W07',
    group: 'W t5 复核（X6）',
    title: 'X6：source-bundle 由平台派生、内容为最终完整文件 + deleted 显式，且 submit 前后逐字节不变',
    x: ['X6', 'X7'],
    requires: W2_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.5（bundle 平台派生 + submit 不再派生，§14.13-F3）',
    expected: '检查阶段派生 attempt/candidate/source-bundle.json：schemaVersion=frontend-source-bundle.v1、'
      + 'files[] 每项 {path,sha256} 且包含本次改动的 pages/menu/index.wxml、deleted 为显式数组、base.treeSha256 存在；'
      + 'submit 前后该文件字节与候选摘要完全不变（submit 不派生）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w07');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w07', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w07', run);
      const paths = attemptPaths(project, run);

      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const marker = 'E0V1B-W07 bundle 派生标记';
      const written = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- ' + marker + ' -->\n');
      assert(written.ok === true, '写入失败');
      assert(!fs.existsSync(path.join(paths.candidateDir, bundleMod.BUNDLE_FILE)),
        '前置：写入后、检查前候选里不应已经有 source-bundle.json');

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: 'source.check 不可用' };
      assertEqual(sourceCheck.data.status, 'PASS', 'source.check 应 PASS');

      const bundleFile = path.join(paths.candidateDir, bundleMod.BUNDLE_FILE);
      assert(fs.existsSync(bundleFile), 'source.check 阶段必须由平台派生 source-bundle.json（X6）');
      const bundleBytesBefore = sha256File(bundleFile);
      const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
      assertEqual(bundle.schemaVersion, 'frontend-source-bundle.v1', 'bundle.schemaVersion 不符');
      assert(Array.isArray(bundle.files) && bundle.files.length > 0, 'bundle.files 必须非空');
      assert(bundle.files.every((item) => typeof item.path === 'string' && /^(sha256:)?[0-9a-f]{64}$/.test(String(item.sha256))),
        'bundle.files[] 必须是 {path, sha256} 且摘要为 sha256 十六进制');
      assert(bundle.files.some((item) => item.path === 'pages/menu/index.wxml'),
        'bundle.files 必须包含本次改动的 pages/menu/index.wxml');
      assert(Array.isArray(bundle.deleted), 'bundle.deleted 必须是显式数组（即使为空）');
      assert(bundle.base && typeof bundle.base.treeSha256 === 'string', 'bundle.base.treeSha256 必须存在');
      assert(Array.isArray(bundle.targetPages) && bundle.targetPages.includes('menu'),
        'bundle.targetPages 应包含本次目标页 menu');
      // X6「files 为最终完整文件内容」：每项 sha256 必须等于候选真实字节摘要（不是 diff 片段）。
      const crypto = require('node:crypto');
      const digestOfBuffer = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
      const baseSourceRoot = path.join(project.paths.versionsDir, 'v1', 'source');
      assert(!bundle.files.some((item) => item.path === bundleMod.BUNDLE_FILE),
        '清单自身（source-bundle.json）不得出现在 bundle.files');
      for (const item of bundle.files) {
        const candidateFile = path.join(paths.candidateDir, ...item.path.split('/'));
        assert(fs.existsSync(candidateFile), 'bundle.files 列出的文件必须真实存在于候选：' + item.path);
        assertEqual(String(item.sha256).replace(/^sha256:/, ''), digestOfBuffer(fs.readFileSync(candidateFile)).replace(/^sha256:/, ''),
          'bundle.files 的 sha256 必须是候选文件的最终完整内容摘要：' + item.path);
        // 只列“Base → 候选”真正改动过的文件（不是整棵树快照）。
        const baseFile = path.join(baseSourceRoot, ...item.path.split('/'));
        if (fs.existsSync(baseFile)) {
          assert(!fs.readFileSync(baseFile).equals(fs.readFileSync(candidateFile)),
            'bundle.files 不应列出与 Base 相同的未改动文件：' + item.path);
        }
      }

      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败：' + JSON.stringify(dryRun.code));
      assertEqual(dryRun.data.status, 'PASS', 'dry-run 应 PASS');
      await runExportGateChecks(coord, handle);
      const stateBeforeSubmit = coord.getAttemptState(handle);
      const bundleBytesAfterChecks = sha256File(bundleFile);

      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 失败：' + JSON.stringify({ code: submitted.code, message: submitted.message }));
      const bundleBytesAfterSubmit = sha256File(bundleFile);
      assertEqual(bundleBytesAfterSubmit, bundleBytesBefore, 'submit 前后 source-bundle.json 必须逐字节不变（submit 不派生）');
      assertEqual(bundleBytesAfterChecks, bundleBytesBefore, '检查阶段之后 bundle 也应保持字节不变（幂等派生）');
      const stateAfterSubmit = coord.getAttemptState(handle);
      assertEqual(stateAfterSubmit.treeDigest, stateBeforeSubmit.treeDigest, 'submit 不得改候选摘要');
      assertEqual(stateAfterSubmit.revision, stateBeforeSubmit.revision, 'submit 不得改 revision');

      return {
        status: 'PASS',
        observed: {
          bundleFile: bundleMod.BUNDLE_FILE,
          fileCount: bundle.files.length,
          deletedCount: bundle.deleted.length,
          hasBaseTreeSha: true,
          bundleSha256Head: bundleBytesBefore.slice(0, 16),
          unchangedAcrossSubmit: true,
        },
        detail: 'bundle 由检查阶段平台派生、内容为最终完整文件摘要 + 显式 deleted，submit 逐字节不变',
      };
    },
  },
  {
    id: 'W08',
    group: 'W t5 复核（X6）',
    title: 'X6/F3：bundle 缺失时**在检查阶段补派生**，submit 只拒绝、绝不派生',
    x: ['X6', 'X7'],
    requires: W2_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.5 + §14.13-F3（derive 只能发生在检查阶段；submit 不得补派生）',
    expected: '有写入但没跑检查时 submit → 被拒（AGENT_STATIC_GATE_FAILED）且候选目录逐字节不变、bundle 仍不存在；'
      + '随后 source.check 触发平台派生 → bundle 出现；再 dry-run → submit 成功',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w08');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w08', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w08', run);
      const paths = attemptPaths(project, run);

      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const written = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- E0V1B-W08 -->\n');
      assert(written.ok === true, '写入失败');
      const bundleFile = path.join(paths.candidateDir, bundleMod.BUNDLE_FILE);
      assert(!fs.existsSync(bundleFile), '前置：写入后不应存在 bundle');
      const candidateBeforeSubmit = ctx.env.fingerprintDir(paths.candidateDir);

      const submitted = coord.submitAttempt(handle);
      const submitCode = assertRejectedWith(submitted,
        ['AGENT_STATIC_GATE_FAILED', 'AGENT_EVIDENCE_STALE'], '未检查就提交');
      assert(!fs.existsSync(bundleFile), 'submit 绝不能派生 bundle（§14.13-F3）');
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, candidateBeforeSubmit.digest,
        'submit 被拒时候选目录必须逐字节不变');

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: 'source.check 不可用' };
      assertEqual(sourceCheck.data.status, 'PASS', 'source.check 应 PASS');
      assert(fs.existsSync(bundleFile), '检查阶段必须补派生 bundle（X6）');

      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败：' + JSON.stringify(dryRun.code));
      assertEqual(dryRun.data.status, 'PASS', 'dry-run 应 PASS');
      await runExportGateChecks(coord, handle);
      const submittedAfter = coord.submitAttempt(handle);
      assert(submittedAfter.ok === true, '补检查后 submit 应成功：' + JSON.stringify(submittedAfter.code));

      return {
        status: 'PASS',
        observed: {
          submitWithoutChecks: submitCode,
          bundleCreatedBy: 'source.check',
          finalSubmit: submittedAfter.status,
        },
        detail: 'submit 不派生（拒绝且零写入），bundle 由检查阶段补派生后链路才可提交',
      };
    },
  },

  /* ---------------- 句柄与身份 ---------------- */
  {
    id: 'W09',
    group: 'W t5 复核（X7）',
    title: '句柄/身份：伪造 projectId → AGENT_RUN_NOT_FOUND；搬迁 run 目录 → AGENT_PROJECT_MISMATCH 且副本零写入；伪造 turn/attempt → AGENT_ATTEMPT_NOT_FOUND',
    x: ['X7', 'X3'],
    requires: W2_REQUIRES,
    basis: 'rev15 §14.12-2 + §14.13-F6（run 级 / attempt 级 / projectId↔私有根 三分码）',
    expected: '跨项目句柄 → AGENT_RUN_NOT_FOUND；把 A 的 run 目录复制进 B 的 runs/ 后用 B 的 projectId 调用 → '
      + 'AGENT_PROJECT_MISMATCH；伪造 attemptId / 跨 turn → AGENT_ATTEMPT_NOT_FOUND；三次拒绝后 treeDigest 不变、'
      + 'B 侧副本目录逐字节不变（零写入）',
    async run(ctx) {
      const projectA = setupProject(ctx, 'e0v1-w09a');
      const projectB = setupProject(ctx, 'e0v1-w09b');
      const coord = newCoordinator(ctx);
      const runA = coord.startRun({
        projectId: 'e0v1-w09a', targetPage: 'menu', operation: 'edit-menu', utterance: 'A 的改动',
      });
      assert(runA.ok === true, 'startRun(A) 失败');
      const handleA = handleOf('e0v1-w09a', runA);
      const pathsA = attemptPaths(projectA, runA);
      const digestBefore = coord.getAttemptState(handleA).treeDigest;

      const crossProject = await coord.invokeTool({
        projectId: 'e0v1-w09b', runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
        tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'cross\n' }] },
      });
      const crossCode = assertRejectedWith(crossProject, 'AGENT_RUN_NOT_FOUND', '伪造 projectId 的句柄');

      const forgedAttempt = await coord.invokeTool({
        ...handleA, attemptId: 'attempt-9', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'forged\n' }] },
      });
      const forgedCode = assertRejectedWith(forgedAttempt, 'AGENT_ATTEMPT_NOT_FOUND', '伪造 attemptId');

      const crossTurn = await coord.invokeTool({
        ...handleA, turnId: 'turn-9', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'turn\n' }] },
      });
      const crossTurnCode = assertRejectedWith(crossTurn, 'AGENT_ATTEMPT_NOT_FOUND', '跨 turn 句柄');

      // 搬迁：把 A 的 run 目录整体复制进 B 的 runs/，用 B 的身份访问 → projectId 与私有根不一致。
      const srcRunDir = path.join(projectA.paths.workspaceDir, 'runs', runA.runId);
      const dstRunDir = path.join(projectB.paths.workspaceDir, 'runs', runA.runId);
      fs.cpSync(srcRunDir, dstRunDir, { recursive: true });
      const copyBefore = ctx.env.fingerprintDir(dstRunDir);
      const moved = await coord.invokeTool({
        projectId: 'e0v1-w09b', runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
        tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'moved\n' }] },
      });
      const movedCode = assertRejectedWith(moved, 'AGENT_PROJECT_MISMATCH', '搬迁 run 目录后的句柄');
      const copyAfter = ctx.env.fingerprintDir(dstRunDir);

      assertEqual(coord.getAttemptState(handleA).treeDigest, digestBefore, '被拒后 A 的候选摘要不得变化');
      assertEqual(copyAfter.digest, copyBefore.digest, 'B 侧副本目录必须零写入');

      return {
        status: 'PASS',
        observed: { crossCode, forgedCode, crossTurnCode, movedCode, copyZeroWrites: true, digestUnchanged: true },
        detail: '三类句柄拒绝命中具体码；搬迁副本零写入，候选摘要不变',
      };
    },
  },

  /* ---------------- direct 接线 ---------------- */
  {
    id: 'W10',
    group: 'W t5 复核（X7/direct）',
    title: 'direct 接线（静态）：main.cjs 用 getter 惰性装配 direct-runtime，并注入主进程唯一凭据',
    x: ['X7'],
    requires: W2_REQUIRES.concat(['direct-runtime']),
    basis: 'rev15 §14.7（invokeDirect 下游；未接线显式 AGENT_RUNTIME_TOOL_MISSING）',
    expected: 'desktop/main.cjs 引用 direct-runtime 模块，createRunCoordinator 的 directRuntime 由 '
      + 'createDirectWorkspaceRuntime({ coordinator: () => workspaceRunCoordinator, credentials: modelCredentials }) 提供 '
      + '（惰性 getter，不在模块顶层立即调用网络/凭据）',
    async run(ctx) {
      const mainPath = path.join(REPO_ROOT, 'desktop', 'main.cjs');
      const text = fs.readFileSync(mainPath, 'utf8');
      assert(text.includes("require('./agent-runtime')") && !text.includes("require('./agent-workspace/direct-runtime.cjs')"),
        'main.cjs 产品主链必须接多轮 agent-runtime，不得接旧单次 direct-runtime');
      assert(/createDirectWorkspaceRuntime\s*\(\s*\{[\s\S]{0,400}?coordinator\s*:\s*\(\s*\)\s*=>\s*workspaceRunCoordinator/.test(text),
        'main.cjs 应以 getter（() => workspaceRunCoordinator）惰性提供 coordinator');
      assert(/credentials\s*:\s*modelCredentials/.test(text), 'main.cjs 应注入主进程唯一凭据 modelCredentials');
      assert(/directRuntime\s*:/.test(text), 'createRunCoordinator 调用里应设置 directRuntime');
      const topology = {
        requiresMultiTurnRuntime: true,
        lazyCoordinatorGetter: true,
        credentialsWired: true,
        lines: text.split('\n').length,
      };
      return {
        status: 'PASS',
        observed: topology,
        detail: 'main.cjs 惰性装配 direct-runtime（getter + 凭据），未暴露目录或命令入口',
      };
    },
  },
  {
    id: 'W11',
    group: 'W t5 复核（X7/direct）',
    title: 'direct 接线（行为）：接线后 invokeDirect 成功返回（不再 AGENT_RUNTIME_TOOL_MISSING），且请求有界',
    x: ['X7'],
    requires: W2_REQUIRES.concat(['direct-runtime']),
    basis: 'rev15 §14.7（direct 通道为默认通道；请求/返回都有界）',
    expected: '把真实 direct-runtime（transport 注入为确定性桩）接到 Coordinator 后：describe().ready=true；'
      + 'invokeDirect → ok:true 且 data.content/finishReason 来自下游、无 AGENT_RUNTIME_TOOL_MISSING；'
      + '传给 transport 的 request 不含绝对路径/密钥；含绝对路径的请求被拒且 transport 调用 0 次',
    async run(ctx) {
      setupProject(ctx, 'e0v1-w11');
      const directMod = ctx.frozen.requireStrict('direct-runtime');
      const seen = [];
      let coord = null;
      const directRuntime = directMod.createDirectWorkspaceRuntime({
        coordinator: () => coord,
        transport: async (request) => {
          seen.push(request);
          return { choices: [{ message: { content: '好的，已按你说的改。' }, finish_reason: 'stop' }], model: 'stub-model' };
        },
      });
      coord = newCoordinator(ctx, { directRuntime });
      assertEqual(directRuntime.describe().ready, true, 'describe().ready 应为 true（coordinator+transport 都有）');

      const run = coord.startRun({
        projectId: 'e0v1-w11', targetPage: 'menu', operation: 'edit-menu', utterance: '把招牌菜改成红烧肉',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w11', run);

      const ok = await coord.invokeDirect({
        ...handle, request: { messages: [{ role: 'user', content: '把招牌菜改成红烧肉' }] },
      });
      assert(ok.ok === true, 'invokeDirect 应成功：' + JSON.stringify({ code: ok.code, message: ok.message }));
      assertEqual(ok.data.content, '好的，已按你说的改。', '应原样返回下游 content');
      assertEqual(ok.data.finishReason, 'stop', '应回传 finishReason');
      assert(ok.code !== 'AGENT_RUNTIME_TOOL_MISSING', '接线后不得再出现 AGENT_RUNTIME_TOOL_MISSING');

      const wire = JSON.stringify(seen);
      assert(!/[A-Za-z]:\\/.test(wire), '发给上游的请求不得含 Windows 绝对路径');
      assert(!/sk-[A-Za-z0-9]/.test(wire), '发给上游的请求不得含密钥样式字符串');

      const callCountBefore = seen.length;
      const badRequest = await coord.invokeDirect({
        ...handle, request: { messages: [{ role: 'user', content: '读 C:\\Windows\\win.ini 再改菜单' }] },
      });
      assert(badRequest.ok === false, '含绝对路径的请求必须被拒');
      assertEqual(seen.length, callCountBefore, '被拒的请求不得发起上游调用');

      return {
        status: 'PASS',
        observed: {
          ready: true,
          contentReturned: true,
          finishReason: ok.data.finishReason,
          transportCalls: callCountBefore,
          badRequestCode: badRequest.code,
        },
        detail: '接线后 invokeDirect 正常返回（content/finishReason），请求有界且含绝对路径时上游 0 调用',
      };
    },
  },
  {
    id: 'W12',
    group: 'W t5 复核（X7/direct）',
    title: 'direct 未接线 / 未配凭据时仍显式 AGENT_RUNTIME_TOOL_MISSING（不静默降级、不返回空成功）',
    x: ['X7'],
    requires: W2_REQUIRES.concat(['direct-runtime']),
    basis: 'rev15 §14.7（能力缺失必须显式；空成功等于欺骗用户）',
    expected: '① Coordinator 未注入 directRuntime → invokeDirect 返回 AGENT_RUNTIME_TOOL_MISSING；'
      + '② direct-runtime 有 coordinator 但没有 transport → 同样该码；'
      + '③ transport 抛 DEEPSEEK_NOT_CONFIGURED（真实未配 Key 路径）→ 该码而不是崩或空成功',
    async run(ctx) {
      setupProject(ctx, 'e0v1-w12');
      const directMod = ctx.frozen.requireStrict('direct-runtime');
      const plain = newCoordinator(ctx);
      const run = plain.startRun({
        projectId: 'e0v1-w12', targetPage: 'menu', operation: 'edit-menu', utterance: '改菜单',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w12', run);

      const unwired = await plain.invokeDirect({ ...handle, request: { messages: [{ role: 'user', content: 'hi' }] } });
      const unwiredCode = assertRejectedWith(unwired, 'AGENT_RUNTIME_TOOL_MISSING', '未注入 directRuntime');

      let coord = null;
      const noTransport = directMod.createDirectWorkspaceRuntime({ coordinator: () => coord });
      coord = newCoordinator(ctx, { directRuntime: noTransport });
      assertEqual(noTransport.describe().ready, false, '无 transport 时 describe().ready 应为 false');
      const noTransportResult = await coord.invokeDirect({
        ...handle, request: { messages: [{ role: 'user', content: 'hi' }] },
      });
      const noTransportCode = assertRejectedWith(noTransportResult, 'AGENT_RUNTIME_TOOL_MISSING', '无 transport');

      let coord2 = null;
      const notConfigured = directMod.createDirectWorkspaceRuntime({
        coordinator: () => coord2,
        transport: async () => {
          const error = new Error('未配置模型凭据');
          error.code = 'DEEPSEEK_NOT_CONFIGURED';
          throw error;
        },
      });
      coord2 = newCoordinator(ctx, { directRuntime: notConfigured });
      const notConfiguredResult = await coord2.invokeDirect({
        ...handle, request: { messages: [{ role: 'user', content: 'hi' }] },
      });
      const notConfiguredCode = assertRejectedWith(notConfiguredResult, 'AGENT_RUNTIME_TOOL_MISSING', '未配置凭据');

      return {
        status: 'PASS',
        observed: { unwiredCode, noTransportCode, notConfiguredCode },
        detail: '三条未接线/未配凭据路径都显式 AGENT_RUNTIME_TOOL_MISSING，无空成功',
      };
    },
  },
  /* ---------------- 证据信任边界（§14.13-F1 必含字段 / partial 由证据决定） ---------------- */
  {
    id: 'W13',
    group: 'W t5 复核（X7 证据绑定）',
    title: '§14.13-F1：submission.json 缺 exportTreeDigest 时必须不可 adopt（缺导出树绑定=证据不完整）',
    x: ['X7'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.13-F1（缺 exportTreeDigest 即不可 adopt）+ §14.5（adopt 必须校验导出树绑定）',
    expected: '真实链路提交成功；把 verification/submission.json 的 exportTreeDigest 字段删掉（模拟旧版/被篡改证据）后，'
      + 'adopt(partialConfirmed:true) 必须被拒（AGENT_EVIDENCE_STALE 或 AGENT_ADOPTION_FAILED），不得生成新版本',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w13');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w13', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w13', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- W13 -->\n')).ok === true, '写入失败');

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: 'source.check 不可用' };
      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败：' + JSON.stringify(dryRun.code));
      for (const checkId of ['mini.check', 'output.consistency']) {
        const checked = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
        assert(checked.ok === true && checked.data.status === 'PASS', checkId + ' 失败：' + JSON.stringify(checked));
      }
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功：' + JSON.stringify(submitted.code));
      assert(typeof submitted.exportTreeDigest === 'string', 'F1：提交返回体应带 exportTreeDigest');

      const submissionFile = path.join(paths.verificationDir, 'submission.json');
      const submission = JSON.parse(fs.readFileSync(submissionFile, 'utf8'));
      delete submission.exportTreeDigest;
      fs.writeFileSync(submissionFile, JSON.stringify(submission, null, 2), 'utf8');

      const versionsBefore = ctx.env.fingerprintDir(project.paths.versionsDir);
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(adopted.ok === false,
        '§14.13-F1 未被实现：submission.json 缺 exportTreeDigest 时 adopt 仍然成功（生成 '
        + String(adopted.adoptedVersionId) + '）——缺导出树绑定的证据被当成完整证据采用');
      assertRejectedWith(adopted, ['AGENT_EVIDENCE_STALE', 'AGENT_ADOPTION_FAILED', 'AGENT_VERIFICATION_MISSING'],
        '缺 exportTreeDigest 的 adopt');
      assertEqual(ctx.env.fingerprintDir(project.paths.versionsDir).digest, versionsBefore.digest,
        '被拒后不得生成新版本目录');

      return {
        status: 'PASS',
        observed: { submitExportTreeDigestHead: submitted.exportTreeDigest.slice(0, 19), adoptCode: adopted.code,
          nextAction: adopted.nextAction || null },
        detail: '缺 exportTreeDigest 的提交证据被拒绝采用，未生成新版本',
      };
    },
  },
  {
    id: 'W14',
    group: 'W t5 复核（X7 证据绑定）',
    title: 'partial 必须由运行时证据决定，不能只信 submission.json 的 partial 字段（改 false 也不能免确认）',
    x: ['X7'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.12-Q1③（运行时 BLOCKED/NOT_RUN 且未确认 → AGENT_PARTIAL_CONFIRM_REQUIRED）+ §14.5（证据由平台判定）',
    expected: '真实链路提交为 partial（wechat.verify 未跑）；把 submission.json 的 partial 改成 false（模拟被篡改/旧版证据）后，'
      + '不带 partialConfirmed 的 adopt 仍必须 AGENT_PARTIAL_CONFIRM_REQUIRED（不得因为字段被改就放行）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w14');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w14', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w14', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- W14 -->\n')).ok === true, '写入失败');
      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: 'source.check 不可用' };
      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败');
      for (const checkId of ['mini.check', 'output.consistency']) {
        const checked = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
        assert(checked.ok === true && checked.data.status === 'PASS', checkId + ' 失败：' + JSON.stringify(checked));
      }
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功');
      assertEqual(submitted.partial, true, 'wechat.verify 未跑时应为 partial');

      const submissionFile = path.join(paths.verificationDir, 'submission.json');
      const submission = JSON.parse(fs.readFileSync(submissionFile, 'utf8'));
      submission.partial = false;
      fs.writeFileSync(submissionFile, JSON.stringify(submission, null, 2), 'utf8');

      const adopted = coord.adoptAttempt(handle);
      assert(adopted.ok === false,
        'partial 只信 submission.json：把 partial 改成 false 后，未确认的 adopt 直接成功（生成 '
        + String(adopted.adoptedVersionId) + '）——运行时 BLOCKED 被绕过');
      assertRejectedWith(adopted, 'AGENT_PARTIAL_CONFIRM_REQUIRED', '篡改 partial 字段的 adopt');

      return {
        status: 'PASS',
        observed: { submitPartial: submitted.partial, tamperedPartial: false, adoptCode: adopted.code },
        detail: 'partial 由平台证据决定：篡改 submission.partial 不能绕过确认',
      };
    },
  },
  {
    id: 'W15',
    group: 'W t5 复核（X7 证据绑定）',
    title: 'X7/A15：导出级证据缺 exportTreeDigest 不得被当成完整 PASS（不完整证据不参与门禁）',
    x: ['X7', 'X4'],
    requires: W2_REQUIRES.concat(['source-check']),
    basis: 'rev15 §14.4「证据必须记录 treeDigest|exportTreeDigest」+ A15「证据缺字段 → 不参与门禁」',
    expected: '真实链路跑到 mini.check PASS；为隔离“导出级证据不完整”这一个变量，写入一条**模拟的** wechat.verify PASS'
      + '（仅测试，不声称微信运行时通过）；随后删掉 mini.check 证据的 exportTreeDigest：'
      + 'submit 不得把它当成完整 PASS —— 要么拒绝（AGENT_EVIDENCE_STALE / AGENT_STATIC_GATE_FAILED），'
      + '要么按“该证据不可用”落 partial（partial=true）。直接给出 partial=false 的 submitted 即失败。',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w15');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w15', targetPage: 'menu', operation: 'edit-menu', utterance: '加一行招牌菜',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w15', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- W15 -->\n')).ok === true, '写入失败');
      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: 'source.check 不可用' };
      const dryRun = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run' } });
      assert(dryRun.ok === true, 'dry-run 失败');
      const mini = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'mini.check' } });
      assert(mini.ok === true, 'mini.check 失败：' + JSON.stringify(mini.code));
      // 输出一致性也跑一遍：否则 partial 会因“output.consistency 未跑”而恒为 true，本用例就失去判据。
      const consistency = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'output.consistency' } });
      assert(consistency.ok === true, 'output.consistency 失败：' + JSON.stringify(consistency.code));

      // A04 式证据写入（仅测试）：模拟 wechat.verify PASS，使“partial”不成为既成事实，
      // 这样“mini.check 缺 exportTreeDigest”是否被算作完整证据才可判定。不代表微信真实通过。
      const state = coord.getAttemptState(handle);
      const simulatedWechat = {
        checkId: 'wechat.verify',
        status: 'PASS',
        durationMs: 1,
        treeDigest: state.treeDigest,
        subjectKind: 'export',
        attemptId: run.attemptId,
        at: new Date().toISOString(),
        exportRelative: dryRun.data.exportRelative,
        exportTreeDigest: dryRun.data.exportTreeDigest,
        issues: [],
      };
      fs.writeFileSync(path.join(paths.checksDir, 'wechat.verify.json'),
        JSON.stringify(simulatedWechat, null, 2), 'utf8');

      // 找到 mini.check 证据文件并把 exportTreeDigest 删掉（模拟旧版/被改的导出级证据）。
      let tampered = null;
      for (const name of fs.readdirSync(paths.checksDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(paths.checksDir, name);
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.checkId !== 'mini.check') continue;
        delete value.exportTreeDigest;
        fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
        tampered = name;
      }
      assert(tampered, '应找到 mini.check 证据文件');

      const submitted = coord.submitAttempt(handle);
      let rejectedCode = null;
      if (submitted.ok === false) {
        rejectedCode = assertRejectedWith(submitted,
          ['AGENT_EVIDENCE_STALE', 'AGENT_STATIC_GATE_FAILED'], '缺导出摘要的导出级证据');
      } else {
        assertEqual(submitted.partial, true,
          '缺 exportTreeDigest 的导出级证据被当成完整 PASS：submit 直接给出 partial=false 的 submitted'
          + '（A15 要求不完整证据不参与门禁）');
      }

      return {
        status: 'PASS',
        observed: {
          miniStatus: mini.data.status,
          tamperedFile: tampered,
          simulatedWechatEvidence: true,
          submitCode: submitted.ok === true ? 'ok' : rejectedCode,
          submitPartial: submitted.ok === true ? submitted.partial : null,
        },
        detail: submitted.ok === true
          ? '不完整导出级证据未被当成完整 PASS（submit 落 partial）'
          : '不完整导出级证据被拒绝（' + rejectedCode + '）',
      };
    },
  },
  {
    id: 'W16',
    group: 'W t5 复核（X6）',
    title: 'X6：deleted 显式（删 assets/** 必须列入 deleted 且不进 files）＋ 平台派生工具的模型不可调用',
    x: ['X6'],
    requires: W2_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.5/§4.1（deleted 显式；deriveSourceBundle 平台专用）+ §14.3（平台专用工具名 → AGENT_TOOL_NOT_ALLOWED）',
    expected: '候选里删除一个真实资产后：source.check 阶段的平台派生把该相对路径写入 bundle.deleted、'
      + '且不出现在 bundle.files；files 每项 sha256 等于候选真实字节；'
      + '模型调用 derive_source_bundle → AGENT_TOOL_NOT_ALLOWED 且候选摘要不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w16');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w16', targetPage: 'menu', operation: 'edit-menu', utterance: '删掉一个资产',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w16', run);
      const paths = attemptPaths(project, run);

      const assetRelative = firstRelativeUnder(paths.candidateDir, 'assets');
      assert(assetRelative, '候选树应含 assets/** 资产（否则本用例无法验证 deleted 显式）');
      const removed = await coord.invokeTool({
        ...handle, tool: 'delete_files', args: { paths: [{ path: assetRelative }] },
      });
      assert(removed.ok === true, '删除资产失败：' + JSON.stringify(removed.code));

      const forbidden = await coord.invokeTool({ ...handle, tool: 'derive_source_bundle', args: {} });
      const forbiddenCode = assertRejectedWith(forbidden, 'AGENT_TOOL_NOT_ALLOWED', '模型调用 derive_source_bundle');
      assertEqual(coord.getAttemptState(handle).treeDigest, removed.data.treeDigest,
        '被拒的平台专用工具调用不得改候选树');

      const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      assert(sourceCheck.ok === true, 'source.check 调用失败：' + JSON.stringify(sourceCheck.code));
      const bundleFile = path.join(paths.candidateDir, bundleMod.BUNDLE_FILE);
      assert(fs.existsSync(bundleFile), '检查阶段必须由平台派生 source-bundle.json');
      const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
      assert(Array.isArray(bundle.deleted) && bundle.deleted.includes(assetRelative),
        'bundle.deleted 必须显式列出被删除的资产 ' + assetRelative + '，实际 ' + JSON.stringify(bundle.deleted));
      assert(!bundle.files.some((item) => item.path === assetRelative),
        '被删除的资产不得出现在 bundle.files');
      const crypto = require('node:crypto');
      const digestOf = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
      for (const item of bundle.files) {
        const file = path.join(paths.candidateDir, ...item.path.split('/'));
        assert(fs.existsSync(file), 'bundle.files 列出的文件必须存在于候选：' + item.path);
        assertEqual(String(item.sha256).replace(/^sha256:/, ''), digestOf(fs.readFileSync(file)).replace(/^sha256:/, ''),
          'bundle.files 的 sha256 必须等于候选真实字节：' + item.path);
      }

      return {
        status: 'PASS',
        observed: {
          deletedAsset: assetRelative,
          bundleDeleted: bundle.deleted.slice(0, 5),
          forbiddenToolCode: forbiddenCode,
          sourceCheckStatus: sourceCheck.data.status,
        },
        detail: '删除的资产被显式列入 bundle.deleted 且不进 files；模型不可调用平台派生工具',
      };
    },
  },
  {
    id: 'W17',
    group: 'W t5 复核（X6）',
    title: 'X6：模型自写 source-bundle.json 不得被平台当成“已派生清单”原样接受（模型不写摘要清单）',
    x: ['X6'],
    requires: W2_REQUIRES.concat(['source-check', 'source-bundle']),
    basis: 'rev15 §14.1 X6「source-bundle.json 由平台 deriveSourceBundle 派生；模型不写摘要清单」',
    expected: '模型用 write_files 写入一份 source-bundle.json（files 摘要与候选一致，但 base.treeSha256 / deleted 是模型编的），'
      + '再跑 source.check：平台必须在检查阶段重派生（清单字节/摘要变回真值）或明确拒绝该清单；'
      + '把模型写的清单原样保留并据此记录 bundle 摘要，等于模型控制摘要清单。',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-w17');
      const bundleMod = ctx.frozen.requireStrict('source-bundle');
      const coord = newCoordinator(ctx);
      const run = coord.startRun({
        projectId: 'e0v1-w17', targetPage: 'menu', operation: 'edit-menu', utterance: '自己写一份清单试试',
      });
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-w17', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      const content = current + '\n<!-- W17 平台派生 -->\n';
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', content)).ok === true, '写入失败');

      const crypto = require('node:crypto');
      const fileSha = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
      const forgedBase = 'sha256:' + '0'.repeat(64);
      const forgedBundle = {
        schemaVersion: 'frontend-source-bundle.v1',
        base: { id: 'ordering-base', version: '1.0.0', treeSha256: forgedBase },
        targetPages: ['menu'],
        files: [{ path: 'pages/menu/index.wxml', sha256: fileSha }],
        deleted: ['assets/tabbar/home.png'],
        components: [],
        assets: [],
      };
      const wrote = await writeText(coord, handle, bundleMod.BUNDLE_FILE, JSON.stringify(forgedBundle, null, 2) + '\n');
      const bundleFile = path.join(paths.candidateDir, bundleMod.BUNDLE_FILE);
      // 新契约允许更强的“直接拒绝”；若产品仍接受写入，则必须在检查阶段被平台重派生覆盖。
      if (wrote.ok === true) {
        const forgedBytes = fs.readFileSync(bundleFile, 'utf8');
        const sourceCheck = await coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
        assert(sourceCheck.ok === true, 'source.check 调用失败：' + JSON.stringify(sourceCheck.code));
        const afterBytes = fs.readFileSync(bundleFile, 'utf8');
        assert(afterBytes !== forgedBytes,
          '平台把模型自写的 source-bundle.json 原样保留（未重派生）：模型控制了摘要清单（X6「模型不写摘要清单」）');
        const after = JSON.parse(afterBytes);
        assert(after.base && after.base.treeSha256 !== forgedBase,
          '重派生后的 base.treeSha256 必须是真实 Base 摘要，不能是模型编的值');
        assert(!(Array.isArray(after.deleted) && after.deleted.includes('assets/tabbar/home.png')),
          '重派生后的 deleted 不得包含候选里仍存在的资产（模型编的删除项不得生效）');
      } else {
        assertEqual(wrote.code, 'AGENT_PAYLOAD_INVALID', '模型写入平台清单必须明确拒绝');
        assert(fs.existsSync(bundleFile) === false, '拒绝写入后不得留下模型伪造的清单');
      }

      return {
        status: 'PASS',
        observed: {
          bundleRejectedOrRewrittenByPlatform: true,
          modelWriteCode: wrote.code || null,
          sourceCheckStatus: 'NOT_RUN_IF_REJECTED',
        },
        detail: '平台在检查阶段重派生了清单，模型自写的 base/deleted 未被原样接受',
      };
    },
  },
];

module.exports = { CASES, W2_REQUIRES };
