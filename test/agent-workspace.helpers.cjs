'use strict';

/**
 * B1 测试共用夹具（不是测试文件，不匹配 `*.test.cjs`）。
 *
 * 只做三件事：
 * - 定位仓库根 / Base 真源 / desktop/agent-workspace 目录；
 * - 提供 os.tmpdir() 下的临时目录（测试绝不写仓库）；
 * - 提供“仓库指纹”（相对路径 + 字节数 + mtime）用于证明正式仓库零写入。
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const AGENT_WORKSPACE_DIR = path.join(REPO, 'desktop', 'agent-workspace');
const FRONTEND_RECONSTRUCT_DIR = path.join(REPO, 'desktop', 'frontend-reconstruct');
const BASE_SOURCE_DIR = path.join(REPO, 'templates', 'base', 'ordering-base', '1.0.0', 'src');

function loadModule(name) {
  return require(path.join(AGENT_WORKSPACE_DIR, name + '.cjs'));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-' + prefix + '-'));
}

function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    /* 清理失败不掩盖断言结果 */
  }
}

/** 每个用例一个独立 userData 根，自动清理。 */
function userDataWith(t, prefix) {
  const dir = tempDir(prefix || 'user');
  t.after(() => removeDir(dir));
  return dir;
}

/** 创建目录型 junction（Windows 无管理员权限也可用）。 */
function createJunction(linkPath, targetPath) {
  fs.symlinkSync(targetPath, linkPath, 'junction');
}

/** 尝试创建文件 symlink；Windows 未开开发者模式时返回 false，由调用方降级。 */
function tryCreateFileSymlink(linkPath, targetPath) {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    return false;
  }
}

/** 递归列出目录下的普通文件（不跟随链接），返回按 POSIX 相对路径排序的 [{path,bytes}]。 */
function listRelativeFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        out.push({ path: relative, bytes: fs.statSync(full).size });
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256OfText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 仓库指纹：只读遍历指定目录，返回“相对路径|字节数|mtimeMs”拼接后的 sha256。
 * 任何新增/删除/内容或时间戳变化都会改变指纹。
 */
function repoFingerprint(dirs) {
  const lines = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        lines.push('link|' + path.relative(REPO, full));
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const stats = fs.statSync(full);
        lines.push(path.relative(REPO, full) + '|' + stats.size + '|' + stats.mtimeMs);
      }
    }
  };
  for (const dir of dirs) {
    const abs = path.join(REPO, dir);
    if (fs.existsSync(abs)) visit(abs);
  }
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/** 断言失败 envelope：ok=false、code 精确匹配、message 有界。 */
function assertFailure(result, code, label) {
  assert.strictEqual(result && result.ok, false, (label ? label + '：' : '') + '应当失败：' + JSON.stringify(result));
  assert.strictEqual(result.code, code, (label ? label + '：' : '') + '错误码不符：' + JSON.stringify(result));
  assert.ok(typeof result.message === 'string' && result.message.length > 0 && result.message.length <= 240,
    (label ? label + '：' : '') + 'message 必须有界：' + JSON.stringify(result));
  return result;
}

/** 断言结果里没有出现给定的绝对路径（防止错误/元数据泄漏本机路径）。 */
function assertNoPathLeak(value, needles) {
  const text = JSON.stringify(value);
  for (const needle of needles || []) {
    assert.ok(!text.includes(needle), '结果泄漏了绝对路径：' + needle + ' → ' + text);
  }
}

/** 读取目录下（不递归）的条目名。 */
function entriesOf(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    return [];
  }
}

module.exports = {
  REPO,
  AGENT_WORKSPACE_DIR,
  FRONTEND_RECONSTRUCT_DIR,
  BASE_SOURCE_DIR,
  loadModule,
  tempDir,
  removeDir,
  userDataWith,
  createJunction,
  tryCreateFileSymlink,
  listRelativeFiles,
  sha256OfFile,
  sha256OfText,
  repoFingerprint,
  assertFailure,
  assertNoPathLeak,
  entriesOf,
};
