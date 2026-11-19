#!/usr/bin/env node
'use strict';

/**
 * Agent 组件库目录生成与门禁。
 *
 * 用法：
 *   node scripts/component-catalog.cjs --write    # 从源码 + Manifest + curation 生成卡片
 *   node scripts/component-catalog.cjs --check    # 重算并与磁盘逐字节比对（默认）
 *
 * 事实源：templates/base/**、templates/components/**、templates/features/**、
 *        templates/frontend-packs/**、templates/registry/registry.v1.json
 * 投影：templates/catalog/index.json、components/*.json、pages/*.json、layouts/*.json
 * 人工知识：templates/catalog/curation.v1.json
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { collectComponentDefinition, normalizePropertyType } = require('./composer/manifest-impl-check.cjs');
const { treeSha256, fileSha256, walk } = require('./composer/digest.cjs');
const { loadRegistry } = require('./composer/registry.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_ROOT = path.join(REPO_ROOT, 'templates', 'catalog');
const BASE_DIR = path.join(REPO_ROOT, 'templates', 'base', 'ordering-base', '1.0.0');
const BASE_SRC = path.join(BASE_DIR, 'src');
const BASE_COMPONENTS = path.join(BASE_SRC, 'components');
const CURATION_FILE = path.join(CATALOG_ROOT, 'curation.v1.json');
let CATALOG_VERSION = '2026.11.0';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * 读取源码文本并统一行尾为 LF。
 *
 * Windows 上 `core.autocrlf=true` 会让同一份仓库出现「部分文件 CRLF、部分 LF」的混合工作区；
 * 段落卡片的 `code` 字段是把源码片段原样嵌进 JSON 字符串的，`\r` 会一起被序列化成转义的
 * `\r\n`，其 `digest` 也随之在 Windows 与 Linux 之间分叉——同一份仓库在两套环境里
 * `--check` 结果相反。凡参与片段抽取与摘要计算的源码都从这里读取，保证生成物与平台无关。
 */
function readSource(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function repoRelative(file) {
  return toPosix(path.relative(REPO_ROOT, file));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function isDirectory(entry) {
  return entry && entry.isDirectory();
}

function loadRegistryAssetMap() {
  const loaded = loadRegistry();
  if (!loaded.ok) {
    const detail = (loaded.errors || []).map((error) => error.code + ': ' + error.message).join('\n');
    throw new Error('REGISTRY_NOT_LOADED\n' + detail);
  }
  const map = new Map();
  loaded.assets.forEach((asset) => {
    map.set(asset.kind + ':' + asset.id + '@' + asset.version, asset);
  });
  return { loaded, map };
}

function collectPageDefinition(jsFile) {
  const source = readSource(jsFile);
  let pageDefinition = null;
  const loose = new Proxy(function looseValue() {}, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'toString') return () => '';
      if (key === 'valueOf') return () => 0;
      return loose;
    },
    apply() {
      return loose;
    },
    construct() {
      return loose;
    },
  });
  const context = {
    Page(config) {
      pageDefinition = config;
    },
    Component() {},
    Behavior() {},
    require() {
      return loose;
    },
    getApp() {
      return loose;
    },
    getCurrentPages() {
      return [];
    },
    wx: loose,
    console,
    setTimeout,
    clearTimeout,
  };
  new vm.Script(source, { filename: jsFile }).runInNewContext(context, { timeout: 3000 });
  return pageDefinition;
}

