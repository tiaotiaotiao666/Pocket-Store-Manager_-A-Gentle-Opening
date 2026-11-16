'use strict';

/**
 * W1：AppID 后处理 / 最终校验 / DevTools 启动一致性。
 *
 * 覆盖七条行为要求：
 * 1. 非法 AppID ⇒ 文件不变，开发者工具不启动；
 * 2. 后处理任一步失败 ⇒ config/lock/JSON 报告/Markdown/侧车全部恢复，launcher 0 次；
 * 3. 相同 AppID + 摘要损坏 ⇒ 不得 unchanged 成功；
 * 4. 清单路径越界/绝对/重复/软链接 ⇒ 写前拒绝；
 * 5. 真实海报合成 → 合法 AppID → 独立最终校验：摘要一致、海报与首页引用不变；
 * 6. Windows 绝对路径不再误报，业务文件里的绝对路径仍被拦截；
 * 7. 缺 CLI / 非法路径 / 校验失败 ⇒ 不写 config、不启动；
 * 8. 成功只表示 generated / devtools-open-requested，绝不升级为 compiled。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.resolve(__dirname, '..');
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { sha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
const { verifyOutput } = require(path.join(REPO, 'scripts', 'composer', 'verify.cjs'));
const { applyAppid, AppidError } = require(path.join(REPO, 'desktop', 'appid-postprocess.cjs'));
const { inspectOutput, digestManifest } = require(path.join(REPO, 'desktop', 'output-consistency.cjs'));
const { openProjectInDevtools } = require(path.join(REPO, 'desktop', 'devtools-launch.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));

const APPID_A = 'wx0123456789abcdef';
const APPID_B = 'wxfedcba9876543210';
const CLI = 'D:\\wx\\cli.bat';

/** 事务涉及的全部文件；快照比对就是"失败后必须逐字节回到原样"。 */
const TRANSACTION_FILES = [
  'project.config.json',
  'composition.lock.json',
  'generation-report.json',
  '生成报告.md',
  'appid-postprocess.json',
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4, 255);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function buildOutput(t, options) {
  const opts = options || {};
  const parent = tempDir('w1-out-');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const result = await compose({
    plan: PLAN,
    parentDir: parent,
    projectName: opts.projectName || 'w1-project',
    mode: 'development',
    ...(opts.media ? { media: opts.media } : {}),
  });
  assert.equal(result.ok, true, `compose 失败：${JSON.stringify(result.code)} ${result.message || ''}`);
  return result;
}

/** 事务文件快照：存在则记字节，不存在记 null。 */
function snapshotFiles(outputPath) {
  const snapshot = {};
  for (const file of TRANSACTION_FILES) {
    const target = path.join(outputPath, file);
    snapshot[file] = fs.existsSync(target) ? fs.readFileSync(target) : null;
  }
  return snapshot;
}

function assertSnapshotUnchanged(outputPath, snapshot, label) {
  for (const file of TRANSACTION_FILES) {
    const target = path.join(outputPath, file);
    const exists = fs.existsSync(target);
    const expected = snapshot[file];
    if (expected === null) {
      assert.equal(exists, false, `${label}：${file} 本应不存在`);
      continue;
    }
    assert.equal(exists, true, `${label}：${file} 被删除`);
    assert.equal(Buffer.compare(fs.readFileSync(target), expected), 0, `${label}：${file} 字节被改动`);
  }
}

function recordingLauncher(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() { calls.unrefed = true; } };
  };
}

function launchOptions(calls) {
  return {
    env: { WX_CLI_PATH: CLI },
    existsSync: (target) => target === CLI,
    launcher: recordingLauncher(calls),
  };
}

// ------------------------------------------------------------------ W1-1

test('W1-1 非法 AppID：拒绝写入，文件逐字节不变，开发者工具不启动', async (t) => {
  const { outputPath } = await buildOutput(t);
  const before = snapshotFiles(outputPath);

  for (const bad of ['', 'touristappid', 'wx123', 'wx0123456789abcde', 'wx0123456789abcdefg', 'wx0123456789ABCDE']) {
    assert.throws(
      () => applyAppid({ outputPath, appid: bad }),
      (error) => error instanceof AppidError && error.code === 'APPID_INVALID',
      `AppID ${JSON.stringify(bad)} 必须被拒绝`,
    );
  }
  assertSnapshotUnchanged(outputPath, before, '非法 AppID');

  const calls = [];
  const result = await openProjectInDevtools({ projectPath: outputPath }, launchOptions(calls));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPID_NOT_APPLIED', `实际：${JSON.stringify(result)}`);
  assert.equal(calls.length, 0, '预检失败时不得调起开发者工具');
  assertSnapshotUnchanged(outputPath, before, '非法 AppID + 启动');
});

