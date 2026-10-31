/**
 * B3 受控导入差异纯函数。
 *
 * 原则：
 * - 默认动作 skip：不静默改价、不静默上架、不删除未声明项。
 * - 冲突必须进入 conflicts，apply 时逐项 confirmations。
 * - 请求内重名与数量边界在这里统一拒绝（422）。
 */

export type ImportAction = 'create' | 'update' | 'skip' | 'conflict';

export interface ImportBusinessHour {
  start: string;
  end: string;
}

export interface ImportProfile {
  name: string;
  category: string;
  address?: string;
  phone?: string;
  notes?: string;
  businessHours: ImportBusinessHour[];
}

export interface ImportCategory {
  draftId: string;
  name: string;
  sortOrder?: number;
}

export interface ImportProduct {
  draftId: string;
  categoryDraftId: string;
  name: string;
  priceCents: number;
  description?: string;
  available: boolean;
  imageUrl?: unknown;
  modifiers?: unknown;
  specs?: unknown;
}

export interface ImportTable {
  draftId: string;
  name: string;
  sortOrder?: number;
}

export interface ImportPayload {
  profile: ImportProfile;
  categories: ImportCategory[];
  products: ImportProduct[];
  tables: ImportTable[];
  sourceDraftDigest: string;
  unsupported?: {
    images?: boolean;
    modifiers?: boolean;
    specs?: boolean;
  };
  delivery?: boolean;
}

export interface ExistingProduct {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
}

export interface ExistingCategory {
  id: string;
  name: string;
  sortOrder: number;
  products: ExistingProduct[];
}

