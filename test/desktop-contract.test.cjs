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
    validateComposition: opts.validateComposition || (() => ({ ok: true, warnings: [] })),
    ...(opts.defaultParentDir ? { defaultParentDir: opts.defaultParentDir } : {}),
    ...(opts.previewParentDir ? { previewParentDir: opts.previewParentDir } : {}),
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

test('角色参数经 IPC 透传到组合校验与导出', async () => {
  const seen = {};
  const { created, parent } = makeContext({
    validateComposition: (plan, options) => {
      seen.validateOptions = options;
      return { ok: true };
    },
    compose: async (payload) => {
      seen.exportRole = payload.role;
      return { ok: true, outputPath: path.join(payload.parentDir, payload.projectName) };
    },
  });
  const validated = await created.handlers['composer:validate'](senderEvent('file:///x'), {
    plan: { planId: 'order-classic' },
    role: 'customer',
  });
  assert.strictEqual(validated.ok, true);
  assert.deepStrictEqual(seen.validateOptions, { role: 'customer' });

  const chosen = await created.handlers['composer:choose-directory'](senderEvent('file:///x'), {});
  const exported = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: chosen.path,
    plan: { planId: 'order-classic' },
    projectName: 'demo',
    role: 'merchant',
  });
  assert.strictEqual(exported.ok, true);
  assert.strictEqual(seen.exportRole, 'merchant');
  assert.ok(fs.existsSync(parent));
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
  ['chooseExportDirectory', 'defaultExportDirectory', 'composerValidate', 'composerPreflightTarget', 'composerExport', 'composerCancel', 'composerReadReport', 'onComposerProgress', 'exportProject', 'openPath', 'pickMaterials', 'saveImage'].forEach((name) => {
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

// ---- P5c：界面内可见、可确认的默认导出位置 ----

test('P5c 默认导出位置由主进程决定，并把目录建好', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-default-'));
  const defaultDir = path.join(base, '轻启导出');
  const ctx = makeContext({ defaultParentDir: defaultDir });

  const target = await ctx.created.handlers['composer:default-target'](senderEvent('file:///x'), {});
  assert.strictEqual(target.ok, true);
  assert.strictEqual(target.path, path.resolve(defaultDir));
  assert.strictEqual(target.token, '__default__');
  assert.strictEqual(fs.existsSync(defaultDir), true, '默认导出位置应当被创建，用户才能直接导出');
  assert.strictEqual(ctx.created.approvedParents.has(path.resolve(defaultDir)), true);
});

test('P5c 用默认位置 token 直接导出，不需要弹原生目录对话框', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-export-'));
  const defaultDir = path.join(base, '轻启导出');
  let dialogCalls = 0;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-dialog-'));
  const created = createComposerIpc({
    dialog: {
      showOpenDialog: async () => {
        dialogCalls += 1;
        return { canceled: true, filePaths: [] };
      },
    },
    shell: { openPath: async () => '' },
    compose: async (payload) => {
      const outputPath = path.join(payload.parentDir, payload.projectName || 'demo');
      fs.mkdirSync(outputPath, { recursive: true });
      return { ok: true, outputPath, lockDigest: 'sha256:' + 'b'.repeat(64) };
    },
    validateComposition: () => ({ ok: true, warnings: [] }),
    defaultParentDir: defaultDir,
  });
  void parent;

  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: '柑橘小馆演示店',
  });

  assert.strictEqual(result.ok, true, '默认位置导出应当成功');
  assert.strictEqual(result.outputPath, path.join(path.resolve(defaultDir), '柑橘小馆演示店'));
  assert.strictEqual(dialogCalls, 0, '默认位置导出不应触发原生目录对话框');
  assert.strictEqual(created.exportedOutputs.has(result.outputPath), true);
});

test('P5c 默认位置导出前的只读预检也认这个 token', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-preflight-'));
  const defaultDir = path.join(base, '轻启导出');
  const ctx = makeContext({ defaultParentDir: defaultDir });

  const free = await ctx.created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: '__default__',
    projectName: '柑橘小馆演示店',
  });
  assert.strictEqual(free.ok, true);
  assert.strictEqual(free.exists, false);

  // 不静默覆盖：同名目录已存在时必须给出冲突与建议名。
  fs.mkdirSync(path.join(path.resolve(defaultDir), '柑橘小馆演示店'), { recursive: true });
  const taken = await ctx.created.handlers['composer:preflight-target'](senderEvent('file:///x'), {
    parentDir: '__default__',
    projectName: '柑橘小馆演示店',
  });
  assert.strictEqual(taken.ok, true);
  assert.strictEqual(taken.exists, true);
  assert.ok(taken.suggestedName && taken.suggestedName !== '柑橘小馆演示店', '应给出不覆盖的建议名');
});

