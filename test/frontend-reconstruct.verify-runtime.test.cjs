'use strict';

/**
 * P3-3：微信运行时验证包装（固定命令与参数、超时、取消、证据路径、四态结论）。
 *
 * 本机没有可用开发者工具时只允许 BLOCKED；测试全程注入 `spawnImpl`，
 * **不会真的启动微信开发者工具**，也不会执行任何模型提供的命令。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const {
  STATUS,
  CODES,
  DEFAULT_AUTO_PORT,
  WRAPPER_EVIDENCE,
  buildRunArgs,
  verifyRuntime,
} = require(path.join(REPO, 'desktop', 'frontend-reconstruct', 'verify-runtime.cjs'));

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-rt-' + prefix + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* 清理失败不影响断言 */
    }
  });
  return dir;
}

function setup(t, prefix) {
  const base = tempDir(t, prefix);
  const privateRoot = path.join(base, 'attempt-1');
  const projectDir = path.join(privateRoot, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'app.json'), JSON.stringify({ pages: ['pages/home/index'] }), 'utf8');
  return { base, privateRoot, projectDir };
}

/** 构造一个“固定脚本”替身：只按参数写证据，不启动任何进程。 */
function fakeSpawn(handler) {
  const calls = [];
  return {
    calls,
    spawnImpl: (spec) => {
      calls.push(spec);
      const outcome = handler(spec, calls.length) || {};
      const kill = () => { outcome.onKill && outcome.onKill(); };
      const result = outcome.pending
        ? outcome.pending
        : Promise.resolve({ exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode });
      return { result, kill };
    },
  };
}

function argsValue(spec, flag) {
  const index = spec.args.indexOf(flag);
  return index >= 0 ? spec.args[index + 1] : '';
}

function writeReport(spec, report) {
  fs.writeFileSync(argsValue(spec, '--json'), JSON.stringify(report, null, 2), 'utf8');
}

function reportBase(overrides) {
  return {
    schemaVersion: 'wechat-devtools-run.v1',
    generatedAt: '2026-11-17T00:00:00.000Z',
    status: 'PASS',
    steps: [{ id: 'login', status: 'PASS' }, { id: 'compile', status: 'PASS' }],
    pages: [],
    interactions: [],
    blocked: null,
    ...(overrides || {}),
  };
}

test('固定参数集：顺序固定、端口/证据/截图都由包装层决定', () => {
  const base = path.join(os.tmpdir(), 'fr-rt-args');
  const args = buildRunArgs({
    projectDir: path.join(base, 'candidate'),
    evidencePath: path.join(base, 'runtime.json'),
    shotsDir: path.join(base, 'shots'),
  });
  assert.strictEqual(args.ok, true, JSON.stringify(args));
  assert.deepStrictEqual(args.args.slice(1), [
    path.join(base, 'candidate'),
    '--auto-port',
    String(DEFAULT_AUTO_PORT),
    '--json',
    path.join(base, 'runtime.json'),
    '--shots',
    path.join(base, 'shots'),
  ]);
  assert.match(args.args[0].replace(/\\/g, '/'), /scripts\/wechat-devtools-run\.cjs$/);

  assert.strictEqual(buildRunArgs({ projectDir: 'relative', evidencePath: 'x', shotsDir: 'y' }).code, CODES.INPUT_INVALID);
  assert.strictEqual(buildRunArgs({ projectDir: base, evidencePath: 'x', shotsDir: 'y' }).code, CODES.INPUT_INVALID);
  assert.strictEqual(buildRunArgs({
    projectDir: base, evidencePath: path.join(base, 'a.json'), shotsDir: path.join(base, 's'), autoPort: 80,
  }).code, CODES.INPUT_INVALID);
});

