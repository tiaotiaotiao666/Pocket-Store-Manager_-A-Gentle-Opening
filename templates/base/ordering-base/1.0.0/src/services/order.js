const { request } = require('./request.js');
const ApiError = require('./api-error.js');
const idempotency = require('../domain/idempotency.js');

function assertOrderId(orderId) {
  if (!orderId) {
    throw ApiError.client('ORDER_ID_REQUIRED', '缺少订单编号');
  }
}

async function createOrder(payload, idempotencyKey) {
  const input = payload || {};
  if (!idempotency.isValidKey(idempotencyKey)) {
    throw ApiError.client('IDEMPOTENCY_KEY_REQUIRED', '结算凭证无效，请返回重新结算');
  }
  if (!input.storeId) {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw ApiError.client('CART_EMPTY', '购物车是空的，请先选择菜品');
  }

  const body = {
    storeId: input.storeId,
    fulfillmentType: input.fulfillmentType,
    items: input.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    note: input.note || '',
  };
  if (input.fulfillmentType === 'DINE_IN' && input.tableId) {
    body.tableId = input.tableId;
  }

  return request({
    path: '/orders',
    method: 'POST',
    data: body,
    idempotencyKey,
  });
}

async function listOrders(query) {
  const input = query || {};
  if (!input.storeId) {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
  return request({
    path: '/orders',
    method: 'GET',
    query: {
      storeId: input.storeId,
      status: input.status || '',
      active: input.active === true ? 'true' : '',
      page: input.page || 1,
      pageSize: input.pageSize || 20,
    },
  });
}

async function getOrder(orderId) {
  assertOrderId(orderId);
  return request({
    path: '/orders/' + encodeURIComponent(orderId),
    method: 'GET',
  });
}

async function demoPayment(orderId) {
  assertOrderId(orderId);
  return request({
    path: '/orders/' + encodeURIComponent(orderId) + '/demo-payment',
    method: 'POST',
    data: {},
  });
}

async function cancelOrder(orderId, reason) {
  assertOrderId(orderId);
  return request({
    path: '/orders/' + encodeURIComponent(orderId) + '/cancel',
    method: 'POST',
    data: { reason: reason || '' },
  });
}

module.exports = {
  createOrder,
  listOrders,
  getOrder,
  demoPayment,
  cancelOrder,
};