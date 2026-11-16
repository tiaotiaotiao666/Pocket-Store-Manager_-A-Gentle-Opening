#!/usr/bin/env node
/**
 * W5：微信小程序导出工程静态审核。
 *
 * 用途：对 Composer 生成的导出目录做「不依赖 IDE」的结构审核，
 * 把可复现的检查固化成脚本，输出 PASS/FAIL 与细节，必要时落 JSON 证据。
 *
 * 用法：
 *   node scripts/wechat-export-audit.cjs <导出工程目录> [--json <证据路径>]
 *
 * 退出码：0 全部 PASS 或仅 BLOCKED 提示；1 存在 FAIL。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PAGE_EXTS = ['.js', '.json', '.wxml'];
const COMPONENT_EXTS = ['.js', '.json', '.wxml'];
const EXTERNAL_URL = /https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"()<>]+/g;
const EXTERNAL_ALLOW_HINT = /(apiBinding|baseUrl|示例|注释|README|生成报告)/;

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function classifyAppId(appid) {
  const value = String(appid || '').trim();
  if (/^wx[0-9a-f]{16}$/i.test(value)) return { kind: 'real', label: '真实 AppID' };
  if (value === 'touristappid') return { kind: 'tourist', label: '游客/测试占位 AppID（touristappid）' };
  if (!value) return { kind: 'empty', label: 'AppID 为空' };
  return { kind: 'unknown', label: '非标准 AppID：' + value };
}

/** 检查 app.json 声明的每个页面是否四件套齐全。 */
function checkPageQuadruples(root, pages) {
  const problems = [];
  for (const page of pages) {
    for (const ext of PAGE_EXTS) {
      const rel = page + ext;
      if (!exists(root, rel)) problems.push('缺少页面文件：' + rel);
    }
  }
  return problems;
}

/** 解析 usingComponents，返回解析不到的引用。 */
function checkUsingComponents(root, files) {
  const problems = [];
  const seen = new Set();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = readJson(path.join(root, file));
    } catch (error) {
      problems.push('JSON 解析失败：' + file + '（' + error.message + '）');
      continue;
    }
    const using = data && typeof data.usingComponents === 'object' && data.usingComponents
      ? data.usingComponents
      : null;
    if (!using) continue;
    for (const [name, target] of Object.entries(using)) {
      const raw = String(target || '');
      if (/^plugin:/.test(raw) || /^weui-miniprogram/.test(raw)) continue;
      if (!raw.startsWith('/') && !raw.startsWith('.')) {
        problems.push(file + ' 的组件 ' + name + ' 使用非相对路径：' + raw);
        continue;
      }
      const base = raw.startsWith('/')
        ? raw.slice(1)
        : path.posix.join(path.posix.dirname(file), raw);
      const normalized = base.replace(/^\.\//, '');
      seen.add(normalized);
      for (const ext of COMPONENT_EXTS) {
        if (!exists(root, normalized + ext)) {
          problems.push(file + ' 的组件 ' + name + ' 缺少 ' + normalized + ext);
        }
      }
      if (exists(root, normalized + '.json')) {
        let meta = null;
        try {
          meta = readJson(path.join(root, normalized + '.json'));
        } catch (error) {
          problems.push('组件 JSON 解析失败：' + normalized + '.json');
        }
        if (meta && meta.component !== true) {
          problems.push('组件 ' + normalized + '.json 缺少 component: true');
        }
      }
    }
  }
  return problems;
}

const SELF_CLOSING_OK = new Set(['image', 'input', 'icon', 'progress', 'switch', 'slider', 'checkbox', 'radio', 'textarea', 'audio', 'video', 'camera', 'canvas', 'map', 'web-view', 'import', 'include', 'wxs']);
const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'link']);

