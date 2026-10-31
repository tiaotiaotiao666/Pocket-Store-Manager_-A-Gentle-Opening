'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const { createComposerIpc, registerComposerIpc, isTrustedSender, MAX_PAYLOAD_BYTES } = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));

function createDialogStub(dir) {
  return {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }),
  };
}

function makeContext(options) {
  const opts = options || {};
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-contract-'));
  const compose = opts.compose || (async (payload) => {
    const outputPath = path.join(payload.parentDir, payload.projectName || 'demo');
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(path.join(outputPath, 'generation-report.json'), JSON.stringify({ checks: [{ id: 'static-check', result: 'pass' }] }));
    fs.writeFileSync(path.join(outputPath, 'composition.lock.json'), JSON.stringify({ lockVersion: 'lock.v1' }));
    if (typeof payload.onProgress === 'function') {
      payload.onProgress({ stage: 'emit', step: 6, total: 9, message: '生成工程' });
    }
    return { ok: true, outputPath, lockDigest: 'sha256:' + 'a'.repeat(64) };
  });
  const created = createComposerIpc({
    dialog: createDialogStub(parent),
    shell: { openPath: async () => '' },
    compose,
    validateComposition: () => ({ ok: true, warnings: [] }),
  });
  return { parent, created, compose };
}

function senderEvent(url) {
  return {
    senderFrame: { url },
    sender: { send: () => {} },
  };
}

test('来源校验只接受 file:// 与本地开发地址', () => {
  assert.strictEqual(isTrustedSender(senderEvent('file:///C:/app/index.html')), true);
  assert.strictEqual(isTrustedSender(senderEvent('http://127.0.0.1:5173/')), true);
  assert.strictEqual(isTrustedSender(senderEvent('https://evil.example.com/')), false);
  assert.strictEqual(isTrustedSender({}), false);
});

test('registerComposerIpc 拒绝不可信来源', async () => {
  const handlers = {};
  const ipcMain = { handle: (channel, handler) => { handlers[channel] = handler; } };
  const ctx = makeContext();
  registerComposerIpc(ipcMain, {
    dialog: createDialogStub(ctx.parent),
    shell: { openPath: async () => '' },
    compose: ctx.compose,
    validateComposition: () => ({ ok: true }),
  });
  assert.ok(Object.keys(handlers).includes('composer:export'));
  assert.ok(Object.keys(handlers).includes('composer:preflight-target'));
  const untrusted = await handlers['composer:export'](senderEvent('https://evil.example.com/'), {});
  assert.strictEqual(untrusted.code, 'UNTRUSTED_SENDER');

  const trusted = await handlers['composer:choose-directory'](senderEvent('http://127.0.0.1:5173/'), {});
  assert.strictEqual(trusted.cancelled, false);
  assert.ok(trusted.path);
});

test('未获白名单的父目录拒绝导出', async () => {
  const { created, parent } = makeContext();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-unapproved-'));
  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: other,
    plan: { planId: 'order-classic' },
    projectName: 'demo',
  });
  assert.strictEqual(result.code, 'TARGET_NOT_WRITABLE');
  assert.ok(!fs.existsSync(path.join(other, 'demo')));
  assert.ok(fs.existsSync(parent));
});

test('系统对话框确认后才允许导出并生成报告', async () => {
  const { created, parent } = makeContext();
  const chosen = await created.handlers['composer:choose-directory'](senderEvent('file:///x'), {});
  assert.strictEqual(chosen.cancelled, false);
  assert.strictEqual(chosen.path, parent);

  const exported = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: chosen.path,
    plan: { planId: 'order-classic' },
    projectName: 'demo',
  });
  assert.strictEqual(exported.ok, true);
  assert.ok(fs.existsSync(path.join(exported.outputPath, 'generation-report.json')));

  const report = await created.handlers['composer:read-report'](senderEvent('file:///x'), { outputPath: exported.outputPath });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.report.checks[0].id, 'static-check');

  const denied = await created.handlers['composer:read-report'](senderEvent('file:///x'), { outputPath: parent });
  assert.strictEqual(denied.code, 'TARGET_NOT_WRITABLE');
});

test('超体积 payload 被拒绝', async () => {
  const { created, parent } = makeContext();
  const chosen = await created.handlers['composer:choose-directory'](senderEvent('file:///x'), {});
  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: chosen.path,
    plan: {},
    projectName: 'demo',
    padding: 'x'.repeat(MAX_PAYLOAD_BYTES + 10),
  });
  assert.strictEqual(result.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(!fs.existsSync(path.join(parent, 'demo')));

  const bigPlan = await created.handlers['composer:validate'](senderEvent('file:///x'), {
    plan: { blob: 'y'.repeat(65 * 1024) },
  });
  assert.strictEqual(bigPlan.code, 'PAYLOAD_TOO_LARGE');
});

test('目标预检只读：目标不存在时不创建任何文件', async () => {
  const { created, parent } = makeContext();
  const before = fs.readdirSync(parent).sort();
  const result = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: parent,
    projectName: '松月食堂',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.projectName, '松月食堂');
  assert.strictEqual(result.suggestedName, null);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), before);
});

