const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const API_BASE_URL = String(ENV.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
const AUTH_MODE = String(ENV.VITE_IMPORT_AUTH_MODE || 'demo');
const DEMO_OWNER_OPEN_ID = 'demo-owner-001';
const DEFAULT_STORE_ID = String(ENV.VITE_DEMO_STORE_ID || 'store-demo-001');

const IMPORT_ERROR_TEXT = Object.freeze({
  AUTH_REQUIRED: '登录已失效，请重新进入导入。',
  DEMO_LOGIN_DISABLED: '当前环境已关闭演示登录，请在微信小程序端完成配置导入。',
  FORBIDDEN: '只有店主可以导入门店配置。',
  STORE_NOT_FOUND: '门店不存在或已被移除。',
  VALIDATION_ERROR: '导入内容不符合要求，请检查菜品数量、价格与营业时间。',
  DUPLICATE_CATEGORY: '分类名称重复，请先合并。',
  DUPLICATE_PRODUCT: '同一分类下菜品名称重复。',
  DUPLICATE_TABLE: '桌号名称重复。',
  PRICE_RANGE: '菜品价格必须是 1–999999 的整数分。',
  HOURS_OVERLAP: '营业时段不能重叠。',
  HOURS_FORMAT: '营业时间格式应为 HH:MM。',
  HOURS_RANGE: '营业时段开始时间必须早于结束时间。',
  DELIVERY_NOT_SUPPORTED: '本项目不支持外送。',
  CONFIRMATION_REQUIRED: '还有冲突项未确认，不能导入。',
  PREVIEW_STALE: '预览已过期或内容已变化，请重新检查差异。',
  IDEMPOTENCY_CONFLICT: '同一提交标识对应了不同内容，请重新发起导入。',
  IMPORT_NOT_FOUND: '导入记录不存在。',
  NETWORK_ERROR: '无法连接后端，请确认本地服务已启动。',
});

let sessionToken = null;
let tokenPromise = null;

export function describeImportError(code) {
  return IMPORT_ERROR_TEXT[code] || '导入失败，请稍后重试。';
}

export function resetImportSession() {
  sessionToken = null;
  tokenPromise = null;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(API_BASE_URL + path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    return { ok: false, status: 0, code: 'NETWORK_ERROR', message: describeImportError('NETWORK_ERROR') };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: (data && data.code) || 'HTTP_' + response.status,
      message: (data && data.message) || describeImportError(data && data.code),
      fields: (data && data.details && data.details.fields) || [],
      details: (data && data.details) || null,
    };
  }
  return { ok: true, status: response.status, data };
}

async function ensureToken() {
  if (sessionToken) return { ok: true, token: sessionToken };
  if (AUTH_MODE !== 'demo') {
    return { ok: false, code: 'DEMO_LOGIN_DISABLED', message: describeImportError('DEMO_LOGIN_DISABLED') };
  }
  if (!tokenPromise) {
    tokenPromise = request('/auth/wechat/login', {
      method: 'POST',
      body: { demoOpenId: DEMO_OWNER_OPEN_ID },
    }).then((result) => {
      if (!result.ok) {
        if (result.code === 'DEMO_LOGIN_DISABLED') {
          return { ...result, message: describeImportError('DEMO_LOGIN_DISABLED') };
        }
        return result;
      }
      sessionToken = result.data.token;
      return { ok: true, token: sessionToken };
    }).finally(() => {
      tokenPromise = null;
    });
  }
  const result = await tokenPromise;
  if (!result.ok) return result;
  return { ok: true, token: result.token };
}

function businessHoursSegments(text) {
  const source = String(text || '').trim();
  if (!source) return [{ start: '10:00', end: '21:00' }];
  const segments = source.split(/[，,;；、]/).map((segment) => segment.trim()).filter(Boolean).map((segment) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(segment);
    return match ? { start: match[1] + ':' + match[2], end: match[3] + ':' + match[4] } : null;
  }).filter(Boolean);
  return segments.length ? segments : [{ start: '10:00', end: '21:00' }];
}