/** 粗粒度 WXML 标签配对检查，捕获真实存在的漏闭合。 */
function checkWxmlBalance(root, files) {
  const problems = [];
  for (const file of files) {
    if (!file.endsWith('.wxml')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\{\{[\s\S]*?\}\}/g, '');
    const stack = [];
    const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let match = tagPattern.exec(source);
    while (match) {
      const closing = match[1] === '/';
      const name = match[2].toLowerCase();
      const selfClosed = match[4] === '/';
      if (!closing && !selfClosed && !VOID_TAGS.has(name)) {
        stack.push(name);
      } else if (closing) {
        if (stack.length === 0) {
          problems.push(file + ' 出现多余闭合标签 <' + name + '>');
        } else if (stack[stack.length - 1] !== name) {
          problems.push(file + ' 标签未正确嵌套：期望 </' + stack[stack.length - 1] + '>，实际 </' + name + '>');
        } else {
          stack.pop();
        }
      }
      match = tagPattern.exec(source);
    }
    if (stack.length > 0) problems.push(file + ' 存在未闭合标签：' + stack.slice(-3).join(','));
  }
  return problems;
}

/** 本地资源引用必须存在文件；不允许外链。 */
function checkAssetReferences(root, files) {
  const problems = [];
  const external = [];
  for (const file of files) {
    if (!/\.(wxml|wxss|js|json)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const urgent of source.match(EXTERNAL_URL) || []) {
      external.push(file + ' → ' + urgent);
    }
    if (!file.endsWith('.wxml')) continue;
    const refPattern = /<image[^>]*\bsrc\s*=\s*"([^"{}]+)"/g;
    let match = refPattern.exec(source);
    while (match) {
      const src = match[1].trim();
      if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) {
        problems.push(file + ' 使用外部图片：' + src);
      } else {
        const rel = src.startsWith('/') ? src.slice(1) : path.posix.join(path.posix.dirname(file), src);
        if (!exists(root, rel)) problems.push(file + ' 引用不存在的图片：' + src);
      }
      match = refPattern.exec(source);
    }
  }
  return { problems, external };
}

/** wxss @import 与 js require 的本地路径必须存在。 */
function checkLocalModules(root, files) {
  const problems = [];
  for (const file of files) {
    if (file.endsWith('.wxss')) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const importPattern = /@import\s+["']([^"']+)["']/g;
      let match = importPattern.exec(source);
      while (match) {
        const raw = match[1];
        const rel = raw.startsWith('/') ? raw.slice(1) : path.posix.join(path.posix.dirname(file), raw);
        const target = path.posix.normalize(rel);
        if (!exists(root, target) && !exists(root, target + '.wxss')) {
          problems.push(file + ' 的 @import 目标不存在：' + raw);
        }
        match = importPattern.exec(source);
      }
      continue;
    }
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match = requirePattern.exec(source);
    while (match) {
      const raw = match[1];
      if (!raw.startsWith('.') && !raw.startsWith('/')) {
        problems.push(file + ' 引用非相对模块：' + raw);
        match = requirePattern.exec(source);
        continue;
      }
      const rel = raw.startsWith('/') ? raw.slice(1) : path.posix.join(path.posix.dirname(file), raw);
      const target = path.posix.normalize(rel);
      const candidates = [target, target + '.js', target + '.json', target + '/index.js'];
      if (!candidates.some((item) => exists(root, item))) {
        problems.push(file + ' 的 require 目标不存在：' + raw);
      }
      match = requirePattern.exec(source);
    }
  }
  return problems;
}

/** tabBar 图标与页面必须落地。 */
function checkTabBar(root, app) {
  const problems = [];
  const tabBar = app && app.tabBar;
  if (!tabBar) return problems;
  for (const item of Array.isArray(tabBar.list) ? tabBar.list : []) {
    if (!exists(root, item.pagePath + '.js')) problems.push('tabBar 页面未生成：' + item.pagePath);
    for (const key of ['iconPath', 'selectedIconPath']) {
      const value = item[key];
      if (typeof value === 'string' && value && !exists(root, value)) {
        problems.push('tabBar 图标缺失：' + value);
      }
    }
  }
  return problems;
}

