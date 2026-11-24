'use strict';

/**
 * C3：Composer 私有 workspace/source overlay（frontend-source-bundle.v1）。
 *
 * 输入契约（overlayRoot = `<userData>/projects/<id>/agent-workspace/versions/<v>/source`
 * 或 attempt candidate 树；必须由主进程派生，调用方不得传任意绝对路径给模型）：
 *
 *   <overlayRoot>/source-bundle.json
 *   {
 *     "schemaVersion": "frontend-source-bundle.v1",
 *     "base": { "id": "ordering-base", "version": "1.0.0", "treeSha256": "sha256:..." },
 *     "targetPages": ["menu"],
 *     "files": [
 *       { "path": "pages/menu/index.wxml", "sha256": "sha256:..." },
 *       { "path": "components/product-card/index.wxml", "sha256": "sha256:..." }
 *     ],
 *     "deleted": ["assets/tabbar/unused.png"],
 *     "components": [
 *       { "componentId": "product-card", "scope": "page", "pages": ["menu"] },
 *       { "componentId": "menu-badge", "scope": "shared" }
 *     ],
 *     "assets": ["assets/frontend-source/menu-hero.png"]
 *   }
 *
 * 语义：
 * - files 是**最终完整文件**，直接覆盖 Base（不做 WXML 替换/WXSS 追加，没有 styleMode）；
 * - components.scope=page（默认）：把 Base 组件四件套复制为确定性页面变体
 *   `components/<id>--<page>`，只改该页 usingComponents；scope=shared：直接覆盖共享组件，
 *   并报告所有受影响页面；
 * - 新增组件必须四件套齐全；assets 仅接受 png/jpeg/webp（魔数校验），拒绝绝对路径/URL/穿越；
 * - deleted 只允许 assets/**，且不得删除页面四件套；
 * - usingComponents 由最终 WXML 重算，不残留旧声明、不漏新组件；
 * - 已分配插槽（Plan features）在最终 WXML 中缺锚点 → `SLOT_REQUIRED_BY_PLAN` 阻断。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { treeSha256 } = require('./digest.cjs');

const SCHEMA_VERSION = 'frontend-source-bundle.v1';
const MANIFEST_NAME = 'source-bundle.json';
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS = 20;

const PAGE_EXTENSIONS = Object.freeze(['js', 'json', 'wxml', 'wxss', 'wxs']);
const COMPONENT_EXTENSIONS = Object.freeze(['js', 'json', 'wxml', 'wxss', 'wxs']);
const IMAGE_TYPES = Object.freeze({
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  webp: { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
});

const BUILTIN_TAGS = new Set([
  'view', 'text', 'image', 'button', 'input', 'scroll-view', 'swiper', 'swiper-item', 'form', 'label',
  'picker', 'textarea', 'checkbox', 'checkbox-group', 'radio', 'radio-group', 'navigator', 'icon', 'progress',
  'slider', 'switch', 'rich-text', 'canvas', 'video', 'map', 'web-view', 'movable-area', 'movable-view',
  'cover-view', 'cover-image', 'open-data', 'official-account', 'functional-page-navigator', 'ad', 'ad-custom',
  'page-meta', 'navigation-bar', 'slot', 'template', 'block', 'wxs', 'import', 'include',
  'editor', 'keyboard-accessory', 'match-media', 'page-container', 'root-portal', 'share-element', 'voip-room',
]);

function fail(code, field, message, details) {
  return { ok: false, code, field, message, ...(details || {}) };
}

function ok(extra) {
  return Object.assign({ ok: true }, extra || {});
}

function canonicalRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 240) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (!/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)) return null;
  return value;
}

function samePath(a, b) {
  return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase()
    === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
}

function isInsideOrEqual(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Windows 上 `realpathSync` 对 junction 返回链接自身，`realpathSync.native` 才解析到目标。
 * 这里统一用 native（存在时），否则退回普通实现。
 */
