'use strict';

/**
 * A 组：E0 攻击清单（A01–A49 + A11O/A21O 观察）的可执行部分。
 *
 * 依据：rev15 §14.2–§14.9/§14.12/§14.13；`docs/evidence/workspace-agent/e0-v1/attacks.md` 一一对应。
 * 纪律：
 *  - 每条都断“拒绝 + 具体码/issue + 零落盘/摘要不变”，不接受“ok:false 就算过”；
 *  - 需要检查结果的地方用**真实注册表**（`checks.createCheckRegistry({})`）；只有“观察平台入参/调用次数”
 *    才用“记录后转交真实实现”的包装（definitions 仍来自真实 checks.cjs）；
 *  - A32–A42 的“上游”是验证器自己的假上游（计数/虚拟时钟），只用于并发与截断语义，不得当真实模型证据；
 *  - 不写产品代码；临时 userData 由 run.cjs 自建自清。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
} = require('../chains/coordinator.cjs');
const { attemptPaths, seedImageAsset } = require('../chains/vertical.cjs');

const COORDINATOR = ['run-coordinator', 'workspace', 'files', 'manifest', 'versions', 'checks'];
const RUNTIME = ['run-coordinator', 'model-call-scheduler', 'agent-runtime'];
const SCHEDULER = ['model-call-scheduler'];
const IMAGES = ['run-coordinator', 'agent-runtime'];

const BASE_SRC = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const REPO_MIRROR = path.join(REPO_ROOT, 'miniprogram');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function writeText(coord, handle, relative, content) {
  return coord.invokeTool({ ...handle, tool: 'write_files', args: { changes: [{ path: relative, content }] } });
}

async function runCheck(coord, handle, checkId) {
  return coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId } });
}

function readEvidence(attemptDirAbs, checkId) {
  const dir = path.join(attemptDirAbs, 'verification', 'checks');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return null; }
  let latest = null;
  for (const name of names) {
    let value = null;
    try { value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!value || value.checkId !== checkId) continue;
    if (!latest || String(value.at || '') >= String(latest.at || '')) latest = value;
  }
  return latest;
}

/** 记录调用参数后再**转交真实实现**：definitions 仍来自真实 checks.cjs。 */
function countingRegistry(ctx, options) {
  const real = realRegistry(ctx);
  const calls = [];
  const opts = options || {};
  return {
    calls,
    definitions: real.definitions,
    async runCheck(request) {
      calls.push({
        checkId: request.checkId, root: request.root || null, exportRoot: request.exportRoot || null,
        exportParentDir: request.exportParentDir || null, subjectKind: request.subjectKind || null,
        attemptId: request.attemptId || null,
      });
      if (typeof opts.override === 'function') {
        const replaced = opts.override(request);
        if (replaced) return replaced;
      }
      return real.runCheck(request);
    },
  };
}

/** 真实检查链：写入本用例专属标记 → source.check → composer.dry-run。 */
async function driveRealChecks(coord, handle, project, run, marker) {
  const paths = attemptPaths(project, run);
  const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
  assert(typeof current === 'string', '候选树应含 pages/menu/index.wxml');
  const write = await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- ' + marker + ' -->\n');
  assert(write.ok === true, '写入失败：' + JSON.stringify(write.code));
  const sourceCheck = await runCheck(coord, handle, 'source.check');
  if (!sourceCheck.ok) return { ok: false, stage: 'source.check', result: sourceCheck, paths };
  const dryRun = await runCheck(coord, handle, 'composer.dry-run');
  if (!dryRun.ok) return { ok: false, stage: 'composer.dry-run', result: dryRun, paths };
  return { ok: true, sourceCheck, dryRun, paths };
}

/** 真实链路到 submitted。 */
function realHandle(projectId, run) {
  return { projectId, runId: run.runId, turnId: run.turnId, attemptId: run.attemptId };
}

function createScheduler(ctx, options) {
  const mod = ctx.frozen.requireStrict('model-call-scheduler');
  return mod.createModelCallScheduler(Object.assign({ globalTokens: false, requestTimeoutMs: 20000 }, options || {}));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeClock(startAt) {
  let nowMs = Number.isFinite(startAt) ? startAt : 1700000000000;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => nowMs,
    timers: {
      setTimeout(fn, ms) {
        seq += 1;
        pending.set(seq, { at: nowMs + Math.max(0, Number(ms) || 0), fn });
        return seq;
      },
      clearTimeout(id) { pending.delete(id); },
      setInterval() { seq += 1; return seq; },
      clearInterval() {},
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, item] of pending) {
          if (item.at <= target && item.at < nextAt) { nextAt = item.at; nextId = id; }
        }
        if (nextId === null) break;
        const item = pending.get(nextId);
        pending.delete(nextId);
        nowMs = Math.max(nowMs, item.at);
        try { item.fn(); } catch { /* 由用例断言 */ }
      }
      nowMs = target;
      return nowMs;
    },
  };
}

function createRuntime(ctx, coord, modelChat, options) {
  const runtime = ctx.frozen.requireStrict('agent-runtime');
  return runtime.createDirectWorkspaceRuntime(Object.assign({ coordinator: coord, modelChat, userDataDir: ctx.temp.real }, options || {}));
}

function fakeModel(ctx, handler) {
  const runtime = ctx.frozen.requireStrict('agent-runtime');
  const calls = [];
  const modelChat = runtime.createModelChat({
    chat: async (payload) => {
      calls.push({ messages: payload.messages, tools: payload.tools, maxTokens: payload.maxTokens });
      return handler(payload, calls.length);
    },
  });
  return { modelChat, calls };
}