function auditProject(root) {
  const checks = [];
  const record = (id, title, problems, extra) => {
    checks.push({
      id,
      title,
      status: problems.length === 0 ? 'PASS' : 'FAIL',
      problems,
      ...(extra || {}),
    });
  };

  const files = listFiles(root);
  const appJsonPath = path.join(root, 'app.json');
  let app = null;
  if (!fs.existsSync(appJsonPath)) {
    record('A1', 'app.json 存在且页面注册完整', ['缺少 app.json']);
  } else {
    try {
      app = readJson(appJsonPath);
    } catch (error) {
      record('A1', 'app.json 存在且页面注册完整', ['app.json 解析失败：' + error.message]);
    }
    if (app) {
      const pages = Array.isArray(app.pages) ? app.pages : [];
      const problems = pages.length === 0 ? ['app.json 未注册任何页面'] : checkPageQuadruples(root, pages);
      record('A1', 'app.json 存在且页面注册完整', problems, { pages: pages.length });
    }
  }

  const configPath = path.join(root, 'project.config.json');
  let appidInfo = { kind: 'missing', label: '缺少 project.config.json' };
  {
    const problems = [];
    if (!fs.existsSync(configPath)) {
      problems.push('缺少 project.config.json');
    } else {
      try {
        const config = readJson(configPath);
        appidInfo = { ...classifyAppId(config.appid), appid: config.appid || '' };
        if (config.compileType !== 'miniprogram') problems.push('compileType 不是 miniprogram：' + config.compileType);
        if (typeof config.miniprogramRoot !== 'string') problems.push('缺少 miniprogramRoot');
        if (!config.setting || config.setting.es6 !== true) problems.push('setting.es6 未开启');
        if (config.setting && config.setting.urlCheck !== false) problems.push('setting.urlCheck 未按演示工程关闭');
      } catch (error) {
        problems.push('project.config.json 解析失败：' + error.message);
      }
    }
    record('A2', 'project.config.json 可编译（compileType/miniprogramRoot/setting）', problems, { appid: appidInfo });
  }

  {
    const problems = [];
    if (!exists(root, 'sitemap.json')) problems.push('缺少 sitemap.json');
    else {
      try {
        const sitemap = readJson(path.join(root, 'sitemap.json'));
        if (!Array.isArray(sitemap.rules) || sitemap.rules.length === 0) problems.push('sitemap.rules 为空');
      } catch (error) {
        problems.push('sitemap.json 解析失败：' + error.message);
      }
    }
    for (const required of ['app.js', 'app.wxss']) {
      if (!exists(root, required)) problems.push('缺少 ' + required);
    }
    record('A3', 'sitemap 与 app.js/app.wxss 齐全', problems);
  }

  record('A4', 'tabBar 页面与图标落地', checkTabBar(root, app));
  record('A5', 'usingComponents 引用可解析', checkUsingComponents(root, files));
  record('A6', 'WXML 标签配对', checkWxmlBalance(root, files));
  const assetResult = checkAssetReferences(root, files);
  record('A7', '本地资源引用存在', assetResult.problems, { external: assetResult.external.slice(0, 20) });
  record('A8', 'WXSS @import 与 JS require 路径存在', checkLocalModules(root, files));

  {
    const problems = [];
    const externalInCode = assetResult.external.filter((item) => !EXTERNAL_ALLOW_HINT.test(item));
    if (externalInCode.length > 0) {
      problems.push('代码中出现外部链接：' + externalInCode.slice(0, 5).join('；'));
    }
    record('A9', '无随机外链（演示工程不依赖远程资源）', problems);
  }

  {
    const problems = [];
    let fileCount = null;
    let lockTree = null;
    const lockPath = path.join(root, 'composition.lock.json');
    const reportPath = path.join(root, 'generation-report.json');
    if (!fs.existsSync(lockPath)) problems.push('缺少 composition.lock.json');
    if (!fs.existsSync(reportPath)) problems.push('缺少 generation-report.json');
    let report = null;
    if (fs.existsSync(reportPath)) {
      try {
        report = readJson(reportPath);
      } catch (error) {
        problems.push('generation-report.json 解析失败：' + error.message);
      }
    }
    if (fs.existsSync(lockPath)) {
      try {
        const lock = readJson(lockPath);
        const digest = lock.outputDigest;
        const tree = digest && typeof digest === 'object' ? digest.tree : digest;
        if (typeof tree !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(tree)) {
          problems.push('lock.outputDigest 形状不符（应为 sha256 树摘要）');
        }
        if (digest && typeof digest === 'object' && !Array.isArray(digest.files)) {
          problems.push('lock.outputDigest.files 缺失');
        }
        if (typeof lock.lockDigest !== 'string') problems.push('lock.lockDigest 缺失');
        lockTree = tree;
      } catch (error) {
        problems.push('composition.lock.json 解析失败：' + error.message);
      }
    }
    if (report) {
      const listed = report.output && Array.isArray(report.output.files) ? report.output.files.length : null;
      if (listed === null) {
        problems.push('report.output.files 缺失');
      } else {
        fileCount = listed;
        // 磁盘上还包含锁文件、生成报告、说明文档，以及 AppID 后置写入产生的侧车记录，
        // 这些都由 Composer / AppID 后置流程写入元数据，不计入产物清单。
        const META_FILES = ['composition.lock.json', 'generation-report.json', '生成报告.md', 'appid-postprocess.json'];
        const payloadOnDisk = files.filter((item) => !META_FILES.includes(item)).length;
        if (listed !== payloadOnDisk) {
          problems.push('报告文件数与实际不一致：报告 ' + listed + ' / 实际产物 ' + payloadOnDisk);
        }
        if (report.output.treeSha256 && lockTree && report.output.treeSha256 !== lockTree) {
          problems.push('报告树摘要与锁文件不一致');
        }
      }
    }
    record('A10', '锁文件与生成报告一致', problems, {
      reportFileCount: fileCount,
      actualFileCount: files.length,
      wechatCompile: report && report.wechatCompile ? report.wechatCompile : null,
    });
  }

  const failed = checks.filter((item) => item.status === 'FAIL');
  return {
    schemaVersion: 'wechat-export-audit.v1',
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    fileCount: files.length,
    appid: appidInfo,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    checks,
  };
}