test('工具不可用：BLOCKED（不启动进程、不伪造通过），并写包装证据', async (t) => {
  const { base, privateRoot, projectDir } = setup(t, 'tool');
  const fake = fakeSpawn(() => ({ exitCode: 0 }));
  const result = await verifyRuntime({
    projectDir,
    privateRoot,
    cliPath: path.join(base, 'missing-cli.bat'),
    spawnImpl: fake.spawnImpl,
  });

  assert.strictEqual(fake.calls.length, 0, '工具缺失时不得启动任何进程');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, STATUS.BLOCKED);
  assert.strictEqual(result.code, CODES.TOOL_MISSING);
  assert.match(result.summary, /BLOCKED/);
  assert.deepStrictEqual(result.artifacts.screenshots, []);

  const wrapperFile = path.join(result.artifacts.evidenceDir, WRAPPER_EVIDENCE);
  assert.ok(fs.existsSync(wrapperFile));
  const wrapper = JSON.parse(fs.readFileSync(wrapperFile, 'utf8'));
  assert.strictEqual(wrapper.status, STATUS.BLOCKED);
  assert.strictEqual(wrapper.code, CODES.TOOL_MISSING);
  assert.ok(!fs.readFileSync(wrapperFile, 'utf8').includes(base), '证据不得写绝对路径');
});

test('PASS：只信任脚本证据，返回截图清单与四态结论', async (t) => {
  const { base, privateRoot, projectDir } = setup(t, 'pass');
  let screenshotFile = '';
  const fake = fakeSpawn((spec) => {
    const shots = argsValue(spec, '--shots');
    screenshotFile = path.join(shots, 'pages-home-index.png');
    fs.writeFileSync(screenshotFile, Buffer.alloc(4096, 1));
    writeReport(spec, reportBase({
      pages: [{ route: '/pages/home/index', label: '首页', status: 'PASS', screenshot: screenshotFile }],
      interactions: [
        { label: '真实点击·首页选桌 →「开始点餐」进入菜单', status: 'PASS', detail: '进入 pages/menu/index', path: 'CLICK（真实点击）' },
        // P0：交互项用 critical 声明是否参与总状态；参考项的非 PASS 只进 degraded。
        { label: '锚点点击·购物车展开', status: 'BLOCKED', detail: '宿主不可定位', path: 'ANCHOR_CLICK', critical: false },
      ],
    }));
    return { exitCode: 0 };
  });

  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });

  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.status, STATUS.PASS);
  assert.strictEqual(result.code, CODES.PASS);
  assert.strictEqual(fake.calls.length, 1);
  const spec = fake.calls[0];
  assert.strictEqual(spec.command, process.execPath, '只允许用当前 node 跑固定脚本');
  assert.strictEqual(path.resolve(spec.args[0]), path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'));
  assert.ok(spec.args.includes('--auto-port'));
  assert.strictEqual(argsValue(spec, '--auto-port'), String(DEFAULT_AUTO_PORT));

  assert.strictEqual(result.details.pages.total, 1);
  assert.strictEqual(result.details.pages.PASS, 1);
  assert.strictEqual(result.details.interactions.total, 2);
  assert.strictEqual(result.artifacts.screenshots.length, 1);
  assert.deepStrictEqual(result.artifacts.screenshots[0], {
    label: '首页',
    path: 'pages-home-index.png',
    bytes: 4096,
  });
  // 报告里的绝对截图路径不外泄，只给相对名。
  assert.ok(!JSON.stringify(result).includes(base));
  assert.ok(!JSON.stringify(result.artifacts.screenshots).includes(path.sep + 'shots'));

  const wrapper = JSON.parse(fs.readFileSync(path.join(result.artifacts.evidenceDir, WRAPPER_EVIDENCE), 'utf8'));
  assert.strictEqual(wrapper.status, STATUS.PASS);
  assert.strictEqual(wrapper.projectDirRelative, 'project');
  assert.deepStrictEqual(wrapper.screenshots.map((item) => item.path), ['pages-home-index.png']);
});

test('FAIL：按证据判定失败（不升级为 PASS）', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'fail');
  const fake = fakeSpawn((spec) => {
    writeReport(spec, reportBase({
      status: 'FAIL',
      pages: [
        { route: '/pages/home/index', label: '首页', status: 'PASS', screenshot: '' },
        { route: '/pages/menu/index', label: '菜单', status: 'FAIL', error: '页面打开失败', screenshot: '' },
      ],
    }));
    return { exitCode: 1 };
  });
  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, STATUS.FAIL);
  assert.strictEqual(result.code, CODES.FAIL);
  assert.strictEqual(result.details.pages.FAIL, 1);
  assert.strictEqual(result.details.exitCode, 1);
});

