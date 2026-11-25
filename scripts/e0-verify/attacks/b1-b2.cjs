'use strict';

/**
 * A 组（可执行部分）：针对**已冻结且已复核**的 B1/B2 模块的负例。
 *
 * 这些用例今天就能真跑（不依赖 Coordinator），用于证明：
 *  - 伪造句柄 / 路径越界 / 摘要冲突 → 拒绝且零落盘；
 *  - 重开与导出身份漂移 → fail-closed，不回落 Base。
 * 它们只覆盖 A16–A20、A23、A24、A25；其余 A 组负例需要 E0 新接口，见 `attacks/e0.cjs`。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assert, assertEqual, assertRejected, blocked } = require('../lib/harness.cjs');
const { openProject } = require('../chains/preconditions.cjs');

const B1_B2_REQUIRES = ['workspace', 'files', 'manifest', 'versions'];

const PATH_REJECT_CODES = [
  'AGENT_PATH_INVALID', 'AGENT_PATH_ESCAPE', 'AGENT_PATH_LINK', 'AGENT_PATH_PROTECTED',
  'AGENT_WORKSPACE_INVALID', 'AGENT_ARGUMENT_INVALID', 'AGENT_PATCH_REJECTED',
];

/** 递归收集目录内文件名（用于“零落盘/无越界文件”断言）。 */
function collectNames(dir, acc) {
  const names = acc || [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    names.push(entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) collectNames(path.join(dir, entry.name), names);
  }
  return names;
}

function setupAttempt(ctx, projectId, runId) {
  const project = openProject(ctx, projectId);
  const created = project.workspace.createAttempt(project.ws, {
    runId, turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
  });
  assert(created.ok, 'createAttempt 失败：' + JSON.stringify({ code: created.code, message: created.message }));
  const workspacePaths = project.workspace.workspacePaths({ userDataDir: ctx.temp.real, projectId });
  assert(workspacePaths.ok, 'workspacePaths 失败');
  return { project, attempt: created.attempt, paths: workspacePaths };
}

