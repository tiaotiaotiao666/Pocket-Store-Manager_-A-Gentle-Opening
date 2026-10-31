'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const {
  createProjectStore,
  createBlankDocument,
  generateProjectId,
  sanitizeProjectName,
  writeFileAtomic,
  PROJECT_ID_RE,
  MAX_PROJECT_BYTES,
} = require(path.join(REPO, 'desktop', 'project-store.cjs'));
const { createAssetStore } = require(path.join(REPO, 'desktop', 'asset-store.cjs'));
const { createSettingsStore, normalizeConfig } = require(path.join(REPO, 'desktop', 'settings-store.cjs'));
const { registerProjectIpc } = require(path.join(REPO, 'desktop', 'project-ipc.cjs'));
const { recoverPendingWrites } = require(path.join(REPO, 'desktop', 'flush-guard.cjs'));

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'p0-store-'));
}

function senderEvent(url) {
  return { senderFrame: { url }, sender: { send: () => {} } };
}

function dialogStub(paths) {
  return { showOpenDialog: async () => ({ canceled: false, filePaths: paths }) };
}

function writePng(file) {
  const buffer = Buffer.alloc(64, 0);
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1200, 16);
  buffer.writeUInt32BE(800, 20);
  fs.writeFileSync(file, buffer);
  return buffer;
}

function makeStore(options) {
  const userDataDir = (options && options.userDataDir) || makeTempDir('p0-userdata-');
  const store = createProjectStore({ userDataDir, ...(options || {}) });
  return { userDataDir, store };
}

async function createAndSave(store) {
  const created = await store.createProject({ name: '松月食堂' });
  return { created, path: path.join(store.projectsDir, created.projectId, 'project.json') };
}

test('projectId 生成符合契约并避开目录保留名', () => {
  for (let index = 0; index < 20; index += 1) {
    const id = generateProjectId(Date.now(), (size) => Buffer.alloc(size, index));
    assert.match(id, PROJECT_ID_RE);
  }
  assert.strictEqual(sanitizeProjectName('a/b:c*?"<>|'), 'a-b-c------');
  assert.strictEqual(sanitizeProjectName('   '), 'smart-store');
});

