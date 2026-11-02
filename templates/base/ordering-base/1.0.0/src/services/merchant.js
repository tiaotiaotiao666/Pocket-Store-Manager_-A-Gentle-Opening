const { request } = require('./request.js');
const ApiError = require('./api-error.js');

function assertStoreId(storeId) {
  if (!storeId) {
    throw ApiError.client('STORE_REQUIRED', '缺少门店信息，请重新扫码');
  }
}

function assertProductId(productId) {
  if (!productId) {
    throw ApiError.client('PRODUCT_ID_REQUIRED', '缺少商品编号');
  }
}

function assertCategoryId(categoryId) {
  if (!categoryId) {
    throw ApiError.client('CATEGORY_ID_REQUIRED', '缺少分类编号');
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
      order: input.order || 'asc',
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
  assertProductId(productId);
  return request({
    path: '/merchant/products/' + encodeURIComponent(productId) + '/availability',
    method: 'PATCH',
    data: { available: Boolean(available) },
  });
}

async function createCategory(storeId, payload) {
  assertStoreId(storeId);
  const input = payload || {};
  const body = { name: input.name };
  if (input.sortOrder !== undefined) {
    body.sortOrder = input.sortOrder;
  }
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/categories',
    method: 'POST',
    data: body,
  });
}

async function updateCategory(categoryId, payload) {
  assertCategoryId(categoryId);
  const input = payload || {};
  const body = {};
  if (input.name !== undefined) {
    body.name = input.name;
  }
  if (input.sortOrder !== undefined) {
    body.sortOrder = input.sortOrder;
  }
  return request({
    path: '/merchant/categories/' + encodeURIComponent(categoryId),
    method: 'PATCH',
    data: body,
  });
}

async function createProduct(storeId, payload) {
  assertStoreId(storeId);
  const input = payload || {};
  const body = {
    categoryId: input.categoryId,
    name: input.name,
    priceCents: input.priceCents,
  };
  if (input.description !== undefined) {
    body.description = input.description;
  }
  if (input.available !== undefined) {
    body.available = Boolean(input.available);
  }
  if (input.sortOrder !== undefined) {
    body.sortOrder = input.sortOrder;
  }
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/products',
    method: 'POST',
    data: body,
  });
}

async function updateProductPrice(productId, payload) {
  assertProductId(productId);
  const input = payload || {};
  return request({
    path: '/merchant/products/' + encodeURIComponent(productId) + '/price',
    method: 'PATCH',
    data: {
      priceCents: input.priceCents,
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
  });
}

module.exports = {
  listOrders,
  updateOrderStatus,
  listProducts,
  updateAvailability,
  createCategory,
  updateCategory,
  createProduct,
  updateProductPrice,
};