export async function buildImportPayload(agentDraft, store = {}) {
  const draft = agentDraft || {};
  const categoryName = String(draft.category || store.type || '全部菜品').trim().slice(0, 48) || '全部菜品';
  const categoryDraftId = 'cat-default';
  const products = (Array.isArray(draft.dishes) ? draft.dishes : [])
    .filter((dish) => dish && String(dish.name || '').trim() && Number.isInteger(dish.priceCents))
    .map((dish, index) => ({
      draftId: 'dish-' + (dish.id || index + 1),
      categoryDraftId,
      name: String(dish.name).trim().slice(0, 48),
      priceCents: dish.priceCents,
      description: String(dish.description || '').trim().slice(0, 255),
      available: true,
    }));

  const payload = {
    profile: {
      name: String(store.name || draft.storeName || '').trim().slice(0, 48),
      category: categoryName,
      address: String(store.address || '').trim().slice(0, 120),
      phone: String(store.phone || '').trim().slice(0, 32),
      notes: String(store.notes || '').trim().slice(0, 200),
      businessHours: businessHoursSegments(draft.businessHours),
    },
    categories: [{ draftId: categoryDraftId, name: categoryName, sortOrder: 1 }],
    products,
    tables: [],
    sourceDraftDigest: '',
    unsupported: { images: true, modifiers: false, specs: false },
    delivery: false,
  };
  payload.sourceDraftDigest = await sha256Hex(JSON.stringify(payload));
  return payload;
}

export async function previewImport({ storeId, payload }) {
  const auth = await ensureToken();
  if (!auth.ok) {
    return {
      status: auth.code === 'DEMO_LOGIN_DISABLED' ? 'auth-unavailable' : 'failed',
      code: auth.code,
      message: auth.message,
    };
  }
  const result = await request(`/merchant/stores/${encodeURIComponent(storeId)}/imports`, {
    method: 'POST',
    token: auth.token,
    body: { mode: 'preview', payload },
  });
  if (!result.ok) {
    if (result.code === 'DEMO_LOGIN_DISABLED') {
      resetImportSession();
      return { status: 'auth-unavailable', code: result.code, message: describeImportError('DEMO_LOGIN_DISABLED') };
    }
    return { status: 'failed', code: result.code, message: result.message, fields: result.fields };
  }
  return { status: 'ok', data: result.data };
}

export async function applyImport({ storeId, payload, previewToken, confirmations = [], idempotencyKey }) {
  const auth = await ensureToken();
  if (!auth.ok) {
    return {
      status: auth.code === 'DEMO_LOGIN_DISABLED' ? 'auth-unavailable' : 'failed',
      code: auth.code,
      message: auth.message,
    };
  }
  const key = idempotencyKey || (globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'import-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const result = await request(`/merchant/stores/${encodeURIComponent(storeId)}/imports`, {
    method: 'POST',
    token: auth.token,
    headers: { 'Idempotency-Key': key },
    body: { mode: 'apply', payload, previewToken, confirmations },
  });
  if (!result.ok) {
    if (result.code === 'DEMO_LOGIN_DISABLED' || result.status === 401) {
      resetImportSession();
      const message = result.code === 'DEMO_LOGIN_DISABLED' ? describeImportError('DEMO_LOGIN_DISABLED') : result.message;
      return { status: 'auth-unavailable', code: result.code, message };
    }
    return { status: 'failed', code: result.code, message: result.message, details: result.details };
  }
  return { status: 'ok', data: result.data, idempotencyKey: key };
}

export async function getImport({ storeId, importId }) {
  const auth = await ensureToken();
  if (!auth.ok) return { status: 'auth-unavailable', code: auth.code, message: auth.message };
  const result = await request(`/merchant/stores/${encodeURIComponent(storeId)}/imports/${encodeURIComponent(importId)}`, {
    token: auth.token,
  });
  if (!result.ok) return { status: 'failed', code: result.code, message: result.message };
  return { status: 'ok', data: result.data };
}

export async function refreshCatalog(storeId) {
  const result = await request(`/stores/${encodeURIComponent(storeId)}/catalog`);
  if (!result.ok) return { status: 'failed', code: result.code, message: result.message };
  return { status: 'ok', data: result.data };
}

export function getImportAuthMode() {
  return AUTH_MODE;
}

export { API_BASE_URL, DEFAULT_STORE_ID, IMPORT_ERROR_TEXT };