test('create → save → load 往返，updatedAt 由主进程回填', async () => {
  const { store } = makeStore();
  const { created, path: file } = await createAndSave(store);
  const loaded = await store.loadProject(created.projectId);
  assert.strictEqual(loaded.doc.projectId, created.projectId);
  assert.strictEqual(loaded.doc.schemaVersion, 1);
  assert.strictEqual(loaded.doc.name, '松月食堂');

  const doc = { ...loaded.doc, name: '松月食堂 · 二店', phase: 'deploy' };
  const saved = await store.saveProject(created.projectId, doc);
  assert.ok(saved.savedAt);
  assert.ok(saved.bytes > 0);
  assert.strictEqual(saved.rev, 1);

  const text = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.name, '松月食堂 · 二店');
  assert.strictEqual(parsed.phase, 'deploy');
  assert.ok(!text.includes('project.json.tmp'));
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('原子写覆盖已存在文件后内容稳定（Windows 三步法）', async () => {
  const dir = makeTempDir('p0-atomic-');
  const target = path.join(dir, 'project.json');
  await writeFileAtomic(target, '{"v":1}\n');
  await writeFileAtomic(target, '{"v":2}\n');
  await writeFileAtomic(target, '{"v":3}\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"v":3}\n');
  assert.ok(!fs.existsSync(`${target}.tmp`));
  assert.ok(!fs.existsSync(`${target}.old`));
});

test('超过 1 MiB 的文档被拒绝且磁盘不变', async () => {
  const { store } = makeStore();
  const { created, path: file } = await createAndSave(store);
  const before = fs.readFileSync(file, 'utf8');
  const loaded = await store.loadProject(created.projectId);
  const huge = { ...loaded.doc, visual: { ...loaded.doc.visual, prompt: 'x'.repeat(MAX_PROJECT_BYTES + 1024) } };
  await assert.rejects(() => store.saveProject(created.projectId, huge), (error) => error.code === 'PROJECT_TOO_LARGE');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('备份轮转不超过 maxBackups 份', async () => {
  const { store } = makeStore({ maxBackups: 3 });
  const { created, path: file } = await createAndSave(store);
  for (let index = 1; index <= 6; index += 1) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    await store.saveProject(created.projectId, { ...current, name: `第 ${index} 版` });
  }
  const backupsDir = path.join(path.dirname(file), 'backups');
  const backups = fs.readdirSync(backupsDir).filter((name) => /^project\.\d+\.json$/.test(name));
  assert.ok(backups.length <= 3, `备份数 ${backups.length} 超过 3`);
  assert.ok(backups.length >= 1);
});

test('并发保存三次：最终内容为最后一次，无 tmp 残留', async () => {
  const { store } = makeStore({ userDataDir: makeTempDir('p0-concurrent-') });
  const { created } = await createAndSave(store);
  const base = (await store.loadProject(created.projectId)).doc;
  const save = (name) => store.saveProject(created.projectId, { ...base, name });
  const results = await Promise.all([save('第一次'), save('第二次'), save('第三次')]);
  assert.strictEqual(results.length, 3);
  const file = path.join(store.projectsDir, created.projectId, 'project.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).name, '第三次');
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('删除必须 confirmName 完全一致，通过后移动到回收站', async () => {
  const { store } = makeStore();
  const { created } = await createAndSave(store);
  await assert.rejects(
    () => store.deleteProject(created.projectId, '松月'),
    (error) => error.code === 'PROJECT_DELETE_CONFIRM_MISMATCH',
  );
  assert.ok(fs.existsSync(path.join(store.projectsDir, created.projectId)));
  const result = await store.deleteProject(created.projectId, '松月食堂');
  assert.strictEqual(result.trashed, true);
  assert.ok(fs.existsSync(result.trashPath));
  assert.ok(!fs.existsSync(path.join(store.projectsDir, created.projectId)));
});

test('损坏主文件时从最近备份恢复', async () => {
  const { store } = makeStore();
  const { created, path: file } = await createAndSave(store);
  await store.saveProject(created.projectId, { ...(await store.loadProject(created.projectId)).doc, name: '备份里的名字' });
  await store.saveProject(created.projectId, { ...(await store.loadProject(created.projectId)).doc, name: '最新名字' });
  fs.writeFileSync(file, '{ 坏掉的 JSON');
  const loaded = await store.loadProject(created.projectId);
  assert.ok(loaded.recoveredFrom);
  assert.strictEqual(loaded.doc.name, '备份里的名字');
});

test('主文件与备份都损坏时：保留 damage 文件并返回空白项目', async () => {
  const { store } = makeStore();
  const { created, path: file } = await createAndSave(store);
  fs.writeFileSync(file, '{ 坏掉的 JSON');
  const loaded = await store.loadProject(created.projectId);
  assert.strictEqual(loaded.corrupt, true);
  assert.strictEqual(loaded.doc.projectId, created.projectId);
  const corruptFiles = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('project.corrupt.'));
  assert.strictEqual(corruptFiles.length, 1);
});

test('高版本项目只读标记 futureVersion', async () => {
  const { store } = makeStore();
  const { created, path: file } = await createAndSave(store);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...current, schemaVersion: 2 }));
  const loaded = await store.loadProject(created.projectId);
  assert.strictEqual(loaded.futureVersion, true);
  await assert.rejects(
    () => store.saveProject(created.projectId, { ...loaded.doc, schemaVersion: 2 }),
    (error) => error.code === 'PROJECT_FUTURE_VERSION',
  );
});

test('未知顶层字段保存时归入 unmappedFields', async () => {
  const { store } = makeStore();
  const { created } = await createAndSave(store);
  const doc = { ...(await store.loadProject(created.projectId)).doc, futureThing: { keep: true } };
  await store.saveProject(created.projectId, doc);
  const loaded = await store.loadProject(created.projectId);
  assert.strictEqual(loaded.doc.futureThing, undefined);
  assert.deepStrictEqual(loaded.doc.unmappedFields, { futureThing: { keep: true } });
});

test('非法 projectId 一律拒绝', async () => {
  const { store } = makeStore();
  for (const id of ['../../etc/passwd', 'p_../../x', 'p_short', 'x_12345678']) {
    await assert.rejects(() => store.loadProject(id), (error) => error.code === 'PROJECT_INVALID_ID');
  }
});

test('图片两段式：pick 只返回元数据，attach 落盘去重', async () => {
  const { userDataDir } = makeStore();
  const store = createProjectStore({ userDataDir });
  const assets = createAssetStore({ userDataDir });
  const { created } = await createAndSave(store);
  const file = path.join(makeTempDir('p0-img-'), '门头.png');
  writePng(file);

  const picked = await assets.pickImages(dialogStub([file]), { max: 1 });
  assert.strictEqual(picked.items.length, 1);
  assert.ok(picked.items[0].token);
  assert.strictEqual(picked.items[0].width, 1200);
  assert.strictEqual(picked.items[0].height, 800);
  assert.strictEqual(picked.items[0].dataUrl, undefined);

  const attached = await assets.attachImages(created.projectId, [picked.items[0].token]);
  assert.strictEqual(attached.assets.length, 1);
  assert.match(attached.assets[0].assetId, /^a_[0-9a-f]{16}$/);
  assert.ok(fs.existsSync(path.join(userDataDir, 'projects', created.projectId, 'assets', 'images', attached.assets[0].fileName)));

  const secondPick = await assets.pickImages(dialogStub([file]), { max: 1 });
  const second = await assets.attachImages(created.projectId, [secondPick.items[0].token]);
  assert.strictEqual(second.assets[0].assetId, attached.assets[0].assetId);
  const files = fs.readdirSync(path.join(userDataDir, 'projects', created.projectId, 'assets', 'images'));
  assert.strictEqual(files.length, 1, '同一内容不应重复落盘');

  const asset = await assets.readAsset(created.projectId, attached.assets[0].assetId);
  assert.ok(asset.dataUrl.startsWith('data:image/png;base64,'));
});

test('未 pick 的 token 与过期 token 被拒绝', async () => {
  const { userDataDir } = makeStore();
  const store = createProjectStore({ userDataDir });
  let clock = 1000;
  const assets = createAssetStore({ userDataDir, now: () => clock });
  const { created } = await createAndSave(store);

  await assert.rejects(
    () => assets.attachImages(created.projectId, ['not-a-token']),
    (error) => error.code === 'ASSET_TOKEN_UNKNOWN',
  );

  const file = path.join(makeTempDir('p0-img-expire-'), 'a.png');
  writePng(file);
  const picked = await assets.pickImages(dialogStub([file]), { max: 1 });
  clock += 301 * 1000;
  await assert.rejects(
    () => assets.attachImages(created.projectId, [picked.items[0].token]),
    (error) => error.code === 'ASSET_TOKEN_EXPIRED',
  );
});

test('被业务字段引用的资产不会被静默删除', async () => {
  const { userDataDir } = makeStore();
  const store = createProjectStore({ userDataDir });
  const assets = createAssetStore({ userDataDir });
  const { created } = await createAndSave(store);
  const file = path.join(makeTempDir('p0-img-ref-'), 'logo.png');
  writePng(file);
  const picked = await assets.pickImages(dialogStub([file]), { max: 1 });
  const attached = await assets.attachImages(created.projectId, [picked.items[0].token]);
  const assetId = attached.assets[0].assetId;

  const doc = (await store.loadProject(created.projectId)).doc;
  await store.saveProject(created.projectId, { ...doc, store: { ...doc.store, logoAssetId: assetId } });
  const refused = await assets.removeAsset(created.projectId, assetId);
  assert.strictEqual(refused.removed, false);
  assert.deepStrictEqual(refused.affectedRefs, ['store.logoAssetId']);

  const nextDoc = (await store.loadProject(created.projectId)).doc;
  await store.saveProject(created.projectId, { ...nextDoc, store: { ...nextDoc.store, logoAssetId: null } });
  const removed = await assets.removeAsset(created.projectId, assetId);
  assert.strictEqual(removed.removed, true);
});

test('设置：默认值、键白名单、敏感键拒绝', async () => {
  const userDataDir = makeTempDir('p0-settings-');
  const settings = createSettingsStore({ userDataDir });
  const loaded = await settings.loadConfig();
  assert.strictEqual(loaded.source, 'default');
  assert.strictEqual(loaded.config.apiBaseUrl, 'http://127.0.0.1:3000/api/v1');

  await assert.rejects(
    () => settings.saveConfig({ ...loaded.config, DEEPSEEK_API_KEY: 'sk-xxx' }),
    (error) => error.code === 'SETTINGS_INVALID',
  );

  const saved = await settings.saveConfig({ ...loaded.config, agentTransport: 'http', extraSetting: 1 });
  assert.strictEqual(saved.config.agentTransport, 'http');
  assert.deepStrictEqual(saved.config.unmappedFields, { extraSetting: 1 });

  const reloaded = await settings.loadConfig();
  assert.strictEqual(reloaded.source, 'file');
  assert.strictEqual(reloaded.config.agentTransport, 'http');
});

test('IPC：不可信来源被拒绝，project:save 体积与删除确认生效', async () => {
  const userDataDir = makeTempDir('p0-ipc-');
  const store = createProjectStore({ userDataDir });
  const assets = createAssetStore({ userDataDir });
  const settings = createSettingsStore({ userDataDir });
  const handlers = {};
  const ipcMain = { handle: (channel, handler) => { handlers[channel] = handler; } };
  registerProjectIpc(ipcMain, {
    store,
    assets,
    settings,
    dialog: dialogStub([]),
    shell: { openPath: async () => '' },
  });

  assert.ok(handlers['project:list']);
  assert.ok(handlers['project:save']);
  assert.ok(handlers['settings:save']);

  const untrusted = await handlers['project:list'](senderEvent('https://evil.example.com/'), {});
  assert.strictEqual(untrusted.code, 'UNTRUSTED_SENDER');

  const created = await handlers['project:create'](senderEvent('file:///x'), { name: '测试店' });
  assert.strictEqual(created.ok, true);

  const invalid = await handlers['project:load'](senderEvent('file:///x'), { projectId: '../../etc/passwd' });
  assert.strictEqual(invalid.code, 'PROJECT_INVALID_ID');

  const tooLarge = await handlers['project:save'](senderEvent('file:///x'), {
    projectId: created.data.projectId,
    doc: { blob: 'x'.repeat(1.3 * 1024 * 1024) },
  });
  assert.strictEqual(tooLarge.code, 'PROJECT_TOO_LARGE');

  const mismatch = await handlers['project:delete'](senderEvent('file:///x'), {
    projectId: created.data.projectId,
    confirmName: '测试',
  });
  assert.strictEqual(mismatch.code, 'PROJECT_DELETE_CONFIRM_MISMATCH');

  const list = await handlers['project:list'](senderEvent('file:///x'), {});
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.data.projects.length, 1);
});

