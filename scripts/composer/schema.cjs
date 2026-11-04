#!/usr/bin/env node
'use strict';

/**
 * 内置 Schema 校验器（零外部依赖）。
 *
 * 设计原则：
 * 1. 不引入 ajv 等校验库，避免安装包与 CI 增加依赖面。
 * 2. 每个失败返回 {ok:false, code, path, message, details}，path 精确到 JSON 路径。
 * 3. 只做“契约级”校验；文件是否存在、组件实现是否一致由 registry.cjs 负责。
 * 4. 所有金额字段只接受整数分。
 */

const { SCHEMA_VERSIONS } = require('./version.cjs');

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const SHA_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REGISTRY_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d+$/;
const MAX_JSON_BYTES = 64 * 1024;

/** 三档组件尺寸；与 `C-SIZE-TOKENS@1` 的 `sm|md|lg` 完全一致。 */
const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);

/** FrontendPack 的页面文件白名单：只允许视图三件套，不允许 js。 */
const FRONTEND_PACK_PAGE_FILE = /^pages\/([a-z][a-z0-9-]*)\/index\.(wxml|wxss|json)$/;

/** FrontendPack 页面 JSON 允许覆盖的键；usingComponents 仍受 Base 页面白名单约束。 */
const FRONTEND_PACK_PAGE_JSON_KEYS = Object.freeze([
  'navigationBarTitleText',
  'enablePullDownRefresh',
  'disableScroll',
  'backgroundColor',
  'backgroundTextStyle',
  'usingComponents',
]);

/**
 * Plan 顶层 `presentationTokens` 的允许键（C-PLAN-PRESENTATION@1）。
 * 只允许两组尺寸；`carousel` 档位走海报 `props.size`，不得写进这里，避免双写。
 */
const PLAN_SIZE_TOKEN_KEYS = Object.freeze(['homeHeroSize', 'productCardSize']);

/** 缺省尺寸固定为 `md`，与 `templates/presentation/size-tokens.v1.json` 的 defaults 一致。 */
const DEFAULT_PRESENTATION_TOKENS = Object.freeze({
  homeHeroSize: 'md',
  productCardSize: 'md',
});

/**
 * Base 插槽 → 导出配置键的固定映射（plan.md 2.2.2 落位表）。
 * `menu-hero` 由 T11 新增，映射到 `menuHero`；这里只是命名约定，不要求 Base 已声明。
 */
const PRESENTATION_SLOT_PAGE_IDS = Object.freeze({
  'home-hero': 'home',
  'home-marketing': 'home',
  'menu-aside': 'menu',
  'menu-hero': 'menu',
});

const PRESENTATION_SLOT_DATA_KEYS = Object.freeze({
  'home-hero': 'homeHero',
  'home-marketing': 'homeMarketing',
  'menu-aside': 'menuAside',
  'menu-hero': 'menuHero',
});

const PRESENTATION_SLOT_IDS = Object.freeze(Object.keys(PRESENTATION_SLOT_PAGE_IDS));

const FORBIDDEN_KEYS = new Set([
  'source',
  'code',
  'script',
  'command',
  'url',
  'token',
  'secret',
  'password',
  'apiKey',
  'priceText',
  'totalCents',
]);

const STORE_CONFIG_ALLOWED = {
  root: [
    'schemaVersion',
    'meta',
    'store',
    'api',
    'catalog',
    'fulfillmentOptions',
    'theme',
    'capabilities',
    'demoPaymentDisclaimer',
  ],
  meta: [
    'configSchemaVersion',
    'storeConfigVersion',
    'catalogVersion',
    'apiContractVersion',
    'recipeId',
    'recipeVersion',
    'lockDigest',
    'generatedAt',
    'generatorVersion',
    'planDigest',
    'mode',
    'frontendPackId',
    'frontendPackVersion',
    'versionGaps',
  ],
  store: ['id', 'name', 'category', 'address', 'phone', 'notes', 'businessHours'],
  api: ['baseUrl', 'contract', 'timeoutMs'],
  catalog: ['mode', 'version', 'categories', 'products'],
  fulfillmentOptions: ['dineIn', 'takeaway', 'delivery'],
  theme: [
    'pageBackground',
    'primaryColor',
    'accentColor',
    'textColor',
    'tabBarBackground',
    'tabBarColor',
    'tabBarSelectedColor',
  ],
  capabilities: ['onlineReady', 'previewOnly'],
  versionGaps: ['storeConfigVersion', 'catalogVersion'],
};

const PLAN_FORBIDDEN = Object.freeze([...FORBIDDEN_KEYS]);

function ok() {
  return { ok: true };
}

function fail(code, path, message, details) {
  return {
    ok: false,
    code,
    path: path || '$',
    message: message || code,
    details: details === undefined ? null : details,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function checkType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'null') return value === null;
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function typeMatches(value, expected) {
  if (Array.isArray(expected)) return expected.some((item) => checkType(value, item));
  return checkType(value, expected);
}

function requiredFields(object, fields, basePath, prefix) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object, field) || object[field] === undefined) {
      return fail('FIELD_MISSING', basePath === '$' ? field : basePath + '.' + field, '缺少必填字段 ' + field, { field });
    }
  }
  return null;
}

function checkString(value, path, options) {
  const opts = options || {};
  if (typeof value !== 'string') return fail('FIELD_TYPE', path, '应为字符串');
  if (opts.minLength !== undefined && value.length < opts.minLength) {
    return fail('FIELD_LENGTH', path, '长度不能小于 ' + opts.minLength);
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    return fail('FIELD_LENGTH', path, '长度不能超过 ' + opts.maxLength);
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    return fail(opts.patternCode || 'FIELD_PATTERN', path, '格式不合法：' + value);
  }
  return null;
}

function checkId(value, path, label) {
  const typeError = checkString(value, path);
  if (typeError) return typeError;
  if (!ID_PATTERN.test(value)) {
    return fail('FIELD_PATTERN', path, (label || 'ID') + ' 必须为 3–48 位 kebab-case：' + value);
  }
  if (value.length < 3 || value.length > 48) {
    return fail('FIELD_LENGTH', path, (label || 'ID') + ' 长度必须为 3–48');
  }
  return null;
}

/** 精确版本：拒绝 latest、范围、^、~、*。 */
function checkExactVersion(value, path) {
  const typeError = checkString(value, path);
  if (typeError) return typeError;
  if (!VERSION_PATTERN.test(value)) {
    return fail('VERSION_NOT_EXACT', path, '版本必须是精确 MAJOR.MINOR.PATCH：' + value, { value });
  }
  return null;
}

function checkColor(value, path) {
  const typeError = checkString(value, path);
  if (typeError) return typeError;
  if (!COLOR_PATTERN.test(value)) return fail('FIELD_PATTERN', path, '颜色必须是大写 6 位十六进制：' + value);
  return null;
}

/**
 * 包内相对 POSIX 路径校验。
 * 拒绝：空串、绝对路径（/ 或 C:\）、反斜杠、..、外部协议、超长。
 */