function defaultOf(property) {
  if (!property || !Object.prototype.hasOwnProperty.call(property, 'value')) return null;
  const value = property.value;
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function extractPayloads(definition) {
  const payloads = new Map();
  const methods = (definition && definition.methods) || {};
  Object.keys(methods).forEach((name) => {
    if (typeof methods[name] !== 'function') return;
    const source = methods[name].toString();
    const eventPattern = /triggerEvent\(\s*['"]([A-Za-z0-9]+)['"]\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/g;
    let match = eventPattern.exec(source);
    while (match) {
      const keys = [];
      if (match[2]) {
        const body = match[2].replace(/^\s*\{/, '').replace(/\}\s*$/, '');
        body.split(',').forEach((part) => {
          const entry = part.trim();
          if (!entry) return;
          const colon = entry.indexOf(':');
          if (colon >= 0) {
            const key = entry.slice(0, colon).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
          } else if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
            keys.push(entry);
          }
        });
      }
      payloads.set(match[1], sortedUnique(keys));
      match = eventPattern.exec(source);
    }
  });
  return payloads;
}

function styleInfo(componentDir, wxml, id) {
  const wxssFile = path.join(componentDir, 'index.wxss');
  const wxss = fs.existsSync(wxssFile) ? readSource(wxssFile) : '';
  const classes = [];
  const classPattern = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let classMatch = classPattern.exec(wxss);
  while (classMatch) {
    classes.push(classMatch[1]);
    classMatch = classPattern.exec(wxss);
  }
  const themeVars = [];
  const varPattern = /--(?:store|color)-[a-z0-9-]+/g;
  let varMatch = varPattern.exec(wxss);
  while (varMatch) {
    themeVars.push(varMatch[0]);
    varMatch = varPattern.exec(wxss);
  }
  const sharedClasses = [];
  const sharedPattern = /\bss-[a-z0-9-]+/g;
  let sharedMatch = sharedPattern.exec(wxml);
  while (sharedMatch) {
    sharedClasses.push(sharedMatch[0]);
    sharedMatch = sharedPattern.exec(wxml);
  }
  const imports = [];
  const importPattern = /@import\s+["']([^"']+)["']/g;
  let importMatch = importPattern.exec(wxss);
  while (importMatch) {
    imports.push(importMatch[1]);
    importMatch = importPattern.exec(wxss);
  }
  return {
    styleFile: 'index.wxss',
    rootClass: classes.includes(id) ? id : (classes[0] || id),
    themeVars: sortedUnique(themeVars),
    sharedClasses: sortedUnique(sharedClasses),
    imports: sortedUnique(imports),
    selectorCount: classes.length,
  };
}

function mirrorInfo(baseDir, registryAsset) {
  if (!registryAsset) return null;
  const assetSrc = path.join(registryAsset.dir, registryAsset.manifest.entry.path);
  const files = registryAsset.manifest.entry.files || [];
  const comparisons = files.map((file) => {
    const baseFile = path.join(baseDir, file);
    const assetFile = path.join(assetSrc, file);
    if (!fs.existsSync(baseFile) || !fs.existsSync(assetFile)) {
      return { file, base: false, registry: false, same: false };
    }
    return {
      file,
      base: true,
      registry: true,
      same: fileSha256(baseFile) === fileSha256(assetFile),
    };
  });
  return {
    assetId: registryAsset.id,
    assetVersion: registryAsset.version,
    assetPath: repoRelative(registryAsset.dir),
    sameImplementation: comparisons.every((item) => item.same),
    comparisons,
  };
}

function runtimeInfo(sourceKind) {
  if (sourceKind === 'base-builtin') {
    return {
      mode: 'base-page-fixed',
      planConsumed: false,
      note: '组件随 Base 页面固定导出；Plan.components 当前不会复制或替换 Base 同名组件。页面结构变化应走 FrontendPack，区块替换应走插槽 Feature Pack。',
    };
  }
  if (sourceKind === 'registry-ui-block') {
    return {
      mode: 'registry-validation',
      planConsumed: false,
      note: '已登记为 UI Block 并通过注册表校验，但当前 Composer 不从 Plan.components 复制它；它的价值是契约、预览与边界校验。',
    };
  }
  return {
    mode: 'slot-injection',
    planConsumed: true,
    note: '通过 Plan 的 features[].slots[] 注入，Composer 把组件目录复制到导出工程的 components/<tag>。',
  };
}

function buildComponentCard(context) {
  const { id, dir, version, sourceKind, curation, registryAsset } = context;
  const componentJs = path.join(dir, 'index.js');
  const wxml = readSource(path.join(dir, 'index.wxml'));
  const collected = collectComponentDefinition(componentJs);
  if (!collected.definition) throw new Error('COMPONENT_NOT_REGISTERED: ' + repoRelative(componentJs));
  if (collected.sideEffects.length > 0) {
    throw new Error('COMPONENT_SIDE_EFFECT: ' + id + ' -> ' + collected.sideEffects.join(','));
  }

  const definition = collected.definition;
  const properties = definition.properties || {};
  const payloads = extractPayloads(definition);
  const manifest = registryAsset ? registryAsset.manifest : null;
  const manifestProps = new Map(((manifest && manifest.interface && manifest.interface.props) || []).map((prop) => [prop.name, prop]));
  const manifestEvents = new Map(((manifest && manifest.interface && manifest.interface.events) || []).map((event) => [event.name, event]));
  const requiredProps = new Set(curation.requiredProps || []);

  const props = Object.keys(properties).sort().map((name) => {
    const manifestProp = manifestProps.get(name);
    const actualType = normalizePropertyType(properties[name]);
    if (manifestProp && manifestProp.type !== actualType) {
      throw new Error('PROP_TYPE_MISMATCH: ' + id + '.' + name + ' declared=' + manifestProp.type + ' actual=' + actualType);
    }
    return {
      name,
      type: actualType,
      required: manifestProp ? Boolean(manifestProp.required) : requiredProps.has(name),
      defaultValue: defaultOf(properties[name]),
      description: (manifestProp && manifestProp.description) || (curation.propDescriptions && curation.propDescriptions[name]) || '',
    };
  });

  const events = [...collected.events].sort().map((name) => {
    const manifestEvent = manifestEvents.get(name);
    const payload = manifestEvent && Array.isArray(manifestEvent.payload) ? manifestEvent.payload : (payloads.get(name) || []);
    const actualPayload = payloads.get(name) || [];
    if (manifestEvent && manifestEvent.payload && sortedUnique(payload).join(',') !== sortedUnique(actualPayload).join(',')) {
      throw new Error('EVENT_PAYLOAD_MISMATCH: ' + id + '.' + name + ' declared=' + payload.join(',') + ' actual=' + actualPayload.join(','));
    }
    return {
      name,
      payload,
      description: (manifestEvent && manifestEvent.description) || (curation.eventDescriptions && curation.eventDescriptions[name]) || '',
    };
  });

  if (manifest) {
    const declaredEvents = [...manifestEvents.keys()].sort();
    const actualEvents = [...collected.events].sort();
    if (declaredEvents.join(',') !== actualEvents.join(',')) {
      throw new Error('EVENT_SET_MISMATCH: ' + id + ' declared=' + declaredEvents.join(',') + ' actual=' + actualEvents.join(','));
    }
  }

  const manifestFiles = manifest ? manifest.entry.files : ['index.js', 'index.json', 'index.wxml', 'index.wxss'];
  const files = sortedUnique(manifestFiles.concat(walk(dir).map((file) => toPosix(path.relative(dir, file)))));

  return {
    schemaVersion: 'component-catalog-entry.v1',
    id,
    version,
    displayName: curation.displayName || (manifest && manifest.displayName) || id,
    category: curation.category,
    summary: curation.summary || '',
    sourceKind,
    source: {
      root: repoRelative(dir),
      files,
      registryAsset: registryAsset ? { id: registryAsset.id, version: registryAsset.version, kind: registryAsset.kind, path: repoRelative(registryAsset.dir) } : null,
      registryMirror: sourceKind === 'base-builtin' ? mirrorInfo(dir, registryAsset) : null,
      digest: treeSha256(dir),
    },
    runtime: runtimeInfo(sourceKind),
    interface: { props, events },
    usage: {
      tag: id,
      wxmlExample: curation.wxmlExample || '<' + id + ' />',
      whenToUse: curation.whenToUse || [],
      avoidWhen: curation.avoidWhen || [],
      notes: curation.notes || [],
    },
    pages: context.pages,
    slots: context.slots,
    dataModel: {
      fields: curation.dataFields || [],
      moneyRule: '金额只使用整数分；展示格式化由 Base 领域层或组件负责，禁止引入第二份金额事实。',
    },
    styles: styleInfo(dir, wxml, id),
    constraints: [
      'UI 组件不得调用 wx.request / wx.uploadFile / 云函数。',
      '不得读写 getApp().globalData 或页面栈业务状态。',
      '不得固定 wx.navigateTo / redirectTo / switchTab / reLaunch。',
      '不得 require 服务层；数据由页面传入，用户意图通过事件上报。',
      ...(curation.constraints || []),
    ],
    knownLimits: (manifest && manifest.release && manifest.release.knownLimits) || [],
    preview: manifest ? { dir: repoRelative(path.join(registryAsset.dir, manifest.preview.dir)), kinds: manifest.preview.kinds } : null,
    verify: {
      command: 'node scripts/component-catalog.cjs --check',
      digest: treeSha256(dir),
    },
  };
}

const LIFECYCLE_KEYS = new Set([
  'onLoad',
  'onReady',
  'onShow',
  'onHide',
  'onUnload',
  'onPullDownRefresh',
  'onReachBottom',
  'onShareAppMessage',
  'onPageScroll',
  'onResize',
  'onTabItemTap',
  'onAddToFavorites',
]);

const SLOT_DATA_KEY_FALLBACK = {
  'menu-hero': 'menuHero',
};

function collectPageCard(pageId, pageMeta, baseManifest, slotsDoc, knownComponents, curation) {
  const pageDir = path.join(BASE_SRC, 'pages', pageId);
  const pageJs = path.join(pageDir, 'index.js');
  const pageJson = readJson(path.join(pageDir, 'index.json'));
  const wxml = readSource(path.join(pageDir, 'index.wxml'));
  const controller = collectPageDefinition(pageJs) || {};
  const declared = pageJson.usingComponents || {};
  const declaredIds = Object.keys(declared)
    .map((tag) => {
      const target = String(declared[tag]);
      const match = target.match(/\/components\/([a-z0-9-]+)\/index$/);
      return match ? match[1] : null;
    })
    .filter(Boolean);
  const missingDeclared = declaredIds.filter((id) => !knownComponents.has(id));
  if (missingDeclared.length > 0) {
    throw new Error('PAGE_COMPONENT_UNKNOWN: ' + pageId + ' -> ' + missingDeclared.join(','));
  }

  const components = [];
  sortedUnique(declaredIds).forEach((id) => {
    const tagPattern = new RegExp('<' + id + '\\b[^>]*>', 'g');
    const match = tagPattern.exec(wxml);
    if (!match) {
      components.push({ tag: id, componentId: id, mode: 'declared-only', sourceLine: 0, usage: '' });
      return;
    }
    const attrs = match[0];
    const prefix = wxml.slice(0, match.index);
    const line = prefix.split('\n').length;
    const lineStart = prefix.lastIndexOf('\n') + 1;
    const lineEnd = wxml.indexOf('\n', match.index);
    const lineText = wxml.slice(lineStart, lineEnd < 0 ? wxml.length : lineEnd);
    let mode = 'always';
    if (/\bvisible\s*=/.test(attrs)) mode = 'modal';
    else if (/wx:(?:if|elif)\s*=/.test(attrs) || /wx:(?:if|elif)\s*=/.test(lineText)) mode = 'conditional';
    components.push({
      tag: id,
      componentId: id,
      mode,
      sourceLine: line,
      usage: attrs.replace(/\s+/g, ' ').slice(0, 200),
    });
  });
  components.sort((a, b) => (a.sourceLine || Number.MAX_SAFE_INTEGER) - (b.sourceLine || Number.MAX_SAFE_INTEGER) || a.tag.localeCompare(b.tag));

  const rawSlots = (baseManifest.slots || []).filter((slot) => slot.pageId === pageId);
  const slotDetails = new Map((((slotsDoc && slotsDoc.slots) || [])).map((slot) => [slot.slotId, slot]));
  const slots = rawSlots.map((slot) => {
    const detail = slotDetails.get(slot.slotId) || {};
    const anchors = [
      '<!-- @slot:' + slot.slotId + ' -->',
      '<!-- @slot-fallback:' + slot.slotId + ' -->',
      '<!-- @slot-fallback:' + slot.slotId + ':end -->',
      '<!-- @slot:' + slot.slotId + ':end -->',
    ];
    const counts = anchors.map((anchor) => wxml.split(anchor).length - 1);
    return {
      slotId: slot.slotId,
      pageId: slot.pageId,
      maxItems: slot.maxItems,
      accepts: slot.accepts,
      required: Boolean(slot.required),
      dataKey: detail.dataKey || SLOT_DATA_KEY_FALLBACK[slot.slotId] || null,
      anchorsPresent: counts.every((count) => count === 1),
      anchorCounts: counts,
    };
  });
  slots.sort((a, b) => wxml.indexOf('<!-- @slot:' + a.slotId + ' -->') - wxml.indexOf('<!-- @slot:' + b.slotId + ' -->'));

  const topLevelFunctions = Object.keys(controller).filter((key) => typeof controller[key] === 'function').sort();
  const lifecycle = topLevelFunctions.filter((key) => LIFECYCLE_KEYS.has(key));
  const methods = sortedUnique(
    topLevelFunctions
      .filter((key) => !LIFECYCLE_KEYS.has(key))
      .concat(Object.keys(controller.methods || {}).filter((key) => typeof controller.methods[key] === 'function')),
  );
  const dataKeys = Object.keys(controller.data || {}).sort();
  const notes = ((curation.pages[pageId] && curation.pages[pageId].notes) || []).slice();
  components.filter((item) => item.mode === 'declared-only').forEach((item) => {
    notes.push('usingComponents 声明了 ' + item.tag + '，但当前 WXML 未使用；Composer 导出时会过滤。');
  });

  return {
    schemaVersion: 'page-catalog-entry.v1',
    pageId,
    title: pageJson.navigationBarTitleText || pageId,
    audience: pageMeta.audience,
    required: Boolean(pageMeta.required),
    summary: (curation.pages[pageId] && curation.pages[pageId].summary) || '',
    source: {
      root: repoRelative(pageDir),
      files: sortedUnique(walk(pageDir).map((file) => toPosix(path.relative(pageDir, file)))),
      digest: treeSha256(pageDir),
    },
    components,
    slots,
    controller: { methods, lifecycle, dataKeys },
    pageJson: {
      navigationBarTitleText: pageJson.navigationBarTitleText || '',
      enablePullDownRefresh: Boolean(pageJson.enablePullDownRefresh),
      usingComponents: declared,
    },
    notes,
  };
}

function slotRanges(wxml, slots) {
  return slots.map((slot) => {
    const begin = wxml.indexOf('<!-- @slot:' + slot.slotId + ' -->');
    const end = wxml.indexOf('<!-- @slot:' + slot.slotId + ':end -->');
    return { slotId: slot.slotId, begin, end };
  }).filter((range) => range.begin >= 0 && range.end > range.begin);
}

function attrValue(attrs, name) {
  const pattern = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
  const match = pattern.exec(attrs || '');
  if (!match) return null;
  return match[2] !== undefined ? match[2] : match[3];
}

/**
 * 引号感知的 WXML 标签扫描。
 * 旧实现用 /<tag([^>]*)>/ 取标签，属性值里出现 `>`（如 wx:if="{{count > 0}}"）会把标签提前截断，
 * 导致 fp-home__notice / fp-home__orders 这类区块无法被识别。
 */
function scanWxmlTags(source) {
  const tags = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open < 0) break;
    if (source.startsWith('<!--', open)) {
      const commentEnd = source.indexOf('-->', open + 4);
      cursor = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    const closing = source[open + 1] === '/';
    const nameStart = open + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(source.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      cursor = open + 1;
      continue;
    }
    const tag = nameMatch[0];
    const attrStart = nameStart + tag.length;
    let quote = null;
    let tagEnd = -1;
    for (let index = attrStart; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        tagEnd = index;
        break;
      }
    }
    if (tagEnd < 0) break;
    const attrs = source.slice(attrStart, tagEnd);
    tags.push({
      tag,
      closing,
      selfClosing: /\/\s*$/.test(attrs),
      start: open,
      end: tagEnd + 1,
      attrs,
      raw: source.slice(open, tagEnd + 1),
    });
    cursor = tagEnd + 1;
  }
  return tags;
}

