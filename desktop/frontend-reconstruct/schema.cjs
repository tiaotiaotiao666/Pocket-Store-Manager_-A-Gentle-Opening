'use strict';

/**
 * `frontend-pack-draft.v1` DSL 的本地校验器（Electron 主进程，纯 CJS，无 IO）。
 *
 * 这是 P0 服务端契约 `server/src/agent/frontend-reconstruct/schema.ts` 中
 * `validateFrontendPackDraft` / `validateFrontendFacts` 的**执行侧镜像**：
 * 服务端负责“模型输出是否合法”，桌面端负责“我即将写盘的东西是否合法”，
 * 两侧规则必须一致；P2 只实现执行所需的部分，不新增 DSL 语义。
 *
 * 硬边界（任何一条不满足即拒绝，绝不“尽力而为”地修正模型输出）：
 * - 只允许 5 类节点：component / slot / container / text / button；
 * - 所有 component/slot/dataPath/action/theme token/size 档位都必须命中**注入事实**；
 * - 只允许白名单 style 属性与档位值；CSS 由确定性 renderer 生成，DSL 不携带样式原文；
 * - 禁止 WXML/WXSS/JS/WXS 原文、模板表达式 `{{}}`、外部 URL、`import`/`include`、
 *   反斜杠、`..`、绝对路径、控制字符；
 * - 未知键一律拒绝（严格对象），节点数量/深度/字符串长度都有上限。
 *
 * 本文件不做任何 IO，也不依赖 Electron；`facts` 由调用方（P1 能力快照）注入。
 */

const DRAFT_SCHEMA_VERSION = 'frontend-pack-draft.v1';
const FACTS_VERSION = 'frontend-facts.v1';

/** 首期仅支持 Base 的 home/menu；与 P0 契约一致。 */
const TARGET_PAGES = Object.freeze(['home', 'menu']);

/** DSL 只允许 5 类节点。 */
const DRAFT_NODE_TYPES = Object.freeze(['component', 'slot', 'container', 'text', 'button']);

/** Base `theme.tokens.json` 的七类颜色 token。 */
const THEME_TOKEN_KEYS = Object.freeze([
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
]);

const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);

const SIZE_KEYS = Object.freeze(['homeHero', 'productCard', 'carousel']);

/** 与 P0 `FRONTEND_LIMITS` 中 Draft 相关部分逐项一致。 */
const LIMITS = Object.freeze({
  maxDraftPages: 2,
  maxDraftNodesPerPage: 48,
  maxDraftDepth: 4,
  maxContainerChildren: 12,
  maxComponentProps: 8,
  maxComponentEvents: 8,
  maxDraftStringChars: 120,
  maxDisplayNameChars: 40,
  maxButtonLabelChars: 16,
  maxNavTitleChars: 20,
  maxFactsEntries: 128,
});

/**
 * 本地结构化 issue code（与 P0 `FRONTEND_REPAIR_ISSUE_CODES` 对齐）。
 * P3 的 repair 只接受这些 code + 精确 DSL path，因此这里不产生自由文本错误码。
 */
const DRAFT_ERROR_CODES = Object.freeze({
  SCHEMA: 'DRAFT_SCHEMA_INVALID',
  COMPONENT: 'DRAFT_UNKNOWN_COMPONENT',
  EVENT: 'DRAFT_UNKNOWN_EVENT',
  DATA_PATH: 'DRAFT_UNKNOWN_DATA_PATH',
  STYLE: 'DRAFT_STYLE_INVALID',
  PAGE_JSON: 'DRAFT_PAGE_JSON_INVALID',
});

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PROP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const EVENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]{0,31}$/;
const DATA_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,7}$/;
const PAGE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * 纯文本黑名单：模板/标签/脚本 scheme/URL/绝对路径/反斜杠/路径穿越。
 * 命中任意一条即拒绝，不做“清洗后继续”。
 */
const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  /[<>]/,
  /\{\{|\}\}/,
  /javascript:/i,
  /vbscript:/i,
  /data:/i,
  /https?:\/\//i,
  /^\/\//,
  /^\//,
  /\\/,
  /\.\./,
]);

const LAYOUT_STYLE_KEYS = Object.freeze([
  'direction',
  'align',
  'justify',
  'gap',
  'padding',
  'radius',
  'width',
  'minHeight',
  'backgroundColorToken',
  'borderColorToken',
]);