test('目标预检：同名目标已存在时报告 exists 且内容不变', async () => {
  const { created, parent } = makeContext();
  const target = path.join(parent, '松月食堂');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');

  const result = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: parent,
    projectName: '松月食堂',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.exists, true);
  assert.strictEqual(result.suggestedName, '松月食堂-2');
  assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  assert.deepStrictEqual(fs.readdirSync(target), ['keep.txt']);
});

test('目标预检：项目名清洗与 Composer 一致，不能跳出父目录', async () => {
  const { created, parent } = makeContext();
  const outside = path.dirname(parent);

  const traversal = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: parent,
    projectName: '../../escape',
  });
  assert.strictEqual(traversal.ok, true);
  assert.strictEqual(traversal.projectName, '..-..-escape');
  assert.ok(!traversal.projectName.includes('/'));
  assert.ok(!traversal.projectName.includes('\\'));
  assert.ok(!fs.existsSync(path.join(outside, 'escape')));

  const trailing = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: parent,
    projectName: '松月食堂. .',
  });
  assert.strictEqual(trailing.projectName, '松月食堂');

  const slashed = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: parent,
    projectName: 'a/b\\c:d*e?f"g<h>i|j',
  });
  assert.strictEqual(slashed.projectName, 'a-b-c-d-e-f-g-h-i-j');
});

test('目标预检：父目录缺失或参数非法返回失败，且不创建目录', async () => {
  const { created, parent } = makeContext();
  const missing = path.join(parent, 'not-created');

  const absent = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: missing,
    projectName: 'demo',
  });
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.code, 'TARGET_PARENT_MISSING');
  assert.strictEqual(fs.existsSync(missing), false);

  const noParent = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    projectName: 'demo',
  });
  assert.strictEqual(noParent.ok, false);
  assert.strictEqual(noParent.code, 'TARGET_PARENT_MISSING');

  const notDir = path.join(parent, 'file.txt');
  fs.writeFileSync(notDir, 'x');
  const fileParent = await created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: notDir,
    projectName: 'demo',
  });
  assert.strictEqual(fileParent.ok, false);
  assert.strictEqual(fileParent.code, 'TARGET_PARENT_MISSING');
});

test('目标预检：不可信来源被拒绝', async () => {
  const handlers = {};
  const ipcMain = { handle: (channel, handler) => { handlers[channel] = handler; } };
  registerComposerIpc(ipcMain, {
    dialog: createDialogStub('C:/tmp'),
    shell: { openPath: async () => '' },
    compose: async () => ({ ok: true }),
    validateComposition: () => ({ ok: true }),
  });
  const result = await handlers['composer:preflight-target'](senderEvent('https://evil.example.com/'), {
    parentDir: 'C:/tmp',
    projectName: 'demo',
  });
  assert.strictEqual(result.code, 'UNTRUSTED_SENDER');
});

test('并发导出返回 EXPORT_BUSY，取消可中断', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const compose = async (payload) => {
    await pending;
    return payload.signal.cancelled
      ? { ok: false, code: 'EXPORT_CANCELLED' }
      : { ok: true, outputPath: path.join(payload.parentDir, payload.projectName) };
  };
  const { created } = makeContext({ compose });
  const chosen = await created.handlers['composer:choose-directory'](senderEvent('file:///x'), {});

  const first = created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: chosen.path,
    plan: {},
    projectName: 'demo',
  });
  const second = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: chosen.path,
    plan: {},
    projectName: 'demo-2',
  });
  assert.strictEqual(second.code, 'EXPORT_BUSY');

  const cancel = await created.handlers['composer:cancel'](senderEvent('file:///x'), {});
  assert.strictEqual(cancel.ok, true);
  release();
  const firstResult = await first;
  assert.strictEqual(firstResult.code, 'EXPORT_CANCELLED');
});

test('preload 只暴露白名单方法且进度订阅可退订', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const listenerSets = new Map();
  let exposed;
  const ipcRenderer = {
    on: (channel, handler) => { listenerSets.set(channel, handler); },
    invoke: async () => ({ ok: true }),
  };
  vm.runInNewContext(source, {
    require: (request) => {
      assert.strictEqual(request, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
        ipcRenderer,
      };
    },
    console,
  });
  assert.strictEqual(exposed.key, 'smartStore');
  const api = exposed.value;
  assert.strictEqual(api.isDesktop, true);
  ['chooseExportDirectory', 'composerValidate', 'composerPreflightTarget', 'composerExport', 'composerCancel', 'composerReadReport', 'onComposerProgress', 'exportProject', 'openPath', 'pickMaterials', 'saveImage'].forEach((name) => {
    assert.strictEqual(typeof api[name], 'function', '缺少桥接方法 ' + name);
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(api, 'ipcRenderer'), false);

  let received = null;
  const unsubscribe = api.onComposerProgress((event) => { received = event; });
  assert.strictEqual(typeof unsubscribe, 'function');
  listenerSets.get('composer:progress')({}, { stage: 'emit' });
  assert.strictEqual(received.stage, 'emit');
  unsubscribe();
  received = null;
  listenerSets.get('composer:progress')({}, { stage: 'verify' });
  assert.strictEqual(received, null);
});