function parseWxssRules(text) {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let index = 0;
  while (index < cleaned.length) {
    const open = cleaned.indexOf('{', index);
    if (open < 0) break;
    const selector = cleaned.slice(index, open).trim();
    const close = cleaned.indexOf('}', open + 1);
    if (close < 0) break;
    rules.push({
      selector,
      declarations: cleaned.slice(open + 1, close).split(';').map((item) => item.trim()).filter(Boolean),
    });
    index = close + 1;
  }
  return rules;
}

function parseWxmlBlocks(wxml, purposeMap) {
  const tags = scanWxmlTags(wxml);
  const blocks = [];
  const stack = [];
  tags.forEach((item) => {
    if (item.closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === item.tag) {
          const popped = stack.splice(index)[0];
          if (popped.block) popped.block.end = item.end;
          break;
        }
      }
      return;
    }
    const classTokens = (attrValue(item.attrs, 'class') || '').split(/\s+/).filter(Boolean);
    const className = classTokens.find((token) => /^fp-[a-z0-9-]+(?:__[a-zA-Z0-9-]+)?(?:--[a-zA-Z0-9-]+)?$/.test(token)) || null;
    const ownerBlock = [...stack].reverse().find((entry) => entry.block);
    let block = null;
    if (className) {
      block = {
        className,
        parentClass: ownerBlock ? ownerBlock.block.className : null,
        depth: ownerBlock ? ownerBlock.block.depth + 1 : 1,
        index: item.start,
        end: item.selfClosing ? item.end : wxml.length,
        sourceLine: wxml.slice(0, item.start).split('\n').length,
        purpose: purposeMap[className] || '',
        components: [],
        slots: [],
      };
      blocks.push(block);
    }
    if (KNOWN_COMPONENT_IDS.has(item.tag)) {
      const owner = [...stack].reverse().find((entry) => entry.block);
      if (owner && !owner.block.components.includes(item.tag)) owner.block.components.push(item.tag);
    }
    if (!item.selfClosing) stack.push({ tag: item.tag, block: block || null });
  });
  return blocks;
}

