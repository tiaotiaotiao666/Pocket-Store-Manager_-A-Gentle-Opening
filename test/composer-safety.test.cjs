'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const safety = require(path.join(path.resolve(__dirname, '..'), 'scripts', 'composer', 'safety.cjs'));

function codes(result) {
  const list = Array.isArray(result) ? result : result.findings;
  return list.map((finding) => finding.code);
}

test('秘密扫描命中文件与行号', () => {
  const result = safety.scanText('const k = "sk-abcdefgh12345678";\n', { file: 'asset/index.js', mode: 'production' });
  assert.strictEqual(result[0].code, 'SECRET_DETECTED');
  assert.strictEqual(result[0].file, 'asset/index.js');
  assert.strictEqual(result[0].line, 1);
});

test('绝对路径、内网地址与数据库连接串被拒绝', () => {
  const text = [
    'const p = "D:\\\\projects\\\\store";',
    'const host = "192.168.1.20";',
    'const url = "mysql://root:pass@localhost/db";',
  ].join('\n');
  const found = codes(safety.scanText(text, { mode: 'production', allowExternalUrls: true }));
  assert.ok(found.includes('PATH_ESCAPE'));
  assert.ok(found.includes('INTERNAL_ADDRESS'));
  assert.ok(found.includes('DB_CONNECTION'));
});

test('development 允许本地地址，production 拒绝', () => {
  const text = 'const baseUrl = "http://127.0.0.1:3000/api/v1";\n';
  assert.strictEqual(safety.scanText(text, { mode: 'development' }).length, 0);
  const production = safety.scanText(text, { mode: 'production' });
  assert.ok(codes(production).includes('LOCALHOST_IN_PRODUCTION'));
});

test('baseUrl 行允许 HTTPS 公网域名，其他外部 URL 默认拒绝', () => {
  const allowed = safety.scanText('const baseUrl = "https://api.example.com";\n', { mode: 'production' });
  assert.strictEqual(allowed.length, 0);
  const rejected = safety.scanText('const webhook = "https://evil.example.com/hook";\n', { mode: 'production' });
  assert.ok(codes(rejected).includes('EXTERNAL_URL'));
});

test('产物禁止宿主依赖与旧运行时常量', () => {
  const text = [
    'const root = process.env.APP_ROOT;',
    'require("../src/domain/catalog.mjs");',
    'require("node:fs");',
  ].join('\n');
  const found = codes(safety.scanText(text, { mode: 'development', file: 'app.js', output: true }));
  assert.ok(found.includes('OUTPUT_HOST_DEPENDENCY'));
});

test('scanOutput 递归扫描目录文本文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'store.generated.js'), 'module.exports = { token: "sk-1234567890abcdef" };\n');
  const result = safety.scanOutput(dir, { mode: 'production' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === 'SECRET_DETECTED'));
  assert.ok(result.findings.some((finding) => finding.file === 'config/store.generated.js'));
});

test('干净资产通过扫描', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-clean-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'Component({ properties: { title: String } });\n');
  const result = safety.scanSources([dir], { mode: 'production' });
  assert.strictEqual(result.ok, true, JSON.stringify(result.findings));
});