function validatePath(value, options) {
  const opts = options || {};
  const path = opts.path || '$';
  if (typeof value !== 'string') return fail('ENTRY_PATH_INVALID', path, '路径必须是字符串');
  if (!value) return fail('ENTRY_PATH_INVALID', path, '路径不能为空');
  if (value.length > 200) return fail('ENTRY_PATH_INVALID', path, '路径超过 200 字符');
  if (value.startsWith('/') || value.startsWith('\\')) return fail('ENTRY_PATH_INVALID', path, '不允许绝对路径');
  if (/^[A-Za-z]:[\\/]/.test(value)) return fail('ENTRY_PATH_INVALID', path, '不允许 Windows 绝对路径');
  if (value.includes('\\')) return fail('ENTRY_PATH_INVALID', path, '只允许 POSIX 分隔符 /');
  if (value.includes('\0')) return fail('ENTRY_PATH_INVALID', path, '路径包含非法字符');
  if (/(^|\/)\.\.(\/|$)/.test(value)) return fail('ENTRY_PATH_INVALID', path, '不允许路径逃逸 ..');
  if (/^[a-z]+:\/\//i.test(value)) return fail('ENTRY_PATH_INVALID', path, '不允许外部协议');
  if (/^\/\//.test(value)) return fail('ENTRY_PATH_INVALID', path, '不允许 UNC 路径');
  return null;
}

/** 递归检测禁止键，返回首个命中的 JSON 路径。 */
function detectForbiddenKeys(value, options) {
  const opts = options || {};
  const forbidden = new Set(opts.keys || FORBIDDEN_KEYS);
  const basePath = opts.path || '$';
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = detectForbiddenKeys(value[index], { keys: [...forbidden], path: basePath + '[' + index + ']' });
      if (hit) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (forbidden.has(key)) {
        return fail('PLAN_FIELD_FORBIDDEN', basePath === '$' ? key : basePath + '.' + key, '禁止字段：' + key, { key });
      }
      const hit = detectForbiddenKeys(value[key], { keys: [...forbidden], path: basePath === '$' ? key : basePath + '.' + key });
      if (hit) return hit;
    }
  }
  return null;
}

function detectForbiddenKeysWithCode(value, code, options) {
  const hit = detectForbiddenKeys(value, options);
  if (hit) return { ...hit, code };
  return null;
}

/** 金额唯一事实：priceCents 必须是整数，且不得出现 priceText/totalCents。 */
function detectMoneyViolations(value, path) {
  const base = path || '$';
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = detectMoneyViolations(value[index], base + '[' + index + ']');
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    const childPath = base === '$' ? key : base + '.' + key;
    if (key === 'priceText' || key === 'totalCents') {
      return fail('MONEY_SECOND_SOURCE', childPath, '金额唯一事实为整数分 priceCents，禁止 ' + key);
    }
    if (key === 'priceCents' && !Number.isInteger(value[key])) {
      return fail('PRICE_NOT_INTEGER', childPath, 'priceCents 必须是整数分', { value: String(value[key]) });
    }
    const hit = detectMoneyViolations(value[key], childPath);
    if (hit) return hit;
  }
  return null;
}

function checkJsonSize(value, path) {
  if (byteLength(value) > MAX_JSON_BYTES) {
    return fail('PAYLOAD_TOO_LARGE', path || '$', 'JSON 超过 64 KB 上限', { bytes: byteLength(value) });
  }
  return null;
}

/**
 * 归一化 Plan 顶层 `presentationTokens`：
 * - 缺省或非法值一律回落 `md`（契约 2.2.2：缺省等价于默认值）；
 * - 输出固定两键，未知键被丢弃，保证摘要与导出结果稳定。
 */
function normalizePresentationTokens(tokens) {
  const normalized = { ...DEFAULT_PRESENTATION_TOKENS };
  if (!isPlainObject(tokens)) return normalized;
  for (const key of PLAN_SIZE_TOKEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(tokens, key) && SIZE_STEPS.includes(tokens[key])) {
      normalized[key] = tokens[key];
    }
  }
  return normalized;
}

/**
 * 校验可选字段 `presentationTokens`（C-PLAN-PRESENTATION@1）。
 * 只在字段存在时校验；缺省时 Composer 必须继续放行。
 */
function validatePresentationTokens(tokens) {
  if (tokens === undefined) return null;
  if (!isPlainObject(tokens)) return fail('FIELD_TYPE', 'presentationTokens', 'presentationTokens 必须是对象');
  for (const key of Object.keys(tokens)) {
    if (!PLAN_SIZE_TOKEN_KEYS.includes(key)) {
      return fail(
        'PLAN_FIELD_FORBIDDEN',
        'presentationTokens.' + key,
        'presentationTokens 只允许 homeHeroSize、productCardSize，禁止字段：' + key,
        { key },
      );
    }
  }
  for (const key of PLAN_SIZE_TOKEN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) continue;
    if (!SIZE_STEPS.includes(tokens[key])) {
      return fail(
        'PRESENTATION_SIZE_INVALID',
        'presentationTokens.' + key,
        '尺寸档位只能是 sm|md|lg：' + String(tokens[key]),
        { key, value: String(tokens[key]), allowed: [...SIZE_STEPS] },
      );
    }
  }
  return null;
}

/** 归一化可选字段 `slotOrder`：只保留三键，缺省返回空数组（表示沿用声明落位）。 */
function normalizeSlotOrder(slotOrder) {
  if (!Array.isArray(slotOrder)) return [];
  return slotOrder
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      featureId: typeof entry.featureId === 'string' ? entry.featureId : '',
      pageId: typeof entry.pageId === 'string' ? entry.pageId : '',
      slotId: typeof entry.slotId === 'string' ? entry.slotId : '',
    }));
}

/** 取插槽对应的导出配置键；未知插槽返回 null。 */
function presentationSlotDataKey(slotId) {
  return Object.prototype.hasOwnProperty.call(PRESENTATION_SLOT_DATA_KEYS, slotId)
    ? PRESENTATION_SLOT_DATA_KEYS[slotId]
    : null;
}

/** 插槽的归属页面；未知插槽返回 null。 */
function presentationSlotPageId(slotId) {
  return Object.prototype.hasOwnProperty.call(PRESENTATION_SLOT_PAGE_IDS, slotId)
    ? PRESENTATION_SLOT_PAGE_IDS[slotId]
    : null;
}

/**
 * 校验可选字段 `slotOrder`（C-PLAN-PRESENTATION@1）。
 *
 * 规则：
 * 1. 缺省放行；存在时必须是数组，条目只允许 `featureId|pageId|slotId`。
 * 2. 必须是当前 Plan 已占用 Feature 的完整排列：每个 featureId 恰好一次。
 * 3. 目标 `pageId+slotId` 必须是落位表中的合法组合，且同一目标插槽不得重复。
 * 4. Base 是否真的声明该插槽、`accepts` 是否匹配，由 `resolve` 校验（SLOT_UNKNOWN / SLOT_TYPE_REJECTED）。
 */
