import { MAX_DISHES, MAX_HOURS_SEGMENTS, MIN_DISHES, describeDishRequirement } from './storeLimits.mjs';
import { parseHoursText, validateHoursSegments } from './businessHours.mjs';
import { STORE_NAME_MAX_LENGTH } from './storeName.mjs';

// 店名上限只有一份：src/domain/storeName.mjs（输入框、AI 提案、领域校验、服务端校验同源）。
const MAX_STORE_NAME = STORE_NAME_MAX_LENGTH;
const MAX_CATEGORY = 24;
const MAX_DISH_NAME = 24;
const MAX_DESCRIPTION = 60;
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 999999;

const HOURS_SEGMENT = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const HOURS_POINT = /^(\d{1,2})(?::(\d{2}))?(?:[点时])?(半)?$/;
const PRICE_PATTERN = /^[¥￥]?\s*(\d{1,9})(?:\.(\d{1,2}))?\s*(?:元|块钱|块)?$/;

const FIELD_LABELS = Object.freeze({
  storeName: '店名',
  category: '品类',
  businessHours: '营业时间',
  fulfillment: '取餐方式',
  dishes: '菜品',
});

const MISSING_DETAILS = Object.freeze({
  storeName: '例如：松月食堂',
  category: '例如：社区餐馆、咖啡茶饮、烘焙甜品',
  businessHours: '格式 HH:MM-HH:MM，例如 10:00-21:00',
  fulfillment: '至少选择堂食或到店自取其中一种',
  dishes: `一共需要 1–8 道菜`,
});

const NEXT_QUESTION_TEXT = Object.freeze({
  storeName: '这家店叫什么名字？例如“松月食堂”。',
  category: '主要做什么品类？例如社区餐馆、咖啡茶饮、烘焙甜品。',
  businessHours: '每天几点到几点营业？例如 10:00-21:00。',
  fulfillment: '顾客可以堂食、到店自取，还是两种都支持？',
});

const QUESTION_LABELS = Object.freeze({
  storeName: '店名',
  category: '品类',
  businessHours: '营业时间',
  fulfillment: '取餐方式',
  dishes: '菜品',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function codePointLength(value) {
  return Array.from(value).length;
}

function toHalfWidth(value) {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x3000) {
      result += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCharCode(code - 0xfee0);
    } else {
      result += character;
    }
  }
  return result;
}

function normalizePriceTextInput(value) {
  return toHalfWidth(trimText(value))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '');
}

export function parsePriceTextToCents(text) {
  const normalized = normalizePriceTextInput(text);
  if (!normalized) {
    return { ok: false, cents: null, code: 'PRICE_REQUIRED' };
  }
  const matched = PRICE_PATTERN.exec(normalized);
  if (!matched) {
    return { ok: false, cents: null, code: 'PRICE_INVALID' };
  }
  const integerPart = matched[1];
  const fraction = matched[2] ?? '';
  if (integerPart.length > 1 && integerPart.startsWith('0')) {
    return { ok: false, cents: null, code: 'PRICE_INVALID' };
  }
  const cents = (Number(integerPart) * 100) + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, cents: null, code: 'PRICE_INVALID' };
  }
  return { ok: true, cents, code: null };
}

