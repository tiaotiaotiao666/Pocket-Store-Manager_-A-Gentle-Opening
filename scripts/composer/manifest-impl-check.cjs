#!/usr/bin/env node
'use strict';

/**
 * 声明与实现一致性检查。
 *
 * 用 node:vm 桩执行组件 JS：
 * - 注入 Component/Page/require/getApp/wx
 * - 捕获 properties 与 triggerEvent 调用
 * - 与 Manifest interface.props/events 双向比对
 * - 组件顶层调用 wx.* 视为副作用（COMPONENT_SIDE_EFFECT）
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ok, fail } = require('./schema.cjs');

function normalizePropertyType(prop) {
  if (!prop) return 'unknown';
  const type = prop.type;
  if (Number.isInteger(type) || typeof type === 'string') {
    const map = {
      String: 'string',
      Number: 'number',
      Boolean: 'boolean',
      Array: 'array',
      Object: 'object',
      0: 'string',
      1: 'number',
      2: 'boolean',
      3: 'array',
      4: 'object',
    };
    return map[type] || map[type.name] || 'unknown';
  }
  return 'unknown';
}

function kebabToCamel(value) {
  return value.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function collectComponentDefinition(jsFile) {
  const source = fs.readFileSync(jsFile, 'utf8');
  let definition = null;
  let pageDefinition = null;
  let sideEffects = [];
  const events = new Set();

  const wxStub = new Proxy({}, {
    get(_target, key) {
      if (key === 'triggerEvent') return () => {};
      sideEffects.push(String(key));
      return () => {};
    },
  });

  const context = {
    Component(config) {
      definition = config;
    },
    Page(config) {
      pageDefinition = config;
    },
    Behavior(config) {
      definition = config;
    },
    require(request) {
      if (request === '../../services/request.js' || request.endsWith('/services/request.js')) {
        throw new Error('COMPONENT_REQUIRES_SERVICES');
      }
      return {};
    },
    getApp() {
      sideEffects.push('getApp');
      return { globalData: {} };
    },
    getCurrentPages() {
      return [];
    },
    wx: wxStub,
    console,
    setTimeout,
    clearTimeout,
  };

  const script = new vm.Script(source, { filename: jsFile });
  script.runInNewContext(context, { timeout: 3000 });

  if (definition && typeof definition === 'object') {
    const methods = definition.methods || {};
    Object.keys(methods).forEach((name) => {
      const fn = methods[name];
      if (typeof fn === 'function') {
        const text = fn.toString();
        const eventPattern = /triggerEvent\(\s*['"]([a-zA-Z0-9]+)['"]/g;
        let match = eventPattern.exec(text);
        while (match) {
          events.add(match[1]);
          match = eventPattern.exec(text);
        }
      }
    });
  }

  return { definition, pageDefinition, sideEffects, events, source };
}

function checkComponentImplementation(manifest, entryRoot) {
  if (!manifest || !manifest.interface) {
    return fail('MANIFEST_FIELD_MISSING', 'interface', 'Manifest 缺少 interface');
  }
  const componentJs = path.join(entryRoot, 'index.js');
  if (!fs.existsSync(componentJs)) {
    return fail('ENTRY_MISSING', componentJs, '组件入口 index.js 不存在');
  }

  let collected;
  try {
    collected = collectComponentDefinition(componentJs);
  } catch (error) {
    if (/COMPONENT_REQUIRES_SERVICES/.test(error.message)) {
      return fail('COMPONENT_BOUNDARY_VIOLATION', componentJs, '组件禁止 require 服务层');
    }
    return fail('COMPONENT_SYNTAX_ERROR', componentJs, '组件执行失败：' + error.message);
  }

  if (!collected.definition || typeof collected.definition !== 'object') {
    return fail('MANIFEST_IMPL_MISMATCH', componentJs, '组件未通过 Component() 注册');
  }

  if (collected.sideEffects.length > 0) {
    return fail('COMPONENT_SIDE_EFFECT', componentJs, '组件顶层存在副作用：' + collected.sideEffects.join(', '), {
      sideEffects: collected.sideEffects,
    });
  }

  const declaredProps = (manifest.interface.props || []).map((prop) => prop.name);
  const actualProperties = collected.definition.properties || {};
  const actualProps = Object.keys(actualProperties);

  const missing = declaredProps.filter((name) => !actualProps.includes(name));
  const extra = actualProps.filter((name) => !declaredProps.includes(name));
  if (missing.length || extra.length) {
    return fail('INTERFACE_MISMATCH', 'interface.props', 'props 声明与实现不一致', { missing, extra });
  }

  for (const prop of manifest.interface.props || []) {
    const actualType = normalizePropertyType(actualProperties[prop.name]);
    if (actualType !== 'unknown' && actualType !== prop.type) {
      return fail('INTERFACE_MISMATCH', 'interface.props.' + prop.name, 'prop 类型不一致', {
        declared: prop.type,
        actual: actualType,
      });
    }
  }

  const declaredEvents = (manifest.interface.events || []).map((event) => event.name);
  const actualEvents = [...collected.events];
  const missingEvents = declaredEvents.filter((name) => !actualEvents.includes(name));
  if (missingEvents.length > 0) {
    return fail('INTERFACE_MISMATCH', 'interface.events', '声明的事件未在实现中触发', { missing: missingEvents });
  }
  const extraEvents = actualEvents.filter((name) => !declaredEvents.includes(name));
  if (extraEvents.length > 0) {
    return fail('INTERFACE_MISMATCH', 'interface.events', '实现触发了未声明的事件', { extra: extraEvents });
  }

  return { ...ok(), props: actualProps, events: actualEvents };
}

module.exports = {
  checkComponentImplementation,
  collectComponentDefinition,
  normalizePropertyType,
  kebabToCamel,
};