export interface ExistingTable {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ExistingStore {
  name: string;
  category: string;
  address: string;
  phone: string;
  businessHours: string;
  categories: ExistingCategory[];
  tables: ExistingTable[];
}

export interface ProfileDiff {
  field: 'name' | 'category' | 'address' | 'phone' | 'businessHours';
  current: string;
  incoming: string;
  action: ImportAction;
  confirmationKey: string;
}

export interface CategoryDiff {
  draftId: string;
  name: string;
  sortOrder: number;
  action: ImportAction;
  confirmationKey: string;
  existingId?: string;
}

export interface ProductDiff {
  draftId: string;
  categoryDraftId: string;
  name: string;
  priceCents: number;
  available: boolean;
  description: string;
  action: ImportAction;
  confirmationKey: string;
  existingId?: string;
  reasons?: string[];
}

export interface TableDiff {
  draftId: string;
  name: string;
  sortOrder: number;
  action: ImportAction;
  confirmationKey: string;
  existingId?: string;
}

export interface ImportDiff {
  profile: ProfileDiff[];
  categories: CategoryDiff[];
  products: ProductDiff[];
  tables: TableDiff[];
  conflicts: string[];
  notImported: string[];
  summary: { create: number; update: number; skip: number; conflict: number };
}

export interface ValidationFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult = { ok: true } | ValidationFailure;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

function fail(status: number, code: string, message: string, details?: Record<string, unknown>): ValidationFailure {
  return { ok: false, status, code, message, details };
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

export function joinBusinessHours(segments: ImportBusinessHour[]): string {
  return segments.map((segment) => `${segment.start}-${segment.end}`).join(',');
}

export function validateBusinessHours(segments: ImportBusinessHour[]): ValidationResult {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 3) {
    return fail(422, 'VALIDATION_ERROR', '营业时间必须是 1–3 个时段。', { field: 'businessHours' });
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const segment of segments) {
    if (!segment || !TIME_PATTERN.test(String(segment.start || '')) || !TIME_PATTERN.test(String(segment.end || ''))) {
      return fail(422, 'HOURS_FORMAT', '营业时间格式必须是 HH:MM。', { segment });
    }
    const start = minutesOf(segment.start);
    const end = minutesOf(segment.end);
    if (start >= end) {
      return fail(422, 'HOURS_RANGE', '营业时段开始时间必须早于结束时间。', { segment });
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      return fail(422, 'HOURS_OVERLAP', '营业时段不能重叠。', { index });
    }
  }
  if (joinBusinessHours(segments).length > 64) {
    return fail(422, 'HOURS_TOO_LONG', '营业时间拼接后不能超过 64 字符。');
  }
  return { ok: true };
}

export function validateImportPayload(payload: ImportPayload): ValidationResult {
  if (!payload || typeof payload !== 'object') {
    return fail(422, 'VALIDATION_ERROR', '导入内容不能为空。');
  }
  if (payload.delivery === true) {
    return fail(422, 'DELIVERY_NOT_SUPPORTED', '本项目不支持外送。');
  }
  if (!payload.profile || !String(payload.profile.name || '').trim()) {
    return fail(422, 'VALIDATION_ERROR', '缺少门店名称。', { field: 'profile.name' });
  }
  if (!String(payload.profile.category || '').trim()) {
    return fail(422, 'VALIDATION_ERROR', '缺少门店品类。', { field: 'profile.category' });
  }
  const hours = validateBusinessHours(payload.profile.businessHours);
  if (!hours.ok) return hours;

  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const products = Array.isArray(payload.products) ? payload.products : [];
  const tables = Array.isArray(payload.tables) ? payload.tables : [];

  if (categories.length > 3) {
    return fail(422, 'VALIDATION_ERROR', '分类最多 3 个。', { field: 'categories' });
  }
  if (products.length < 3 || products.length > 5) {
    return fail(422, 'VALIDATION_ERROR', '菜品必须是 3–5 道。', { field: 'products' });
  }
  if (tables.length > 20) {
    return fail(422, 'VALIDATION_ERROR', '桌号最多 20 个。', { field: 'tables' });
  }

  const draftIds = [...categories, ...products, ...tables].map((item) => String(item.draftId || ''));
  if (!unique(draftIds) || draftIds.some((id) => !id)) {
    return fail(422, 'VALIDATION_ERROR', 'draftId 必须存在且请求内唯一。', { field: 'draftId' });
  }

  const categoryNames = categories.map((category) => String(category.name || '').trim());
  if (categoryNames.some((name) => !name) || !unique(categoryNames)) {
    return fail(422, 'DUPLICATE_CATEGORY', '分类名称必须存在且不重复。', { field: 'categories.name' });
  }

  const productKeys = products.map((product) => `${product.categoryDraftId}::${String(product.name || '').trim()}`);
  if (productKeys.some((key) => key.endsWith('::')) || !unique(productKeys)) {
    return fail(422, 'DUPLICATE_PRODUCT', '同一分类下的菜品名称不能重复。', { field: 'products.name' });
  }

  const tableNames = tables.map((table) => String(table.name || '').trim());
  if (tableNames.some((name) => !name) || !unique(tableNames)) {
    return fail(422, 'DUPLICATE_TABLE', '桌号名称必须存在且不重复。', { field: 'tables.name' });
  }

  const knownCategories = new Set(categories.map((category) => category.draftId));
  for (const product of products) {
    if (!knownCategories.has(product.categoryDraftId)) {
      return fail(422, 'VALIDATION_ERROR', `菜品 ${product.name} 引用了不存在的分类。`, {
        field: 'products.categoryDraftId',
        categoryDraftId: product.categoryDraftId,
      });
    }
    if (!Number.isInteger(product.priceCents) || product.priceCents < 1 || product.priceCents > 999999) {
      return fail(422, 'PRICE_RANGE', `菜品 ${product.name} 的价格必须是 1–999999 的整数分。`, {
        field: 'products.priceCents',
      });
    }
    if (typeof product.available !== 'boolean') {
      return fail(422, 'VALIDATION_ERROR', `菜品 ${product.name} 必须显式声明 available。`, { field: 'products.available' });
    }
  }

  const unsupported = payload.unsupported || {};
  if (unsupported.images || unsupported.modifiers || unsupported.specs) {
    // 允许通过 unsupported 声明，但不会导入；具体清单在 diff.notImported 中体现。
  }

  if (payload.sourceDraftDigest && !/^[0-9a-f]{64}$/.test(payload.sourceDraftDigest)) {
    return fail(422, 'VALIDATION_ERROR', 'sourceDraftDigest 必须是 64 位小写十六进制。', { field: 'sourceDraftDigest' });
  }

  return { ok: true };
}

export function validateIdempotencyKey(key: string | undefined): ValidationResult {
  if (!key) return fail(400, 'BAD_REQUEST', 'apply 必须提供 Idempotency-Key。');
  if (key.length < 8 || key.length > 128 || !VISIBLE_ASCII.test(key)) {
    return fail(400, 'BAD_REQUEST', 'Idempotency-Key 必须是 8–128 位可见 ASCII。');
  }
  return { ok: true };
}

export function computeImportDiff(payload: ImportPayload, existing: ExistingStore): ImportDiff {
  const profile: ProfileDiff[] = [];
  const incomingHours = joinBusinessHours(payload.profile.businessHours);
  const profileFields: Array<{ field: ProfileDiff['field']; incoming: string }> = [
    { field: 'name', incoming: String(payload.profile.name || '').trim() },
    { field: 'category', incoming: String(payload.profile.category || '').trim() },
    { field: 'address', incoming: String(payload.profile.address || '').trim() },
    { field: 'phone', incoming: String(payload.profile.phone || '').trim() },
    { field: 'businessHours', incoming: incomingHours },
  ];
  for (const item of profileFields) {
    const current = String((existing as unknown as Record<string, string>)[item.field] || '');
    const action: ImportAction = current === item.incoming ? 'skip' : 'conflict';
    profile.push({
      field: item.field,
      current,
      incoming: item.incoming,
      action,
      confirmationKey: `profile.${item.field}`,
    });
  }

  const categoryByDraft = new Map<string, CategoryDiff>();
  const categories: CategoryDiff[] = [];
  for (const category of payload.categories) {
    const matched = existing.categories.find((item) => item.name === category.name);
    const diff: CategoryDiff = {
      draftId: category.draftId,
      name: category.name,
      sortOrder: Number.isInteger(category.sortOrder) ? Number(category.sortOrder) : 1,
      action: matched ? 'skip' : 'create',
      confirmationKey: `category:${category.draftId}`,
      existingId: matched ? matched.id : undefined,
    };
    categories.push(diff);
    categoryByDraft.set(category.draftId, diff);
  }

  const products: ProductDiff[] = [];
  for (const product of payload.products) {
    const categoryDiff = categoryByDraft.get(product.categoryDraftId);
    const matchedCategory = categoryDiff && categoryDiff.existingId
      ? existing.categories.find((item) => item.id === categoryDiff.existingId)
      : null;
    const matched = matchedCategory
      ? matchedCategory.products.find((item) => item.name === product.name)
      : undefined;

    let action: ImportAction = 'create';
    const reasons: string[] = [];
    if (matched) {
      if (matched.priceCents !== product.priceCents) {
        action = 'conflict';
        reasons.push('PRICE_CHANGED');
      }
      if (matched.available !== product.available) {
        action = 'conflict';
        reasons.push(matched.available ? 'WILL_UNLIST' : 'WILL_LIST');
      }
      if (action !== 'conflict') action = 'skip';
    }

    products.push({
      draftId: product.draftId,
      categoryDraftId: product.categoryDraftId,
      name: product.name,
      priceCents: product.priceCents,
      available: product.available,
      description: String(product.description || ''),
      action,
      confirmationKey: `product:${product.draftId}`,
      existingId: matched ? matched.id : undefined,
      reasons: reasons.length ? reasons : undefined,
    });
  }

  const tables: TableDiff[] = [];
  for (const table of payload.tables) {
    const matched = existing.tables.find((item) => item.name === table.name);
    tables.push({
      draftId: table.draftId,
      name: table.name,
      sortOrder: Number.isInteger(table.sortOrder) ? Number(table.sortOrder) : 1,
      action: matched ? 'skip' : 'create',
      confirmationKey: `table:${table.draftId}`,
      existingId: matched ? matched.id : undefined,
    });
  }

  const conflicts = [
    ...profile.filter((item) => item.action === 'conflict').map((item) => item.confirmationKey),
    ...products.filter((item) => item.action === 'conflict').map((item) => item.confirmationKey),
  ];

  const notImported: string[] = [];
  if (payload.profile.notes && payload.profile.notes.trim()) notImported.push('店铺简介');
  if (payload.unsupported && payload.unsupported.images) notImported.push('菜品图片');
  if (payload.unsupported && payload.unsupported.modifiers) notImported.push('加料');
  if (payload.unsupported && payload.unsupported.specs) notImported.push('规格');
  notImported.push('外送');

  const counts = { create: 0, update: 0, skip: 0, conflict: 0 };
  [...profile, ...categories, ...products, ...tables].forEach((item) => {
    counts[item.action] += 1;
  });

  return { profile, categories, products, tables, conflicts, notImported, summary: counts };
}

export function assertConfirmations(diff: ImportDiff, confirmations: string[] | undefined): ValidationResult {
  const provided = new Set((confirmations || []).map((item) => String(item)));
  const missing = diff.conflicts.filter((key) => !provided.has(key));
  if (missing.length > 0) {
    return fail(422, 'CONFIRMATION_REQUIRED', '存在未确认的冲突项，不能导入。', { missing });
  }
  return { ok: true };
}