function validateSlotOrder(slotOrder, features) {
  if (slotOrder === undefined) return null;
  if (!Array.isArray(slotOrder)) return fail('FIELD_TYPE', 'slotOrder', 'slotOrder 必须是数组');

  const featureIds = (Array.isArray(features) ? features : [])
    .map((feature) => (isPlainObject(feature) ? feature.id : null))
    .filter((id) => typeof id === 'string');
  const featureIdSet = new Set(featureIds);
  const seenFeatureIds = new Set();
  const seenTargets = new Set();

  for (let index = 0; index < slotOrder.length; index += 1) {
    const entry = slotOrder[index];
    const entryPath = 'slotOrder[' + index + ']';
    if (!isPlainObject(entry)) return fail('FIELD_TYPE', entryPath, 'slotOrder 条目必须是对象');

    for (const key of Object.keys(entry)) {
      if (!['featureId', 'pageId', 'slotId'].includes(key)) {
        return fail('PLAN_FIELD_FORBIDDEN', entryPath + '.' + key, 'slotOrder 条目只允许 featureId、pageId、slotId，禁止字段：' + key, { key });
      }
    }

    const missing = requiredFields(entry, ['featureId', 'pageId', 'slotId'], entryPath);
    if (missing) return missing;

    if (typeof entry.featureId !== 'string') {
      return fail('FIELD_TYPE', entryPath + '.featureId', 'featureId 必须是字符串');
    }
    if (!featureIdSet.has(entry.featureId)) {
      return fail('PLAN_SLOT_ORDER_INVALID', entryPath + '.featureId', 'slotOrder 引用了 Plan 中不存在的 Feature：' + entry.featureId, {
        featureId: entry.featureId,
        available: featureIds,
      });
    }
    if (seenFeatureIds.has(entry.featureId)) {
      return fail('PLAN_SLOT_ORDER_INVALID', entryPath + '.featureId', 'slotOrder 中 Feature 重复：' + entry.featureId, {
        featureId: entry.featureId,
      });
    }
    seenFeatureIds.add(entry.featureId);

    if (typeof entry.pageId !== 'string' || typeof entry.slotId !== 'string') {
      return fail('FIELD_TYPE', entryPath, 'pageId 与 slotId 必须是字符串');
    }
    const page = presentationSlotPageId(entry.slotId);
    if (!page || page !== entry.pageId) {
      return fail(
        'PLAN_SLOT_TARGET_INVALID',
        entryPath + '.slotId',
        'slotOrder 目标插槽不合法：' + entry.pageId + '#' + entry.slotId,
        { pageId: entry.pageId, slotId: entry.slotId, allowed: PRESENTATION_SLOT_IDS },
      );
    }
    const target = entry.pageId + '#' + entry.slotId;
    if (seenTargets.has(target)) {
      return fail('PLAN_SLOT_TARGET_INVALID', entryPath + '.slotId', 'slotOrder 目标插槽重复：' + target, {
        pageId: entry.pageId,
        slotId: entry.slotId,
      });
    }
    seenTargets.add(target);
  }

  if (seenFeatureIds.size !== featureIds.length) {
    const missingIds = featureIds.filter((id) => !seenFeatureIds.has(id));
    return fail('PLAN_SLOT_ORDER_INVALID', 'slotOrder', 'slotOrder 必须是当前已占用 Feature 的完整排列，缺少：' + missingIds.join('、'), {
      missing: missingIds,
    });
  }

  return null;
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) return fail('PLAN_SCHEMA_UNSUPPORTED', '$', 'Plan 必须是对象');
  if (plan.schemaVersion !== SCHEMA_VERSIONS.composition) {
    return fail('PLAN_SCHEMA_UNSUPPORTED', 'schemaVersion', 'Plan 版本不受支持：' + plan.schemaVersion, {
      supported: SCHEMA_VERSIONS.composition,
    });
  }
  const sizeError = checkJsonSize(plan, '$');
  if (sizeError) return sizeError;

  const forbidden = detectForbiddenKeysWithCode(plan, 'PLAN_FIELD_FORBIDDEN', { keys: PLAN_FORBIDDEN });
  if (forbidden) return forbidden;

  const missing = requiredFields(plan, [
    'schemaVersion',
    'planId',
    'planVersion',
    'baseTemplate',
    'registryVersion',
    'pages',
    'features',
    'components',
    'themeTokens',
    'apiBinding',
    'storeProfile',
    'previewOnlyAck',
    'degradations',
  ], '$');
  if (missing) return missing;

  let error = checkId(plan.planId, 'planId', 'planId');
  if (error) return error;
  error = checkExactVersion(plan.planVersion, 'planVersion');
  if (error) return error;

  // 可选 FrontendPack（受控视图包）：只允许 id/version 精确引用，禁止内联源码。
  if (plan.frontendPack !== undefined) {
    if (!isPlainObject(plan.frontendPack)) return fail('FIELD_TYPE', 'frontendPack', 'frontendPack 必须是对象');
    for (const key of Object.keys(plan.frontendPack)) {
      if (key !== 'id' && key !== 'version') {
        return fail('PLAN_FIELD_FORBIDDEN', 'frontendPack.' + key, 'frontendPack 只允许 id 与 version', { key });
      }
    }
    error = requiredFields(plan.frontendPack, ['id', 'version'], 'frontendPack');
    if (error) return error;
    error = checkId(plan.frontendPack.id, 'frontendPack.id', 'FrontendPack ID');
    if (error) return error;
    error = checkExactVersion(plan.frontendPack.version, 'frontendPack.version');
    if (error) return error;
  }

  if (!isPlainObject(plan.baseTemplate)) return fail('FIELD_TYPE', 'baseTemplate', '应为对象');
  error = requiredFields(plan.baseTemplate, ['id', 'version'], 'baseTemplate');
  if (error) return error;
  error = checkId(plan.baseTemplate.id, 'baseTemplate.id', 'Base ID');
  if (error) return error;
  error = checkExactVersion(plan.baseTemplate.version, 'baseTemplate.version');
  if (error) return error;

  error = checkString(plan.registryVersion, 'registryVersion', { pattern: REGISTRY_VERSION_PATTERN });
  if (error) return error;

  if (!Array.isArray(plan.pages) || plan.pages.length === 0) {
    return fail('FIELD_TYPE', 'pages', 'pages 必须是非空数组');
  }
  const pageIds = new Set();
  for (let index = 0; index < plan.pages.length; index += 1) {
    const page = plan.pages[index];
    const pagePath = 'pages[' + index + ']';
    if (!isPlainObject(page)) return fail('FIELD_TYPE', pagePath, '页面必须是对象');
    error = checkId(page.pageId, pagePath + '.pageId', 'pageId');
    if (error) return error;
    if (pageIds.has(page.pageId)) {
      return fail('PAGE_DUPLICATED', pagePath + '.pageId', '页面重复：' + page.pageId, { pageId: page.pageId });
    }
    pageIds.add(page.pageId);
    if (page.path !== undefined) {
      error = validatePath(page.path, { path: pagePath + '.path' });
      if (error) return error;
    }
    if (page.enabled !== undefined && typeof page.enabled !== 'boolean') {
      return fail('FIELD_TYPE', pagePath + '.enabled', 'enabled 必须是布尔值');
    }
  }

  if (!Array.isArray(plan.features)) return fail('FIELD_TYPE', 'features', 'features 必须是数组');
  for (let index = 0; index < plan.features.length; index += 1) {
    const feature = plan.features[index];
    const featurePath = 'features[' + index + ']';
    if (!isPlainObject(feature)) return fail('FIELD_TYPE', featurePath, 'feature 必须是对象');
    error = requiredFields(feature, ['id', 'version', 'slots'], featurePath);
    if (error) return error;
    error = checkId(feature.id, featurePath + '.id', 'feature id');
    if (error) return error;
    error = checkExactVersion(feature.version, featurePath + '.version');
    if (error) return error;
    if (!Array.isArray(feature.slots)) return fail('FIELD_TYPE', featurePath + '.slots', 'slots 必须是数组');
    for (let slotIndex = 0; slotIndex < feature.slots.length; slotIndex += 1) {
      const slot = feature.slots[slotIndex];
      const slotPath = featurePath + '.slots[' + slotIndex + ']';
      if (!isPlainObject(slot)) return fail('FIELD_TYPE', slotPath, '插槽分配必须是对象');
      error = requiredFields(slot, ['slotId', 'dataKey'], slotPath);
      if (error) return error;
      error = checkId(slot.slotId, slotPath + '.slotId', 'slotId');
      if (error) return error;
      error = checkString(slot.dataKey, slotPath + '.dataKey', { pattern: /^[a-z][a-zA-Z0-9]*$/ });
      if (error) return error;
      if (slot.props !== undefined && !isPlainObject(slot.props)) {
        return fail('FIELD_TYPE', slotPath + '.props', 'props 必须是对象');
      }
    }
  }

  // 可选展示字段（C-PLAN-PRESENTATION@1）：缺省时保持向后兼容，存在时必须合法。
  const presentationError = validatePresentationTokens(plan.presentationTokens);
  if (presentationError) return presentationError;
  const slotOrderError = validateSlotOrder(plan.slotOrder, plan.features);
  if (slotOrderError) return slotOrderError;

  if (!Array.isArray(plan.components)) return fail('FIELD_TYPE', 'components', 'components 必须是数组');
  for (let index = 0; index < plan.components.length; index += 1) {
    const component = plan.components[index];
    const componentPath = 'components[' + index + ']';
    if (!isPlainObject(component)) return fail('FIELD_TYPE', componentPath, 'component 必须是对象');
    error = requiredFields(component, ['id', 'version'], componentPath);
    if (error) return error;
    error = checkId(component.id, componentPath + '.id', 'component id');
    if (error) return error;
    error = checkExactVersion(component.version, componentPath + '.version');
    if (error) return error;
  }

  if (!isPlainObject(plan.themeTokens)) return fail('FIELD_TYPE', 'themeTokens', 'themeTokens 必须是对象');
  for (const key of ['pageBackground', 'primaryColor', 'accentColor', 'textColor']) {
    error = checkColor(plan.themeTokens[key], 'themeTokens.' + key);
    if (error) return error;
  }

  if (!isPlainObject(plan.apiBinding)) return fail('FIELD_TYPE', 'apiBinding', 'apiBinding 必须是对象');
  if (plan.apiBinding.contract !== 'storefront.v1') {
    return fail('API_CONTRACT_INCOMPATIBLE', 'apiBinding.contract', 'API 契约不受支持：' + plan.apiBinding.contract);
  }
  if (plan.apiBinding.baseUrl !== undefined) {
    error = checkString(plan.apiBinding.baseUrl, 'apiBinding.baseUrl', { maxLength: 200 });
    if (error) return error;
  }

  if (!isPlainObject(plan.storeProfile)) return fail('FIELD_TYPE', 'storeProfile', 'storeProfile 必须是对象');
  error = checkString(plan.storeProfile.name, 'storeProfile.name', { maxLength: 48 });
  if (error) return error;

  if (typeof plan.previewOnlyAck !== 'boolean') {
    return fail('FIELD_TYPE', 'previewOnlyAck', 'previewOnlyAck 必须是布尔值');
  }

  if (!Array.isArray(plan.degradations)) return fail('FIELD_TYPE', 'degradations', 'degradations 必须是数组');
  for (let index = 0; index < plan.degradations.length; index += 1) {
    const degradation = plan.degradations[index];
    const degradationPath = 'degradations[' + index + ']';
    if (!isPlainObject(degradation)) return fail('FIELD_TYPE', degradationPath, '降级声明必须是对象');
    error = requiredFields(degradation, ['assetId', 'reason'], degradationPath);
    if (error) return error;
    error = checkString(degradation.reason, degradationPath + '.reason', { maxLength: 200 });
    if (error) return error;
  }

  const moneyError = detectMoneyViolations(plan, '$');
  if (moneyError) return moneyError;

  return ok();
}