function renderSummary(result) {
  const lines = [];
  lines.push('微信小程序导出工程静态审核');
  lines.push('  工程：' + result.projectRoot);
  lines.push('  文件：' + result.fileCount + ' · AppID：' + (result.appid.label || '未知'));
  for (const check of result.checks) {
    lines.push('  ' + (check.status === 'PASS' ? '✓' : '✗') + ' [' + check.id + '] ' + check.title);
    for (const problem of check.problems.slice(0, 6)) lines.push('      - ' + problem);
  }
  lines.push('  结论：' + result.status);
  return lines.join('\n');
}

function main(argv) {
  const root = path.resolve(argv[2] || '');
  const jsonIndex = argv.indexOf('--json');
  const jsonOut = jsonIndex > -1 ? argv[jsonIndex + 1] : '';
  if (!argv[2] || !fs.existsSync(root)) {
    console.error('用法：node scripts/wechat-export-audit.cjs <导出工程目录> [--json <证据路径>]');
    process.exit(2);
  }
  const result = auditProject(root);
  console.log(renderSummary(result));
  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(result, null, 2), 'utf8');
    console.log('  证据：' + path.resolve(jsonOut));
  }
  process.exit(result.status === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { auditProject, classifyAppId, checkPageQuadruples, checkUsingComponents, checkWxmlBalance };
