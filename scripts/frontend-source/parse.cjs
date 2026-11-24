'use strict';

/**
 * frontend-source 共享解析层（C2）。
 *
 * 设计约束：
 * - 不引入新 npm 依赖：JS 复用仓库已有 TypeScript 编译器（server/node_modules 或根 node_modules）；
 * - WXML/WXSS 使用本文件内手写的 tokenizer/parser（真实 AST/位置信息，不是正则扫描）；
 * - 所有解析错误带 line/column，抛 SourceParseError；调用方转换为有界 issue；
 * - 不读取网络、不执行源码、不打印源码全文。
 */

const fs = require('node:fs');
const path = require('node:path');

class SourceParseError extends Error {
  constructor(code, message, location) {
    super(message);
    this.name = 'SourceParseError';
    this.code = code;
    this.line = location && location.line ? location.line : 1;
    this.column = location && location.column ? location.column : 1;
  }
}

function loadTypeScript() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(repoRoot, 'server', 'node_modules', 'typescript'),
    path.join(repoRoot, 'node_modules', 'typescript'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
  }
  throw new Error('frontend-source 需要仓库已有 TypeScript 编译器（server devDependency），不新增依赖');
}

function lineColumn(text, index) {
  const before = text.slice(0, Math.max(0, Math.min(index, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function offsetToPosition(text, offset) {
  return lineColumn(text, offset);
}

// ---------------------------------------------------------------------------
// WXML parser
// ---------------------------------------------------------------------------

function parseWxml(source, options) {
  const opts = options || {};
  const text = String(source);
  const root = { type: 'root', name: '#root', children: [], line: 1, column: 1 };
  const stack = [root];
  let index = 0;

  function fail(code, message, at) {
    throw new SourceParseError(code, message, lineColumn(text, at));
  }

  function current() {
    return stack[stack.length - 1];
  }

  function parseAttributes(startIndex) {
    const attrs = [];
    let offset = startIndex;
    while (offset < text.length) {
      while (offset < text.length && /\s/.test(text[offset])) offset += 1;
      if (text[offset] === '>' || (text[offset] === '/' && text[offset + 1] === '>')) break;
      const nameStart = offset;
      while (offset < text.length && !/[\s=/>]/.test(text[offset])) offset += 1;
      if (offset === nameStart) fail('WXML_PARSE_ERROR', '属性名为空', offset);
      const name = text.slice(nameStart, offset);
      while (offset < text.length && /\s/.test(text[offset])) offset += 1;
      let value = '';
      let quote = '';
      let valueStart = offset;
      if (text[offset] === '=') {
        offset += 1;
        while (offset < text.length && /\s/.test(text[offset])) offset += 1;
        if (text[offset] === '"' || text[offset] === "'") {
          quote = text[offset];
          offset += 1;
          valueStart = offset;
          while (offset < text.length && text[offset] !== quote) offset += 1;
          if (offset >= text.length) fail('WXML_PARSE_ERROR', '属性值引号未闭合：' + name, valueStart);
          value = text.slice(valueStart, offset);
          offset += 1;
        } else {
          valueStart = offset;
          while (offset < text.length && !/[\s>]/.test(text[offset])) offset += 1;
          value = text.slice(valueStart, offset);
        }
      }
      const location = lineColumn(text, nameStart);
      attrs.push({
        type: 'attribute',
        name,
        value,
        quote,
        line: location.line,
        column: location.column,
        valueStart: valueStart,
        valueEnd: valueStart + value.length,
      });
    }
    return { attrs, offset };
  }

  while (index < text.length) {
    let nextTag = -1;
    let scan = index;
    let mustacheDepth = 0;
    while (scan < text.length) {
      if (text.startsWith('{{', scan)) {
        mustacheDepth += 1;
        scan += 2;
        continue;
      }
      if (mustacheDepth > 0 && text.startsWith('}}', scan)) {
        mustacheDepth -= 1;
        scan += 2;
        continue;
      }
      if (mustacheDepth === 0 && text[scan] === '<') {
        nextTag = scan;
        break;
      }
      scan += 1;
    }
    if (nextTag === -1) {
      const value = text.slice(index);
      if (value.length > 0) current().children.push({ type: 'text', value, line: lineColumn(text, index).line, column: lineColumn(text, index).column });
      break;
    }
    if (nextTag > index) {
      const value = text.slice(index, nextTag);
      current().children.push({ type: 'text', value, line: lineColumn(text, index).line, column: lineColumn(text, index).column });
    }
    if (text.startsWith('<!--', nextTag)) {
      const end = text.indexOf('-->', nextTag + 4);
      if (end === -1) fail('WXML_PARSE_ERROR', '注释未闭合', nextTag);
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', nextTag)) {
      const end = text.indexOf(']]>', nextTag + 9);
      if (end === -1) fail('WXML_PARSE_ERROR', 'CDATA 未闭合', nextTag);
      index = end + 3;
      continue;
    }
    if (text[nextTag + 1] === '!' || text[nextTag + 1] === '?') {
      const end = text.indexOf('>', nextTag);
      if (end === -1) fail('WXML_PARSE_ERROR', '声明未闭合', nextTag);
      index = end + 1;
      continue;
    }
    if (text[nextTag + 1] === '/') {
      const match = /^<\/\s*([A-Za-z][\w-]*)\s*>/.exec(text.slice(nextTag));
      if (!match) fail('WXML_PARSE_ERROR', '闭合标签格式非法', nextTag);
      const name = match[1];
      const node = current();
      if (node.type !== 'element' || node.name !== name) {
        fail('WXML_PARSE_ERROR', '闭合标签不匹配：</' + name + '> 当前 <' + (node.name || '#root') + '>', nextTag);
      }
      node.endLine = lineColumn(text, nextTag).line;
      node.endColumn = lineColumn(text, nextTag).column;
      stack.pop();
      index = nextTag + match[0].length;
      continue;
    }
    const openMatch = /^<([A-Za-z][\w-]*)/.exec(text.slice(nextTag));
    if (!openMatch) fail('WXML_PARSE_ERROR', '标签名非法', nextTag);
    const name = openMatch[1];
    const location = lineColumn(text, nextTag);
    const attrStart = nextTag + openMatch[0].length;
    const parsed = parseAttributes(attrStart);
    let offset = parsed.offset;
    let selfClosing = false;
    if (text[offset] === '/' && text[offset + 1] === '>') {
      selfClosing = true;
      offset += 2;
    } else if (text[offset] === '>') {
      offset += 1;
    } else {
      fail('WXML_PARSE_ERROR', '标签未闭合：<' + name + '>', offset);
    }
    const node = {
      type: 'element',
      name,
      attributes: parsed.attrs,
      children: [],
      line: location.line,
      column: location.column,
      selfClosing,
    };
    current().children.push(node);
    index = offset;

    if (name === 'wxs' && !selfClosing) {
      const close = text.indexOf('</wxs>', index);
      if (close === -1) fail('WXML_PARSE_ERROR', 'wxs 区块未闭合', nextTag);
      node.children.push({ type: 'text', value: text.slice(index, close), line: lineColumn(text, index).line, column: lineColumn(text, index).column });
      index = close + '</wxs>'.length;
      continue;
    }
    if (!selfClosing) stack.push(node);
  }

  if (stack.length !== 1) {
    const node = current();
    throw new SourceParseError('WXML_PARSE_ERROR', '存在未闭合标签：<' + node.name + '>', {
      line: node.line,
      column: node.column,
    });
  }
  return root;
}

// ---------------------------------------------------------------------------
// WXSS parser（块/声明/at-rule/url，位置信息）
// ---------------------------------------------------------------------------

function parseWxss(source) {
  const text = String(source);
  let index = 0;

  function fail(code, message, at) {
    throw new SourceParseError(code, message, lineColumn(text, at));
  }

  function skipWhitespaceAndComments() {
    while (index < text.length) {
      if (/\s/.test(text[index])) {
        index += 1;
      } else if (text.startsWith('/*', index)) {
        const end = text.indexOf('*/', index + 2);
        if (end === -1) fail('WXSS_PARSE_ERROR', '注释未闭合', index);
        index = end + 2;
      } else {
        break;
      }
    }
  }

  function readUntil(stops) {
    const start = index;
    let quote = '';
    let parens = 0;
    while (index < text.length) {
      const ch = text[index];
      if (quote) {
        if (ch === '\\') index += 2;
        else if (ch === quote) {
          quote = '';
          index += 1;
        } else index += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === '(') parens += 1;
      if (ch === ')') parens = Math.max(0, parens - 1);
      if (parens === 0 && stops.includes(ch)) break;
      index += 1;
    }
    if (quote) fail('WXSS_PARSE_ERROR', '字符串未闭合', start);
    if (parens !== 0) fail('WXSS_PARSE_ERROR', '括号未闭合', start);
    return text.slice(start, index);
  }

  function parseBlock(kind, isRoot) {
    const node = { type: kind, children: [], declarations: [], atRules: [], line: lineColumn(text, index).line, column: lineColumn(text, index).column };
    while (index < text.length) {
      skipWhitespaceAndComments();
      if (index >= text.length) {
        if (isRoot) return node;
        fail('WXSS_PARSE_ERROR', '块未闭合', index);
      }
      if (text[index] === '}') {
        if (isRoot) fail('WXSS_PARSE_ERROR', '根样式表存在多余 }', index);
        index += 1;
        return node;
      }
      if (text[index] === '@') {
        const atStart = index;
        index += 1;
        while (index < text.length && /[\w-]/.test(text[index])) index += 1;
        const atName = text.slice(atStart, index);
        const raw = readUntil(['{', ';']);
        if (text[index] === ';') {
          index += 1;
          node.atRules.push({ name: atName, prelude: raw.trim(), block: null, line: lineColumn(text, atStart).line, column: lineColumn(text, atStart).column });
        } else if (text[index] === '{') {
          index += 1;
          const block = parseBlock('atrule', false);
          node.atRules.push({ name: atName, prelude: raw.trim(), block, line: lineColumn(text, atStart).line, column: lineColumn(text, atStart).column });
        } else {
          fail('WXSS_PARSE_ERROR', 'at-rule 未闭合：' + atName, atStart);
        }
        continue;
      }
      const selectorStart = index;
      const selector = readUntil(['{', '}', ';']);
      if (text[index] === ';' || text[index] === '}') {
        // 顶层/块内孤立声明或空规则：记录为声明
        if (selector.trim()) {
          const declaration = parseDeclaration(selector, selectorStart);
          if (declaration) node.declarations.push(declaration);
        }
        if (text[index] === ';') index += 1;
        if (text[index] === '}') {
          index += 1;
          return node;
        }
        continue;
      }
      if (text[index] !== '{') fail('WXSS_PARSE_ERROR', '规则缺少 {', selectorStart);
      index += 1;
      const rule = parseBlock('rule', false);
      rule.selector = selector.trim();
      rule.line = lineColumn(text, selectorStart).line;
      rule.column = lineColumn(text, selectorStart).column;
      node.children.push(rule);
    }
    if (isRoot) return node;
    fail('WXSS_PARSE_ERROR', '样式表未闭合', index);
  }

  function parseDeclaration(raw, start) {
    const colon = raw.indexOf(':');
    if (colon <= 0) return null;
    const property = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!property || !value) return null;
    return {
      type: 'declaration',
      property,
      value,
      line: lineColumn(text, start).line,
      column: lineColumn(text, start).column,
      valueStart: start + colon + 1,
    };
  }

  skipWhitespaceAndComments();
  const root = parseBlock('stylesheet', true);
  skipWhitespaceAndComments();
  if (index < text.length) fail('WXSS_PARSE_ERROR', '样式表末尾存在多余内容', index);
  return root;
}

function collectWxssUrls(stylesheet) {
  const urls = [];
  const imports = [];
  const pattern = /url\s*\(\s*([^)]*?)\s*\)/gi;
  function walk(node) {
    if (!node) return;
    for (const declaration of node.declarations || []) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(declaration.value)) !== null) {
        let value = match[1].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        const offset = textOffsetOfDeclarationValue(node, declaration, match.index);
        urls.push({ value, line: declaration.line, column: declaration.column, offset });
      }
    }
    for (const rule of node.children || []) walk(rule);
    for (const at of node.atRules || []) if (at.block) walk(at.block);
  }
  function textOffsetOfDeclarationValue() {
    return 0;
  }
  walk(stylesheet);
  function collectImports(node) {
    for (const at of node.atRules || []) {
      if (at.name === '@import') imports.push(at);
      if (at.block) collectImports(at.block);
    }
    for (const rule of node.children || []) collectImports(rule);
  }
  collectImports(stylesheet);
  return { urls, imports };
}