test('P5c 未配置默认位置时明确报错，不回落到任意路径', async () => {
  const ctx = makeContext();
  const target = await ctx.created.handlers['composer:default-target'](senderEvent('file:///x'), {});
  assert.strictEqual(target.ok, false);
  assert.strictEqual(target.code, 'TARGET_PARENT_MISSING');

  const exported = await ctx.created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(exported.ok, false);
  assert.strictEqual(exported.code, 'TARGET_PARENT_MISSING');
});

test('P5c 默认位置建不出来时明确报错，界面不会给一个坏按钮', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-blocked-'));
  const blocker = path.join(base, 'blocked');
  fs.writeFileSync(blocker, 'x');
  const ctx = makeContext({ defaultParentDir: path.join(blocker, '轻启导出') });

  const target = await ctx.created.handlers['composer:default-target'](senderEvent('file:///x'), {});
  assert.strictEqual(target.ok, false);
  assert.strictEqual(target.code, 'TARGET_PARENT_MISSING');

  const exported = await ctx.created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(exported.ok, false);
  assert.strictEqual(exported.code, 'TARGET_PARENT_MISSING');
  assert.match(exported.message, /选择其他目录/);
  assert.strictEqual(ctx.created.approvedParents.has(path.resolve(base, 'blocked', '轻启导出')), false);
});

test('P5c 目录改名被系统拒绝时整段重试，成功后再交付', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-retry-'));
  const defaultDir = path.join(base, 'exports');
  let attempts = 0;
  const created = createComposerIpc({
    dialog: createDialogStub(base),
    shell: { openPath: async () => '' },
    compose: async (payload) => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, code: 'COMMIT_FAILED', message: '目录提交失败：EPERM' };
      }
      const outputPath = path.join(payload.parentDir, payload.projectName || 'demo');
      fs.mkdirSync(outputPath, { recursive: true });
      return { ok: true, outputPath, lockDigest: 'sha256:' + 'c'.repeat(64) };
    },
    validateComposition: () => ({ ok: true, warnings: [] }),
    defaultParentDir: defaultDir,
    commitRetryDelays: [1, 1],
    enableCommitFallback: false,
  });

  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(attempts, 3, '应当在失败后重试到成功，而不是第一次失败就放弃');
  assert.strictEqual(created.exportedOutputs.has(result.outputPath), true);
});

test('P5c 重试次数用尽后仍然如实失败，不假装成功', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-retry-fail-'));
  let attempts = 0;
  const created = createComposerIpc({
    dialog: createDialogStub(base),
    shell: { openPath: async () => '' },
    compose: async () => {
      attempts += 1;
      return { ok: false, code: 'COMMIT_FAILED', message: '目录提交失败：EPERM' };
    },
    validateComposition: () => ({ ok: true, warnings: [] }),
    defaultParentDir: path.join(base, 'exports'),
    commitRetryDelays: [1, 1],
    enableCommitFallback: false,
  });

  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'COMMIT_FAILED');
  assert.strictEqual(attempts, 3);
  assert.strictEqual(created.exportedOutputs.size, 0);
});

test('P5c 主进程提交失败后改用 node 子进程重跑同一个 Composer', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-fallback-'));
  const defaultDir = path.join(base, 'exports');
  const fallbackCalls = [];
  const created = createComposerIpc({
    dialog: createDialogStub(base),
    shell: { openPath: async () => '' },
    compose: async () => ({ ok: false, code: 'COMMIT_FAILED', message: '目录提交失败：EPERM' }),
    composeInNode: async (options) => {
      fallbackCalls.push(options);
      const outputPath = path.join(options.parentDir, options.projectName);
      fs.mkdirSync(outputPath, { recursive: true });
      return { ok: true, outputPath, lockDigest: 'sha256:' + 'd'.repeat(64), fileCount: 1 };
    },
    validateComposition: () => ({ ok: true, warnings: [] }),
    defaultParentDir: defaultDir,
    commitRetryDelays: [1, 1],
  });

  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fallbackCalls.length, 1);
  assert.strictEqual(path.resolve(fallbackCalls[0].parentDir), path.resolve(defaultDir), '兜底仍必须落在已确认的默认位置');
  assert.strictEqual(fallbackCalls[0].plan.planVersion, 'p.v1');
  assert.strictEqual(created.exportedOutputs.has(result.outputPath), true);
});

