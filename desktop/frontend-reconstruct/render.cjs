'use strict';

/**
 * 确定性 renderer：`frontend-pack-draft.v1` DSL → FrontendPack 视图文件。
 *
 * 设计约束：
 * - **纯函数**：输入 Draft + 注入事实 + 页面目录事实，输出文件 Map；不做 IO、不读时间/随机器；
 * - **确定性**：同一 DSL 重复渲染得到逐字节相同的文件与相同摘要（键排序、节点顺序、
 *   样式规则顺序全部固定，不写时间戳/绝对路径/随机数）；
 * - **只能产出视图三件套**：`pages/<pageId>/index.{wxml,wxss,json}` + `manifest.json`
 *   + `preview/{normal,empty,error,long}.json`；不产出 JS/WXS，不产出任意源码；
 * - **slot fallback 锚点**：每个 slot 节点都输出 Composer 要求的 4 个锚点且各恰好一次，
 *   内容为空（落位由 Composer 依据 Plan 注入），DSL 无法表达任意 WXML；
 * - 任何生成结果在返回前自检：不含 `<script|wxs|import|include>`、`eval/Function(`、
 *   外部 URL、反斜杠绝对路径；自检失败即整体失败（绝不返回可疑产物）。
 *
 * 只允许白名单样式属性；CSS 由本文件的档位表生成，DSL 里没有 WXSS 原文。
 *
 * 数据绑定映射（P2 repair-4）：DSL 的 `dataPath` 是 P1 规范化命名空间
 * （`home.mode` / `menu.products` / `cart.totalCents`），写进 WXML 前必须映射成 Base
 * 真实访问器（`mode` / `products` / `cartSummary.totalCents`）；未知根或未知 cart key
 * 直接 `RENDER_DATA_PATH_UNSUPPORTED`，绝不把规范 token 原样透传到运行时。
 */

const { sha256, normalizedText } = require('../../scripts/composer/digest.cjs');
const {
  validateDraft,
  LIMITS,
  SIZE_STEPS,
  LAYOUT_STYLE_KEYS,
  TEXT_STYLE_KEYS,
} = require('./schema.cjs');

const MANIFEST_SCHEMA_VERSION = 'frontend-pack.v1';
const PREVIEW_KINDS = Object.freeze(['normal', 'empty', 'error', 'long']);
const CANDIDATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Base 已声明插槽；超出的插槽 Composer 会拒绝，renderer 提前失败。 */
const BASE_SLOT_IDS = Object.freeze(['home-hero', 'home-marketing', 'menu-aside', 'menu-hero']);

/** 主题 token → Base `theme.generated.wxss` 中的 CSS 变量（只读映射，不生成新变量）。 */
const THEME_CSS_VARS = Object.freeze({
  pageBackground: '--store-page-background',
  primaryColor: '--store-primary-color',
  accentColor: '--store-accent-color',
  textColor: '--store-text-color',
  tabBarBackground: '--store-tab-bar-background',
  tabBarColor: '--store-tab-bar-color',
  tabBarSelectedColor: '--store-tab-bar-selected-color',
});

/** 档位 → rpx 值；只允许这些固定档位，不接受任意 px/rpx。 */
const SPACE_SCALE = Object.freeze({ none: 0, xs: 8, sm: 12, md: 16, lg: 24, xl: 32 });
const RADIUS_SCALE = Object.freeze({ none: 0, sm: 8, md: 16, lg: 24, full: 999 });
const FONT_SIZE_SCALE = Object.freeze({ sm: 24, md: 28, lg: 36 });

/**
 * P1 规范 `cart.*` → Base 页面真实访问器（menu 控制器 data 字段 `cartSummary`）。
 * 只允许这三个 key；其余 cart key 一律 RENDER_DATA_PATH_UNSUPPORTED。
 */
