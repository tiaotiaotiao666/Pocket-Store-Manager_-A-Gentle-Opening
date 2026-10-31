#!/usr/bin/env node
/**
 * 小程序静态校验（本机无微信开发者工具 CLI 时的编译前兜底）。
 *
 * 校验内容：
 * 1. app.json 页面注册与页面文件齐全
 * 2. 组件四件套与 usingComponents 路径
 * 3. JSON 可解析
 * 4. WXML 标签配对、属性闭合
 * 5. 事件绑定的处理函数在对应 JS 中存在
 * 6. 组件越界调用（wx.request / 固定路由 / globalData / 服务层 require）
 * 7. 页面直接 wx.request 与 require 路径存在性
 * 8. wx:for 是否带 wx:key
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');

let state = {
  root: path.join(repoRoot, 'miniprogram'),
  errors: [],
  warnings: [],
};

const BUILTIN_TAGS = new Set([
  'view', 'scroll-view', 'swiper', 'swiper-item', 'movable-area', 'movable-view', 'cover-view',
  'cover-image', 'icon', 'text', 'rich-text', 'progress', 'button', 'checkbox', 'checkbox-group',
  'form', 'input', 'label', 'picker', 'picker-view', 'picker-view-column', 'radio', 'radio-group',
  'slider', 'switch', 'textarea', 'navigator', 'audio', 'image', 'video', 'camera', 'live-player',
  'live-pusher', 'map', 'canvas', 'open-data', 'web-view', 'ad', 'official-account', 'block',
  'template', 'import', 'include', 'wxs', 'slot', 'page-meta', 'navigation-bar', 'match-media',
  'page-container', 'root-portal', 'editor', 'keyboard-accessory', 'functional-page-navigator',
  'share-element', 'sticky-header', 'sticky-section', 'grid-view', 'list-view', 'aria-component',
]);

function walk(dir, filter) {
  const result = [];
  if (!fs.existsSync(dir)) {
    return result;
  }
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        return;
      }
      result.push(...walk(full, filter));
    } else if (!filter || filter(full)) {
      result.push(full);
    }
  });
  return result;
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function rel(file) {
  return path.relative(state.root, file).replace(/\\/g, '/');
}

function addError(file, message) {
  state.errors.push(rel(file) + ': ' + message);
}

function addWarning(file, message) {
  state.warnings.push(rel(file) + ': ' + message);
}

function parseJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    addError(file, 'JSON 解析失败 ' + error.message);
    return null;
  }
}

function stripComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
}

function lineOf(content, offset) {
  return content.slice(0, offset).split('\n').length;
}

/**
 * 轻量 WXML 扫描：只做标签配对与属性提取，不追求完整 HTML 语义。
 */
