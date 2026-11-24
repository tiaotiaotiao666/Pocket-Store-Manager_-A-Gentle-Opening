'use strict';

/**
 * JS 分策略检查（真实 TypeScript AST）。
 *
 * 角色：
 * - component：UI 组件，禁止网络/存储/路由/globalData/动态执行/require 服务或页面；
 * - page：页面，**不永久禁止页面 JS**；允许 wx.request/navigateTo 等页面能力，
 *   但必须满足 page-contract 的 handler/data，且禁止动态执行；
 * - service（services/domain/state/config）：禁止 Page/Component 定义与动态执行；
 * - other：仅语法检查。
 */

const { parseJs, loadTypeScript, lineColumn } = require('./parse.cjs');

const COMPONENT_FORBIDDEN_WX = new Set([
  'request', 'uploadFile', 'downloadFile', 'connectSocket',
  'setStorage', 'setStorageSync', 'getStorage', 'getStorageSync', 'removeStorage', 'removeStorageSync', 'clearStorage', 'clearStorageSync',
  'navigateTo', 'redirectTo', 'switchTab', 'reLaunch',
  'login', 'checkSession', 'requestPayment',
]);

const COMPONENT_FORBIDDEN_REQUIRE = /(?:^|\/)(?:services|pages|state|server)\//;

function roleForPath(file) {
  const normalized = String(file).replace(/\\/g, '/');
  let match = /(?:^|\/)components\/([a-z0-9-]+)\/index\.js$/.exec(normalized);
  if (match) return { role: 'component', id: match[1] };
  match = /(?:^|\/)pages\/([a-z0-9-]+)\/index\.js$/.exec(normalized);
  if (match) return { role: 'page', id: match[1] };
  if (/(?:^|\/)(?:services|domain|state|config)\//.test(normalized)) return { role: 'service', id: null };
  return { role: 'other', id: null };
}

function isFunctionLike(ts, node) {
  return Boolean(node) && (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));
}

