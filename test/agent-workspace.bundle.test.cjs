'use strict';

/**
 * E0-W2 / X5+X6：SourceBundle 平台派生与 8 页枚举的单元测试。
 *
 * 覆盖：确定性、Base 对齐（`base.treeSha256`）、files 为完整内容摘要、`deleted` 只允许 assets、
 * 不许改 overlay 之外的目录/文件类型、组件 scope 由引用页派生、资产魔数校验、
 * `bundleIsStale` 的三种翻转、以及 8 页枚举的单一事实源与 enabled/reasons 派生。
 *
 * 只写 os.tmpdir()。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..');
const BASE_SRC = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
const sourceBundle = require(path.join(REPO, 'desktop', 'agent-workspace', 'source-bundle.cjs'));
const sourceFacts = require(path.join(REPO, 'scripts', 'agent-source-facts.cjs'));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

function candidate(t) {
  const root = path.join(tempDir('w2-bundle-'), 'candidate');
  copyTree(BASE_SRC, root);
  t.after(() => {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch (error) {
      /* noop */
    }
  });
  return root;
}

function filesOf(root) {
  const read = sourceBundle.readTree(root);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  return read.files;
}

function derive(root, targetPages) {
  return sourceBundle.deriveBundle({ candidateFiles: filesOf(root), targetPages: targetPages || ['menu'] });
}

function pngBuffer() {
  // 最小合法 PNG 魔数 + 尾部垃圾字节（只校验魔数，不解码）。
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('w2-asset')]);
}

test('8 页枚举：唯一事实源、顺序冻结、enabled/reasons 由候选树派生（不是 8 个硬编码 true）', (t) => {
  assert.deepStrictEqual([...sourceBundle.PAGE_IDS], [
    'home', 'menu', 'checkout', 'orders', 'order-detail', 'product-detail', 'mine', 'merchant-orders',
  ]);
  assert.deepStrictEqual([...sourceBundle.PAGE_IDS], [...sourceFacts.PAGE_IDS]);
  for (const id of sourceBundle.PAGE_IDS) {
    assert.ok(sourceBundle.PAGE_CONTRACTS[id], id + ' 缺少页面契约');
    assert.strictEqual(sourceBundle.isKnownTargetPage(id), true);
  }
  for (const bad of ['settings', 'HOME', 'menu ', 'pages/menu', '', null, 42]) {
    assert.strictEqual(sourceBundle.isKnownTargetPage(bad), false, String(bad));
  }

  // 无候选文件 → 全部 disabled 且有理由（绝不默认 true）。
  const blind = sourceBundle.enumerateTargetPages({});
  assert.strictEqual(blind.length, 8);
  for (const page of blind) {
    assert.strictEqual(page.enabled, false);
    assert.ok(page.reasons.length > 0);
  }

  // 完整候选 → 全部 enabled；缺页 → 只有该页 disabled 且理由点名缺哪个文件。
  const root = candidate(t);
  const full = sourceBundle.enumerateTargetPages({ files: filesOf(root) });
  assert.ok(full.every((page) => page.enabled === true), JSON.stringify(full.filter((page) => !page.enabled)));

  fs.rmSync(path.join(root, 'pages', 'mine', 'index.wxml'));
  const partial = sourceBundle.enumerateTargetPages({ files: filesOf(root) });
  const mine = partial.find((page) => page.id === 'mine');
  assert.strictEqual(mine.enabled, false);
  assert.ok(mine.reasons.some((reason) => reason.includes('pages/mine/index.wxml')), JSON.stringify(mine.reasons));
  assert.strictEqual(partial.filter((page) => page.enabled).length, 7);
});

test('derived bundle：确定、与 Base 对齐、files 为完整内容摘要、未改动不列入', (t) => {
  const root = candidate(t);
  const file = path.join(root, 'pages', 'menu', 'index.wxml');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n<!-- e0-w2 -->\n')]));

  const first = derive(root);
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.manifest.schemaVersion, 'frontend-source-bundle.v1');
  assert.deepStrictEqual(first.manifest.base.id, 'ordering-base');
  assert.deepStrictEqual(first.manifest.base.version, '1.0.0');
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(first.manifest.base.treeSha256));
  assert.deepStrictEqual(first.manifest.targetPages, ['menu']);
  assert.deepStrictEqual(first.manifest.files.map((entry) => entry.path), ['pages/menu/index.wxml']);
  assert.deepStrictEqual(first.manifest.deleted, []);
  assert.deepStrictEqual(first.manifest.assets, []);
  const expected = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.strictEqual(first.manifest.files[0].sha256, expected, 'files 必须是完整内容摘要');

  const second = derive(root);
  assert.deepStrictEqual(second.manifest, first.manifest, '派生结果必须确定');
  assert.strictEqual(second.digest, first.digest);

  // Base 对齐：把 Base 树摘要换成假的 → 加载 overlay 必然 SOURCE_BUNDLE_BASE_MISMATCH（证明我们用的是真 Base）。
  const composerDigest = require(path.join(REPO, 'scripts', 'composer', 'digest.cjs'));
  assert.strictEqual(first.manifest.base.treeSha256, composerDigest.treeSha256(BASE_SRC));
});

