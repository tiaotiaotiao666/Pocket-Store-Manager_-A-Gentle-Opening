'use strict';

/**
 * E0-W2 / X4：验证注册表的 **检查目标绑定** 测试（rev15 §14.4 + §14.5）。
 *
 * 这里证明四件事：
 * 1. 每条 checkId 有且只有一个 subject（attempt / export / repo），root 只能由平台给；
 * 2. attempt 级检查（source.check / composer.dry-run）真的跑在**本次 attempt 候选树**上；
 * 3. 导出树级检查（mini.check / output.consistency / wechat.verify）**缺根即 AGENT_CHECK_UNKNOWN**，
 *    绝不回落到仓库 `miniprogram/` 镜像；
 * 4. 状态口径统一四态；未知/不可判定 → NOT_RUN（不是 FAIL、更不是 PASS），工具不可用 → BLOCKED。
 *
 * 只写 os.tmpdir()；不写 templates/miniprogram/contracts，不 spawn 子进程跑 attempt 级检查。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const checksMod = require('../desktop/agent-workspace/checks.cjs');
const sourceBundle = require('../desktop/agent-workspace/source-bundle.cjs');

const REPO = path.resolve(__dirname, '..');
const BASE_SRC = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const MIRROR = path.join(REPO, 'miniprogram');

const FROZEN_IDS = Object.freeze([
  'source.check',
  'composer.dry-run',
  'mini.check',
  'output.consistency',
  'capabilities.check',
  'wechat.verify',
  'unit.targeted',
  'unit.full',
  'desktop.contract',
  'catalog.check',
  'registry.check',
]);

const SUBJECTS = Object.freeze({
  'source.check': 'attempt',
  'composer.dry-run': 'attempt',
  'mini.check': 'export',
  'output.consistency': 'export',
  'capabilities.check': 'repo',
  'wechat.verify': 'export',
  'unit.targeted': 'repo',
  'unit.full': 'repo',
  'desktop.contract': 'repo',
  'catalog.check': 'repo',
  'registry.check': 'repo',
});

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 递归复制（不用 fs.cpSync：Node 24 Windows 对深树会爆栈）。 */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function candidateTree(t) {
  const root = path.join(tempDir('w2-checks-'), 'candidate');
  copyTree(BASE_SRC, root);
  t.after(() => {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return root;
}

function appendToPage(root, pageId) {
  const file = path.join(root, 'pages', pageId, 'index.wxml');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace(/<\/view>\s*$/, '  <view class="w2-note">e0-w2</view>\n</view>\n'));
  return file;
}

function writeBundle(root, targetPages) {
  const read = sourceBundle.readTree(root);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const derived = sourceBundle.deriveBundle({ candidateFiles: read.files, targetPages });
  assert.strictEqual(derived.ok, true, JSON.stringify(derived));
  fs.writeFileSync(path.join(root, sourceBundle.BUNDLE_FILE), sourceBundle.renderBundle(derived.manifest));
  return derived;
}

function registry(extra) {
  return checksMod.createCheckRegistry(extra || {});
}

/* ------------------------------------------------------------------ */

test('注册表：11 个 checkId + 唯一 subject 表；capabilities.check 独立于 source.check', () => {
  assert.deepStrictEqual([...checksMod.CHECK_IDS], FROZEN_IDS);
  const listed = registry().listChecks();
  assert.strictEqual(listed.length, FROZEN_IDS.length);
  assert.deepStrictEqual(listed.map((item) => item.checkId), FROZEN_IDS);
  for (const item of listed) {
    assert.strictEqual(item.subject, SUBJECTS[item.checkId], item.checkId + ' subject 不符');
    assert.ok(Array.isArray(item.params) && item.params.includes('timeoutMs'));
    assert.strictEqual(typeof item.description, 'string');
  }
  // 旧 source.check 的仓库级语义保留成独立 checkId（不再顶替 attempt 级 source.check）。
  assert.strictEqual(checksMod.CHECK_DEFINITIONS['capabilities.check'].script, 'scripts/frontend-capabilities.cjs');
  assert.strictEqual(checksMod.CHECK_DEFINITIONS['source.check'].script, 'scripts/frontend-source/check.cjs');
  assert.strictEqual(checksMod.CHECK_DEFINITIONS['wechat.verify'].script, 'scripts/wechat-devtools-run.cjs');
  assert.strictEqual(checksMod.assertFixedMapping(), true);
});

test('合同别名 capabilities.source-facts ≡ canonical capabilities.check（同一实现，不冒名 source.check）', async () => {
  const reg = registry({});
  assert.deepStrictEqual({ ...checksMod.CHECK_ALIASES }, { 'capabilities.source-facts': 'capabilities.check' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(reg.definitions, 'capabilities.source-facts'), true);
  assert.strictEqual(reg.definitions['capabilities.source-facts'], reg.definitions['capabilities.check']);
  assert.strictEqual(reg.listChecks().length, FROZEN_IDS.length, '别名不改变 canonical 检查数量');
  const seen = [];
  const aliasReg = registry({
    runner: async (request) => {
      seen.push(request);
      return { ok: true, code: 'OK', stdout: JSON.stringify({ status: 'PASS', issues: [] }), stderr: '', durationMs: 1 };
    },
  });
  const viaAlias = await aliasReg.runCheck({ checkId: 'capabilities.source-facts' });
  assert.strictEqual(viaAlias.ok, true, JSON.stringify(viaAlias));
  assert.strictEqual(viaAlias.checkId, 'capabilities.check', '别名归一到 canonical');
  assert.strictEqual(viaAlias.status, 'PASS');
  // F-T5-06：首元素必须是固定的 dispatcher 路径（不能拿实际值自比较），并完整断言 argv 前三项。
  assert.strictEqual(seen[seen.length - 1].args[0], checksMod.dispatcherPath);
  assert.deepStrictEqual(
    seen[seen.length - 1].args.slice(0, 3),
    [checksMod.dispatcherPath, '--check', 'capabilities.check'],
  );
  // 别名不得冒名 source.check（attempt 主体）。
  assert.strictEqual(aliasReg.definitions['capabilities.source-facts'].subject, 'repo');
  assert.strictEqual(aliasReg.definitions['source.check'].subject, 'attempt');
});

test('未知 checkId → AGENT_CHECK_UNKNOWN（不执行任何检查）', async () => {
  const calls = [];
  const reg = registry({ runner: async (request) => { calls.push(request); return { ok: true, stdout: '{}', stderr: '', durationMs: 1 }; } });
  for (const checkId of ['evil.command', '', 'source', 'mini.check2']) {
    const result = await reg.runCheck({ checkId, root: BASE_SRC, exportRoot: BASE_SRC });
    assert.strictEqual(result.ok, false, checkId);
    assert.strictEqual(result.code, checksMod.CODES.CHECK_UNKNOWN, checkId);
  }
  assert.strictEqual(calls.length, 0, '未知 checkId 不得 spawn');
});

test('source.check：真跑在 attempt 候选树上（进程内，不 spawn）；坏文件 → FAIL 且指向候选路径', async (t) => {
  const root = candidateTree(t);
  const calls = [];
  const reg = registry({ runner: async (request) => { calls.push(request); return { ok: true, stdout: '{}', stderr: '', durationMs: 1 }; } });

  const clean = await reg.runCheck({ checkId: 'source.check', root });
  assert.strictEqual(clean.ok, true, JSON.stringify(clean));
  assert.strictEqual(clean.status, 'PASS', JSON.stringify(clean.issues.slice(0, 3)));
  assert.strictEqual(clean.subjectKind, 'attempt');
  assert.strictEqual(calls.length, 0, 'attempt 级检查不得 spawn');

  // 破坏候选树里的 JSON 语法：必须 FAIL 且问题指向候选树相对路径。
  fs.writeFileSync(path.join(root, 'pages', 'menu', 'index.json'), '{ "usingComponents": { ');
  const broken = await reg.runCheck({ checkId: 'source.check', root });
  assert.strictEqual(broken.status, 'FAIL');
  assert.ok(broken.issues.length > 0);
  assert.ok(broken.issues.some((issue) => /pages\/menu\/index\.json/.test(String(issue.file))), JSON.stringify(broken.issues.slice(0, 3)));

  // 无 root：fail-closed，不猜仓库、不伪造 PASS。
  const noRoot = await reg.runCheck({ checkId: 'source.check' });
  assert.strictEqual(noRoot.ok, false);
  assert.strictEqual(noRoot.code, checksMod.CODES.CHECK_UNKNOWN);
});

test('composer.dry-run：缺 bundle → AGENT_CHECK_UNKNOWN；空 files → FAIL(SOURCE_BUNDLE_NO_CHANGES)；真实改动 → PASS + 导出树摘要', async (t) => {
  const root = candidateTree(t);
  const parent = tempDir('w2-export-');
  t.after(() => {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch (error) {
      /* noop */
    }
  });
  const reg = registry({});

  const noBundle = await reg.runCheck({ checkId: 'composer.dry-run', root, exportParentDir: parent });
  assert.strictEqual(noBundle.ok, false);
  assert.strictEqual(noBundle.code, checksMod.CODES.CHECK_UNKNOWN);

  // 候选未改 → 派生出的 overlay 为空（loader 不允许空 files）：给出可读结论，不静默通过。
  const emptyDerived = sourceBundle.deriveBundle({ candidateFiles: sourceBundle.readTree(root).files, targetPages: ['menu'] });
  assert.strictEqual(emptyDerived.ok, true);
  assert.strictEqual(emptyDerived.fileCount, 0);
  fs.writeFileSync(path.join(root, sourceBundle.BUNDLE_FILE), sourceBundle.renderBundle(emptyDerived.manifest));
  const noChanges = await reg.runCheck({ checkId: 'composer.dry-run', root, exportParentDir: parent });
  assert.strictEqual(noChanges.status, 'FAIL');
  assert.strictEqual(noChanges.issues[0].code, 'SOURCE_BUNDLE_NO_CHANGES');

  // 真实改动 + 派生 bundle → dry-run PASS，并登记导出根/导出树摘要。
  appendToPage(root, 'menu');
  const derived = writeBundle(root, ['menu']);
  assert.ok(derived.fileCount >= 1);
  const dry = await reg.runCheck({ checkId: 'composer.dry-run', root, exportParentDir: parent });
  assert.strictEqual(dry.status, 'PASS', JSON.stringify(dry.issues.slice(0, 3)));
  assert.strictEqual(dry.subjectKind, 'attempt');
  assert.ok(path.isAbsolute(dry.exportedRoot));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(String(dry.exportTreeDigest)), String(dry.exportTreeDigest));
  assert.ok(fs.existsSync(dry.exportedRoot));
});

test('导出树级检查：缺根 → AGENT_CHECK_UNKNOWN（绝不回落仓库 miniprogram/ 镜像）；正确导出根 → PASS', async (t) => {
  const root = candidateTree(t);
  const parent = tempDir('w2-export-');
  t.after(() => {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch (error) {
      /* noop */
    }
  });
  appendToPage(root, 'menu');
  writeBundle(root, ['menu']);
  const reg = registry({});
  const dry = await reg.runCheck({ checkId: 'composer.dry-run', root, exportParentDir: parent });
  assert.strictEqual(dry.status, 'PASS', JSON.stringify(dry.issues.slice(0, 3)));

  for (const checkId of ['mini.check', 'output.consistency', 'wechat.verify']) {
    const missing = await reg.runCheck({ checkId });
    assert.strictEqual(missing.ok, false, checkId);
    assert.strictEqual(missing.code, checksMod.CODES.CHECK_UNKNOWN, checkId);
    const relative = await reg.runCheck({ checkId, exportRoot: 'miniprogram' });
    assert.strictEqual(relative.ok, false, checkId + ' 不接受相对/仓库路径');
    assert.strictEqual(relative.code, checksMod.CODES.CHECK_UNKNOWN, checkId);
  }

  const mini = await reg.runCheck({ checkId: 'mini.check', exportRoot: dry.exportedRoot });
  assert.strictEqual(mini.status, 'PASS', JSON.stringify(mini.issues.slice(0, 3)));
  assert.strictEqual(mini.subjectKind, 'export');
  const consistency = await reg.runCheck({ checkId: 'output.consistency', exportRoot: dry.exportedRoot });
  assert.strictEqual(consistency.status, 'PASS', JSON.stringify(consistency.issues.slice(0, 3)));

  // 静态防线：checks.cjs 里不存在“默认根 = 仓库 miniprogram/”的写法。
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'), 'utf8');
  assert.ok(!/path\.join\(\s*REPO_ROOT\s*,\s*['"]miniprogram['"]/.test(source), '不得硬编码仓库 miniprogram 作为检查根');
  assert.ok(!/exportRoot\s*=\s*[^;]*MIRROR/.test(source));
  assert.ok(fs.existsSync(MIRROR), '镜像目录仍然存在（只是永不被当作导出成果）');
});

test('参数白名单：root/exportRoot/command/env… 一律 AGENT_PAYLOAD_INVALID；只接受 checkId 自己的有界参数', async () => {
  const reg = registry({});
  const badParams = [
    { command: 'rm -rf /' },
    { env: { A: '1' } },
    { shell: true },
    { cwd: 'C:\\Windows' },
    { root: 'C:\\Windows' },
    { exportRoot: 'C:\\Windows' },
    { exportParentDir: 'C:\\Windows' },
    { attempt: 'attempt-1' },
    { versionId: 'v1' },
    { path: '../escape' },
    { unknown: 1 },
    { timeoutMs: 10 },
    { timeoutMs: 999999 },
    { timeoutMs: '1000' },
    { targetFiles: ['test/evil.test.cjs'] },
    { targetFiles: ['C:/abs.test.cjs'] },
    { appId: 'wxnothex' },
    { nested: { a: 1 } },
  ];
  for (const params of badParams) {
    const result = await reg.runCheck({ checkId: 'source.check', params });
    assert.strictEqual(result.ok, false, JSON.stringify(params));
    assert.strictEqual(result.code, checksMod.CODES.PAYLOAD_INVALID, JSON.stringify(params));
  }
  // appId 只对 wechat.verify 合法。
  const appIdOnSource = await reg.runCheck({ checkId: 'source.check', params: { appId: 'wx1234567890abcdef' } });
  assert.strictEqual(appIdOnSource.code, checksMod.CODES.PAYLOAD_INVALID);
  // 合法白名单参数：unit.targeted 固定白名单 + timeoutMs。
  const seen = [];
  const okReg = registry({
    runner: async (request) => {
      seen.push(request);
      return { ok: true, stdout: JSON.stringify({ status: 'PASS' }), stderr: '', durationMs: 3 };
    },
  });
  const okResult = await okReg.runCheck({
    checkId: 'unit.targeted',
    params: { timeoutMs: 60000, targetFiles: ['test/desktop-contract.test.cjs', 'test/frontend-contract.test.cjs'] },
  });
  assert.strictEqual(okResult.status, 'PASS');
  const request = seen[seen.length - 1];
  assert.strictEqual(request.args[1], '--check');
  assert.strictEqual(request.args[2], 'unit.targeted');
  assert.ok(!Object.prototype.hasOwnProperty.call(request, 'shell'));
  const targets = request.args.filter((arg, index) => request.args[index - 1] === '--target');
  assert.deepStrictEqual(targets, ['test/desktop-contract.test.cjs', 'test/frontend-contract.test.cjs']);
});

test('状态口径：通过/失败/工具不可用/不可解析/未知状态，绝不把“不可判定”当 PASS 或 FAIL', async () => {
  const cases = [
    { stdout: JSON.stringify({ status: 'PASS', issues: [] }), expect: 'PASS' },
    { stdout: JSON.stringify({ status: 'FAIL', issues: [{ code: 'X', message: '真的失败' }] }), expect: 'FAIL' },
    { processResult: { ok: false, code: 'EPERM', killed: false, stdout: '', stderr: 'spawn EPERM' }, expect: 'BLOCKED' },
    { processResult: { ok: false, code: 'ETIMEDOUT', killed: true, stdout: '', stderr: 'timeout' }, expect: 'BLOCKED' },
    { stdout: 'not json at all', expect: 'BLOCKED' },
    { stdout: JSON.stringify({ status: 'SUCCESS' }), expect: 'NOT_RUN' },
    { stdout: JSON.stringify({ status: '' }), expect: 'NOT_RUN' },
    { stdout: '', expect: 'BLOCKED' },
  ];
  for (const item of cases) {
    const reg = registry({
      runner: async () => item.processResult || { ok: true, code: 'OK', stdout: item.stdout, stderr: '', durationMs: 2 },
    });
    const result = await reg.runCheck({ checkId: 'capabilities.check' });
    assert.strictEqual(result.ok, true, item.expect);
    assert.strictEqual(result.status, item.expect, JSON.stringify(item));
    if (item.expect !== 'PASS') assert.ok(result.issues.length > 0, JSON.stringify(item));
  }
  // 明确定义：未知状态 → NOT_RUN + CHECK_STATUS_UNKNOWN（不是 FAIL）。
  const regUnknown = registry({ runner: async () => ({ ok: true, code: 'OK', stdout: JSON.stringify({ status: 'WHATEVER' }), stderr: '', durationMs: 1 }) });
  const unknown = await regUnknown.runCheck({ checkId: 'capabilities.check' });
  assert.strictEqual(unknown.status, 'NOT_RUN');
  assert.strictEqual(unknown.issues[0].code, 'CHECK_STATUS_UNKNOWN');
});

test('issues 有界且脱敏：≤200、无仓库/userData/盘符路径、无 sk- 密钥、消息 ≤240', async () => {
  const tmp = tempDir('w2-issues-');
  const lines = [];
  for (let index = 0; index < 400; index += 1) lines.push(`C:\\secret\\file-${index}.wxml:${index + 1}:3 error`);
  lines.push('token sk-abcdef1234567890 leaked');
  lines.push(`repo=${REPO}`);
  lines.push(`tmp=${tmp}`);
  const reg = registry({
    runner: async () => ({
      ok: true,
      code: 'OK',
      stdout: JSON.stringify({ status: 'FAIL', issues: lines.map((message) => ({ code: 'X', message })) }),
      stderr: '',
      durationMs: 1,
    }),
  });
  const result = await reg.runCheck({ checkId: 'capabilities.check' });
  assert.strictEqual(result.status, 'FAIL');
  assert.ok(result.issues.length <= checksMod.MAX_ISSUES);
  for (const issue of result.issues) {
    assert.ok(issue.message.length <= 240);
    assert.ok(!issue.message.includes(REPO));
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(issue.message));
    assert.ok(!/[A-Za-z]:[\\/]/.test(issue.message));
  }
});

test('静态边界：无 shell 执行入口；dispatcher 只做固定映射', () => {
  const dispatcher = fs.readFileSync(path.join(REPO, 'scripts', 'agent-checks', 'run-check.cjs'), 'utf8');
  assert.ok(dispatcher.includes('shell: false'));
  assert.ok(!/shell:\s*true/.test(dispatcher));
  assert.ok(dispatcher.includes('TARGET_ALLOWLIST'));
  assert.ok(dispatcher.includes("'wechat.verify'"));
  assert.ok(dispatcher.includes("'capabilities.check'"));
  // attempt 级检查不得经 dispatcher（它拿不到 attempt 主体）。
  assert.ok(!/'source\.check':\s*\{/.test(dispatcher), 'dispatcher 不得接受 source.check');
  assert.ok(!/'composer\.dry-run':\s*\{/.test(dispatcher), 'dispatcher 不得接受 composer.dry-run');

  const checksSource = fs.readFileSync(path.join(REPO, 'desktop', 'agent-workspace', 'checks.cjs'), 'utf8');
  assert.ok(checksSource.includes('shell: false'));
  assert.ok(!/shell:\s*true/.test(checksSource));
  assert.ok(checksSource.includes("'wechat.verify'"));
  assert.ok(checksSource.includes('createCheckRegistry'));
  // 只有 dispatcher 路径才 spawn；attempt 级检查是进程内实现。
  assert.ok(checksSource.includes("'attempt-source'"));
  assert.ok(checksSource.includes("'attempt-compose'"));
});