// ---------------------------------------------------------------------------
// Expression parser（WXML 支持子集；函数调用/赋值/动态执行一律拒绝）
// ---------------------------------------------------------------------------

function tokenizeExpression(source) {
  const text = String(source);
  const tokens = [];
  let index = 0;
  function push(type, value, start) {
    tokens.push({ type, value, start, end: index });
  }
  while (index < text.length) {
    const ch = text[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = index;
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') {
          value += text[index + 1] || '';
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      if (index >= text.length) throw new SourceParseError('EXPRESSION_PARSE_ERROR', '字符串未闭合', lineColumn(text, start));
      index += 1;
      push('string', value, start);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = index;
      while (index < text.length && /[0-9.]/.test(text[index])) index += 1;
      push('number', Number(text.slice(start, index)), start);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = index;
      index += 1;
      while (index < text.length && /[\w$]/.test(text[index])) index += 1;
      push('identifier', text.slice(start, index), start);
      continue;
    }
    const operators3 = ['===', '!==', '>>>'];
    const operators2 = ['==', '!=', '<=', '>=', '&&', '||', '??', '?.', '=>', '++', '--', '**', '<<', '>>'];
    const three = text.slice(index, index + 3);
    if (operators3.includes(three)) {
      push('operator', three, index);
      index += 3;
      continue;
    }
    const two = text.slice(index, index + 2);
    if (operators2.includes(two)) {
      push('operator', two, index);
      index += 2;
      continue;
    }
    if ('+-*/%!<>'.includes(ch)) {
      push('operator', ch, index);
      index += 1;
      continue;
    }
    if ('?:.,()[]{}='.includes(ch)) {
      push('punctuation', ch, index);
      index += 1;
      continue;
    }
    throw new SourceParseError('EXPRESSION_PARSE_ERROR', '无法识别的表达式字符：' + ch, lineColumn(text, index));
  }
  tokens.push({ type: 'eof', value: '', start: index, end: index });
  return tokens;
}