function resolveRealPath(target) {
  if (typeof fs.realpathSync.native === 'function') return fs.realpathSync.native(target);
  return fs.realpathSync(target);
}

/**
 * 逐段拒绝 reparse：junction 的 lstat 是普通目录（isSymbolicLink=false），
 * 因此每一级都必须 realpath 后与词法路径相等；文件级再确认仍在 realRoot 内。
 * 返回 {ok:true} | {ok:false, reason:'missing'|'link'|'reparse'|'escape'|'not-file'}
 */
function inspectOverlayPath(realRoot, relative) {
  const segments = relative.split('/');
  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      return { ok: false, reason: 'missing' };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: 'link' };
    let real;
    try {
      real = resolveRealPath(current);
    } catch (error) {
      return { ok: false, reason: 'missing' };
    }
    // 中间目录为 junction/reparse 时 realpath 会指向别处，即使仍在根内也拒绝。
    if (!samePath(real, current)) return { ok: false, reason: 'reparse' };
  }
  const finalReal = resolveRealPath(current);
  if (!isInsideOrEqual(realRoot, finalReal)) return { ok: false, reason: 'escape' };
  if (!fs.lstatSync(current).isFile()) return { ok: false, reason: 'not-file' };
  return { ok: true };
}

function normalizedSha(buffer) {
  const text = /\.(js|json|wxml|wxss|wxs|txt|md)$/i.test('') ? buffer : buffer;
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

function fileSha256(file) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function detectImageType(buffer) {
  for (const [extension, type] of Object.entries(IMAGE_TYPES)) {
    if (type.magic.every((byte, index) => buffer[index] === byte)) return { extension, mime: type.mime };
  }
  return null;
}

function collectUsedTags(wxml) {
  const tags = new Set();
  const pattern = /<([a-z][a-z0-9-]*)[\s/>]/g;
  let match = pattern.exec(String(wxml || ''));
  while (match) {
    tags.add(match[1]);
    match = pattern.exec(String(wxml || ''));
  }
  return tags;
}

function hasSlotAnchors(wxml, slotId) {
  const anchors = [
    '<!-- @slot:' + slotId + ' -->',
    '<!-- @slot-fallback:' + slotId + ' -->',
    '<!-- @slot-fallback:' + slotId + ':end -->',
    '<!-- @slot:' + slotId + ':end -->',
  ];
  return anchors.every((anchor) => String(wxml).split(anchor).length - 1 === 1);
}

/**
 * 读取并校验 overlay。
 * @param {object} graph resolvePlan 的结果（需要 baseSrc / pageIds / assignments）
 * @param {string|{root:string}} input 私有 overlay 根（绝对路径，由主进程派生）
 */
function loadSourceOverlay(graph, input) {
  const root = typeof input === 'string' ? input : (input && input.root);
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return fail('SOURCE_OVERLAY_ROOT_INVALID', 'sourceOverlay', 'overlay 根必须是主进程派生的绝对目录');
  }
  let stats;
  try {
    stats = fs.lstatSync(root);
  } catch (error) {
    return fail('SOURCE_OVERLAY_MISSING', 'sourceOverlay', 'overlay 目录不存在');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return fail('SOURCE_OVERLAY_ROOT_INVALID', 'sourceOverlay', 'overlay 根必须是真实目录（拒绝链接）');
  }
  const lexicalRoot = path.resolve(root);
  let realRoot;
  try {
    realRoot = resolveRealPath(root);
  } catch (error) {
    return fail('SOURCE_OVERLAY_ROOT_INVALID', 'sourceOverlay', 'overlay 根无法解析');
  }
  // junction 的 lstat 是普通目录，必须用 realpath 与词法根对比；不相等即 reparse。
  if (!samePath(realRoot, lexicalRoot)) {
    return fail('SOURCE_OVERLAY_ROOT_INVALID', 'sourceOverlay', 'overlay 根是链接/junction（reparse），拒绝读取');
  }
  const manifestInspection = inspectOverlayPath(realRoot, MANIFEST_NAME);
  if (!manifestInspection.ok) {
    if (manifestInspection.reason === 'missing') {
      return fail('SOURCE_BUNDLE_MANIFEST_MISSING', MANIFEST_NAME, '缺少 source-bundle.json');
    }
    return fail('SOURCE_OVERLAY_PATH_INVALID', MANIFEST_NAME, 'source-bundle.json 路径经过链接/junction，拒绝读取');
  }
  const manifestFile = path.join(realRoot, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return fail('SOURCE_BUNDLE_MANIFEST_INVALID', MANIFEST_NAME, 'source-bundle.json 解析失败：' + error.message);
  }
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) {
    return fail('SOURCE_BUNDLE_MANIFEST_INVALID', MANIFEST_NAME, 'schemaVersion 必须为 ' + SCHEMA_VERSION);
  }
  const base = manifest.base;
  if (!base || typeof base !== 'object' || base.id !== graph.base.id || base.version !== graph.base.version) {
    return fail('SOURCE_BUNDLE_BASE_MISMATCH', 'base', 'overlay 的 Base 身份与当前 Composer Base 不一致');
  }
  const actualBaseTree = treeSha256(graph.baseSrc);
  if (base.treeSha256 !== actualBaseTree) {
    return fail('SOURCE_BUNDLE_BASE_MISMATCH', 'base.treeSha256', 'overlay 基于的 Base 源树摘要不一致，拒绝用旧底稿覆盖', {
      expected: actualBaseTree,
      actual: typeof base.treeSha256 === 'string' ? base.treeSha256 : null,
    });
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'files', 'files 必须是非空数组');
  }
  const seen = new Set();
  const files = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object') return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'files', 'files 项必须是对象');
    const relative = canonicalRelative(entry.path);
    if (!relative) return fail('SOURCE_BUNDLE_PATH_INVALID', 'files.path', '文件路径必须是规范相对路径', { path: String(entry.path || '') });
    if (seen.has(relative)) return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'files.path', '文件路径重复：' + relative);
    seen.add(relative);
    const segments = relative.split('/');
    const top = segments[0];
    if (!['pages', 'components', 'assets'].includes(top)) {
      return fail('SOURCE_BUNDLE_PATH_FORBIDDEN', 'files.path', 'overlay 只允许 pages/components/assets：' + relative);
    }
    const extension = path.posix.extname(relative).slice(1).toLowerCase();
    const allowed = top === 'assets' ? Object.keys(IMAGE_TYPES) : (top === 'pages' ? PAGE_EXTENSIONS : COMPONENT_EXTENSIONS);
    if (!allowed.includes(extension)) {
      return fail('SOURCE_BUNDLE_FILE_TYPE_FORBIDDEN', 'files.path', '不允许的文件类型：' + relative);
    }
    const inspection = inspectOverlayPath(realRoot, relative);
    if (!inspection.ok) {
      if (inspection.reason === 'missing') {
        return fail('SOURCE_BUNDLE_FILE_MISSING', 'files.path', 'overlay 声明了不存在的文件：' + relative);
      }
      return fail('SOURCE_OVERLAY_PATH_INVALID', 'files.path', 'overlay 路径经过链接/junction 或越界，拒绝读取：' + relative, {
        reason: inspection.reason,
      });
    }
    const absolute = path.join(realRoot, relative);
    const buffer = fs.readFileSync(absolute);
    const actualSha = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
    if (entry.sha256 !== actualSha) {
      return fail('SOURCE_BUNDLE_FILE_HASH_MISMATCH', 'files.sha256', '文件摘要与声明不一致：' + relative, {
        expected: entry.sha256 || null,
        actual: actualSha,
      });
    }
    if (top === 'assets') {
      if (buffer.length > MAX_ASSET_BYTES) return fail('SOURCE_BUNDLE_ASSET_TOO_LARGE', relative, '资产超过 2 MiB');
      const image = detectImageType(buffer);
      if (!image || image.extension !== extension) {
        return fail('SOURCE_BUNDLE_ASSET_TYPE_INVALID', relative, '资产魔数与扩展名不一致（仅 png/jpeg/webp）');
      }
    }
    files.push({ path: relative, buffer, sha256: actualSha });
  }
  if (files.filter((item) => item.path.startsWith('assets/')).length > MAX_ASSETS) {
    return fail('SOURCE_BUNDLE_ASSET_COUNT_EXCEEDED', 'assets', '资产数量超过 ' + MAX_ASSETS);
  }

  const deleted = [];
  if (manifest.deleted !== undefined) {
    if (!Array.isArray(manifest.deleted)) return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'deleted', 'deleted 必须是数组');
    const deletedSeen = new Set();
    for (const raw of manifest.deleted) {
      const relative = canonicalRelative(raw);
      if (!relative) return fail('SOURCE_BUNDLE_PATH_INVALID', 'deleted', '删除路径必须是规范相对路径');
      if (deletedSeen.has(relative)) return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'deleted', '删除路径重复');
      deletedSeen.add(relative);
      if (!relative.startsWith('assets/')) {
        return fail('SOURCE_BUNDLE_DELETE_FORBIDDEN', 'deleted', '只允许删除 assets/ 下的文件：' + relative);
      }
      if (!seen.has(relative) && !fs.existsSync(path.join(realRoot, relative))) {
        return fail('SOURCE_BUNDLE_DELETE_FORBIDDEN', 'deleted', '删除目标必须来自 Base 或 overlay：' + relative);
      }
      deleted.push(relative);
    }
  }

  const components = [];
  if (manifest.components !== undefined) {
    if (!Array.isArray(manifest.components)) return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'components', 'components 必须是数组');
    const componentIds = new Set();
    for (const entry of manifest.components) {
      if (!entry || typeof entry !== 'object') return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'components', 'components 项必须是对象');
      const componentId = typeof entry.componentId === 'string' ? entry.componentId : '';
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(componentId)) {
        return fail('SOURCE_BUNDLE_COMPONENT_INVALID', 'components.componentId', '组件 id 非法');
      }
      if (componentIds.has(componentId)) return fail('SOURCE_BUNDLE_COMPONENT_INVALID', 'components.componentId', '组件重复：' + componentId);
      componentIds.add(componentId);
      const scope = entry.scope === undefined ? 'page' : entry.scope;
      if (scope !== 'page' && scope !== 'shared') {
        return fail('SOURCE_BUNDLE_COMPONENT_INVALID', 'components.scope', 'scope 只能是 page/shared');
      }
      let pages = [];
      if (scope === 'page') {
        if (!Array.isArray(entry.pages) || entry.pages.length === 0) {
          return fail('SOURCE_BUNDLE_COMPONENT_SCOPE_REQUIRED', 'components.pages', 'page-scoped 组件必须声明受影响页面');
        }
        for (const pageId of entry.pages) {
          if (typeof pageId !== 'string' || !graph.pageIds.includes(pageId)) {
            return fail('SOURCE_BUNDLE_COMPONENT_SCOPE_REQUIRED', 'components.pages', '页面不在当前 Plan：' + String(pageId));
          }
        }
        pages = [...new Set(entry.pages)].sort();
      }
      components.push({ componentId, scope, pages });
    }
  }

  if (!Array.isArray(manifest.targetPages) && !manifest.targetPage) {
    return fail('SOURCE_BUNDLE_TARGET_PAGE_REQUIRED', 'targetPages', '必须声明 targetPage 或 targetPages');
  }
  const targetPages = [...new Set(Array.isArray(manifest.targetPages)
    ? manifest.targetPages
    : [manifest.targetPage])];
  for (const pageId of targetPages) {
    if (typeof pageId !== 'string' || !graph.pageIds.includes(pageId)) {
      return fail('SOURCE_BUNDLE_TARGET_PAGE_REQUIRED', 'targetPages', '目标页不在当前 Plan：' + String(pageId));
    }
  }
  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets)) return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'assets', 'assets 必须是数组');
    for (const assetPath of manifest.assets) {
      if (!files.some((file) => file.path === assetPath)) {
        return fail('SOURCE_BUNDLE_ASSET_MISSING', 'assets', 'assets 声明的文件未在 files 中：' + String(assetPath));
      }
    }
  }

  // overlay 摘要：路径+sha 排序后取摘要；不包含时间/绝对路径。
  const digest = 'sha256:' + crypto.createHash('sha256')
    .update(files.map((file) => file.path + ':' + file.sha256).sort().join('\n'))
    .digest('hex');

  return ok({
    bundle: {
      root: realRoot,
      manifestDigest: digest,
      base: { id: base.id, version: base.version, treeSha256: actualBaseTree },
      targetPages,
      files,
      deleted,
      components,
      digest,
      schemaVersion: SCHEMA_VERSION,
    },
  });
}