function buildLayoutCard(asset, curation) {
  const packSrc = path.join(asset.dir, 'src');
  const manifest = asset.manifest;
  const key = asset.id + '@' + asset.version;
  const layoutCuration = curation.layouts[key] || {};
  const pages = manifest.pages.map((pageId) => {
    const pageDir = path.join(packSrc, 'pages', pageId);
    const wxml = readSource(path.join(pageDir, 'index.wxml'));
    const wxss = readSource(path.join(pageDir, 'index.wxss'));
    const pageJson = readJson(path.join(pageDir, 'index.json'));
    const ranges = slotRanges(wxml, (manifest.requiresSlots || []).map((slotId) => ({ slotId })));
    const blockMatches = parseWxmlBlocks(wxml, layoutCuration.blockPurposes || {});
    blockMatches.forEach((block) => {
      block.slots = ranges
        .filter((range) => block.index <= range.begin && block.end >= range.end)
        .map((range) => range.slotId);
    });
    const themeVars = [];
    const varPattern = /--(?:store|color)-[a-z0-9-]+/g;
    let varMatch = varPattern.exec(wxss);
    while (varMatch) {
      themeVars.push(varMatch[0]);
      varMatch = varPattern.exec(wxss);
    }
    return {
      pageId,
      source: {
        wxml: repoRelative(path.join(pageDir, 'index.wxml')),
        wxss: repoRelative(path.join(pageDir, 'index.wxss')),
        json: repoRelative(path.join(pageDir, 'index.json')),
      },
      pageJson: {
        navigationBarTitleText: pageJson.navigationBarTitleText || '',
        usingComponents: pageJson.usingComponents || {},
      },
      slots: (manifest.requiresSlots || [])
        .filter((slotId) => wxml.includes('<!-- @slot:' + slotId + ' -->'))
        .map((slotId) => ({
          slotId,
          anchorsPresent: [
            '<!-- @slot:' + slotId + ' -->',
            '<!-- @slot-fallback:' + slotId + ' -->',
            '<!-- @slot-fallback:' + slotId + ':end -->',
            '<!-- @slot:' + slotId + ':end -->',
          ].every((anchor) => wxml.split(anchor).length - 1 === 1),
        })),
      blocks: blockMatches.map((block) => ({
        className: block.className,
        parentClass: block.parentClass,
        depth: block.depth,
        sourceLine: block.sourceLine,
        purpose: block.purpose,
        components: block.components,
        slots: block.slots,
      })),
      style: {
        themeVars: sortedUnique(themeVars),
        selectorCount: (wxss.match(/\.(fp-[a-zA-Z0-9_-]+)/g) || []).length,
        imports: sortedUnique((wxss.match(/@import\s+["'][^"']+["']/g) || [])),
      },
      controllerSource: 'Base pages/' + pageId + '/index.js（FrontendPack 不包含 JS）',
    };
  });

  return {
    schemaVersion: 'layout-catalog-entry.v1',
    id: asset.id,
    version: asset.version,
    kind: asset.kind,
    displayName: manifest.displayName,
    summary: layoutCuration.summary || '',
    source: {
      root: repoRelative(asset.dir),
      manifest: repoRelative(path.join(asset.dir, 'manifest.json')),
      digest: treeSha256(asset.dir),
    },
    pages,
    requiresSlots: manifest.requiresSlots,
    constraints: [...new Set([
      '只覆盖 WXML/WXSS/页面 JSON，不包含任何 JS；页面控制器始终来自 Base。',
      'WXSS 追加在 Base 页面样式之后，不删除 Base 原有样式。',
      '页面 JSON 只允许白名单键，usingComponents 只能是 Base 页面的子集。',
      '事件绑定必须命中 Base 控制器已有方法，否则构建期 FRONTEND_PACK_EVENT_UNKNOWN。',
      ...((manifest.release && manifest.release.knownLimits) || []),
    ])],
    preview: {
      dir: repoRelative(path.join(asset.dir, manifest.preview.dir)),
      kinds: manifest.preview.kinds,
    },
  };
}

function textSha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function closingTagEnd(tags, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < tags.length; index += 1) {
    const item = tags[index];
    if (item.tag !== tags[startIndex].tag) continue;
    if (item.closing) {
      depth -= 1;
      if (depth === 0) return item.end;
      continue;
    }
    if (!item.selfClosing) depth += 1;
  }
  return -1;
}

function uniqueClassTokens(code) {
  const tokens = [];
  const pattern = /class\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(code);
  while (match) {
    match[1].split(/\s+/).filter(Boolean).forEach((token) => {
      if (!tokens.includes(token)) tokens.push(token);
    });
    match = pattern.exec(code);
  }
  return tokens;
}

const DATA_FIELD_KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'item', 'index', 'length']);

function extractDataFields(code) {
  const fields = new Set();
  const pattern = /\{\{([\s\S]*?)\}\}/g;
  let match = pattern.exec(code);
  while (match) {
    const identifiers = match[1].match(/[A-Za-z_$][\w$]*/g) || [];
    identifiers.forEach((identifier) => {
      if (!DATA_FIELD_KEYWORDS.has(identifier)) fields.add(identifier);
    });
    match = pattern.exec(code);
  }
  return [...fields].sort();
}

