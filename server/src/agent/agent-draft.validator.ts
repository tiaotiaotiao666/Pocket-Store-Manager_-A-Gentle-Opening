import type {
  AgentQuestion,
  ContractDraft,
  DraftValidation,
  FieldError,
  InternalDraft,
  InternalDraftDish,
  MissingField,
} from './agent.types';

/**
 * 服务端草稿校验器（独立实现，不复用前端 React 状态）。
 *
 * 规则来源：docs/agent-turn-contract.md §3.3 / §5。
 * - 长度统一按 Unicode 码点计。
 * - 空值优先判缺项（missingFields），非法值判错误（errors）。
 * - readyForReview 仅在 missingFields 与 errors 同时为空时为 true。
 */

const MAX_STORE_NAME = 48;
const MAX_CATEGORY = 24;
const MAX_DISH_NAME = 24;
const MAX_DESCRIPTION = 60;
const MIN_DISHES = 3;
const MAX_DISHES = 5;
const MIN_PRICE_CENTS = 1;
const MAX_PRICE_CENTS = 999999;
const MAX_HOURS_SEGMENTS = 3;
/** 防御性上限：模型返回超大数组时不至于把内存打满。 */
const MAX_PATCH_DISHES = 50;
const MAX_REQUEST_DISHES = 50;
const MAX_DISH_ID_LENGTH = 32;

const HOURS_SEGMENT = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const HOURS_POINT = /^(\d{1,2})(?::(\d{2}))?(?:[点时])?(半)?$/;
const DISH_ID_PATTERN = /^\S{1,32}$/u;

const FIELD_LABELS: Record<string, string> = {
  storeName: '店名',
  category: '品类',
  businessHours: '营业时间',
  fulfillment: '取餐方式',
  dishes: '菜品',
};

const MISSING_DETAILS: Record<string, string> = {
  storeName: '例如：松月食堂',
  category: '例如：社区餐馆、咖啡茶饮、烘焙甜品',
  businessHours: '格式 HH:MM-HH:MM，例如 10:00-21:00',
  fulfillment: '至少选择堂食或到店自取其中一种',
  dishes: '一共需要 3–5 道菜',
};

const QUESTION_LABELS: Record<string, string> = {
  storeName: '店名',
  category: '品类',
  businessHours: '营业时间',
  fulfillment: '取餐方式',
  dishes: '菜品',
};

const NEXT_QUESTION_TEXT: Record<string, string> = {
  storeName: '这家店叫什么名字？例如“松月食堂”。',
  category: '主要做什么品类？例如社区餐馆、咖啡茶饮、烘焙甜品。',
  businessHours: '每天几点到几点营业？例如 10:00-21:00。',
  fulfillment: '顾客可以堂食、到店自取，还是两种都支持？',
  dishes: '还需要再补充几道菜，一共 3–5 道。',
};

