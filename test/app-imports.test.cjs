'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function readApp() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
}

function definedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = match[1];
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) names.add(namespace[1]);
    const braces = clause.match(/\{([\s\S]*?)\}/);
    const before = clause.split('{')[0].replace(/^[\s,]+|[\s,]+$/g, '').replace(/^\*\s+as\s+/, '');
    if (before && /^[A-Za-z_$][\w$]*$/.test(before)) names.add(before);
    if (braces) {
      braces[1].split(',').forEach((part) => {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) names.add(name);
      });
    }
  }
  for (const match of source.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  return names;
}

test('App.jsx 的 JSX 组件都能解析到导入或本地定义', () => {
  const source = readApp();
  const defined = definedNames(source);
  const missing = new Set();
  for (const match of source.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)) {
    const name = match[1];
    if (name !== 'Fragment' && !defined.has(name)) missing.add(name);
  }
  assert.deepStrictEqual([...missing], [], `App.jsx 使用了未导入的组件：${[...missing].join(', ')}`);
});

test('App.jsx 的 await 函数调用都能解析到导入或本地定义', () => {
  const source = readApp();
  const defined = definedNames(source);
  const missing = new Set();
  for (const match of source.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== 'import' && !defined.has(name)) missing.add(name);
  }
  assert.deepStrictEqual([...missing], [], `App.jsx await 了未导入的函数：${[...missing].join(', ')}`);
});