function extractHandlers(code) {
  const handlers = [];
  const pattern = /(?:bind|catch|mut-bind|capture-bind|capture-catch):?([a-zA-Z]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(code);
  while (match) {
    handlers.push({ type: match[1], handler: match[2] });
    match = pattern.exec(code);
  }
  return handlers;
}

function describeComponentUse(item) {
  const bindings = [];
  const events = [];
  const pattern = /(?:^|\s)([a-zA-Z][\w:-]*)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(item.attrs);
  while (match) {
    const name = match[1];
    const value = match[2];
    const eventMatch = /^(?:bind|catch|mut-bind|capture-bind|capture-catch):?([a-zA-Z]+)$/.exec(name);
    if (eventMatch) events.push({ name: eventMatch[1], handler: value });
    else bindings.push({ attr: name, expression: value });
    match = pattern.exec(item.attrs);
  }
  return { tag: item.tag, bindings, events };
}

function extractSlotIds(code) {
  const ids = [];
  const pattern = /<!--\s*@slot:([a-z0-9-]+)\s*-->/g;
  let match = pattern.exec(code);
  while (match) {
    if (!ids.includes(match[1])) ids.push(match[1]);
    match = pattern.exec(code);
  }
  return ids;
}

function resolveSectionRanges(wxml, tags, def) {
  if (def.selector) {
    const expected = def.occurrences || 1;
    const ranges = [];
    tags.forEach((item, index) => {
      if (item.closing) return;
      const tokens = (attrValue(item.attrs, 'class') || '').split(/\s+/).filter(Boolean);
      if (!tokens.includes(def.selector)) return;
      const end = item.selfClosing ? item.end : closingTagEnd(tags, index);
      if (end < 0) return;
      ranges.push({
        start: item.start,
        end,
        code: wxml.slice(item.start, end),
        rootTag: item.tag,
        lineStart: lineOf(wxml, item.start),
        lineEnd: lineOf(wxml, end - 1),
      });
    });
    if (def.occurrence) {
      if (!Number.isInteger(def.occurrence) || def.occurrence < 1 || def.occurrence > ranges.length) {
        throw new Error('SECTION_SELECTOR_DRIFT: ' + def.id + ' selector=' + def.selector + ' occurrence=' + def.occurrence + ' actual=' + ranges.length);
      }
      return [ranges[def.occurrence - 1]];
    }
    if (ranges.length !== expected) {
      throw new Error('SECTION_SELECTOR_DRIFT: ' + def.id + ' selector=' + def.selector + ' expected=' + expected + ' actual=' + ranges.length);
    }
    return ranges;
  }
  if (def.componentTag) {
    const expected = def.occurrence || 1;
    const matched = tags.filter((item) => !item.closing && item.tag === def.componentTag);
    if (matched.length < expected) {
      throw new Error('SECTION_COMPONENT_DRIFT: ' + def.id + ' tag=' + def.componentTag + ' expected>=' + expected + ' actual=' + matched.length);
    }
    const item = matched[expected - 1];
    const end = item.selfClosing ? item.end : closingTagEnd(tags, tags.indexOf(item));
    if (end < 0) throw new Error('SECTION_UNCLOSED: ' + def.id);
    return [{
      start: item.start,
      end,
      code: wxml.slice(item.start, end),
      rootTag: item.tag,
      lineStart: lineOf(wxml, item.start),
      lineEnd: lineOf(wxml, end - 1),
    }];
  }
  if (def.slotId) {
    const beginMarker = '<!-- @slot:' + def.slotId + ' -->';
    const endMarker = '<!-- @slot:' + def.slotId + ':end -->';
    const begin = wxml.indexOf(beginMarker);
    const end = wxml.indexOf(endMarker);
    if (begin < 0 || end < 0) throw new Error('SECTION_SLOT_DRIFT: ' + def.id + ' slot=' + def.slotId);
    const contentStart = begin + beginMarker.length;
    const contentEnd = end + endMarker.length;
    return [{
      start: contentStart,
      end: contentEnd,
      code: wxml.slice(contentStart, contentEnd),
      rootTag: '#slot',
      lineStart: lineOf(wxml, contentStart),
      lineEnd: lineOf(wxml, contentEnd - 1),
    }];
  }
  throw new Error('SECTION_LOCATOR_MISSING: ' + def.id);
}

function sectionStyleInfo(rules, code) {
  const classTokens = uniqueClassTokens(code);
  const matched = rules.filter((rule) => classTokens.some((token) => rule.selector.includes('.' + token)));
  const themeVars = new Set();
  matched.forEach((rule) => {
    const joined = rule.declarations.join(';');
    const pattern = /--(?:store|color)-[a-z0-9-]+/g;
    let match = pattern.exec(joined);
    while (match) {
      themeVars.add(match[0]);
      match = pattern.exec(joined);
    }
  });
  return {
    rootClass: classTokens.find((token) => /^fp-/.test(token)) || null,
    classTokens,
    selectors: matched.map((rule) => ({ selector: rule.selector, declarations: rule.declarations })),
    themeVars: [...themeVars].sort(),
    selectorCount: matched.length,
  };
}

function collectBasePageHandlers() {
  const map = new Map();
  fs.readdirSync(path.join(BASE_SRC, 'pages'), { withFileTypes: true })
    .filter(isDirectory)
    .forEach((entry) => {
      const controller = collectPageDefinition(path.join(BASE_SRC, 'pages', entry.name, 'index.js')) || {};
      const names = new Set();
      Object.keys(controller).forEach((key) => {
        if (typeof controller[key] === 'function') names.add(key);
      });
      Object.keys(controller.methods || {}).forEach((key) => {
        if (typeof controller.methods[key] === 'function') names.add(key);
      });
      map.set(entry.name, names);
    });
  return map;
}

function buildSectionCatalog(context) {
  const { source, curation, basePageHandlers } = context;
  const srcRoot = source.srcRoot;
  const key = source.id + '@' + source.version;
  const sectionCuration = (curation.sections || {})[key] || {};
  const cardsByKey = new Map();
  const pages = [];
  const gaps = [];
  let total = 0;
  const pageSource = source.kind === 'base' ? 'base-page' : 'frontend-pack-page';

  source.pages.forEach((pageId) => {
    const definitions = sectionCuration[pageId];
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new Error('CURATION_MISSING_SECTION: ' + key + '#' + pageId);
    }
    const pageDir = path.join(srcRoot, 'pages', pageId);
    const wxmlFile = path.join(pageDir, 'index.wxml');
    const wxssFile = path.join(pageDir, 'index.wxss');
    const wxml = readSource(wxmlFile);
    const wxss = readSource(wxssFile);
    const tags = scanWxmlTags(wxml);
    const rules = parseWxssRules(wxss);
    const handlers = basePageHandlers.get(pageId) || new Set();

    const cards = definitions.map((def, index) => {
      const ranges = resolveSectionRanges(wxml, tags, def);
      const code = ranges.map((range) => range.code).join('\n');

      const componentUses = [];
      ranges.forEach((range) => {
        scanWxmlTags(range.code).forEach((item) => {
          if (item.closing || !KNOWN_COMPONENT_IDS.has(item.tag)) return;
          const described = describeComponentUse(item);
          const existing = componentUses.find((entry) => entry.tag === described.tag);
          if (!existing) {
            componentUses.push(described);
            return;
          }
          described.bindings.forEach((binding) => {
            if (!existing.bindings.some((item2) => item2.attr === binding.attr && item2.expression === binding.expression)) {
              existing.bindings.push(binding);
            }
          });
          described.events.forEach((event) => {
            if (!existing.events.some((item2) => item2.name === event.name && item2.handler === event.handler)) {
              existing.events.push(event);
            }
          });
        });
      });

      const sectionHandlers = extractHandlers(code);
      const uniqueHandlers = [...new Set(sectionHandlers.map((entry) => entry.handler))].sort();
      const missingHandlers = uniqueHandlers.filter((name) => !handlers.has(name));
      const styles = sectionStyleInfo(rules, code);
      const reuse = def.reuse || {};
      const digest = textSha256(code + '\n' + JSON.stringify(styles.selectors));
      const card = {
        schemaVersion: 'section-catalog-entry.v1',
        id: def.id,
        displayName: def.displayName || def.id,
        summary: def.summary || '',
        layout: { id: source.id, version: source.version },
        pageSource,
        pageId,
        order: index + 1,
        locator: {
          selector: def.selector || null,
          componentTag: def.componentTag || null,
          slotId: def.slotId || null,
          occurrence: def.occurrence || null,
          occurrences: ranges.length,
        },
        source: {
          wxml: repoRelative(wxmlFile),
          wxss: repoRelative(wxssFile),
          lineStart: Math.min(...ranges.map((range) => range.lineStart)),
          lineEnd: Math.max(...ranges.map((range) => range.lineEnd)),
          digest,
        },
        template: {
          occurrences: ranges.length,
          rootTag: ranges[0].rootTag,
          snippets: ranges.map((range) => ({
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            code: range.code.trim(),
          })),
        },
        components: componentUses,
        slots: extractSlotIds(code),
        bindings: {
          dataFields: extractDataFields(code),
          handlers: sectionHandlers,
        },
        controller: {
          source: 'Base pages/' + pageId + '/index.js',
          handlers: uniqueHandlers,
          verified: missingHandlers.length === 0,
          missing: missingHandlers,
        },
        styles,
        reuse: {
          level: reuse.level || 'direct-wxml',
          reason: reuse.reason || '',
          whenToUse: reuse.whenToUse || [],
          avoidWhen: reuse.avoidWhen || [],
          uiBlockBlueprint: reuse.uiBlockBlueprint || null,
        },
        constraints: [...new Set(def.constraints || [])],
        knownLimits: [...new Set(def.knownLimits || [])],
        verify: { command: 'node scripts/component-catalog.cjs --check', digest },
      };

      if (missingHandlers.length) {
        gaps.push({
          code: 'SECTION_CONTROLLER_HANDLER_UNKNOWN',
          severity: 'error',
          message: '区块绑定的事件在 Base 页面控制器中不存在',
          details: { layout: key, pageId, sectionId: def.id, missing: missingHandlers },
        });
      }

      cardsByKey.set('sections/' + key + '/' + pageId + '/' + def.id + '.json', card);
      total += 1;
      return card;
    });

    cardsByKey.set('sections/' + key + '/' + pageId + '/index.json', {
      schemaVersion: 'section-page-index.v1',
      layout: { id: source.id, version: source.version },
      pageSource,
      pageId,
      source: { wxml: repoRelative(wxmlFile), wxss: repoRelative(wxssFile) },
      counts: { sections: cards.length },
      sections: cards.map((card) => ({
        id: card.id,
        displayName: card.displayName,
        order: card.order,
        locator: card.locator,
        lineStart: card.source.lineStart,
        components: card.components.map((entry) => entry.tag),
        slots: card.slots,
        reuseLevel: card.reuse.level,
        card: card.id + '.json',
      })),
    });
    pages.push({
      layout: { id: source.id, version: source.version },
      pageSource,
      pageId,
      index: 'sections/' + key + '/' + pageId + '/index.json',
      count: cards.length,
    });
  });

  return { cardsByKey, pages, total, gaps };
}