const CART_DATA_PATH_MAP = Object.freeze({
  items: 'cartSummary.items',
  totalCents: 'cartSummary.totalCents',
  count: 'cartSummary.totalQuantity',
});
const ALIGN_VALUES = Object.freeze({ start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' });
const JUSTIFY_VALUES = Object.freeze({
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
});

/** FrontendPack 页面 JSON 允许的键（与 `scripts/composer/schema.cjs` 白名单一致）。 */
const PACK_PAGE_JSON_KEYS = Object.freeze([
  'navigationBarTitleText',
  'enablePullDownRefresh',
  'backgroundColor',
]);

const FORBIDDEN_OUTPUT_PATTERNS = Object.freeze([
  { code: 'RENDER_SCRIPT_FORBIDDEN', pattern: /<(script|wxs|import|include)[\s>]/i },
  { code: 'RENDER_SCRIPT_FORBIDDEN', pattern: /\b(eval|Function)\s*\(/ },
  { code: 'RENDER_EXTERNAL_URL', pattern: /url\(\s*['"]?(?:https?:)?\/\//i },
  { code: 'RENDER_EXTERNAL_URL', pattern: /https?:\/\//i },
  { code: 'RENDER_PATH_FORBIDDEN', pattern: /[A-Za-z]:\\/ },
  { code: 'RENDER_PATH_FORBIDDEN', pattern: /\\/ },
]);

function ok(extra) {
  return Object.assign({ ok: true }, extra);
}

function fail(code, path, message) {
  return { ok: false, code, path: path || '$', message };
}

/** 稳定序列化：对象键排序、无空白、数字用 JSON 形式；用于 Draft 摘要。 */
function stableStringify(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_TYPE:' + type);
}

/** Draft 摘要（与渲染出的文件内容解耦，可用于幂等复用与日志）。 */
function draftDigest(draft) {
  return sha256(stableStringify(draft));
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function escapeWxmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function camelToKebab(name) {
  return name.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
}

function tokenVar(token) {
  return 'var(' + THEME_CSS_VARS[token] + ')';
}

function cssRule(selector, declarations) {
  const lines = declarations.map(([property, value]) => '  ' + property + ': ' + value + ';');
  return selector + ' {\n' + lines.join('\n') + '\n}';
}

function containerDeclarations(style) {
  const declarations = [
    ['display', 'flex'],
    ['flex-direction', style && style.direction ? style.direction : 'column'],
    ['box-sizing', 'border-box'],
  ];
  declarations.push(['gap', (style && style.gap ? SPACE_SCALE[style.gap] : SPACE_SCALE.md) + 'rpx']);
  if (style && style.align) declarations.push(['align-items', ALIGN_VALUES[style.align]]);
  if (style && style.justify) declarations.push(['justify-content', JUSTIFY_VALUES[style.justify]]);
  if (style && style.padding !== undefined) declarations.push(['padding', SPACE_SCALE[style.padding] + 'rpx']);
  if (style && style.radius !== undefined) declarations.push(['border-radius', RADIUS_SCALE[style.radius] + 'rpx']);
  if (style && style.width !== undefined) {
    if (style.width === 'auto') declarations.push(['width', 'auto']);
    else if (style.width === 'full') declarations.push(['width', '100%']);
    else declarations.push(['width', style.width + 'rpx']);
  }
  if (style && style.minHeight !== undefined) declarations.push(['min-height', style.minHeight + 'rpx']);
  if (style && style.backgroundColorToken) declarations.push(['background', tokenVar(style.backgroundColorToken)]);
  if (style && style.borderColorToken) declarations.push(['border', '1rpx solid ' + tokenVar(style.borderColorToken)]);
  return declarations;
}

function textDeclarations(style, base) {
  const declarations = base ? base.slice() : [];
  if (style && style.size) declarations.push(['font-size', FONT_SIZE_SCALE[style.size] + 'rpx']);
  if (style && style.weight) declarations.push(['font-weight', String(style.weight)]);
  if (style && style.colorToken) declarations.push(['color', tokenVar(style.colorToken)]);
  return declarations;
}

/**
 * 规范 dataPath → Base 页面真实 WXML 数据访问器（P2 repair-4）。
 *
 * P1 快照的命名空间（`home.mode` / `menu.products` / `cart.totalCents`）是**契约层**抽象，
 * Base 页面的真实字段是另一套（`mode` / `products` / `cartSummary.totalCents`）。
 * 如果原样写进 WXML，微信运行时会绑定到 undefined；因此这一步必须由确定性 renderer 完成：
 * - `<pageId>.<key>` → `<key>`（home.mode→mode、menu.products→products、menu.tableName→tableName）
 * - `cart.items` → `cartSummary.items`
 * - `cart.totalCents` → `cartSummary.totalCents`
 * - `cart.count` → `cartSummary.totalQuantity`
 * - `store.*` 原样（Base 的 store 就是嵌套对象）
 * - 其它根（非本页/非 cart/store）或未知 cart key → RENDER_DATA_PATH_UNSUPPORTED，绝不静默透传。
 */
function toWxmlDataExpression(dataPath, pageId, dslPath) {
  const segments = String(dataPath).split('.');
  const root = segments[0];
  const rest = segments.slice(1).join('.');
  if (root === pageId && rest !== '') return rest;
  if (root === 'store') return String(dataPath);
  if (root === 'cart') {
    const mapped = CART_DATA_PATH_MAP[rest];
    if (mapped !== undefined) return mapped;
    throw new RenderError(
      'RENDER_DATA_PATH_UNSUPPORTED',
      dslPath || '$.dataPath',
      'cart 数据路径没有 Base 映射：' + dataPath,
    );
  }
  throw new RenderError(
    'RENDER_DATA_PATH_UNSUPPORTED',
    dslPath || '$.dataPath',
    '未知规范数据根（只允许本页/cart/store）：' + dataPath,
  );
}

function propAttributeValue(binding, pageId, dslPath) {
  if (binding.kind === 'data') {
    return '"{{' + toWxmlDataExpression(binding.dataPath, pageId, dslPath) + '}}"';
  }
  const value = binding.value;
  if (value === null) return '"{{null}}"';
  if (typeof value === 'boolean') return '"{{' + (value ? 'true' : 'false') + '}}"';
  if (typeof value === 'number') return '"{{' + String(value) + '}}"';
  return '"' + escapeWxmlAttribute(value) + '"';
}

function actionHandler(action) {
  return action.split('.')[1];
}

/** 还原节点的 DSL path（用于错误定位）：`$.pages[i].nodes[j].children[k]...`。 */
function nodeDslPath(context) {
  const [first, ...rest] = context.path;
  let out = context.pagePath + '.nodes[' + first + ']';
  for (const index of rest) out += '.children[' + index + ']';
  return out;
}

/**
 * 单页 WXML 渲染。
 * @returns {{ok:true, wxml:string, wxss:string, slots:string[], pageId:string}|{ok:false, ...}}
 */
function renderNode(node, context) {
  const { pageId, depth, path, lines, wxss, slots } = context;
  const indent = '  '.repeat(depth);
  const nodePath = path.join('-');

  if (node.type === 'component') {
    const attributes = ['class="fp-cand__component fp-cand__component-' + nodePath + '"'];
    for (const propName of Object.keys(node.props).sort()) {
      attributes.push(
        camelToKebab(propName) + '='
        + propAttributeValue(
          node.props[propName],
          pageId,
          nodeDslPath(context) + '.props.' + propName + '.dataPath',
        ),
      );
    }
    for (const eventName of Object.keys(node.events).sort()) {
      attributes.push('bind:' + eventName + '="' + escapeWxmlAttribute(actionHandler(node.events[eventName])) + '"');
    }
    lines.push(indent + '<' + node.componentId + ' ' + attributes.join(' ') + ' />');
    wxss.push(
      cssRule('.fp-cand__component-' + nodePath, [
        ['display', 'block'],
        ['width', '100%'],
      ]),
    );
    return;
  }

  if (node.type === 'slot') {
    if (!BASE_SLOT_IDS.includes(node.slotId)) {
      throw new RenderError('RENDER_SLOT_UNSUPPORTED', '$.slotId', '不支持的插槽：' + node.slotId);
    }
    slots.push(node.slotId);
    lines.push(indent + '<!-- @slot:' + node.slotId + ' -->');
    lines.push(indent + '<!-- @slot-fallback:' + node.slotId + ' -->');
    lines.push(indent + '<!-- @slot-fallback:' + node.slotId + ':end -->');
    lines.push(indent + '<!-- @slot:' + node.slotId + ':end -->');
    return;
  }

  if (node.type === 'container') {
    const className = 'fp-cand__box-' + nodePath;
    lines.push(indent + '<view class="' + className + '">');
    for (let index = 0; index < node.children.length; index += 1) {
      renderNode(node.children[index], {
        ...context,
        depth: depth + 1,
        path: path.concat(String(index)),
      });
    }
    lines.push(indent + '</view>');
    wxss.push(cssRule('.' + className, containerDeclarations(node.style)));
    return;
  }

  if (node.type === 'text') {
    const className = 'fp-cand__text-' + nodePath;
    const expression = toWxmlDataExpression(
      node.textToken,
      pageId,
      nodeDslPath(context) + '.textToken',
    );
    lines.push(indent + '<text class="' + className + '">{{' + expression + '}}</text>');
    if (node.style) wxss.push(cssRule('.' + className, textDeclarations(node.style)));
    return;
  }

  if (node.type === 'button') {
    const className = 'fp-cand__button-' + nodePath;
    lines.push(
      indent + '<button class="fp-cand__button ' + className + '" bind:tap="' + actionHandler(node.action) + '">'
      + escapeWxmlAttribute(node.label) + '</button>',
    );
    if (node.style) wxss.push(cssRule('.' + className, textDeclarations(node.style)));
    return;
  }

  throw new RenderError('RENDER_NODE_UNSUPPORTED', '$', '未知节点类型');
}

function renderPage(page, pageIndex) {
  const lines = [];
  const wxss = [];
  const slots = [];
  const context = {
    pageId: page.pageId,
    pagePath: '$.pages[' + pageIndex + ']',
    depth: 2,
    path: [],
    lines,
    wxss,
    slots,
  };
  lines.push('<view class="page fp-cand-page fp-cand-page--' + page.pageId + '">');
  lines.push('  <view class="fp-cand__root">');
  for (let index = 0; index < page.nodes.length; index += 1) {
    renderNode(page.nodes[index], { ...context, path: [String(index)] });
  }
  lines.push('  </view>');
  lines.push('</view>');

  const staticRules = [cssRule('.fp-cand__root', containerDeclarations(undefined))];
  if (page.nodes.some((node) => containsType(node, 'button'))) {
    staticRules.push(
      cssRule('.fp-cand__button', [
        ['display', 'flex'],
        ['align-items', 'center'],
        ['justify-content', 'center'],
        ['min-height', '88rpx'],
        ['padding', '0 32rpx'],
        ['border-radius', '999rpx'],
        ['box-sizing', 'border-box'],
        ['background', 'var(--store-primary-color)'],
        ['color', '#FFFFFF'],
        ['font-size', '28rpx'],
        ['font-weight', '600'],
      ]),
    );
  }
  const header = [
    '/* 由 frontend-reconstruct 确定性 renderer 生成：不要手改。 */',
    '/* 页面 ' + page.pageId + '：结构来自 frontend-pack-draft.v1，CSS 只使用白名单档位。 */',
  ];
  const wxssText = header.join('\n') + '\n' + staticRules.concat(wxss).join('\n\n') + '\n';
  return {
    pageId: page.pageId,
    wxml: lines.join('\n') + '\n',
    wxss: wxssText,
    slots,
  };
}

function containsType(node, type) {
  if (node.type === type) return true;
  if (node.type !== 'container') return false;
  return node.children.some((child) => containsType(child, type));
}

function pageJsonSubset(pageJson, pageId) {
  const out = {};
  const dropped = [];
  for (const key of Object.keys(pageJson)) {
    if (PACK_PAGE_JSON_KEYS.includes(key)) out[key] = pageJson[key];
    else dropped.push(key);
  }
  // 固定键顺序：标题 → 下拉刷新 → 背景色。
  const ordered = {};
  for (const key of PACK_PAGE_JSON_KEYS) {
    if (out[key] !== undefined) ordered[key] = out[key];
  }
  const degradations = dropped.sort().map((key) => ({
    code: 'PAGE_JSON_KEY_UNSUPPORTED',
    path: '$.' + pageId + '.pageJson.' + key,
    message: 'FrontendPack 页面 JSON 白名单不含 ' + key + '，已丢弃（不静默保留）',
  }));
  return { json: ordered, degradations };
}

function previewFiles(draft, pages) {
  const files = new Map();
  const notes = {
    normal: '正常态：结构与样式与候选 FrontendPack 一致',
    empty: '空态：数据 token 为空时只保留结构骨架，不编造业务内容',
    error: '错误态：页面级错误由 Base 控制器的 error 状态处理，候选不新增错误源',
    long: '长内容态：文本 token 变长时按 Base 行高换行，不引入固定高度裁剪',
  };
  for (const kind of PREVIEW_KINDS) {
    files.set(
      'preview/' + kind + '.json',
      jsonText({
        schemaVersion: 'frontend-preview.v1',
        state: kind,
        displayName: draft.displayName,
        note: notes[kind],
        pages: pages.map((page) => ({
          pageId: page.pageId,
          slotIds: page.slots,
        })),
      }),
    );
  }
  return files;
}

function buildManifest(options) {
  const { candidateId, version, displayName, pages, requiresSlots, base } = options;
  const entryFiles = [];
  for (const page of pages) {
    entryFiles.push('pages/' + page.pageId + '/index.wxml');
    entryFiles.push('pages/' + page.pageId + '/index.wxss');
    entryFiles.push('pages/' + page.pageId + '/index.json');
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    identity: { id: candidateId, version },
    kind: 'frontend-pack',
    displayName,
    entry: { path: 'src', files: entryFiles, assets: [] },
    pages: pages.map((page) => page.pageId),
    boundary: {
      allowNetwork: false,
      allowRoutes: false,
      allowGlobalState: false,
      allowServices: false,
    },
    compatibility: {
      baseRange: '^' + base.version,
      minWechatLib: base.minWechatLib,
      apiContract: 'storefront.v1',
    },
    requiresSlots,
    preview: { dir: 'preview', kinds: [...PREVIEW_KINDS] },
    release: {
      stage: 'candidate',
      knownLimits: [
        '仅覆盖 ' + pages.map((page) => page.pageId).join('/') + ' 的视图层；页面控制器、服务层与领域逻辑仍来自 Base',
        'WXSS 在 Base 页面样式之后追加，不删除 Base 原有样式',
        '候选包由 frontend-pack-draft.v1 DSL 确定性生成，未经用户采用不进入全局 Registry',
      ],
    },
  };
}

class RenderError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.path = path;
  }
}

function assertGeneratedSafe(files) {
  for (const [relative, content] of files) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    for (const rule of FORBIDDEN_OUTPUT_PATTERNS) {
      if (rule.pattern.test(text)) {
        throw new RenderError(rule.code, relative, '生成内容命中了禁止模式：' + rule.code);
      }
    }
  }
}

/** 目录树摘要：与 `scripts/composer/digest.cjs#treeSha256` 同口径（全部按文本 LF 归一化）。 */
function treeDigestOfFiles(files) {
  const paths = [...files.keys()].sort();
  const lines = paths.map((relative) => {
    const content = files.get(relative);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const normalized = Buffer.from(normalizedText(buffer.toString('utf8')), 'utf8');
    return relative + ':' + sha256(normalized);
  });
  return sha256(lines.join('\n'));
}

/**
 * 渲染 FrontendPack 候选。
 *
 * @param {unknown} rawDraft 模型产出的 Draft（会被完整校验）
 * @param {object} options
 * @param {object} options.facts         注入能力事实（P1 能力快照投影）
 * @param {object} options.pageFacts     页面级目录事实（每页 usingComponents、插槽与 dataPaths）
 * @param {string} [options.version]     候选版本，默认 1.0.0
 * @param {{version:string, minWechatLib:string}} [options.base] Base 版本信息
 * @returns {{ok:true, candidateId:string, version:string, digest:string, draftDigest:string,
 *            files:Map<string,string>, manifest:object, pages:object[], requiresSlots:string[],
 *            degradations:object[]}|{ok:false, code:string, path:string, message:string}}
 */
function renderFrontendPack(rawDraft, options) {
  const opts = options || {};
  try {
    const validated = validateDraft(rawDraft, opts.facts, opts.pageFacts);
    if (!validated.ok) return validated;
    const { draft } = validated;

    const version = opts.version === undefined ? '1.0.0' : opts.version;
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
      return fail('RENDER_VERSION_INVALID', 'version', '版本必须是 x.y.z');
    }
    const base = opts.base || { version: '1.0.0', minWechatLib: '3.0.0' };
    const candidateId = opts.candidateId || 'fr-' + draftDigest(draft).slice('sha256:'.length, 'sha256:'.length + 12);
    if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
      return fail('RENDER_CANDIDATE_ID_INVALID', 'candidateId', '候选 id 非法：' + candidateId);
    }

    const files = new Map();
    const pages = [];
    const requiresSlots = [];
    const degradations = [];

    for (let pageIndex = 0; pageIndex < draft.pages.length; pageIndex += 1) {
      const page = draft.pages[pageIndex];
      const rendered = renderPage(page, pageIndex);
      for (const slotId of rendered.slots) {
        if (!requiresSlots.includes(slotId)) requiresSlots.push(slotId);
      }
      files.set('src/pages/' + page.pageId + '/index.wxml', rendered.wxml);
      files.set('src/pages/' + page.pageId + '/index.wxss', rendered.wxss);
      const subset = pageJsonSubset(page.pageJson, page.pageId);
      for (const degradation of subset.degradations) degradations.push(degradation);
      files.set('src/pages/' + page.pageId + '/index.json', jsonText(subset.json));
      pages.push({ pageId: page.pageId, slots: rendered.slots });
    }

    const manifest = buildManifest({
      candidateId,
      version,
      displayName: draft.displayName,
      pages,
      requiresSlots,
      base,
    });
    files.set('manifest.json', jsonText(manifest));
    for (const [relative, content] of previewFiles(draft, pages)) files.set(relative, content);

    assertGeneratedSafe(files);

    return ok({
      candidateId,
      version,
      digest: treeDigestOfFiles(files),
      draftDigest: draftDigest(draft),
      files,
      manifest,
      pages,
      requiresSlots,
      degradations,
    });
  } catch (error) {
    if (error instanceof RenderError) return fail(error.code, error.path, error.message);
    throw error;
  }
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  PREVIEW_KINDS,
  BASE_SLOT_IDS,
  THEME_CSS_VARS,
  PACK_PAGE_JSON_KEYS,
  SPACE_SCALE,
  RADIUS_SCALE,
  FONT_SIZE_SCALE,
  LIMITS,
  SIZE_STEPS,
  LAYOUT_STYLE_KEYS,
  TEXT_STYLE_KEYS,
  CART_DATA_PATH_MAP,
  RenderError,
  stableStringify,
  draftDigest,
  treeDigestOfFiles,
  toWxmlDataExpression,
  renderFrontendPack,
};