function parseExpression(source) {
  const text = String(source);
  const tokens = tokenizeExpression(text);
  let position = 0;

  function current() {
    return tokens[position];
  }
  function next() {
    return tokens[position++];
  }
  function fail(message, token) {
    throw new SourceParseError('EXPRESSION_PARSE_ERROR', message, lineColumn(text, token ? token.start : 0));
  }
  function isPunct(value) {
    return current().type === 'punctuation' && current().value === value;
  }
  function isOperator(value) {
    return current().type === 'operator' && current().value === value;
  }
  function expectPunct(value) {
    if (!isPunct(value)) fail('缺少 ' + value, current());
    return next();
  }
  function node(type, start, extra) {
    return Object.assign({ type, start, end: 0, line: lineColumn(text, start).line, column: lineColumn(text, start).column }, extra || {});
  }
  function finish(value) {
    if (current().type !== 'eof') fail('表达式存在多余内容', current());
    return value;
  }

  function parsePrimary() {
    const token = next();
    if (token.type === 'number') return node('Literal', token.start, { value: token.value, valueType: 'number' });
    if (token.type === 'string') return node('Literal', token.start, { value: token.value, valueType: 'string' });
    if (token.type === 'identifier') {
      if (token.value === 'true' || token.value === 'false') return node('Literal', token.start, { value: token.value === 'true', valueType: 'boolean' });
      if (token.value === 'null') return node('Literal', token.start, { value: null, valueType: 'null' });
      if (token.value === 'undefined') return node('Literal', token.start, { value: undefined, valueType: 'undefined' });
      return node('Identifier', token.start, { name: token.value });
    }
    if (token.type === 'punctuation' && token.value === '(') {
      const expression = parseConditional();
      expectPunct(')');
      return node('ParenthesizedExpression', token.start, { expression });
    }
    if (token.type === 'punctuation' && token.value === '[') {
      const elements = [];
      while (!isPunct(']')) {
        elements.push(parseConditional());
        if (isPunct(',')) next();
        else break;
      }
      expectPunct(']');
      return node('ArrayExpression', token.start, { elements });
    }
    if (token.type === 'punctuation' && token.value === '{') {
      const properties = [];
      while (!isPunct('}')) {
        const keyToken = next();
        if (keyToken.type !== 'identifier' && keyToken.type !== 'string' && keyToken.type !== 'number') fail('对象键非法', keyToken);
        if (isPunct(':')) {
          next();
          properties.push({ key: String(keyToken.value), value: parseConditional() });
        } else {
          properties.push({ key: String(keyToken.value), value: node('Identifier', keyToken.start, { name: String(keyToken.value) }), shorthand: true });
        }
        if (isPunct(',')) next();
        else break;
      }
      expectPunct('}');
      return node('ObjectExpression', token.start, { properties });
    }
    if (token.type === 'operator' && token.value === '!') {
      const argument = parseUnary();
      return node('UnaryExpression', token.start, { operator: '!', argument });
    }
    if (token.type === 'operator' && (token.value === '++' || token.value === '--')) {
      const argument = parseUnary();
      return node('UpdateExpression', token.start, { operator: token.value, argument });
    }
    if (token.type === 'punctuation' && token.value === '-') {
      const argument = parseUnary();
      return node('UnaryExpression', token.start, { operator: '-', argument });
    }
    if (token.type === 'punctuation' && token.value === '+') {
      const argument = parseUnary();
      return node('UnaryExpression', token.start, { operator: '+', argument });
    }
    fail('表达式缺少操作数', token);
  }

  function parsePostfix() {
    let expression = parsePrimary();
    for (;;) {
      if (isPunct('.') || isOperator('?.')) {
        const token = next();
        const property = next();
        if (property.type !== 'identifier') fail('成员属性名非法', property);
        expression = node('MemberExpression', expression.start, { object: expression, property: node('Identifier', property.start, { name: property.value }), computed: false, optional: token.value === '?.' });
        continue;
      }
      if (isPunct('[')) {
        const start = expression.start;
        next();
        const property = parseConditional();
        expectPunct(']');
        expression = node('MemberExpression', start, { object: expression, property, computed: true });
        continue;
      }
      if (isPunct('(')) {
        const start = expression.start;
        next();
        const args = [];
        while (!isPunct(')')) {
          args.push(parseConditional());
          if (isPunct(',')) next();
          else break;
        }
        expectPunct(')');
        expression = node('CallExpression', start, { callee: expression, arguments: args });
        continue;
      }
      break;
    }
    return expression;
  }

  function parseUnary() {
    const token = current();
    if (token.type === 'operator' && (token.value === '!' || token.value === '-' || token.value === '+')) {
      next();
      return node('UnaryExpression', token.start, { operator: token.value, argument: parseUnary() });
    }
    return parsePostfix();
  }

  function parseBinary() {
    const levels = [
      ['||', '??'],
      ['&&'],
      ['==', '!=', '===', '!=='],
      ['<', '>', '<=', '>='],
      ['+', '-'],
      ['*', '/', '%'],
    ];
    function parseLevel(level) {
      if (level >= levels.length) return parseUnary();
      let expr = parseLevel(level + 1);
      while (current().type === 'operator' && levels[level].includes(current().value)) {
        const operator = next();
        const right = parseLevel(level + 1);
        expr = node('BinaryExpression', expr.start, { operator: operator.value, left: expr, right });
      }
      return expr;
    }
    return parseLevel(0);
  }

  function parseConditional() {
    const test = parseBinary();
    if (isPunct('?')) {
      next();
      const consequent = parseConditional();
      expectPunct(':');
      const alternate = parseConditional();
      return node('ConditionalExpression', test.start, { test, consequent, alternate });
    }
    return test;
  }

  return finish(parseConditional());
}