function baseComponentFiles(files, componentId) {
  const prefix = 'components/' + componentId + '/';
  const found = new Map();
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) found.set(key.slice(prefix.length), files.get(key));
  }
  return found;
}

function pageJsonOf(files, pageId) {
  const key = 'pages/' + pageId + '/index.json';
  const buffer = files.get(key);
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return null;
  }
}

function writePageJson(files, pageId, document) {
  files.set('pages/' + pageId + '/index.json', Buffer.from(JSON.stringify(document, null, 2) + '\n', 'utf8'));
}

/**
 * 应用 overlay 到内存 files（Base 文件图）。返回页面变体映射，供 usingComponents 重算使用。
 */
function applySourceOverlay(files, graph, bundle) {
  if (!bundle || bundle.schemaVersion !== SCHEMA_VERSION) {
    return fail('SOURCE_BUNDLE_MANIFEST_INVALID', 'sourceOverlay', 'overlay bundle 无效');
  }
  const pageIds = new Set(graph.pageIds);
  const componentScopes = new Map(bundle.components.map((item) => [item.componentId, item]));

  // 删除（只允许 assets/**，先删再写，便于替换同名资产）
  for (const relative of bundle.deleted) files.delete(relative);

  const variantComponents = new Map(); // componentId -> { dir, pages }
  const pageTagPaths = new Map(); // pageId -> Map(tag, path)

  function registerPageTag(pageId, tag, target) {
    if (!pageTagPaths.has(pageId)) pageTagPaths.set(pageId, new Map());
    pageTagPaths.get(pageId).set(tag, target);
  }

  for (const file of bundle.files) {
    const segments = file.path.split('/');
    if (segments[0] === 'pages') {
      const pageId = segments[1];
      if (!pageIds.has(pageId)) return fail('SOURCE_BUNDLE_PAGE_NOT_IN_PLAN', file.path, '页面不在 Plan：' + pageId);
      if (segments[2] === 'index.json') {
        try {
          JSON.parse(file.buffer.toString('utf8'));
        } catch (error) {
          return fail('SOURCE_OVERLAY_PAGE_JSON_INVALID', file.path, '页面 JSON 无法解析');
        }
      }
      files.set(file.path, Buffer.from(file.buffer));
      continue;
    }
    if (segments[0] === 'assets') {
      files.set(file.path, Buffer.from(file.buffer));
      continue;
    }
    // components/**
    const componentId = segments[1];
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(componentId)) {
      return fail('SOURCE_BUNDLE_COMPONENT_INVALID', file.path, '组件 id 非法');
    }
    const relativeInside = file.path.slice(('components/' + componentId + '/').length);
    const baseFiles = baseComponentFiles(files, componentId);
    const scopeEntry = componentScopes.get(componentId);
    const isNew = baseFiles.size === 0;
    if (!scopeEntry) {
      if (bundle.targetPages.length !== 1) {
        return fail('SOURCE_BUNDLE_COMPONENT_SCOPE_REQUIRED', file.path, '组件必须声明 page/shared 范围');
      }
      componentScopes.set(componentId, { componentId, scope: 'page', pages: [...bundle.targetPages] });
    }
    const scope = componentScopes.get(componentId);
    if (scope.scope === 'shared') {
      if (isNew) {
        const required = ['index.js', 'index.json', 'index.wxml', 'index.wxss'];
        const present = new Set(bundle.files.filter((item) => item.path.startsWith('components/' + componentId + '/')).map((item) => item.path.slice(('components/' + componentId + '/').length)));
        for (const name of required) {
          if (!present.has(name)) return fail('SOURCE_BUNDLE_COMPONENT_INCOMPLETE', file.path, '新增共享组件缺少四件套：' + name);
        }
      }
      files.set(file.path, Buffer.from(file.buffer));
      continue;
    }
    // page-scoped：Base 组件四件套复制到确定性变体目录，再覆盖
    const variantDir = 'components/' + componentId + '--' + scope.pages[0];
    // 同一组件在不同页面的变体各自独立；这里按 (component,page) 展开。
    for (const pageId of scope.pages) {
      const targetDir = 'components/' + componentId + '--' + pageId;
      if (!variantComponents.has(targetDir)) {
        for (const [name, content] of baseFiles) {
          files.set(targetDir + '/' + name, Buffer.from(content));
        }
        variantComponents.set(targetDir, { componentId, pageId });
      }
      files.set(targetDir + '/' + relativeInside, Buffer.from(file.buffer));
      registerPageTag(pageId, componentId, '/' + targetDir + '/index');
    }
    void variantDir;
  }

  // 变体四件套完整性（新增组件或 Base 缺文件）
  for (const [dir, info] of variantComponents) {
    for (const name of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
      if (!files.has(dir + '/' + name)) {
        return fail('SOURCE_BUNDLE_COMPONENT_INCOMPLETE', dir, '页面变体组件缺少四件套：' + name, { pageId: info.pageId });
      }
    }
    try {
      JSON.parse(files.get(dir + '/index.json').toString('utf8'));
    } catch (error) {
      return fail('SOURCE_BUNDLE_COMPONENT_JSON_INVALID', dir + '/index.json', '组件 JSON 无法解析');
    }
  }

  // 新共享组件四件套
  for (const [componentId, scope] of componentScopes) {
    if (scope.scope !== 'shared') continue;
    const dir = 'components/' + componentId;
    if (baseComponentFiles(files, componentId).size === 0) {
      return fail('SOURCE_BUNDLE_COMPONENT_INCOMPLETE', dir, '新增共享组件缺少文件');
    }
  }

  // 页面 WXML 新标签校验：只校验 overlay 改过的页面，避免改变旧链行为。
  for (const file of bundle.files) {
    if (!file.path.startsWith('pages/') || !file.path.endsWith('.wxml')) continue;
    const pageId = file.path.split('/')[1];
    const baseJson = pageJsonOf(files, pageId) || {};
    const declared = baseJson.usingComponents || {};
    const wxml = files.get(file.path).toString('utf8');
    for (const tag of collectUsedTags(wxml)) {
      if (BUILTIN_TAGS.has(tag) || declared[tag]) continue;
      if (pageTagPaths.get(pageId) && pageTagPaths.get(pageId).has(tag)) continue;
      const sharedLooksLikeComponent = files.has('components/' + tag + '/index.json');
      if (sharedLooksLikeComponent) continue;
      return fail('SOURCE_OVERLAY_COMPONENT_UNKNOWN', file.path, 'WXML 使用了未声明的组件：' + tag, { pageId, tag });
    }
  }

  // 页面变体 usingComponents 先写入；最终统一重算会保留/清理。
  for (const [pageId, tagPaths] of pageTagPaths) {
    const document = pageJsonOf(files, pageId);
    if (!document) return fail('SOURCE_OVERLAY_PAGE_JSON_INVALID', 'pages/' + pageId + '/index.json', '页面 JSON 无法解析');
    document.usingComponents = { ...(document.usingComponents || {}) };
    for (const [tag, target] of tagPaths) document.usingComponents[tag] = target;
    writePageJson(files, pageId, document);
  }

  // 已分配插槽缺失必须阻断（除非用户显式移除功能；C3 只支持阻断）。
  for (const key of graph.assignments.keys()) {
    const [pageId, slotId] = key.split('#');
    const wxmlBuffer = files.get('pages/' + pageId + '/index.wxml');
    if (!wxmlBuffer) continue;
    const touched = bundle.files.some((file) => file.path === 'pages/' + pageId + '/index.wxml');
    if (!touched) continue;
    if (!hasSlotAnchors(wxmlBuffer.toString('utf8'), slotId)) {
      return fail('SLOT_REQUIRED_BY_PLAN', 'pages/' + pageId + '/index.wxml', 'Plan 已为该页分配功能插槽，overlay 不得删除锚点：' + slotId, { pageId, slotId });
    }
  }

  // shared 组件受影响页面：最终所有页面里实际使用该 tag 的页面。
  const sharedImpacts = [];
  for (const [componentId, scope] of componentScopes) {
    if (scope.scope !== 'shared') continue;
    const affected = [];
    for (const pageId of graph.pageIds) {
      const wxml = files.get('pages/' + pageId + '/index.wxml');
      if (wxml && collectUsedTags(wxml.toString('utf8')).has(componentId)) affected.push(pageId);
    }
    sharedImpacts.push({ componentId, pages: affected.sort() });
  }

  return ok({
    pageTagPaths,
    componentScopes: [...componentScopes.values()].map((item) => ({
      componentId: item.componentId,
      scope: item.scope,
      pages: item.scope === 'shared'
        ? (sharedImpacts.find((impact) => impact.componentId === item.componentId) || { pages: [] }).pages
        : item.pages,
    })),
    sharedImpacts,
    targetPages: bundle.targetPages,
    digest: bundle.digest,
    variantDirs: [...variantComponents.keys()].sort(),
  });
}

