const { request } = require('./request.js');
const ApiError = require('./api-error.js');

function assertStoreId(storeId) {
  if (!storeId || typeof storeId !== 'string') {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
}

async function getStore(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/stores/' + encodeURIComponent(storeId),
    method: 'GET',
    auth: false,
  });
}

async function getCatalog(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/stores/' + encodeURIComponent(storeId) + '/catalog',
    method: 'GET',
    auth: false,
  });
}

module.exports = {
  getStore,
  getCatalog,
};