function parseWxml(file) {
  const raw = read(file);
  const content = stripComments(raw);
  const stack = [];
  const elements = [];
  let index = 0;

  while (index < content.length) {
    const open = content.indexOf('<', index);
    if (open < 0) {
      break;
    }
    if (content.startsWith('<!--', open)) {
      const endComment = content.indexOf('-->', open);
      index = endComment < 0 ? content.length : endComment + 3;
      continue;
    }
    if (content.startsWith('</', open)) {
      const closeEnd = content.indexOf('>', open);
      if (closeEnd < 0) {
        addError(file, '第 ' + lineOf(content, open) + ' 行结束标签未闭合');
        break;
      }
      const name = content.slice(open + 2, closeEnd).trim();
      const top = stack.pop();
      if (!top) {
        addError(file, '第 ' + lineOf(content, open) + ' 行多余结束标签 </' + name + '>');
      } else if (top.name !== name) {
        addError(
          file,
          '第 ' + lineOf(content, open) + ' 行标签不匹配：<' + top.name + '>（第 ' + top.line + ' 行）被 </' + name + '> 关闭',
        );
      }
      index = closeEnd + 1;
      continue;
    }

    let cursor = open + 1;
    while (cursor < content.length && /[a-zA-Z0-9_\-:]/.test(content[cursor])) {
      cursor += 1;
    }
    const name = content.slice(open + 1, cursor);
    if (!name) {
      index = open + 1;
      continue;
    }

    let quote = '';
    let end = cursor;
    while (end < content.length) {
      const char = content[end];
      if (quote) {
        if (char === quote) {
          quote = '';
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      end += 1;
    }
    if (end >= content.length) {
      addError(file, '第 ' + lineOf(content, open) + ' 行标签 <' + name + '> 未闭合');
      break;
    }

    const attrText = content.slice(cursor, end);
    const selfClosing = /\/\s*$/.test(attrText);
    const attrs = {};
    const attrPattern = /([a-zA-Z0-9_:\-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match = attrPattern.exec(attrText);
    while (match) {
      attrs[match[1]] = match[3] !== undefined ? match[3] : match[4];
      match = attrPattern.exec(attrText);
    }

    const element = {
      name,
      attrs,
      line: lineOf(content, open),
      selfClosing,
      hasLoop: Object.prototype.hasOwnProperty.call(attrs, 'wx:for'),
      hasKey: Object.prototype.hasOwnProperty.call(attrs, 'wx:key'),
    };
    elements.push(element);

    if (!selfClosing) {
      stack.push(element);
    }
    index = end + 1;
  }

  stack.forEach((element) => {
    addError(file, '第 ' + element.line + ' 行 <' + element.name + '> 没有关闭');
  });

  return { elements, content };
}

function checkJsonFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return parseJson(file);
}

function resolveComponentDir(baseDir, target) {
  const resolved = target.startsWith('/')
    ? path.join(state.root, target.slice(1))
    : path.resolve(baseDir, target);
  if (path.basename(resolved) === 'index') {
    return path.dirname(resolved);
  }
  return resolved;
}

function checkComponentFiles(componentDir) {
  const base = path.join(componentDir, 'index');
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const file = base + '.' + ext;
    if (!fs.existsSync(file)) {
      errors.push(rel(componentDir) + ': 缺少 index.' + ext);
    }
  });
  const jsonFile = base + '.json';
  if (fs.existsSync(jsonFile)) {
    const json = parseJson(jsonFile);
    if (json && json.component !== true) {
      addError(jsonFile, '组件 json 必须包含 "component": true');
    }
  }
}

function checkWxss(file) {
  const raw = read(file);
  const openBraces = (raw.match(/\{/g) || []).length;
  const closeBraces = (raw.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    addError(file, 'WXSS 花括号不匹配：' + openBraces + ' 个 "{"，' + closeBraces + ' 个 "}"');
  }
  const openComment = (raw.match(/\/\*/g) || []).length;
  const closeComment = (raw.match(/\*\//g) || []).length;
  if (openComment !== closeComment) {
    addError(file, 'WXSS 注释未闭合');
  }
  const importPattern = /@import\s+["']([^"']+)["']\s*;/g;
  let match = importPattern.exec(raw);
  while (match) {
    const target = match[1];
    if (target.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) {
        addError(file, '@import 目标不存在：' + target);
      }
    }
    match = importPattern.exec(raw);
  }
}

function checkRequires(file, source) {
  const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match = pattern.exec(source);
  while (match) {
    const target = match[2];
    if (target.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), target);
      const candidates = [resolved, resolved + '.js', path.join(resolved, 'index.js')];
      if (!candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())) {
        addError(file, 'require 路径不存在：' + target);
      }
      if (!target.endsWith('.js') && !fs.existsSync(resolved) && fs.existsSync(resolved + '.js')) {
        addWarning(file, 'require 建议带 .js 后缀：' + target);
      }
    }
    match = pattern.exec(source);
  }
}

function eventHandlersFromWxml(elements) {
  const handlers = [];
  const eventPattern = /^(bind|catch|capture-bind|capture-catch)(:)?([a-zA-Z]+)$/;
  elements.forEach((element) => {
    Object.keys(element.attrs).forEach((name) => {
      if (!eventPattern.test(name)) {
        return;
      }
      const value = element.attrs[name].trim();
      if (!value || value.indexOf('{{') >= 0) {
        return;
      }
      handlers.push({ name: value, line: element.line, event: name });
    });
  });
  return handlers;
}