function validateManifest(manifest, options) {
  const opts = options || {};
  if (!isPlainObject(manifest)) return fail('MANIFEST_SCHEMA_UNSUPPORTED', '$', 'Manifest 必须是对象');
  if (manifest.schemaVersion !== SCHEMA_VERSIONS.manifest) {
    return fail('MANIFEST_SCHEMA_UNSUPPORTED', 'schemaVersion', 'Manifest 版本不受支持：' + manifest.schemaVersion);
  }
  const sizeError = checkJsonSize(manifest, '$');
  if (sizeError) return sizeError;

  const forbidden = detectForbiddenKeysWithCode(manifest, 'MANIFEST_FIELD_FORBIDDEN', { keys: PLAN_FORBIDDEN });
  if (forbidden) return forbidden;

  const missing = requiredFields(manifest, [
    'schemaVersion',
    'identity',
    'kind',
    'displayName',
    'entry',
    'interface',
    'boundary',
    'compatibility',
    'requiredPages',
    'requiresSlots',
    'dependencies',
    'conflicts',
    'preview',
    'release',
  ], '$');
  if (missing) return missing;

  if (!isPlainObject(manifest.identity)) return fail('FIELD_TYPE', 'identity', 'identity 必须是对象');
  let error = requiredFields(manifest.identity, ['id', 'version'], 'identity');
  if (error) return error;
  error = checkId(manifest.identity.id, 'identity.id', '资产 ID');
  if (error) return error;
  error = checkExactVersion(manifest.identity.version, 'identity.version');
  if (error) return error;

  if (!['ui-block', 'feature-pack'].includes(manifest.kind)) {
    return fail('MANIFEST_KIND_INVALID', 'kind', 'kind 必须是 ui-block 或 feature-pack');
  }
  error = checkString(manifest.displayName, 'displayName', { maxLength: 48 });
  if (error) return error;

  if (!isPlainObject(manifest.entry)) return fail('FIELD_TYPE', 'entry', 'entry 必须是对象');
  error = requiredFields(manifest.entry, ['path', 'files', 'assets'], 'entry');
  if (error) return error;
  error = validatePath(manifest.entry.path, { path: 'entry.path' });
  if (error) return error;
  if (!Array.isArray(manifest.entry.files) || manifest.entry.files.length === 0) {
    return fail('ENTRY_MISSING', 'entry.files', 'entry.files 必须是非空数组');
  }
  for (let index = 0; index < manifest.entry.files.length; index += 1) {
    error = validatePath(manifest.entry.files[index], { path: 'entry.files[' + index + ']' });
    if (error) return error;
  }
  if (!Array.isArray(manifest.entry.assets)) return fail('FIELD_TYPE', 'entry.assets', 'entry.assets 必须是数组');
  for (let index = 0; index < manifest.entry.assets.length; index += 1) {
    error = validatePath(manifest.entry.assets[index], { path: 'entry.assets[' + index + ']' });
    if (error) return error;
  }

  if (!isPlainObject(manifest.interface)) return fail('FIELD_TYPE', 'interface', 'interface 必须是对象');
  error = requiredFields(manifest.interface, ['props', 'events'], 'interface');
  if (error) return error;
  if (!Array.isArray(manifest.interface.props)) return fail('FIELD_TYPE', 'interface.props', 'props 必须是数组');
  for (let index = 0; index < manifest.interface.props.length; index += 1) {
    const prop = manifest.interface.props[index];
    const propPath = 'interface.props[' + index + ']';
    if (!isPlainObject(prop)) return fail('FIELD_TYPE', propPath, 'prop 必须是对象');
    error = requiredFields(prop, ['name', 'type', 'required'], propPath);
    if (error) return error;
    error = checkString(prop.name, propPath + '.name', { pattern: /^[a-zA-Z][a-zA-Z0-9]*$/ });
    if (error) return error;
    if (!['string', 'number', 'boolean', 'array', 'object'].includes(prop.type)) {
      return fail('FIELD_ENUM', propPath + '.type', 'prop 类型不支持：' + prop.type);
    }
    if (typeof prop.required !== 'boolean') return fail('FIELD_TYPE', propPath + '.required', 'required 必须是布尔值');
  }
  if (!Array.isArray(manifest.interface.events)) return fail('FIELD_TYPE', 'interface.events', 'events 必须是数组');
  for (let index = 0; index < manifest.interface.events.length; index += 1) {
    const event = manifest.interface.events[index];
    const eventPath = 'interface.events[' + index + ']';
    if (!isPlainObject(event)) return fail('FIELD_TYPE', eventPath, 'event 必须是对象');
    error = requiredFields(event, ['name', 'description'], eventPath);
    if (error) return error;
    error = checkString(event.name, eventPath + '.name', { pattern: /^[a-z][a-zA-Z0-9]*$/ });
    if (error) return error;
    error = checkString(event.description, eventPath + '.description', { maxLength: 200 });
    if (error) return error;
  }

  if (!isPlainObject(manifest.boundary)) return fail('FIELD_TYPE', 'boundary', 'boundary 必须是对象');
  for (const key of ['allowNetwork', 'allowRoutes', 'allowGlobalState', 'allowServices']) {
    if (typeof manifest.boundary[key] !== 'boolean') {
      return fail('FIELD_TYPE', 'boundary.' + key, 'boundary.' + key + ' 必须是布尔值');
    }
  }
  if (manifest.kind === 'ui-block') {
    for (const key of ['allowNetwork', 'allowRoutes', 'allowGlobalState', 'allowServices']) {
      if (manifest.boundary[key] !== false) {
        return fail('COMPONENT_BOUNDARY_VIOLATION', 'boundary.' + key, 'UI Block 的 boundary.' + key + ' 必须为 false');
      }
    }
  }

  if (!isPlainObject(manifest.compatibility)) return fail('FIELD_TYPE', 'compatibility', 'compatibility 必须是对象');
  error = requiredFields(manifest.compatibility, ['baseRange', 'minWechatLib', 'apiContract'], 'compatibility');
  if (error) return error;
  error = checkString(manifest.compatibility.baseRange, 'compatibility.baseRange', {
    pattern: /^\^\d+\.\d+\.\d+$/,
    patternCode: 'BASE_VERSION_INCOMPATIBLE',
  });
  if (error) return error;
  error = checkExactVersion(manifest.compatibility.minWechatLib, 'compatibility.minWechatLib');
  if (error) return error;
  if (manifest.compatibility.apiContract !== 'storefront.v1') {
    return fail('API_CONTRACT_INCOMPATIBLE', 'compatibility.apiContract', 'API 契约不受支持');
  }

  for (const key of ['requiredPages', 'requiresSlots', 'conflicts']) {
    if (!Array.isArray(manifest[key])) return fail('FIELD_TYPE', key, key + ' 必须是数组');
  }
  if (!Array.isArray(manifest.dependencies)) return fail('FIELD_TYPE', 'dependencies', 'dependencies 必须是数组');
  for (let index = 0; index < manifest.dependencies.length; index += 1) {
    const dep = manifest.dependencies[index];
    const depPath = 'dependencies[' + index + ']';
    if (!isPlainObject(dep)) return fail('FIELD_TYPE', depPath, '依赖必须是对象');
    error = requiredFields(dep, ['id', 'version'], depPath);
    if (error) return error;
    error = checkExactVersion(dep.version, depPath + '.version');
    if (error) return error;
  }

  if (!isPlainObject(manifest.preview)) return fail('FIELD_TYPE', 'preview', 'preview 必须是对象');
  error = requiredFields(manifest.preview, ['dir', 'kinds'], 'preview');
  if (error) return error;
  error = validatePath(manifest.preview.dir, { path: 'preview.dir' });
  if (error) return error;
  if (!Array.isArray(manifest.preview.kinds)) return fail('FIELD_TYPE', 'preview.kinds', 'preview.kinds 必须是数组');
  for (const kind of ['normal', 'empty', 'error', 'long']) {
    if (!manifest.preview.kinds.includes(kind)) {
      return fail('PREVIEW_DATA_MISSING', 'preview.kinds', '缺少预览类型：' + kind, { missing: kind });
    }
  }

  if (!isPlainObject(manifest.release)) return fail('FIELD_TYPE', 'release', 'release 必须是对象');
  error = requiredFields(manifest.release, ['stage', 'knownLimits'], 'release');
  if (error) return error;
  if (!['online-ready', 'preview-only', 'blocked', 'candidate'].includes(manifest.release.stage)) {
    return fail('FIELD_ENUM', 'release.stage', 'release.stage 不支持：' + manifest.release.stage);
  }
  if (!Array.isArray(manifest.release.knownLimits)) {
    return fail('FIELD_TYPE', 'release.knownLimits', 'knownLimits 必须是数组');
  }

  if (opts.expectedKind && manifest.kind !== opts.expectedKind) {
    return fail('MANIFEST_KIND_INVALID', 'kind', '资产类型必须为 ' + opts.expectedKind);
  }

  return ok();
}

