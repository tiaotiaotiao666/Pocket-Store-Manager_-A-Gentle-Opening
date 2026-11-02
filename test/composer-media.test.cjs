'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { compose } = require(path.join(REPO, 'scripts', 'composer', 'index.cjs'));
const { loadRegistry } = require(path.join(REPO, 'scripts', 'composer', 'registry.cjs'));
const { resolvePlan } = require(path.join(REPO, 'scripts', 'composer', 'resolve.cjs'));
const { buildProjectFiles } = require(path.join(REPO, 'scripts', 'composer', 'emit.cjs'));
const { loadMedia, validateMedia, inspectSvg } = require(path.join(REPO, 'scripts', 'composer', 'media.cjs'));
const { verifyMediaOutput } = require(path.join(REPO, 'scripts', 'composer', 'verify.cjs'));
const { sha256 } = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));

const PLAN_FILE = path.join(REPO, 'templates', 'recipes', 'order-classic', '1.0.0', 'plan.json');
const PLAN = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
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

function makeSvg(width, height) {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="' + width + '" height="' + height + '" rx="8" fill="#2F7D4F"/></svg>', 'utf8');
}

function entry(data, mime, width, height, source) {
  return { mime, sha256: sha256(data), width, height, source: source || { kind: 'user-provided', provider: 'media-test' }, data };
}

function validMedia() {
  const background = makePng(32, 24);
  const mark = makeSvg(64, 64);
  return {
    homeBackground: entry(background, 'image/png', 32, 24, { kind: 'ai-generated', provider: 'model-vendor', model: 'image-test-model' }),
    homeMark: entry(mark, 'image/svg+xml', 64, 64, { kind: 'agent-local-svg', provider: 'composer-test' }),
  };
}

function buildGraph(role, production) {
  const plan = role === 'customer'
    ? { ...PLAN, pages: PLAN.pages.filter((page) => page.pageId !== 'merchant-orders') }
    : role === 'merchant'
      ? { ...PLAN, pages: PLAN.pages.filter((page) => page.pageId === 'merchant-orders') }
      : JSON.parse(JSON.stringify(PLAN));
  if (production) plan.apiBinding.baseUrl = 'https://api.example.com';
  const graph = resolvePlan(plan, loadRegistry(), role === undefined ? {} : { role });
  assert.strictEqual(graph.ok, true, JSON.stringify(graph));
  return graph;
}

function assertFilesEqual(first, second) {
  assert.deepStrictEqual([...first.keys()].sort(), [...second.keys()].sort());
  for (const [file, data] of first.entries()) assert.strictEqual(Buffer.compare(data, second.get(file)), 0, file);
}

function writeFixture(media) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-fixture-'));
  const serialized = {};
  for (const [id, item] of Object.entries(media)) {
    const extension = id === 'homeBackground' ? 'png' : 'svg';
    const file = id + '.' + extension;
    fs.writeFileSync(path.join(directory, file), item.data);
    serialized[id] = {
      file,
      mime: item.mime,
      sha256: item.sha256,
      width: item.width,
      height: item.height,
      source: item.source,
    };
  }
  const manifest = path.join(directory, 'media.json');
  fs.writeFileSync(manifest, JSON.stringify(serialized, null, 2));
  return { directory, manifest, serialized };
}

test('合法媒体写入固定资产、media.v1、首页与真实来源说明', () => {
  const media = validMedia();
  const result = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check', media });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(Buffer.compare(result.files.get('assets/media/home-background.png'), media.homeBackground.data), 0);
  assert.strictEqual(Buffer.compare(result.files.get('assets/media/home-mark.svg'), media.homeMark.data), 0);
  const manifestText = result.files.get('assets/media/manifest.json').toString('utf8');
  const manifest = JSON.parse(manifestText);
  assert.strictEqual(manifest.schemaVersion, 'media.v1');
  assert.deepStrictEqual(manifest.items.map((item) => item.id), ['homeBackground', 'homeMark']);
  for (const item of manifest.items) {
    assert.deepStrictEqual(Object.keys(item), ['id', 'path', 'mime', 'bytes', 'sha256', 'width', 'height', 'source']);
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'file'));
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'data'));
  }
  assert.ok(!manifestText.includes('base64'));
  assert.ok(!/https?:\/\//.test(manifestText));
  assert.ok(!/[A-Za-z]:[\\/]/.test(manifestText));
  const home = result.files.get('pages/home/index.wxml').toString('utf8');
  assert.ok(home.includes('src="/assets/media/home-background.png"'));
  assert.ok(home.includes('src="/assets/media/home-mark.svg"'));
  assert.ok(home.includes('<store-header'));
  assert.ok(home.includes('开始点餐'));
  assert.ok(home.includes('bind:tap="goMenu"'));
  assert.ok(!/<(script|foreignObject)\b/.test(home));
  const wxss = result.files.get('pages/home/index.wxss').toString('utf8');
  assert.ok(wxss.includes('.home-media__background'));
  assert.ok(wxss.includes('.home-media__mark'));
  const readme = result.files.get('README.md').toString('utf8');
  assert.ok(readme.includes('model-vendor'));
  assert.ok(readme.includes('image-test-model'));
  assert.ok(readme.includes('composer-test'));
  assert.ok(readme.includes('不代表 Composer 发起了模型调用'));
});