export const AGENT_DRAFT_LIMITS = Object.freeze({
  maxStoreName: MAX_STORE_NAME,
  maxCategory: MAX_CATEGORY,
  maxDishName: MAX_DISH_NAME,
  maxDescription: MAX_DESCRIPTION,
  minDishes: MIN_DISHES,
  maxDishes: MAX_DISHES,
  minPriceCents: MIN_PRICE_CENTS,
  maxPriceCents: MAX_PRICE_CENTS,
  maxHoursSegments: MAX_HOURS_SEGMENTS,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function trimText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function toHalfWidth(value: string): string {
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

function normalizePoint(value: string): string | null {
  if (!value) return null;
  const matched = HOURS_POINT.exec(value);
  if (!matched) return null;
  const hour = Number(matched[1]);
  if (!Number.isInteger(hour) || hour > 23) return null;
  const minute = matched[2] === undefined ? (matched[3] ? 30 : 0) : Number(matched[2]);
  if (!Number.isInteger(minute) || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 与前端 normalizeBusinessHoursText 保持同一归一化语义（全角、中文标点、点/半）。 */
export function normalizeBusinessHoursText(value: unknown): string {
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

function normalizeFulfillment(value: unknown): { dineIn: boolean; takeaway: boolean } {
  const source = isPlainObject(value) ? value : {};
  return {
    dineIn: source.dineIn === true,
    takeaway: source.takeaway === true,
  };
}

function normalizeDishIdCandidate(value: unknown): string {
  const text = trimText(value);
  if (!text) return '';
  if (!DISH_ID_PATTERN.test(text)) return '';
  return text;
}

function nextDishId(dishes: readonly InternalDraftDish[], preferred: string): string {
  const used = new Set(dishes.map((dish) => dish.id));
  if (preferred && !used.has(preferred)) return preferred.slice(0, MAX_DISH_ID_LENGTH);
  let index = 1;
  while (used.has(`dish-${index}`)) index += 1;
  return `dish-${index}`;
}

export function createEmptyInternalDraft(): InternalDraft {
  return {
    storeName: '',
    category: '',
    businessHours: '',
    fulfillment: { dineIn: false, takeaway: false },
    dishes: [],
  };
}

function normalizePriceForStorage(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return value;
}

function normalizeInternalDish(raw: unknown, existing: InternalDraftDish[]): InternalDraftDish | null {
  const source = isPlainObject(raw) ? raw : {};
  const name = trimText(source.name);
  const description = trimText(source.description);
  const preferredId = normalizeDishIdCandidate(source.id);
  const id = nextDishId(existing, preferredId);
  return {
    id,
    name,
    priceCents: normalizePriceForStorage(source.priceCents),
    description,
  };
}

/** 把任意输入（请求体 / 模型补丁）规范化为内部草稿，未知字段直接丢弃。 */
export function normalizeInternalDraft(input: unknown): InternalDraft {
  if (!isPlainObject(input)) return createEmptyInternalDraft();
  const sourceDishes = Array.isArray(input.dishes) ? input.dishes : [];
  const dishes: InternalDraftDish[] = [];
  for (const rawDish of sourceDishes.slice(0, MAX_REQUEST_DISHES)) {
    const dish = normalizeInternalDish(rawDish, dishes);
    if (dish) dishes.push(dish);
  }
  return {
    storeName: trimText(input.storeName),
    category: trimText(input.category),
    businessHours: normalizeBusinessHoursText(input.businessHours),
    fulfillment: normalizeFulfillment(input.fulfillment),
    dishes,
  };
}

/** 对外投影：只输出契约字段，非法价格统一投影为 null（错误信息由校验器给出）。 */
export function projectContractDraft(draft: InternalDraft): ContractDraft {
  return {
    storeName: trimText(draft.storeName),
    category: trimText(draft.category),
    businessHours: trimText(draft.businessHours),
    fulfillment: {
      dineIn: draft.fulfillment.dineIn === true,
      takeaway: draft.fulfillment.takeaway === true,
    },
    dishes: draft.dishes.map((dish) => ({
      id: dish.id,
      name: trimText(dish.name),
      priceCents: typeof dish.priceCents === 'number' && Number.isInteger(dish.priceCents)
        ? dish.priceCents
        : null,
      description: trimText(dish.description),
    })),
  };
}

function cloneDraft(draft: InternalDraft): InternalDraft {
  return {
    storeName: draft.storeName,
    category: draft.category,
    businessHours: draft.businessHours,
    fulfillment: { ...draft.fulfillment },
    dishes: draft.dishes.map((dish) => ({ ...dish })),
  };
}

/**
 * 白名单合并 draftPatch。
 *
 * 与前端 applyDraftPatch 的差异（安全考虑）：
 * - 只接受白名单字段，未知字段一律丢弃。
 * - 空字符串表示“模型没把握/没有提到”，不覆盖已有值。
 * - 价格原样保留（不在合并阶段做取整或换算），由校验器判定合法与否。
 */
export function applyDraftPatch(base: InternalDraft, patch: unknown): InternalDraft {
  const next = cloneDraft(base);
  if (!isPlainObject(patch)) return next;

  for (const field of ['storeName', 'category'] as const) {
    const value = patch[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    next[field] = trimmed;
  }

  if (typeof patch.businessHours === 'string') {
    const normalized = normalizeBusinessHoursText(patch.businessHours);
    if (normalized) next.businessHours = normalized;
  }

  if (isPlainObject(patch.fulfillment)) {
    if (typeof patch.fulfillment.dineIn === 'boolean') {
      next.fulfillment.dineIn = patch.fulfillment.dineIn;
    }
    if (typeof patch.fulfillment.takeaway === 'boolean') {
      next.fulfillment.takeaway = patch.fulfillment.takeaway;
    }
  }

  if (Array.isArray(patch.dishes)) {
    for (const raw of patch.dishes.slice(0, MAX_PATCH_DISHES)) {
      if (!isPlainObject(raw)) continue;
      const hasName = typeof raw.name === 'string' && raw.name.trim().length > 0;
      const name = hasName ? trimText(raw.name) : '';
      const preferredId = normalizeDishIdCandidate(raw.id);
      if (!hasName && !preferredId) continue;

      const index = preferredId
        ? next.dishes.findIndex((dish) => dish.id === preferredId)
        : next.dishes.findIndex((dish) => dish.name === name);
      const hasPrice = Object.prototype.hasOwnProperty.call(raw, 'priceCents');
      const hasDescription = typeof raw.description === 'string';

      if (index === -1) {
        if (!hasName) continue;
        if (next.dishes.some((dish) => dish.name === name)) continue;
        next.dishes.push({
          id: nextDishId(next.dishes, preferredId),
          name,
          priceCents: hasPrice ? normalizePriceForStorage(raw.priceCents) : null,
          description: hasDescription ? trimText(raw.description) : '',
        });
        continue;
      }

      const current = next.dishes[index];
      if (hasName) current.name = name;
      if (hasPrice) current.priceCents = normalizePriceForStorage(raw.priceCents);
      if (hasDescription) current.description = trimText(raw.description);
    }
  }

  return next;
}

function pushMissing(missingFields: MissingField[], field: string, label?: string, detail?: string): void {
  missingFields.push({
    field,
    label: label ?? QUESTION_LABELS[field] ?? FIELD_LABELS[field] ?? field,
    detail: detail ?? MISSING_DETAILS[field] ?? '请补充该项',
  });
}

function pushError(errors: FieldError[], field: string, code: string, message: string): void {
  errors.push({ field, code, message });
}

function validateBusinessHours(value: string, errors: FieldError[]): void {
  const segments = value.split(',').filter(Boolean);
  if (segments.length > MAX_HOURS_SEGMENTS) {
    pushError(
      errors,
      'businessHours',
      'HOURS_TOO_MANY',
      `营业时间最多支持 ${MAX_HOURS_SEGMENTS} 个时段，请删减后再试。`,
    );
  }

  const parsed: Array<{ start: string; end: string }> = [];
  let hasFormatError = false;
  for (const segment of segments) {
    const matched = HOURS_SEGMENT.exec(segment);
    if (!matched) {
      hasFormatError = true;
      continue;
    }
    parsed.push({ start: `${matched[1]}:${matched[2]}`, end: `${matched[3]}:${matched[4]}` });
  }
  if (hasFormatError) {
    pushError(
      errors,
      'businessHours',
      'HOURS_FORMAT',
      '营业时间格式不正确，请使用 HH:MM-HH:MM，例如 10:00-21:00。',
    );
  }

  for (const segment of parsed) {
    // start >= end 包含“相等”和“跨午夜”，本轮一律拒绝。
    if (segment.start >= segment.end) {
      pushError(
        errors,
        'businessHours',
        'HOURS_RANGE',
        '营业时间的开始时间必须早于结束时间，跨午夜请拆成两个时段。',
      );
      break;
    }
  }

  const ordered = [...parsed].sort((left, right) => (left.start < right.start ? -1 : 1));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      pushError(errors, 'businessHours', 'HOURS_OVERLAP', '营业时间的多个时段不能重叠。');
      break;
    }
  }
}

function validateDishes(
  dishes: InternalDraftDish[],
  missingFields: MissingField[],
  errors: FieldError[],
): void {
  if (dishes.length < MIN_DISHES) {
    const gap = MIN_DISHES - dishes.length;
    pushMissing(missingFields, 'dishes', QUESTION_LABELS.dishes, `还差 ${gap} 道菜，一共需要 3–5 道。`);
  }
  if (dishes.length > MAX_DISHES) {
    pushError(
      errors,
      'dishes',
      'DISHES_TOO_MANY',
      `最多保留 ${MAX_DISHES} 道菜，请删减多余的菜品。`,
    );
  }

  const seenIds = new Set<string>();
  dishes.forEach((dish, index) => {
    const label = `第 ${index + 1} 道菜`;

    if (!DISH_ID_PATTERN.test(dish.id)) {
      pushError(errors, `dishes[${index}].id`, 'DISH_ID_INVALID', `${label}缺少可用的本地标识。`);
    } else if (seenIds.has(dish.id)) {
      pushError(errors, `dishes[${index}].id`, 'DISH_ID_INVALID', `${label}的本地标识重复。`);
    } else {
      seenIds.add(dish.id);
    }

    if (!dish.name) {
      pushMissing(missingFields, `dishes[${index}].name`, `${label}菜名`, '填写菜品的名称');
    } else if (codePointLength(dish.name) > MAX_DISH_NAME) {
      pushError(
        errors,
        `dishes[${index}].name`,
        'DISH_NAME_TOO_LONG',
        `${label}的菜名不能超过 ${MAX_DISH_NAME} 个字。`,
      );
    }

    const price = dish.priceCents;
    if (price === null || price === undefined || price === '') {
      pushMissing(missingFields, `dishes[${index}].priceCents`, `${label}价格`, '例如 28 或 28.50');
    } else if (typeof price !== 'number' || !Number.isInteger(price)) {
      pushError(
        errors,
        `dishes[${index}].priceCents`,
        'PRICE_INVALID',
        `${label}的价格必须是整数分，例如 28 或 28.50。`,
      );
    } else if (price < MIN_PRICE_CENTS || price > MAX_PRICE_CENTS) {
      pushError(
        errors,
        `dishes[${index}].priceCents`,
        'PRICE_RANGE',
        `${label}的价格必须在 0.01–9999.99 元之间。`,
      );
    }

    if (dish.description && codePointLength(dish.description) > MAX_DESCRIPTION) {
      pushError(
        errors,
        `dishes[${index}].description`,
        'DESCRIPTION_TOO_LONG',
        `${label}的描述不能超过 ${MAX_DESCRIPTION} 个字。`,
      );
    }
  });
}

export function validateInternalDraft(draft: InternalDraft): DraftValidation {
  const missingFields: MissingField[] = [];
  const errors: FieldError[] = [];

  const storeName = trimText(draft.storeName);
  if (!storeName) {
    pushMissing(missingFields, 'storeName');
  } else if (codePointLength(storeName) > MAX_STORE_NAME) {
    pushError(errors, 'storeName', 'NAME_TOO_LONG', `店名不能超过 ${MAX_STORE_NAME} 个字。`);
  }

  const category = trimText(draft.category);
  if (!category) {
    pushMissing(missingFields, 'category');
  } else if (codePointLength(category) > MAX_CATEGORY) {
    pushError(errors, 'category', 'CATEGORY_TOO_LONG', `品类不能超过 ${MAX_CATEGORY} 个字。`);
  }

  const businessHours = trimText(draft.businessHours);
  if (!businessHours) {
    pushMissing(missingFields, 'businessHours');
  } else {
    validateBusinessHours(businessHours, errors);
  }

  if (!draft.fulfillment.dineIn && !draft.fulfillment.takeaway) {
    pushMissing(missingFields, 'fulfillment');
  }

  validateDishes(draft.dishes, missingFields, errors);

  return {
    missingFields,
    errors,
    readyForReview: missingFields.length === 0 && errors.length === 0,
  };
}

export function buildNextQuestion(validation: DraftValidation): AgentQuestion | null {
  const missing = Array.isArray(validation.missingFields) ? validation.missingFields : [];
  const errors = Array.isArray(validation.errors) ? validation.errors : [];

  if (missing.length) {
    const first = missing[0];
    if (first.field === 'dishes') {
      return { field: 'dishes', label: QUESTION_LABELS.dishes, text: NEXT_QUESTION_TEXT.dishes };
    }
    const dishName = /^dishes\[(\d+)\]\.name$/.exec(first.field);
    if (dishName) {
      return {
        field: first.field,
        label: first.label,
        text: `第 ${Number(dishName[1]) + 1} 道菜的菜名是什么？`,
      };
    }
    const dishPrice = /^dishes\[(\d+)\]\.priceCents$/.exec(first.field);
    if (dishPrice) {
      return {
        field: first.field,
        label: first.label,
        text: `${first.label}是多少钱？例如 28 或 28.50。`,
      };
    }
    return {
      field: first.field,
      label: first.label,
      text: NEXT_QUESTION_TEXT[first.field] ?? first.detail ?? '还需要补充这项资料。',
    };
  }

  if (errors.length) {
    const first = errors[0];
    return {
      field: first.field,
      label: FIELD_LABELS[first.field] ?? first.field,
      text: first.message,
    };
  }

  return null;
}