function validateFrontendPackManifest(manifest) {
  if (!isPlainObject(manifest)) return fail('FRONTEND_PACK_MANIFEST_UNSUPPORTED', '$', 'FrontendPack Manifest 必须是对象');
  if (manifest.schemaVersion !== SCHEMA_VERSIONS.frontendPack) {
    return fail('FRONTEND_PACK_MANIFEST_UNSUPPORTED', 'schemaVersion', 'FrontendPack Manifest 版本不受支持：' + manifest.schemaVersion);
  }
  const sizeError = checkJsonSize(manifest, '$');
  if (sizeError) return sizeError;

  const forbidden = detectForbiddenKeysWithCode(manifest, 'FRONTEND_PACK_FIELD_FORBIDDEN', { keys: PLAN_FORBIDDEN });
  if (forbidden) return forbidden;

  const missing = requiredFields(manifest, [
    'schemaVersion',
    'identity',
    'kind',
    'displayName',
    'entry',
    'pages',
    'boundary',
    'compatibility',
    'requiresSlots',
    'preview',
    'release',
  ], '$');
  if (missing) return missing;

  if (!isPlainObject(manifest.identity)) return fail('FIELD_TYPE', 'identity', 'identity 必须是对象');
  let error = requiredFields(manifest.identity, ['id', 'version'], 'identity');
  if (error) return error;
  error = checkId(manifest.identity.id, 'identity.id', 'FrontendPack ID');
  if (error) return error;
  error = checkExactVersion(manifest.identity.version, 'identity.version');
  if (error) return error;

  if (manifest.kind !== 'frontend-pack') {
    return fail('FRONTEND_PACK_MANIFEST_INVALID', 'kind', 'kind 必须是 frontend-pack');
  }
  error = checkString(manifest.displayName, 'displayName', { maxLength: 48 });
  if (error) return error;

  if (!isPlainObject(manifest.entry)) return fail('FIELD_TYPE', 'entry', 'entry 必须是对象');
  error = requiredFields(manifest.entry, ['path', 'files', 'assets'], 'entry');
  if (error) return error;
  error = validatePath(manifest.entry.path, { path: 'entry.path' });
  if (error) return error;
  if (!Array.isArray(manifest.entry.files) || manifest.entry.files.length === 0) {
    return fail('ENTRY_MISSING', 'entry.files', 'entry.files 必须是非空数组');
  }
  const declaredFiles = new Set();
  for (let index = 0; index < manifest.entry.files.length; index += 1) {
    const file = manifest.entry.files[index];
    error = validatePath(file, { path: 'entry.files[' + index + ']' });
    if (error) return error;
    if (!FRONTEND_PACK_PAGE_FILE.test(file)) {
      return fail('FRONTEND_PACK_SOURCE_FORBIDDEN', 'entry.files[' + index + ']', 'FrontendPack 只允许 pages/<pageId>/index.wxml|wxss|json：' + file);
    }
    declaredFiles.add(file);
  }
  if (!Array.isArray(manifest.entry.assets)) return fail('FIELD_TYPE', 'entry.assets', 'entry.assets 必须是数组');
  for (let index = 0; index < manifest.entry.assets.length; index += 1) {
    error = validatePath(manifest.entry.assets[index], { path: 'entry.assets[' + index + ']' });
    if (error) return error;
  }

  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    return fail('FIELD_TYPE', 'pages', 'pages 必须是非空数组');
  }
  const seenPages = new Set();
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const pageId = manifest.pages[index];
    error = checkId(pageId, 'pages[' + index + ']', 'pageId');
    if (error) return error;
    if (seenPages.has(pageId)) return fail('PAGE_DUPLICATED', 'pages[' + index + ']', '页面重复：' + pageId);
    seenPages.add(pageId);
    for (const extension of ['wxml', 'wxss', 'json']) {
      const expected = 'pages/' + pageId + '/index.' + extension;
      if (!declaredFiles.has(expected)) {
        return fail('FRONTEND_PACK_PAGE_FILE_MISSING', 'entry.files', '页面缺少视图文件：' + expected);
      }
    }
  }

  if (!isPlainObject(manifest.compatibility)) return fail('FIELD_TYPE', 'compatibility', 'compatibility 必须是对象');
  error = requiredFields(manifest.compatibility, ['baseRange', 'minWechatLib', 'apiContract'], 'compatibility');
  if (error) return error;
  error = checkString(manifest.compatibility.baseRange, 'compatibility.baseRange', {
    pattern: /^\^\d+\.\d+\.\d+$/,
    patternCode: 'BASE_VERSION_INCOMPATIBLE',
  });
  if (error) return error;
  error = checkExactVersion(manifest.compatibility.minWechatLib, 'compatibility.minWechatLib');
  if (error) return error;
  if (manifest.compatibility.apiContract !== 'storefront.v1') {
    return fail('API_CONTRACT_INCOMPATIBLE', 'compatibility.apiContract', 'API 契约不受支持');
  }

  if (!isPlainObject(manifest.boundary)) return fail('FIELD_TYPE', 'boundary', 'boundary 必须是对象');
  for (const key of ['allowNetwork', 'allowRoutes', 'allowGlobalState', 'allowServices']) {
    if (manifest.boundary[key] !== false) {
      return fail('FRONTEND_PACK_BOUNDARY_VIOLATION', 'boundary.' + key, 'FrontendPack 的 boundary.' + key + ' 必须为 false');
    }
  }

  if (!Array.isArray(manifest.requiresSlots)) return fail('FIELD_TYPE', 'requiresSlots', 'requiresSlots 必须是数组');
  for (let index = 0; index < manifest.requiresSlots.length; index += 1) {
    error = checkId(manifest.requiresSlots[index], 'requiresSlots[' + index + ']', 'slotId');
    if (error) return error;
    if (!PRESENTATION_SLOT_IDS.includes(manifest.requiresSlots[index])) {
      return fail('FRONTEND_PACK_SLOT_UNKNOWN', 'requiresSlots[' + index + ']', '未知插槽：' + manifest.requiresSlots[index]);
    }
  }

  if (!isPlainObject(manifest.preview)) return fail('FIELD_TYPE', 'preview', 'preview 必须是对象');
  error = requiredFields(manifest.preview, ['dir', 'kinds'], 'preview');
  if (error) return error;
  error = validatePath(manifest.preview.dir, { path: 'preview.dir' });
  if (error) return error;
  if (!Array.isArray(manifest.preview.kinds)) return fail('FIELD_TYPE', 'preview.kinds', 'preview.kinds 必须是数组');
  for (const kind of ['normal', 'empty', 'error', 'long']) {
    if (!manifest.preview.kinds.includes(kind)) {
      return fail('PREVIEW_DATA_MISSING', 'preview.kinds', '缺少预览类型：' + kind, { missing: kind });
    }
  }

  if (!isPlainObject(manifest.release)) return fail('FIELD_TYPE', 'release', 'release 必须是对象');
  error = requiredFields(manifest.release, ['stage', 'knownLimits'], 'release');
  if (error) return error;
  if (!['online-ready', 'preview-only', 'blocked', 'candidate'].includes(manifest.release.stage)) {
    return fail('FIELD_ENUM', 'release.stage', 'release.stage 不支持：' + manifest.release.stage);
  }
  if (!Array.isArray(manifest.release.knownLimits)) {
    return fail('FIELD_TYPE', 'release.knownLimits', 'knownLimits 必须是数组');
  }

  return ok();
}