const TEXT_STYLE_KEYS = Object.freeze(['size', 'weight', 'colorToken']);

const PAGE_JSON_KEYS = Object.freeze([
  'navigationBarTitleText',
  'navigationBarBackgroundColor',
  'navigationBarTextStyle',
  'backgroundColor',
  'enablePullDownRefresh',
]);

const DRAFT_KEYS = Object.freeze(['schemaVersion', 'displayName', 'pages']);
const DRAFT_PAGE_KEYS = Object.freeze(['pageId', 'nodes', 'styles', 'pageJson']);
const COMPONENT_KEYS = Object.freeze(['type', 'componentId', 'props', 'events']);
const SLOT_KEYS = Object.freeze(['type', 'slotId']);
const CONTAINER_KEYS = Object.freeze(['type', 'style', 'children']);
const TEXT_KEYS = Object.freeze(['type', 'textToken', 'style']);
const BUTTON_KEYS = Object.freeze(['type', 'label', 'action', 'style']);
const DATA_PROP_KEYS = Object.freeze(['kind', 'dataPath']);
const LITERAL_PROP_KEYS = Object.freeze(['kind', 'value']);

class DraftValidationError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'DraftValidationError';
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, path, message) {
  throw new DraftValidationError(code, path, message);
}

function assertObject(value, path, code, message) {
  if (!isPlainObject(value)) fail(code, path, message || '必须是对象');
  return value;
}