test('CLI 相对 media.json 读取 Buffer 且最终清单不泄露输入路径', () => {
  const fixture = writeFixture(validMedia());
  const loaded = loadMedia(fixture.manifest);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.ok(Buffer.isBuffer(loaded.media.homeBackground.data));
  assert.ok(Buffer.isBuffer(loaded.media.homeMark.data));
  assert.ok(!Object.prototype.hasOwnProperty.call(loaded.media.homeBackground, 'file'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-cli-'));
  const cli = spawnSync(process.execPath, [
    path.join(REPO, 'scripts', 'composer', 'cli.cjs'),
    '--plan', PLAN_FILE,
    '--out', parent,
    '--project-name', 'cli-media',
    '--media', fixture.manifest,
    '--json',
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr + cli.stdout);
  const output = path.join(parent, 'cli-media');
  const manifestText = fs.readFileSync(path.join(output, 'assets', 'media', 'manifest.json'), 'utf8');
  assert.ok(!manifestText.includes(fixture.directory));
  assert.ok(!manifestText.includes('homeBackground.png'));
  assert.ok(!manifestText.includes('homeMark.svg'));
  const verified = verifyMediaOutput(output);
  assert.strictEqual(verified.ok, true, JSON.stringify(verified));
});

test('空清单、错误摘要格式、错误 hash 与声明尺寸均被拒绝', () => {
  assert.strictEqual(validateMedia({}).code, 'MEDIA_MANIFEST_EMPTY');
  const wrongFormat = validMedia();
  wrongFormat.homeBackground.sha256 = wrongFormat.homeBackground.sha256.slice(7);
  assert.strictEqual(validateMedia(wrongFormat).code, 'MEDIA_HASH_INVALID');
  const wrongHash = validMedia();
  wrongHash.homeBackground.sha256 = 'sha256:' + '0'.repeat(64);
  assert.strictEqual(validateMedia(wrongHash).code, 'MEDIA_HASH_MISMATCH');
  const wrongSize = validMedia();
  wrongSize.homeBackground.width = 31;
  assert.strictEqual(validateMedia(wrongSize).code, 'MEDIA_DIMENSION_MISMATCH');
  const wrongMarkSize = validMedia();
  wrongMarkSize.homeMark.height = 63;
  assert.strictEqual(validateMedia(wrongMarkSize).code, 'MEDIA_DIMENSION_MISMATCH');
});

test('伪造 PNG、错误 MIME、越界尺寸与文件大小均被拒绝', () => {
  const fake = validMedia();
  fake.homeBackground = entry(Buffer.from('not a png'), 'image/png', 32, 24);
  assert.strictEqual(validateMedia(fake).code, 'MEDIA_PNG_INVALID');
  const headerOnly = validMedia();
  const forged = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(40)]);
  forged.writeUInt32BE(13, 8);
  forged.write('IHDR', 12, 'ascii');
  forged.writeUInt32BE(32, 16);
  forged.writeUInt32BE(24, 20);
  headerOnly.homeBackground = entry(forged, 'image/png', 32, 24);
  assert.strictEqual(validateMedia(headerOnly).code, 'MEDIA_PNG_INVALID');
  const wrongMime = validMedia();
  wrongMime.homeBackground.mime = 'image/jpeg';
  assert.strictEqual(validateMedia(wrongMime).code, 'MEDIA_MIME_INVALID');
  const tooSmall = validMedia();
  tooSmall.homeBackground = entry(makePng(15, 24), 'image/png', 15, 24);
  assert.strictEqual(validateMedia(tooSmall).code, 'MEDIA_DIMENSION_INVALID');
  const tooLarge = validMedia();
  tooLarge.homeBackground.data = Buffer.alloc(5 * 1024 * 1024 + 1);
  assert.strictEqual(validateMedia(tooLarge).code, 'MEDIA_SIZE_INVALID');
});

test('恶意 SVG 的脚本、事件、实体、外部资源与远程 URL 均被拒绝', () => {
  const attacks = [
    '<svg width="64" height="64"><script>alert(1)</script></svg>',
    '<svg width="64" height="64"><foreignObject width="64" height="64"/></svg>',
    '<svg width="64" height="64" onload="alert(1)"><rect width="64" height="64"/></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg width="64" height="64"><text>&xxe;</text></svg>',
    '<svg width="64" height="64"><use href="https://evil.example/a.svg#x"/></svg>',
    '<svg width="64" height="64"><image href="data:image/png;base64,AAAA"/></svg>',
    '<svg width="64" height="64"><rect width="64" height="64" style="fill:url(https://evil.example/a)"/></svg>',
    '<svg width="64" height="64"><style>@import url(//evil.example/a.css);</style></svg>',
    '<svg xmlns:s="urn:test" width="64" height="64"><s:script/></svg>',
  ];
  for (const attack of attacks) {
    const media = validMedia();
    const data = Buffer.from(attack);
    media.homeMark = entry(data, 'image/svg+xml', 64, 64);
    const result = validateMedia(media);
    assert.strictEqual(result.ok, false, attack);
    assert.ok(['MEDIA_SVG_UNSAFE', 'MEDIA_SVG_INVALID'].includes(result.code), result.code);
  }
});

test('安全 SVG namespace、内部 href 与本地 url 不误判', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:href="urn:local-href" xmlns:onload="urn:local-onload" viewBox="0 0 48 48"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path id="shape" d="M0 0h48v48H0z" fill="url(#paint)"/><use xlink:href="#shape"/></svg>';
  const inspected = inspectSvg(Buffer.from(source), 'homeMark');
  assert.strictEqual(inspected.ok, true, JSON.stringify(inspected));
  assert.strictEqual(inspected.width, 48);
  assert.strictEqual(inspected.height, 48);
  const media = validMedia();
  media.homeMark = entry(Buffer.from(source), 'image/svg+xml', 48, 48);
  assert.strictEqual(validateMedia(media).ok, true);
});