function validateBaseManifest(manifest) {
  if (!isPlainObject(manifest)) return fail('BASE_MANIFEST_UNSUPPORTED', '$', 'Base Manifest 必须是对象');
  if (manifest.schemaVersion !== SCHEMA_VERSIONS.baseManifest) {
    return fail('BASE_MANIFEST_UNSUPPORTED', 'schemaVersion', 'Base Manifest 版本不受支持：' + manifest.schemaVersion);
  }
  const missing = requiredFields(manifest, [
    'schemaVersion',
    'identity',
    'entry',
    'pages',
    'themeTokens',
    'layouts',
    'services',
    'builtinComponents',
    'excludedCapabilities',
    'storeConfigSchema',
    'slots',
    'release',
  ], '$');
  if (missing) return missing;

  if (!isPlainObject(manifest.identity)) return fail('FIELD_TYPE', 'identity', 'identity 必须是对象');
  let error = requiredFields(manifest.identity, ['id', 'version'], 'identity');
  if (error) return error;
  error = checkId(manifest.identity.id, 'identity.id', 'Base ID');
  if (error) return error;
  error = checkExactVersion(manifest.identity.version, 'identity.version');
  if (error) return error;

  if (!isPlainObject(manifest.entry)) return fail('FIELD_TYPE', 'entry', 'entry 必须是对象');
  error = requiredFields(manifest.entry, ['root', 'files', 'assets'], 'entry');
  if (error) return error;
  error = validatePath(manifest.entry.root, { path: 'entry.root' });
  if (error) return error;
  for (const key of ['files', 'assets']) {
    if (!Array.isArray(manifest.entry[key])) return fail('FIELD_TYPE', 'entry.' + key, 'entry.' + key + ' 必须是数组');
    for (let index = 0; index < manifest.entry[key].length; index += 1) {
      error = validatePath(manifest.entry[key][index], { path: 'entry.' + key + '[' + index + ']' });
      if (error) return error;
    }
  }

  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    return fail('FIELD_TYPE', 'pages', 'pages 必须是非空数组');
  }
  const pageIds = new Set();
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const page = manifest.pages[index];
    const pagePath = 'pages[' + index + ']';
    if (!isPlainObject(page)) return fail('FIELD_TYPE', pagePath, '页面声明必须是对象');
    error = requiredFields(page, ['pageId', 'path', 'required', 'audience'], pagePath);
    if (error) return error;
    error = checkId(page.pageId, pagePath + '.pageId', 'pageId');
    if (error) return error;
    if (pageIds.has(page.pageId)) return fail('PAGE_DUPLICATED', pagePath + '.pageId', '页面重复：' + page.pageId);
    pageIds.add(page.pageId);
    error = validatePath(page.path, { path: pagePath + '.path' });
    if (error) return error;
    if (!['customer', 'merchant'].includes(page.audience)) {
      return fail('FIELD_ENUM', pagePath + '.audience', 'audience 只能是 customer 或 merchant');
    }
  }

  if (!Array.isArray(manifest.themeTokens) || manifest.themeTokens.length < 4) {
    return fail('THEME_TOKEN_MISSING', 'themeTokens', '主题 Token 至少 4 个');
  }
  for (let index = 0; index < manifest.themeTokens.length; index += 1) {
    const token = manifest.themeTokens[index];
    const tokenPath = 'themeTokens[' + index + ']';
    if (!isPlainObject(token)) return fail('FIELD_TYPE', tokenPath, 'Token 必须是对象');
    error = requiredFields(token, ['key', 'cssVar', 'type', 'required'], tokenPath);
    if (error) return error;
    error = checkString(token.cssVar, tokenPath + '.cssVar', { pattern: /^--store-[a-z0-9-]+$/ });
    if (error) return error;
    if (!['color'].includes(token.type)) return fail('FIELD_ENUM', tokenPath + '.type', 'Token 类型只支持 color');
    if (typeof token.required !== 'boolean') return fail('FIELD_TYPE', tokenPath + '.required', 'required 必须是布尔值');
  }

  for (const key of ['layouts', 'services', 'builtinComponents']) {
    if (!Array.isArray(manifest[key])) return fail('FIELD_TYPE', key, key + ' 必须是数组');
  }

  if (!Array.isArray(manifest.excludedCapabilities)) {
    return fail('FIELD_TYPE', 'excludedCapabilities', 'excludedCapabilities 必须是数组');
  }
  for (const capability of ['ad-slot', 'coupon', 'poster-carousel']) {
    if (!manifest.excludedCapabilities.includes(capability)) {
      return fail('BASE_CAPABILITY_LEAK', 'excludedCapabilities', 'Base 必须显式排除未内置能力：' + capability);
    }
  }

  if (manifest.storeConfigSchema !== SCHEMA_VERSIONS.storeGenerated) {
    return fail('STORE_CONFIG_SCHEMA_UNSUPPORTED', 'storeConfigSchema', 'Base 只接受 store.generated.v2');
  }

  const slotsResult = validateSlots({ schemaVersion: SCHEMA_VERSIONS.slots, slots: manifest.slots });
  if (!slotsResult.ok) return slotsResult;

  if (!isPlainObject(manifest.release)) return fail('FIELD_TYPE', 'release', 'release 必须是对象');
  error = requiredFields(manifest.release, ['stage', 'verifiedRecipes'], 'release');
  if (error) return error;

  return ok();
}