export function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) return '';
  const integer = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${integer}.${fraction}`;
}

export function createDishId(dishes) {
  const list = Array.isArray(dishes) ? dishes : [];
  let max = 0;
  for (const dish of list) {
    if (!isPlainObject(dish)) continue;
    const matched = /^dish-(\d+)$/.exec(String(dish.id ?? ''));
    if (!matched) continue;
    const value = Number(matched[1]);
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  return `dish-${max + 1}`;
}

export function normalizeBusinessHoursText(value) {
  const raw = toHalfWidth(trimText(value));
  if (!raw) return '';
  const unified = raw
    .replace(/[，、]/g, ',')
    .replace(/[~～—–]/g, '-')
    .replace(/到|至/g, '-')
    .replace(/\s+/g, '');
  const segments = unified.split(',');
  const normalized = segments.map((segment) => {
    if (!segment) return segment;
    const parts = segment.split('-');
    if (parts.length !== 2) return segment;
    const start = normalizePoint(parts[0]);
    const end = normalizePoint(parts[1]);
    if (!start || !end) return segment;
    return `${start}-${end}`;
  });
  return normalized.join(',');
}

function normalizePoint(value) {
  if (!value) return null;
  const matched = HOURS_POINT.exec(value);
  if (!matched) return null;
  const hour = Number(matched[1]);
  if (!Number.isInteger(hour) || hour > 23) return null;
  const minute = matched[2] === undefined ? (matched[3] ? 30 : 0) : Number(matched[2]);
  if (!Number.isInteger(minute) || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeFulfillment(value) {
  const source = isPlainObject(value) ? value : {};
  return { dineIn: source.dineIn === true, takeaway: source.takeaway === true };
}

function normalizePriceCents(value, priceText) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof priceText === 'string' && priceText.trim()) {
    const parsed = parsePriceTextToCents(priceText);
    return parsed.ok ? parsed.cents : null;
  }
  return null;
}

function normalizeDish(dish, existingDishes) {
  const source = isPlainObject(dish) ? dish : {};
  const name = trimText(source.name);
  const description = trimText(source.description);
  const priceText = trimText(source.priceText);
  const priceCents = normalizePriceCents(source.priceCents, priceText);
  const id = trimText(source.id) || createDishId(existingDishes);
  return { id, name, priceCents, priceText: priceText || formatCents(priceCents), description };
}

export function createEmptyAgentDraft() {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

export function normalizeAgentDraft(input) {
  if (!isPlainObject(input)) return createEmptyAgentDraft();
  const sourceDishes = Array.isArray(input.dishes) ? input.dishes : [];
  const dishes = [];
  for (const rawDish of sourceDishes) {
    dishes.push(normalizeDish(rawDish, dishes));
  }
  return {
    storeName: trimText(input.storeName),
    category: trimText(input.category),
    businessHours: normalizeBusinessHoursText(input.businessHours),
    fulfillment: normalizeFulfillment(input.fulfillment),
    dishes,
  };
}

function pushMissing(missingFields, field, detail) {
  missingFields.push({
    field,
    label: QUESTION_LABELS[field] ?? FIELD_LABELS[field] ?? field,
    detail: detail ?? MISSING_DETAILS[field] ?? '请补充该项',
  });
}

function pushError(errors, field, code, message) {
  errors.push({ field, code, message });
}

function validateBusinessHours(value, errors) {
  // 唯一口径：见 businessHours.mjs。结束时间早于开始时间表示营业到次日，不再要求拆段。
  for (const problem of validateHoursSegments(parseHoursText(value))) {
    pushError(errors, 'businessHours', problem.code, problem.message);
  }
}

function validateDishes(dishes, missingFields, errors) {
  if (dishes.length < MIN_DISHES) {
    // 0 道可以留在草稿里，只是「继续」会被拦下；这里给的是人话提示，不是硬报错。
    pushMissing(
      missingFields,
      'dishes',
      dishes.length === 0
        ? `还没有菜品：先加 ${MIN_DISHES} 道带菜名和价格的菜就能继续（0 道也能先存草稿）。`
        : `还差 ${MIN_DISHES - dishes.length} 道菜，${describeDishRequirement()}。`,
    );
    return;
  }
  if (dishes.length > MAX_DISHES) {
    pushError(errors, 'dishes', 'DISHES_TOO_MANY', `最多保留 ${MAX_DISHES} 道菜，请删减多余的菜品。`);
  }
  const seenIds = new Set();
  dishes.forEach((dish, index) => {
    const label = `第 ${index + 1} 道菜`;
    if (!dish.id) {
      pushError(errors, `dishes[${index}].id`, 'DISH_ID_INVALID', `${label}缺少本地标识。`);
    } else if (seenIds.has(dish.id)) {
      pushError(errors, `dishes[${index}].id`, 'DISH_ID_INVALID', `${label}的本地标识重复。`);
    } else {
      seenIds.add(dish.id);
    }
    if (!dish.name) {
      missingFields.push({ field: `dishes[${index}].name`, label: `${label}菜名`, detail: '填写菜品的名称' });
    } else if (codePointLength(dish.name) > MAX_DISH_NAME) {
      pushError(errors, `dishes[${index}].name`, 'DISH_NAME_TOO_LONG', `${label}的菜名不能超过 ${MAX_DISH_NAME} 个字。`);
    }
    if (dish.priceCents === null || dish.priceCents === undefined) {
      const parsedText = dish.priceText ? parsePriceTextToCents(dish.priceText) : null;
      if (parsedText && !parsedText.ok && parsedText.code === 'PRICE_INVALID') {
        pushError(errors, `dishes[${index}].priceCents`, 'PRICE_INVALID', '价格格式不正确，例如 28 或 28.50。');
      } else {
        missingFields.push({ field: `dishes[${index}].priceCents`, label: `${label}价格`, detail: '例如 28 或 28.50' });
      }
    } else if (!Number.isInteger(dish.priceCents)) {
      pushError(errors, `dishes[${index}].priceCents`, 'PRICE_INVALID', `${label}的价格必须是整数分，例如 28 或 28.50。`);
    } else if (dish.priceCents < MIN_PRICE_CENTS || dish.priceCents > MAX_PRICE_CENTS) {
      pushError(errors, `dishes[${index}].priceCents`, 'PRICE_RANGE', `${label}的价格必须在 0.01–9999.99 元之间。`);
    }
    if (dish.description && codePointLength(dish.description) > MAX_DESCRIPTION) {
      pushError(errors, `dishes[${index}].description`, 'DESCRIPTION_TOO_LONG', `${label}的描述不能超过 ${MAX_DESCRIPTION} 个字。`);
    }
  });
}

export function validateAgentDraft(draft) {
  const normalized = normalizeAgentDraft(draft);
  const missingFields = [];
  const errors = [];

  if (!normalized.storeName) {
    pushMissing(missingFields, 'storeName');
  } else if (codePointLength(normalized.storeName) > MAX_STORE_NAME) {
    pushError(errors, 'storeName', 'NAME_TOO_LONG', `店名不能超过 ${MAX_STORE_NAME} 个字。`);
  }

  if (!normalized.category) {
    pushMissing(missingFields, 'category');
  } else if (codePointLength(normalized.category) > MAX_CATEGORY) {
    pushError(errors, 'category', 'CATEGORY_TOO_LONG', `品类不能超过 ${MAX_CATEGORY} 个字。`);
  }

  if (!normalized.businessHours) {
    pushMissing(missingFields, 'businessHours');
  } else {
    validateBusinessHours(normalized.businessHours, errors);
  }

  if (!normalized.fulfillment.dineIn && !normalized.fulfillment.takeaway) {
    pushMissing(missingFields, 'fulfillment');
  }

  validateDishes(normalized.dishes, missingFields, errors);

  return {
    missingFields,
    errors,
    readyForReview: missingFields.length === 0 && errors.length === 0,
  };
}

export function buildNextQuestion(validation) {
  const result = isPlainObject(validation) ? validation : { missingFields: [], errors: [] };
  const missing = Array.isArray(result.missingFields) ? result.missingFields : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  if (missing.length) {
    const first = missing[0];
    if (first.field === 'dishes') {
      return { field: 'dishes', label: QUESTION_LABELS.dishes, text: '还需要再补充几道菜，至少 1 道、最多 8 道。' };
    }
    const dishName = /^dishes\[(\d+)\]\.name$/.exec(first.field);
    if (dishName) {
      return { field: first.field, label: first.label, text: `第 ${Number(dishName[1]) + 1} 道菜的菜名是什么？` };
    }
    const dishPrice = /^dishes\[(\d+)\]\.priceCents$/.exec(first.field);
    if (dishPrice) {
      return { field: first.field, label: first.label, text: `${first.label}是多少钱？例如 28 或 28.50。` };
    }
    return {
      field: first.field,
      label: first.label,
      text: NEXT_QUESTION_TEXT[first.field] ?? first.detail ?? '还需要补充这项资料。',
    };
  }

  if (errors.length) {
    const first = errors[0];
    return { field: first.field, label: first.field, text: first.message };
  }

  return null;
}

export function applyDraftPatch(draft, patch) {
  const base = normalizeAgentDraft(draft);
  if (!isPlainObject(patch)) return base;

  let next = { ...base, dishes: base.dishes.map((dish) => ({ ...dish })) };
  for (const field of ['storeName', 'category', 'businessHours']) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = trimText(patch[field]);
    next[field] = field === 'businessHours' ? normalizeBusinessHoursText(value) : value;
  }
  if (isPlainObject(patch.fulfillment)) {
    next.fulfillment = {
      dineIn: Object.prototype.hasOwnProperty.call(patch.fulfillment, 'dineIn')
        ? patch.fulfillment.dineIn === true
        : base.fulfillment.dineIn,
      takeaway: Object.prototype.hasOwnProperty.call(patch.fulfillment, 'takeaway')
        ? patch.fulfillment.takeaway === true
        : base.fulfillment.takeaway,
    };
  }
  if (Array.isArray(patch.dishes)) {
    const merged = [...next.dishes];
    const seenPatchKeys = new Set();
    for (const rawDish of patch.dishes) {
      if (!isPlainObject(rawDish)) continue;
      const id = trimText(rawDish.id);
      const name = trimText(rawDish.name);
      const patchKey = id ? `id:${id}` : (name ? `name:${name}` : '');
      if (patchKey) {
        if (seenPatchKeys.has(patchKey)) continue;
        seenPatchKeys.add(patchKey);
      }
      const index = merged.findIndex((dish) => (
        id ? dish.id === id : (name && dish.name === name)
      ));
      if (index === -1) {
        const created = normalizeDish(rawDish, merged);
        const duplicateName = created.name
          ? merged.find((dish) => dish.name === created.name)
          : null;
        if (duplicateName) continue;
        merged.push(created);
        continue;
      }
      const current = merged[index];
      const incomingText = trimText(rawDish.priceText);
      const hasTextKey = Object.prototype.hasOwnProperty.call(rawDish, 'priceText');
      const hasIncomingPrice = typeof rawDish.priceCents === 'number' && Number.isInteger(rawDish.priceCents);
      const parsedText = incomingText ? parsePriceTextToCents(incomingText) : null;
      const nextPriceCents = hasTextKey
        ? (incomingText ? (parsedText && parsedText.ok ? parsedText.cents : null) : null)
        : (hasIncomingPrice ? rawDish.priceCents : current.priceCents);
      const nextPriceText = incomingText
        ? incomingText
        : (nextPriceCents === current.priceCents && current.priceText
          ? current.priceText
          : formatCents(nextPriceCents));
      merged[index] = {
        ...current,
        name: Object.prototype.hasOwnProperty.call(rawDish, 'name') ? name : current.name,
        description: Object.prototype.hasOwnProperty.call(rawDish, 'description')
          ? trimText(rawDish.description)
          : current.description,
        priceCents: nextPriceCents,
        priceText: nextPriceText,
      };
    }
    next.dishes = merged;
  }
  return next;
}

export function toContractDraft(draft) {
  const normalized = normalizeAgentDraft(draft);
  return {
    storeName: normalized.storeName,
    category: normalized.category,
    businessHours: normalized.businessHours,
    fulfillment: {
      dineIn: normalized.fulfillment.dineIn,
      takeaway: normalized.fulfillment.takeaway,
    },
    dishes: normalized.dishes.map((dish) => ({
      id: dish.id,
      name: dish.name,
      priceCents: Number.isInteger(dish.priceCents) ? dish.priceCents : null,
      description: dish.description,
    })),
  };
}

export function fromContractDraft(contractDraft) {
  if (!isPlainObject(contractDraft)) return createEmptyAgentDraft();
  const sourceDishes = Array.isArray(contractDraft.dishes) ? contractDraft.dishes : [];
  const dishes = [];
  for (const dish of sourceDishes) {
    const source = isPlainObject(dish) ? dish : {};
    const priceCents = typeof source.priceCents === 'number' && Number.isInteger(source.priceCents)
      ? source.priceCents
      : null;
    dishes.push({
      id: trimText(source.id) || createDishId(dishes),
      name: trimText(source.name),
      priceCents,
      priceText: formatCents(priceCents),
      description: trimText(source.description),
    });
  }
  return {
    storeName: trimText(contractDraft.storeName),
    category: trimText(contractDraft.category),
    businessHours: normalizeBusinessHoursText(contractDraft.businessHours),
    fulfillment: normalizeFulfillment(contractDraft.fulfillment),
    dishes,
  };
}

export const AGENT_DRAFT_LIMITS = Object.freeze({
  maxStoreName: MAX_STORE_NAME,
  maxCategory: MAX_CATEGORY,
  maxDishName: MAX_DISH_NAME,
  maxDescription: MAX_DESCRIPTION,
  maxDishes: MAX_DISHES,
  minDishes: MIN_DISHES,
  minPriceCents: MIN_PRICE_CENTS,
  maxPriceCents: MAX_PRICE_CENTS,
  maxHoursSegments: MAX_HOURS_SEGMENTS,
});