test('P5c node 子进程兜底也失败时如实返回失败', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-fallback-fail-'));
  const created = createComposerIpc({
    dialog: createDialogStub(base),
    shell: { openPath: async () => '' },
    compose: async () => ({ ok: false, code: 'COMMIT_FAILED', message: '目录提交失败：EPERM' }),
    composeInNode: async () => ({ ok: false, code: 'COMMIT_FAILED', message: '目录提交失败：EPERM' }),
    validateComposition: () => ({ ok: true, warnings: [] }),
    defaultParentDir: path.join(base, 'exports'),
    commitRetryDelays: [1, 1],
  });

  const result = await created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: '__default__',
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'COMMIT_FAILED');
  assert.strictEqual(created.exportedOutputs.size, 0);
});

test('P5c 未在对话框确认的任意路径仍然被拒绝', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p5c-unapproved-'));
  const ctx = makeContext({ defaultParentDir: path.join(base, '轻启导出') });
  const result = await ctx.created.handlers['composer:export'](senderEvent('file:///x'), {
    parentDir: path.join(base, '别人选的目录'),
    plan: { planVersion: 'p.v1' },
    projectName: 'demo',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'TARGET_NOT_WRITABLE');
});

// ---- B3：Workspace Agent preload 命名空间（只做加法断言，不改既有 preload 断言） ----

test('B3：preload workspaceAgent 只暴露 19 个语义命令 + onProgress，旧 API 与订阅不变', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const listenerSets = new Map();
  const invocations = [];
  let exposed;
  const ipcRenderer = {
    on: (channel, handler) => { listenerSets.set(channel, handler); },
    invoke: async (channel, payload) => {
      invocations.push({ channel, payload });
      return { ok: true, data: { channel }, issues: [], meta: {} };
    },
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
  const workspaceAgent = api.workspaceAgent;
  assert.ok(workspaceAgent && typeof workspaceAgent === 'object');
  assert.strictEqual(Object.isFrozen(workspaceAgent), true);

  const methods = [
    'getContext', 'listFiles', 'readFile', 'searchFiles', 'writeFiles', 'deleteFiles',
    'addImageAsset', 'getDiff', 'runCheck', 'verifyWechat', 'readVerification', 'readArtifact',
    'submitCandidate', 'versions', 'adoptVersion', 'undo', 'redo', 'reopen', 'cancelRun',
  ];
  assert.deepStrictEqual(Object.keys(workspaceAgent).sort(), [...methods, 'onProgress'].sort());
  for (const method of methods) {
    assert.strictEqual(typeof workspaceAgent[method], 'function', '缺少 workspaceAgent.' + method);
  }
  assert.strictEqual(typeof workspaceAgent.onProgress, 'function');
  for (const forbidden of ['ipcRenderer', 'invoke', 'send', 'readFileSync', 'exec', 'spawn']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(workspaceAgent, forbidden), false, '不得暴露 ' + forbidden);
  }

  // 旧 smartStore API 继续存在（B3 不改旧链）。
  for (const legacy of ['projectLoad', 'projectSave', 'composerExport', 'exportProject', 'analyzeFrontend', 'onFrontendProgress', 'attachImages']) {
    assert.strictEqual(typeof api[legacy], 'function', '旧 API 丢失：' + legacy);
  }

  // 19 个方法只映射到冻结的 agent:* channel；payload 原样交给主进程再校验。
  const expectedChannels = [
    'agent:get-context', 'agent:list-files', 'agent:read-file', 'agent:search-files',
    'agent:write-files', 'agent:delete-files', 'agent:add-image-asset', 'agent:get-diff',
    'agent:run-check', 'agent:verify-wechat', 'agent:read-verification', 'agent:read-artifact',
    'agent:submit-candidate', 'agent:versions', 'agent:adopt-version', 'agent:undo',
    'agent:redo', 'agent:reopen', 'agent:cancel-run',
  ];
  for (const [index, method] of methods.entries()) {
    invocations.length = 0;
    workspaceAgent[method]({ projectId: 'p_abc12345' });
    assert.strictEqual(invocations.length, 1, method);
    assert.strictEqual(invocations[0].channel, expectedChannels[index]);
    assert.strictEqual(invocations[0].channel.startsWith('agent:'), true);
  }

  // 进度订阅：agent:progress → onProgress；退订后不再触发。
  assert.strictEqual(typeof listenerSets.get('agent:progress'), 'function');
  let received = null;
  const unsubscribe = workspaceAgent.onProgress((payload) => { received = payload; });
  assert.strictEqual(typeof unsubscribe, 'function');
  listenerSets.get('agent:progress')({}, { status: 'running', stage: 'write' });
  assert.strictEqual(received.stage, 'write');
  unsubscribe();
  received = null;
  listenerSets.get('agent:progress')({}, { status: 'succeeded' });
  assert.strictEqual(received, null);
});