function validateSlots(document) {
  if (!isPlainObject(document)) return fail('SLOTS_SCHEMA_UNSUPPORTED', '$', 'slots 必须是对象');
  if (document.schemaVersion !== SCHEMA_VERSIONS.slots) {
    return fail('SLOTS_SCHEMA_UNSUPPORTED', 'schemaVersion', 'slots 版本不受支持');
  }
  let error = requiredFields(document, ['schemaVersion', 'slots'], '$');
  if (error) return error;
  if (!Array.isArray(document.slots)) return fail('FIELD_TYPE', 'slots', 'slots 必须是数组');
  const seen = new Set();
  for (let index = 0; index < document.slots.length; index += 1) {
    const slot = document.slots[index];
    const slotPath = 'slots[' + index + ']';
    if (!isPlainObject(slot)) return fail('FIELD_TYPE', slotPath, '插槽声明必须是对象');
    error = requiredFields(slot, ['slotId', 'pageId', 'maxItems', 'accepts', 'required'], slotPath);
    if (error) return error;
    error = checkId(slot.slotId, slotPath + '.slotId', 'slotId');
    if (error) return error;
    const identity = slot.pageId + '#' + slot.slotId;
    if (seen.has(identity)) return fail('SLOT_DUPLICATED', slotPath + '.slotId', '同页插槽重复：' + slot.slotId);
    seen.add(identity);
    if (!Number.isInteger(slot.maxItems) || slot.maxItems < 0 || slot.maxItems > 5) {
      return fail('FIELD_TYPE', slotPath + '.maxItems', 'maxItems 必须是 0–5 的整数');
    }
    if (!Array.isArray(slot.accepts) || slot.accepts.length === 0) {
      return fail('FIELD_TYPE', slotPath + '.accepts', 'accepts 必须是非空数组');
    }
    for (const kind of slot.accepts) {
      if (!['ui-block', 'feature-pack'].includes(kind)) {
        return fail('FIELD_ENUM', slotPath + '.accepts', '插槽不接受资产类型：' + kind);
      }
    }
    if (typeof slot.required !== 'boolean') return fail('FIELD_TYPE', slotPath + '.required', 'required 必须是布尔值');
  }
  return ok();
}

function validateLock(lock) {
  if (!isPlainObject(lock)) return fail('LOCK_SCHEMA_UNSUPPORTED', '$', 'Lock 必须是对象');
  if (lock.lockVersion !== SCHEMA_VERSIONS.lock) {
    return fail('LOCK_SCHEMA_UNSUPPORTED', 'lockVersion', 'Lock 版本不受支持：' + lock.lockVersion);
  }
  const fields = [
    'lockVersion',
    'planDigest',
    'base',
    'registryVersion',
    'registryDigest',
    'features',
    'resolvedDependencies',
    'composerVersion',
    'apiContract',
    'capabilitySet',
    'sourceDigests',
    'outputDigest',
    'backendVersions',
    'generatedAt',
  ];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(lock, field)) {
      return fail('LOCK_FIELD_MISSING', field, 'Lock 缺少必填项 ' + field, { field });
    }
  }
  let error = checkString(lock.planDigest, 'planDigest', { pattern: SHA_PATTERN, patternCode: 'LOCK_DIGEST_INVALID' });
  if (error) return error;
  error = checkString(lock.registryDigest, 'registryDigest', { pattern: SHA_PATTERN, patternCode: 'LOCK_DIGEST_INVALID' });
  if (error) return error;
  if (!isPlainObject(lock.base)) return fail('FIELD_TYPE', 'base', 'base 必须是对象');
  error = requiredFields(lock.base, ['id', 'version'], 'base');
  if (error) return error;
  error = checkExactVersion(lock.base.version, 'base.version');
  if (error) return error;
  if (!Array.isArray(lock.features)) return fail('FIELD_TYPE', 'features', 'features 必须是数组');
  if (!Array.isArray(lock.resolvedDependencies)) {
    return fail('FIELD_TYPE', 'resolvedDependencies', 'resolvedDependencies 必须是数组');
  }
  error = checkExactVersion(lock.composerVersion, 'composerVersion');
  if (error) return error;
  if (lock.apiContract !== 'storefront.v1') {
    return fail('API_CONTRACT_INCOMPATIBLE', 'apiContract', 'API 契约不受支持');
  }
  if (!Array.isArray(lock.capabilitySet)) return fail('FIELD_TYPE', 'capabilitySet', 'capabilitySet 必须是数组');
  if (!Array.isArray(lock.sourceDigests)) return fail('FIELD_TYPE', 'sourceDigests', 'sourceDigests 必须是数组');
  if (!isPlainObject(lock.outputDigest)) return fail('FIELD_TYPE', 'outputDigest', 'outputDigest 必须是对象');
  if (!isPlainObject(lock.backendVersions)) return fail('FIELD_TYPE', 'backendVersions', 'backendVersions 必须是对象');
  error = checkString(lock.generatedAt, 'generatedAt', {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  });
  if (error) return error;

  const forbidden = detectForbiddenKeysWithCode(lock, 'LOCK_FIELD_FORBIDDEN', { keys: PLAN_FORBIDDEN });
  if (forbidden) return forbidden;

  return ok();
}

