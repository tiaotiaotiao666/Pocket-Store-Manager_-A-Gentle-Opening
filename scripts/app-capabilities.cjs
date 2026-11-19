#!/usr/bin/env node
/**
 * 生成 / 校验服务端只读能力快照。
 *
 * 事实源只有一个：`src/domain/appCapabilities.mjs`。
 * 服务端不允许手抄第二份字段限制；本脚本把目录写成
 * `server/src/agent/app-assistant/capabilities.snapshot.json`，`--check` 逐字节校验。
 *
 * 用法：
 *   node scripts/app-capabilities.cjs --write
 *   node scripts/app-capabilities.cjs --check
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'domain', 'appCapabilities.mjs');
const TARGET = path.join(ROOT, 'server', 'src', 'agent', 'app-assistant', 'capabilities.snapshot.json');

function serialize(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : (process.argv.includes('--check') ? 'check' : null);
  if (!mode) {
    console.error('用法：node scripts/app-capabilities.cjs --write | --check');
    process.exit(2);
  }

  const module = await import(pathToFileURL(SOURCE).href);
  const snapshot = module.buildAppCapabilitySnapshot();
  const expected = serialize(snapshot);

  if (mode === 'write') {
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.writeFileSync(TARGET, expected, 'utf8');
    console.log(`[app-capabilities] 已写入 ${path.relative(ROOT, TARGET)}（digest=${snapshot.digest}）`);
    return;
  }

  if (!fs.existsSync(TARGET)) {
    console.error(`[app-capabilities] 缺少快照：${path.relative(ROOT, TARGET)}；先运行 --write`);
    process.exit(1);
  }
  const actual = fs.readFileSync(TARGET, 'utf8');
  if (actual !== expected) {
    let hint = '内容不一致';
    try {
      const parsed = JSON.parse(actual);
      if (parsed.catalogVersion !== snapshot.catalogVersion) {
        hint = `catalogVersion 漂移：磁盘 ${parsed.catalogVersion} / 生成 ${snapshot.catalogVersion}`;
      } else if (parsed.digest !== snapshot.digest) {
        hint = `digest 漂移：磁盘 ${parsed.digest} / 生成 ${snapshot.digest}`;
      }
    } catch (error) {
      hint = '磁盘文件不是合法 JSON';
    }
    console.error(`[app-capabilities] ${hint}；重新运行 --write 并复核差异`);
    process.exit(1);
  }
  console.log(`[app-capabilities] 快照一致（digest=${snapshot.digest}）`);
}

main().catch((error) => {
  console.error(`[app-capabilities] 失败：${error && error.message ? error.message : error}`);
  process.exit(1);
});