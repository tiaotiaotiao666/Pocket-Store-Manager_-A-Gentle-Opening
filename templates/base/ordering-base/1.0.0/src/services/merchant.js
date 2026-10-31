const { request } = require('./request.js');
const ApiError = require('./api-error.js');

function assertStoreId(storeId) {
  if (!storeId) {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
}

async function listOrders(storeId, query) {
  assertStoreId(storeId);
  const input = query || {};
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/orders',
    method: 'GET',
    query: {
      status: input.status || '',
      page: input.page || 1,
      pageSize: input.pageSize || 20,
    },
  });
}

async function updateOrderStatus(orderId, payload) {
  if (!orderId) {
    throw ApiError.client('ORDER_ID_REQUIRED', '缺少订单编号');
  }
  const input = payload || {};
  if (!input.toStatus) {
    throw ApiError.client('TARGET_STATUS_REQUIRED', '缺少目标状态');
  }
  const body = { toStatus: input.toStatus };
  if (input.expectedStatus) {
    body.expectedStatus = input.expectedStatus;
  }
  if (input.reason) {
    body.reason = input.reason;
  }
  return request({
    path: '/merchant/orders/' + encodeURIComponent(orderId) + '/status',
    method: 'PATCH',
    data: body,
  });
}

async function listProducts(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/products',
    method: 'GET',
  });
}

async function updateAvailability(productId, available) {
  if (!productId) {
    throw ApiError.client('PRODUCT_ID_REQUIRED', '缺少商品编号');
  }
  return request({
    path: '/merchant/products/' + encodeURIComponent(productId) + '/availability',
    method: 'PATCH',
    data: { available: Boolean(available) },
  });
}

module.exports = {
  listOrders,
  updateOrderStatus,
  listProducts,
  updateAvailability,
};