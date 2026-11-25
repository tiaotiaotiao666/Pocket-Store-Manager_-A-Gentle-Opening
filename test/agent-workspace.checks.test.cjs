'use strict';

/**
 * B4：验证注册表（desktop/agent-workspace/checks.cjs）。
 *
 * 覆盖：10 个 checkId 注册表完整性、未知 id、参数白名单（禁 command/env/shell/cwd/绝对路径）、
 * 固定脚本映射（dispatcher + 既有脚本）、PASS/FAIL/BLOCKED/NOT_RUN、issues 有界脱敏、
 * wechat.verify 固定包装与 BLOCKED 语义。
 *
 * 本文件不 spawn 子进程：全部通过注入 fake runner（沙箱 npm spawn EPERM）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./agent-workspace.helpers.cjs');

const REPO = h.REPO;
const checksMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'));
const versionsMod = require(path.join(REPO, 'desktop', 'agent-workspace', 'versions.cjs'));

const PROJECT_ID = 'p_b4check01';
const FROZEN_IDS = [
  'source.check', 'mini.check', 'composer.dry-run', 'output.consistency',
  'unit.targeted', 'unit.full', 'desktop.contract', 'catalog.check',
  'registry.check', 'wechat.verify',
];

function tempUserData(t) {
  return h.userDataWith(t, 'b4');
}

function initProject(userDataDir) {
  const init = versionsMod.initProject({ userDataDir, projectId: PROJECT_ID });
  assert.strictEqual(init.ok, true, JSON.stringify(init));
  return init;
}

function fakeRunner(handler) {
  const calls = [];
  return {
    calls,
    runner: async (request) => {
      calls.push(request);
      if (typeof handler === 'function') return handler(request, calls.length);
      return { ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 3 };
    },
  };
}

function registry(extra) {
  return checksMod.createCheckRegistry(Object.assign({}, extra));
}

test('注册表：冻结 10 个 checkId，映射完整且每个脚本真实存在；未知 id → AGENT_CHECK_UNKNOWN', () => {
  assert.deepStrictEqual([...checksMod.CHECK_IDS], FROZEN_IDS);
  const listed = registry().listChecks();
  assert.strictEqual(listed.length, 10);
  assert.deepStrictEqual(listed.map((item) => item.checkId), FROZEN_IDS);
  for (const item of listed) {
    assert.strictEqual(typeof item.description, 'string');
    assert.ok(Array.isArray(item.params) && item.params.length > 0);
    assert.ok(item.params.includes('timeoutMs'));
  }
  assert.strictEqual(checksMod.assertFixedMapping(), true);
  assert.strictEqual(checksMod.CHECK_DEFINITIONS['wechat.verify'].script, 'scripts/wechat-devtools-run.cjs');
  for (const id of FROZEN_IDS) {
    assert.ok(fs.existsSync(path.join(REPO, checksMod.CHECK_DEFINITIONS[id].script)), id + ' 脚本不存在');
  }

  return registry().runCheck({ checkId: 'evil.command' }).then((result) => {
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, checksMod.CODES.CHECK_UNKNOWN);
  });
});

test('固定映射：只调用 dispatcher + 固定参数，不接受调用方命令；scoped 检查用派生版本 source', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const { runner, calls } = fakeRunner();
  const reg = registry({ userDataDir, runner });

  for (const checkId of FROZEN_IDS) {
    const result = await reg.runCheck({ checkId, projectId: PROJECT_ID, attemptId: 'attempt-1' });
    assert.strictEqual(result.ok, true, checkId + ' ' + JSON.stringify(result));
    assert.strictEqual(result.status, 'PASS', checkId);
  }
  assert.strictEqual(calls.length, FROZEN_IDS.length);
  for (const [index, checkId] of FROZEN_IDS.entries()) {
    const request = calls[index];
    assert.strictEqual(request.command, process.execPath);
    assert.strictEqual(path.resolve(request.args[0]), checksMod.dispatcherPath);
    assert.strictEqual(request.args[1], '--check');
    assert.strictEqual(request.args[2], checkId);
    assert.strictEqual(request.cwd, REPO);
    assert.ok(!Object.prototype.hasOwnProperty.call(request, 'shell'));
    for (const arg of request.args) {
      assert.ok(typeof arg === 'string' && !/[\u0000-\u001f]/.test(arg), 'argv 不得含控制字符');
    }
    const scoped = checksMod.CHECK_DEFINITIONS[checkId].scoped;
    const rootIndex = request.args.indexOf('--root');
    if (scoped) {
      assert.ok(rootIndex > 0, checkId + ' 必须带派生 root');
      const root = request.args[rootIndex + 1];
      assert.ok(path.isAbsolute(root));
      assert.ok(root.includes(path.join('agent-workspace', 'versions', 'v1', 'source')), root);
    } else {
      assert.strictEqual(rootIndex, -1, checkId + ' 不应带 root');
    }
    if (checkId === 'unit.targeted') {
      assert.ok(request.args.includes('--target'));
    }
  }
});

test('参数白名单：拒绝 command/env/shell/cwd/绝对路径/未知键/非法值，错误码 AGENT_PAYLOAD_INVALID', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const { runner, calls } = fakeRunner();
  const reg = registry({ userDataDir, runner });

  const badParams = [
    { command: 'rm -rf /' },
    { env: { A: '1' } },
    { shell: true },
    { cwd: 'C:\\Windows' },
    { path: '../escape' },
    { dir: 'test' },
    { unknown: 1 },
    { timeoutMs: 10 },
    { timeoutMs: 999999 },
    { timeoutMs: '1000' },
    { targetFiles: ['test/evil.test.cjs'] },
    { targetFiles: 'test/desktop-contract.test.cjs' },
    { targetFiles: ['C:/abs.test.cjs'] },
    { appId: 'wxnothex' },
    { nested: { a: 1 } },
    { value: '/etc/passwd' },
  ];
  for (const params of badParams) {
    const result = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID, params });
    assert.strictEqual(result.ok, false, JSON.stringify(params));
    assert.strictEqual(result.code, checksMod.CODES.PAYLOAD_INVALID, JSON.stringify(params));
  }
  // appId 只对 wechat.verify 合法；对 source.check 是未知键。
  const appIdOnSource = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID, params: { appId: 'wx1234567890abcdef' } });
  assert.strictEqual(appIdOnSource.code, checksMod.CODES.PAYLOAD_INVALID);
  // 合法白名单参数通过。
  const ok = await reg.runCheck({
    checkId: 'unit.targeted',
    projectId: PROJECT_ID,
    params: { timeoutMs: 60000, targetFiles: ['test/desktop-contract.test.cjs', 'test/frontend-contract.test.cjs'] },
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.status, 'PASS');
  const last = calls[calls.length - 1];
  const targets = last.args.filter((arg, index) => last.args[index - 1] === '--target');
  assert.deepStrictEqual(targets, ['test/desktop-contract.test.cjs', 'test/frontend-contract.test.cjs']);
  assert.strictEqual(calls.length, 1, '非法参数不得 spawn');
});

test('结果与 fail-closed：PASS / FAIL / BLOCKED（EPERM/超时/不可解析），绝不把不可解析当 PASS', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);

  const pass = registry({ userDataDir, runner: fakeRunner(() => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 4 })).runner });
  const passResult = await pass.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
  assert.deepStrictEqual(passResult, {
    ok: true, checkId: 'source.check', status: 'PASS', durationMs: 4, issues: [],
  });

  const fail = registry({ userDataDir, runner: fakeRunner(() => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'FAIL', issues: [{ code: 'SRC', message: '语法错误', file: 'pages/menu/index.wxml', line: 3 }] }), stderr: '', durationMs: 7 })).runner });
  const failResult = await fail.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
  assert.strictEqual(failResult.status, 'FAIL');
  assert.strictEqual(failResult.issues[0].file, 'pages/menu/index.wxml');
  assert.strictEqual(failResult.issues[0].line, 3);

  for (const fake of [
    () => ({ ok: false, code: 'EPERM', killed: false, stdout: '', stderr: 'spawn EPERM', durationMs: 1 }),
    () => ({ ok: false, code: 'ETIMEDOUT', killed: true, stdout: '', stderr: 'timeout', durationMs: 2 }),
    () => ({ ok: true, code: 'OK', stdout: 'not json', stderr: '', durationMs: 1 }),
    () => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'SUCCESS' }), stderr: '', durationMs: 1 }),
    () => ({ ok: true, code: 'OK', stdout: '', stderr: '', durationMs: 1 }),
  ]) {
    const reg = registry({ userDataDir, runner: fakeRunner(fake).runner });
    const result = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'BLOCKED', '不可用/不可解析必须 BLOCKED');
    assert.notStrictEqual(result.status, 'PASS');
    assert.ok(result.issues.length > 0);
  }
});

test('issues 有界且脱敏：≤200、无仓库/userData 绝对路径、无 sk- 密钥、消息 ≤240', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const lines = [];
  for (let index = 0; index < 400; index += 1) {
    lines.push(`C:\\secret\\path\\file-${index}.wxml:${index + 1}:3 error`);
  }
  lines.push('token sk-abcdef1234567890 leaked');
  lines.push(`repo=${REPO}`);
  lines.push(`userData=${userDataDir}`);
  const runner = fakeRunner(() => ({
    ok: true,
    code: 'OK',
    stdout: JSON.stringify({ status: 'FAIL', issues: lines.map((message) => ({ code: 'X', message })) }),
    stderr: '',
    durationMs: 2,
  })).runner;
  const reg = registry({ userDataDir, runner });
  const result = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
  assert.strictEqual(result.status, 'FAIL');
  assert.ok(result.issues.length <= checksMod.MAX_ISSUES);
  assert.ok(result.issues.length > 0);
  for (const issue of result.issues) {
    assert.ok(issue.message.length <= 240);
    assert.ok(!issue.message.includes(userDataDir), '不得含 userData 路径');
    assert.ok(!issue.message.includes(REPO), '不得含仓库路径');
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(issue.message), '不得含密钥');
    assert.ok(!/[A-Za-z]:[\\/]/.test(issue.message), '不得含盘符路径');
    assert.strictEqual(issue.file, null);
  }
});

test('scoped 检查无版本：确定性 NOT_RUN（不 spawn，不伪造 PASS）', async (t) => {
  const userDataDir = tempUserData(t);
  const { runner, calls } = fakeRunner();
  const reg = registry({ userDataDir, runner });
  for (const checkId of ['composer.dry-run', 'output.consistency', 'wechat.verify']) {
    const result = await reg.runCheck({ checkId, projectId: PROJECT_ID });
    assert.strictEqual(result.ok, true, checkId);
    assert.strictEqual(result.status, 'NOT_RUN', checkId);
    assert.ok(
      result.issues.some((issue) => [checksMod.CODES.VERSION_NOT_FOUND, 'AGENT_WORKSPACE_NOT_FOUND', 'AGENT_VERSION_CONFLICT'].includes(issue.code)),
      JSON.stringify(result.issues),
    );
  }
  assert.strictEqual(calls.length, 0, '无版本不得 spawn');
});

test('wechat.verify：固定包装 wechat-devtools-run.cjs；工具缺失/超时/证据矛盾 → BLOCKED，绝不伪造 PASS', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);

  const missing = registry({
    userDataDir,
    runner: fakeRunner(() => ({ ok: false, code: 'ENOENT', killed: false, stdout: '', stderr: 'CLI 不存在', durationMs: 1 })).runner,
  });
  const blocked = await missing.runCheck({ checkId: 'wechat.verify', projectId: PROJECT_ID });
  assert.strictEqual(blocked.status, 'BLOCKED');
  assert.notStrictEqual(blocked.status, 'PASS');

  const verified = await missing.verifyWechat({ projectId: PROJECT_ID, attemptId: 'attempt-1', appId: 'wx1234567890abcdef' });
  assert.strictEqual(verified.ok, true, JSON.stringify(verified));
  assert.strictEqual(verified.status, 'BLOCKED');
  assert.deepStrictEqual(verified.screenshots, []);
  assert.deepStrictEqual(verified.pages, []);

  // 包装真实报告 PASS → 才允许 PASS；evidenceRelative 只接受相对路径。
  const pass = registry({
    userDataDir,
    runner: fakeRunner(() => ({
      ok: true,
      code: 'OK',
      stdout: JSON.stringify({ status: 'PASS', evidenceRelative: 'runtime/attempt-1', screenshots: [{ label: 'a', relative: 'runtime/a.png' }] }),
      stderr: '',
      durationMs: 9,
    })).runner,
  });
  const passed = await pass.verifyWechat({ projectId: PROJECT_ID, attemptId: 'attempt-1' });
  assert.strictEqual(passed.ok, true);
  assert.strictEqual(passed.status, 'PASS');
  assert.strictEqual(passed.evidenceRelative, 'runtime/attempt-1');

  const unsafeEvidence = registry({
    userDataDir,
    runner: fakeRunner(() => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', evidenceRelative: '../secrets' }), stderr: '', durationMs: 1 })).runner,
  });
  const unsafe = await unsafeEvidence.runCheck({ checkId: 'wechat.verify', projectId: PROJECT_ID });
  assert.strictEqual(unsafe.status, 'PASS');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(unsafe, 'evidenceRelative'), false);
});

test('同步 spawn 异常归一：runner throw EPERM → BLOCKED + CHECK_TOOL_MISSING；dispatcher 同场景一致', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  assert.strictEqual(checksMod.CODES.TOOL_MISSING, 'CHECK_TOOL_MISSING');

  const syncThrow = () => {
    const error = new Error('spawn EPERM');
    error.code = 'EPERM';
    throw error;
  };
  const reg = checksMod.createCheckRegistry({ userDataDir, runner: syncThrow });
  const result = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.status, 'BLOCKED');
  assert.ok(result.issues.some((issue) => issue.code === 'CHECK_TOOL_MISSING'), JSON.stringify(result.issues));

  // dispatcher：同步 spawn 失败归一为工具缺失（不能冒泡成 CHECK_FAILED）。
  const dispatcher = require(path.join(REPO, 'scripts', 'agent-checks', 'run-check.cjs'));
  assert.strictEqual(typeof dispatcher.runProcess, 'function');
  const syncSpawn = () => {
    const error = new Error('spawn EPERM');
    error.code = 'EPERM';
    throw error;
  };
  const runResult = await dispatcher.runProcess([process.execPath, '-e', ''], { timeoutMs: 1000 }, syncSpawn);
  assert.strictEqual(runResult.ok, false);
  assert.strictEqual(runResult.code, 'EPERM');
  assert.strictEqual(runResult.stdout, '');
  const report = dispatcher.buildFailureReport('source.check', runResult);
  assert.strictEqual(report.status, 'BLOCKED');
  assert.strictEqual(report.issues[0].code, 'CHECK_TOOL_MISSING');
  assert.notStrictEqual(report.status, 'PASS');

  // 真实非零退出仍是 FAIL（CHECK_FAILED），不被环境码吞掉。
  const exitFail = dispatcher.buildFailureReport('source.check', {
    ok: false, code: 'EXIT_1', killed: false, stdout: '{"status":"PASS"}', stderr: 'real failure', durationMs: 3,
  });
  assert.strictEqual(exitFail.status, 'FAIL');
  assert.strictEqual(exitFail.issues[0].code, 'CHECK_FAILED');
});

test('非零退出 + stdout 里写 PASS 仍是 FAIL（不把输出文本当成功）', async (t) => {
  const userDataDir = tempUserData(t);
  initProject(userDataDir);
  const reg = checksMod.createCheckRegistry({
    userDataDir,
    runner: async () => ({ ok: false, code: 'EXIT_1', killed: false, stdout: '{"status":"PASS"}', stderr: 'real failure', durationMs: 3 }),
  });
  const result = await reg.runCheck({ checkId: 'source.check', projectId: PROJECT_ID });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'FAIL');
  assert.strictEqual(result.issues[0].code, 'AGENT_CHECK_FAILED');
  assert.notStrictEqual(result.status, 'PASS');
});

test('静态边界：dispatcher 只做固定映射，不出现 shell 执行/任意命令拼接', () => {
  const dispatcher = fs.readFileSync(path.join(REPO, 'scripts', 'agent-checks', 'run-check.cjs'), 'utf8');
  assert.ok(dispatcher.includes("shell: false"));
  assert.ok(!/shell:\s*true/.test(dispatcher));
  assert.ok(!/\bexec\(\s*`/.test(dispatcher), 'dispatcher 不得拼接 shell 命令');
  assert.ok(dispatcher.includes('scripts/wechat-devtools-run.cjs'));
  assert.ok(dispatcher.includes("'wechat.verify'"));
  assert.ok(dispatcher.includes('TARGET_ALLOWLIST'));

  const checksSource = fs.readFileSync(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'), 'utf8');
  assert.ok(checksSource.includes('shell: false'));
  assert.ok(!/shell:\s*true/.test(checksSource));
  assert.ok(checksSource.includes("'wechat.verify'"));
  assert.ok(checksSource.includes('createCheckRegistry'));
});
