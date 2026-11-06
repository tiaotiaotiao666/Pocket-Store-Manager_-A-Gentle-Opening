'use strict';

/**
 * T6 / C-REAL-PREVIEW@1 契约测试（node --test）。
 *
 * 覆盖：路径非法/不存在、截图 MIME/超限/取消、IPC 通道名与 preload 方法名、
 * JSON 回传结构、来源校验、以及“不执行任意 shell 命令”的源码约束。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const channel = require(path.join(REPO, 'desktop', 'preview-channel.cjs'));
const launcher = require(path.join(REPO, 'desktop', 'devtools-launch.cjs'));

const {
  PREVIEW_CHANNELS,
  PREVIEW_BRIDGE_METHODS,
  PREVIEW_ERROR_CODES,
  PREVIEW_MAX_SCREENSHOT_BYTES,
  toContractCode,
  validateProjectPath,
  validateScreenshotFile,
  openPreviewProject,
  registerPreviewIpc,
} = channel;

const TRUSTED_EVENT = Object.freeze({ senderFrame: { url: 'file:///C:/app/dist/index.html' } });
const UNTRUSTED_EVENT = Object.freeze({ senderFrame: { url: 'https://evil.example.com/' } });

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'real-preview-'));
}

function writeFile(dir, name, buffer) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, buffer);
  return target;
}

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channelName, handler) {
      handlers.set(channelName, handler);
    },
  };
}

// ---------- validateProjectPath ----------

test('validateProjectPath：相对路径返回 PREVIEW_PATH_INVALID', async () => {
  const result = await validateProjectPath('some/relative/project');

  assert.equal(result.ok, false);
  assert.equal(result.code, PREVIEW_ERROR_CODES.pathInvalid);
  assert.match(result.message, /绝对路径/);
  assert.equal(toContractCode(result.code), 'PATH_INVALID');
});

test('validateProjectPath：不存在的绝对目录返回 PREVIEW_PATH_NOT_FOUND', async () => {
  const missing = path.join(makeTempDir('real-preview-missing-'), 'not-exists');
  const result = await validateProjectPath(missing);

  assert.equal(result.ok, false);
  assert.equal(result.code, PREVIEW_ERROR_CODES.pathNotFound);
  assert.equal(toContractCode(result.code), 'PATH_MISSING');
});

test('validateProjectPath：文件路径（非目录）返回 PREVIEW_PATH_INVALID', async () => {
  const dir = makeTempDir();
  const file = writeFile(dir, 'plain.txt', Buffer.from('not a directory', 'utf8'));
  const result = await validateProjectPath(file);

  assert.equal(result.ok, false);
  assert.equal(result.code, PREVIEW_ERROR_CODES.pathInvalid);
  assert.match(result.message, /不是目录/);
});

test('validateProjectPath：合法导出目录通过并回传绝对路径与 project.config.json 提示', async () => {
  const dir = makeTempDir('real-preview-ok-');
  writeFile(dir, 'project.config.json', Buffer.from('{"appid":"wx123"}', 'utf8'));

  const normalized = path.join(dir, 'nested', '..');
  const result = await validateProjectPath(normalized);

  assert.equal(result.ok, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.hasProjectConfig, true);
  assert.equal(path.isAbsolute(result.path), true);
  assert.equal(path.normalize(result.path), path.normalize(dir));
});

test('validateProjectPath：非字符串/空串/超长路径全部返回 PREVIEW_PATH_INVALID', async () => {
  const cases = [null, undefined, 42, {}, '', '   ', 'x'.repeat(channel.PREVIEW_MAX_PATH_LENGTH + 1)];
  for (const input of cases) {
    const result = await validateProjectPath(input);
    assert.equal(result.ok, false, `输入 ${String(input)} 应被拒绝`);
    assert.equal(result.code, PREVIEW_ERROR_CODES.pathInvalid);
  }
});

// ---------- validateScreenshotFile ----------

test('validateScreenshotFile：取消（空路径）返回 { cancelled: true }', async () => {
  for (const input of [null, undefined, '']) {
    const result = await validateScreenshotFile(input);
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, PREVIEW_ERROR_CODES.screenshotCancelled);
  }
});

test('validateScreenshotFile：PNG 通过并返回契约字段（path/name/dataUrl/bytes）', async () => {
  const dir = makeTempDir();
  const file = writeFile(dir, 'home.png', PNG_BYTES);
  const result = await validateScreenshotFile(file);

  assert.equal(result.cancelled, false);
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.name, 'home.png');
  assert.equal(result.bytes, PNG_BYTES.length);
  assert.equal(result.path, path.resolve(file));
  assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(result.dataUrl.split(',')[1], 'base64').equals(PNG_BYTES), true);
});

test('validateScreenshotFile：JPEG 通过（按 magic bytes 判定为 image/jpeg）', async () => {
  const dir = makeTempDir();
  const file = writeFile(dir, 'home.jpg', JPEG_BYTES);
  const result = await validateScreenshotFile(file);

  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/jpeg');
  assert.ok(result.dataUrl.startsWith('data:image/jpeg;base64,'));
});

test('validateScreenshotFile：超过 8 MiB 返回 PREVIEW_SCREENSHOT_TOO_LARGE', async () => {
  const dir = makeTempDir();
  const oversized = Buffer.alloc(PREVIEW_MAX_SCREENSHOT_BYTES + 1);
  PNG_BYTES.copy(oversized, 0);
  const file = writeFile(dir, 'huge.png', oversized);

  const result = await validateScreenshotFile(file);

  assert.equal(result.cancelled, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, PREVIEW_ERROR_CODES.screenshotTooLarge);
  assert.match(result.message, /8 MiB/);
});

test('validateScreenshotFile：非 PNG/JPEG 内容与非法扩展名都被拒绝', async () => {
  const dir = makeTempDir();
  const textPng = writeFile(dir, 'fake.png', Buffer.from('just text, not an image', 'utf8'));
  const fakePng = await validateScreenshotFile(textPng);
  assert.equal(fakePng.ok, false);
  assert.equal(fakePng.code, PREVIEW_ERROR_CODES.screenshotUnsupportedType);

  const bmpWithPngContent = writeFile(dir, 'shot.bmp', PNG_BYTES);
  const badExtension = await validateScreenshotFile(bmpWithPngContent);
  assert.equal(badExtension.ok, false);
  assert.equal(badExtension.code, PREVIEW_ERROR_CODES.screenshotUnsupportedType);
});

// ---------- 通道名 / preload 方法名 ----------

test('通道名与契约一致，且 preload 方法名固定', () => {
  assert.equal(PREVIEW_CHANNELS.openProject, 'preview:open-project');
  assert.equal(PREVIEW_CHANNELS.pickScreenshot, 'preview:pick-screenshot');
  assert.deepEqual([...PREVIEW_BRIDGE_METHODS], ['openPreviewProject', 'pickPreviewScreenshot', 'openPreviewDevtools']);
});

test('preload 暴露 openPreviewProject / pickPreviewScreenshot，且不影响现有 smartStore 方法', async () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const invocations = [];
  let exposed = null;

  const electronStub = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        exposed = { key, api };
      },
    },
    ipcRenderer: {
      on() {},
      invoke(channelName, payload) {
        invocations.push({ channel: channelName, payload });
        return Promise.resolve({ ok: true });
      },
    },
  };

  const sandbox = {
    require(request) {
      if (request === 'electron') return electronStub;
      return require(request);
    },
    module: { exports: {} },
    console,
    Object,
    Set,
    Promise,
    __dirname: path.join(REPO, 'desktop'),
    __filename: path.join(REPO, 'desktop', 'preload.cjs'),
  };
  vm.runInNewContext(source, sandbox, { filename: 'preload.cjs' });

  assert.ok(exposed, 'preload 应通过 contextBridge 暴露 bridge');
  assert.equal(exposed.key, 'smartStore');
  const api = exposed.api;
  assert.equal(typeof api.openPreviewProject, 'function');
  assert.equal(typeof api.pickPreviewScreenshot, 'function');

  // 现有方法不回退：抽样校验若干关键方法与监听器仍在。
  for (const name of ['chooseExportDirectory', 'composerExport', 'projectSave', 'probeDevtools', 'onComposerProgress']) {
    assert.equal(typeof api[name], 'function', `smartStore.${name} 应保持可用`);
  }

  await api.openPreviewProject({ projectPath: 'C:\\exports\\demo' });
  await api.pickPreviewScreenshot();

  assert.deepEqual(invocations.map((item) => item.channel), [
    'preview:open-project',
    'preview:pick-screenshot',
  ]);
  assert.deepEqual(invocations[0].payload, { projectPath: 'C:\\exports\\demo' });
});

// ---------- IPC 回传结构 ----------

test('preview:open-project：非法路径回传 { ok:false, code:"PATH_INVALID" }，合法路径回传 { ok:true, message }', async () => {
  const ipcMain = createIpcMainStub();
  const opened = [];
  registerPreviewIpc(ipcMain, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async (dir) => { opened.push(dir); return ''; } },
  });

  const handler = ipcMain.handlers.get('preview:open-project');
  assert.equal(typeof handler, 'function');

  const bad = await handler(TRUSTED_EVENT, { projectPath: 'relative/dir' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PATH_INVALID');
  assert.equal(typeof bad.message, 'string');

  const missing = await handler(TRUSTED_EVENT, { projectPath: path.join(makeTempDir('real-preview-x-'), 'nope') });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PATH_MISSING');

  const dir = makeTempDir('real-preview-open-');
  writeFile(dir, 'project.config.json', Buffer.from('{}', 'utf8'));
  const good = await handler(TRUSTED_EVENT, { projectPath: dir });
  assert.equal(good.ok, true);
  assert.equal(typeof good.message, 'string');
  assert.match(good.message, /不代表已完成渲染/);
  assert.deepEqual(opened, [path.resolve(dir)]);
});

test('preview:open-project：只调用 shell.openPath，打开失败回传 DEVTOOLS_NOT_FOUND', async () => {
  const dir = makeTempDir('real-preview-fail-');
  const result = await openPreviewProject({ projectPath: dir }, {
    shell: { openPath: async () => '没有默认打开方式' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEVTOOLS_NOT_FOUND');
  assert.match(result.message, /手动在微信开发者工具中导入/);
});

test('preview:pick-screenshot：取消回传 { cancelled:true }，选中 PNG 回传契约字段', async () => {
  const ipcMain = createIpcMainStub();
  const dir = makeTempDir('real-preview-pick-');
  const file = writeFile(dir, 'menu.png', PNG_BYTES);
  let dialogResult = { canceled: true, filePaths: [] };

  registerPreviewIpc(ipcMain, {
    dialog: { showOpenDialog: async () => dialogResult },
    shell: { openPath: async () => '' },
  });
  const handler = ipcMain.handlers.get('preview:pick-screenshot');
  assert.equal(typeof handler, 'function');

  const cancelled = await handler(TRUSTED_EVENT);
  assert.equal(cancelled.cancelled, true);

  dialogResult = { canceled: false, filePaths: [file] };
  const picked = await handler(TRUSTED_EVENT);
  assert.equal(picked.cancelled, false);
  assert.equal(picked.ok, true);
  assert.deepEqual(Object.keys(picked).sort(), ['bytes', 'cancelled', 'dataUrl', 'mime', 'name', 'ok', 'path']);
  assert.equal(picked.name, 'menu.png');
  assert.equal(picked.bytes, PNG_BYTES.length);
  assert.ok(picked.dataUrl.startsWith('data:image/png;base64,'));

  dialogResult = { canceled: false, filePaths: [path.join(dir, 'fake.png')] };
  writeFile(dir, 'fake.png', Buffer.from('nope', 'utf8'));
  const rejected = await handler(TRUSTED_EVENT);
  assert.equal(rejected.cancelled, false);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, PREVIEW_ERROR_CODES.screenshotUnsupportedType);
});

test('IPC 拒绝不受信任来源（UNTRUSTED_SENDER）', async () => {
  const ipcMain = createIpcMainStub();
  registerPreviewIpc(ipcMain, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
  });

  const openResult = await ipcMain.handlers.get('preview:open-project')(UNTRUSTED_EVENT, { projectPath: 'C:\\x' });
  assert.equal(openResult.ok, false);
  assert.equal(openResult.code, 'UNTRUSTED_SENDER');

  const pickResult = await ipcMain.handlers.get('preview:pick-screenshot')(UNTRUSTED_EVENT);
  assert.equal(pickResult.ok, false);
  assert.equal(pickResult.code, 'UNTRUSTED_SENDER');
});

// ---------- 安全与文案约束 ----------

test('preview-channel 不引入 child_process / spawn / exec（不执行任意 shell 命令）', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preview-channel.cjs'), 'utf8');
  assert.equal(/child_process/.test(source), false);
  assert.equal(/\b(execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\b/.test(source), false);
});

test('RealPreviewPanel 文案明确“截图回传 ≠ 实时渲染”并含代理/AppID 人工步骤', () => {
  const jsx = fs.readFileSync(path.join(REPO, 'src', 'components', 'preview', 'RealPreviewPanel.jsx'), 'utf8');
  assert.match(jsx, /不是应用内实时渲染/);
  assert.match(jsx, /AppID/);
  assert.match(jsx, /proxyType/);
  assert.match(jsx, /选择截图/);
  assert.match(jsx, /不上传网络/);
  assert.match(jsx, /不写入导出工程/);
  assert.match(jsx, /import '\.\/real-preview\.css';/);
  // 浏览器模式降级：禁用按钮 + 说明
  assert.match(jsx, /smartStore/);
  assert.match(jsx, /浏览器模式/);

  const css = fs.readFileSync(path.join(REPO, 'src', 'components', 'preview', 'real-preview.css'), 'utf8');
  assert.match(css, /\.real-preview/);
});
// ---------- 预览新模块：微信开发者工具调起 ----------

test('preview:open-devtools 通道与桥接方法已登记', () => {
  assert.equal(PREVIEW_CHANNELS.openDevtools, 'preview:open-devtools');
  assert.ok(PREVIEW_BRIDGE_METHODS.includes('openPreviewDevtools'));

  const preload = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  assert.match(preload, /openPreviewDevtools/);
  assert.match(preload, /preview:open-devtools/);

  const ipcMain = createIpcMainStub();
  registerPreviewIpc(ipcMain, {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
  });
  assert.equal(typeof ipcMain.handlers.get('preview:open-devtools'), 'function');
});

test('resolveDevtoolsCli：优先 WX_CLI_PATH，找不到时返回 null', () => {
  const env = { WX_CLI_PATH: 'D:\\wx\\cli.bat' };
  assert.equal(
    launcher.resolveDevtoolsCli({ env, existsSync: (target) => target === env.WX_CLI_PATH }),
    env.WX_CLI_PATH,
  );
  assert.equal(launcher.resolveDevtoolsCli({ env: {}, existsSync: () => false }), null);
});

test('isShellSafePath 拒绝 cmd 特殊字符', () => {
  assert.equal(launcher.isShellSafePath('C:\\work\\shop'), true);
  assert.equal(launcher.isShellSafePath('C:\\work\\shop&calc'), false);
  assert.equal(launcher.isShellSafePath('C:\\work\\a"b'), false);
});

test('openPreviewInDevtools：目录不存在回传 PATH_MISSING', async () => {
  const result = await channel.openPreviewInDevtools({
    projectPath: path.join(makeTempDir('real-preview-devtools-'), 'nope'),
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PATH_MISSING');
});

test('openPreviewInDevtools：找到 CLI 时以 open --project 调起并 unref', async () => {
  const dir = makeTempDir('real-preview-devtools-ok-');
  writeFile(dir, 'project.config.json', Buffer.from('{}', 'utf8'));
  const calls = [];
  let unreffed = false;

  const result = await channel.openPreviewInDevtools({ projectPath: dir }, {
    env: { WX_CLI_PATH: 'D:\\wx\\cli.bat' },
    existsSync: (target) => target === 'D:\\wx\\cli.bat',
    launcher: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() { unreffed = true; } };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.equal(unreffed, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /cli\.bat/);
  assert.equal(calls[0].args[0], 'open');
  assert.equal(calls[0].args[1], '--project');
  assert.match(calls[0].args[2], /real-preview-devtools-ok-/);
});

test('openPreviewInDevtools：缺少 CLI 回传 DEVTOOLS_NOT_FOUND', async () => {
  const dir = makeTempDir('real-preview-devtools-missing-');
  const result = await channel.openPreviewInDevtools({ projectPath: dir }, {
    env: {},
    existsSync: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEVTOOLS_NOT_FOUND');
  assert.match(result.message, /WX_CLI_PATH/);
});