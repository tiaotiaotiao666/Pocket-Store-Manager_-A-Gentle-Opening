// T15 门禁 9：构建产物密钥/内联图片扫描（只读验证，不修改任何生产文件）
// 输出只包含文件路径与计数，绝不输出密钥原文。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
// 默认扫描真实构建产物；可通过 argv 传入目录做扫描器自检（例如诱饵目录）。
const ARGS = process.argv.slice(2);
const TARGETS = ARGS.length > 0 ? ARGS : ['dist', 'server/dist'];
const ENV_PATH = process.env.SCAN_ENV_PATH
  ? path.resolve(process.env.SCAN_ENV_PATH)
  : path.join(ROOT, 'server', '.env');

function readEnvKey(key) {
  if (!fs.existsSync(ENV_PATH)) return { present: false, value: '' };
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  let found = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (m[1] === key) {
      found = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { present: Boolean(found), value: found };
}

function walk(dir, out, skipDirs) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      walk(abs, out, skipDirs);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

const keyInfo = readEnvKey('DEEPSEEK_API_KEY');
const files = [];
for (const target of TARGETS) {
  walk(path.join(ROOT, target), files, new Set(['node_modules', '.git']));
}

const result = {
  scannedRoots: TARGETS,
  scannedFileCount: files.length,
  env: {
    envFileExists: fs.existsSync(ENV_PATH),
    deepseekKeyPresent: keyInfo.present,
  },
  deepseekValueHits: [],
  skPrefixHits: [],
  inlineImageHits: [],
};

const keyValue = keyInfo.value;
for (const file of files) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    continue;
  }
  // 大文件（>32MB）跳过，避免误吞二进制产物
  if (buf.length > 32 * 1024 * 1024) continue;
  const text = buf.toString('latin1');

  if (keyValue.length >= 6) {
    let idx = text.indexOf(keyValue);
    let count = 0;
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(keyValue, idx + keyValue.length);
    }
    if (count > 0) {
      result.deepseekValueHits.push({ file: path.relative(ROOT, file), occurrences: count });
    }
  }

  // sk- 前缀密钥（排除普通英文连字符词；要求高熵字符集长度 >=8）
  const skRegex = /(?:^|[^A-Za-z0-9_])sk-[A-Za-z0-9]{12,}/g;
  let skMatch;
  let skCount = 0;
  while ((skMatch = skRegex.exec(text)) !== null) {
    skCount += 1;
  }
  if (skCount > 0) {
    result.skPrefixHits.push({ file: path.relative(ROOT, file), occurrences: skCount });
  }

  // data:image/...;base64,<payload>，统计 >1KB 的 base64 大块
  const imgRegex = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)/g;
  let imgMatch;
  let bigCount = 0;
  let maxLen = 0;
  while ((imgMatch = imgRegex.exec(text)) !== null) {
    const payloadLen = imgMatch[1].replace(/\s+/g, '').length;
    if (payloadLen > 1024) {
      bigCount += 1;
      if (payloadLen > maxLen) maxLen = payloadLen;
    }
  }
  if (bigCount > 0) {
    result.inlineImageHits.push({
      file: path.relative(ROOT, file),
      occurrences: bigCount,
      maxBase64Length: maxLen,
    });
  }
}

console.log(JSON.stringify(result, null, 2));
const failed =
  result.deepseekValueHits.length > 0 ||
  result.skPrefixHits.length > 0 ||
  result.inlineImageHits.length > 0;
process.exit(failed ? 2 : 0);