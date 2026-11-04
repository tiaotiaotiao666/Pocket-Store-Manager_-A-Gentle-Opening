/**
 * 展示补丁（agent-presentation-patch.v1）的纯逻辑实现。
 *
 * 契约来源：.codeartsdoer/plans/full-chain-agent/plan.md 2.2.4。
 *
 * 工程约束：
 * - 不依赖 DOM / React / Node Buffer，浏览器与 Node 同构可用；
 * - 任一字段非法即整包失败（禁止部分应用）；
 * - 对象遍历统一使用 Object.keys + Object.prototype.hasOwnProperty.call，
 *   防止原型污染与继承属性误读；
 * - 本模块只做纯逻辑，不读写状态；context 完全由调用方传入。
 */

import { AGENT_DRAFT_LIMITS } from './agentDraft.mjs';

/** 补丁序列化（JSON）后允许的最大字节数。 */
const MAX_SERIALIZED_BYTES = 8192;
/** 允许的最大嵌套深度（根对象记为第 1 层，只统计对象/数组容器）。 */
const MAX_DEPTH = 4;
/** 允许的最大总键数（数组元素计入）。 */
const MAX_KEY_COUNT = 64;
/** slotOrder 允许的最大条目数。 */
const MAX_SLOT_ENTRIES = 4;
/** 变更清单最多返回的条目数。 */
const MAX_CHANGE_ITEMS = 20;
/** 门店口号最大长度（Unicode 码点）。 */
const MAX_TAGLINE = 40;

/** 7 个主题色 token，顺序即变更清单的比较顺序。 */
export const THEME_TOKEN_KEYS = Object.freeze([
  'pageBackground',
  'primaryColor',
  'accentColor',
  'textColor',
  'tabBarBackground',
  'tabBarColor',
  'tabBarSelectedColor',
]);

/** 三档尺寸，顺序即变更清单的比较顺序。 */
export const SIZE_STEPS = Object.freeze(['sm', 'md', 'lg']);

/** 允许在补丁中出现的尺寸字段。 */
const SIZE_KEYS = Object.freeze(['homeHero', 'productCard', 'carousel']);

/** 顶层白名单。 */
const PATCH_KEYS = Object.freeze(['theme', 'sizes', 'slotOrder', 'copy']);
/** 单个落位条目白名单。 */
const SLOT_ENTRY_KEYS = Object.freeze(['featureId', 'pageId', 'slotId']);
/** 菜品补丁字段白名单（价格被明确禁止）。 */
const DISH_PATCH_KEYS = Object.freeze(['id', 'name', 'description']);
/** 原型污染键。 */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_KEYS);