function validateJs(source, options) {
  const opts = options || {};
  const file = opts.file || 'fixture.js';
  const facts = opts.facts || null;
  const ts = opts.typescript || loadTypeScript();
  const parsed = parseJs(source, { file, typescript: ts });
  const issues = [];

  function addIssue(code, message, node) {
    const position = node && typeof node.getStart === 'function'
      ? lineColumn(String(source), node.getStart(parsed.sourceFile))
      : { line: 1, column: 1 };
    issues.push({ file, line: position.line, column: position.column, code, message: String(message).slice(0, 180), source: 'js-policy' });
  }

  if (parsed.diagnostics.length > 0) {
    for (const diagnostic of parsed.diagnostics) {
      issues.push({ file, line: diagnostic.line, column: diagnostic.column, code: diagnostic.code, message: diagnostic.message, source: 'js-policy' });
    }
    return { issues, role: roleForPath(file).role };
  }

  const roleInfo = roleForPath(file);
  const role = roleInfo.role;
  const componentId = roleInfo.id;
  const sourceFile = parsed.sourceFile;
  let pageObject = null;
  let componentObject = null;
  const triggerEvents = [];
  const requiredProps = new Map();
  const declaredProps = new Set();

  function walk(node, cb) {
    cb(node);
    node.forEachChild((child) => walk(child, cb));
  }

  function propertyName(node) {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
    return null;
  }
  function fullChain(node) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      const left = fullChain(node.expression);
      return left ? left + '.' + node.name.text : null;
    }
    return null;
  }

  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'Page') pageObject = node.arguments[0] || null;
        if (node.expression.text === 'Component') componentObject = node.arguments[0] || null;
        if (node.expression.text === 'eval') addIssue('JS_EVAL_FORBIDDEN', '禁止 eval', node);
        if (node.expression.text === 'Function') addIssue('JS_DYNAMIC_FUNCTION', '禁止动态 Function', node);
        if (node.expression.text === 'getApp' && role === 'component') addIssue('JS_COMPONENT_GLOBAL_DATA', 'UI 组件不得读取 getApp()', node);
        if (node.expression.text === 'require') {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            if (role === 'component' && COMPONENT_FORBIDDEN_REQUIRE.test(arg.text)) {
              addIssue('JS_COMPONENT_REQUIRE_FORBIDDEN', 'UI 组件不得 require 服务/页面/state：' + arg.text, node);
            }
            if (/^(?:[A-Za-z]:|\/)/.test(arg.text)) addIssue('JS_ABSOLUTE_REQUIRE', '禁止绝对路径 require：' + arg.text, node);
          } else {
            addIssue('JS_DYNAMIC_REQUIRE', 'require 必须是字符串字面量', node);
          }
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'wx') {
        const api = node.expression.name.text;
        if (role === 'component' && COMPONENT_FORBIDDEN_WX.has(api)) {
          addIssue('JS_COMPONENT_WX_FORBIDDEN', 'UI 组件不得调用 wx.' + api, node);
        }
        if (ts.isIdentifier(node.expression.expression) && api === 'triggerEvent') {
          // handled below for literal event names
        }
      }
      if (role === 'component' && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'triggerEvent') {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) triggerEvents.push(arg.text);
        else addIssue('JS_COMPONENT_EVENT_DYNAMIC', 'triggerEvent 事件名必须是字符串字面量', node);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      addIssue('JS_DYNAMIC_FUNCTION', '禁止 new Function', node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const chain = fullChain(node);
      if (chain === 'window' || chain === 'document' || chain && chain.startsWith('window.') || chain && chain.startsWith('document.')) {
        addIssue('JS_DOM_GLOBAL', '小程序源码不得访问 window/document', node);
      }
    }
  });

  if (role === 'component' && ts.isObjectLiteralExpression(componentObject)) {
    for (const prop of componentObject.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propertyName(prop.name);
      if (name !== 'properties' || !ts.isObjectLiteralExpression(prop.initializer)) continue;
      for (const property of prop.initializer.properties) {
        const propKey = propertyName(property.name);
        if (propKey) declaredProps.add(propKey);
      }
    }
  }
  if (role === 'component' && facts && facts.components && componentId) {
    const component = facts.components[componentId];
    if (component) {
      for (const prop of component.props || []) requiredProps.set(prop[0], prop);
      for (const property of requiredProps.keys()) {
        if (!declaredProps.has(property)) addIssue('COMPONENT_PROP_CONTRACT_MISSING', '组件 JS 缺少 SourceFacts 声明的属性：' + property, null);
      }
      const declaredEvents = new Set((component.events || []).map((event) => event[0]));
      const triggered = new Set(triggerEvents);
      for (const event of declaredEvents) {
        if (!triggered.has(event)) addIssue('COMPONENT_EVENT_CONTRACT_MISSING', '组件 JS 未触发 SourceFacts 声明的事件：' + event, null);
      }
    }
  }

  if (role === 'service') {
    if (pageObject) addIssue('JS_SERVICE_PAGE_DEFINITION', 'service/domain/state 不得定义 Page', null);
    if (componentObject) addIssue('JS_SERVICE_COMPONENT_DEFINITION', 'service/domain/state 不得定义 Component', null);
  }

  if (role === 'page' && facts && facts.pages && componentId) {
    const page = facts.pages[componentId];
    if (page && page.pageContract) {
      const methodNames = new Set();
      const dataKeys = new Set();
      if (ts.isObjectLiteralExpression(pageObject)) {
        for (const prop of pageObject.properties) {
          const name = propertyName(prop.name);
          if (!name) continue;
          if (name === 'data' && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
            for (const field of prop.initializer.properties) {
              const key = propertyName(field.name);
              if (key) dataKeys.add(key);
            }
          } else if (isFunctionLike(ts, prop)) {
            methodNames.add(name);
          }
        }
      }
      for (const handler of page.pageContract.requiredHandlers || []) {
        if (!methodNames.has(handler)) issues.push({ file, line: 1, column: 1, code: 'CONTRACT_HANDLER_MISSING', message: 'page-contract handler 不存在：' + handler, source: 'js-policy' });
      }
      for (const root of page.pageContract.requiredData || []) {
        if (!dataKeys.has(root)) issues.push({ file, line: 1, column: 1, code: 'CONTRACT_DATA_MISSING', message: 'page-contract data 不在页面 data：' + root, source: 'js-policy' });
      }
    }
  }

  return { issues, role, componentId };
}

module.exports = {
  COMPONENT_FORBIDDEN_WX,
  COMPONENT_FORBIDDEN_REQUIRE,
  roleForPath,
  validateJs,
};
