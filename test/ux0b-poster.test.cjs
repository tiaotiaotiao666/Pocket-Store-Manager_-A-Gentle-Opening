'use strict';

/**
 * UX0b 行为证据：海报素材的持久化、恢复与真实导出闭环。
 *
 * 覆盖：
 * 1. 真实 asset-store：选图 token → attach → 文件落盘 → readAsset 预览 → 重开恢复；
 * 2. 非 PNG / 伪造 PNG / 超 2 MB / 未知 token / 跨项目 assetId 全部拒绝；
 * 3. 上传未完成时不能声称「已选用上传图片」；
 * 4. 已选与跳过两种 IMAGE_REVIEW 项目都能保存重开，且文档不漂移；
 * 5. 主进程 composer IPC 用受控 resolver 读取真实资产，renderer 传路径/dataUrl 被拒；
 * 6. 真实 compose 导出：背景图字节一致、首页真实引用、manifest 来源正确、Lock/媒体校验通过；
 * 7. config.json 损坏：备份可恢复，同一未变化文件不重复备份。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.join(__dirname, '..');
const { createProjectStore } = require(path.join(REPO, 'desktop', 'project-store.cjs'));
const { createAssetStore } = require(path.join(REPO, 'desktop', 'asset-store.cjs'));
const { createPosterMediaResolver } = require(path.join(REPO, 'desktop', 'poster-media.cjs'));
const { createComposerIpc } = require(path.join(REPO, 'desktop', 'composer-ipc.cjs'));
const { createSettingsStore } = require(path.join(REPO, 'desktop', 'settings-store.cjs'));
const composer = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { validateMedia } = require(path.join(REPO, 'scripts', 'composer', 'media.cjs'));
const { sha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const PLAN = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json'), 'utf8'));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
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

function makeJpeg() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 按需返回指定文件的假对话框，避免真实弹窗。 */
function dialogFor(filePaths) {
  return {
    showOpenDialog: async () => ({ canceled: filePaths.length === 0, filePaths }),
  };
}

/** 建一个真实项目 + 真实资产库，返回可复用的上下文。 */
async function setupProject(options) {
  const opts = options || {};
  const userDataDir = tempDir(opts.prefix || 'ux0b-');
  const store = createProjectStore({ userDataDir });
  const assets = createAssetStore({ userDataDir });
  const created = await store.createProject({ name: '松月食堂' });
  const projectId = created.projectId;
  const stagingDir = tempDir('ux0b-src-');
  return { userDataDir, store, assets, projectId, stagingDir };
}

/** 走真实两段式：pick → attach，返回 attach 结果里的 asset 元数据。 */
async function attachFile(ctx, fileName, bytes) {
  const source = path.join(ctx.stagingDir, fileName);
  fs.writeFileSync(source, bytes);
  const picked = await ctx.assets.pickImages(dialogFor([source]), { max: 1 });
  assert.equal(picked.items.length, 1, '选图应返回 1 个 token');
  const attached = await ctx.assets.attachImages(ctx.projectId, [picked.items[0].token]);
  assert.equal(attached.assets.length, 1, 'attach 应返回 1 个资产');
  return { item: picked.items[0], asset: attached.assets[0], source };
}