test('BLOCKED：脚本如实阻塞时保留原因并脱敏本机路径', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'blocked');
  const fake = fakeSpawn((spec) => {
    writeReport(spec, reportBase({
      status: 'BLOCKED',
      blocked: 'SERVICE_PORT_DISABLED：开发者工具服务端口未开启（C:\\Program Files\\微信web开发者工具\\cli.bat）',
    }));
    return { exitCode: 1 };
  });
  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, STATUS.BLOCKED);
  assert.strictEqual(result.code, CODES.BLOCKED);
  assert.match(result.details.blockedReason, /SERVICE_PORT_DISABLED/);
  assert.match(result.details.blockedReason, /<local-path>/);
  assert.ok(!result.summary.includes('Program Files'));
});

test('没有证据文件：BLOCKED（脚本崩溃不能算通过）', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'noev');
  const fake = fakeSpawn(() => ({ exitCode: 1 }));
  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(result.status, STATUS.BLOCKED);
  assert.strictEqual(result.code, CODES.EVIDENCE_MISSING);
  assert.strictEqual(result.ok, false);
});

test('证据与退出码矛盾：BLOCKED（拒绝据此判定通过）', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'mismatch');
  const fake = fakeSpawn((spec) => {
    writeReport(spec, reportBase({
      pages: [{ route: '/pages/home/index', label: '首页', status: 'PASS', screenshot: '' }],
    }));
    return { exitCode: 1 };
  });
  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(result.status, STATUS.BLOCKED);
  assert.strictEqual(result.code, CODES.INCONSISTENT);
  assert.ok(result.details.warnings.some((item) => item.includes('退出码')));
});

test('取消：开始前 NOT_RUN；执行中取消也 NOT_RUN 并 kill 子进程', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'cancel');

  const beforeFake = fakeSpawn(() => ({ exitCode: 0 }));
  const before = await verifyRuntime({
    projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: beforeFake.spawnImpl, signal: { cancelled: true },
  });
  assert.strictEqual(before.status, STATUS.NOT_RUN);
  assert.strictEqual(before.code, CODES.CANCELLED);
  assert.strictEqual(beforeFake.calls.length, 0);

  let killed = 0;
  const signal = { cancelled: false };
  const duringFake = fakeSpawn(() => {
    setTimeout(() => { signal.cancelled = true; }, 60);
    return { pending: new Promise(() => {}), onKill: () => { killed += 1; } };
  });
  const during = await verifyRuntime({
    projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: duringFake.spawnImpl, signal,
  });
  assert.strictEqual(during.status, STATUS.NOT_RUN);
  assert.strictEqual(during.code, CODES.CANCELLED);
  assert.strictEqual(killed, 1);
});

test('超时：BLOCKED（不把未完成当 PASS）并尝试结束子进程', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'timeout');
  let killed = 0;
  const fake = fakeSpawn(() => ({ pending: new Promise(() => {}), onKill: () => { killed += 1; } }));
  const startedAt = Date.now();
  const result = await verifyRuntime({
    projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl, timeoutMs: 1000,
  });
  assert.strictEqual(result.status, STATUS.BLOCKED);
  assert.strictEqual(result.code, CODES.TIMEOUT);
  assert.strictEqual(killed, 1);
  assert.ok(Date.now() - startedAt < 8000);
});

test('证据目录必须留在私有根内；projectDir 必须是规范小程序工程', async (t) => {
  const { base, privateRoot, projectDir } = setup(t, 'guard');
  const fake = fakeSpawn(() => ({ exitCode: 0 }));

  const escaped = await verifyRuntime({
    projectDir,
    privateRoot,
    evidenceDir: path.join(base, 'outside'),
    cliPath: path.join(REPO, 'package.json'),
    spawnImpl: fake.spawnImpl,
  });
  assert.strictEqual(escaped.status, STATUS.BLOCKED);
  assert.strictEqual(escaped.code, CODES.INPUT_INVALID);
  assert.ok(!fs.existsSync(path.join(base, 'outside')));

  const notProject = path.join(privateRoot, 'not-project');
  fs.mkdirSync(notProject);
  const invalidProject = await verifyRuntime({
    projectDir: notProject, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl,
  });
  assert.strictEqual(invalidProject.status, STATUS.BLOCKED);
  assert.strictEqual(invalidProject.code, CODES.INPUT_INVALID);
  assert.strictEqual(fake.calls.length, 0);

  // 仓库内受保护目录（miniprogram/ 有 app.json）不得当候选工程：DevTools 会写本地产物。
  const repoProject = await verifyRuntime({
    projectDir: path.join(REPO, 'miniprogram'), privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl,
  });
  assert.strictEqual(repoProject.status, STATUS.BLOCKED);
  assert.strictEqual(repoProject.code, CODES.INPUT_INVALID);
  assert.match(repoProject.summary, /仓库内/);
  assert.strictEqual(fake.calls.length, 0);

  // 自定义 scriptPath 不允许（固定脚本不可替换）。
  const customScript = await verifyRuntime({
    projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), scriptPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl,
  });
  assert.strictEqual(customScript.status, STATUS.BLOCKED);
  assert.strictEqual(customScript.code, CODES.INPUT_INVALID);
  assert.strictEqual(fake.calls.length, 0);
});

