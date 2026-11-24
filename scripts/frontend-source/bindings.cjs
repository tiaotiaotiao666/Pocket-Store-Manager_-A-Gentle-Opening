'use strict';

/**
 * 数据绑定与表达式检查（WXML）。
 *
 * - 使用 parse.cjs 的真实 AST；所有 `{{}}` 都解析；
 * - 支持嵌套 wx:for 的 item/index（含自定义 wx:for-item/wx:for-index）局部作用域；
 * - 数据根/已知字段来自 C1 SourceFacts（data.initial 紧凑描述符）+ 当前页面 JS 的 data/setData；
 * - 已知形状才校验字段；C1 无法知道形状（store/expression 引用等）时允许更深访问，避免误杀。
 */

const { parseExpression, extractBindingsFromExpression, SourceParseError, lineColumn } = require('./parse.cjs');

const GLOBAL_IDENTIFIERS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

function parseDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return { type: 'unknown' };
  if (descriptor.startsWith('object{')) {
    const body = descriptor.slice('object{'.length, -1);
    return { type: 'object', fields: new Set(body ? body.split(',') : []) };
  }
  if (descriptor.startsWith('array<object{')) {
    const body = descriptor.slice('array<object{'.length, -2);
    return { type: 'array', item: { type: 'object', fields: new Set(body ? body.split(',') : []) } };
  }
  if (descriptor.startsWith('array<')) return { type: 'array', item: { type: 'unknown' } };
  if (descriptor.startsWith('string:')) return { type: 'string' };
  if (descriptor.startsWith('number:')) return { type: 'number' };
  if (descriptor.startsWith('boolean:')) return { type: 'boolean' };
  if (descriptor === 'null') return { type: 'null' };
  if (descriptor.startsWith('reference:') || descriptor.startsWith('expression:')) return { type: 'unknown' };
  return { type: 'unknown' };
}

