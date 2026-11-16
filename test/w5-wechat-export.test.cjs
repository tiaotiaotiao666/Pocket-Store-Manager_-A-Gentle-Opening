const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const AUDIT = path.join(REPO, 'scripts', 'wechat-export-audit.cjs');
const RUNNER = path.join(REPO, 'scripts', 'wechat-devtools-run.cjs');
const STUB = path.join(REPO, 'scripts', 'wechat-runtime-stub.cjs');
const { auditProject, classifyAppId, checkPageQuadruples } = require(AUDIT);

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-audit-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  return root;
}

const MINIMAL = {
  'app.js': 'App({});',
  'app.wxss': 'page { color: #111; }',
  'app.json': {
    pages: ['pages/home/index'],
    tabBar: {
      list: [{ pagePath: 'pages/home/index', text: '首页', iconPath: 'assets/tab/home.png', selectedIconPath: 'assets/tab/home.png' }],
    },
  },
  'sitemap.json': { rules: [{ action: 'allow', page: '*' }] },
  'assets/tab/home.png': 'png',
  'pages/home/index.js': 'Page({});',
  'pages/home/index.json': { usingComponents: { 'store-header': '../../components/store-header/index' } },
  'pages/home/index.wxml': '<view class="home"><store-header /><image src="../../assets/tab/home.png" /></view>',
  'components/store-header/index.js': 'Component({});',
  'components/store-header/index.json': { component: true },
  'components/store-header/index.wxml': '<view class="h">{{name}}</view>',
  'project.config.json': { appid: 'wx0123456789abcdef', compileType: 'miniprogram', miniprogramRoot: './', setting: { es6: true, urlCheck: false } },
  'composition.lock.json': { outputDigest: { tree: 'sha256:' + 'a'.repeat(64), files: [] }, lockDigest: 'sha256:' + 'b'.repeat(64) },
};

test('W5 导出审核：结构完整的工程判定为 PASS', () => {
  const files = { ...MINIMAL };
  files['generation-report.json'] = {
    output: { treeSha256: 'sha256:' + 'a'.repeat(64), files: Object.keys(MINIMAL).filter((item) => !item.endsWith('.png')).map((item) => ({ path: item })) },
  };
  const root = makeProject(files);
  const result = auditProject(root);
  assert.equal(result.status, 'PASS');
  assert.equal(result.checks.length, 10);
  assert.equal(result.appid.kind, 'real');
});

test('W5b 导出审核：AppID 后置写入的侧车记录不计入产物清单', () => {
  // 真实导出 + desktop/appid-postprocess.cjs 会在产物根写入 appid-postprocess.json，
  // 它属于元数据，不能让 A10「报告文件数 vs 磁盘产物数」误判。
  const files = { ...MINIMAL };
  files['generation-report.json'] = {
    output: { treeSha256: 'sha256:' + 'a'.repeat(64), files: Object.keys(MINIMAL).filter((item) => !item.endsWith('.png')).map((item) => ({ path: item })) },
  };
  files['appid-postprocess.json'] = { appidMasked: 'wx0123********cdef', appliedAt: '2026-11-16T09:29:15Z' };
  const root = makeProject(files);
  const result = auditProject(root);
  assert.equal(result.status, 'PASS');
  const a10 = result.checks.find((check) => check.id === 'A10');
  assert.equal(a10.status, 'PASS');
});

test('W5 导出审核：缺页面文件与坏组件引用必须报 FAIL', () => {
  const files = { ...MINIMAL };
  delete files['pages/home/index.wxml'];
  files['pages/home/index.json'] = { usingComponents: { 'store-header': '../../components/missing/index' } };
  files['project.config.json'] = { appid: 'touristappid', compileType: 'game', miniprogramRoot: './', setting: { es6: false, urlCheck: true } };
  files['generation-report.json'] = { output: { treeSha256: 'sha256:' + 'c'.repeat(64), files: [] } };
  const root = makeProject(files);
  const result = auditProject(root);
  assert.equal(result.status, 'FAIL');
  const pageCheck = result.checks.find((item) => item.id === 'A1');
  assert.equal(pageCheck.status, 'FAIL');
  assert.ok(pageCheck.problems.some((item) => item.includes('index.wxml')));
  const componentCheck = result.checks.find((item) => item.id === 'A5');
  assert.ok(componentCheck.problems.some((item) => item.includes('missing')));
  const configCheck = result.checks.find((item) => item.id === 'A2');
  assert.ok(configCheck.problems.some((item) => item.includes('compileType')));
  assert.equal(result.appid.kind, 'tourist');
});

test('W5 导出审核：页面四件套检查按扩展名逐个比对', () => {
  const root = makeProject({ 'pages/a/index.js': 'Page({});' });
  const problems = checkPageQuadruples(root, ['pages/a/index']);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((item) => item.includes('index.json')));
  assert.ok(problems.some((item) => item.includes('index.wxml')));
});

test('W5 导出审核：AppID 分类覆盖真实/游客/空值', () => {
  assert.equal(classifyAppId('wx0123456789abcdef').kind, 'real');
  assert.equal(classifyAppId('touristappid').kind, 'tourist');
  assert.equal(classifyAppId('').kind, 'empty');
  assert.equal(classifyAppId('custom-id').kind, 'unknown');
});

test('W5 编译验证脚本：CLI 不存在或工程缺失时如实 BLOCKED', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-run-'));
  const result = spawnSync(process.execPath, [RUNNER, path.join(empty, 'nope')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /结论：BLOCKED/);
});

test('W5 编译验证脚本：识别 AppID 拒绝与端口未开启两类阻塞', () => {
  const { detectBlockedReason } = require(RUNNER);
  assert.match(detectBlockedReason({ stdout: "code: 'APPID_ERROR'", stderr: '' }), /APPID_ERROR/);
  assert.match(detectBlockedReason({ stdout: 'IDE service port disabled', stderr: '' }), /SERVICE_PORT_DISABLED/);
  assert.equal(detectBlockedReason({ stdout: '√ IDE server has started', stderr: '' }), '');
});

test('W5 桩后端：只提供演示只读接口，不接数据库', async () => {
  const source = fs.readFileSync(STUB, 'utf8');
  assert.match(source, /这不是真实后端/);
  assert.ok(!/mysql|prisma|process\.env\.DATABASE_URL/i.test(source));
  const { createServer } = require(STUB);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch('http://127.0.0.1:' + port + '/api/v1/stores/store-demo-001/catalog');
  const body = await response.json();
  assert.ok(Array.isArray(body.categories) && body.categories.length >= 2);
  assert.ok(body.categories.every((item) => Array.isArray(item.products)));
  server.close();
});
