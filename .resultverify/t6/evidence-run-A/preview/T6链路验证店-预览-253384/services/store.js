const { request } = require('./request.js');
const ApiError = require('./api-error.js');

/**
 * 门店字段兜底：后端某些字段可能返回 null（未填地址、未填营业时间等），
 * 组件属性声明的是 String，直接绑 null 会在开发者工具里报
 * "received type-uncompatible value: expected <String> but get null value"。
 */
function textOrEmpty(value) {
  if (value === null || value === undefined) return '';
  return value;
}

function normalizeStore(store) {
  if (!store || typeof store !== 'object') return store;
  return {
    ...store,
    name: textOrEmpty(store.name),
    category: textOrEmpty(store.category),
    address: textOrEmpty(store.address),
    phone: textOrEmpty(store.phone),
    notes: textOrEmpty(store.notes),
    businessHours: textOrEmpty(store.businessHours),
  };
}

function assertStoreId(storeId) {
  if (!storeId || typeof storeId !== 'string') {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
}

async function getStore(storeId) {
  assertStoreId(storeId);
  const store = await request({
    path: '/stores/' + encodeURIComponent(storeId),
    method: 'GET',
    auth: false,
  });
  return normalizeStore(store);
}

async function getCatalog(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/stores/' + encodeURIComponent(storeId) + '/catalog',
    method: 'GET',
    auth: false,
  });
}

async function getTables(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/stores/' + encodeURIComponent(storeId) + '/tables',
    method: 'GET',
    auth: false,
  });
}

async function getPosters(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/stores/' + encodeURIComponent(storeId) + '/posters',
    method: 'GET',
    auth: false,
  });
}

module.exports = {
  getStore,
  getCatalog,
  getTables,
  getPosters,
  normalizeStore,
};