let KNOWN_COMPONENT_IDS = new Set();

function buildAll() {
  const curation = readJson(CURATION_FILE);
  const { loaded } = loadRegistryAssetMap();
  CATALOG_VERSION = loaded.registry.registryVersion;
  const baseManifest = readJson(path.join(BASE_DIR, 'manifest.json'));
  const slotsDocFile = path.join(BASE_DIR, 'slots.json');
  const slotsDoc = fs.existsSync(slotsDocFile) ? readJson(slotsDocFile) : null;
  const basePages = new Map(baseManifest.pages.map((page) => [page.pageId, page]));

  const baseComponentIds = fs.readdirSync(BASE_COMPONENTS, { withFileTypes: true })
    .filter(isDirectory)
    .map((entry) => entry.name)
    .sort();
  KNOWN_COMPONENT_IDS = new Set(baseComponentIds);

  const uiBlocks = loaded.assets.filter((asset) => asset.kind === 'ui-block');
  const featurePacks = loaded.assets.filter((asset) => asset.kind === 'feature-pack');
  const frontendPacks = loaded.assets.filter((asset) => asset.kind === 'frontend-pack');
  const uiBlockById = new Map(uiBlocks.map((asset) => [asset.id, asset]));

  const componentInputs = [];
  baseComponentIds.forEach((id) => {
    const curationEntry = curation.components[id];
    if (!curationEntry) throw new Error('CURATION_MISSING_COMPONENT: ' + id);
    const registryAsset = uiBlockById.get(id) || null;
    componentInputs.push({
      id,
      dir: path.join(BASE_COMPONENTS, id),
      version: '1.0.0',
      sourceKind: 'base-builtin',
      registryAsset,
      curation: curationEntry,
    });
  });

  uiBlocks.filter((asset) => !baseComponentIds.includes(asset.id)).forEach((asset) => {
    const curationEntry = curation.components[asset.id];
    if (!curationEntry) throw new Error('CURATION_MISSING_COMPONENT: ' + asset.id);
    componentInputs.push({
      id: asset.id,
      dir: path.join(asset.dir, asset.manifest.entry.path),
      version: asset.version,
      sourceKind: 'registry-ui-block',
      registryAsset: asset,
      curation: curationEntry,
    });
    KNOWN_COMPONENT_IDS.add(asset.id);
  });

  featurePacks.forEach((asset) => {
    const curationEntry = curation.components[asset.id];
    if (!curationEntry) throw new Error('CURATION_MISSING_COMPONENT: ' + asset.id);
    componentInputs.push({
      id: asset.id,
      dir: path.join(asset.dir, asset.manifest.entry.path),
      version: asset.version,
      sourceKind: 'feature-pack',
      registryAsset: asset,
      curation: curationEntry,
    });
    KNOWN_COMPONENT_IDS.add(asset.id);
  });

  const cardsByKey = new Map();
  const componentCards = componentInputs.map((input) => {
    const pageIds = new Set();
    if (input.registryAsset) {
      (input.registryAsset.manifest.requiredPages || []).forEach((pageId) => pageIds.add(pageId));
    } else {
      baseObjectPages(input.id).forEach((pageId) => pageIds.add(pageId));
    }
    const slots = input.registryAsset && input.registryAsset.kind === 'feature-pack'
      ? (input.registryAsset.manifest.requiresSlots || [])
      : [];
    const card = buildComponentCard({
      ...input,
      pages: [...pageIds].sort(),
      slots,
    });
    cardsByKey.set('components/' + input.id + '.json', card);
    return card;
  });

  function baseObjectPages(componentId) {
    const pages = [];
    basePages.forEach((pageMeta, pageId) => {
      const pageJson = readJson(path.join(BASE_SRC, 'pages', pageId, 'index.json'));
      const targets = Object.values(pageJson.usingComponents || {}).map((value) => String(value));
      if (targets.some((target) => target === '/components/' + componentId + '/index')) pages.push(pageId);
    });
    return pages;
  }

  const pageCards = [...basePages.keys()].sort().map((pageId) => {
    if (!curation.pages[pageId]) throw new Error('CURATION_MISSING_PAGE: ' + pageId);
    return collectPageCard(pageId, basePages.get(pageId), baseManifest, slotsDoc, KNOWN_COMPONENT_IDS, curation);
  });
  pageCards.forEach((card) => cardsByKey.set('pages/' + card.pageId + '.json', card));

  const layoutCards = frontendPacks.map((asset) => {
    const key = asset.id + '@' + asset.version;
    if (!curation.layouts[key]) throw new Error('CURATION_MISSING_LAYOUT: ' + key);
    const card = buildLayoutCard(asset, curation);
    cardsByKey.set('layouts/' + key + '.json', card);
    return card;
  });

  const basePageHandlers = collectBasePageHandlers();
  const sectionResult = { cardsByKey: new Map(), pages: [], total: 0, gaps: [] };
  const frontendPackPages = new Set();
  frontendPacks.forEach((asset) => (asset.manifest.pages || []).forEach((pageId) => frontendPackPages.add(pageId)));
  const sectionSources = frontendPacks.map((asset) => ({
    id: asset.id,
    version: asset.version,
    kind: 'frontend-pack',
    srcRoot: path.join(asset.dir, 'src'),
    pages: asset.manifest.pages,
  }));
  const baseSectionPages = [...basePages.keys()].filter((pageId) => !frontendPackPages.has(pageId)).sort();
  if (baseSectionPages.length) {
    sectionSources.push({
      id: baseManifest.identity.id,
      version: baseManifest.identity.version,
      kind: 'base',
      srcRoot: BASE_SRC,
      pages: baseSectionPages,
    });
  }
  sectionSources.forEach((source) => {
    const built = buildSectionCatalog({ source, curation, basePageHandlers });
    built.cardsByKey.forEach((card, relative) => sectionResult.cardsByKey.set(relative, card));
    built.pages.forEach((page) => sectionResult.pages.push(page));
    sectionResult.total += built.total;
    built.gaps.forEach((gap) => sectionResult.gaps.push(gap));
  });
  sectionResult.cardsByKey.forEach((card, relative) => cardsByKey.set(relative, card));

  const gaps = [];
  sectionResult.gaps.forEach((gap) => gaps.push(gap));
  const declaredBuiltins = [...(baseManifest.builtinComponents || [])].sort();
  const diskBuiltins = [...baseComponentIds].sort();
  const missingBuiltins = diskBuiltins.filter((id) => !declaredBuiltins.includes(id));
  const extraBuiltins = declaredBuiltins.filter((id) => !diskBuiltins.includes(id));
  if (missingBuiltins.length || extraBuiltins.length) {
    gaps.push({
      code: 'BASE_BUILTIN_MANIFEST_GAP',
      severity: 'error',
      message: 'Base Manifest builtinComponents 与磁盘组件目录不一致',
      details: { missingBuiltins, extraBuiltins },
    });
  }
  const slotIdsInManifest = (baseManifest.slots || []).map((slot) => slot.slotId).sort();
  const slotIdsInDoc = slotsDoc ? slotsDoc.slots.map((slot) => slot.slotId).sort() : [];
  const missingSlotDocs = slotIdsInManifest.filter((slotId) => !slotIdsInDoc.includes(slotId));
  if (missingSlotDocs.length) {
    gaps.push({
      code: 'BASE_SLOTS_DOC_GAP',
      severity: 'warning',
      message: 'slots.json 人类可读镜像缺少 Base Manifest 已声明的插槽',
      details: { missing: missingSlotDocs, sourceOfTruth: 'manifest.json#slots' },
    });
  }
  componentCards.forEach((card) => {
    if (card.source.registryMirror && !card.source.registryMirror.sameImplementation) {
      gaps.push({
        code: 'UI_BLOCK_SOURCE_MIRROR_DRIFT',
        severity: 'error',
        message: '已登记 UI Block 与 Base 同名组件实现不一致',
        details: { id: card.id, mirror: card.source.registryMirror },
      });
    }
  });
  pageCards.forEach((card) => {
    card.slots.forEach((slot) => {
      if (!slot.anchorsPresent) {
        gaps.push({
          code: 'PAGE_SLOT_ANCHOR_INVALID',
          severity: 'error',
          message: '页面插槽锚点缺失或重复',
          details: { pageId: card.pageId, slotId: slot.slotId, anchorCounts: slot.anchorCounts },
        });
      }
    });
  });

  const errors = gaps.filter((gap) => gap.severity === 'error');
  if (errors.length) {
    throw new Error('CATALOG_INVALID\n' + errors.map((gap) => gap.code + ': ' + gap.message + ' ' + JSON.stringify(gap.details)).join('\n'));
  }

  const categoryOrder = curation.categories.map((category) => category.id);
  const orderedCards = componentCards.slice().sort((a, b) => {
    const categoryDelta = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    return categoryDelta === 0 ? a.id.localeCompare(b.id) : categoryDelta;
  });
  const componentsIndex = orderedCards.map((card) => ({
    id: card.id,
    version: card.version,
    displayName: card.displayName,
    category: card.category,
    sourceKind: card.sourceKind,
    summary: card.summary,
    card: 'components/' + card.id + '.json',
    props: card.interface.props.map((prop) => prop.name),
    requiredProps: card.interface.props.filter((prop) => prop.required).map((prop) => prop.name),
    events: card.interface.events.map((event) => event.name),
    pages: card.pages,
    slots: card.slots,
    runtimeMode: card.runtime.mode,
    registryAsset: card.source.registryAsset ? card.source.registryAsset.id + '@' + card.source.registryAsset.version : null,
  }));
  const categories = curation.categories.map((category) => ({
    id: category.id,
    displayName: category.displayName,
    description: category.description,
    componentCount: orderedCards.filter((card) => card.category === category.id).length,
  }));
  const counts = {
    components: orderedCards.length,
    baseBuiltins: baseComponentIds.length,
    registryUiBlocks: uiBlocks.length,
    featureComponents: featurePacks.length,
    pages: pageCards.length,
    layouts: layoutCards.length,
    sections: sectionResult.total,
    errors: errors.length,
    warnings: gaps.length - errors.length,
  };

  const index = {
    schemaVersion: 'component-catalog.v1',
    catalogVersion: CATALOG_VERSION,
    generatedFrom: {
      base: { id: baseManifest.identity.id, version: baseManifest.identity.version, root: repoRelative(BASE_SRC), digest: treeSha256(BASE_SRC) },
      registryVersion: loaded.registry.registryVersion,
      sourceOfTruth: 'templates/base/** + templates/registry/registry.v1.json + templates/{components,features,frontend-packs}/**',
      curation: repoRelative(CURATION_FILE),
    },
    readOrder: [
      '先读本索引：按 category、props、events、pages、slots 选择候选组件。',
      '再读 components/<id>.json：核对完整 props/events、默认值、数据字段、约束与 WXML 示例。',
      '需要页面装配关系时读 pages/<pageId>.json：区块、插槽、控制器方法与页面 JSON。',
      '需要换一套页面布局时读 layouts/<packId>@<version>.json：区块顺序、插槽锚点与组件归属。',
      '需要按区块复用视图时读 sections/<layoutId>@<version>/<pageId>/index.json：FrontendPack 页面与 Base 原始页面都投影为区块，每个区块含 WXML 片段、样式规则、组件绑定、控制器方法与复用等级。',
      '写 Plan/Recipe 前先读 source.files 与 runtime.mode：Base 内置组件不可被 Plan.components 复制或替换。',
      '提交前运行 node scripts/component-catalog.cjs --check，禁止手改 catalog 生成物。'
    ],
    counts,
    categories,
    components: componentsIndex,
    pages: pageCards.map((card) => ({
      pageId: card.pageId,
      title: card.title,
      audience: card.audience,
      required: card.required,
      summary: card.summary,
      card: 'pages/' + card.pageId + '.json',
      components: card.components.map((item) => item.componentId),
      slots: card.slots.map((slot) => slot.slotId),
    })),
    layouts: layoutCards.map((card) => ({
      id: card.id,
      version: card.version,
      displayName: card.displayName,
      summary: card.summary,
      card: 'layouts/' + card.id + '@' + card.version + '.json',
      pages: card.pages.map((page) => page.pageId),
      requiresSlots: card.requiresSlots,
    })),
    sections: sectionResult.pages,
    gaps,
    runtimeNotes: [
      'Base 内置组件是页面固定结构，Plan.components 当前不会复制或替换同名组件。',
      'templates/components/ 下 3 个 UI Block 与 Base 同名组件共享实现，但当前只用于契约、预览与边界校验。',
      '可运行时注入的组件是 Feature Pack：通过 features[].slots[] 进入导出工程。',
      '改写页面布局只能通过 FrontendPack 的 WXML/WXSS/页面 JSON，不得生成 JS。',
      'sections/*.json 是页面区块投影：FrontendPack 覆盖的页面 pageSource=frontend-pack-page，Base 原始页面 pageSource=base-page，后者是改写该页视图前的参考实现。',
      '提升为 UI Block 前必须按组件入库标准登记，并在 Base 页面 usingComponents 声明后才能进入页面。'
    ],
  };
  cardsByKey.set('index.json', index);
  return { index, cardsByKey, counts, gaps };
}