test('flush 自愈：更新的 tmp 替换主文件，旧 tmp 删除', async () => {
  const userDataDir = makeTempDir('p0-flush-');
  const store = createProjectStore({ userDataDir });
  const { created, path: file } = await createAndSave(store);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

  const tmp = `${file}.tmp`;
  const older = new Date(Date.now() - 5000);
  fs.writeFileSync(file, JSON.stringify({ ...doc, name: '旧内容' }));
  fs.utimesSync(file, older, older);
  fs.writeFileSync(tmp, JSON.stringify({ ...doc, name: '新内容' }));

  const result = await recoverPendingWrites(userDataDir);
  assert.strictEqual(result.recovered.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).name, '新内容');
  assert.ok(!fs.existsSync(tmp));

  fs.writeFileSync(tmp, JSON.stringify({ ...doc, name: '更旧' }));
  const oldTmp = new Date(Date.now() - 10000);
  fs.utimesSync(tmp, oldTmp, oldTmp);
  const second = await recoverPendingWrites(userDataDir);
  assert.strictEqual(second.discarded.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).name, '新内容');
});

test('preload 暴露新增方法，且不泄漏 ipcRenderer', () => {
  const source = fs.readFileSync(path.join(REPO, 'desktop', 'preload.cjs'), 'utf8');
  const channels = new Map();
  let exposed;
  const ipcRenderer = {
    on: (channel, handler) => { channels.set(channel, handler); },
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
  const api = exposed.value;
  assert.strictEqual(exposed.key, 'smartStore');
  [
    'projectList', 'projectCreate', 'projectLoad', 'projectSave', 'projectDelete', 'projectReveal',
    'pickImages', 'attachImages', 'readAsset', 'removeAsset',
    'settingsLoad', 'settingsSave', 'diagnosticsRun', 'diagnosticsSaveSnapshot',
    'applyAppid', 'probeDevtools', 'onProjectFlushRequest', 'reportFlushDone',
  ].forEach((name) => {
    assert.strictEqual(typeof api[name], 'function', '缺少桥接方法 ' + name);
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(api, 'ipcRenderer'), false);

  let flushCalls = 0;
  const unsubscribe = api.onProjectFlushRequest(() => { flushCalls += 1; });
  assert.strictEqual(typeof unsubscribe, 'function');
  channels.get('project:flush-request')({});
  assert.strictEqual(flushCalls, 1);
  unsubscribe();
  channels.get('project:flush-request')({});
  assert.strictEqual(flushCalls, 1);
});

test('设置归一化：类型错误给出字段级错误', () => {
  assert.throws(
    () => normalizeConfig({ agentTimeoutMs: 10 }),
    (error) => error.code === 'SETTINGS_INVALID' && Array.isArray(error.details.errors),
  );
});

test('空白文档结构满足 4.1 必填字段', () => {
  const doc = createBlankDocument({ projectId: 'p_12345678abcdef', name: '店' });
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.activeSessionId, 'session-main');
  assert.deepStrictEqual(doc.features.selected, ['scan-order', 'product-catalog', 'cart-checkout', 'order-tracking']);
  assert.strictEqual(doc.sessions.length, 1);
  assert.ok(!('revealFlush' in doc.sessions[0]));
  assert.ok(!('status' in doc.build));
});