function extractBindingsFromExpression(ast) {
  const roots = [];
  const members = [];
  function walk(node, chain) {
    if (!node) return;
    if (node.type === 'Identifier') {
      roots.push({ name: node.name, node });
      return;
    }
    if (node.type === 'MemberExpression') {
      const parts = [];
      let current = node;
      while (current && current.type === 'MemberExpression') {
        if (current.computed) {
          walk(current.property, null);
        } else {
          parts.unshift(current.property.name);
        }
        current = current.object;
      }
      if (current && current.type === 'Identifier') {
        roots.push({ name: current.name, node: current });
        if (parts.length > 0) members.push({ root: current.name, path: [current.name, ...parts].join('.'), node, parts });
      } else if (current) {
        walk(current, chain);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      walk(node.callee, chain);
      for (const arg of node.arguments) walk(arg, chain);
      return;
    }
    for (const key of ['argument', 'left', 'right', 'test', 'consequent', 'alternate', 'expression']) {
      if (node[key]) walk(node[key], chain);
    }
    if (Array.isArray(node.elements)) for (const item of node.elements) walk(item, chain);
    if (Array.isArray(node.properties)) for (const prop of node.properties) walk(prop.value, chain);
  }
  walk(ast, null);
  const uniqueRoots = [...new Set(roots.map((item) => item.name))];
  const uniqueMembers = [...new Set(members.map((item) => item.path))];
  return { roots: uniqueRoots, members: uniqueMembers };
}

// ---------------------------------------------------------------------------
// JS / JSON parser
// ---------------------------------------------------------------------------

function parseJs(source, options) {
  const opts = options || {};
  const ts = opts.typescript || loadTypeScript();
  const file = opts.file || 'fixture.js';
  const sourceFile = ts.createSourceFile(file, String(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = sourceFile.parseDiagnostics || [];
  return {
    sourceFile,
    diagnostics: diagnostics.map((diagnostic) => {
      const position = diagnostic.start || 0;
      const location = lineColumn(String(source), position);
      return {
        code: 'JS_PARSE_ERROR',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 200),
        line: location.line,
        column: location.column,
      };
    }),
  };
}

function parseJson(source) {
  const text = String(source);
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /position (\d+)/.exec(message);
    const location = lineColumn(text, match ? Number(match[1]) : 0);
    throw new SourceParseError('JSON_PARSE_ERROR', 'JSON 解析失败：' + message.slice(0, 160), location);
  }
}

module.exports = {
  SourceParseError,
  loadTypeScript,
  lineColumn,
  offsetToPosition,
  parseWxml,
  parseWxss,
  collectWxssUrls,
  parseExpression,
  extractBindingsFromExpression,
  parseJs,
  parseJson,
};