function validateAllowedKeys(value, allowed, basePath) {
  if (!isPlainObject(value)) return fail('FIELD_TYPE', basePath, '应为对象');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return fail('STORE_CONFIG_FIELD_FORBIDDEN', basePath === '$' ? key : basePath + '.' + key, '导出配置禁止字段：' + key);
    }
  }
  return null;
}

function validateStoreConfig(config, options) {
  const opts = options || {};
  if (!isPlainObject(config)) return fail('STORE_CONFIG_SCHEMA_UNSUPPORTED', '$', '配置必须是对象');
  if (config.schemaVersion === 1) {
    return fail('STORE_CONFIG_SCHEMA_UNSUPPORTED', 'schemaVersion', 'store.generated v1 已不支持，请重新导出');
  }
  if (config.schemaVersion !== SCHEMA_VERSIONS.storeGenerated && config.schemaVersion !== 2) {
    return fail('STORE_CONFIG_SCHEMA_UNSUPPORTED', 'schemaVersion', '配置版本不受支持：' + config.schemaVersion);
  }
  const sizeError = checkJsonSize(config, '$');
  if (sizeError) return sizeError;

  const forbidden = detectForbiddenKeysWithCode(config, 'STORE_CONFIG_FIELD_FORBIDDEN', {
    keys: new Set(['priceText', 'totalCents', 'token', 'secret', 'password', 'apiKey', 'appSecret', 'openid', 'openId', 'template', 'icons']),
  });
  if (forbidden) return forbidden;

  const rootError = validateAllowedKeys(config, STORE_CONFIG_ALLOWED.root, '$');
  if (rootError) return rootError;

  for (const field of ['meta', 'store', 'api', 'catalog', 'fulfillmentOptions', 'theme', 'capabilities']) {
    if (!Object.prototype.hasOwnProperty.call(config, field)) {
      return fail('FIELD_MISSING', field, '导出配置缺少 ' + field);
    }
    const keyError = validateAllowedKeys(config[field], STORE_CONFIG_ALLOWED[field], field);
    if (keyError) return keyError;
  }

  const requiredMeta = ['configSchemaVersion', 'storeConfigVersion', 'catalogVersion', 'apiContractVersion', 'recipeId', 'recipeVersion', 'lockDigest', 'generatedAt', 'generatorVersion', 'planDigest', 'mode'];
  for (const field of requiredMeta) {
    if (!Object.prototype.hasOwnProperty.call(config.meta, field)) {
      return fail('FIELD_MISSING', 'meta.' + field, 'meta 缺少 ' + field);
    }
  }
  if (config.meta.configSchemaVersion !== 2) {
    return fail('STORE_CONFIG_SCHEMA_UNSUPPORTED', 'meta.configSchemaVersion', 'meta.configSchemaVersion 必须为 2');
  }
  for (const [field, value] of Object.entries(config.meta.versionGaps || {})) {
    if (!['storeConfigVersion', 'catalogVersion'].includes(field)) {
      return fail('STORE_CONFIG_FIELD_FORBIDDEN', 'meta.versionGaps.' + field, 'versionGaps 只允许版本字段');
    }
    if (value !== null && !Number.isInteger(value)) {
      return fail('FIELD_TYPE', 'meta.versionGaps.' + field, '版本必须是整数或 null');
    }
  }

  const storeId = config.store.id;
  if (config.meta.mode === 'production' && (typeof storeId !== 'string' || !storeId.trim())) {
    return fail('STORE_ID_REQUIRED', 'store.id', '生产导出必须提供真实 storeId');
  }
  if (storeId !== undefined && (typeof storeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(storeId))) {
    return fail('STORE_ID_INVALID', 'store.id', 'storeId 只能包含字母、数字、下划线与连字符');
  }
  if (config.meta.mode === 'production' && storeId === 'store-demo-001') {
    return fail('STORE_ID_DEMO_FORBIDDEN', 'store.id', '生产导出不能使用演示 storeId');
  }

  if (typeof config.api.baseUrl !== 'string' || !config.api.baseUrl) {
    return fail('FIELD_MISSING', 'api.baseUrl', 'api.baseUrl 不能为空');
  }
  if (config.meta.mode === 'production' && !/^https:\/\//i.test(config.api.baseUrl)) {
    return fail('API_BASE_URL_NOT_HTTPS', 'api.baseUrl', '生产模式 API 必须是 HTTPS');
  }
  if (config.api.contract !== 'storefront.v1') {
    return fail('API_CONTRACT_INCOMPATIBLE', 'api.contract', 'API 契约不受支持');
  }

  if (config.fulfillmentOptions.delivery !== false) {
    return fail('DELIVERY_NOT_SUPPORTED', 'fulfillmentOptions.delivery', '本项目不支持外送，delivery 必须为 false');
  }

  const themeKeys = STORE_CONFIG_ALLOWED.theme;
  for (const key of themeKeys) {
    const colorError = checkColor(config.theme[key], 'theme.' + key);
    if (colorError) return colorError;
  }

  const onlineReady = config.capabilities.onlineReady || [];
  const previewOnly = config.capabilities.previewOnly || [];
  const intersection = onlineReady.filter((item) => previewOnly.includes(item));
  if (intersection.length > 0) {
    return fail('CAPABILITY_INTERSECTION', 'capabilities', 'onlineReady 与 previewOnly 不允许交集', { intersection });
  }

  if (opts.mode && config.meta.mode !== opts.mode) {
    return fail('FIELD_ENUM', 'meta.mode', 'mode 必须为 ' + opts.mode);
  }

  const moneyError = detectMoneyViolations(config, '$');
  if (moneyError) return moneyError;

  return ok();
}

module.exports = {
  ok,
  fail,
  validatePlan,
  validateManifest,
  validateFrontendPackManifest,
  validateBaseManifest,
  validateSlots,
  validateLock,
  validateStoreConfig,
  validatePath,
  detectForbiddenKeys,
  detectForbiddenKeysWithCode,
  detectMoneyViolations,
  checkExactVersion,
  checkColor,
  checkId,
  checkJsonSize,
  byteLength,
  normalizePresentationTokens,
  normalizeSlotOrder,
  validatePresentationTokens,
  validateSlotOrder,
  presentationSlotDataKey,
  presentationSlotPageId,
  FORBIDDEN_KEYS,
  STORE_CONFIG_ALLOWED,
  ID_PATTERN,
  VERSION_PATTERN,
  COLOR_PATTERN,
  SIZE_STEPS,
  PLAN_SIZE_TOKEN_KEYS,
  DEFAULT_PRESENTATION_TOKENS,
  FRONTEND_PACK_PAGE_FILE,
  FRONTEND_PACK_PAGE_JSON_KEYS,
  PRESENTATION_SLOT_PAGE_IDS,
  PRESENTATION_SLOT_DATA_KEYS,
  PRESENTATION_SLOT_IDS,
  MAX_JSON_BYTES,
};