// ------------------------------------------------------------------ W1-2

test('W1-2 后处理任一步失败：五个文件全部回滚，launcher 0 次', async (t) => {
  for (const step of TRANSACTION_FILES) {
    const { outputPath } = await buildOutput(t);
    const before = snapshotFiles(outputPath);
    const originalWrite = fs.writeFileSync;
    let injected = 0;

    fs.writeFileSync = function patched(file, ...rest) {
      if (typeof file === 'string' && file.includes(step)) {
        injected += 1;
        throw new Error(`INJECTED_WRITE_FAILURE:${step}`);
      }
      return originalWrite.call(fs, file, ...rest);
    };
    try {
      assert.throws(
        () => applyAppid({ outputPath, appid: APPID_A }),
        (error) => error instanceof AppidError
          && ['APPID_WRITE_FAILED', 'APPID_VERIFY_FAILED'].includes(error.code),
        `在写入 ${step} 时注入失败，必须整体失败`,
      );
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(injected > 0, true, `注入点 ${step} 没有被触发，测试无效`);
    assertSnapshotUnchanged(outputPath, before, `注入失败于 ${step}`);

    const calls = [];
    const launch = await openProjectInDevtools({ projectPath: outputPath }, launchOptions(calls));
    assert.equal(launch.ok, false, `注入失败于 ${step} 后不得允许启动`);
    assert.equal(calls.length, 0);
  }
});

// ------------------------------------------------------------------ W1-3

test('W1-3 相同 AppID 但摘要损坏：不得 unchanged 成功，且不改文件', async (t) => {
  const { outputPath } = await buildOutput(t);
  const first = applyAppid({ outputPath, appid: APPID_A });
  assert.equal(first.unchanged, false);
  assert.equal(readJson(path.join(outputPath, 'project.config.json')).appid, APPID_A);

  // 正常情形：同值重写才允许 unchanged
  const same = applyAppid({ outputPath, appid: APPID_A });
  assert.equal(same.unchanged, true);
  assert.equal(same.backupDir, null);

  // 损坏 lock 摘要（保留 lockDigest，模拟"被手改成不一致"）
  const lockFile = path.join(outputPath, 'composition.lock.json');
  const lock = readJson(lockFile);
  lock.outputDigest.tree = `sha256:${'0'.repeat(64)}`;
  writeJson(lockFile, lock);
  const corrupted = snapshotFiles(outputPath);
  assert.throws(
    () => applyAppid({ outputPath, appid: APPID_A }),
    (error) => error instanceof AppidError && error.code === 'APPID_VERIFY_FAILED',
    '同值 + 摘要损坏必须报 APPID_VERIFY_FAILED',
  );
  assertSnapshotUnchanged(outputPath, corrupted, '同值 + 摘要损坏');

  const calls = [];
  const launch = await openProjectInDevtools({ projectPath: outputPath }, launchOptions(calls));
  assert.equal(launch.ok, false, '摘要损坏时不得启动开发者工具');
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ W1-4

test('W1-4 清单路径边界：越界/绝对/重复/软链接在写盘前被拒绝', async (t) => {
  const pathCases = [
    { name: '父目录越界', extra: '../evil.js' },
    { name: 'Windows 绝对路径', extra: 'C:/Windows/system32/drivers/etc/hosts' },
    { name: 'POSIX 绝对路径', extra: '/etc/passwd' },
    { name: '反斜杠相对路径', extra: 'assets\\media\\x.js' },
    { name: '空段路径', extra: 'assets//media/x.js' },
  ];

  for (const item of pathCases) {
    const { outputPath } = await buildOutput(t);
    const lockFile = path.join(outputPath, 'composition.lock.json');
    const lock = readJson(lockFile);
    lock.outputDigest.files = [...lock.outputDigest.files, { path: item.extra, digest: `sha256:${'a'.repeat(64)}` }];
    writeJson(lockFile, lock);
    const before = snapshotFiles(outputPath);
    assert.throws(
      () => applyAppid({ outputPath, appid: APPID_A }),
      (error) => error instanceof AppidError && error.code === 'APPID_PATH_INVALID',
      `${item.name} 必须在写盘前被拒绝`,
    );
    assertSnapshotUnchanged(outputPath, before, item.name);
  }

  // 重复项
  {
    const { outputPath } = await buildOutput(t);
    const lockFile = path.join(outputPath, 'composition.lock.json');
    const lock = readJson(lockFile);
    lock.outputDigest.files = [...lock.outputDigest.files, { ...lock.outputDigest.files[0] }];
    writeJson(lockFile, lock);
    const before = snapshotFiles(outputPath);
    assert.throws(
      () => applyAppid({ outputPath, appid: APPID_A }),
      (error) => error instanceof AppidError && error.code === 'APPID_PATH_INVALID',
      '清单重复项必须被拒绝',
    );
    assertSnapshotUnchanged(outputPath, before, '清单重复项');
  }

  // 软链接 / junction：平台不支持创建链接时如实记为 NOT_RUN，不伪造结果
  {
    const { outputPath } = await buildOutput(t);
    const outsideDir = tempDir('w1-outside-');
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
    const outsideFile = path.join(outsideDir, 'evil.js');
    fs.writeFileSync(outsideFile, 'module.exports = 1;\n', 'utf8');
    const linkDir = path.join(outputPath, 'assets', 'media');
    fs.mkdirSync(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, 'linked.js');
    let linked = true;
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (error) {
      linked = false;
      t.diagnostic(`软链接用例 NOT_RUN：本机无法创建符号链接（${error.code || error.message}）`);
    }
    if (linked) {
      const lockFile = path.join(outputPath, 'composition.lock.json');
      const lock = readJson(lockFile);
      lock.outputDigest.files = [
        ...lock.outputDigest.files,
        { path: 'assets/media/linked.js', digest: sha256(fs.readFileSync(outsideFile)) },
      ];
      writeJson(lockFile, lock);
      const before = snapshotFiles(outputPath);
      assert.throws(
        () => applyAppid({ outputPath, appid: APPID_A }),
        (error) => error instanceof AppidError && error.code === 'APPID_PATH_INVALID',
        '清单指向软链接必须被拒绝',
      );
      assertSnapshotUnchanged(outputPath, before, '清单软链接');
    }

    // 目录 junction：文件本身是普通文件，但真实路径越出产物根目录，同样必须拒绝
    const { outputPath: junctionRoot } = await buildOutput(t);
    const escapeDir = tempDir('w1-escape-');
    t.after(() => fs.rmSync(escapeDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(escapeDir, 'evil.js'), 'module.exports = 2;\n', 'utf8');
    const junctionPath = path.join(junctionRoot, 'linked-dir');
    let junctioned = true;
    try {
      fs.symlinkSync(escapeDir, junctionPath, 'junction');
    } catch (error) {
      junctioned = false;
      t.diagnostic(`junction 用例 NOT_RUN：本机无法创建 junction（${error.code || error.message}）`);
    }
    if (junctioned) {
      const lockFile = path.join(junctionRoot, 'composition.lock.json');
      const lock = readJson(lockFile);
      lock.outputDigest.files = [
        ...lock.outputDigest.files,
        { path: 'linked-dir/evil.js', digest: sha256(fs.readFileSync(path.join(escapeDir, 'evil.js'))) },
      ];
      writeJson(lockFile, lock);
      const before = snapshotFiles(junctionRoot);
      assert.throws(
        () => applyAppid({ outputPath: junctionRoot, appid: APPID_A }),
        (error) => error instanceof AppidError && error.code === 'APPID_PATH_INVALID',
        '清单经 junction 越出产物根目录必须被拒绝',
      );
      assertSnapshotUnchanged(junctionRoot, before, '清单 junction');
    }
  }
});

// ------------------------------------------------------------------ W1-5

test('W1-5 真实海报合成 → 合法 AppID → 最终校验：摘要一致、海报与首页引用不变', async (t) => {
  const png = makePng(96, 64);
  const media = {
    homeBackground: {
      mime: 'image/png',
      sha256: sha256(png),
      width: 96,
      height: 64,
      source: { kind: 'user-provided', provider: 'user-upload' },
      data: png,
    },
  };
  const { outputPath } = await buildOutput(t, { media, projectName: 'w1-poster' });

  const posterFile = path.join(outputPath, 'assets', 'media', 'home-background.png');
  assert.equal(fs.existsSync(posterFile), true, '导出必须包含首页背景图');
  assert.equal(Buffer.compare(fs.readFileSync(posterFile), png), 0, '背景图必须与上传 PNG 字节一致');
  const homeFile = path.join(outputPath, 'pages', 'home', 'index.wxml');
  const homeBefore = fs.readFileSync(homeFile);
  assert.match(homeBefore.toString('utf8'), /\/assets\/media\/home-background\.png/);

  const lockFile = path.join(outputPath, 'composition.lock.json');
  const reportFile = path.join(outputPath, 'generation-report.json');
  const configFile = path.join(outputPath, 'project.config.json');
  const lockBefore = readJson(lockFile);
  const reportBefore = readJson(reportFile);
  const nonTarget = lockBefore.outputDigest.files.map((item) => item.path).filter((item) => item !== 'project.config.json');
  const nonTargetBefore = digestManifest(outputPath, nonTarget);

  const applied = applyAppid({ outputPath, appid: APPID_A });
  assert.equal(applied.verified, true);
  assert.equal(applied.unchanged, false);

  // 独立最终校验（另起一次，不复用 applyAppid 的内部结果）
  const finalCheck = inspectOutput(outputPath, { expectAppid: APPID_A, requireValidAppid: true, deep: true });
  assert.equal(finalCheck.ok, true, JSON.stringify(finalCheck.problems.slice(0, 6)));

  const lock = readJson(lockFile);
  const report = readJson(reportFile);
  const config = readJson(configFile);
  const markdown = fs.readFileSync(path.join(outputPath, '生成报告.md'), 'utf8');

  assert.equal(config.appid, APPID_A, 'config AppID 必须已写入');
  assert.equal(lock.outputDigest.tree, report.output.treeSha256, 'lock/report 当前产物摘要必须一致');
  assert.equal(report.lock.lockDigest, lock.lockDigest, 'report 里的 Lock 摘要必须同步');
  assert.equal(report.output.fileCount, lock.outputDigest.files.length);
  assert.ok(markdown.includes(lock.outputDigest.tree), 'Markdown 必须包含当前产物摘要');
  assert.ok(markdown.includes(lock.lockDigest), 'Markdown 必须包含当前 Lock 摘要');
  assert.equal(report.output.history.length, 1, '初次生成摘要必须降级为历史记录');
  assert.equal(report.output.history[0].treeSha256, reportBefore.output.treeSha256);
  assert.notEqual(report.output.history[0].treeSha256, report.output.treeSha256);
  assert.match(String(report.output.history[0].stage), /初次生成/);

  // 海报、首页引用与非目标文件逐字节不变
  assert.equal(Buffer.compare(fs.readFileSync(posterFile), png), 0);
  assert.equal(Buffer.compare(fs.readFileSync(homeFile), homeBefore), 0);
  const nonTargetAfter = digestManifest(outputPath, nonTarget);
  assert.deepEqual(nonTargetAfter.files, nonTargetBefore.files, '非目标文件摘要必须不变');
  assert.equal(nonTargetAfter.tree, nonTargetBefore.tree);

  // 再写第二个 AppID：当前值仍然自洽，历史记录只增不改
  applyAppid({ outputPath, appid: APPID_B });
  const second = readJson(reportFile);
  assert.equal(readJson(configFile).appid, APPID_B);
  assert.ok(second.output.history.length >= 1);
  assert.equal(inspectOutput(outputPath, { expectAppid: APPID_B, deep: true }).ok, true);
});

// ------------------------------------------------------------------ W1-6

test('W1-6 最终目录复检不再误报 Windows 绝对路径，业务文件里的绝对路径仍被拒绝', async (t) => {
  const { outputPath } = await buildOutput(t);

  // ① 真实产物（含 generation-report.json 里的 Windows 绝对路径）最终复检必须通过
  const finalVerify = verifyOutput(outputPath, { mode: 'development' });
  assert.equal(finalVerify.ok, true, `最终目录复检被误报：${finalVerify.code} ${finalVerify.message || ''}`);
  const report = readJson(path.join(outputPath, 'generation-report.json'));
  assert.match(report.output.projectPath, /^[A-Za-z]:\\/, '前置条件：报告里确实有 Windows 绝对路径');

  // ② 业务文件注入绝对路径仍然被拦截（不是全局关闭 PATH_ESCAPE）
  const businessCopy = path.join(tempDir('w1-escape-business-'), 'project');
  fs.cpSync(outputPath, businessCopy, { recursive: true });
  fs.appendFileSync(path.join(businessCopy, 'config', 'store.generated.js'), '\n// 泄漏：C:\\\\Users\\\\someone\\\\.ssh\n', 'utf8');
  const businessBroken = verifyOutput(businessCopy, { mode: 'development' });
  assert.equal(businessBroken.ok, false, '业务文件里的绝对路径必须继续被拦截');
  assert.equal(businessBroken.code, 'PATH_ESCAPE');

  // ③ 报告文件里「未声明」的绝对路径也要拦截（豁免只针对声明的那个值）
  const reportCopy = path.join(tempDir('w1-escape-report-'), 'project');
  fs.cpSync(outputPath, reportCopy, { recursive: true });
  const tamperedReport = readJson(path.join(reportCopy, 'generation-report.json'));
  tamperedReport.warnings = [...(tamperedReport.warnings || []), '备份位于 C:\\Users\\someone\\AppData\\backup'];
  writeJson(path.join(reportCopy, 'generation-report.json'), tamperedReport);
  const reportBroken = verifyOutput(reportCopy, { mode: 'development' });
  assert.equal(reportBroken.ok, false, '报告中未声明的绝对路径不得被豁免');
  assert.equal(reportBroken.code, 'PATH_ESCAPE');
});

// ------------------------------------------------------------------ W1-7

test('W1-7 缺 CLI / 非法路径 / 校验失败：不写 config、不启动', async (t) => {
  const { outputPath } = await buildOutput(t);
  applyAppid({ outputPath, appid: APPID_A });
  const configFile = path.join(outputPath, 'project.config.json');
  const configBefore = fs.readFileSync(configFile);

  // 非法路径
  const relative = await openProjectInDevtools({ projectPath: 'relative\\project' }, {});
  assert.equal(relative.ok, false);
  assert.equal(relative.code, 'PATH_INVALID');

  // 缺 CLI（其余全部就绪）
  const calls = [];
  const missingCli = await openProjectInDevtools({ projectPath: outputPath }, {
    env: {},
    existsSync: () => false,
    launcher: recordingLauncher(calls),
  });
  assert.equal(missingCli.ok, false);
  assert.equal(missingCli.code, 'DEVTOOLS_NOT_FOUND');
  assert.match(missingCli.message, /WX_CLI_PATH/);
  assert.equal(calls.length, 0);

  // 校验失败：篡改非目标产物文件后 refuse（launcher 仍为 0 次）
  fs.appendFileSync(path.join(outputPath, 'app.json'), '\n', 'utf8');
  const tamperedBefore = snapshotFiles(outputPath);
  const tampered = await openProjectInDevtools({ projectPath: outputPath }, launchOptions(calls));
  assert.equal(tampered.ok, false, '摘要不一致时不得启动开发者工具');
  assert.match(String(tampered.code), /OUTPUT_(TREE|MANIFEST)_MISMATCH|OUTPUT_REPORT_STALE/);
  assert.equal(calls.length, 0);
  assertSnapshotUnchanged(outputPath, tamperedBefore, '校验失败启动');
  assert.equal(Buffer.compare(fs.readFileSync(configFile), configBefore), 0, '启动链路不得写 project.config.json');
});

// ------------------------------------------------------------------ W1-8

test('W1-8 成功状态只到 generated / devtools-open-requested，不升级为 compiled', async (t) => {
  const composed = await buildOutput(t);
  const outputPath = composed.outputPath;

  // 导出报告明确记录"微信编译未运行"
  const report = readJson(path.join(outputPath, 'generation-report.json'));
  assert.equal(report.wechatCompile.result, 'not-run');

  applyAppid({ outputPath, appid: APPID_A });
  const calls = [];
  const launched = await openProjectInDevtools({ projectPath: outputPath }, launchOptions(calls));
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(calls.length, 1);
  assert.equal(launched.details.status, 'devtools-open-requested');
  assert.equal(launched.details.compiled, false);
  assert.equal(launched.details.appidFixed, false);
  assert.match(launched.message, /不代表编译通过/);
  assert.doesNotMatch(launched.message, /已编译|编译成功/);

  // 源码层面也不存在把状态提升为 compiled 的出口
  const launcherSource = fs.readFileSync(path.join(REPO, 'desktop', 'devtools-launch.cjs'), 'utf8');
  assert.doesNotMatch(launcherSource, /compiled:\s*true/);
  assert.doesNotMatch(launcherSource, /'compiled'/);
  assert.doesNotMatch(launcherSource, /ensurePreviewAppid|fallbackAppidFile/);
});