function buildPageDataModel(facts, pageId, pageJsAnalysis) {
  const descriptors = new Map();
  const roots = new Set();
  const page = facts && facts.pages ? facts.pages[pageId] : null;
  if (page && page.data && page.data.initial) {
    for (const [key, descriptor] of Object.entries(page.data.initial)) {
      roots.add(key);
      descriptors.set(key, parseDescriptor(descriptor));
    }
    for (const key of page.data.setData || []) {
      const root = String(key).split(/[.[]/)[0];
      if (!root) continue;
      roots.add(root);
      if (!descriptors.has(root)) descriptors.set(root, { type: 'unknown' });
    }
  }
  if (pageJsAnalysis && pageJsAnalysis.dataInitial) {
    for (const key of Object.keys(pageJsAnalysis.dataInitial)) {
      roots.add(key);
      if (!descriptors.has(key)) descriptors.set(key, { type: 'unknown' });
    }
  }
  if (pageJsAnalysis && pageJsAnalysis.setData && Array.isArray(pageJsAnalysis.setData.paths)) {
    for (const path of pageJsAnalysis.setData.paths) {
      const root = String(path).split(/[.[]/)[0];
      if (!root) continue;
      roots.add(root);
      if (!descriptors.has(root)) descriptors.set(root, { type: 'unknown' });
    }
  }
  return { roots, descriptors };
}

function listAttributes(element) {
  const map = new Map();
  for (const attr of element.attributes || []) map.set(attr.name, attr);
  return map;
}

function valuePosition(attr, matchIndex) {
  const before = String(attr.value || '').slice(0, Math.max(0, matchIndex));
  const lines = before.split('\n');
  if (lines.length > 1) return { line: attr.line + lines.length - 1, column: lines[lines.length - 1].length + 1 };
  return { line: attr.line, column: attr.column + attr.name.length + 3 + matchIndex };
}

function scanMustaches(value) {
  const text = String(value);
  const results = [];
  const pattern = /\{\{([\s\S]*?)\}\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({ expression: match[1].trim(), index: match.index, length: match[0].length });
  }
  return results;
}

function collectionDescriptor(expression, scopes, descriptors) {
  if (!expression) return { type: 'unknown' };
  let node = expression;
  if (node.type === 'ParenthesizedExpression') node = node.expression;
  if (node.type === 'Identifier' && scopes.has(node.name)) return scopes.get(node.name);
  if (node.type === 'MemberExpression') {
    const parts = [];
    let current = node;
    while (current && current.type === 'MemberExpression' && !current.computed) {
      parts.unshift(current.property.name);
      current = current.object;
    }
    if (current && current.type === 'Identifier') {
      if (scopes.has(current.name)) {
        const scope = scopes.get(current.name);
        if (scope.type === 'object' && scope.fields && scope.fields.has(parts[0])) return { type: 'unknown' };
        return { type: 'unknown' };
      }
      const rootDescriptor = descriptors.get(current.name);
      if (!rootDescriptor) return { type: 'unknown' };
      if (parts.length === 1 && rootDescriptor.type === 'array') return rootDescriptor;
      return { type: 'unknown' };
    }
  }
  return { type: 'unknown' };
}

function describeScopes(scopes) {
  return [...scopes.entries()].map(([name, descriptor]) => name + ':' + descriptor.type).sort();
}

function validatePageBindings(ast, options) {
  const opts = options || {};
  const facts = opts.facts || null;
  const pageId = opts.pageId || null;
  const file = opts.file || 'fixture.wxml';
  const pageJsAnalysis = opts.pageJsAnalysis || null;
  const issues = [];
  if (!pageId) return { issues, bindings: [] };

  const dataModel = buildPageDataModel(facts, pageId, pageJsAnalysis);
  const bindings = [];

  function addIssue(code, message, position) {
    issues.push({
      file,
      line: position.line,
      column: position.column,
      code,
      message: String(message).slice(0, 180),
      source: 'bindings',
    });
  }

  function validateExpression(expressionText, position, scopes) {
    let expression;
    try {
      expression = parseExpression(expressionText);
    } catch (error) {
      if (error instanceof SourceParseError) addIssue(error.code, error.message, { line: position.line + error.line - 1, column: error.line === 1 ? position.column + error.column - 1 : error.column });
      else addIssue('EXPRESSION_PARSE_ERROR', String(error.message || error), position);
      return;
    }
    let hasCall = false;
    let hasUpdate = false;
    (function walk(node) {
      if (!node) return;
      if (node.type === 'CallExpression') hasCall = true;
      if (node.type === 'UpdateExpression') hasUpdate = true;
      for (const key of ['argument', 'left', 'right', 'test', 'consequent', 'alternate', 'expression', 'object', 'property']) {
        if (node[key] && typeof node[key] === 'object') walk(node[key]);
      }
      if (Array.isArray(node.elements)) node.elements.forEach(walk);
      if (Array.isArray(node.properties)) node.properties.forEach((prop) => walk(prop.value));
      if (Array.isArray(node.arguments)) node.arguments.forEach(walk);
    })(expression);
    if (hasCall) addIssue('EXPRESSION_FUNCTION_CALL', 'WXML 表达式不允许函数调用', position);
    if (hasUpdate) addIssue('EXPRESSION_ASSIGNMENT', 'WXML 表达式不允许赋值/自增', position);

    const extracted = extractBindingsFromExpression(expression);
    for (const root of extracted.roots) {
      if (GLOBAL_IDENTIFIERS.has(root)) continue;
      bindings.push({ root, position });
      if (scopes.has(root)) {
        const scope = scopes.get(root);
        for (const path of extracted.members) {
          if (!path.startsWith(root + '.')) continue;
          const first = path.slice(root.length + 1).split('.')[0];
          if (scope.type === 'object' && scope.fields && !scope.fields.has(first) && first !== 'length') {
            addIssue('DATA_FIELD_UNKNOWN', '循环局部变量 ' + root + ' 没有字段 ' + first, position);
          }
        }
        continue;
      }
      if (!dataModel.roots.has(root)) {
        addIssue('DATA_ROOT_UNKNOWN', '数据根不在 data/setData/SourceFacts：' + root, position);
        continue;
      }
      const descriptor = dataModel.descriptors.get(root) || { type: 'unknown' };
      for (const path of extracted.members) {
        if (!path.startsWith(root + '.')) continue;
        const first = path.slice(root.length + 1).split('.')[0];
        if (descriptor.type === 'object' && descriptor.fields && !descriptor.fields.has(first)) {
          addIssue('DATA_FIELD_UNKNOWN', '已知数据 root ' + root + ' 没有字段 ' + first, position);
        }
      }
    }
  }

  function visit(node, scopes) {
    if (!node || node.type !== 'element') {
      if (node && Array.isArray(node.children)) for (const child of node.children) visit(child, scopes);
      return;
    }
    const attrs = listAttributes(node);
    const loopAttr = attrs.get('wx:for');
    let loopExpression = null;
    if (loopAttr) {
      for (const mustache of scanMustaches(loopAttr.value)) {
        try {
          loopExpression = parseExpression(mustache.expression);
        } catch (error) {
          addIssue('EXPRESSION_PARSE_ERROR', error.message, valuePosition(loopAttr, mustache.index));
        }
      }
    }
    const nextScopes = new Map(scopes);
    if (loopAttr) {
      const itemName = attrs.has('wx:for-item') ? attrs.get('wx:for-item').value : 'item';
      const indexName = attrs.has('wx:for-index') ? attrs.get('wx:for-index').value : 'index';
      const itemDescriptor = loopExpression ? (collectionDescriptor(loopExpression, scopes, dataModel.descriptors).item || { type: 'unknown' }) : { type: 'unknown' };
      if (itemName) nextScopes.set(itemName, itemDescriptor);
      if (indexName) nextScopes.set(indexName, { type: 'number' });
    }

    for (const attr of node.attributes || []) {
      if (/^(?:bind|catch|capture-bind|capture-catch)/.test(attr.name)) continue;
      if (attr.name === 'wx:for' || attr.name === 'wx:for-item' || attr.name === 'wx:for-index') continue;
      for (const mustache of scanMustaches(attr.value)) {
        validateExpression(mustache.expression, valuePosition(attr, mustache.index), nextScopes);
      }
    }
    for (const child of node.children || []) {
      if (child.type === 'text') {
        for (const mustache of scanMustaches(child.value)) {
          const before = child.value.slice(0, mustache.index);
          const lines = before.split('\n');
          const position = lines.length > 1
            ? { line: child.line + lines.length - 1, column: lines[lines.length - 1].length + 1 }
            : { line: child.line, column: child.column + mustache.index };
          validateExpression(mustache.expression, position, nextScopes);
        }
      } else {
        visit(child, nextScopes);
      }
    }
  }

  visit(ast, new Map());
  return { issues, bindings, scopes: describeScopes(new Map()) };
}

function validateExpressionSyntaxOnly(ast, options) {
  const opts = options || {};
  const file = opts.file || 'fixture.wxml';
  const issues = [];
  function addIssue(code, message, position) {
    issues.push({ file, line: position.line, column: position.column, code, message: String(message).slice(0, 180), source: 'bindings' });
  }
  function check(value, position) {
    for (const mustache of scanMustaches(value)) {
      try {
        const expression = parseExpression(mustache.expression);
        let hasCall = false;
        let hasUpdate = false;
        (function walk(node) {
          if (!node) return;
          if (node.type === 'CallExpression') hasCall = true;
          if (node.type === 'UpdateExpression') hasUpdate = true;
          for (const key of ['argument', 'left', 'right', 'test', 'consequent', 'alternate', 'expression', 'object', 'property']) {
            if (node[key] && typeof node[key] === 'object') walk(node[key]);
          }
          if (Array.isArray(node.elements)) node.elements.forEach(walk);
          if (Array.isArray(node.properties)) node.properties.forEach((prop) => walk(prop.value));
          if (Array.isArray(node.arguments)) node.arguments.forEach(walk);
        })(expression);
        if (hasCall) addIssue('EXPRESSION_FUNCTION_CALL', 'WXML 表达式不允许函数调用', position);
        if (hasUpdate) addIssue('EXPRESSION_ASSIGNMENT', 'WXML 表达式不允许赋值/自增', position);
      } catch (error) {
        if (error instanceof SourceParseError) {
          addIssue(error.code, error.message, { line: position.line + error.line - 1, column: error.line === 1 ? position.column + error.column - 1 : error.column });
        }
      }
    }
  }
  function positionFor(element, attr, index) {
    return valuePosition(attr, index);
  }
  function visit(node) {
    if (!node) return;
    if (node.type === 'element') {
      for (const attr of node.attributes || []) {
        if (/^(?:bind|catch|capture-bind|capture-catch)/.test(attr.name)) continue;
        check(attr.value, positionFor(node, attr, 0));
      }
    }
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const position = { line: child.line, column: child.column };
        check(child.value, position);
      } else {
        visit(child);
      }
    }
  }
  visit(ast);
  return issues;
}

module.exports = {
  GLOBAL_IDENTIFIERS,
  parseDescriptor,
  buildPageDataModel,
  scanMustaches,
  validatePageBindings,
  validateExpressionSyntaxOnly,
};