function assertExactKeys(value, allowed, path, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${path}.${key}`, '不允许的字段：' + key);
  }
}

function assertArray(value, path, code, min, max, message) {
  if (!Array.isArray(value)) fail(code, path, message || '必须是数组');
  if (value.length < min || value.length > max) {
    fail(code, path, (message || '数组长度越界') + '：' + value.length + '（允许 ' + min + '–' + max + '）');
  }
  return value;
}

function assertEnum(value, allowed, path, code) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(code, path, '只允许：' + allowed.join(' | '));
  }
  return value;
}

function assertPattern(value, pattern, path, code, message) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code, path, message || '格式非法');
  return value;
}

function assertInteger(value, path, code, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(code, path, '必须是 ' + min + '–' + max + ' 的整数');
  }
  return value;
}

function assertBoolean(value, path, code) {
  if (typeof value !== 'boolean') fail(code, path, '必须是布尔值');
  return value;
}

/**
 * 纯文本：trim 后长度在界内、无控制字符、不命中模板/标签/URL/路径黑名单。
 * 返回值是 trim 后的文本（不会“修好”非法输入）。
 */
function assertPlainText(value, path, code, options) {
  if (typeof value !== 'string') fail(code, path, '必须是字符串');
  const min = options.allowEmpty === true ? 0 : (options.min === undefined ? 1 : options.min);
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < min || length > options.max) {
    fail(code, path, '长度必须是 ' + min + '–' + options.max);
  }
  if (CONTROL_CHAR_PATTERN.test(text)) fail(code, path, '不得包含控制字符');
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    if (pattern.test(text)) fail(code, path, '包含禁止的标签/模板/URL/路径片段');
  }
  return text;
}

function uniqueStrings(value, path, code, pattern, min, max) {
  const raw = assertArray(value, path, code, min, max);
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = assertPattern(raw[index], pattern, `${path}[${index}]`, code, '条目标识非法');
    if (out.includes(item)) fail(code, `${path}[${index}]`, '重复条目：' + item);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 注入事实（能力快照投影）
// ---------------------------------------------------------------------------

function parseFacts(raw) {
  const code = DRAFT_ERROR_CODES.SCHEMA;
  const root = assertObject(raw, '$facts', code, '能力事实必须是对象');
  assertExactKeys(
    root,
    ['version', 'pageIds', 'components', 'slots', 'actions', 'dataPaths', 'themeTokens', 'sizeKeys'],
    '$facts',
    code,
  );
  if (root.version !== FACTS_VERSION) fail(code, '$facts.version', '事实版本必须是 ' + FACTS_VERSION);

  const pageIds = uniqueStrings(root.pageIds, '$facts.pageIds', code, PAGE_ID_PATTERN, 1, TARGET_PAGES.length);
  for (const pageId of pageIds) {
    if (!TARGET_PAGES.includes(pageId)) fail(code, '$facts.pageIds', '不支持的页面：' + pageId);
  }

  const rawComponents = assertObject(root.components, '$facts.components', code, 'components 必须是对象');
  const componentIds = Object.keys(rawComponents);
  if (componentIds.length > LIMITS.maxFactsEntries) fail(code, '$facts.components', '组件事实过多');
  const components = {};
  for (const componentId of componentIds) {
    if (!COMPONENT_ID_PATTERN.test(componentId)) fail(code, '$facts.components', '组件 id 非法：' + componentId);
    const entry = assertObject(rawComponents[componentId], `$facts.components.${componentId}`, code);
    assertExactKeys(entry, ['props', 'events'], `$facts.components.${componentId}`, code);
    components[componentId] = {
      props: uniqueStrings(entry.props, `$facts.components.${componentId}.props`, code, PROP_ID_PATTERN, 0, LIMITS.maxFactsEntries),
      events: uniqueStrings(entry.events, `$facts.components.${componentId}.events`, code, EVENT_ID_PATTERN, 0, LIMITS.maxFactsEntries),
    };
  }

  const slots = uniqueStrings(root.slots, '$facts.slots', code, COMPONENT_ID_PATTERN, 0, LIMITS.maxFactsEntries);
  const actions = uniqueStrings(root.actions, '$facts.actions', code, ACTION_PATTERN, 0, LIMITS.maxFactsEntries);
  const dataPaths = uniqueStrings(root.dataPaths, '$facts.dataPaths', code, DATA_PATH_PATTERN, 0, LIMITS.maxFactsEntries);

  const themeTokens = uniqueStrings(
    root.themeTokens,
    '$facts.themeTokens',
    code,
    /^[A-Za-z][A-Za-z0-9]{0,39}$/,
    1,
    THEME_TOKEN_KEYS.length,
  );
  for (const token of themeTokens) {
    if (!THEME_TOKEN_KEYS.includes(token)) fail(code, '$facts.themeTokens', '未知主题 token：' + token);
  }

  const sizeKeys = uniqueStrings(
    root.sizeKeys,
    '$facts.sizeKeys',
    code,
    /^[A-Za-z][A-Za-z0-9]{0,39}$/,
    1,
    SIZE_KEYS.length,
  );
  for (const key of sizeKeys) {
    if (!SIZE_KEYS.includes(key)) fail(code, '$facts.sizeKeys', '未知尺寸键：' + key);
  }

  return {
    version: FACTS_VERSION,
    pageIds,
    components,
    slots,
    actions,
    dataPaths,
    themeTokens,
    sizeKeys,
  };
}

/**
 * 校验并归一化注入事实。
 * @returns {{ok:true, facts:object}|{ok:false, code:string, path:string, message:string}}
 */
function validateFacts(raw) {
  try {
    return { ok: true, facts: parseFacts(raw) };
  } catch (error) {
    if (error instanceof DraftValidationError) {
      return { ok: false, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 页面级目录事实（由桌面端从可信 Base 读取，避免“组件未在页面声明”）
// ---------------------------------------------------------------------------

/**
 * 校验页面级目录事实：`{ [pageId]: { components: string[], slots: string[], dataPaths: string[] } }`。
 * 这是 renderer 的第二道门：能力事实是全局的，页面声明才是“这个页面真的能用”。
 * 页面可以声明比能力快照更多的组件（例如被能力报告排除的组件），但**被 DSL 引用的**
 * 组件/插槽/数据路径必须同时命中能力事实与页面声明（repair-2：dataPaths 必填，
 * 防止 home 的数据绑定被挪到 menu 页面）。
 */
function parsePageFacts(raw) {
  const code = DRAFT_ERROR_CODES.SCHEMA;
  const root = assertObject(raw, '$pageFacts', code, '页面事实必须是对象');
  const out = {};
  for (const pageId of Object.keys(root)) {
    if (!TARGET_PAGES.includes(pageId)) fail(code, `$pageFacts.${pageId}`, '不支持的页面：' + pageId);
    const entry = assertObject(root[pageId], `$pageFacts.${pageId}`, code);
    assertExactKeys(entry, ['components', 'slots', 'dataPaths'], `$pageFacts.${pageId}`, code);
    const components = uniqueStrings(entry.components, `$pageFacts.${pageId}.components`, code, COMPONENT_ID_PATTERN, 0, LIMITS.maxFactsEntries);
    const slots = uniqueStrings(entry.slots, `$pageFacts.${pageId}.slots`, code, COMPONENT_ID_PATTERN, 0, LIMITS.maxFactsEntries);
    const dataPaths = uniqueStrings(entry.dataPaths, `$pageFacts.${pageId}.dataPaths`, code, DATA_PATH_PATTERN, 0, LIMITS.maxFactsEntries);
    out[pageId] = { components, slots, dataPaths };
  }
  return out;
}

// ---------------------------------------------------------------------------
// DSL
// ---------------------------------------------------------------------------

function assertPageDataPath(dataPath, path, pageId, pageDataPaths) {
  if (!pageDataPaths.includes(dataPath)) {
    fail(
      DRAFT_ERROR_CODES.DATA_PATH,
      path,
      '数据路径未在页面 ' + pageId + ' 的事实中：' + dataPath,
    );
  }
}

function parsePropBinding(raw, path, facts, pageId, pageDataPaths) {
  const code = DRAFT_ERROR_CODES.SCHEMA;
  const binding = assertObject(raw, path, code, 'prop 绑定必须是对象');
  if (binding.kind === 'data') {
    assertExactKeys(binding, DATA_PROP_KEYS, path, code);
    const dataPath = assertPattern(binding.dataPath, DATA_PATH_PATTERN, `${path}.dataPath`, DRAFT_ERROR_CODES.DATA_PATH, '只接受真实 dataPath');
    if (!facts.dataPaths.includes(dataPath)) fail(DRAFT_ERROR_CODES.DATA_PATH, `${path}.dataPath`, '未在事实中的数据路径：' + dataPath);
    assertPageDataPath(dataPath, `${path}.dataPath`, pageId, pageDataPaths);
    return { kind: 'data', dataPath };
  }
  if (binding.kind === 'literal') {
    assertExactKeys(binding, LITERAL_PROP_KEYS, path, code);
    const value = binding.value;
    if (value === null || typeof value === 'boolean') return { kind: 'literal', value };
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(code, `${path}.value`, '必须是有限数字');
      return { kind: 'literal', value };
    }
    if (typeof value === 'string') {
      return {
        kind: 'literal',
        value: assertPlainText(value, `${path}.value`, code, { max: LIMITS.maxDraftStringChars, allowEmpty: true }),
      };
    }
    fail(code, `${path}.value`, '字面量只允许 string/number/boolean/null');
  }
  fail(code, `${path}.kind`, 'prop 只允许 data 或 literal');
}

function parseLayoutStyle(raw, path, facts) {
  const code = DRAFT_ERROR_CODES.STYLE;
  const style = assertObject(raw, path, code, 'style 必须是对象');
  assertExactKeys(style, LAYOUT_STYLE_KEYS, path, code);
  if (Object.keys(style).length === 0) fail(code, path, 'style 不能是空对象');
  const out = {};
  if (style.direction !== undefined) out.direction = assertEnum(style.direction, ['row', 'column'], `${path}.direction`, code);
  if (style.align !== undefined) out.align = assertEnum(style.align, ['start', 'center', 'end', 'stretch'], `${path}.align`, code);
  if (style.justify !== undefined) {
    out.justify = assertEnum(style.justify, ['start', 'center', 'end', 'between', 'around'], `${path}.justify`, code);
  }
  if (style.gap !== undefined) out.gap = assertEnum(style.gap, ['none', 'xs', 'sm', 'md', 'lg', 'xl'], `${path}.gap`, code);
  if (style.padding !== undefined) out.padding = assertEnum(style.padding, ['none', 'xs', 'sm', 'md', 'lg', 'xl'], `${path}.padding`, code);
  if (style.radius !== undefined) out.radius = assertEnum(style.radius, ['none', 'sm', 'md', 'lg', 'full'], `${path}.radius`, code);
  if (style.width !== undefined) {
    if (style.width === 'auto' || style.width === 'full') out.width = style.width;
    else out.width = assertInteger(style.width, `${path}.width`, code, 40, 750);
  }
  if (style.minHeight !== undefined) out.minHeight = assertInteger(style.minHeight, `${path}.minHeight`, code, 0, 2000);
  if (style.backgroundColorToken !== undefined) {
    out.backgroundColorToken = assertEnum(style.backgroundColorToken, facts.themeTokens, `${path}.backgroundColorToken`, code);
  }
  if (style.borderColorToken !== undefined) {
    out.borderColorToken = assertEnum(style.borderColorToken, facts.themeTokens, `${path}.borderColorToken`, code);
  }
  return out;
}

function parseTextStyle(raw, path, facts) {
  const code = DRAFT_ERROR_CODES.STYLE;
  const style = assertObject(raw, path, code, 'style 必须是对象');
  assertExactKeys(style, TEXT_STYLE_KEYS, path, code);
  if (Object.keys(style).length === 0) fail(code, path, 'style 不能是空对象');
  const out = {};
  if (style.size !== undefined) out.size = assertEnum(style.size, SIZE_STEPS, `${path}.size`, code);
  if (style.weight !== undefined) {
    if (style.weight !== 400 && style.weight !== 500 && style.weight !== 600 && style.weight !== 700) {
      fail(code, `${path}.weight`, '只允许 400/500/600/700');
    }
    out.weight = style.weight;
  }
  if (style.colorToken !== undefined) {
    out.colorToken = assertEnum(style.colorToken, facts.themeTokens, `${path}.colorToken`, code);
  }
  return out;
}

function parseDraftNode(raw, path, depth, context) {
  const { facts, pageFacts, pageId } = context;
  const code = DRAFT_ERROR_CODES.SCHEMA;
  const node = assertObject(raw, path, code, '节点必须是对象');
  context.nodeCount += 1;
  if (context.nodeCount > LIMITS.maxDraftNodesPerPage) fail(code, path, '节点数量超过上限');
  if (depth > LIMITS.maxDraftDepth) fail(code, path, '节点嵌套过深');
  const type = assertEnum(node.type, DRAFT_NODE_TYPES, `${path}.type`, code);

  switch (type) {
    case 'component': {
      assertExactKeys(node, COMPONENT_KEYS, path, code);
      const componentId = assertPattern(node.componentId, COMPONENT_ID_PATTERN, `${path}.componentId`, DRAFT_ERROR_CODES.COMPONENT, '组件 id 非法');
      const componentFact = facts.components[componentId];
      if (componentFact === undefined) fail(DRAFT_ERROR_CODES.COMPONENT, `${path}.componentId`, '未在事实中的组件：' + componentId);
      const pageEntry = pageFacts[pageId];
      if (!pageEntry || !pageEntry.components.includes(componentId)) {
        fail(DRAFT_ERROR_CODES.COMPONENT, `${path}.componentId`, '组件未在页面 ' + pageId + ' 的 usingComponents 中声明：' + componentId);
      }

      const rawProps = assertObject(node.props, `${path}.props`, code, 'props 必须是对象');
      const propNames = Object.keys(rawProps).sort();
      if (propNames.length > LIMITS.maxComponentProps) fail(code, `${path}.props`, 'props 数量超过上限');
      const props = {};
      for (const propName of propNames) {
        if (!componentFact.props.includes(propName)) {
          fail(code, `${path}.props.${propName}`, '组件 ' + componentId + ' 未声明 prop：' + propName);
        }
        props[propName] = parsePropBinding(rawProps[propName], `${path}.props.${propName}`, facts, pageId, pageEntry.dataPaths);
      }

      const rawEvents = assertObject(node.events, `${path}.events`, code, 'events 必须是对象');
      const eventNames = Object.keys(rawEvents).sort();
      if (eventNames.length > LIMITS.maxComponentEvents) fail(code, `${path}.events`, 'events 数量超过上限');
      const events = {};
      for (const eventName of eventNames) {
        if (!componentFact.events.includes(eventName)) {
          fail(DRAFT_ERROR_CODES.EVENT, `${path}.events.${eventName}`, '组件 ' + componentId + ' 未声明事件：' + eventName);
        }
        const action = assertPattern(rawEvents[eventName], ACTION_PATTERN, `${path}.events.${eventName}`, DRAFT_ERROR_CODES.EVENT, '事件必须绑定真实控制器动作');
        if (!facts.actions.includes(action)) {
          fail(DRAFT_ERROR_CODES.EVENT, `${path}.events.${eventName}`, '未在事实中的控制器动作：' + action);
        }
        if (action.split('.')[0] !== pageId) {
          fail(DRAFT_ERROR_CODES.EVENT, `${path}.events.${eventName}`, '动作必须属于本页面：' + pageId);
        }
        events[eventName] = action;
      }

      return { type, componentId, props, events };
    }
    case 'slot': {
      assertExactKeys(node, SLOT_KEYS, path, code);
      const slotId = assertPattern(node.slotId, COMPONENT_ID_PATTERN, `${path}.slotId`, code, '插槽 id 非法');
      if (!facts.slots.includes(slotId)) fail(code, `${path}.slotId`, '未在事实中的插槽：' + slotId);
      const pageEntry = pageFacts[pageId];
      if (!pageEntry || !pageEntry.slots.includes(slotId)) {
        fail(code, `${path}.slotId`, '插槽不属于页面 ' + pageId + '：' + slotId);
      }
      return { type, slotId };
    }
    case 'container': {
      assertExactKeys(node, CONTAINER_KEYS, path, code);
      const rawChildren = assertArray(node.children, `${path}.children`, code, 1, LIMITS.maxContainerChildren, 'children 必须是 1–12 个节点');
      const style = node.style === undefined ? undefined : parseLayoutStyle(node.style, `${path}.style`, facts);
      const children = [];
      for (let index = 0; index < rawChildren.length; index += 1) {
        children.push(parseDraftNode(rawChildren[index], `${path}.children[${index}]`, depth + 1, context));
      }
      return { type, style, children };
    }
    case 'text': {
      assertExactKeys(node, TEXT_KEYS, path, code);
      const textToken = assertPattern(node.textToken, DATA_PATH_PATTERN, `${path}.textToken`, DRAFT_ERROR_CODES.DATA_PATH, '文本只能绑定真实 dataPath');
      if (!facts.dataPaths.includes(textToken)) {
        fail(DRAFT_ERROR_CODES.DATA_PATH, `${path}.textToken`, '未在事实中的数据路径：' + textToken);
      }
      const pageEntry = pageFacts[pageId];
      if (!pageEntry) fail(DRAFT_ERROR_CODES.SCHEMA, `${path}.textToken`, '页面缺少目录事实：' + pageId);
      assertPageDataPath(textToken, `${path}.textToken`, pageId, pageEntry.dataPaths);
      const style = node.style === undefined ? undefined : parseTextStyle(node.style, `${path}.style`, facts);
      return { type, textToken, style };
    }
    case 'button': {
      assertExactKeys(node, BUTTON_KEYS, path, code);
      const label = assertPlainText(node.label, `${path}.label`, code, { max: LIMITS.maxButtonLabelChars });
      const action = assertPattern(node.action, ACTION_PATTERN, `${path}.action`, DRAFT_ERROR_CODES.EVENT, '按钮必须绑定真实控制器动作');
      if (!facts.actions.includes(action)) {
        fail(DRAFT_ERROR_CODES.EVENT, `${path}.action`, '未在事实中的控制器动作：' + action);
      }
      if (action.split('.')[0] !== pageId) {
        fail(DRAFT_ERROR_CODES.EVENT, `${path}.action`, '动作必须属于本页面：' + pageId);
      }
      const style = node.style === undefined ? undefined : parseTextStyle(node.style, `${path}.style`, facts);
      return { type, label, action, style };
    }
    default:
      return fail(code, `${path}.type`, '未知节点类型');
  }
}

function parsePageJson(raw, path) {
  const code = DRAFT_ERROR_CODES.PAGE_JSON;
  const pageJson = assertObject(raw, path, code, 'pageJson 必须是对象');
  assertExactKeys(pageJson, PAGE_JSON_KEYS, path, code);
  const out = {};
  if (pageJson.navigationBarTitleText !== undefined) {
    out.navigationBarTitleText = assertPlainText(pageJson.navigationBarTitleText, `${path}.navigationBarTitleText`, code, {
      max: LIMITS.maxNavTitleChars,
    });
  }
  if (pageJson.navigationBarBackgroundColor !== undefined) {
    const color = pageJson.navigationBarBackgroundColor;
    if (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) fail(code, `${path}.navigationBarBackgroundColor`, '只接受 #RRGGBB');
    out.navigationBarBackgroundColor = color.toUpperCase();
  }
  if (pageJson.navigationBarTextStyle !== undefined) {
    out.navigationBarTextStyle = assertEnum(pageJson.navigationBarTextStyle, ['black', 'white'], `${path}.navigationBarTextStyle`, code);
  }
  if (pageJson.backgroundColor !== undefined) {
    const color = pageJson.backgroundColor;
    if (typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) fail(code, `${path}.backgroundColor`, '只接受 #RRGGBB');
    out.backgroundColor = color.toUpperCase();
  }
  if (pageJson.enablePullDownRefresh !== undefined) {
    out.enablePullDownRefresh = assertBoolean(pageJson.enablePullDownRefresh, `${path}.enablePullDownRefresh`, code);
  }
  return out;
}

function parseDraft(raw, facts, pageFacts) {
  const code = DRAFT_ERROR_CODES.SCHEMA;
  const root = assertObject(raw, '$', code, 'Draft 必须是对象');
  assertExactKeys(root, DRAFT_KEYS, '$', code);
  if (root.schemaVersion !== DRAFT_SCHEMA_VERSION) fail(code, '$.schemaVersion', '只接受 ' + DRAFT_SCHEMA_VERSION);
  const displayName = assertPlainText(root.displayName, '$.displayName', code, { max: LIMITS.maxDisplayNameChars });

  const rawPages = assertArray(root.pages, '$.pages', code, 1, LIMITS.maxDraftPages, 'pages 必须是 1–2 页');
  const pages = [];
  const seen = new Set();
  for (let index = 0; index < rawPages.length; index += 1) {
    const path = `$.pages[${index}]`;
    const page = assertObject(rawPages[index], path, code);
    assertExactKeys(page, DRAFT_PAGE_KEYS, path, code);
    if (typeof page.pageId !== 'string' || !TARGET_PAGES.includes(page.pageId)) {
      fail(code, `${path}.pageId`, '只支持 home/menu');
    }
    const pageId = page.pageId;
    if (seen.has(pageId)) fail(code, `${path}.pageId`, '页面重复：' + pageId);
    if (!facts.pageIds.includes(pageId)) fail(code, `${path}.pageId`, '页面未在事实中：' + pageId);
    seen.add(pageId);

    // styles 是保留字段：首期必须为空数组，CSS 只能由确定性 renderer 生成。
    assertArray(page.styles, `${path}.styles`, code, 0, 0, 'styles 首期必须为空数组（CSS 由 renderer 生成）');

    const rawNodes = assertArray(page.nodes, `${path}.nodes`, code, 1, LIMITS.maxDraftNodesPerPage, 'nodes 必须是 1–48 个节点');
    const context = { facts, pageFacts, pageId, nodeCount: 0 };
    const nodes = [];
    for (let nodeIndex = 0; nodeIndex < rawNodes.length; nodeIndex += 1) {
      nodes.push(parseDraftNode(rawNodes[nodeIndex], `${path}.nodes[${nodeIndex}]`, 0, context));
    }
    const pageJson = parsePageJson(page.pageJson, `${path}.pageJson`);
    pages.push({ pageId, nodes, styles: [], pageJson });
  }

  return { schemaVersion: DRAFT_SCHEMA_VERSION, displayName, pages };
}

function wrap(runner) {
  try {
    return runner();
  } catch (error) {
    if (error instanceof DraftValidationError) {
      return { ok: false, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
}

/**
 * 校验并归一化 FrontendPackDraft。
 *
 * @param {unknown} raw 模型输出的 Draft
 * @param {unknown} rawFacts 注入能力事实
 * @param {unknown} rawPageFacts 页面级目录事实（每页 usingComponents、插槽与本页 dataPaths；三者都必填）
 * @returns {{ok:true, draft:object, facts:object, pageFacts:object}|{ok:false, code:string, path:string, message:string}}
 */
function validateDraft(raw, rawFacts, rawPageFacts) {
  return wrap(() => {
    const facts = parseFacts(rawFacts);
    const pageFacts = parsePageFacts(rawPageFacts);
    const draft = parseDraft(raw, facts, pageFacts);
    return { ok: true, draft, facts, pageFacts };
  });
}

module.exports = {
  DRAFT_SCHEMA_VERSION,
  FACTS_VERSION,
  TARGET_PAGES,
  DRAFT_NODE_TYPES,
  THEME_TOKEN_KEYS,
  SIZE_STEPS,
  SIZE_KEYS,
  LIMITS,
  DRAFT_ERROR_CODES,
  PAGE_JSON_KEYS,
  LAYOUT_STYLE_KEYS,
  TEXT_STYLE_KEYS,
  DraftValidationError,
  validateFacts,
  validateDraft,
};