function listGeneratedFiles() {
  const files = [];
  ['components', 'pages', 'layouts'].forEach((group) => {
    const dir = path.join(CATALOG_ROOT, group);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).forEach((entry) => {
      files.push(group + '/' + entry.name);
    });
  });
  const sectionsRoot = path.join(CATALOG_ROOT, 'sections');
  if (fs.existsSync(sectionsRoot)) {
    walk(sectionsRoot).forEach((file) => files.push(toPosix(path.relative(CATALOG_ROOT, file))));
  }
  files.push('index.json');
  return files.sort();
}

function writeAll(result) {
  ['components', 'pages', 'layouts', 'sections'].forEach((group) => {
    fs.mkdirSync(path.join(CATALOG_ROOT, group), { recursive: true });
  });
  const expected = new Set(result.cardsByKey.keys());
  listGeneratedFiles().forEach((relative) => {
    if (relative === 'index.json') return;
    if (!expected.has(relative)) fs.unlinkSync(path.join(CATALOG_ROOT, relative));
  });
  [...result.cardsByKey.keys()].sort().forEach((relative) => {
    const file = path.join(CATALOG_ROOT, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json(result.cardsByKey.get(relative)), 'utf8');
  });
  console.log('组件目录已生成：' + result.counts.components + ' 个组件 / ' +
    result.counts.pages + ' 个页面 / ' + result.counts.layouts + ' 个布局 / ' +
    result.counts.sections + ' 个区块；gap ' + result.gaps.length + ' 项');
}

