'use strict';

/**
 * 共享 source-check 编排器（C2）。
 *
 * 输入：虚拟文件集 `{path, content}`（相对路径）+ C1 SourceFacts；
 * 输出：有界 issues `{file,line,column,code,message,source}`，无绝对路径/源码全文。
 *
 * 不访问网络、不执行被检查源码；解析失败 fail-closed（parse issue 直接返回）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { SourceParseError, parseWxml, parseJson, lineColumn, loadTypeScript } = require('./parse.cjs');
const { validatePageBindings, validateExpressionSyntaxOnly } = require('./bindings.cjs');
const { validatePageEvents } = require('./events.cjs');
const { validateUsingComponents, validateComponentTags } = require('./components.cjs');
const { validateWxss } = require('./wxss.cjs');
const { validateJs } = require('./js-policy.cjs');

const MAX_ISSUES = 200;
const PAGE_IDS = ['home', 'menu', 'checkout', 'orders', 'order-detail', 'product-detail', 'mine', 'merchant-orders'];

const APP_ALLOWED_KEYS = new Set([
  'pages', 'window', 'tabBar', 'style', 'sitemapLocation', 'permission', 'requiredPrivateInfos',
  'networkTimeout', 'subPackages', 'subpackages', 'plugins', 'lazyCodeLoading', 'renderer',
  'componentFramework', 'entryPagePath', 'workers', 'preloadRule', 'resizable', 'darkmode',
]);
const APP_CONTRACT_KEYS = {
  pages: 'routes',
  entryPagePath: 'routes',
  subPackages: 'routes',
  subpackages: 'routes',
  tabBar: 'tabBar',
  networkTimeout: 'network',
  permission: 'permission',
  requiredPrivateInfos: 'permission',
  plugins: 'plugins',
};
const PAGE_ALLOWED_KEYS = new Set([
  'navigationBarTitleText', 'navigationBarBackgroundColor', 'navigationBarTextStyle',
  'enablePullDownRefresh', 'backgroundTextStyle', 'backgroundColor', 'disableScroll',
  'onReachBottomDistance', 'navigationStyle', 'usingComponents', 'componentPlaceholder',
  'styleIsolation', 'renderer', 'pageOrientation', 'restartStrategy',
]);
const PAGE_FORBIDDEN_KEYS = new Set(['pages', 'tabBar', 'subPackages', 'subpackages', 'networkTimeout', 'permission', 'requiredPrivateInfos', 'plugins', 'sitemapLocation']);
const COMPONENT_ALLOWED_KEYS = new Set(['component', 'usingComponents', 'styleIsolation', 'options', 'externalClasses', 'relations', 'observers', 'renderer']);
const COMPONENT_FORBIDDEN_KEYS = new Set(['pages', 'tabBar', 'subPackages', 'subpackages', 'networkTimeout', 'permission', 'requiredPrivateInfos', 'plugins', 'sitemapLocation']);

let cachedFacts = null;
let cachedTypeScript = null;

function loadFacts() {
  if (cachedFacts) return cachedFacts;
  const generator = require('../agent-source-facts.cjs');
  cachedFacts = generator.buildSnapshot();
  return cachedFacts;
}

function resetFactsCacheForTests() {
  cachedFacts = null;
}

function normalizePath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

function pageIdFromPath(file) {
  const normalized = normalizePath(file);
  const match = /(?:^|\/)pages\/([a-z0-9-]+)\//.exec(normalized);
  return match ? match[1] : null;
}

function componentIdFromPath(file) {
  const normalized = normalizePath(file);
  const match = /(?:^|\/)components\/([a-z0-9-]+)\//.exec(normalized);
  return match ? match[1] : null;
}

function fileExistsFromMap(files) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const map = new Map();
  for (const item of files) map.set(normalizePath(item.path), item);
  return (relative) => {
    const normalized = normalizePath(relative);
    if (map.has(normalized)) return true;
    const basePrefix = 'templates/base/ordering-base/1.0.0/src/';
    if (normalized.startsWith(basePrefix) && map.has(normalized.slice(basePrefix.length))) return true;
    return fs.existsSync(path.join(repoRoot, normalized));
  };
}

function readTextFileFromMap(files, file) {
  const map = new Map();
  for (const item of files) map.set(normalizePath(item.path), item);
  const entry = map.get(normalizePath(file));
  return entry ? String(entry.content) : null;
}

function addBounded(issues, issue) {
  if (issues.length >= MAX_ISSUES) return;
  const normalized = {
    file: normalizePath(issue.file),
    line: Number.isInteger(issue.line) && issue.line > 0 ? issue.line : 1,
    column: Number.isInteger(issue.column) && issue.column > 0 ? issue.column : 1,
    code: String(issue.code || 'SOURCE_CHECK_ISSUE'),
    message: String(issue.message || '').slice(0, 180),
    source: String(issue.source || 'source-check'),
  };
  if (/^[A-Za-z]:[\\/]/.test(normalized.file) || normalized.file.startsWith('/')) {
    normalized.file = '<invalid-absolute-path>';
  }
  issues.push(normalized);
}

function scanJsonUrls(value, file, issues, pathPrefix) {
  if (typeof value === 'string') {
    if (/^(?:https?:)?\/\//i.test(value)) {
      addBounded(issues, { file, line: 1, column: 1, code: 'JSON_EXTERNAL_URL', message: 'JSON 中出现外部 URL：' + pathPrefix, source: 'json' });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJsonUrls(item, file, issues, pathPrefix + '[' + index + ']'));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanJsonUrls(item, file, issues, pathPrefix ? pathPrefix + '.' + key : key);
  }
}

function validateJson(source, options) {
  const opts = options || {};
  const file = normalizePath(opts.file || 'fixture.json');
  const contracts = opts.contracts || {};
  const baselineSource = typeof opts.baselineSource === 'string' ? opts.baselineSource : null;
  const changed = baselineSource === null || String(source).replace(/\r\n/g, '\n') !== baselineSource.replace(/\r\n/g, '\n');
  const issues = [];
  let value;
  try {
    value = parseJson(source).value;
  } catch (error) {
    if (error instanceof SourceParseError) {
      issues.push({ file, line: error.line, column: error.column, code: error.code, message: error.message, source: 'json' });
      return { issues, json: null };
    }
    throw error;
  }
  const base = path.posix.basename(file);
  const isApp = base === 'app.json';
  const isPage = /(?:^|\/)pages\/[a-z0-9-]+\/index\.json$/.test(file);
  const isComponent = /(?:^|\/)components\/[a-z0-9-]+\/index\.json$/.test(file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ file, line: 1, column: 1, code: 'JSON_OBJECT_REQUIRED', message: '配置文件必须是对象', source: 'json' });
    return { issues, json: value };
  }
  scanJsonUrls(value, file, issues, '');
  if (isApp) {
    for (const key of Object.keys(value)) {
      if (!APP_ALLOWED_KEYS.has(key)) {
        issues.push({ file, line: 1, column: 1, code: 'JSON_UNKNOWN_KEY', message: 'app.json 未知键：' + key, source: 'json' });
      }
      const contractKey = APP_CONTRACT_KEYS[key];
      if (changed && contractKey && contracts[contractKey] !== true) {
        issues.push({ file, line: 1, column: 1, code: 'APP_CONFIG_FORBIDDEN', message: 'app.json 修改 ' + key + ' 需要业务契约（' + contractKey + '）', source: 'json' });
      }
    }
    if (Array.isArray(value.pages)) {
      for (const item of value.pages) {
        if (typeof item !== 'string' || !/^pages\/[a-z0-9-]+\/index$/.test(item)) {
          issues.push({ file, line: 1, column: 1, code: 'APP_ROUTE_INVALID', message: 'app.json 页面路由非法：' + String(item), source: 'json' });
        }
      }
    }
    if (value.tabBar && Array.isArray(value.tabBar.list)) {
      for (const item of value.tabBar.list) {
        if (!item || typeof item.pagePath !== 'string') continue;
        if (!/^pages\/[a-z0-9-]+\/index$/.test(item.pagePath)) {
          issues.push({ file, line: 1, column: 1, code: 'APP_TABBAR_ROUTE_INVALID', message: 'tabBar pagePath 非法：' + item.pagePath, source: 'json' });
        }
        for (const iconKey of ['iconPath', 'selectedIconPath']) {
          if (typeof item[iconKey] === 'string' && /^(?:https?:)?\/\//i.test(item[iconKey])) {
            issues.push({ file, line: 1, column: 1, code: 'APP_TABBAR_EXTERNAL_ICON', message: 'tabBar 图标不能是外链：' + item[iconKey], source: 'json' });
          }
        }
      }
    }
  } else if (isPage) {
    for (const key of Object.keys(value)) {
      if (PAGE_FORBIDDEN_KEYS.has(key)) {
        if (changed) issues.push({ file, line: 1, column: 1, code: 'PAGE_CONFIG_FORBIDDEN', message: '页面 JSON 不允许修改 ' + key, source: 'json' });
      } else if (!PAGE_ALLOWED_KEYS.has(key)) {
        issues.push({ file, line: 1, column: 1, code: 'JSON_UNKNOWN_KEY', message: '页面 JSON 未知键：' + key, source: 'json' });
      }
    }
    if (value.usingComponents !== undefined) validateUsingComponentsMap(value.usingComponents, file, issues);
  } else if (isComponent) {
    for (const key of Object.keys(value)) {
      if (COMPONENT_FORBIDDEN_KEYS.has(key)) {
        if (changed) issues.push({ file, line: 1, column: 1, code: 'COMPONENT_CONFIG_FORBIDDEN', message: '组件 JSON 不允许修改 ' + key, source: 'json' });
      } else if (!COMPONENT_ALLOWED_KEYS.has(key)) {
        issues.push({ file, line: 1, column: 1, code: 'JSON_UNKNOWN_KEY', message: '组件 JSON 未知键：' + key, source: 'json' });
      }
    }
    if (value.usingComponents !== undefined) validateUsingComponentsMap(value.usingComponents, file, issues);
  }
  return { issues, json: value };
}

function validateUsingComponentsMap(using, file, issues) {
  if (!using || typeof using !== 'object' || Array.isArray(using)) {
    issues.push({ file, line: 1, column: 1, code: 'USING_COMPONENTS_INVALID', message: 'usingComponents 必须是对象', source: 'json' });
    return;
  }
  for (const [tag, target] of Object.entries(using)) {
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      issues.push({ file, line: 1, column: 1, code: 'COMPONENT_TAG_INVALID', message: '组件标签名非法：' + tag, source: 'json' });
      continue;
    }
    if (typeof target !== 'string' || !/^\/components\/[a-z0-9-]+\/index$/.test(target)) {
      issues.push({ file, line: 1, column: 1, code: 'COMPONENT_PATH_INVALID', message: '组件路径必须指向 /components/<id>/index：' + tag, source: 'json' });
    }
  }
}

function analyzePageJsForCheck(jsFiles, pageId) {
  const jsFile = 'pages/' + pageId + '/index.js';
  const source = jsFiles.get(jsFile);
  if (!source) return null;
  try {
    const ts = cachedTypeScript || loadTypeScript();
    cachedTypeScript = ts;
    const generator = require('../agent-source-facts.cjs');
    return generator.analyzePageScript(ts, jsFile, source);
  } catch (error) {
    return null;
  }
}

function checkProject(input) {
  const opts = input || {};
  const facts = opts.facts || loadFacts();
  const contracts = opts.contracts || {};
  const rawFiles = opts.files || [];
  const issues = [];
  const files = rawFiles.map((item) => ({ path: normalizePath(item.path), content: String(item.content) }));
  const contentMap = new Map(files.map((item) => [item.path, item.content]));
  const baselineMap = opts.baseline
    ? new Map(Object.entries(opts.baseline).map(([key, value]) => [normalizePath(key), String(value)]))
    : null;
  const fileExists = fileExistsFromMap(files);
  const jsFiles = new Map(files.filter((item) => item.path.endsWith('.js')).map((item) => [item.path, item.content]));

  for (const item of files) {
    const file = item.path;
    const content = item.content;
    try {
      if (file.endsWith('.wxml')) {
        const ast = parseWxml(content, { file });
        const pageId = pageIdFromPath(file);
        const componentId = componentIdFromPath(file);
        if (pageId) {
          const pageJsonSource = contentMap.get('pages/' + pageId + '/index.json');
          let using = {};
          if (pageJsonSource) {
            try {
              using = parseJson(pageJsonSource).value.usingComponents || {};
            } catch (error) {
              using = {};
            }
          } else {
            addBounded(issues, { file, line: 1, column: 1, code: 'PAGE_JSON_MISSING', message: '页面缺少 index.json：' + pageId, source: 'json' });
          }
          for (const issue of validateUsingComponents(pageId, using, facts, { file, fileExists })) addBounded(issues, issue);
          for (const issue of validateComponentTags(ast, { pageId, file, usingComponents: using, facts })) addBounded(issues, issue);
          const pageJs = analyzePageJsForCheck(jsFiles, pageId);
          for (const issue of validatePageBindings(ast, { pageId, file, facts, pageJsAnalysis: pageJs }).issues) addBounded(issues, issue);
          for (const issue of validatePageEvents(ast, { pageId, file, facts, pageJsAnalysis: pageJs }).issues) addBounded(issues, issue);
        } else if (componentId) {
          const componentJsonSource = contentMap.get('components/' + componentId + '/index.json');
          let using = {};
          if (componentJsonSource) {
            try {
              using = parseJson(componentJsonSource).value.usingComponents || {};
            } catch (error) {
              using = {};
            }
          }
          for (const issue of validateUsingComponents(componentId, using, facts, { file, fileExists })) addBounded(issues, issue);
          for (const issue of validateComponentTags(ast, { pageId: null, file, usingComponents: using, facts })) addBounded(issues, issue);
          for (const issue of validateExpressionSyntaxOnly(ast, { file })) addBounded(issues, issue);
        } else {
          for (const issue of validateExpressionSyntaxOnly(ast, { file })) addBounded(issues, issue);
        }
      } else if (file.endsWith('.wxss')) {
        for (const issue of validateWxss(content, { file }).issues) addBounded(issues, issue);
      } else if (file.endsWith('.js')) {
        for (const issue of validateJs(content, { file, facts }).issues) addBounded(issues, issue);
      } else if (file.endsWith('.json')) {
        for (const issue of validateJson(content, { file, contracts, baselineSource: baselineMap ? baselineMap.get(file) : null }).issues) addBounded(issues, issue);
      }
    } catch (error) {
      if (error instanceof SourceParseError) {
        addBounded(issues, { file, line: error.line, column: error.column, code: error.code, message: error.message, source: 'parse' });
      } else {
        addBounded(issues, { file, line: 1, column: 1, code: 'SOURCE_CHECK_INTERNAL', message: String(error && error.message || error), source: 'source-check' });
      }
    }
  }

  issues.sort((a, b) => (a.file + ':' + a.line + ':' + a.column + ':' + a.code).localeCompare(b.file + ':' + b.line + ':' + b.column + ':' + b.code));
  const unique = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = issue.file + '|' + issue.line + '|' + issue.column + '|' + issue.code + '|' + issue.message;
    if (seen.has(key)) continue;
    seen.add(key);
    if (unique.length >= MAX_ISSUES) break;
    unique.push(issue);
  }
  const failClosed = unique.some((issue) => /_PARSE_ERROR$/.test(issue.code));
  const truncated = issues.length >= MAX_ISSUES;
  const byPage = {};
  for (const pageId of PAGE_IDS) {
    byPage[pageId] = unique.filter((issue) => issue.file === 'pages/' + pageId + '/index.wxml'
      || issue.file === 'pages/' + pageId + '/index.wxss'
      || issue.file === 'pages/' + pageId + '/index.js'
      || issue.file === 'pages/' + pageId + '/index.json').length;
  }
  return {
    ok: unique.length === 0,
    failClosed,
    issues: unique,
    total: unique.length,
    truncated,
    pageMatrix: byPage,
    factsDigest: facts && facts.digest ? facts.digest : null,
  };
}

function walkFiles(dir, baseDir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) out.push(path.relative(baseDir, absolute).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function loadBaseFiles() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const baseSrc = path.join(repoRoot, 'templates', 'base', 'ordering-base', '1.0.0', 'src');
  const files = [];
  for (const relative of walkFiles(baseSrc, baseSrc)) {
    if (!/\.(?:js|json|wxml|wxss)$/.test(relative)) continue;
    files.push({
      path: relative,
      content: fs.readFileSync(path.join(baseSrc, relative), 'utf8'),
    });
  }
  return files;
}

function checkBase(options) {
  const opts = options || {};
  const facts = opts.facts || loadFacts();
  const files = loadBaseFiles();
  const baseline = Object.fromEntries(files.map((item) => [item.path, item.content]));
  const result = checkProject({ files, facts, contracts: {}, baseline });
  const global = result.issues.filter((issue) => !/^pages\//.test(issue.file));
  return Object.assign({}, result, {
    files: files.length,
    globalIssues: global.length,
    pageMatrix: result.pageMatrix,
  });
}

function printResult(result) {
  console.log('source-check: ' + (result.ok ? 'PASS' : 'FAIL') + '（' + result.total + ' issues' + (result.truncated ? '，已截断' : '') + (result.failClosed ? '，fail-closed' : '') + '）');
  console.log('page matrix: ' + Object.entries(result.pageMatrix || {}).map(([page, count]) => page + '=' + count).join(' '));
  for (const issue of result.issues.slice(0, 80)) {
    console.log('  ' + issue.file + ':' + issue.line + ':' + issue.column + ' [' + issue.code + '] ' + issue.message + ' (' + issue.source + ')');
  }
}

function main(argv) {
  const args = new Set(argv);
  if (!args.has('--base')) {
    console.error('用法：node scripts/frontend-source/check.cjs --base [--json]');
    process.exitCode = 2;
    return;
  }
  try {
    const result = checkBase();
    if (args.has('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else printResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error('source-check crash: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 2;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  MAX_ISSUES,
  PAGE_IDS,
  loadFacts,
  resetFactsCacheForTests,
  pageIdFromPath,
  componentIdFromPath,
  validateJson,
  validateUsingComponentsMap,
  checkProject,
  loadBaseFiles,
  checkBase,
  printResult,
};