const CASES = [
  {
    id: 'A16',
    group: 'A 负例（句柄/路径/越权）',
    title: '伪造 attempt 句柄指向 versions/<id>/source → 拒绝且零落盘',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev4 §2.7 F1（assertAttemptHandle 单实现）',
    expected: '写入被拒（AGENT_WORKSPACE_INVALID / AGENT_PATH_* 之一），被伪造指向的 versions/v1 指纹前后一致',
    run(ctx) {
      const { project, attempt, paths } = setupAttempt(ctx, 'e0v1-a16', 'frun-e0v1a16');
      const v1Dir = path.join(paths.versionsDir, 'v1');
      const before = ctx.env.fingerprintDir(v1Dir);
      const forged = Object.assign({}, attempt, {
        candidateDir: path.join(v1Dir, 'source'),
        attemptDir: v1Dir,
        verificationDir: path.join(v1Dir, 'verification'),
      });
      const result = project.files.writeFile(forged, { path: 'app.json', content: '{"pages":[]}\n' });
      assertRejected(result, PATH_REJECT_CODES.concat(['AGENT_ID_INVALID']), '伪造句柄写入未被拒绝');
      const after = ctx.env.fingerprintDir(v1Dir);
      assertEqual(after.digest, before.digest, '伪造句柄写入改动了已采用版本（非零落盘）');
      return { observed: { code: result.code }, detail: '伪造句柄被拒且 versions/v1 指纹不变' };
    },
  },
  {
    id: 'A17',
    group: 'A 负例（句柄/路径/越权）',
    title: '相对路径越界（../ 与 sub/../../）→ AGENT_PATH_INVALID 且不产生越界文件',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev3 §1.5-1',
    expected: '两次写入都被参数类错误拒绝；临时私有根内没有出现 escape-probe.txt',
    run(ctx) {
      const { project, attempt } = setupAttempt(ctx, 'e0v1-a17', 'frun-e0v1a17');
      const first = project.files.writeFile(attempt, { path: '../escape-probe.txt', content: 'x' });
      assertRejected(first, PATH_REJECT_CODES, '../ 越界未被拒绝');
      const second = project.files.writeFile(attempt, { path: 'pages/../../escape-probe.txt', content: 'x' });
      assertRejected(second, PATH_REJECT_CODES, 'sub/../../ 越界未被拒绝');
      const names = collectNames(ctx.temp.real, []);
      assert(!names.includes('escape-probe.txt'), '越界文件名出现在临时私有根内（非零落盘）');
      return { observed: { codes: [first.code, second.code] }, detail: '路径越界被拒且无越界产物' };
    },
  },
  {
    id: 'A18',
    group: 'A 负例（句柄/路径/越权）',
    title: '绝对路径 / 盘符 / UNC → AGENT_PATH_INVALID',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev3 §1.5-1',
    expected: '三种输入（C:/…、/etc/…、\\\\server\\share\\…）全部拒绝',
    run(ctx) {
      const { project, attempt } = setupAttempt(ctx, 'e0v1-a18', 'frun-e0v1a18');
      const inputs = ['C:/Windows/win.ini', '/etc/passwd', '\\\\server\\share\\x.txt'];
      const codes = [];
      for (const input of inputs) {
        const result = project.files.writeFile(attempt, { path: input, content: 'x' });
        assertRejected(result, PATH_REJECT_CODES, '绝对/盘符/UNC 路径未被拒绝：' + input);
        codes.push(result.code);
      }
      return { observed: { codes }, detail: '绝对路径族全部拒绝' };
    },
  },
  {
    id: 'A19',
    group: 'A 负例（句柄/路径/越权）',
    title: 'expectedBaseSha256 冲突 → AGENT_BASE_DIGEST_MISMATCH 且不落盘',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev3 §1.5-4',
    expected: '带错摘要的写入被拒；文件内容与摘要保持不变',
    run(ctx) {
      const { project, attempt } = setupAttempt(ctx, 'e0v1-a19', 'frun-e0v1a19');
      const seed = project.files.writeFile(attempt, { path: 'pages/menu/index.wxml', content: 'seed\n' });
      assert(seed.ok, '种子写入失败：' + JSON.stringify(seed.code));
      const before = project.files.readFile(attempt, { path: 'pages/menu/index.wxml' });
      const beforeContent = before.content !== undefined ? before.content : (before.data && before.data.content);
      const conflicted = project.files.writeFile(attempt, {
        path: 'pages/menu/index.wxml',
        content: 'overwrite\n',
        expectedBaseSha256: 'sha256:' + '0'.repeat(64),
      });
      assertRejected(conflicted, ['AGENT_BASE_DIGEST_MISMATCH', 'AGENT_TXN_ABORTED'], '摘要冲突未被拒绝');
      const after = project.files.readFile(attempt, { path: 'pages/menu/index.wxml' });
      const afterContent = after.content !== undefined ? after.content : (after.data && after.data.content);
      assertEqual(afterContent, beforeContent, '摘要冲突后文件被改写（非零落盘）');
      return { observed: { code: conflicted.code }, detail: '摘要冲突 fail-closed' };
    },
  },
  {
    id: 'A20',
    group: 'A 负例（句柄/路径/越权）',
    title: '非法 runId（frun-../../x）→ AGENT_ID_INVALID 且不建目录',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev3 §1.3（RUN_ID_PATTERN）',
    expected: 'createAttempt 被拒；runs/ 下没有越界目录',
    run(ctx) {
      const project = openProject(ctx, 'e0v1-a20');
      const paths = project.workspace.workspacePaths({ userDataDir: ctx.temp.real, projectId: 'e0v1-a20' });
      assert(paths.ok, 'workspacePaths 失败');
      const runsBefore = collectNames(paths.runsDir, []);
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-../../x', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assertRejected(created, ['AGENT_ID_INVALID', 'AGENT_ARGUMENT_INVALID'], '非法 runId 未被拒绝');
      const runsAfter = collectNames(paths.runsDir, []);
      assertEqual(runsAfter.length, runsBefore.length, '非法 runId 产生了目录（非零落盘）');
      return { observed: { code: created.code }, detail: '非法 id fail-closed' };
    },
  },
  {
    id: 'A23',
    group: 'A 负例（句柄/路径/越权）',
    title: 'candidate 内符号链接/junction 逃逸 → AGENT_PATH_LINK（环境不允许则 BLOCKED）',
    x: ['X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev3 §1.5-2',
    expected: '通过链接读到/写到工作树外的一切尝试都被拒绝；沙箱禁止创建链接时记 BLOCKED（不得记 PASS）',
    run(ctx) {
      const { project, attempt } = setupAttempt(ctx, 'e0v1-a23', 'frun-e0v1a23');
      const outside = fs.mkdtempSync(path.join(ctx.env.realpathOrNull(os.tmpdir()), 'dsh-e0v1-outside-'));
      try {
        const linkPath = path.join(attempt.candidateDir, 'link-out');
        try {
          fs.symlinkSync(outside, linkPath, 'junction');
        } catch (error) {
          throw blocked('无法创建符号链接/junction（沙箱限制）：' + (error && error.code));
        }
        const readAttempt = project.files.readFile(attempt, { path: 'link-out/secret.txt' });
        assertRejected(readAttempt, PATH_REJECT_CODES, '通过链接读取未被拒绝');
        const writeAttempt = project.files.writeFile(attempt, { path: 'link-out/secret.txt', content: 'x' });
        assertRejected(writeAttempt, PATH_REJECT_CODES, '通过链接写入未被拒绝');
        assert(!fs.existsSync(path.join(outside, 'secret.txt')), '链接逃逸导致工作树外落盘');
        return { observed: { codes: [readAttempt.code, writeAttempt.code] }, detail: '链接逃逸被拒' };
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'A11O',
    group: 'A 负例（检查目标）',
    title: '观察（t5 后）：direct 调用缺平台派生根时先拒，不再回落仓库/已采用版本源码',
    x: ['X4'],
    requires: ['checks', 'workspace'],
    basis: 'rev15 §14.4（checkId→subject 平台表；root 只由平台填）+ §14.12-5（t5 前的 A11O 缺陷登记）',
    expected: '直接调注册表、**不传平台派生根**时：source.check / composer.dry-run 一律先拒（AGENT_CHECK_UNKNOWN）'
      + '且 runner 0 次调用；即 t5 前“source.check 不带 --root 查仓库、composer.dry-run 查已采用版本 source”的行为已消失。'
      + 'A11O 只登记这一事实，不再单独判 X4；X4 绑定由 W01–W04（attempt 主体 + 派生导出树）复核。',
    async run(ctx) {
      const project = openProject(ctx, 'e0v1-a11o');
      const created = project.workspace.createAttempt(project.ws, {
        runId: 'frun-e0v1a11o', turnId: 'turn-1', source: { kind: 'version', versionId: 'v1' },
      });
      assert(created.ok, 'createAttempt 失败：' + JSON.stringify(created.code));
      const checks = ctx.frozen.requireStrict('checks');
      let runnerCalls = 0;
      const registry = checks.createCheckRegistry({
        userDataDir: ctx.temp.real,
        runner: async () => {
          runnerCalls += 1;
          return { ok: true, stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 1 };
        },
      });

      const observedChecks = [];
      for (const checkId of ['source.check', 'composer.dry-run']) {
        const result = await registry.runCheck({ projectId: project.projectId, checkId, params: { timeoutMs: 1000 } });
        assert(result && result.ok === false,
          checkId + ' 缺平台派生根仍被执行（t5 前的回落行为回来了）：' + JSON.stringify(result && result.status));
        assertEqual(result.code, 'AGENT_CHECK_UNKNOWN', checkId + ' 缺根应以 AGENT_CHECK_UNKNOWN 先拒');
        observedChecks.push({ checkId, rejectedCode: result.code, reason: result.message || null });
      }
      assertEqual(runnerCalls, 0, '缺平台派生根时必须先拒后跑（runner 调用 0 次，§14.13-F2），实际 ' + runnerCalls + ' 次');

      const definitions = checks.CHECK_DEFINITIONS || {};
      return {
        status: 'PASS',
        observed: {
          checks: observedChecks,
          runnerCalls,
          subjects: {
            sourceCheck: definitions['source.check'] && definitions['source.check'].subject,
            composerDryRun: definitions['composer.dry-run'] && definitions['composer.dry-run'].subject,
            capabilitiesCheck: definitions['capabilities.check'] && definitions['capabilities.check'].subject,
          },
          checkIds: Array.isArray(checks.CHECK_IDS) ? checks.CHECK_IDS.slice() : [],
          hasCapabilitiesCheck: Array.isArray(checks.CHECK_IDS) && checks.CHECK_IDS.includes('capabilities.check'),
        },
        detail: '缺平台派生根一律先拒（runner 0 次），t5 前的仓库/已采用版本回落行为不再存在；X4 绑定证据见 W01–W04',
      };
    },
  },
  {
    id: 'A13',
    group: 'A 负例（检查目标）',
    title: '模型在 run_check 里传 root/path/command/env 等参数 → AGENT_PAYLOAD_INVALID',
    x: ['X4'],
    requires: ['checks'],
    basis: 'rev15 §14.4 参数白名单（root/attempt/versionId 由平台填）',
    expected: 'runCheck 返回 ok:false + AGENT_PAYLOAD_INVALID；不触发任何子进程执行',
    async run(ctx) {
      const checks = ctx.frozen.requireStrict('checks');
      let runnerCalls = 0;
      const registry = checks.createCheckRegistry({
        userDataDir: ctx.temp.real,
        runner: async () => { runnerCalls += 1; return { ok: true, stdout: '{}', stderr: '', durationMs: 1 }; },
      });
      const payloads = [
        { root: 'C:/Windows' },
        { path: 'miniprogram' },
        { command: 'node -v' },
        { shell: 'cmd.exe' },
        { cwd: '../' },
        { env: { X: '1' } },
      ];
      const codes = [];
      for (const params of payloads) {
        const result = await registry.runCheck({ projectId: 'e0v1-a13', checkId: 'source.check', params });
        assert(result && result.ok === false, '参数未被拒绝：' + JSON.stringify(params));
        assertEqual(result.code, 'AGENT_PAYLOAD_INVALID', '拒绝码应为 AGENT_PAYLOAD_INVALID');
        codes.push(result.code);
      }
      assertEqual(runnerCalls, 0, '被拒绝的参数仍触发了子进程执行');
      return { observed: { rejected: codes.length, runnerCalls }, detail: '路径/命令类参数全部拒绝' };
    },
  },
  {
    id: 'A14',
    group: 'A 负例（检查目标）',
    title: '未知 checkId（模型自造检查名）→ AGENT_CHECK_UNKNOWN',
    x: ['X4'],
    requires: ['checks'],
    basis: 'rev3 §3.5 / rev10 §3.8（只接受注册 checkId）',
    expected: 'runCheck 返回 AGENT_CHECK_UNKNOWN；不得回落到“等价命令”或任意脚本',
    async run(ctx) {
      const checks = ctx.frozen.requireStrict('checks');
      let runnerCalls = 0;
      const registry = checks.createCheckRegistry({
        userDataDir: ctx.temp.real,
        runner: async () => { runnerCalls += 1; return { ok: true, stdout: '{}', stderr: '', durationMs: 1 }; },
      });
      const codes = [];
      for (const checkId of ['source.check ', 'source-check', 'composer.dryrun', 'shell', '../scripts/x.cjs']) {
        const result = await registry.runCheck({ projectId: 'e0v1-a14', checkId, params: {} });
        assert(result && result.ok === false, '未知 checkId 未拒绝：' + checkId);
        assertEqual(result.code, 'AGENT_CHECK_UNKNOWN', '拒绝码应为 AGENT_CHECK_UNKNOWN');
        codes.push(result.code);
      }
      assertEqual(runnerCalls, 0, '未知 checkId 触发了子进程执行');
      return { observed: { rejected: codes.length }, detail: '未知 checkId 全部拒绝' };
    },
  },
  {
    id: 'A21O',
    group: 'A 负例（句柄/路径/越权）',
    title: '观察：B1 文件/事务只校验目录布局，不校验 handle.projectId 与私有根一致',
    x: ['X1', 'X3'],
    requires: B1_B2_REQUIRES,
    basis: 'rev15 §14.2 不变量 5 + §14.12-2（B1 只校验布局，跨项目拒绝由 Coordinator 承担，不因此判 FAIL）',
    expected: 'E0 期望：Coordinator 层必须拒绝伪造 projectId 的句柄（AGENT_PROJECT_MISMATCH，零落盘）；'
      + 'B1 直调属非产品链，本条只登记观察，不判 FAIL。当前观察：改写 handle.projectId 后写入仍落在原项目 attempt 树',
    run(ctx) {
      const { project, attempt } = setupAttempt(ctx, 'e0v1-a21o', 'frun-e0v1a21o');
      const forged = Object.assign({}, attempt, { projectId: 'e0v1-a21o-other' });
      const result = project.files.writeFile(forged, { path: 'pages/menu/index.wxml', content: 'projectid-probe\n' });
      const accepted = Boolean(result && result.ok === true);
      return {
        status: 'NOT_RUN',
        observed: {
          acceptedWithMismatchedProjectId: accepted,
          note: 'B1 层按布局与 candidateDir 判定归属；projectId 一致性由 Coordinator.assertAttemptHandle 负责（t1）',
        },
        detail: accepted
          ? 'B1 直调仍写入（非产品链；按 rev15 §14.12-2 由 Coordinator 层拒绝，本条不判 FAIL）'
          : 'B1 已拒绝 projectId 不一致的句柄',
      };
    },
  },
  {
    id: 'A24',
    group: 'A 负例（重开/导出身份）',
    title: '当前版本 source 被篡改 → AGENT_VERSION_CONFLICT 且不回退 Base',
    x: ['X11'],
    requires: B1_B2_REQUIRES,
    basis: 'B2 §2.2 重开 fail-closed',
    expected: 'reopen 返回 AGENT_VERSION_CONFLICT；currentVersionId 仍为 v1（不回落 Base、不静默采用磁盘内容）',
    run(ctx) {
      const { project, paths } = setupAttempt(ctx, 'e0v1-a24', 'frun-e0v1a24');
      const target = path.join(paths.versionsDir, 'v1', 'source', 'app.json');
      const original = fs.readFileSync(target, 'utf8');
      try {
        fs.writeFileSync(target, original.replace('}', ',"__tampered":true}'), 'utf8');
        const reopened = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: project.projectId });
        assertRejected(reopened, ['AGENT_VERSION_CONFLICT', 'AGENT_EXPORT_IDENTITY_MISMATCH'], '篡改后重开未 fail-closed');
        const state = project.versions.readProjectState({ userDataDir: ctx.temp.real, projectId: project.projectId });
        assertEqual(state.state.currentVersionId, 'v1', '重开失败后指针被改写（疑似回落 Base）');
        return { observed: { code: reopened.code, currentVersionId: 'v1' }, detail: '重开漂移 fail-closed' };
      } finally {
        fs.writeFileSync(target, original, 'utf8');
        const restored = project.versions.reopenProject({ userDataDir: ctx.temp.real, projectId: project.projectId });
        assert(restored.ok, '恢复文件后 reopen 仍失败（fail-closed 过度）');
      }
    },
  },
  {
    id: 'A25',
    group: 'A 负例（重开/导出身份）',
    title: '导出身份漂移 → AGENT_EXPORT_IDENTITY_MISMATCH（不清洗摘要、不回落 Base）',
    x: ['X7'],
    requires: B1_B2_REQUIRES,
    basis: 'B2 §2.4 导出身份',
    expected: '篡改当前版本 source 后 verifyExportIdentity 失败且不给导出根；恢复后重新 PASS',
    run(ctx) {
      const { project, paths } = setupAttempt(ctx, 'e0v1-a25', 'frun-e0v1a25');
      const identityOk = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: project.projectId });
      assert(identityOk.ok, '前置：干净状态导出身份应 PASS：' + JSON.stringify(identityOk.code));
      const target = path.join(paths.versionsDir, 'v1', 'source', 'app.json');
      const original = fs.readFileSync(target, 'utf8');
      try {
        fs.writeFileSync(target, original + '\n', 'utf8');
        const drift = project.versions.verifyExportIdentity({ userDataDir: ctx.temp.real, projectId: project.projectId });
        assertRejected(drift, ['AGENT_EXPORT_IDENTITY_MISMATCH', 'AGENT_VERSION_CONFLICT'], '导出身份漂移未被拒绝');
        return { observed: { code: drift.code }, detail: '导出身份 fail-closed' };
      } finally {
        fs.writeFileSync(target, original, 'utf8');
      }
    },
  },
];

module.exports = { CASES };