function checkAll(result) {
  const failures = [];
  const existing = listGeneratedFiles();
  const expected = new Set(result.cardsByKey.keys());
  existing.forEach((relative) => {
    if (!expected.has(relative)) failures.push('多余文件：' + relative);
  });
  [...result.cardsByKey.keys()].sort().forEach((relative) => {
    const file = path.join(CATALOG_ROOT, relative);
    if (!fs.existsSync(file)) {
      failures.push('缺少文件：' + relative);
      return;
    }
    const actual = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const want = json(result.cardsByKey.get(relative)).replace(/\r\n/g, '\n');
    if (actual !== want) failures.push('内容漂移：' + relative + '（运行 --write 重新生成）');
  });
  if (failures.length) {
    failures.forEach((failure) => console.error('  ✗ ' + failure));
    console.error('组件目录校验失败：' + failures.length + ' 项');
    return false;
  }
  console.log('组件目录校验通过：' + result.counts.components + ' 个组件 / ' +
    result.counts.pages + ' 个页面 / ' + result.counts.layouts + ' 个布局 / ' +
    result.counts.sections + ' 个区块；' +
    'gap ' + result.gaps.length + ' 项（' + result.counts.errors + ' error / ' + result.counts.warnings + ' warning）');
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check') || !write;
  if (!write && !check) {
    console.error('用法：node scripts/component-catalog.cjs --write|--check');
    process.exit(2);
  }
  let result;
  try {
    result = buildAll();
  } catch (error) {
    console.error('  ✗ ' + error.message);
    process.exit(1);
  }
  if (write) writeAll(result);
  if (check) {
    const ok = checkAll(result);
    if (!ok) process.exit(1);
  }
}

main();