/** 颜色必须是 6 位十六进制（输入允许小写，输出统一大写）。 */
const THEME_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
/** 控制字符（C0 与 DEL）。 */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
/** 脚本 / 链接 / HTML / 模板注入片段。 */
const DANGEROUS_TEXT_PATTERN = /(javascript:|data:|https?:\/\/|<script|<\/|\{\{|\}\}|expression\(|url\()/i;

/**
 * Base manifest 允许的目标插槽（与 plan.md 2.2.2 的落位表一致）。
 * menu-hero 由 T11 在 Base manifest 中新增，这里先作为合法目标声明，
 * 校验时只用于目标合法性判断，不写入模板文件。
 */
export const SLOT_DEFINITIONS = Object.freeze({
  'home-hero': Object.freeze({ pageId: 'home', accepts: Object.freeze(['feature-pack', 'ui-block']), maxItems: 1 }),
  'home-marketing': Object.freeze({ pageId: 'home', accepts: Object.freeze(['feature-pack']), maxItems: 2 }),
  'menu-aside': Object.freeze({ pageId: 'menu', accepts: Object.freeze(['ui-block']), maxItems: 1 }),
  'menu-hero': Object.freeze({ pageId: 'menu', accepts: Object.freeze(['feature-pack', 'ui-block']), maxItems: 1 }),
});

/** 补丁错误码（与 plan.md 2.2.4 错误码表逐字一致）。 */
export const PRESENTATION_PATCH_CODES = Object.freeze({
  INVALID: 'PRESENTATION_PATCH_INVALID',
  THEME_COLOR_INVALID: 'PATCH_THEME_COLOR_INVALID',
  SLOT_ORDER_UNSUPPORTED: 'PATCH_SLOT_ORDER_UNSUPPORTED',
  SLOT_TARGET_INVALID: 'PATCH_SLOT_TARGET_INVALID',
  SIZE_UNSUPPORTED: 'PATCH_SIZE_UNSUPPORTED',
  COPY_DISH_UNKNOWN: 'PATCH_COPY_DISH_UNKNOWN',
});

/** 尺寸 / 文案 / 结构限制，供调用方展示与测试断言。 */
export const PRESENTATION_PATCH_LIMITS = Object.freeze({
  maxSerializedBytes: MAX_SERIALIZED_BYTES,
  maxDepth: MAX_DEPTH,
  maxKeyCount: MAX_KEY_COUNT,
  maxSlotEntries: MAX_SLOT_ENTRIES,
  maxChanges: MAX_CHANGE_ITEMS,
  maxStoreName: AGENT_DRAFT_LIMITS.maxStoreName,
  maxCategory: AGENT_DRAFT_LIMITS.maxCategory,
  maxTagline: MAX_TAGLINE,
  maxDishName: AGENT_DRAFT_LIMITS.maxDishName,
  maxDishDescription: AGENT_DRAFT_LIMITS.maxDescription,
  maxDishPatches: AGENT_DRAFT_LIMITS.maxDishes,
});

/**
 * 固定 label 映射（plan.md 2.2.4「固定 label 映射」表的字面键）。
 * 动态路径请使用 resolvePresentationLabel()。
 */
export const PRESENTATION_LABEL_MAP = Object.freeze({
  'theme.pageBackground': '页面背景色',
  'theme.primaryColor': '主色',
  'theme.accentColor': '强调色',
  'theme.textColor': '文字色',
  'theme.tabBarBackground': '底栏背景',
  'theme.tabBarColor': '底栏文字',
  'theme.tabBarSelectedColor': '底栏选中色',
  'sizes.homeHero': '首屏主视觉尺寸',
  'sizes.productCard': '商品卡尺寸',
  'sizes.carousel': '轮播区尺寸',
  'slotOrder.<featureId>': '区块位置',
  'copy.storeName': '店名',
  'copy.category': '品类',
  'copy.tagline': '门店口号',
  'copy.dishes[i].name': '菜品名称',
  'copy.dishes[i].description': '菜品描述',
});

/** 按 path 解析中文 label；未知路径原样返回。 */
export function resolvePresentationLabel(path) {
  if (typeof path !== 'string' || !path) return '';
  if (Object.prototype.hasOwnProperty.call(PRESENTATION_LABEL_MAP, path)) {
    return PRESENTATION_LABEL_MAP[path];
  }
  if (path.startsWith('slotOrder.')) {
    return PRESENTATION_LABEL_MAP['slotOrder.<featureId>'];
  }
  const dishMatch = /^copy\.dishes\[\d+\]\.(name|description)$/.exec(path);
  if (dishMatch) {
    return PRESENTATION_LABEL_MAP[`copy.dishes[i].${dishMatch[1]}`];
  }
  return path;
}

const { INVALID, THEME_COLOR_INVALID, SLOT_ORDER_UNSUPPORTED, SLOT_TARGET_INVALID, SIZE_UNSUPPORTED, COPY_DISH_UNKNOWN } = PRESENTATION_PATCH_CODES;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwn(object, key) {
  return hasOwn(object, key) ? object[key] : undefined;
}

function codePointLength(text) {
  return [...text].length;
}

function patchDetail(path, code, message) {
  return { path, code, message };
}

function failure(details) {
  return { ok: false, code: details[0].code, details };
}

/** 以 UTF-8 字节数衡量序列化体积，不依赖 Buffer / TextEncoder。 */
function utf8ByteLength(text) {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 文本规范化：NFC → 去首尾空白 → 控制字符 / 危险片段检测。
 * 返回 { ok, value } 或 { ok:false, code, message }。
 */
function normalizeText(raw) {
  const normalized = raw.normalize('NFC').trim();
  if (CONTROL_CHAR_PATTERN.test(normalized)) {
    return { ok: false, code: INVALID, message: '文案中不允许包含控制字符。' };
  }
  if (DANGEROUS_TEXT_PATTERN.test(normalized)) {
    return { ok: false, code: INVALID, message: '文案中不允许包含脚本、链接、HTML 或 CSS 片段。' };
  }
  return { ok: true, value: normalized };
}

/**
 * 结构体检：序列化体积、嵌套深度、总键数、原型污染键、非 JSON 值。
 * 任何一项不通过都整包失败。
 */
function inspectStructure(root) {
  const details = [];

  let serialized = '';
  try {
    serialized = JSON.stringify(root);
  } catch {
    return [patchDetail('', INVALID, '补丁包含无法序列化的结构（可能存在循环引用或非法类型）。')];
  }
  if (typeof serialized !== 'string') serialized = '';

  const bytes = utf8ByteLength(serialized);
  if (bytes > MAX_SERIALIZED_BYTES) {
    details.push(patchDetail('', INVALID, `补丁序列化后不能超过 ${MAX_SERIALIZED_BYTES} 字节（当前 ${bytes} 字节）。`));
  }

  let keyCount = 0;
  let depthReported = false;

  const visit = (node, path, depth) => {
    if (node === null || node === undefined) return;
    const type = typeof node;
    if (type === 'string' || type === 'number' || type === 'boolean') return;

    if (Array.isArray(node) || isPlainObject(node)) {
      if (depth > MAX_DEPTH && !depthReported) {
        depthReported = true;
        details.push(patchDetail(path || '', INVALID, `补丁嵌套深度不能超过 ${MAX_DEPTH} 层。`));
      }
      if (Array.isArray(node)) {
        keyCount += node.length;
        node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      } else {
        const keys = Object.keys(node);
        keyCount += keys.length;
        for (const key of keys) {
          const childPath = path ? `${path}.${key}` : key;
          if (FORBIDDEN_KEY_SET.has(key)) {
            details.push(patchDetail(childPath, INVALID, `不允许出现原型污染键：${key}。`));
          }
          visit(node[key], childPath, depth + 1);
        }
      }
      return;
    }

    details.push(patchDetail(path || '', INVALID, '补丁中存在非 JSON 数据类型的值。'));
  };

  visit(root, '', 1);

  if (keyCount > MAX_KEY_COUNT) {
    details.push(patchDetail('', INVALID, `补丁总键数不能超过 ${MAX_KEY_COUNT}（当前 ${keyCount}）。`));
  }

  return details;
}

/** 归一化调用方传入的 context，缺失时降级为空集合而不是抛异常。 */
function normalizeContext(context) {
  const source = isPlainObject(context) ? context : {};
  const occupiedFeatures = [];
  const seenIds = new Set();
  if (Array.isArray(source.occupiedFeatures)) {
    for (const feature of source.occupiedFeatures) {
      if (!isPlainObject(feature)) continue;
      const id = typeof feature.id === 'string' ? feature.id : '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      occupiedFeatures.push({ id, kind: typeof feature.kind === 'string' ? feature.kind : '' });
    }
  }

  const baseDraft = isPlainObject(source.baseDraft) ? source.baseDraft : {};
  return {
    occupiedFeatures,
    hasCarousel: source.hasCarousel === true,
    baseDraft: { dishes: Array.isArray(baseDraft.dishes) ? baseDraft.dishes : [] },
  };
}

function validateTheme(patch, details, normalized) {
  const themeValue = readOwn(patch, 'theme');
  if (themeValue === undefined) return;
  if (!isPlainObject(themeValue)) {
    details.push(patchDetail('theme', INVALID, 'theme 必须是对象。'));
    return;
  }

  const themeOut = {};
  for (const key of Object.keys(themeValue)) {
    const path = `theme.${key}`;
    const value = themeValue[key];
    if (value === undefined) continue;
    if (!THEME_TOKEN_KEYS.includes(key)) {
      details.push(patchDetail(path, INVALID, `未知的主题 token：${key}。`));
      continue;
    }
    if (typeof value !== 'string') {
      details.push(patchDetail(path, THEME_COLOR_INVALID, `${key} 必须是 #RRGGBB 形式的颜色。`));
      continue;
    }
    const text = normalizeText(value);
    if (!text.ok) {
      details.push(patchDetail(path, text.code, text.message));
      continue;
    }
    if (!THEME_COLOR_PATTERN.test(text.value)) {
      details.push(patchDetail(path, THEME_COLOR_INVALID, `${key} 必须是 #RRGGBB 形式的颜色，例如 #1F6F5C。`));
      continue;
    }
    themeOut[key] = text.value.toUpperCase();
  }

  if (Object.keys(themeOut).length) normalized.theme = themeOut;
}

function validateSizes(patch, context, details, normalized) {
  const sizesValue = readOwn(patch, 'sizes');
  if (sizesValue === undefined) return;
  if (!isPlainObject(sizesValue)) {
    details.push(patchDetail('sizes', INVALID, 'sizes 必须是对象。'));
    return;
  }

  const sizesOut = {};
  for (const key of Object.keys(sizesValue)) {
    const path = `sizes.${key}`;
    const value = sizesValue[key];
    if (value === undefined) continue;
    if (!SIZE_KEYS.includes(key)) {
      details.push(patchDetail(path, INVALID, `未知的尺寸字段：${key}。`));
      continue;
    }
    if (key === 'carousel' && !context.hasCarousel) {
      details.push(patchDetail(path, SIZE_UNSUPPORTED, '当前模板没有海报轮播区块，不能修改轮播尺寸。'));
      continue;
    }
    if (typeof value !== 'string' || !SIZE_STEPS.includes(value)) {
      details.push(patchDetail(path, INVALID, `${key} 只能是 sm、md、lg 之一。`));
      continue;
    }
    sizesOut[key] = value;
  }

  if (Object.keys(sizesOut).length) normalized.sizes = sizesOut;
}

function validateSlotOrder(patch, context, details, normalized) {
  const slotValue = readOwn(patch, 'slotOrder');
  if (slotValue === undefined) return;

  if (!Array.isArray(slotValue)) {
    details.push(patchDetail('slotOrder', INVALID, 'slotOrder 必须是数组。'));
    return;
  }
  if (slotValue.length > MAX_SLOT_ENTRIES) {
    details.push(patchDetail('slotOrder', INVALID, `slotOrder 最多 ${MAX_SLOT_ENTRIES} 项。`));
    return;
  }
  if (context.occupiedFeatures.length === 0) {
    if (slotValue.length !== 0) {
      details.push(patchDetail('slotOrder', SLOT_ORDER_UNSUPPORTED, '当前模板没有可移动的区块，slotOrder 只能为空数组。'));
      return;
    }
    normalized.slotOrder = [];
    return;
  }
  if (slotValue.length !== context.occupiedFeatures.length) {
    details.push(patchDetail('slotOrder', SLOT_ORDER_UNSUPPORTED, 'slotOrder 必须是当前已占用区块的完整排列。'));
    return;
  }

  const featureById = new Map(context.occupiedFeatures.map((feature) => [feature.id, feature]));
  const seenFeatures = new Set();
  const seenTargets = new Set();
  const orderOut = [];

  slotValue.forEach((entry, index) => {
    const basePath = `slotOrder[${index}]`;
    if (!isPlainObject(entry)) {
      details.push(patchDetail(basePath, INVALID, '落位条目必须是对象。'));
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!SLOT_ENTRY_KEYS.includes(key)) {
        details.push(patchDetail(`${basePath}.${key}`, INVALID, `未知的落位字段：${key}。`));
      }
    }

    const rawFeatureId = readOwn(entry, 'featureId');
    const featureId = typeof rawFeatureId === 'string' ? rawFeatureId : '';
    if (!featureId || !featureById.has(featureId)) {
      details.push(
        patchDetail(`${basePath}.featureId`, SLOT_ORDER_UNSUPPORTED, `featureId 不属于当前模板的已占用区块：${featureId || '(空)'}。`),
      );
      return;
    }
    if (seenFeatures.has(featureId)) {
      details.push(patchDetail(`${basePath}.featureId`, SLOT_ORDER_UNSUPPORTED, `featureId 重复出现：${featureId}。`));
      return;
    }
    seenFeatures.add(featureId);

    const pageId = readOwn(entry, 'pageId');
    const slotId = readOwn(entry, 'slotId');
    if (typeof pageId !== 'string' || typeof slotId !== 'string') {
      details.push(patchDetail(basePath, INVALID, '落位必须包含字符串 pageId 与 slotId。'));
      return;
    }

    if (!hasOwn(SLOT_DEFINITIONS, slotId) || SLOT_DEFINITIONS[slotId].pageId !== pageId) {
      details.push(patchDetail(`${basePath}.slotId`, SLOT_TARGET_INVALID, `目标插槽不存在：${pageId}/${slotId}。`));
      return;
    }
    const slot = SLOT_DEFINITIONS[slotId];
    const kind = featureById.get(featureId).kind;
    if (!slot.accepts.includes(kind)) {
      details.push(
        patchDetail(`${basePath}.slotId`, SLOT_TARGET_INVALID, `目标插槽 ${slotId} 不接受 ${kind || '(未知类型)'} 类型的区块。`),
      );
      return;
    }

    const targetKey = `${pageId}/${slotId}`;
    if (seenTargets.has(targetKey)) {
      details.push(patchDetail(`${basePath}.slotId`, SLOT_TARGET_INVALID, `同一目标插槽不能重复落位：${targetKey}。`));
      return;
    }
    seenTargets.add(targetKey);
    orderOut.push({ featureId, pageId, slotId });
  });

  if (seenFeatures.size !== featureById.size) {
    details.push(patchDetail('slotOrder', SLOT_ORDER_UNSUPPORTED, 'slotOrder 必须是当前已占用区块的完整排列。'));
  }
  normalized.slotOrder = orderOut;
}

function validateCopy(patch, context, details, normalized) {
  const copyValue = readOwn(patch, 'copy');
  if (copyValue === undefined) return;
  if (!isPlainObject(copyValue)) {
    details.push(patchDetail('copy', INVALID, 'copy 必须是对象。'));
    return;
  }

  const copyOut = {};
  const textSpecs = [
    { field: 'storeName', min: 1, max: AGENT_DRAFT_LIMITS.maxStoreName, label: '店名' },
    { field: 'category', min: 1, max: AGENT_DRAFT_LIMITS.maxCategory, label: '品类' },
    { field: 'tagline', min: 0, max: MAX_TAGLINE, label: '门店口号' },
  ];
  const textFields = textSpecs.map((spec) => spec.field);

  for (const key of Object.keys(copyValue)) {
    if (key === 'dishes') continue;
    const value = copyValue[key];
    if (value === undefined) continue;
    if (!textFields.includes(key)) {
      details.push(patchDetail(`copy.${key}`, INVALID, `未知的文案字段：${key}。`));
      continue;
    }
    const spec = textSpecs.find((item) => item.field === key);
    if (typeof value !== 'string') {
      details.push(patchDetail(`copy.${key}`, INVALID, `${spec.label}必须是字符串。`));
      continue;
    }
    const text = normalizeText(value);
    if (!text.ok) {
      details.push(patchDetail(`copy.${key}`, text.code, text.message));
      continue;
    }
    const length = codePointLength(text.value);
    if (length < spec.min || length > spec.max) {
      details.push(
        patchDetail(`copy.${key}`, INVALID, `${spec.label}长度必须在 ${spec.min}–${spec.max} 个字符之间，当前 ${length} 个。`),
      );
      continue;
    }
    copyOut[key] = text.value;
  }

  const dishesValue = readOwn(copyValue, 'dishes');
  if (dishesValue !== undefined) {
    if (!Array.isArray(dishesValue)) {
      details.push(patchDetail('copy.dishes', INVALID, 'copy.dishes 必须是数组。'));
    } else if (dishesValue.length > AGENT_DRAFT_LIMITS.maxDishes) {
      details.push(
        patchDetail('copy.dishes', INVALID, `一次最多修改 ${AGENT_DRAFT_LIMITS.maxDishes} 道菜的文案，当前 ${dishesValue.length} 道。`),
      );
    } else {
      const baseDishIds = new Set(
        context.baseDraft.dishes
          .filter((dish) => isPlainObject(dish) && typeof dish.id === 'string')
          .map((dish) => dish.id),
      );
      const seenDishIds = new Set();
      const dishesOut = [];

      dishesValue.forEach((dish, index) => {
        const basePath = `copy.dishes[${index}]`;
        if (!isPlainObject(dish)) {
          details.push(patchDetail(basePath, INVALID, '菜品补丁必须是对象。'));
          return;
        }
        for (const key of Object.keys(dish)) {
          if (key === 'priceCents' || key === 'priceText') {
            details.push(patchDetail(`${basePath}.${key}`, INVALID, '菜品补丁不允许修改价格。'));
          } else if (!DISH_PATCH_KEYS.includes(key)) {
            details.push(patchDetail(`${basePath}.${key}`, INVALID, `未知的菜品补丁字段：${key}。`));
          }
        }

        const rawId = readOwn(dish, 'id');
        const id = typeof rawId === 'string' ? rawId.normalize('NFC').trim() : '';
        if (!id) {
          details.push(patchDetail(`${basePath}.id`, INVALID, '菜品补丁必须包含菜品 id。'));
          return;
        }
        if (seenDishIds.has(id)) {
          details.push(patchDetail(`${basePath}.id`, INVALID, `菜品补丁中的 id 不能重复：${id}。`));
          return;
        }
        seenDishIds.add(id);
        if (!baseDishIds.has(id)) {
          details.push(patchDetail(`${basePath}.id`, COPY_DISH_UNKNOWN, `草稿中不存在菜品 id：${id}。`));
          return;
        }

        const dishOut = { id };
        for (const field of ['name', 'description']) {
          if (!hasOwn(dish, field)) continue;
          const rawText = dish[field];
          if (rawText === undefined) continue;
          if (typeof rawText !== 'string') {
            details.push(patchDetail(`${basePath}.${field}`, INVALID, `${field} 必须是字符串。`));
            continue;
          }
          const text = normalizeText(rawText);
          if (!text.ok) {
            details.push(patchDetail(`${basePath}.${field}`, text.code, text.message));
            continue;
          }
          const isName = field === 'name';
          const min = isName ? 1 : 0;
          const max = isName ? AGENT_DRAFT_LIMITS.maxDishName : AGENT_DRAFT_LIMITS.maxDescription;
          const label = isName ? '菜品名称' : '菜品描述';
          const length = codePointLength(text.value);
          if (length < min || length > max) {
            details.push(
              patchDetail(`${basePath}.${field}`, INVALID, `${label}长度必须在 ${min}–${max} 个字符之间，当前 ${length} 个。`),
            );
            continue;
          }
          dishOut[field] = text.value;
        }
        dishesOut.push(dishOut);
      });

      copyOut.dishes = dishesOut;
    }
  }

  if (Object.keys(copyOut).length) normalized.copy = copyOut;
}

/**
 * 校验一份展示补丁。
 *
 * @param {unknown} patch 待校验补丁（通常来自模型输出或前端已接受补丁）
 * @param {{occupiedFeatures?: Array<{id: string, kind: string}>, hasCarousel?: boolean,
 *   baseDraft?: {dishes?: Array<{id: string}>}}} context 校验上下文
 * @returns {{ok: true, patch: object, changes: Array<object>}
 *   | {ok: false, code: string, details: Array<{path: string, code: string, message: string}>}}
 */
export function validatePresentationPatch(patch, context) {
  const ctx = normalizeContext(context);
  if (!isPlainObject(patch)) {
    return failure([patchDetail('', INVALID, '补丁必须是 JSON 对象。')]);
  }

  const structural = inspectStructure(patch);
  if (structural.length) return failure(structural);

  const details = [];
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) {
      details.push(patchDetail(key, INVALID, `未知的补丁字段：${key}。`));
    }
  }

  const normalized = {};
  validateTheme(patch, details, normalized);
  validateSizes(patch, ctx, details, normalized);
  validateSlotOrder(patch, ctx, details, normalized);
  validateCopy(patch, ctx, details, normalized);

  if (details.length) return failure(details);

  return {
    ok: true,
    patch: normalized,
    changes: diffPresentationPatch({}, normalized, context),
  };
}

