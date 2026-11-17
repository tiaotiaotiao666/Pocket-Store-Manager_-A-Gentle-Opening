'use strict';

/**
 * P0（执行链跑通）行为测试。
 *
 * 覆盖三件曾经出问题的事：
 * 1. 预览与候选验证必须用同一份 CLI 解析（曾出现「预览能打开、验证说工具缺失」）；
 * 2. 总状态必须由页面 + 关键交互共同决定（关键下单动作失败不能 PASS）；
 * 3. 安装版必须带固定脚本与 automator（package.json 契约）。
 *
 * 全部只读或写临时目录，不启动微信开发者工具，不执行任何外部命令。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const shared = require(path.join(REPO, 'desktop', 'devtools-cli.cjs'));
const launcher = require(path.join(REPO, 'desktop', 'devtools-launch.cjs'));
const runner = require(path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'));
const { computeVerificationStatus, STATUS } = require(
  path.join(REPO, 'desktop', 'frontend-reconstruct', 'verification-status.cjs'),
);
const { verifyRuntime, resolveToolchain } = require(
  path.join(REPO, 'desktop', 'frontend-reconstruct', 'verify-runtime.cjs'),
);

// --------------------------------------------------------------------------- 1. 共享 CLI 解析

test('P0-1 预览与候选验证用同一个 resolveDevtoolsCli 实现', () => {
  assert.strictEqual(launcher.resolveDevtoolsCli, shared.resolveDevtoolsCli);
  // 候选验证包装层不再自带候选清单，只 require 共享模块（源码层面也不允许再分叉）。
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'frontend-reconstruct', 'verify-runtime.cjs'), 'utf8');
  assert.match(source, /require\('\.\.\/devtools-cli\.cjs'\)/);
  assert.doesNotMatch(source, /CLI_CANDIDATES/);

  const runnerSource = fs.readFileSync(path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'), 'utf8');
  assert.match(runnerSource, /require\('\.\.\/desktop\/devtools-cli\.cjs'\)/);
  assert.doesNotMatch(runnerSource, /const CLI_CANDIDATES/);
});

test('P0-1 WX_CLI_PATH 优先，固定候选与安装目录扫描兜底', () => {
  const seen = [];
  const resolved = shared.resolveDevtoolsCli({
    env: { WX_CLI_PATH: 'C:\\custom\\cli.bat' },
    existsSync: (target) => {
      seen.push(target);
      return target === 'C:\\custom\\cli.bat';
    },
  });
  assert.strictEqual(resolved, 'C:\\custom\\cli.bat');
  assert.deepStrictEqual(seen, ['C:\\custom\\cli.bat']);

  // 没有任何候选命中时返回 null（调用方据此给 BLOCKED，而不是编一个路径）
  assert.strictEqual(shared.resolveDevtoolsCli({ env: {}, existsSync: () => false }), null);

  // 环境变量展开：%LOCALAPPDATA% 之类候选要真的被替换
  assert.strictEqual(shared.expandEnvPath('%FOO%\\cli.bat', { FOO: 'C:\\bar' }), 'C:\\bar\\cli.bat');
});

test('P0-1 本机若安装了开发者工具，包装层的 resolveToolchain 必须找到同一个 cli.bat', (t) => {
  const cliPath = shared.resolveDevtoolsCli();
  if (!cliPath) {
    t.diagnostic('本机未安装微信开发者工具，跳过 CLI 命中一致性断言（不得视为通过）');
    return;
  }
  const toolchain = resolveToolchain({});
  assert.equal(toolchain.ok, true, JSON.stringify(toolchain));
  assert.equal(toolchain.cliPath, cliPath, '预览与验证必须解析出同一个 cli.bat');
  assert.match(path.basename(cliPath), /^cli\.bat$/i);
});

test('P0-1 工程身份检查：Composer 产物与 AppID 用同一套错误码', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const empty = shared.inspectDevtoolsTarget({ projectDir: dir });
  assert.equal(empty.ok, true);
  assert.equal(empty.composer, false);
  assert.equal(empty.appidKind, 'empty');

  const notComposer = shared.inspectDevtoolsTarget({ projectDir: dir, requireComposer: true });
  assert.equal(notComposer.ok, false);
  assert.equal(notComposer.code, 'OUTPUT_NOT_COMPOSER');
  assert.match(notComposer.message, /不是 Composer 产物/);

  fs.writeFileSync(path.join(dir, 'composition.lock.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'generation-report.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({ appid: 'touristappid' }), 'utf8');
  const tourist = shared.inspectDevtoolsTarget({ projectDir: dir, requireComposer: true, requireAppId: true });
  assert.equal(tourist.ok, false);
  assert.equal(tourist.code, 'APPID_NOT_APPLIED');
  assert.equal(tourist.appidKind, 'tourist');

  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify({ appid: 'wx0123456789abcdef' }), 'utf8');
  const ready = shared.inspectDevtoolsTarget({ projectDir: dir, requireComposer: true, requireAppId: true });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.appidKind, 'real');
  assert.match(ready.appidMasked, /^wx01\*{4}abcdef$/);
});

// --------------------------------------------------------------------------- 2. 总状态

function interaction(label, status, critical) {
  return critical === undefined ? { label, status } : { label, status, critical };
}

test('P0-2 关键交互 FAIL：页面全通过也不能 PASS', () => {
  const verdict = computeVerificationStatus({
    pages: [{ route: '/pages/home/index', status: 'PASS' }, { route: '/pages/menu/index', status: 'PASS' }],
    interactions: [
      interaction('真实点击·结算提交下单', 'FAIL', true),
      interaction('分类切换（页面处理器直调 + 状态断言）', 'PASS', false),
    ],
  });
  assert.equal(verdict.status, STATUS.FAIL, JSON.stringify(verdict));
  assert.match(verdict.reason, /结算提交下单/);
  assert.equal(verdict.critical.failed, 1);
});

test('P0-2 关键交互 BLOCKED/NOT_RUN：降为 BLOCKED，不能冒充通过', () => {
  for (const status of ['BLOCKED', 'NOT_RUN']) {
    const verdict = computeVerificationStatus({
      pages: [{ route: '/pages/home/index', status: 'PASS' }],
      interactions: [interaction('真实点击·结算提交下单', status, true)],
    });
    assert.equal(verdict.status, STATUS.BLOCKED, status + ' → ' + JSON.stringify(verdict));
    assert.match(verdict.reason, /关键交互/);
  }
});

test('P0-2 参考项非 PASS 只记 degraded，不把候选打成阻塞', () => {
  const verdict = computeVerificationStatus({
    pages: [{ route: '/pages/home/index', status: 'PASS' }],
    interactions: [
      interaction('真实点击·结算提交下单', 'PASS', true),
      interaction('锚点点击·分类切换（#menu-category-nav）', 'BLOCKED', false),
      interaction('锚点点击·购物车展开（#menu-cart-bar）', 'NOT_RUN', false),
    ],
  });
  assert.equal(verdict.status, STATUS.PASS, JSON.stringify(verdict));
  assert.equal(verdict.degraded.length, 2);
  assert.equal(verdict.critical.total, 1);
});

test('P0-2 参考项 FAIL 仍然不能 PASS（诚实性优先于可用性）', () => {
  const verdict = computeVerificationStatus({
    pages: [{ route: '/pages/home/index', status: 'PASS' }],
    interactions: [interaction('桌号数据源', 'FAIL', false)],
  });
  assert.equal(verdict.status, STATUS.FAIL);
});

test('P0-2 没标 critical 的交互按关键项对待，旧证据不会被静默降级', () => {
  const verdict = computeVerificationStatus({
    pages: [{ route: '/pages/home/index', status: 'PASS' }],
    interactions: [{ label: '未标注交互', status: 'BLOCKED' }],
  });
  assert.equal(verdict.status, STATUS.BLOCKED);
});

test('P0-2 空证据与阻断原因：NOT_RUN / BLOCKED，绝不 PASS', () => {
  assert.equal(computeVerificationStatus({ pages: [], interactions: [] }).status, STATUS.NOT_RUN);
  assert.equal(computeVerificationStatus({ blocked: '工具未安装', pages: [], interactions: [] }).status, STATUS.BLOCKED);
  assert.equal(computeVerificationStatus({ pages: [{ status: 'PASS' }], interactions: [], blocked: 'APPID_ERROR' }).status, STATUS.BLOCKED);
});

test('P0-2 未知状态按 NOT_RUN 处理（关键项 → BLOCKED）', () => {
  assert.equal(computeVerificationStatus({ pages: [{ status: 'PASS' }], interactions: [{ label: 'x', status: 'WHATEVER' }] }).status, STATUS.BLOCKED);
});

// --------------------------------------------------------------------------- 3. 包装层降级 + 依赖契约

function tempAttempt(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-rt-'));
  const privateRoot = path.join(base, 'attempt-1');
  const projectDir = path.join(privateRoot, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'app.json'), JSON.stringify({ pages: ['pages/home/index'] }), 'utf8');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { privateRoot, projectDir };
}

function fakeSpawn(report) {
  return (spec) => {
    const index = spec.args.indexOf('--json');
    fs.writeFileSync(spec.args[index + 1], JSON.stringify(report, null, 2), 'utf8');
    return { result: Promise.resolve({ exitCode: 0 }), kill: () => {} };
  };
}

test('P0-2 包装层：证据自称 PASS 但关键交互 FAIL → 拒绝 PASS', async (t) => {
  const { privateRoot, projectDir } = tempAttempt(t);
  const result = await verifyRuntime({
    projectDir,
    privateRoot,
    cliPath: process.execPath,
    spawnImpl: fakeSpawn({
      schemaVersion: 'wechat-devtools-run.v1',
      status: 'PASS',
      blocked: null,
      steps: [{ id: 'login', status: 'PASS' }],
      pages: [{ route: '/pages/home/index', status: 'PASS' }],
      interactions: [{ label: '真实点击·结算提交下单', status: 'FAIL', critical: true }],
    }),
  });
  assert.notEqual(result.status, STATUS.PASS, JSON.stringify(result));
  assert.equal(result.code, 'RUNTIME_INCONSISTENT');
  assert.match(result.summary, /结算提交下单/);
  assert.ok(result.details.warnings.some((item) => item.includes('总判定')));
  assert.equal(result.details.criticalInteractions.failed, 1);
});

test('P0-2 包装层：页面 + 关键交互都通过才 PASS，并给出关键交互计数', async (t) => {
  const { privateRoot, projectDir } = tempAttempt(t);
  const result = await verifyRuntime({
    projectDir,
    privateRoot,
    cliPath: process.execPath,
    spawnImpl: fakeSpawn({
      schemaVersion: 'wechat-devtools-run.v1',
      status: 'PASS',
      blocked: null,
      steps: [{ id: 'login', status: 'PASS' }],
      pages: [{ route: '/pages/home/index', status: 'PASS' }],
      interactions: [
        { label: '真实点击·结算提交下单', status: 'PASS', critical: true },
        { label: '锚点点击·分类切换（#menu-category-nav）', status: 'BLOCKED', critical: false },
      ],
    }),
  });
  assert.equal(result.status, STATUS.PASS, JSON.stringify(result));
  assert.match(result.summary, /关键交互 1\/1 通过/);
  assert.equal(result.details.verdict.degraded.length, 1);
  assert.equal(result.details.identity.appidKind, 'empty');
});

test('P0-3 安装版依赖契约：固定脚本与 automator 必须进包', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['miniprogram-automator'], 'miniprogram-automator 必须在 dependencies');
  assert.ok(!(pkg.devDependencies || {})['miniprogram-automator'], '不能同时留在 devDependencies');
  assert.ok(
    (pkg.build.files || []).includes('scripts/wechat-devtools-run.cjs'),
    '固定验证脚本必须在 build.files 里',
  );
  assert.notEqual(pkg.build.asar, true, 'asar 必须关闭：固定脚本要能被 electron.exe 直接执行');
});

test('P0-3 固定脚本在安装版里由 electron.exe 以 Node 模式执行', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'frontend-reconstruct', 'verify-runtime.cjs'), 'utf8');
  // 安装版必须显式打开 ELECTRON_RUN_AS_NODE；开发态必须剔除（否则开发者工具 CLI 退化成纯 Node）。
  assert.match(source, /env\.ELECTRON_RUN_AS_NODE = '1'/);
  assert.match(source, /delete env\.ELECTRON_RUN_AS_NODE/);
  // 固定脚本路径在 asar 场景要换成真实文件路径
  assert.match(source, /function unpackedPathFor/);
});

test('P0-1 runner 的交互分级：加购/选桌/结算 是关键项，锚点补验是参考项', () => {
  for (const label of [
    '真实点击·结算提交下单',
    '真实点击·首页选桌 →「开始点餐」进入菜单',
    '真实点击·选择餐桌（菜单页 .menu__table）',
    '菜品加购（页面处理器直调 + 状态断言）',
  ]) {
    assert.equal(runner.ADVISORY_INTERACTIONS.has(label), false, label + ' 必须是关键项');
  }
  for (const label of [
    '锚点点击·分类切换（#menu-category-nav）',
    '锚点点击·菜品加购（#menu-product-*）',
    '锚点点击·购物车展开（#menu-cart-bar）',
    '桌号数据源·首页/菜单/结算均来自后端 /stores/:id/tables',
    '真实点击·订单详情「演示模拟支付」',
  ]) {
    assert.equal(runner.ADVISORY_INTERACTIONS.has(label), true, label + ' 必须是参考项');
  }
});

test('P0-1 runner 导出的总状态函数与包装层同源', () => {
  assert.strictEqual(runner.computeVerificationStatus, computeVerificationStatus);
  assert.match(runner.detectBlockedReason({ stdout: 'APPID_ERROR', stderr: '' }), /APPID_ERROR/);
});