/**
 * 修复 pack `entry.assets` 复制：manifest.assets 相对 **pack 根**（asset.dir），不是 entry.path；
 * 目标保留相对子路径 `assets/<assetId>/<relative>`（旧 pack 的 entry.assets 为空，行为不变）。
 * 兼容说明：若 pack 根找不到文件，回落到 entry.path 下查找，并按旧行为只取 basename 落盘。
 */
function copyEntryAssets(asset, files, options) {
  const entryPath = asset.manifest && asset.manifest.entry ? asset.manifest.entry.path : '.';
  const entryDir = path.join(asset.dir, entryPath);
  const assetFiles = (asset.manifest && asset.manifest.entry && asset.manifest.entry.assets) || [];
  for (const raw of assetFiles) {
    const relative = canonicalRelative(raw);
    if (!relative) return fail('FEATURE_ASSET_PATH_INVALID', raw, 'entry.assets 必须是规范相对路径');
    const fromPack = path.join(asset.dir, relative);
    const fromEntry = path.join(entryDir, relative);
    const source = fs.existsSync(fromPack) ? fromPack : (fs.existsSync(fromEntry) ? fromEntry : null);
    if (!source) return fail('FEATURE_ASSET_MISSING', raw, '功能包资产不存在：' + raw);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return fail('FEATURE_ASSET_PATH_INVALID', raw, '功能包资产必须是普通文件');
    const stripped = relative.startsWith('assets/') ? relative.slice('assets/'.length) : relative;
    const target = source === fromPack
      ? 'assets/' + asset.id + '/' + stripped
      : 'assets/' + asset.id + '/' + path.posix.basename(relative);
    files.set(target, fs.readFileSync(source));
  }
  void options;
  return ok();
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_NAME,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  PAGE_EXTENSIONS,
  COMPONENT_EXTENSIONS,
  IMAGE_TYPES,
  BUILTIN_TAGS,
  canonicalRelative,
  detectImageType,
  fileSha256,
  collectUsedTags,
  hasSlotAnchors,
  loadSourceOverlay,
  applySourceOverlay,
  copyEntryAssets,
};