/** 取某个 token 的当前值（非字符串视为未设置）。 */
function readThemeToken(patch, token) {
  const theme = isPlainObject(patch.theme) ? patch.theme : null;
  if (!theme) return null;
  const value = readOwn(theme, token);
  return typeof value === 'string' ? value : null;
}

function readSize(patch, key) {
  const sizes = isPlainObject(patch.sizes) ? patch.sizes : null;
  if (!sizes) return null;
  const value = readOwn(sizes, key);
  return typeof value === 'string' ? value : null;
}

function readPlacement(slotOrder, featureId) {
  if (!Array.isArray(slotOrder)) return null;
  for (const entry of slotOrder) {
    if (!isPlainObject(entry)) continue;
    if (readOwn(entry, 'featureId') !== featureId) continue;
    const pageId = readOwn(entry, 'pageId');
    const slotId = readOwn(entry, 'slotId');
    if (typeof pageId !== 'string' || typeof slotId !== 'string') return null;
    return `${pageId}/${slotId}`;
  }
  return null;
}

function readCopyText(patch, field) {
  const copy = isPlainObject(patch.copy) ? patch.copy : null;
  if (!copy) return null;
  const value = readOwn(copy, field);
  return typeof value === 'string' ? value : null;
}

function readDishField(patch, id, field) {
  const copy = isPlainObject(patch.copy) ? patch.copy : null;
  if (!copy || !Array.isArray(copy.dishes)) return null;
  for (const dish of copy.dishes) {
    if (!isPlainObject(dish) || readOwn(dish, 'id') !== id) continue;
    const value = readOwn(dish, field);
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** 菜品比较顺序：baseDraft 的菜品顺序优先，补丁里多出的 id 追加在后。 */
function collectDishIds(context, basePatch, nextPatch) {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const dish of context.baseDraft.dishes) {
    if (isPlainObject(dish)) push(readOwn(dish, 'id'));
  }
  for (const source of [basePatch, nextPatch]) {
    if (!isPlainObject(source) || !isPlainObject(source.copy) || !Array.isArray(source.copy.dishes)) continue;
    for (const dish of source.copy.dishes) {
      if (isPlainObject(dish)) push(readOwn(dish, 'id'));
    }
  }
  return ids;
}

/** 变更清单截断：保留前 19 条，最后一条为“…等 N 项”。 */
function limitChanges(items) {
  if (items.length <= MAX_CHANGE_ITEMS) return items;
  const head = items.slice(0, MAX_CHANGE_ITEMS - 1);
  head.push({ path: '...', label: `…等 ${items.length} 项`, before: null, after: null });
  return head;
}

/**
 * 计算两份补丁之间的可读变更清单。
 *
 * 固定比较顺序：
 * theme（7 个 token 固定顺序）→ sizes（homeHero/productCard/carousel）
 * → slotOrder（按 context.occupiedFeatures 声明顺序）→ copy（storeName/category/tagline/dishes 按 id）。
 * 每项输出 path/label/before/after，最多 20 条。
 *
 * @param {object} base 变更前补丁（缺省视为 {}）
 * @param {object} next 变更后补丁
 * @param {object} context 与 validatePresentationPatch 相同的上下文
 * @returns {Array<{path: string, label: string, before: string|null, after: string|null}>}
 */
export function diffPresentationPatch(base, next, context) {
  const ctx = normalizeContext(context);
  const basePatch = isPlainObject(base) ? base : {};
  const nextPatch = isPlainObject(next) ? next : {};
  const items = [];

  for (const token of THEME_TOKEN_KEYS) {
    const before = readThemeToken(basePatch, token);
    const after = readThemeToken(nextPatch, token);
    if (before === after) continue;
    items.push({ path: `theme.${token}`, label: resolvePresentationLabel(`theme.${token}`), before, after });
  }

  for (const key of SIZE_KEYS) {
    const before = readSize(basePatch, key);
    const after = readSize(nextPatch, key);
    if (before === after) continue;
    items.push({ path: `sizes.${key}`, label: resolvePresentationLabel(`sizes.${key}`), before, after });
  }

  for (const feature of ctx.occupiedFeatures) {
    const before = readPlacement(basePatch.slotOrder, feature.id);
    const after = readPlacement(nextPatch.slotOrder, feature.id);
    if (before === after) continue;
    items.push({ path: `slotOrder.${feature.id}`, label: resolvePresentationLabel(`slotOrder.${feature.id}`), before, after });
  }

  for (const field of ['storeName', 'category', 'tagline']) {
    const before = readCopyText(basePatch, field);
    const after = readCopyText(nextPatch, field);
    if (before === after) continue;
    items.push({ path: `copy.${field}`, label: resolvePresentationLabel(`copy.${field}`), before, after });
  }

  const dishIds = collectDishIds(ctx, basePatch, nextPatch);
  dishIds.forEach((id, index) => {
    for (const field of ['name', 'description']) {
      const before = readDishField(basePatch, id, field);
      const after = readDishField(nextPatch, id, field);
      if (before === after) continue;
      const path = `copy.dishes[${index}].${field}`;
      items.push({ path, label: resolvePresentationLabel(path), before, after });
    }
  });

  return limitChanges(items);
}

/** 把两份已校验补丁按 2.2.4 合并语义合成一份（不校验）。 */
function mergeTwo(basePatch, nextPatch) {
  const result = {};

  if (isPlainObject(basePatch.theme) || isPlainObject(nextPatch.theme)) {
    const theme = {
      ...(isPlainObject(basePatch.theme) ? basePatch.theme : {}),
      ...(isPlainObject(nextPatch.theme) ? nextPatch.theme : {}),
    };
    if (Object.keys(theme).length) result.theme = theme;
  }

  if (isPlainObject(basePatch.sizes) || isPlainObject(nextPatch.sizes)) {
    const sizes = {
      ...(isPlainObject(basePatch.sizes) ? basePatch.sizes : {}),
      ...(isPlainObject(nextPatch.sizes) ? nextPatch.sizes : {}),
    };
    if (Object.keys(sizes).length) result.sizes = sizes;
  }

  // slotOrder 整体替换；next 中 undefined 表示不改。
  if (nextPatch.slotOrder !== undefined) {
    result.slotOrder = nextPatch.slotOrder.map((entry) => ({ ...entry }));
  } else if (basePatch.slotOrder !== undefined) {
    result.slotOrder = basePatch.slotOrder.map((entry) => ({ ...entry }));
  }

  const copyOut = {};
  const baseCopy = isPlainObject(basePatch.copy) ? basePatch.copy : null;
  const nextCopy = isPlainObject(nextPatch.copy) ? nextPatch.copy : null;

  if (baseCopy) {
    for (const field of ['storeName', 'category', 'tagline']) {
      if (hasOwn(baseCopy, field)) copyOut[field] = baseCopy[field];
    }
    if (Array.isArray(baseCopy.dishes)) {
      copyOut.dishes = baseCopy.dishes.map((dish) => ({ ...dish }));
    }
  }

  if (nextCopy) {
    for (const field of ['storeName', 'category', 'tagline']) {
      if (hasOwn(nextCopy, field)) copyOut[field] = nextCopy[field];
    }
    if (Array.isArray(nextCopy.dishes)) {
      const list = Array.isArray(copyOut.dishes) ? copyOut.dishes.map((dish) => ({ ...dish })) : [];
      for (const dish of nextCopy.dishes) {
        const id = readOwn(dish, 'id');
        const index = list.findIndex((item) => readOwn(item, 'id') === id);
        if (index === -1) list.push({ ...dish });
        else list[index] = { ...list[index], ...dish };
      }
      copyOut.dishes = list;
    }
  }

  if (Object.keys(copyOut).length) result.copy = copyOut;
  return result;
}

/**
 * 合并补丁：把服务端新补丁叠加到已接受补丁上，并重新校验。
 *
 * @param {object} base 已接受补丁
 * @param {object} next 新补丁
 * @param {object} context 校验上下文
 * @returns {{ok: true, patch: object, changes: Array<object>}
 *   | {ok: false, code: string, details: Array<object>}}
 */
export function mergePresentationPatch(base, next, context) {
  const baseCheck = validatePresentationPatch(base === undefined ? {} : base, context);
  if (!baseCheck.ok) return baseCheck;

  const nextCheck = validatePresentationPatch(next === undefined ? {} : next, context);
  if (!nextCheck.ok) return nextCheck;

  const merged = mergeTwo(baseCheck.patch, nextCheck.patch);
  const mergedCheck = validatePresentationPatch(merged, context);
  if (!mergedCheck.ok) return mergedCheck;

  return {
    ok: true,
    patch: mergedCheck.patch,
    changes: diffPresentationPatch(baseCheck.patch, mergedCheck.patch, context),
  };
}