test('UX0b-1 真实资产链路：PNG 选图 token → attach 落盘 → readAsset 预览 → 重开项目恢复', async () => {
  const { fromDocument } = await import('../src/domain/projectSnapshot.mjs');
  const ctx = await setupProject();
  const png = makePng(64, 48);
  const { asset } = await attachFile(ctx, 'poster.png', png);

  assert.match(asset.assetId, /^a_[0-9a-f]{16}$/);
  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.width, 64);
  assert.equal(asset.height, 48);

  // 文件真的落到了项目资产目录
  const onDisk = path.join(ctx.assets.assetsDirectory(ctx.projectId), asset.fileName);
  assert.equal(fs.existsSync(onDisk), true, '资产文件必须真实存在');
  assert.equal(Buffer.compare(fs.readFileSync(onDisk), png), 0, '落盘字节必须与源文件一致');

  // 渲染进程可见的预览
  const preview = await ctx.assets.readAsset(ctx.projectId, asset.assetId, 720);
  assert.equal(preview.mime, 'image/png');
  assert.ok(preview.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(preview.dataUrl, `data:image/png;base64,${png.toString('base64')}`);

  // 主进程内部完整字节
  const raw = await ctx.assets.readAssetBytes(ctx.projectId, asset.assetId);
  assert.equal(Buffer.compare(raw.buffer, png), 0);
  assert.equal(raw.sha256, sha256(png));

  // 写进项目文档 → 重开项目 → 仍能按资产 ID 恢复预览
  const loaded = await ctx.store.loadProject(ctx.projectId);
  const doc = loaded.doc;
  doc.phase = 'image-review';
  doc.visual = { ...(doc.visual || {}), prompt: '温暖木质餐台', imageAssetId: asset.assetId, imageMeta: { provider: 'user-upload', width: 64, height: 48 } };
  await ctx.store.saveProject(ctx.projectId, doc);

  const reopened = await ctx.store.loadProject(ctx.projectId);
  const hydrated = fromDocument(reopened.doc);
  assert.equal(hydrated.phase, 'image-review');
  assert.equal(hydrated.visual.imageAssetId, asset.assetId);
  assert.equal(hydrated.visual.imageMeta.provider, 'user-upload');
  assert.equal(hydrated.visual.image, null, 'dataUrl 不落盘，只做运行中预览');

  const restored = await ctx.assets.readAsset(reopened.doc.projectId, hydrated.visual.imageAssetId, 720);
  assert.equal(Buffer.compare(Buffer.from(restored.dataUrl.split(',')[1], 'base64'), png), 0,
    '重开后读到的预览必须还是同一张图');
});

test('UX0b-2 非法素材一律拒绝：非 PNG / 伪造 PNG / 超 2 MB / 未知 token / 跨项目资产', async () => {
  const ctx = await setupProject();
  const resolver = createPosterMediaResolver({ assets: ctx.assets });

  // ① 非 PNG（JPEG 字节）：能落盘成资产，但海报链路必须拒绝
  const { asset: jpegAsset } = await attachFile(ctx, 'photo.png', makeJpeg());
  assert.equal(jpegAsset.mime, 'image/jpeg');
  const jpegResolved = await resolver({ projectId: ctx.projectId, posterAssetId: jpegAsset.assetId });
  assert.equal(jpegResolved.ok, false);
  assert.equal(jpegResolved.code, 'MEDIA_TYPE_UNSUPPORTED');

  // ② 伪造 PNG：magic 是 PNG，但内容不是有效 PNG（IHDR 不全）
  const forged = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(32, 0x41)]);
  const { asset: forgedAsset } = await attachFile(ctx, 'forged.png', forged);
  const forgedResolved = await resolver({ projectId: ctx.projectId, posterAssetId: forgedAsset.assetId });
  // 解析器只按 magic/尺寸做第一层判断；真正的内容校验必须由 Composer 拒绝
  if (forgedResolved.ok) {
    const rejected = validateMedia({
      homeBackground: {
        mime: 'image/png',
        sha256: sha256(forged),
        width: forgedResolved.media.homeBackground.width,
        height: forgedResolved.media.homeBackground.height,
        source: { kind: 'user-provided', provider: 'user-upload' },
        data: forged,
      },
    });
    assert.equal(rejected.ok, false, '伪造 PNG 必须被 Composer 拒绝');
    assert.match(String(rejected.code), /^MEDIA_/);
  } else {
    assert.match(String(forgedResolved.code), /^MEDIA_/);
  }

  // ③ 超过 2 MB 产品上限：真实 PNG + 填充到 2 MB 以上
  const big = Buffer.concat([makePng(64, 48), Buffer.alloc(2 * 1024 * 1024, 0)]);
  const { asset: bigAsset } = await attachFile(ctx, 'big.png', big);
  const bigResolved = await resolver({ projectId: ctx.projectId, posterAssetId: bigAsset.assetId });
  assert.equal(bigResolved.ok, false);
  assert.equal(bigResolved.code, 'MEDIA_SIZE_INVALID');

  // ④ 未知 token
  await assert.rejects(
    () => ctx.assets.attachImages(ctx.projectId, ['deadbeefdeadbeef']),
    (error) => error.code === 'ASSET_TOKEN_UNKNOWN',
  );

  // ⑤ 跨项目 assetId：B 项目读不到 A 项目的资产
  const other = await ctx.store.createProject({ name: '另一家店' });
  const crossResolved = await resolver({ projectId: other.projectId, posterAssetId: bigAsset.assetId });
  assert.equal(crossResolved.ok, false);
  assert.equal(crossResolved.code, 'MEDIA_ASSET_NOT_IN_PROJECT');
  await assert.rejects(
    () => ctx.assets.readAssetBytes(other.projectId, bigAsset.assetId),
    (error) => error.code === 'ASSET_NOT_FOUND',
  );

  // ⑥ renderer 想直接塞媒体内容（dataUrl / 路径 / mime）一律拒绝
  const smuggled = await resolver({ projectId: ctx.projectId, posterAssetId: bigAsset.assetId, dataUrl: 'data:image/png;base64,AA' });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.code, 'MEDIA_REQUEST_INVALID');
});

