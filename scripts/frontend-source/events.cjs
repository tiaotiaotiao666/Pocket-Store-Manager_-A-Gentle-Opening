'use strict';

/**
 * WXML 事件绑定检查。
 * - event 属性解析（bindtap / bind:tap / catch / capture-bind / capture-catch）；
 * - handler 必须存在于页面 methods/lifecycle；
 * - 组件事件必须在 C1 SourceFacts 的组件 events 中声明；
 * - page-contract.requiredComponentEvents 必须有真实接线。
 */

const BUILTIN_TAGS = new Set(Object.freeze([
  'view', 'text', 'image', 'button', 'block', 'scroll-view', 'swiper', 'swiper-item', 'input',
  'textarea', 'label', 'form', 'picker', 'checkbox', 'checkbox-group', 'radio', 'radio-group',
  'switch', 'slider', 'progress', 'icon', 'rich-text', 'navigator', 'map', 'canvas', 'video',
  'audio', 'camera', 'cover-view', 'cover-image', 'movable-area', 'movable-view', 'slot',
  'template', 'import', 'include', 'wxs', 'web-view', 'open-data', 'ad', 'official-account',
  'functional-page-navigator', 'page-meta', 'navigation-bar', 'match-media', 'root-portal',
  'keyboard-accessory', 'grid-view', 'list-view', 'sticky-header', 'sticky-section', 'share-element',
]));

function parseEventAttribute(name) {
  const match = /^(capture-bind|capture-catch|bind|catch)(?::)?([A-Za-z][\w-]*)$/.exec(name);
  if (!match) return null;
  return { prefix: match[1], event: match[2] };
}

function componentIdFromTarget(target) {
  if (typeof target !== 'string') return null;
  const match = /^\/components\/([a-z0-9-]+)\/index$/.exec(target);
  return match ? match[1] : null;
}

function collectEvents(ast) {
  const events = [];
  function visit(node) {
    if (!node) return;
    if (node.type === 'element') {
      for (const attr of node.attributes || []) {
        const parsed = parseEventAttribute(attr.name);
        if (parsed) {
          events.push({
            tag: node.name,
            event: parsed.event,
            prefix: parsed.prefix,
            handler: String(attr.value || '').trim(),
            line: attr.line,
            column: attr.column,
          });
        }
      }
    }
    for (const child of node.children || []) visit(child);
  }
  visit(ast);
  return events;
}

function validatePageEvents(ast, options) {
  const opts = options || {};
  const facts = opts.facts || null;
  const pageId = opts.pageId || null;
  const file = opts.file || 'fixture.wxml';
  const pageJsAnalysis = opts.pageJsAnalysis || null;
  const issues = [];
  const events = collectEvents(ast);
  const page = facts && facts.pages ? facts.pages[pageId] : null;
  if (!pageId || !page) return { issues, events };

  const methods = new Set([...(page.handlers.methods || []), ...(page.handlers.lifecycle || [])]);
  if (pageJsAnalysis) {
    for (const method of pageJsAnalysis.methods || []) methods.add(method);
    for (const method of pageJsAnalysis.lifecycle || []) methods.add(method);
  }
  const using = page.pageJson.usingComponents || {};
  const components = facts.components || {};

  function addIssue(code, message, event) {
    issues.push({
      file,
      line: event.line,
      column: event.column,
      code,
      message: String(message).slice(0, 180),
      source: 'events',
    });
  }

  const wiring = new Set();
  for (const event of events) {
    if (event.handler.includes('{{')) {
      addIssue('EVENT_HANDLER_DYNAMIC', '事件 handler 不能是动态表达式：' + event.tag + '.' + event.event, event);
      continue;
    }
    if (!event.handler || !methods.has(event.handler)) {
      addIssue('EVENT_HANDLER_MISSING', '事件 handler 不存在：' + event.tag + '.' + event.event + '=' + event.handler, event);
    }
    const componentId = componentIdFromTarget(using[event.tag]);
    if (componentId) {
      const component = components[componentId];
      if (component && !component.events.some((item) => item[0] === event.event)) {
        addIssue('COMPONENT_EVENT_UNKNOWN', '组件 ' + componentId + ' 没有声明事件 ' + event.event, event);
      }
      wiring.add(event.tag + ':' + event.event + ':' + event.handler);
    }
  }

  const contract = page.pageContract || {};
  for (const required of contract.requiredComponentEvents || []) {
    const key = required.component + ':' + required.event + ':' + required.handler;
    if (!wiring.has(key)) {
      issues.push({
        file,
        line: 1,
        column: 1,
        code: 'CONTRACT_EVENT_MISSING',
        message: 'page-contract 组件事件未接线：' + key,
        source: 'events',
      });
    }
  }
  for (const required of contract.requiredHandlers || []) {
    if (!methods.has(required)) {
      issues.push({
        file,
        line: 1,
        column: 1,
        code: 'CONTRACT_HANDLER_MISSING',
        message: 'page-contract handler 不存在：' + required,
        source: 'events',
      });
    }
  }
  return { issues, events };
}

module.exports = {
  BUILTIN_TAGS,
  parseEventAttribute,
  componentIdFromTarget,
  collectEvents,
  validatePageEvents,
};