test('来源 provider 必填且 local-demo 不得冒充 AI，来源不得带 URL 或路径', () => {
  const missing = validMedia();
  delete missing.homeBackground.source.provider;
  assert.strictEqual(validateMedia(missing).code, 'MEDIA_SOURCE_INVALID');
  const impersonated = validMedia();
  impersonated.homeBackground.source = { kind: 'ai-generated', provider: 'local-demo', model: 'fake-model' };
  assert.strictEqual(validateMedia(impersonated).code, 'MEDIA_SOURCE_INVALID');
  const remote = validMedia();
  remote.homeBackground.source.provider = 'https://evil.example';
  assert.strictEqual(validateMedia(remote).code, 'MEDIA_SOURCE_INVALID');
  const absolute = validMedia();
  absolute.homeBackground.source.model = 'C:\\fake\\model';
  assert.strictEqual(validateMedia(absolute).code, 'MEDIA_SOURCE_INVALID');
});

test('媒体文件禁止目录逃逸、绝对路径和 URL', () => {
  const fixture = writeFixture(validMedia());
  for (const file of ['../outside.png', path.resolve(fixture.directory, 'homeBackground.png'), 'https://evil.example/a.png']) {
    const document = JSON.parse(JSON.stringify(fixture.serialized));
    document.homeBackground.file = file;
    const manifest = path.join(fixture.directory, 'invalid-path.json');
    fs.writeFileSync(manifest, JSON.stringify(document));
    const result = loadMedia(manifest);
    assert.strictEqual(result.ok, false, file);
    assert.strictEqual(result.code, 'MEDIA_PATH_INVALID');
  }
});

test('无 media 时文件表逐字节不变且不产生媒体清单', () => {
  const first = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check' });
  const second = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check', media: undefined });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assertFilesEqual(first.files, second.files);
  assert.ok(![...first.files.keys()].some((file) => file.startsWith('assets/media/')));
  assert.ok(!first.files.get('README.md').toString('utf8').includes('首页媒体来源'));
});

test('role 兼容且 merchant 无首页仍保留媒体资产与清单', () => {
  const customer = buildProjectFiles(buildGraph('customer'), { mode: 'development', projectName: 'media-check', role: 'customer', media: validMedia() });
  assert.strictEqual(customer.ok, true, JSON.stringify(customer));
  assert.ok(customer.files.has('pages/home/index.wxml'));
  assert.ok(![...customer.files.keys()].some((file) => file.startsWith('pages/merchant-orders/')));
  const merchant = buildProjectFiles(buildGraph('merchant'), { mode: 'development', projectName: 'media-check', role: 'merchant', media: validMedia() });
  assert.strictEqual(merchant.ok, true, JSON.stringify(merchant));
  assert.ok(!merchant.files.has('pages/home/index.wxml'));
  assert.ok(merchant.files.has('assets/media/home-background.png'));
  assert.ok(merchant.files.has('assets/media/home-mark.svg'));
  assert.ok(merchant.files.has('assets/media/manifest.json'));
  const plain = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check', media: validMedia() });
  const combined = buildProjectFiles(buildGraph('combined'), { mode: 'development', projectName: 'media-check', role: 'combined', media: validMedia() });
  assertFilesEqual(plain.files, combined.files);
});