test('UX0b-3 上传未完成或失败时不能声称「已选用上传图片」', async () => {
  const machine = await import('../src/state/sessionMachine.mjs');
  let state = machine.createInitialState();
  state = machine.reducer(state, { type: 'START_ONBOARDING' });
  state = machine.reducer(state, { type: 'SUBMIT_NAME', name: '松月食堂' });
  state = machine.reducer(state, { type: 'SKIP_INTRO' });
  state = machine.reducer(state, { type: 'SUBMIT_CUSTOMIZE', value: '' });
  state = machine.reducer(state, { type: 'BUILD_READY', candidates: [{ id: 'warm-bistro', name: '街巷食集', score: 88 }] });
  state = machine.reducer(state, { type: 'CONFIRM_TEMPLATE' });
  state = machine.reducer(state, { type: 'SUBMIT_STORE_INFO', summary: '店铺资料', styleId: 'warm' });
  state = machine.reducer(state, { type: 'CONFIRM_PROMPT' });

  // 只有预览、没有资产 ID：不能算"已选用"
  const previewOnly = machine.reducer(state, {
    type: 'SET_IMAGE',
    image: { dataUrl: 'data:image/png;base64,AA', provider: 'user-upload' },
  });
  const deployA = machine.reducer(previewOnly, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  const textA = deployA.sessions.find((session) => session.id === deployA.activeSessionId).messages[0].text;
  assert.match(textA, /未添加（已跳过/);
  assert.equal(deployA.visual.imageAssetId, null);

  // 有资产 ID 才算已选用
  const withAsset = machine.reducer(state, {
    type: 'SET_POSTER_ASSET',
    assetId: 'a_0123456789abcdef',
    meta: { provider: 'user-upload', width: 64, height: 48 },
    preview: 'data:image/png;base64,AA',
  });
  const deployB = machine.reducer(withAsset, { type: 'APPROVE_IMAGE', material: 'uploaded' });
  const textB = deployB.sessions.find((session) => session.id === deployB.activeSessionId).messages[0].text;
  assert.match(textB, /已选用上传图片/);
  assert.equal(deployB.visual.imageAssetId, 'a_0123456789abcdef');

  // 跳过时明确解除引用，导出不会偷偷带上没用上的图
  const deployC = machine.reducer(withAsset, { type: 'APPROVE_IMAGE', material: 'skipped' });
  assert.equal(deployC.visual.imageAssetId, null);
  assert.equal(deployC.visual.image, null);
  const textC = deployC.sessions.find((session) => session.id === deployC.activeSessionId).messages[0].text;
  assert.match(textC, /未添加（已跳过/);
});

test('UX0b-4 已选/跳过两种 IMAGE_REVIEW 项目都能保存重开，文档不漂移', async () => {
  const snapshot = await import('../src/domain/projectSnapshot.mjs');
  const ctx = await setupProject();
  const { asset } = await attachFile(ctx, 'poster.png', makePng(32, 24));
  const loaded = await ctx.store.loadProject(ctx.projectId);
  const baseVisual = loaded.doc.visual || {};

  const savedDoc = {
    ...loaded.doc,
    phase: 'image-review',
    visual: {
      ...baseVisual,
      prompt: '木质餐台暖光',
      imageAssetId: asset.assetId,
      imageMeta: { provider: 'user-upload', width: 32, height: 24, note: '你上传的图片，不是模型生成结果' },
    },
  };
  const skippedDoc = {
    ...loaded.doc,
    phase: 'image-review',
    visual: { ...baseVisual, prompt: '木质餐台暖光', imageAssetId: null, imageMeta: null },
  };

  for (const [label, doc] of [['已选海报', savedDoc], ['跳过海报', skippedDoc]]) {
    await ctx.store.saveProject(ctx.projectId, doc);
    const reopened = await ctx.store.loadProject(ctx.projectId);
    const hydrated = snapshot.fromDocument(reopened.doc);
    assert.equal(hydrated.phase, 'image-review', `${label}：重开必须回到 image-review`);
    assert.equal(hydrated.visual.prompt, '木质餐台暖光');
    assert.equal(hydrated.visual.image, null, `${label}：dataUrl 不写进项目文档`);
    assert.equal(
      hydrated.visual.imageAssetId,
      label === '已选海报' ? asset.assetId : null,
      `${label}：资产引用要被正确恢复`,
    );

    const once = snapshot.toDocument(hydrated, { projectId: ctx.projectId });
    const twice = snapshot.toDocument(snapshot.fromDocument(once), { projectId: ctx.projectId });
    assert.deepEqual(twice, once, `${label}：toDocument → fromDocument → toDocument 不得漂移`);
  }
});

test('UX0b-5 composer IPC：受控 resolver 读取真实资产，renderer 传路径/dataUrl 被拒', async () => {
  const ctx = await setupProject();
  const png = makePng(64, 48);
  const { asset } = await attachFile(ctx, 'poster.png', png);
  const resolver = createPosterMediaResolver({ assets: ctx.assets });

  const composeCalls = [];
  const resolvedRequests = [];
  const ipc = createComposerIpc({
    dialog: dialogFor([]),
    shell: {},
    compose: async (opts) => {
      composeCalls.push(opts);
      return { ok: true, outputPath: path.join(ctx.userDataDir, 'out'), lockDigest: 'sha256:' + 'a'.repeat(64) };
    },
    validateComposition: () => ({ ok: true }),
    previewParentDir: path.join(ctx.userDataDir, 'preview-projects'),
    resolveMedia: async (request) => {
      resolvedRequests.push(request);
      return resolver(request);
    },
  });
  const event = { sender: { send() {} } };
  const basePayload = {
    parentDir: '__preview__',
    plan: { schemaVersion: 'plan.v1' },
    projectName: 'poster',
    mode: 'development',
    projectId: ctx.projectId,
  };

  // A. 有海报：compose 收到的媒体是真字节，resolver 只看到两个受控字段
  const okResult = await ipc.handlers['composer:export'](event, { ...basePayload, posterAssetId: asset.assetId });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.deepEqual(Object.keys(resolvedRequests[0]).sort(), ['posterAssetId', 'projectId']);
  const media = composeCalls[0].media;
  assert.ok(media && media.homeBackground, 'compose 必须收到 homeBackground');
  assert.equal(media.homeBackground.mime, 'image/png');
  assert.equal(Buffer.compare(media.homeBackground.data, png), 0, '媒体字节必须来自主进程读取的真实文件');
  assert.deepEqual(media.homeBackground.source, { kind: 'user-provided', provider: 'user-upload' });
  assert.equal(okResult.poster.included, true);

  // B. renderer 直接塞媒体内容：拒绝且不进入 compose
  const before = composeCalls.length;
  const smuggled = await ipc.handlers['composer:export'](event, {
    ...basePayload,
    posterAssetId: asset.assetId,
    dataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.code, 'MEDIA_REQUEST_INVALID');
  const smuggledPath = await ipc.handlers['composer:export'](event, {
    ...basePayload,
    posterAssetId: asset.assetId,
    assetPath: 'C:/secret/poster.png',
  });
  assert.equal(smuggledPath.code, 'MEDIA_REQUEST_INVALID');
  assert.equal(composeCalls.length, before, '被拒绝的请求不得执行 compose');

  // C. 跨项目资产：阻断导出
  const other = await ctx.store.createProject({ name: '另一家店' });
  const cross = await ipc.handlers['composer:export'](event, {
    ...basePayload,
    projectId: other.projectId,
    posterAssetId: asset.assetId,
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.code, 'MEDIA_ASSET_NOT_IN_PROJECT');
  assert.equal(composeCalls.length, before);

  // D. 没有海报：不传 media，导出照旧成功
  const noPoster = await ipc.handlers['composer:export'](event, basePayload);
  assert.equal(noPoster.ok, true);
  assert.equal(composeCalls.at(-1).media, undefined, '无海报时不得伪造占位图或空媒体');
  assert.equal(noPoster.poster.included, false);

  // E. composer:validate 仍然只校验 Plan，不触发媒体解析
  const resolvedBefore = resolvedRequests.length;
  await ipc.handlers['composer:validate'](event, { plan: {}, posterAssetId: asset.assetId });
  assert.equal(resolvedRequests.length, resolvedBefore, 'composerValidate 只校验 Plan，不读媒体');
});

test('UX0b-6 真实 compose 导出：背景图字节一致、首页真实引用、manifest 来源正确', async () => {
  const ctx = await setupProject();
  const png = makePng(96, 64);
  const { asset } = await attachFile(ctx, 'poster.png', png);
  const resolver = createPosterMediaResolver({ assets: ctx.assets });
  const resolved = await resolver({ projectId: ctx.projectId, posterAssetId: asset.assetId });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const parentDir = tempDir('ux0b-out-');
  const withPoster = await composer.compose({
    plan: PLAN,
    parentDir,
    projectName: 'poster-e2e',
    mode: 'development',
    media: resolved.media,
  });
  assert.equal(withPoster.ok, true, JSON.stringify(withPoster));
  const outputDir = withPoster.outputPath;

  const background = path.join(outputDir, 'assets', 'media', 'home-background.png');
  assert.equal(fs.existsSync(background), true, '导出工程必须包含首页背景图');
  assert.equal(Buffer.compare(fs.readFileSync(background), png), 0, '导出背景图必须与原始 PNG 字节一致');

  const wxml = fs.readFileSync(path.join(outputDir, 'pages', 'home', 'index.wxml'), 'utf8');
  assert.ok(wxml.includes('/assets/media/home-background.png'), '首页必须真实引用背景图');

  const manifestText = fs.readFileSync(path.join(outputDir, 'assets', 'media', 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const item = manifest.items.find((entry) => entry.id === 'homeBackground');
  assert.ok(item, 'manifest 必须登记 homeBackground');
  assert.deepEqual(item.source, { kind: 'user-provided', provider: 'user-upload' }, '来源必须是用户提供/用户上传');
  assert.equal(item.sha256, sha256(png));
  assert.equal(item.bytes, png.length);
  assert.equal(item.path, 'assets/media/home-background.png');
  assert.ok(!manifestText.includes('base64'), 'manifest 不得包含 base64');
  assert.ok(!/[A-Za-z]:[\\/]/.test(manifestText), 'manifest 不得包含本机绝对路径');
  assert.ok(!/token|secret|api[-_]?key/i.test(manifestText), 'manifest 不得包含密钥类字段');

  // Lock/verify：compose 只有在 verifyOutput 通过后才返回 ok，并写出 composition.lock.json
  const lockFile = path.join(outputDir, 'composition.lock.json');
  assert.equal(fs.existsSync(lockFile), true, '导出必须产出 Lock 文件');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.match(String(lock.lockDigest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(lock.lockDigest, withPoster.lockDigest);

  // 无海报导出：成功，且不引用该背景图
  const noPoster = await composer.compose({
    plan: PLAN,
    parentDir: tempDir('ux0b-out-'),
    projectName: 'no-poster-e2e',
    mode: 'development',
  });
  assert.equal(noPoster.ok, true, JSON.stringify(noPoster));
  const noPosterDir = noPoster.outputPath;
  const noPosterHome = fs.readFileSync(path.join(noPosterDir, 'pages', 'home', 'index.wxml'), 'utf8');
  assert.ok(!noPosterHome.includes('/assets/media/home-background.png'), '无海报时首页不得引用背景图');
  assert.equal(fs.existsSync(path.join(noPosterDir, 'assets', 'media', 'home-background.png')), false);
});

test('UX0b-7 config.json 损坏：默认配置可用，原始内容可从备份恢复，同一损坏内容不重复备份', async () => {
  const userDataDir = tempDir('ux0b-settings-');
  const broken = '{ "apiBaseUrl": "http://127.0.0.1:3000/api/v1", dup';
  fs.writeFileSync(path.join(userDataDir, 'config.json'), broken);
  const store = createSettingsStore({ userDataDir, now: () => new Date('2026-11-16T03:00:00Z') });

  const loaded = await store.loadConfig();
  assert.equal(loaded.source, 'default');
  assert.match(loaded.warning, /设置文件读不出来/);
    assert.match(loaded.warning, /备份/);
  assert.equal(loaded.details.reason, 'unreadable');
  const backups = fs.readdirSync(userDataDir).filter((name) => name.startsWith('config.json.bak-'));
  assert.equal(backups.length, 1, '损坏文件应先留下备份');
  const backupPath = path.join(userDataDir, backups[0]);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), broken, '备份必须是原始损坏内容');

  // 自动保存默认配置后，原文件变成合法 JSON，但备份里的损坏内容仍可恢复
  const saved = await store.saveConfig({ ...loaded.config, modelChannel: 'server' });
  assert.equal(saved.config.agentTransport, 'http');
  const afterSave = fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8');
  JSON.parse(afterSave);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), broken, '保存默认配置不得覆盖备份');

  const reloaded = await store.loadConfig();
  assert.equal(reloaded.source, 'file');
  assert.equal(reloaded.warning, null);
  assert.equal(reloaded.config.agentTransport, 'http');

  // 同一个未变化的损坏文件再次出现：复用已有备份，不再重复备份
  fs.writeFileSync(path.join(userDataDir, 'config.json'), broken);
  const again = await store.loadConfig();
  assert.equal(again.source, 'default');
  const backupsAfter = fs.readdirSync(userDataDir).filter((name) => name.startsWith('config.json.bak-'));
  assert.equal(backupsAfter.length, 1, '同一损坏内容不应重复备份');
  assert.equal(fs.readFileSync(path.join(userDataDir, backupsAfter[0]), 'utf8'), broken);
});