test('截图清单只收截图目录内的文件（越界路径被丢弃）', async (t) => {
  const { base, privateRoot, projectDir } = setup(t, 'shots');
  const outside = path.join(base, 'outside.png');
  fs.writeFileSync(outside, Buffer.alloc(16, 2));
  const fake = fakeSpawn((spec) => {
    writeReport(spec, reportBase({
      pages: [
        { route: '/pages/home/index', label: '首页', status: 'PASS', screenshot: outside },
        { route: '/pages/menu/index', label: '菜单', status: 'PASS', screenshot: path.join(argsValue(spec, '--shots'), 'menu.png') },
      ],
    }));
    fs.writeFileSync(path.join(argsValue(spec, '--shots'), 'menu.png'), Buffer.alloc(64, 3));
    return { exitCode: 0 };
  });
  const result = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(result.status, STATUS.PASS);
  assert.deepStrictEqual(result.artifacts.screenshots.map((item) => item.path), ['menu.png']);
});

test('重复执行不覆盖上一次证据（runtime / runtime-2）', async (t) => {
  const { privateRoot, projectDir } = setup(t, 'repeat');
  const fake = fakeSpawn((spec) => {
    writeReport(spec, reportBase({ pages: [{ route: '/pages/home/index', label: '首页', status: 'PASS', screenshot: '' }] }));
    return { exitCode: 0 };
  });
  const first = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  const second = await verifyRuntime({ projectDir, privateRoot, cliPath: path.join(REPO, 'package.json'), spawnImpl: fake.spawnImpl });
  assert.strictEqual(first.status, STATUS.PASS);
  assert.strictEqual(second.status, STATUS.PASS);
  assert.ok(first.artifacts.evidenceDir.endsWith(path.join('verification', 'runtime')));
  assert.ok(second.artifacts.evidenceDir.endsWith(path.join('verification', 'runtime-2')));
  assert.ok(fs.existsSync(path.join(first.artifacts.evidenceDir, 'wechat-devtools-run.json')));
  assert.ok(fs.existsSync(path.join(second.artifacts.evidenceDir, 'wechat-devtools-run.json')));
});

test('运行时点击链不把「后端无餐台」判成骨架缺陷：显式读 /tables 并降级为参考项', () => {
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'wechat-devtools-run.cjs'), 'utf8');
  // 1) 必须真的去后端核对 /tables，而不是只看页面有没有渲染出 Base 类名。
  assert.match(script, /async function readBackendTables\(/);
  assert.match(script, /\/tables'\)/);
  // 2) 数据缺失时该步降为参考项（critical:false），但仍如实记 BLOCKED / NOT_RUN。
  assert.match(script, /critical: noTableData \? false : undefined/);
  assert.match(script, /数据缺失，不是骨架缺陷/);
  // 3) 新骨架没有 Base 类名时按可见文案做真实点击，报告里写清实际路径。
  assert.match(script, /async function tapByLabel\(/);
  assert.match(script, /新骨架无 Base 类名/);
  // 4) 没选桌时不得再断言「结算页桌号一致」，否则空数据会把下单判成 FAIL。
  assert.ok(
    !/const tableNameMatches = selectedTable\.name \? checkoutTableName === selectedTable\.name : Boolean\(checkoutTableName\);/.test(script),
    '未选桌时不应强行断言结算页桌号一致',
  );
  assert.match(script, /本单未选桌：后端无餐台数据，不做一致性断言/);
  // 5) attempt() 允许单条结果覆盖 critical，但不会把状态改写成 PASS。
  assert.match(script, /typeof result\.critical === 'boolean' \? result\.critical : critical/);
});