test('相同媒体输入两次生成逐字节一致', () => {
  const first = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check', media: validMedia() });
  const second = buildProjectFiles(buildGraph(), { mode: 'development', projectName: 'media-check', media: validMedia() });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assertFilesEqual(first.files, second.files);
});

test('compose 媒体产物可复现且 production 不回退开发配置', async () => {
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-a-'));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-b-'));
  const first = await compose({ plan: PLAN, parentDir: parentA, projectName: 'media-store', media: validMedia(), generatedAt: '2026-11-20T00:00:00Z' });
  const second = await compose({ plan: PLAN, parentDir: parentB, projectName: 'media-store', media: validMedia(), generatedAt: '2026-11-21T00:00:00Z' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(first.treeSha256, second.treeSha256);
  assert.strictEqual(first.lockDigest, second.lockDigest);
  const productionPlan = JSON.parse(JSON.stringify(PLAN));
  productionPlan.apiBinding.baseUrl = 'https://api.example.com';
  const parentProduction = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-production-'));
  const production = await compose({
    plan: productionPlan,
    parentDir: parentProduction,
    projectName: 'media-store',
    mode: 'production',
    storeId: 'store-prod-media',
    backendVersions: { storeConfigVersion: 3, catalogVersion: 7 },
    media: validMedia(),
  });
  assert.strictEqual(production.ok, true, JSON.stringify(production));
  const output = path.join(parentProduction, 'media-store');
  const env = fs.readFileSync(path.join(output, 'config', 'env.js'), 'utf8');
  const config = fs.readFileSync(path.join(output, 'config', 'store.generated.js'), 'utf8');
  assert.ok(env.includes('USE_WECHAT_CODE_LOGIN = true'));
  assert.ok(!env.includes('http://127.0.0.1'));
  assert.ok(!env.includes("|| 'store-demo-001'"));
  assert.ok(config.includes('store-prod-media'));
  const verifiedProduction = verifyMediaOutput(output);
  assert.strictEqual(verifiedProduction.ok, true, JSON.stringify(verifiedProduction));
});

test('verify 交叉发现文件缺失、hash 篡改、恶意 SVG 与首页引用缺失', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-media-verify-'));
  const result = await compose({ plan: PLAN, parentDir: parent, projectName: 'media-store', media: validMedia() });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const original = result.outputPath;
  assert.strictEqual(verifyMediaOutput(original).ok, true);
  const cases = ['manifest', 'missing', 'hash', 'svg', 'reference'];
  for (const kind of cases) {
    const copy = path.join(parent, 'copy-' + kind);
    fs.cpSync(original, copy, { recursive: true });
    if (kind === 'manifest') fs.unlinkSync(path.join(copy, 'assets', 'media', 'manifest.json'));
    if (kind === 'missing') fs.unlinkSync(path.join(copy, 'assets', 'media', 'home-background.png'));
    if (kind === 'hash') {
      const file = path.join(copy, 'assets', 'media', 'home-background.png');
      const data = fs.readFileSync(file);
      data[data.length - 20] ^= 1;
      fs.writeFileSync(file, data);
    }
    if (kind === 'svg') {
      const data = Buffer.from('<svg width="64" height="64"><script>alert(1)</script></svg>');
      fs.writeFileSync(path.join(copy, 'assets', 'media', 'home-mark.svg'), data);
      const manifestFile = path.join(copy, 'assets', 'media', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const mark = manifest.items.find((item) => item.id === 'homeMark');
      mark.bytes = data.length;
      mark.sha256 = sha256(data);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    }
    if (kind === 'reference') {
      const file = path.join(copy, 'pages', 'home', 'index.wxml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('src="/assets/media/home-mark.svg"', 'src="/assets/media/missing.svg"'));
    }
    const verified = verifyMediaOutput(copy);
    assert.strictEqual(verified.ok, false, kind);
    const expected = kind === 'manifest' ? 'MEDIA_MANIFEST_MISSING' : kind === 'missing' ? 'MEDIA_FILE_MISSING' : kind === 'hash' ? 'MEDIA_HASH_MISMATCH' : kind === 'svg' ? 'MEDIA_SVG_UNSAFE' : 'MEDIA_HOME_REFERENCE_MISSING';
    assert.strictEqual(verified.code, expected);
  }
});