function checkHandlers(jsFile, handlers) {
  if (!fs.existsSync(jsFile)) {
    return;
  }
  const source = read(jsFile);
  handlers.forEach((handler) => {
    const pattern = new RegExp('(^|[^a-zA-Z0-9_$])' + handler.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
    if (!pattern.test(source)) {
      addError(jsFile, 'WXML 第 ' + handler.line + ' 行绑定了未定义的处理函数 ' + handler.name + '（' + handler.event + '）');
    }
  });
}

function checkWxml(file) {
  const raw = read(file);
  const { elements } = parseWxml(file);
  const openExpr = (raw.match(/\{\{/g) || []).length;
  const closeExpr = (raw.match(/\}\}/g) || []).length;
  if (openExpr !== closeExpr) {
    addError(file, '插值 {{ }} 数量不匹配：' + openExpr + ' 个 "{{"，' + closeExpr + ' 个 "}}"');
  }
  const exprPattern = /\{\{([\s\S]*?)\}\}/g;
  let match = exprPattern.exec(raw);
  while (match) {
    const expression = match[1];
    if (/=>|\?\.|\$\{|`/.test(expression)) {
      addError(file, 'WXML 表达式使用了不支持的语法：{{' + expression.trim().slice(0, 40) + '}}');
    }
    match = exprPattern.exec(raw);
  }
  elements.forEach((element) => {
    if (element.hasLoop && !element.hasKey) {
      addWarning(file, '第 ' + element.line + ' 行 wx:for 缺少 wx:key');
    }
  });
  return elements;
}

function checkPage(pageDir) {
  const base = path.join(pageDir, 'index');
  ['js', 'json', 'wxml'].forEach((ext) => {
    if (!fs.existsSync(base + '.' + ext)) {
      errors.push(rel(pageDir) + ': 缺少 index.' + ext);
    }
  });

  const json = checkJsonFile(base + '.json');
  const usingComponents = (json && json.usingComponents) || {};
  const allowed = new Set(BUILTIN_TAGS);

  Object.keys(usingComponents).forEach((tag) => {
    const target = usingComponents[tag];
    if (!target.startsWith('/') && !target.startsWith('.')) {
      allowed.add(tag);
      return;
    }
    const targetDir = resolveComponentDir(pageDir, target);
    checkComponentFiles(targetDir);
    allowed.add(tag);
  });

  const jsFile = base + '.js';
  if (fs.existsSync(jsFile)) {
    const source = read(jsFile);
    if (/\bwx\.request\s*\(/.test(source)) {
      addError(jsFile, '页面禁止直接调用 wx.request，请通过 services');
    }
    checkRequires(jsFile, source);
  }

  if (fs.existsSync(base + '.wxml')) {
    const elements = checkWxml(base + '.wxml');
    elements.forEach((element) => {
      if (!allowed.has(element.name) && !element.name.startsWith('wx-')) {
        addError(base + '.wxml', '第 ' + element.line + ' 行使用了未注册的组件 <' + element.name + '>');
      }
    });
    checkHandlers(jsFile, eventHandlersFromWxml(elements));
  }
  if (fs.existsSync(base + '.wxss')) {
    checkWxss(base + '.wxss');
  }
}

function checkComponent(componentDir) {
  checkComponentFiles(componentDir);
  const jsFile = path.join(componentDir, 'index.js');
  const wxmlFile = path.join(componentDir, 'index.wxml');

  if (fs.existsSync(jsFile)) {
    const source = read(jsFile);
    const forbidden = [
      { pattern: /\bwx\.request\s*\(/, message: '组件禁止调用 wx.request' },
      { pattern: /\bwx\.uploadFile\s*\(/, message: '组件禁止调用 wx.uploadFile' },
      { pattern: /\bwx\.navigateTo\s*\(/, message: '组件禁止固定路由 wx.navigateTo' },
      { pattern: /\bwx\.redirectTo\s*\(/, message: '组件禁止固定路由 wx.redirectTo' },
      { pattern: /\bwx\.switchTab\s*\(/, message: '组件禁止固定路由 wx.switchTab' },
      { pattern: /\bwx\.reLaunch\s*\(/, message: '组件禁止固定路由 wx.reLaunch' },
      { pattern: /\bglobalData\b/, message: '组件禁止读写 globalData' },
      { pattern: /require\(\s*['"][^'"]*services\//, message: '组件禁止 require 服务层' },
    ];
    forbidden.forEach((rule) => {
      if (rule.pattern.test(source)) {
        addError(jsFile, rule.message);
      }
    });
    checkRequires(jsFile, source);
  }

  if (fs.existsSync(wxmlFile)) {
    const elements = checkWxml(wxmlFile);
    checkHandlers(jsFile, eventHandlersFromWxml(elements));
  }

  const jsonFile = path.join(componentDir, 'index.json');
  if (fs.existsSync(jsonFile)) {
    const json = parseJson(jsonFile);
    const usingComponents = (json && json.usingComponents) || {};
    Object.keys(usingComponents).forEach((tag) => {
      const target = usingComponents[tag];
      if (target.startsWith('/') || target.startsWith('.')) {
        const targetDir = resolveComponentDir(componentDir, target);
        checkComponentFiles(targetDir);
      }
    });
  }
}

function runChecks(targetRoot) {
  const miniRoot = path.resolve(targetRoot);
  if (!fs.existsSync(miniRoot) || !fs.statSync(miniRoot).isDirectory()) {
    return {
      ok: false,
      fatal: true,
      errors: ['静态校验根目录不存在或不是目录：' + miniRoot],
      warnings: [],
      stats: { pages: 0, components: 0, js: 0, wxss: 0 },
    };
  }
  state = { root: miniRoot, errors: [], warnings: [] };

  const appJsonFile = path.join(miniRoot, 'app.json');
  const appJson = fs.existsSync(appJsonFile) ? parseJson(appJsonFile) : null;
  if (!appJson) {
    state.errors.push('无法读取 ' + path.join(miniRoot, 'app.json'));
    const stats = { pages: 0, components: 0, js: 0, wxss: 0 };
    return { ok: false, fatal: true, errors: [...state.errors], warnings: [], stats };
  }

  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  pages.forEach((page) => {
    const pageDir = path.dirname(path.join(miniRoot, page));
    if (!fs.existsSync(pageDir)) {
      state.errors.push('app.json: 页面目录不存在 ' + page);
      return;
    }
    checkPage(pageDir);
  });

  const tabList = appJson.tabBar && Array.isArray(appJson.tabBar.list) ? appJson.tabBar.list : [];
  tabList.forEach((tab) => {
    if (pages.indexOf(tab.pagePath) < 0) {
      state.errors.push('app.json: tabBar 页面未在 pages 注册 ' + tab.pagePath);
    }
  });

  const componentsDir = path.join(miniRoot, 'components');
  if (fs.existsSync(componentsDir)) {
    fs.readdirSync(componentsDir, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) {
        checkComponent(path.join(componentsDir, entry.name));
      }
    });
  }

  if (!fs.existsSync(path.join(miniRoot, 'app.js'))) {
    state.errors.push('缺少 app.js');
  }
  if (!fs.existsSync(path.join(miniRoot, 'app.wxss'))) {
    state.errors.push('缺少 app.wxss');
  }

  const jsFiles = walk(miniRoot, (file) => file.endsWith('.js'));
  const wxssFiles = walk(miniRoot, (file) => file.endsWith('.wxss'));
  wxssFiles.forEach((file) => checkWxss(file));
  jsFiles.forEach((file) => {
    try {
      new vm.Script(read(file), { filename: file });
    } catch (error) {
      addError(file, 'JS 语法错误：' + error.message);
    }
    const relative = path.relative(miniRoot, file).replace(/\\/g, '/');
    if (relative.startsWith('services/') || relative.startsWith('domain/') || relative.startsWith('state/')) {
      const source = read(file);
      checkRequires(file, source);
      if (relative.startsWith('services/') && relative !== 'services/platform.js' && /\bwx\.request\s*\(/.test(source)) {
        addError(file, 'wx.request 只允许出现在 services/platform.js');
      }
    }
  });

  return {
    ok: state.errors.length === 0,
    fatal: false,
    errors: [...state.errors],
    warnings: [...state.warnings],
    stats: {
      pages: pages.length,
      components: fs.existsSync(componentsDir) ? fs.readdirSync(componentsDir).filter((name) => fs.statSync(path.join(componentsDir, name)).isDirectory()).length : 0,
      js: jsFiles.length,
      wxss: wxssFiles.length,
    },
  };
}

function printResult(result) {
  console.log('小程序静态校验：' + result.stats.pages + ' 个页面，' +
    result.stats.components + ' 个组件目录，' +
    result.stats.js + ' 个 JS 文件，' + result.stats.wxss + ' 个 WXSS 文件');

  result.warnings.forEach((warning) => console.log('  ⚠ ' + warning));
  if (result.errors.length > 0) {
    result.errors.forEach((error) => console.log('  ✗ ' + error));
    console.error('\n静态校验失败：' + result.errors.length + ' 个错误，' + result.warnings.length + ' 个警告');
    process.exitCode = 1;
    return;
  }
  console.log('  ✓ 标签配对、组件注册、事件处理函数、越界调用与 require 路径检查通过');
  console.log('静态校验通过：0 个错误，' + result.warnings.length + ' 个警告\n');
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  let target = path.join(repoRoot, 'miniprogram');
  if (rootIndex >= 0) {
    target = args[rootIndex + 1];
    if (!target) {
      console.error('参数错误：--root 需要一个目录路径');
      process.exitCode = 2;
      return;
    }
  }
  const result = runChecks(target);
  if (result.fatal) {
    console.error(result.errors[0]);
    process.exitCode = 1;
    return;
  }
  printResult(result);
}

if (require.main === module) {
  main();
}

module.exports = { runChecks, main, repoRoot };