const CASES = [
  /* ---------------- A01–A09 / A49：submit / adopt 证据绑定（X7） ---------------- */
  {
    id: 'A01',
    group: 'A 负例（submit/adopt 证据）',
    title: '未 derive bundle / 未跑任何检查就 submit → AGENT_STATIC_GATE_FAILED，不置 submitted 且零落盘',
    x: ['X6', 'X7'],
    requires: COORDINATOR,
    basis: 'rev15 §14.5 submit 门禁①',
    expected: 'submitAttempt 拒绝 AGENT_STATIC_GATE_FAILED；attempt 仍 open；无 submission.json；候选目录与 versions/v1 指纹不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a01');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a01');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a01', run);
      const paths = attemptPaths(project, run);
      const candidateBefore = ctx.env.fingerprintDir(paths.candidateDir);
      const v1Before = ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1'));
      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '无检查证据 submit');
      assertEqual(coord.getAttemptState(handle).status, 'open', '不得置 submitted');
      assert(!fs.existsSync(path.join(paths.verificationDir, 'submission.json')), '不得写 submission 证据');
      assert(!fs.existsSync(path.join(paths.candidateDir, 'source-bundle.json')), 'submit 不得派生 bundle');
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, candidateBefore.digest, '候选目录必须零写入');
      assertEqual(ctx.env.fingerprintDir(path.join(project.paths.versionsDir, 'v1')).digest, v1Before.digest, '版本必须零写入');
      return { status: 'PASS', observed: { code: submitted.code, status: coord.getAttemptState(handle).status },
        detail: '未检查就提交被静态门禁拒绝，零落盘' };
    },
  },
  {
    id: 'A02',
    group: 'A 负例（submit/adopt 证据）',
    title: '只写候选、不跑 source.check 就 submit → AGENT_STATIC_GATE_FAILED',
    x: ['X4', 'X7'],
    requires: COORDINATOR,
    basis: 'rev15 §14.5 submit 门禁②',
    expected: '写入后直接 submit 被拒；attempt 仍 open；无 submission 证据；候选摘要不因 submit 变化',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a02');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a02');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a02', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A02 -->\n')).ok === true, '写入失败');
      const before = coord.getAttemptState(handle);
      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '未 source.check 就 submit');
      assertEqual(coord.getAttemptState(handle).treeDigest, before.treeDigest, 'submit 不得改候选摘要');
      assertEqual(coord.getAttemptState(handle).status, 'open', '状态应仍 open');
      assert(!fs.existsSync(path.join(paths.verificationDir, 'submission.json')), '不得写 submission 证据');
      return { status: 'PASS', observed: { code: submitted.code }, detail: '缺 source.check 被门禁拒绝' };
    },
  },
  {
    id: 'A03',
    group: 'A 负例（submit/adopt 证据）',
    title: '只跑 source.check=PASS、未跑 composer.dry-run 就 submit → AGENT_STATIC_GATE_FAILED',
    x: ['X4', 'X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.5 submit 门禁②',
    expected: '真实 source.check PASS 后 submit 仍因缺 dry-run 被拒；attempt 仍 open；无 submitted 证据',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a03');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a03');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a03', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A03 -->\n')).ok === true, '写入失败');
      const sourceCheck = await runCheck(coord, handle, 'source.check');
      if (!sourceCheck.ok) return { status: 'BLOCKED', observed: { code: sourceCheck.code }, detail: '真实 source.check 不可用' };
      assertEqual(sourceCheck.data.status, 'PASS', 'source.check 应 PASS');
      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '缺 dry-run 的 submit');
      assertEqual(coord.getAttemptState(handle).status, 'open', '状态应仍 open');
      assert(!fs.existsSync(path.join(paths.verificationDir, 'submission.json')), '不得写 submission 证据');
      return { status: 'PASS', observed: { code: submitted.code }, detail: '缺 dry-run 被门禁拒绝' };
    },
  },
  {
    id: 'A04',
    group: 'A 负例（submit/adopt 证据）',
    title: '手写 verification/checks/*.json 伪造 PASS 证据后 submit → 平台重算并拒绝（手写记录不得放行）',
    x: ['X7'],
    requires: COORDINATOR,
    basis: 'rev15 §14.5「读取并保存上述证据」+ §14.4 证据字段',
    expected: '手写 {checkId,status:PASS,treeDigest=当前,subjectKind:attempt,attemptId,at} 的 source.check 与 dry-run 证据后 submit：'
      + '必须 AGENT_STATIC_GATE_FAILED 或 AGENT_EVIDENCE_STALE（平台不得只信文件里的 PASS 与摘要）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a04');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a04');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a04', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A04 -->\n')).ok === true, '写入失败');
      const state = coord.getAttemptState(handle);
      const at = new Date().toISOString();
      const common = {
        status: 'PASS', subjectKind: 'attempt', attemptId: run.attemptId, at, issues: [],
        durationMs: 1, treeDigest: state.treeDigest,
      };
      fs.mkdirSync(paths.checksDir, { recursive: true });
      fs.writeFileSync(path.join(paths.checksDir, 'forged-source.json'),
        JSON.stringify({ ...common, checkId: 'source.check' }, null, 2), 'utf8');
      // 手工造一棵“导出树”，伪造 dry-run 证据（导出摘要按真实算法自算，但 compose 未真正执行）。
      const exportDir = path.join(paths.verificationDir, 'dry-run');
      fs.mkdirSync(path.join(exportDir, 'pages', 'menu'), { recursive: true });
      fs.writeFileSync(path.join(exportDir, 'app.json'), '{"pages":["pages/menu/index"]}\n', 'utf8');
      fs.writeFileSync(path.join(exportDir, 'pages', 'menu', 'index.wxml'), current + '\n<!-- A04 -->\n', 'utf8');
      const manifest = ctx.frozen.requireStrict('manifest');
      const built = manifest.buildManifest(exportDir);
      const exportTreeDigest = built.manifest ? built.manifest.treeDigest : built.treeDigest;
      fs.writeFileSync(path.join(paths.checksDir, 'forged-dry-run.json'), JSON.stringify({
        ...common, checkId: 'composer.dry-run', exportRelative: 'verification/dry-run', exportTreeDigest,
      }, null, 2), 'utf8');
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === false,
        '手写 PASS 证据被平台放行（status=' + String(submitted.status) + '）——平台没有重算/重跑检查，伪造证据可通过门禁');
      assertRejectedWith(submitted, ['AGENT_STATIC_GATE_FAILED', 'AGENT_EVIDENCE_STALE'], '伪造 PASS 证据 submit');
      assertEqual(coord.getAttemptState(handle).status, 'open', '被拒后不得置 submitted');
      return { status: 'PASS', observed: { code: submitted.code, issues: (submitted.issues || []).map((item) => item.code) },
        detail: '手写 PASS 证据未被放行' };
    },
  },
  {
    id: 'A05',
    group: 'A 负例（submit/adopt 证据）',
    title: 'dry-run 导出自 tree1，写候选使树变 tree2，再 submit → AGENT_EVIDENCE_STALE（不得只比 checkId 字符串）',
    x: ['X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.5 submit 门禁②「导出自当前 treeDigest」+ §14.13-F3',
    expected: 'source.check+dry-run 后再次写文件 → submit 返回 AGENT_EVIDENCE_STALE + issue EVIDENCE_STALE_RERUN_CHECKS + nextAction=rerun-checks',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a05');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a05');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a05', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A05-tree1');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      const afterChecks = coord.getAttemptState(handle);
      const write = await writeText(coord, handle, 'pages/menu/index.wxml', readTextOrNull(path.join(driven.paths.candidateDir, 'pages', 'menu', 'index.wxml')) + '\n<!-- A05-tree2 -->\n');
      assert(write.ok === true, '第二次写入失败');
      assert(write.data.treeDigest !== afterChecks.treeDigest, '第二次写入后摘要应变化');
      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_EVIDENCE_STALE', '旧树证据 submit');
      const issues = (submitted.issues || []).map((item) => item.code);
      assert(issues.includes('EVIDENCE_STALE_RERUN_CHECKS'), '应带 EVIDENCE_STALE_RERUN_CHECKS，实际 ' + JSON.stringify(issues));
      assertEqual(submitted.nextAction, 'rerun-checks', 'nextAction 应为 rerun-checks');
      return { status: 'PASS', observed: { code: submitted.code, issues, nextAction: submitted.nextAction },
        detail: '旧导出树证据被拒（stale 三要素齐全）' };
    },
  },
  {
    id: 'A06',
    group: 'A 负例（submit/adopt 证据）',
    title: '提交后再写使摘要变化 → 先被 AGENT_ATTEMPT_IMMUTABLE 拦住；重复 submit → AGENT_RUN_ALREADY_SUBMITTED',
    x: ['X3', 'X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.2 不变量 4 + §14.5',
    expected: '两条路径都不得放行：写拒绝且零落盘；重复提交拒绝且候选身份/摘要不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a06');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a06');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a06', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A06');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功：' + JSON.stringify(submitted.code));
      const candidateBefore = ctx.env.fingerprintDir(driven.paths.candidateDir);
      const lateWrite = await writeText(coord, handle, 'pages/menu/index.wxml', 'late\n');
      assertRejectedWith(lateWrite, 'AGENT_ATTEMPT_IMMUTABLE', '提交后写入');
      assertEqual(ctx.env.fingerprintDir(driven.paths.candidateDir).digest, candidateBefore.digest, '写入被拒必须零落盘');
      const again = coord.submitAttempt(handle);
      assertRejectedWith(again, 'AGENT_RUN_ALREADY_SUBMITTED', '重复提交');
      assertEqual(coord.getAttemptState(handle).treeDigest, submitted.treeDigest, '重复提交不得改摘要');
      return { status: 'PASS', observed: { lateWrite: lateWrite.code, again: again.code },
        detail: '提交后写与重复提交都被拒，候选零变化' };
    },
  },
  {
    id: 'A07',
    group: 'A 负例（submit/adopt 证据）',
    title: 'adopt 前改写 submission.treeDigest（工作树与证据不一致）→ AGENT_EVIDENCE_STALE，不生成新版本、指针不变',
    x: ['X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.5 adopt-attempt 段',
    expected: '提交后把 submission.json 的 treeDigest 改成别的值 → adopt 拒绝 AGENT_EVIDENCE_STALE；versions/ 目录集合与指针不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a07');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a07');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a07', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A07');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handle).ok === true, 'submit 应成功');
      const submissionFile = path.join(driven.paths.verificationDir, 'submission.json');
      const submission = JSON.parse(fs.readFileSync(submissionFile, 'utf8'));
      submission.treeDigest = 'sha256:' + '0'.repeat(64);
      fs.writeFileSync(submissionFile, JSON.stringify(submission, null, 2), 'utf8');
      const versionsBefore = ctx.env.fingerprintDir(project.paths.versionsDir);
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assertRejectedWith(adopted, 'AGENT_EVIDENCE_STALE', '篡改 treeDigest 的 adopt');
      assertEqual(ctx.env.fingerprintDir(project.paths.versionsDir).digest, versionsBefore.digest, '被拒后不得生成新版本');
      const state = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-a07' });
      assertEqual(state.state.currentVersionId, 'v1', '版本指针不得前进');
      return { status: 'PASS', observed: { code: adopted.code, nextAction: adopted.nextAction || null },
        detail: '证据摘要不符被拒，版本零新增' };
    },
  },
  {
    id: 'A08',
    group: 'A 负例（submit/adopt 证据）',
    title: '提交后篡改 attempt/verification/dry-run/** 再 adopt → AGENT_EVIDENCE_STALE（重算 exportTreeDigest 与记录不符）',
    x: ['X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.5「校验 treeDigest/exportTreeDigest 与记录一致」',
    expected: '提交后改导出树里的文件 → adopt 拒绝 AGENT_EVIDENCE_STALE；不生成新版本、不清洗、不回落',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a08');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a08');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a08', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A08');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功');
      const exportDir = path.join(driven.paths.attemptDir, ...String(driven.dryRun.data.exportRelative).split('/'));
      assert(fs.existsSync(exportDir), '导出树应存在');
      const tamperFile = path.join(exportDir, 'pages', 'menu', 'index.wxml');
      fs.writeFileSync(tamperFile, (readTextOrNull(tamperFile) || '') + '\n<!-- tampered after submit -->\n', 'utf8');
      const versionsBefore = ctx.env.fingerprintDir(project.paths.versionsDir);
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assertRejectedWith(adopted, 'AGENT_EVIDENCE_STALE', '篡改导出树后的 adopt');
      assertEqual(ctx.env.fingerprintDir(project.paths.versionsDir).digest, versionsBefore.digest, '被拒后不得生成新版本');
      return { status: 'PASS', observed: { code: adopted.code, issues: (adopted.issues || []).map((item) => item.code) },
        detail: '导出树被篡改后 adopt 拒绝' };
    },
  },
  {
    id: 'A09',
    group: 'A 负例（submit/adopt 证据）',
    title: 'partial（微信 BLOCKED）未 partialConfirmed 就 adopt → AGENT_PARTIAL_CONFIRM_REQUIRED；确认后才可 adopt 且结果仍标 partial',
    x: ['X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.5 + §3.3 + §14.12-Q1③',
    expected: 'wechat.verify 未跑 → submit.partial=true；adopt 不带确认 → AGENT_PARTIAL_CONFIRM_REQUIRED；'
      + '带 partialConfirmed:true → 成功，且 version.verification.runtime=BLOCKED（≠ 通过）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a09');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a09');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a09', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A09');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      const submitted = coord.submitAttempt(handle);
      assert(submitted.ok === true, 'submit 应成功');
      assertEqual(submitted.partial, true, 'wechat 未跑应为 partial');
      const unconfirmed = coord.adoptAttempt(handle);
      assertRejectedWith(unconfirmed, 'AGENT_PARTIAL_CONFIRM_REQUIRED', '未确认 partial');
      assertEqual(unconfirmed.nextAction, 'confirm-partial', 'nextAction 应为 confirm-partial');
      const confirmed = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assert(confirmed.ok === true, '确认后 adopt 应成功：' + JSON.stringify(confirmed.code));
      const version = project.versions.readVersion({ userDataDir: ctx.temp.real, projectId: 'e0v1-a09', versionId: confirmed.adoptedVersionId });
      assertEqual(version.version.verification.runtime, 'BLOCKED', 'version.verification.runtime 应为 BLOCKED（partial 不等于通过）');
      return { status: 'PASS', observed: { submitPartial: submitted.partial, unconfirmed: unconfirmed.code,
        runtimeVerification: version.version.verification.runtime },
        detail: 'partial 未确认被拒；确认后仍记 BLOCKED' };
    },
  },
  {
    id: 'A49',
    group: 'A 负例（submit/adopt 证据）',
    title: '越级 adopt：attempt 未 submitted 就 adopt → AGENT_ADOPTION_FAILED + issue NOT_SUBMITTED（不得用别的码顶替）',
    x: ['X7'],
    requires: COORDINATOR,
    basis: 'rev15 §14.12-1（Captain 裁定 Q1）',
    expected: '从未提交就 adopt → AGENT_ADOPTION_FAILED 且 issues 含 code=NOT_SUBMITTED；不生成新版本、versions/ 不变；'
      + '不得返回 AGENT_EVIDENCE_STALE / AGENT_PARTIAL_CONFIRM_REQUIRED',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a49');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a49');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a49', run);
      const versionsBefore = ctx.env.fingerprintDir(project.paths.versionsDir);
      const adopted = coord.adoptAttempt({ ...handle, partialConfirmed: true });
      assertRejectedWith(adopted, 'AGENT_ADOPTION_FAILED', '未提交就 adopt');
      const issues = (adopted.issues || []).map((item) => item.code);
      assert(issues.includes('NOT_SUBMITTED'), 'issues 必须含 NOT_SUBMITTED，实际 ' + JSON.stringify(issues));
      assertEqual(ctx.env.fingerprintDir(project.paths.versionsDir).digest, versionsBefore.digest, '不得生成新版本');
      const pointer = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: 'e0v1-a49' });
      assertEqual(pointer.state.currentVersionId, 'v1', '指针不得前进');
      return { status: 'PASS', observed: { code: adopted.code, issues }, detail: '越级 adopt 命中三分码之一（NOT_SUBMITTED）' };
    },
  },

  /* ---------------- A10–A15：检查目标（X4） ---------------- */
  {
    id: 'A10',
    group: 'A 负例（检查目标）',
    title: '用 Base 源冒充候选跑 source.check → AGENT_PAYLOAD_INVALID 且 runner 0 次调用',
    x: ['X4'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.4 第一行（source.check 执行对象 = attempt 树，root 只由平台填）',
    expected: 'run_check args.root=templates/base/…/src → AGENT_PAYLOAD_INVALID；注册表 runCheck 调用 0 次；'
      + '随后正常 source.check 的 root=attempt/candidate、subjectKind=attempt',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a10');
      const registry = countingRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-a10');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a10', run);
      const paths = attemptPaths(project, run);
      const injection = await coord.invokeTool({
        ...handle, tool: 'run_check', args: { checkId: 'source.check', root: BASE_SRC },
      });
      assertRejectedWith(injection, 'AGENT_PAYLOAD_INVALID', '模型注入 Base root');
      assertEqual(registry.calls.length, 0, '模型注入 root 时 runner 必须 0 次调用');
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A10 -->\n')).ok === true, '写入失败');
      const real = await runCheck(coord, handle, 'source.check');
      if (!real.ok) return { status: 'BLOCKED', observed: { code: real.code }, detail: '真实 source.check 不可用' };
      const call = registry.calls.find((item) => item.checkId === 'source.check');
      assertEqual(call.root, paths.candidateDir, '平台注入的 root 必须是 attempt/candidate，不能是 Base');
      assertEqual(call.subjectKind, 'attempt', '平台必须以 subjectKind=attempt 执行');
      assert(!String(call.root).startsWith(BASE_SRC), 'root 不得指向 Base');
      return { status: 'PASS', observed: { injection: injection.code, platformRoot: 'attempt/candidate',
        subjectKind: call.subjectKind, status: real.data.status }, detail: 'Base root 注入被拒，真实检查落 attempt' };
    },
  },
  {
    id: 'A11',
    group: 'A 负例（检查目标）',
    title: '用已采用版本 versions/v1/source 冒充候选跑 source.check → 注入被拒；真实证据 subjectKind=attempt 且摘要=当前 attempt',
    x: ['X4'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.4 + 计划 §1 X4',
    expected: 'args.root=versions/v1/source → AGENT_PAYLOAD_INVALID 且 runner 0 次；'
      + '真实 source.check 的 treeDigest 必须等于当前 attempt 摘要（不等于 v1 版本摘要）',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a11');
      const registry = countingRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-a11');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a11', run);
      const paths = attemptPaths(project, run);
      const versionSource = path.join(project.paths.versionsDir, 'v1', 'source');
      const injection = await coord.invokeTool({
        ...handle, tool: 'run_check', args: { checkId: 'source.check', root: versionSource },
      });
      assertRejectedWith(injection, 'AGENT_PAYLOAD_INVALID', '模型注入版本 root');
      assertEqual(registry.calls.length, 0, '注入 root 时 runner 必须 0 次调用');
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A11 -->\n')).ok === true, '写入失败');
      const real = await runCheck(coord, handle, 'source.check');
      if (!real.ok) return { status: 'BLOCKED', observed: { code: real.code }, detail: '真实 source.check 不可用' };
      assertEqual(real.data.subjectKind, 'attempt', '证据主体必须是 attempt');
      const state = coord.getAttemptState(handle);
      assertEqual(real.data.treeDigest, state.treeDigest, '证据摘要必须等于当前 attempt 摘要');
      assert(real.data.treeDigest !== project.v1TreeDigest, '证据摘要不得等于已采用版本摘要（否则查的是版本）');
      assertEqual(registry.calls.filter((item) => item.checkId === 'source.check').pop().subjectKind, 'attempt',
        '平台注入主体应为 attempt');
      return { status: 'PASS', observed: { injection: injection.code, subjectKind: real.data.subjectKind,
        matchesAttempt: true, equalsVersion: false }, detail: '版本冒充被拒，真实检查绑定 attempt' };
    },
  },
  {
    id: 'A12',
    group: 'A 负例（检查目标）',
    title: '用仓库 miniprogram/ 镜像冒充派生导出树跑 mini.check → 注入被拒；无导出树 → AGENT_CHECK_UNKNOWN（不回落镜像）',
    x: ['X4'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.4 第三行「绝不允许回落仓库 miniprogram/ 镜像」',
    expected: 'args.root=仓库 miniprogram → AGENT_PAYLOAD_INVALID 且 runner 0 次；未跑 dry-run 时 mini.check → AGENT_CHECK_UNKNOWN，'
      + '且注册表 0 次调用；整个用例仓库 miniprogram/ 指纹不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a12');
      const registry = countingRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-a12');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a12', run);
      const mirrorBefore = ctx.env.fingerprintDir(REPO_MIRROR);
      const injection = await coord.invokeTool({
        ...handle, tool: 'run_check', args: { checkId: 'mini.check', root: REPO_MIRROR },
      });
      assertRejectedWith(injection, ['AGENT_PAYLOAD_INVALID', 'AGENT_CHECK_UNKNOWN'], '模型注入仓库镜像 root');
      assertEqual(registry.calls.length, 0, '注入 root 时 runner 必须 0 次调用');
      const noExport = await runCheck(coord, handle, 'mini.check');
      assertRejectedWith(noExport, 'AGENT_CHECK_UNKNOWN', '无导出树的 mini.check');
      assertEqual(registry.calls.length, 0, '缺导出根时必须先拒，runner 0 次调用');
      assertEqual(ctx.env.fingerprintDir(REPO_MIRROR).digest, mirrorBefore.digest, '仓库镜像必须零写入');
      return { status: 'PASS', observed: { injection: injection.code, noExport: noExport.code, runnerCalls: 0 },
        detail: '仓库镜像冒充被拒，缺派生导出树不回落镜像' };
    },
  },
  {
    id: 'A15',
    group: 'A 负例（检查目标）',
    title: '证据缺字段不参与门禁；dry-run 导出落点越界（模型传 exportParentDir）→ AGENT_PAYLOAD_INVALID 且 runner 0 次',
    x: ['X4', 'X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.4 证据字段 + §14.5',
    expected: '手写缺 treeDigest/subjectKind 的 source.check 证据 + 无 dry-run → submit 仍 AGENT_STATIC_GATE_FAILED；'
      + 'run_check 带 exportParentDir（attempt/verification 之外）→ AGENT_PAYLOAD_INVALID，runner 0 次，外部目录零落盘',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a15');
      const registry = countingRegistry(ctx);
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-a15');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a15', run);
      const paths = attemptPaths(project, run);
      const current = readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml'));
      assert((await writeText(coord, handle, 'pages/menu/index.wxml', current + '\n<!-- A15 -->\n')).ok === true, '写入失败');
      fs.mkdirSync(paths.checksDir, { recursive: true });
      fs.writeFileSync(path.join(paths.checksDir, 'incomplete.json'),
        JSON.stringify({ checkId: 'source.check', status: 'PASS', at: new Date().toISOString() }, null, 2), 'utf8');
      const submitted = coord.submitAttempt(handle);
      assertRejectedWith(submitted, 'AGENT_STATIC_GATE_FAILED', '不完整证据 submit');
      const outsideDir = path.join(ctx.temp.real, 'outside-export');
      const callsBefore = registry.calls.length;
      const injection = await coord.invokeTool({
        ...handle, tool: 'run_check', args: { checkId: 'composer.dry-run', exportParentDir: outsideDir },
      });
      assertRejectedWith(injection, 'AGENT_PAYLOAD_INVALID', '模型注入 exportParentDir');
      assertEqual(registry.calls.length, callsBefore, '注入导出落点时 runner 必须 0 次调用');
      assert(!fs.existsSync(outsideDir), '越界导出目录不得被创建（零落盘）');
      return { status: 'PASS', observed: { submit: submitted.code, injection: injection.code, outsideDirCreated: false },
        detail: '不完整证据不参与门禁；越界导出落点被拒且零落盘' };
    },
  },

  /* ---------------- A21–A22：句柄/身份 ---------------- */
  {
    id: 'A21',
    group: 'A 负例（句柄/路径/越权）',
    title: '跨项目句柄 / 搬移 run 目录 / 伪造 projectId → Coordinator 拒绝（AGENT_RUN_NOT_FOUND / AGENT_PROJECT_MISMATCH）且零落盘',
    x: ['X1', 'X3'],
    requires: COORDINATOR,
    basis: 'rev15 §14.2 不变量 5 + §14.12-2',
    expected: '用 B 的 projectId 访问 A 的 run → AGENT_RUN_NOT_FOUND；把 A 的 run 目录复制进 B 后访问 → AGENT_PROJECT_MISMATCH；'
      + '两项目 runs/ 与 A 的候选摘要零变化',
    async run(ctx) {
      const projectA = setupProject(ctx, 'e0v1-a21a');
      const projectB = setupProject(ctx, 'e0v1-a21b');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const runA = startRun(coord, 'e0v1-a21a');
      assert(runA.ok === true, 'startRun(A) 失败');
      const handleA = handleOf('e0v1-a21a', runA);
      const pathsA = attemptPaths(projectA, runA);
      const digestBefore = coord.getAttemptState(handleA).treeDigest;
      const runsABefore = ctx.env.fingerprintDir(projectA.runsDir);
      const runsBBefore = ctx.env.fingerprintDir(projectB.runsDir);
      const cross = await coord.invokeTool({
        projectId: 'e0v1-a21b', runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
        tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'cross\n' }] },
      });
      const crossCode = assertRejectedWith(cross, ['AGENT_RUN_NOT_FOUND', 'AGENT_PROJECT_MISMATCH'], '跨项目句柄');
      const srcRunDir = path.join(projectA.paths.workspaceDir, 'runs', runA.runId);
      const dstRunDir = path.join(projectB.paths.workspaceDir, 'runs', runA.runId);
      fs.cpSync(srcRunDir, dstRunDir, { recursive: true });
      const copyBefore = ctx.env.fingerprintDir(dstRunDir);
      const moved = await coord.invokeTool({
        projectId: 'e0v1-a21b', runId: runA.runId, turnId: runA.turnId, attemptId: runA.attemptId,
        tool: 'write_files', args: { changes: [{ path: 'pages/menu/index.wxml', content: 'moved\n' }] },
      });
      const movedCode = assertRejectedWith(moved, ['AGENT_PROJECT_MISMATCH', 'AGENT_RUN_NOT_FOUND'], '搬移 run 目录');
      assertEqual(ctx.env.fingerprintDir(dstRunDir).digest, copyBefore.digest, 'B 侧副本必须零写入');
      assertEqual(coord.getAttemptState(handleA).treeDigest, digestBefore, 'A 的候选摘要不得变化');
      assertEqual(ctx.env.fingerprintDir(projectA.runsDir).digest, runsABefore.digest, 'A 的 runs/ 必须零写入');
      return { status: 'PASS', observed: { crossCode, movedCode, aZeroWrites: true, bCopyZeroWrites: true },
        detail: '跨项目/搬移句柄被 Coordinator 拒绝且零落盘' };
    },
  },
  {
    id: 'A22',
    group: 'A 负例（句柄/路径/越权）',
    title: '跨 run / 跨 turn / 伪造 attempt 句柄 → AGENT_ATTEMPT_NOT_FOUND / AGENT_RUN_NOT_FOUND 且不建目录',
    x: ['X3'],
    requires: COORDINATOR,
    basis: 'rev15 §14.2 不变量 5',
    expected: '伪造 attemptId / 跨 turn / 跨 run 全部拒绝；runs/ 目录集合不变、候选摘要不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a22');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a22');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a22', run);
      const runsBefore = fs.readdirSync(project.runsDir).slice().sort();
      const digestBefore = coord.getAttemptState(handle).treeDigest;
      const forgedAttempt = await coord.invokeTool({
        ...handle, attemptId: 'attempt-9', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'forged\n' }] },
      });
      const forgedCode = assertRejectedWith(forgedAttempt, 'AGENT_ATTEMPT_NOT_FOUND', '伪造 attemptId');
      const crossTurn = await coord.invokeTool({
        ...handle, turnId: 'turn-9', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'turn\n' }] },
      });
      const crossTurnCode = assertRejectedWith(crossTurn, 'AGENT_ATTEMPT_NOT_FOUND', '跨 turn');
      const crossRun = await coord.invokeTool({
        ...handle, runId: 'frun-forged-000000', tool: 'write_files',
        args: { changes: [{ path: 'pages/menu/index.wxml', content: 'run\n' }] },
      });
      const crossRunCode = assertRejectedWith(crossRun, 'AGENT_RUN_NOT_FOUND', '跨 run');
      assertEqual(JSON.stringify(fs.readdirSync(project.runsDir).slice().sort()), JSON.stringify(runsBefore), '不得新建 run 目录');
      assertEqual(coord.getAttemptState(handle).treeDigest, digestBefore, '候选摘要不得变化');
      return { status: 'PASS', observed: { forgedCode, crossTurnCode, crossRunCode }, detail: '伪造/跨 run/跨 turn 全部拒绝且零落盘' };
    },
  },

  /* ---------------- A26–A29：不可变与生命周期 ---------------- */
  {
    id: 'A26',
    group: 'A 负例（attempt 不可变）',
    title: 'submitted 后继续 write_files/delete_files → AGENT_ATTEMPT_IMMUTABLE 且候选摘要不变',
    x: ['X3', 'X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.2 不变量 4',
    expected: '两种写工具都被拒；候选目录指纹与 submitted 证据不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a26');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a26');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a26', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A26');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handle).ok === true, 'submit 应成功');
      const candidateBefore = ctx.env.fingerprintDir(driven.paths.candidateDir);
      const write = await writeText(coord, handle, 'pages/menu/index.wxml', 'late\n');
      const writeCode = assertRejectedWith(write, 'AGENT_ATTEMPT_IMMUTABLE', '提交后 write_files');
      const del = await coord.invokeTool({ ...handle, tool: 'delete_files', args: { paths: [{ path: 'pages/menu/index.wxml' }] } });
      const delCode = assertRejectedWith(del, 'AGENT_ATTEMPT_IMMUTABLE', '提交后 delete_files');
      assertEqual(ctx.env.fingerprintDir(driven.paths.candidateDir).digest, candidateBefore.digest, '候选目录必须零写入');
      return { status: 'PASS', observed: { writeCode, delCode }, detail: '提交后写/删都被拒且零落盘' };
    },
  },
  {
    id: 'A27',
    group: 'A 负例（attempt 不可变）',
    title: 'submit 成功后再次 submit → AGENT_RUN_ALREADY_SUBMITTED（不产生第二候选身份）',
    x: ['X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.9 新码表',
    expected: '第二次 submit 拒绝；已提交候选身份、treeDigest、证据不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a27');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a27');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a27', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A27');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      const first = coord.submitAttempt(handle);
      assert(first.ok === true, '首次 submit 应成功');
      const submissionBefore = fs.readFileSync(path.join(driven.paths.verificationDir, 'submission.json'), 'utf8');
      const second = coord.submitAttempt(handle);
      assertRejectedWith(second, 'AGENT_RUN_ALREADY_SUBMITTED', '重复 submit');
      assertEqual(coord.getAttemptState(handle).treeDigest, first.treeDigest, '摘要不得变化');
      assertEqual(fs.readFileSync(path.join(driven.paths.verificationDir, 'submission.json'), 'utf8'),
        submissionBefore, 'submission 证据不得被第二次提交改写');
      return { status: 'PASS', observed: { first: first.status, second: second.code },
        detail: '重复提交被拒，候选身份与证据不变' };
    },
  },
  {
    id: 'A28',
    group: 'A 负例（attempt 不可变）',
    title: 'repair 覆盖已提交候选（继续写 attempt-1）→ 拒绝；修复必须落新 attempt（当前实现为新 run 的 attempt-1）',
    x: ['X3', 'X7'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.2 不变量 4「repair 建新 attempt，不覆盖已提交候选」',
    expected: 'attempt-1 零写入且摘要不变；新修改落在新 run 的新 attempt（平台当前不提供同 run attempt-2 入口，登记为偏差）；'
      + '两个 attempt 摘要可追溯',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a28');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a28');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a28', run);
      const driven = await driveRealChecks(coord, handle, project, run, 'A28');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handle).ok === true, 'submit 应成功');
      const candidateBefore = ctx.env.fingerprintDir(driven.paths.candidateDir);
      const overwrite = await writeText(coord, handle, 'pages/menu/index.wxml', 'repair-overwrite\n');
      assertRejectedWith(overwrite, 'AGENT_ATTEMPT_IMMUTABLE', 'repair 覆盖已提交候选');
      const repair = startRun(coord, 'e0v1-a28', { operation: 'repair-menu', utterance: '按 issue 修复菜单' });
      assert(repair.ok === true, 'repair 新 attempt 失败：' + JSON.stringify(repair.code));
      assert(repair.runId !== run.runId, 'repair 应由新 run 承接（当前无同 run attempt-2 入口）');
      const repairWrite = await writeText(coord, handleOf('e0v1-a28', repair), 'pages/menu/index.wxml', 'repair\n');
      assert(repairWrite.ok === true, 'repair attempt 写入应成功');
      assertEqual(ctx.env.fingerprintDir(driven.paths.candidateDir).digest, candidateBefore.digest, '已提交 attempt-1 必须字节不变');
      const attempts = coord.getRun({ projectId: 'e0v1-a28', runId: run.runId }).attempts.map((item) => item.attemptId);
      return { status: 'PASS', observed: { overwrite: overwrite.code, repairRunId: repair.runId, repairAttemptId: repair.attemptId,
        originalAttempts: attempts }, detail: '已提交候选不可覆盖；修复落在新 run 的新 attempt（同 run attempt-2 入口缺失，已登记偏差）' };
    },
  },
  {
    id: 'A29',
    group: 'A 负例（attempt 不可变）',
    title: '工具写入带 version subject → AGENT_PAYLOAD_INVALID；read_file 的 version 覆盖仍只读成功',
    x: ['X3'],
    requires: COORDINATOR,
    basis: 'rev15 §14.3「写入永不接受 version subject」',
    expected: 'write_files + subject/subjectOverride=version 全部拒绝；versions/v1 指纹不变；read_file(version) 成功且内容来自版本',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a29');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a29');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a29', run);
      const v1Dir = path.join(project.paths.versionsDir, 'v1');
      const v1Before = ctx.env.fingerprintDir(v1Dir);
      const versionSubject = { kind: 'version', versionId: 'v1' };
      const attempts = [
        { subject: versionSubject },
        { subjectOverride: versionSubject },
      ];
      const codes = [];
      for (const extra of attempts) {
        const result = await coord.invokeTool({
          ...handle, ...extra, tool: 'write_files',
          args: { changes: [{ path: 'pages/menu/index.wxml', content: 'probe\n' }] },
        });
        codes.push(assertRejectedWith(result, ['AGENT_PAYLOAD_INVALID', 'AGENT_TOOL_NOT_ALLOWED'], '写入带 version subject'));
      }
      const read = await coord.invokeTool({ ...handle, tool: 'read_file', args: { path: 'app.json', subjectOverride: versionSubject } });
      assert(read.ok === true, 'read_file(version) 应成功');
      assertEqual(read.data.content, readTextOrNull(path.join(v1Dir, 'source', 'app.json')), '内容应来自 versions/v1/source');
      assertEqual(ctx.env.fingerprintDir(v1Dir).digest, v1Before.digest, '版本目录零写入');
      return { status: 'PASS', observed: { writeCodes: codes, versionReadOnly: true }, detail: '写入拒绝 version subject，版本只读成立' };
    },
  },

  /* ---------------- A30–A31：工具白名单 ---------------- */
  {
    id: 'A30',
    group: 'A 负例（工具白名单）',
    title: '平台专用工具名（derive_source_bundle / adopt_attempt / attach_image_asset + 变体）→ AGENT_TOOL_NOT_ALLOWED',
    x: ['X6', 'X7'],
    requires: COORDINATOR,
    basis: 'rev15 §14.3 平台专用段',
    expected: '三个平台专用名不在 MODEL_TOOL_NAMES；调用（含大小写/前缀变体）一律 AGENT_TOOL_NOT_ALLOWED；不产生任何落盘',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a30');
      const coordMod = ctx.frozen.requireStrict('run-coordinator');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a30');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a30', run);
      const paths = attemptPaths(project, run);
      const before = ctx.env.fingerprintDir(paths.attemptDir);
      const names = ['derive_source_bundle', 'adopt_attempt', 'attach_image_asset', 'Derive_Source_Bundle', 'x_derive_source_bundle'];
      const codes = [];
      for (const name of names) {
        const result = await coord.invokeTool({ ...handle, tool: name, args: {} });
        codes.push(assertRejectedWith(result, 'AGENT_TOOL_NOT_ALLOWED', '平台专用/变体工具名 ' + name));
      }
      for (const name of ['derive_source_bundle', 'adopt_attempt', 'attach_image_asset']) {
        assert(!coordMod.MODEL_TOOL_NAMES.includes(name), '平台专用名不得出现在模型工具列表：' + name);
        assert(coordMod.PLATFORM_ONLY_TOOL_NAMES.includes(name), '平台专用名应在 PLATFORM_ONLY_TOOL_NAMES：' + name);
      }
      assertEqual(coordMod.MODEL_TOOL_NAMES.length, 11, '模型工具应为 11 个');
      assertEqual(ctx.env.fingerprintDir(paths.attemptDir).digest, before.digest, '被拒工具调用不得落盘');
      return { status: 'PASS', observed: { codes, modelToolCount: coordMod.MODEL_TOOL_NAMES.length }, detail: '平台专用工具名与变体全部拒绝' };
    },
  },
  {
    id: 'A31',
    group: 'A 负例（工具白名单）',
    title: '未登记工具名（write_file 单数 / shell / exec / child_process）→ AGENT_TOOL_NOT_ALLOWED，不存在通用命令入口',
    x: ['X1', 'X3'],
    requires: COORDINATOR,
    basis: 'rev15 §14.3（11 个工具固定命名）',
    expected: '全部拒绝 AGENT_TOOL_NOT_ALLOWED；工具目录中无 shell/exec/child_process；候选零写入',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a31');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a31');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a31', run);
      const paths = attemptPaths(project, run);
      const before = ctx.env.fingerprintDir(paths.candidateDir);
      const names = ['write_file', 'shell', 'exec', 'child_process', 'spawn', 'node_eval'];
      const codes = [];
      for (const name of names) {
        const result = await coord.invokeTool({ ...handle, tool: name, args: {} });
        codes.push(assertRejectedWith(result, 'AGENT_TOOL_NOT_ALLOWED', '未登记工具名 ' + name));
      }
      const catalog = coord.toolCatalog();
      for (const name of names) assert(!catalog.modelTools.includes(name), '工具目录不得含 ' + name);
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, before.digest, '被拒工具不得落盘');
      return { status: 'PASS', observed: { codes, modelTools: catalog.modelTools }, detail: '未登记工具名全部拒绝，无命令入口' };
    },
  },

  /* ---------------- A32–A34：截断与预算（X8） ---------------- */
  {
    id: 'A32',
    group: 'A 负例（截断/预算）',
    title: '上游 finish_reason=length 且带 tool_calls → 本批工具零执行、返回 AGENT_OUTPUT_TRUNCATED、attempt 摘要不变',
    x: ['X8'],
    requires: RUNTIME,
    basis: 'rev15 §14.7 / §12.2-3',
    expected: 'runtime 返回 ok:false + AGENT_OUTPUT_TRUNCATED（可重试）；写工具未执行（候选摘要不变）；truncated 标记出现在结果/trace',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a32');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a32');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a32', run);
      const paths = attemptPaths(project, run);
      const before = coord.getAttemptState(handle);
      const fake = fakeModel(ctx, async () => ({
        model: 'fake-upstream', finishReason: 'length', content: '',
        toolCalls: [{ id: 't1', name: 'write_files', arguments: JSON.stringify({ changes: [{ path: 'pages/menu/index.wxml', content: 'truncated-write\n' }] }) }],
      }));
      const runtime = createRuntime(ctx, coord, fake.modelChat);
      const result = await runtime.invoke({ context: handle, request: { utterance: '写一整页菜单', profile: 'chat' } });
      assert(result.ok === false, '截断结果不得 ok:true');
      assertEqual(result.code, 'AGENT_OUTPUT_TRUNCATED', '截断码应为 AGENT_OUTPUT_TRUNCATED');
      assertEqual(fake.calls.length, 1, '截断后不得再发上游');
      assertEqual(coord.getAttemptState(handle).treeDigest, before.treeDigest, '截断时本批工具零执行（摘要不变）');
      assert(!readTextOrNull(path.join(paths.candidateDir, 'pages', 'menu', 'index.wxml')).includes('truncated-write'),
        '截断内容不得写入工作树');
      return { status: 'PASS', observed: { code: result.code, retryable: result.retryable === true,
        upstreamCalls: fake.calls.length, digestUnchanged: true }, detail: 'finish=length 时工具零执行且返回 output_truncated' };
    },
  },
  {
    id: 'A33',
    group: 'A 负例（截断/预算）',
    title: '空正文 + finish_reason=length → 记 truncated（不是“无响应”，也不当成功/不写盘）',
    x: ['X8'],
    requires: RUNTIME,
    basis: 'rev15 §14.7 第 1 条 / D-RT-1',
    expected: '返回 AGENT_OUTPUT_TRUNCATED / status=needs_input 或等价可重试结果；不得抛“无响应”类崩溃；候选摘要不变',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a33');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, 'e0v1-a33');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a33', run);
      const before = coord.getAttemptState(handle);
      const fake = fakeModel(ctx, async () => ({ model: 'fake-upstream', finishReason: 'length', content: '', toolCalls: [] }));
      const runtime = createRuntime(ctx, coord, fake.modelChat);
      let result = null;
      try {
        result = await runtime.invoke({ context: handle, request: { utterance: '长回答', profile: 'chat', images: [] } });
      } catch (error) {
        throw new Error('空正文+length 不得抛异常：' + (error && error.message));
      }
      assert(result, '应返回结果对象');
      assert(result.ok === false, '空正文+length 不得 ok:true');
      assertEqual(result.code, 'AGENT_OUTPUT_TRUNCATED', '应返回可重试截断码');
      assertEqual(coord.getAttemptState(handle).treeDigest, before.treeDigest, '不得写盘');
      return { status: 'PASS', observed: { code: result.code, status: result.data && result.data.status },
        detail: '空正文+length 被记为截断，不崩溃、不写盘' };
    },
  },
  {
    id: 'A34',
    group: 'A 负例（截断/预算）',
    title: '预算：源码编辑默认 6000 / 硬上限 8000；1200 被抬到 6000（不静默回退）；>8000 明确报错',
    x: ['X8'],
    requires: ['model-call-scheduler', 'agent-runtime'],
    basis: 'rev15 §14.7 第 3 条',
    expected: 'resolveMaxTokens(direct-edit) 默认 6000、1200→6000(raised)、9000→ok:false；normalizeChatPayload 对 9000 抛 MODEL_REQUEST_INVALID；'
      + 'direct profile 请求体 max_tokens=6000',
    async run(ctx) {
      const credentials = require(path.join(REPO_ROOT, 'desktop', 'model-credentials.cjs'));
      assertEqual(credentials.DIRECT_EDIT_MAX_TOKENS.default, 6000, '源码编辑默认应为 6000');
      assertEqual(credentials.DIRECT_EDIT_MAX_TOKENS.max, 8000, '硬上限应为 8000');
      const dflt = credentials.resolveMaxTokens({ profile: 'direct-edit' });
      assertEqual(dflt.ok, true, '默认解析应成功');
      assertEqual(dflt.maxTokens, 6000, '默认 maxTokens 应为 6000（不是 1200）');
      const raised = credentials.resolveMaxTokens({ profile: 'direct-edit', maxTokens: 1200 });
      assertEqual(raised.ok, true, '1200 应被抬升而不是报错');
      assertEqual(raised.maxTokens, 6000, '1200 应抬到 6000');
      assertEqual(raised.raised, true, '抬升必须标记 raised=true');
      const tooLarge = credentials.resolveMaxTokens({ profile: 'direct-edit', maxTokens: 9000 });
      assertEqual(tooLarge.ok, false, '>8000 必须明确报错而不是静默裁剪');
      let thrown = null;
      try {
        credentials.normalizeChatPayload({
          profile: 'direct-edit', maxTokens: 9000,
          messages: [{ role: 'user', content: 'hi' }],
        });
      } catch (error) { thrown = error; }
      assert(thrown && thrown.code === 'MODEL_REQUEST_INVALID', '>8000 的请求应抛 MODEL_REQUEST_INVALID');
      const normalized = credentials.normalizeChatPayload({
        profile: 'direct-edit', messages: [{ role: 'user', content: 'hi' }],
      });
      assertEqual(normalized.body.max_tokens, 6000, 'direct-edit 请求体 max_tokens 必须是 6000');
      return { status: 'PASS', observed: { default: dflt.maxTokens, raised: raised.maxTokens, max: 8000,
        tooLarge: tooLarge.message }, detail: '预算契约成立：6000 默认/8000 上限/1200 抬升/>8000 报错' };
    },
  },

  /* ---------------- A35–A37：取消/迟到 ---------------- */
  {
    id: 'A35',
    group: 'A 负例（取消/迟到）',
    title: '取消排队项后不再发起上游：排队项出队（MODEL_ABORTED）、占槽任务不受影响、槽位释放可复用',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 第 7 条',
    expected: '3 槽占满 + 2 排队；取消两个排队项 → MODEL_ABORTED、queued=0、被执行数仍为 3；释放后新任务可立即执行',
    async run(ctx) {
      const scheduler = createScheduler(ctx);
      let release = null;
      const hold = new Promise((resolve) => { release = resolve; });
      let executed = 0;
      const holders = [];
      for (let i = 0; i < 3; i += 1) {
        holders.push(scheduler.run(async () => { executed += 1; await hold; return 'h' + i; }));
      }
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().active, 3, '3 个任务应占满槽位');
      const ca = new AbortController();
      const cb = new AbortController();
      const qa = scheduler.run(async () => { executed += 1; return 'qa'; }, { signal: ca.signal });
      const qb = scheduler.run(async () => { executed += 1; return 'qb'; }, { signal: cb.signal });
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().queued, 2, '应有 2 个排队项');
      const errors = {};
      const sa = qa.catch((error) => { errors.a = error; });
      ca.abort();
      await sa;
      const sb = qb.catch((error) => { errors.b = error; });
      cb.abort();
      await sb;
      assertEqual(errors.a.code, 'MODEL_ABORTED', '取消排队项应为 MODEL_ABORTED');
      assertEqual(errors.b.code, 'MODEL_ABORTED', '第二个也应为 MODEL_ABORTED');
      assertEqual(scheduler.stats().queued, 0, '取消后队列归零');
      assertEqual(executed, 3, '被取消的排队项不得执行（上游调用不增加）');
      release();
      await Promise.allSettled(holders);
      const after = await scheduler.run(async () => 'post', {});
      const stats = scheduler.stats();
      scheduler.close();
      assertEqual(after, 'post', '槽位释放后新任务应能执行');
      assertEqual(stats.active, 0, '结束后 active=0');
      return { status: 'PASS', observed: { cancelCodes: [errors.a.code, errors.b.code], executed, postRan: true },
        detail: '取消排队项不再发起上游，槽位不泄漏' };
    },
  },
  {
    id: 'A36',
    group: 'A 负例（取消/迟到）',
    title: '取消后工具调用不落盘（AGENT_CANCELLED）；提交后迟到工具不落盘（AGENT_ATTEMPT_IMMUTABLE）',
    x: ['X8', 'X12'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §14.2 不变量 6 / §3.3 迟到响应',
    expected: '取消的 run 上 write_files → AGENT_CANCELLED 且候选摘要不变；已提交 attempt 上 write_files → AGENT_ATTEMPT_IMMUTABLE 且零写入',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a36');
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const runA = startRun(coord, 'e0v1-a36');
      assert(runA.ok === true, 'startRun 失败');
      const handleA = handleOf('e0v1-a36', runA);
      const digestA = coord.getAttemptState(handleA).treeDigest;
      const cancel = coord.cancelRun(handleA);
      assertEqual(cancel.state, 'cancelled', '无在途时应直接 cancelled');
      const late = await writeText(coord, handleA, 'pages/menu/index.wxml', 'late\n');
      assertRejectedWith(late, 'AGENT_CANCELLED', '取消后工具调用');
      assertEqual(coord.getAttemptState(handleA).treeDigest, digestA, '取消后候选摘要不得变化');

      const runB = startRun(coord, 'e0v1-a36', { operation: 'second', utterance: '第二次' });
      assert(runB.ok === true, '第二个 run 失败');
      const handleB = handleOf('e0v1-a36', runB);
      const driven = await driveRealChecks(coord, handleB, project, runB, 'A36');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handleB).ok === true, 'submit 应成功');
      const beforeB = ctx.env.fingerprintDir(driven.paths.candidateDir);
      const lateB = await writeText(coord, handleB, 'pages/menu/index.wxml', 'late-after-submit\n');
      assertRejectedWith(lateB, 'AGENT_ATTEMPT_IMMUTABLE', '提交后工具调用');
      assertEqual(ctx.env.fingerprintDir(driven.paths.candidateDir).digest, beforeB.digest, '提交后工具零落盘');
      return { status: 'PASS', observed: { cancel: cancel.state, late: late.code, lateAfterSubmit: lateB.code },
        detail: '取消/提交后的迟到工具都不落盘' };
    },
  },
  {
    id: 'A37',
    group: 'A 负例（取消/迟到）',
    title: 'cancel 三态：在途 requested → 停止后 cancelled → 已提交 too-late（cancelled=false，不得显示为失败）',
    x: ['X12'],
    requires: COORDINATOR.concat(['source-check']),
    basis: 'rev15 §3.3 / rev7 F1',
    expected: '在途 cancel=requested；迟到结束后 run=cancelled；已提交后 cancel=too-late 且 cancelled=false；不产生错误态',
    async run(ctx) {
      const project = setupProject(ctx, 'e0v1-a37');
      let releaseCheck = null;
      let entered = false;
      let intercepted = false;
      const real = realRegistry(ctx);
      const registry = {
        definitions: real.definitions,
        async runCheck(request) {
          if (!intercepted) {
            intercepted = true;
            entered = true;
            await new Promise((resolve) => { releaseCheck = resolve; });
            return { ok: true, checkId: request.checkId, status: 'PASS', durationMs: 1, issues: [], subjectKind: 'attempt' };
          }
          return real.runCheck(request);
        },
      };
      const coord = newCoordinator(ctx, { checks: registry });
      const run = startRun(coord, 'e0v1-a37');
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf('e0v1-a37', run);
      const pending = coord.invokeTool({ ...handle, tool: 'run_check', args: { checkId: 'source.check' } });
      while (!entered) await new Promise((r) => setImmediate(r));
      const requested = coord.cancelRun(handle);
      assertEqual(requested.state, 'requested', '在途取消应为 requested');
      releaseCheck();
      await pending;
      const runState = coord.getRun({ projectId: 'e0v1-a37', runId: run.runId }).state;
      assertEqual(runState, 'cancelled', '在途结束后应为 cancelled');

      const runB = startRun(coord, 'e0v1-a37', { operation: 'second', utterance: '第二次' });
      assert(runB.ok === true, '第二个 run 失败');
      const handleB = handleOf('e0v1-a37', runB);
      const driven = await driveRealChecks(coord, handleB, project, runB, 'A37');
      if (!driven.ok) return { status: 'BLOCKED', observed: { code: driven.result.code }, detail: '真实检查链不可用' };
      assert(coord.submitAttempt(handleB).ok === true, 'submit 应成功');
      const tooLate = coord.cancelRun(handleB);
      assertEqual(tooLate.state, 'too-late', '已提交后 cancel 应为 too-late');
      assertEqual(tooLate.cancelled, false, 'too-late 的 cancelled 必须为 false（不显示为失败）');
      return { status: 'PASS', observed: { requested: requested.state, final: runState, tooLate: tooLate.state },
        detail: '三态 requested→cancelled→too-late 全部命中' };
    },
  },

  /* ---------------- A38–A42：上游并发 ≤3 ---------------- */
  {
    id: 'A38',
    group: 'A 负例（上游并发）',
    title: '同时 5 个上游请求 → 峰值并发恰好 3、排队峰值 2、5 个最终全部成功',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 / 计划 §4 E0-R1a 测试 1',
    expected: 'on-the-fly 峰值=3；stats().maxQueueLength=2；totalAcquired=5；stats 不含 prompt/源码/图片/Key',
    async run(ctx) {
      const scheduler = createScheduler(ctx);
      let active = 0;
      let peak = 0;
      const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => scheduler.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(40);
        active -= 1;
        return index;
      })));
      const stats = scheduler.stats();
      const wire = JSON.stringify(stats);
      scheduler.close();
      assertEqual(results.filter((item) => item.status === 'fulfilled').length, 5, '5 个请求应全部成功');
      assertEqual(peak, 3, '上游并发峰值必须恰好 3');
      assertEqual(stats.maxQueueLength, 2, '排队峰值应为 2');
      assertEqual(stats.totalAcquired, 5, '5 个都应拿到过槽位');
      assertEqual(stats.active, 0, '结束后 active=0');
      assertEqual(stats.queued, 0, '结束后 queued=0');
      assert(!/prompt|messages|data:image|sk-[A-Za-z0-9]{8}/.test(wire), 'stats 不得含 prompt/图片/Key');
      return { status: 'PASS', observed: { peakActive: peak, maxQueueLength: stats.maxQueueLength, totalAcquired: stats.totalAcquired },
        detail: '5 并发被限到 3（第 4/5 个排队），全部完成' };
    },
  },
  {
    id: 'A39',
    group: 'A 负例（上游并发）',
    title: '排队超过 queueTimeoutMs → MODEL_QUEUE_TIMEOUT（不是上游超时/429）；占槽任务不受影响',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 第 3/4 条',
    expected: '虚拟时钟推进 30s+ → 排队项 MODEL_QUEUE_TIMEOUT；totalTimedOut=1；3 个占槽任务随后正常完成',
    async run(ctx) {
      const clock = createFakeClock();
      const scheduler = createScheduler(ctx, { queueTimeoutMs: 30000, now: clock.now, timers: clock.timers });
      let release = null;
      const hold = new Promise((resolve) => { release = resolve; });
      const holders = [];
      for (let i = 0; i < 3; i += 1) holders.push(scheduler.run(async () => { await hold; return 'h' + i; }));
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().active, 3, '3 个 holder 应占满槽位');
      let error = null;
      const queued = scheduler.run(async () => 'queued', {}).catch((err) => { error = err; });
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().queued, 1, '第 4 个应排队');
      clock.advance(30001);
      await queued;
      assert(error, '排队超时应报错');
      assertEqual(error.code, 'MODEL_QUEUE_TIMEOUT', '码应为 MODEL_QUEUE_TIMEOUT');
      assertEqual(scheduler.stats().totalTimedOut, 1, 'totalTimedOut=1');
      release();
      const held = await Promise.allSettled(holders);
      scheduler.close();
      assertEqual(held.filter((item) => item.status === 'fulfilled').length, 3, '占槽任务不受影响');
      return { status: 'PASS', observed: { code: error.code, timedOut: 1 }, detail: '排队超时命中 MODEL_QUEUE_TIMEOUT' };
    },
  },
  {
    id: 'A40',
    group: 'A 负例（上游并发）',
    title: '取消排队任务不减少已执行数；取消运行中任务释放槽位可被立即复用',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 第 7 条 / E0-R1a 测试 2',
    expected: '1 慢请求占槽 + 其余排队；取消排队项 → 执行数不增；运行中任务结束后新请求立即拿到槽位',
    async run(ctx) {
      const scheduler = createScheduler(ctx);
      let executed = 0;
      let release = null;
      const hold = new Promise((resolve) => { release = resolve; });
      const holders = [];
      for (let i = 0; i < 3; i += 1) {
        holders.push(scheduler.run(async () => { executed += 1; await hold; return 'h' + i; }));
      }
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().active, 3, '3 个任务应占满槽位');
      const controller = new AbortController();
      const queued = scheduler.run(async () => { executed += 1; return 'queued'; }, { signal: controller.signal });
      await new Promise((r) => setImmediate(r));
      assertEqual(scheduler.stats().queued, 1, '第 4 个任务应排队');
      const beforeQueued = executed;
      let queuedError = null;
      const queuedSettled = queued.catch((error) => { queuedError = error; });
      controller.abort();
      await queuedSettled;
      assertEqual(queuedError.code, 'MODEL_ABORTED', '取消排队项应为 MODEL_ABORTED');
      assertEqual(executed, beforeQueued, '取消排队项不得增加已执行数');
      assertEqual(executed, 3, '只有 3 个占槽任务执行过');
      release();
      await Promise.allSettled(holders);
      const reused = await scheduler.run(async () => { executed += 1; return 'reused'; });
      const stats = scheduler.stats();
      scheduler.close();
      assertEqual(reused, 'reused', '运行中任务结束后槽位应可复用');
      assertEqual(stats.active, 0, '结束后 active=0');
      return { status: 'PASS', observed: { queuedError: queuedError.code, executed, reused: true },
        detail: '取消排队项不增执行数；运行结束槽位可复用' };
    },
  },
  {
    id: 'A41',
    group: 'A 负例（上游并发）',
    title: '429/5xx 重试期间不出现第 4 个并发；重试结束释放槽位',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 第 6 条',
    expected: '每个任务内部“失败→重试”仍只占一个槽位；任意时刻峰值 ≤3；重试结束 active=0',
    async run(ctx) {
      const scheduler = createScheduler(ctx);
      let active = 0;
      let peak = 0;
      let attempts = 0;
      const task = async () => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          attempts += 1;
          await sleep(20);
          if (attempts % 2 === 1) {
            const error = new Error('429');
            error.code = 'DEEPSEEK_RATE_LIMITED';
            throw error;
          }
          return 'ok';
        } finally {
          active -= 1;
        }
      };
      // 重试 = 本次 run 失败并释放槽位后“重新排队”，不在持槽期间再次 run（否则会自我死锁）。
      const runWithRetry = async () => {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await scheduler.run(task, {});
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      };
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => runWithRetry()));
      const stats = scheduler.stats();
      scheduler.close();
      assert(peak <= 3, '重试期间并发峰值必须 ≤3，实际 ' + peak);
      assertEqual(results.filter((item) => item.status === 'fulfilled').length, 5, '5 个任务最终都应成功（重试后）');
      assertEqual(stats.active, 0, '重试结束 active=0');
      assertEqual(stats.queued, 0, '重试结束 queued=0');
      return { status: 'PASS', observed: { peakActive: peak, attempts, totalAcquired: stats.totalAcquired },
        detail: '重试不增并发（峰值 ' + peak + '）且结束后槽位归零' };
    },
  },
  {
    id: 'A42',
    group: 'A 负例（上游并发）',
    title: 'MODEL_MAX_CONCURRENT=4 或非法值 → clamp 到 3 且有可见警告；configure(0) 抛 MODEL_CONFIG_INVALID',
    x: ['X12'],
    requires: SCHEDULER,
    basis: 'rev15 §14.6 第 2 条',
    expected: 'configure(4) → 3 + warnings；configure(0) → MODEL_CONFIG_INVALID；env MODEL_MAX_CONCURRENT=9 → 3 + warning',
    async run(ctx) {
      const mod = ctx.frozen.requireStrict('model-call-scheduler');
      const warnings = [];
      const scheduler = mod.createModelCallScheduler({ globalTokens: false, onWarn: (message) => warnings.push(String(message)) });
      const clamped = scheduler.configure({ maxConcurrent: 4 });
      assertEqual(clamped.maxConcurrent, 3, 'configure(4) 应 clamp 到 3');
      assert(warnings.length > 0, 'clamp 必须有可见警告');
      let invalid = null;
      try { scheduler.configure({ maxConcurrent: 0 }); } catch (error) { invalid = error; }
      assert(invalid, 'configure(0) 应抛错');
      assertEqual(invalid.code, 'MODEL_CONFIG_INVALID', '非法配置码应为 MODEL_CONFIG_INVALID');
      const envWarnings = [];
      const fromEnv = mod.createModelCallScheduler({
        globalTokens: false,
        env: { MODEL_MAX_CONCURRENT: '9' },
        onWarn: (message) => envWarnings.push(String(message)),
      });
      assertEqual(fromEnv.stats().maxConcurrent, 3, 'env=9 应 clamp 到 3');
      assert(envWarnings.length > 0, 'env clamp 必须有可见警告');
      fromEnv.close();
      scheduler.close();
      return { status: 'PASS', observed: { clamped: clamped.maxConcurrent, warnings: warnings.length,
        invalid: invalid.code, envClamped: 3 }, detail: '>3 clamp 到 3 且有警告；非法值显式报错' };
    },
  },

  /* ---------------- A43–A48：图片与视觉（X2） ---------------- */
  {
    id: 'A43',
    group: 'A 负例（图片/视觉）',
    title: '缺图 / 坏图（assetId 不存在、字节被篡改、魔数不符）→ AGENT_IMAGE_INVALID，不降级为文本',
    x: ['X2'],
    requires: IMAGES,
    basis: 'rev15 §14.8-5',
    expected: '三种坏输入都抛出 code=AGENT_IMAGE_INVALID；不返回可用 dataUrl；不经纯文本通道',
    async run(ctx) {
      const runtime = ctx.frozen.requireStrict('agent-runtime');
      const projectId = 'p_a43probe';
      setupProject(ctx, projectId);
      const seeded = seedImageAsset(ctx, projectId);
      const codes = [];
      const probe = (assetId, label) => {
        try {
          runtime.resolveAssetImage({ userDataDir: ctx.temp.real, projectId, assetId });
          throw new Error(label + '：应被拒绝但没有抛错');
        } catch (error) {
          codes.push(error && error.code);
          assertEqual(error && error.code, 'AGENT_IMAGE_INVALID', label + '：码应为 AGENT_IMAGE_INVALID');
        }
      };
      probe('a_0000000000000000', '不存在的 assetId');
      const assetFile = path.join(ctx.temp.real, 'projects', projectId, 'assets', 'images',
        fs.readdirSync(path.join(ctx.temp.real, 'projects', projectId, 'assets', 'images'))[0]);
      const original = fs.readFileSync(assetFile);
      fs.writeFileSync(assetFile, Buffer.concat([original, Buffer.from([0, 1, 2])]));
      probe(seeded.assetId, '字节与登记摘要不一致');
      fs.writeFileSync(assetFile, original);
      // 魔数不符：把资产文件替换成 GIF 头，同时把 project.json 的 sha/bytes 改成新内容（只骗过摘要）。
      const gif = Buffer.from('GIF89a' + 'A'.repeat(64), 'binary');
      const projectFile = path.join(ctx.temp.real, 'projects', projectId, 'project.json');
      const doc = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      const image = doc.assets.images.find((item) => item.assetId === seeded.assetId);
      fs.writeFileSync(assetFile, gif);
      image.bytes = gif.length;
      image.sha256 = 'sha256:' + sha256(gif);
      fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
      probe(seeded.assetId, 'GIF 魔数伪装 PNG');
      return { status: 'PASS', observed: { codes }, detail: '缺图/篡改/魔数不符都 AGENT_IMAGE_INVALID' };
    },
  },
  {
    id: 'A44',
    group: 'A 负例（图片/视觉）',
    title: '单张图 > 2 MiB → AGENT_IMAGE_INVALID（按真实字节判定，不裁剪不压缩）',
    x: ['X2'],
    requires: IMAGES,
    basis: 'rev15 §14.8-3',
    expected: '登记并落盘 >2 MiB 文件后 resolveAssetImage 抛 AGENT_IMAGE_INVALID；不返回 dataUrl',
    async run(ctx) {
      const runtime = ctx.frozen.requireStrict('agent-runtime');
      const projectId = 'p_a44probe';
      setupProject(ctx, projectId);
      seedImageAsset(ctx, projectId);
      const big = Buffer.alloc(runtime.MAX_IMAGE_BYTES + 1, 0);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big, 0);
      const digest = sha256(big);
      const fileName = digest.slice(0, 16) + '.png';
      const assetId = 'a_' + digest.slice(0, 16);
      const imagesDir = path.join(ctx.temp.real, 'projects', projectId, 'assets', 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, fileName), big);
      const projectFile = path.join(ctx.temp.real, 'projects', projectId, 'project.json');
      const doc = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
      images.push({ assetId, fileName, originalName: 'big.png', mime: 'image/png', bytes: big.length, sha256: 'sha256:' + digest });
      doc.assets = { ...(doc.assets || {}), images };
      fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
      let thrown = null;
      try { runtime.resolveAssetImage({ userDataDir: ctx.temp.real, projectId, assetId }); } catch (error) { thrown = error; }
      assert(thrown, '>2 MiB 应被拒绝');
      assertEqual(thrown.code, 'AGENT_IMAGE_INVALID', '码应为 AGENT_IMAGE_INVALID');
      assert(/KiB|MiB|字节|大小|too large|exceed/i.test(thrown.message), '错误信息应说明超限，实际 ' + thrown.message);
      return { status: 'PASS', observed: { bytes: big.length, max: runtime.MAX_IMAGE_BYTES, code: thrown.code },
        detail: '>2 MiB 被拒（未裁剪/压缩）' };
    },
  },
  {
    id: 'A45',
    group: 'A 负例（图片/视觉）',
    title: '非 PNG/JPEG/WebP（GIF/BMP/SVG/伪装扩展名）→ AGENT_IMAGE_INVALID（魔数 + MIME 双检）',
    x: ['X2'],
    requires: IMAGES,
    basis: 'rev15 §14.8-3',
    expected: 'GIF/BMP/SVG 内容即使登记为 image/png 且摘要匹配，也必须 AGENT_IMAGE_INVALID',
    async run(ctx) {
      const runtime = ctx.frozen.requireStrict('agent-runtime');
      const projectId = 'p_a45probe';
      setupProject(ctx, projectId);
      seedImageAsset(ctx, projectId);
      const imagesDir = path.join(ctx.temp.real, 'projects', projectId, 'assets', 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      const projectFile = path.join(ctx.temp.real, 'projects', projectId, 'project.json');
      const doc = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      const images = Array.isArray(doc.assets && doc.assets.images) ? doc.assets.images : [];
      const payloads = {
        gif: Buffer.from('GIF89a' + 'A'.repeat(32), 'binary'),
        bmp: Buffer.from('BM' + 'B'.repeat(64), 'binary'),
        svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8'),
      };
      const codes = [];
      for (const [kind, buffer] of Object.entries(payloads)) {
        const digest = sha256(buffer);
        const fileName = digest.slice(0, 16) + '.png';
        const assetId = 'a_' + digest.slice(0, 16);
        fs.writeFileSync(path.join(imagesDir, fileName), buffer);
        images.push({ assetId, fileName, originalName: kind + '.png', mime: 'image/png', bytes: buffer.length, sha256: 'sha256:' + digest });
        // 每次解析前都先把登记写回 project.json，否则失败原因会变成“资产未登记”。
        doc.assets = { ...(doc.assets || {}), images };
        fs.writeFileSync(projectFile, JSON.stringify(doc, null, 2), 'utf8');
        try {
          runtime.resolveAssetImage({ userDataDir: ctx.temp.real, projectId, assetId });
          throw new Error(kind + '：应被拒绝');
        } catch (error) {
          assertEqual(error && error.code, 'AGENT_IMAGE_INVALID', kind + ' 应按 AGENT_IMAGE_INVALID 拒绝');
          codes.push(kind + ':' + error.code);
        }
      }
      return { status: 'PASS', observed: { codes }, detail: 'GIF/BMP/SVG 伪装 .png 全部拒绝' };
    },
  },
  {
    id: 'A46',
    group: 'A 负例（图片/视觉）',
    title: '输入为路径 / base64 / data URL（而非 assetId）→ 拒绝，且不读取该路径',
    x: ['X2'],
    requires: IMAGES,
    basis: 'rev15 §14.8-1',
    expected: '三种输入都 AGENT_IMAGE_INVALID；被指向的路径不被读取（文件不存在/未创建也能拒绝）',
    async run(ctx) {
      const runtime = ctx.frozen.requireStrict('agent-runtime');
      const projectId = 'p_a46probe';
      setupProject(ctx, projectId);
      const missing = path.join(ctx.temp.real, 'do-not-read.png');
      const inputs = [missing, 'QWJD', 'data:image/png;base64,iVBORw0KGgo='];
      const codes = [];
      for (const value of inputs) {
        let thrown = null;
        try { runtime.resolveAssetImage({ userDataDir: ctx.temp.real, projectId, assetId: value }); } catch (error) { thrown = error; }
        assert(thrown, '非 assetId 输入应被拒绝：' + value);
        assertEqual(thrown.code, 'AGENT_IMAGE_INVALID', '码应为 AGENT_IMAGE_INVALID');
        codes.push(thrown.code);
      }
      assert(!fs.existsSync(missing), '不得因输入路径而创建/读取文件');
      return { status: 'PASS', observed: { codes, pathTouched: false }, detail: '路径/base64/data URL 都被拒绝，未读路径' };
    },
  },
  {
    id: 'A47',
    group: 'A 负例（图片/视觉）',
    title: '模型无视觉能力 → AGENT_VISION_UNAVAILABLE / needs_input，0 次上游调用（不静默退化）',
    x: ['X2'],
    requires: RUNTIME,
    basis: 'rev15 §14.8-5',
    expected: 'runtime vision:false + request.images=[assetId] → ok:false + AGENT_VISION_UNAVAILABLE；fake 上游调用 0 次；不写工作树',
    async run(ctx) {
      const projectId = 'p_a47probe';
      const project = setupProject(ctx, projectId);
      const asset = seedImageAsset(ctx, projectId);
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, projectId);
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf(projectId, run);
      const paths = attemptPaths(project, run);
      const before = ctx.env.fingerprintDir(paths.candidateDir);
      const fake = fakeModel(ctx, async () => ({ content: '不应被调用', finishReason: 'stop', toolCalls: [] }));
      const runtime = createRuntime(ctx, coord, fake.modelChat, { vision: false });
      const result = await runtime.invoke({
        context: handle, request: { utterance: '看图改菜单', images: [asset.assetId], profile: 'chat' },
      });
      assert(result.ok === false, '无视觉能力不得成功');
      assertEqual(result.code, 'AGENT_VISION_UNAVAILABLE', '码应为 AGENT_VISION_UNAVAILABLE');
      assertEqual(fake.calls.length, 0, '视觉不可用时上游调用必须为 0');
      assertEqual(ctx.env.fingerprintDir(paths.candidateDir).digest, before.digest, '不得写工作树');
      return { status: 'PASS', observed: { code: result.code, upstreamCalls: 0 }, detail: '视觉不可用显式失败，零上游调用' };
    },
  },
  {
    id: 'A48',
    group: 'A 负例（图片/视觉）',
    title: '跑完一轮带图调用后扫描 runs/**、trace、结果：不得出现 data:image / 长 base64 / prompt 原文 / Key',
    x: ['X2'],
    requires: IMAGES,
    basis: 'rev15 §14.8-4',
    expected: '真实图片只在内存：结果与磁盘上的 attempt.json/run.json/trace/checks 文件都不含 "data:image"、长 base64 或密钥；'
      + '结果只暴露 {assetId,mime,bytes,sha256}',
    async run(ctx) {
      const projectId = 'p_a48probe';
      const project = setupProject(ctx, projectId);
      const asset = seedImageAsset(ctx, projectId);
      const coord = newCoordinator(ctx, { checks: realRegistry(ctx) });
      const run = startRun(coord, projectId);
      assert(run.ok === true, 'startRun 失败');
      const handle = handleOf(projectId, run);
      const fake = fakeModel(ctx, async () => ({ model: 'fake-upstream', content: '看到红蓝两色。', finishReason: 'stop', toolCalls: [] }));
      const runtime = createRuntime(ctx, coord, fake.modelChat, { vision: true });
      const result = await runtime.invoke({
        context: handle, request: { utterance: '这张参考图有哪些颜色？', images: [asset.assetId], profile: 'chat' },
      });
      assert(result.ok === true, '带图调用应成功：' + JSON.stringify(result.code));
      assertEqual(result.data.multimodal, true, '结果应标记 multimodal');
      assertEqual(result.data.images.length, 1, '结果应只回图片元数据');
      assertEqual(result.data.images[0].sha256, asset.sha256, '结果 sha256 应等于原图');
      const serialized = JSON.stringify(result);
      assert(!serialized.includes('data:image'), '结果不得含 data:image');
      assert(!/[A-Za-z0-9+/]{200,}={0,2}/.test(serialized), '结果不得含长 base64');
      assert(!/sk-[A-Za-z0-9]{8}/.test(serialized), '结果不得含 Key');
      const runRoot = path.join(project.paths.workspaceDir, 'runs', run.runId);
      const offenders = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(file); continue; }
          if (!entry.isFile()) continue;
          const text = fs.readFileSync(file, 'latin1');
          if (text.includes('data:image') || /[A-Za-z0-9+/]{200,}={0,2}/.test(text) || /sk-[A-Za-z0-9]{8}/.test(text)) {
            offenders.push(path.relative(runRoot, file).split(path.sep).join('/'));
          }
        }
      };
      walk(runRoot);
      assertEqual(offenders.length, 0, '落盘文件不得含 data URL/长 base64/Key：' + JSON.stringify(offenders.slice(0, 5)));
      return { status: 'PASS', observed: { images: result.data.images, offenders: [], multimodal: true },
        detail: '图片只在内存：结果与落盘文件均无 data URL/长 base64/Key' };
    },
  },
];

module.exports = { CASES };