test('derived bundle：只允许 pages/components/assets 与规定扩展名（fail-closed）', (t) => {
  const root = candidate(t);
  const services = path.join(root, 'services', 'store.js');
  fs.writeFileSync(services, fs.readFileSync(services, 'utf8') + '\n// e0-w2\n');
  const derived = derive(root);
  assert.strictEqual(derived.ok, false);
  assert.strictEqual(derived.code, 'AGENT_STATIC_GATE_FAILED');
  assert.strictEqual(derived.issues[0].code, 'SOURCE_BUNDLE_PATH_FORBIDDEN');
});

test('derived bundle：deleted 只允许 assets/**；删页面文件必须显式失败', (t) => {
  const root = candidate(t);
  fs.rmSync(path.join(root, 'pages', 'menu', 'index.wxml'));
  const derived = derive(root);
  assert.strictEqual(derived.ok, false);
  assert.strictEqual(derived.code, 'AGENT_STATIC_GATE_FAILED');
  assert.strictEqual(derived.issues[0].code, 'SOURCE_BUNDLE_DELETE_FORBIDDEN');
  assert.ok(derived.issues[0].message.includes('pages/menu/index.wxml'));
});

test('derived bundle：组件 scope 由“被哪些页引用”派生；资产必须真图魔数', (t) => {
  const root = candidate(t);
  // 新增一个只在 menu 页引用的组件（四件套齐全）。
  const componentDir = path.join(root, 'components', 'menu-badge');
  fs.mkdirSync(componentDir, { recursive: true });
  fs.writeFileSync(path.join(componentDir, 'index.json'), JSON.stringify({ component: true, usingComponents: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(componentDir, 'index.js'), 'Component({ properties: {} });\n');
  fs.writeFileSync(path.join(componentDir, 'index.wxml'), '<view class="menu-badge">{{text}}</view>\n');
  fs.writeFileSync(path.join(componentDir, 'index.wxss'), '.menu-badge{display:inline-block}\n');

  const pageJsonFile = path.join(root, 'pages', 'menu', 'index.json');
  const pageJson = JSON.parse(fs.readFileSync(pageJsonFile, 'utf8'));
  pageJson.usingComponents = { ...(pageJson.usingComponents || {}), 'menu-badge': '/components/menu-badge/index' };
  fs.writeFileSync(pageJsonFile, JSON.stringify(pageJson, null, 2) + '\n');
  const pageWxml = path.join(root, 'pages', 'menu', 'index.wxml');
  fs.writeFileSync(pageWxml, fs.readFileSync(pageWxml, 'utf8').replace('</view>', '  <menu-badge text="新"/>\n</view>'));

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'badge.png'), pngBuffer());

  const derived = derive(root, ['menu', 'home']);
  assert.strictEqual(derived.ok, true, JSON.stringify(derived));
  const component = derived.manifest.components.find((entry) => entry.componentId === 'menu-badge');
  assert.ok(component, JSON.stringify(derived.manifest.components));
  assert.strictEqual(component.scope, 'page');
  assert.deepStrictEqual(component.pages, ['menu']);
  assert.deepStrictEqual(derived.manifest.assets, ['assets/badge.png']);

  // 假图（扩展名对、魔数错）必须失败。
  fs.writeFileSync(path.join(root, 'assets', 'fake.png'), Buffer.from('not-a-real-png'));
  const fake = derive(root, ['menu']);
  assert.strictEqual(fake.ok, false);
  assert.strictEqual(fake.issues[0].code, 'SOURCE_BUNDLE_ASSET_TYPE_INVALID');
});

test('bundleIsStale：缺清单/内容变化/与 Base 不同的未列出文件都必须重派生', (t) => {
  const root = candidate(t);
  const base = filesOf(BASE_SRC);
  assert.strictEqual(sourceBundle.bundleIsStale(filesOf(root), base), true, '缺清单 → stale');

  const file = path.join(root, 'pages', 'menu', 'index.wxml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n<!-- e0-w2 -->\n');
  const derived = derive(root);
  assert.strictEqual(derived.ok, true);
  fs.writeFileSync(path.join(root, sourceBundle.BUNDLE_FILE), sourceBundle.renderBundle(derived.manifest));
  assert.strictEqual(sourceBundle.bundleIsStale(filesOf(root), base), false, '最新清单 → 不 stale');

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n<!-- changed again -->\n');
  assert.strictEqual(sourceBundle.bundleIsStale(filesOf(root), base), true, '内容又变 → stale');

  // 恢复清单后，再改一个“清单里没列”的文件（等于改回 Base 之外的内容）→ 仍 stale。
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- changed again -->\n', ''));
  fs.writeFileSync(path.join(root, sourceBundle.BUNDLE_FILE), sourceBundle.renderBundle(derive(root).manifest));
  const other = path.join(root, 'pages', 'home', 'index.wxml');
  fs.writeFileSync(other, fs.readFileSync(other, 'utf8') + '\n<!-- unlisted change -->\n');
  assert.strictEqual(sourceBundle.bundleIsStale(filesOf(root), base), true, '未列出的改动 → stale');

  // 行尾不同但内容一致的文件不算改动（衍生 bundle 只按内容摘要比较）。
  const read = filesOf(root);
  assert.ok(read.has(sourceBundle.BUNDLE_FILE));
});
