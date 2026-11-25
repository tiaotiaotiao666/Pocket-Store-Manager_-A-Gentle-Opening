'use strict';

/**
 * 组件声明/属性/四件套检查。
 * - usingComponents 路径必须是 /components/<id>/index，且组件事实存在；
 * - WXML 自定义标签必须在 usingComponents 中声明；
 * - 传给组件的属性必须命中 C1 SourceFacts 的 props；required prop 缺失报错；
 * - 组件四件套文件存在（可注入 fileExists，默认不访问文件系统）。
 */

const { BUILTIN_TAGS } = require('./events.cjs');

const ALLOWED_PASSTHROUGH_ATTRIBUTES = new Set(['class', 'style', 'id', 'slot', 'hidden', 'role']);

function kebabToCamel(name) {
  return String(name).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function componentIdFromTarget(target) {
  if (typeof target !== 'string') return null;
  const match = /^\/components\/([a-z0-9-]+)\/index$/.exec(target);
  return match ? match[1] : null;
}

function isAllowedAttribute(name) {
  if (ALLOWED_PASSTHROUGH_ATTRIBUTES.has(name)) return true;
  if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('generic:')) return true;
  if (/^(?:bind|catch|capture-bind|capture-catch)/.test(name)) return true;
  if (name.startsWith('wx:')) return true;
  if (name === 'mut-bind' || name === 'capture-bind' || name === 'capture-catch') return true;
  return false;
}

function validateUsingComponents(pageId, usingComponents, facts, options) {
  const opts = options || {};
  const file = opts.file || 'index.json';
  const fileExists = opts.fileExists || null;
  const issues = [];
  if (!usingComponents || typeof usingComponents !== 'object' || Array.isArray(usingComponents)) {
    issues.push({ file, line: 1, column: 1, code: 'USING_COMPONENTS_INVALID', message: 'usingComponents 必须是对象', source: 'components' });
    return issues;
  }
  for (const [tag, target] of Object.entries(usingComponents)) {
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
      issues.push({ file, line: 1, column: 1, code: 'COMPONENT_TAG_INVALID', message: '组件标签名非法：' + tag, source: 'components' });
      continue;
    }
    const componentId = componentIdFromTarget(target);
    if (!componentId) {
      issues.push({ file, line: 1, column: 1, code: 'COMPONENT_PATH_INVALID', message: 'usingComponents 路径必须是 /components/<id>/index：' + tag, source: 'components' });
      continue;
    }
    const component = facts && facts.components ? facts.components[componentId] : null;
    if (!component) {
      issues.push({ file, line: 1, column: 1, code: 'COMPONENT_FACTS_MISSING', message: '组件不在 SourceFacts：' + componentId, source: 'components' });
      continue;
    }
    if (fileExists) {
      for (const relative of component.files) {
        if (!fileExists(component.root + '/' + relative)) {
          issues.push({ file, line: 1, column: 1, code: 'COMPONENT_FILE_MISSING', message: '组件四件套缺失：' + componentId + '/' + relative, source: 'components' });
        }
      }
    }
  }
  return issues;
}

function validateComponentTags(ast, options) {
  const opts = options || {};
  const facts = opts.facts || null;
  const pageId = opts.pageId || null;
  const file = opts.file || 'fixture.wxml';
  const usingComponents = opts.usingComponents || {};
  const issues = [];

  const components = (facts && facts.components) || {};
  const usingEntries = new Map();
  for (const [tag, target] of Object.entries(usingComponents)) {
    const componentId = componentIdFromTarget(target);
    if (componentId) usingEntries.set(tag, { componentId, component: components[componentId] || null });
  }

  function addIssue(code, message, node, attr) {
    issues.push({
      file,
      line: attr ? attr.line : node.line,
      column: attr ? attr.column : node.column,
      code,
      message: String(message).slice(0, 180),
      source: 'components',
    });
  }

  function visit(node) {
    if (!node) return;
    if (node.type === 'element') {
      if (!BUILTIN_TAGS.has(node.name)) {
        const declared = usingEntries.get(node.name);
        if (!declared) {
          addIssue('COMPONENT_UNDECLARED', 'WXML 使用了未声明组件：' + node.name, node);
        } else if (declared.component) {
          const props = new Map();
          for (const prop of declared.component.props || []) props.set(prop[0], { name: prop[0], type: prop[1], required: prop[2] === true, defaultValue: prop[3] });
          const seen = new Set();
          for (const attr of node.attributes || []) {
            if (isAllowedAttribute(attr.name)) continue;
            const camel = kebabToCamel(attr.name);
            if (!props.has(camel)) {
              addIssue('COMPONENT_PROP_UNKNOWN', '组件 ' + declared.componentId + ' 没有属性 ' + attr.name, node, attr);
            } else seen.add(camel);
          }
          for (const prop of props.values()) {
            if (prop.required && !seen.has(prop.name)) {
              addIssue('COMPONENT_PROP_REQUIRED', '组件 ' + declared.componentId + ' 缺少必填属性 ' + prop.name, node);
            }
          }
        }
      }
    }
    for (const child of node.children || []) visit(child);
  }
  visit(ast);
  return issues;
}

module.exports = {
  BUILTIN_TAGS,
  ALLOWED_PASSTHROUGH_ATTRIBUTES,
  kebabToCamel,
  componentIdFromTarget,
  validateUsingComponents,
  validateComponentTags,
};
