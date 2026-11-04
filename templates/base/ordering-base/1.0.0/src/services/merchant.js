const config = require('../config/env.js');
const platform = require('./platform.js');
const core = require('./request-core.js');
const ApiError = require('./api-error.js');
const session = require('./session.js');
const requestService = require('./request.js');
const { request } = requestService;

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
  if (input.imageUrl) {
    body.imageUrl = input.imageUrl;
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

async function updateProduct(productId, payload) {
  assertProductId(productId);
  const input = payload || {};
  const body = { expectedUpdatedAt: input.expectedUpdatedAt };
  ['categoryId', 'name', 'description', 'imageUrl', 'priceCents', 'sortOrder'].forEach((key) => {
    if (input[key] !== undefined) body[key] = input[key];
  });
  if (input.available !== undefined) body.available = Boolean(input.available);
  return request({
    path: '/merchant/products/' + encodeURIComponent(productId),
    method: 'PATCH',
    data: body,
  });
}

async function listPosters(storeId) {
  assertStoreId(storeId);
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/posters',
    method: 'GET',
  });
}

async function createPoster(storeId, payload) {
  assertStoreId(storeId);
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/posters',
    method: 'POST',
    data: payload || {},
  });
}

async function updatePoster(posterId, payload) {
  if (!posterId) throw ApiError.client('POSTER_ID_REQUIRED', '缺少海报编号');
  return request({ path: '/merchant/posters/' + encodeURIComponent(posterId), method: 'PATCH', data: payload || {} });
}

async function deletePoster(posterId) {
  if (!posterId) throw ApiError.client('POSTER_ID_REQUIRED', '缺少海报编号');
  return request({ path: '/merchant/posters/' + encodeURIComponent(posterId), method: 'DELETE' });
}

async function reorderPosters(storeId, ids) {
  assertStoreId(storeId);
  return request({
    path: '/merchant/stores/' + encodeURIComponent(storeId) + '/posters/reorder',
    method: 'PATCH',
    data: { ids: Array.isArray(ids) ? ids : [] },
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

function uploadImageRequest(storeId, filePath, token) {
  return new Promise((resolve, reject) => {
    platform.uploadFile({
      url: core.buildUrl(config.API_BASE_URL, '/media/stores/' + encodeURIComponent(storeId) + '/images'),
      filePath,
      name: 'file',
      header: { Authorization: 'Bearer ' + token },
      timeout: 30000,
    }, (result) => {
      if (result && result.error) {
        reject(ApiError.network(result.error.errMsg, result.error.timeout));
        return;
      }
      const body = core.parseBody(result && result.data);
      if (core.isSuccess(result && result.statusCode)) {
        resolve(body);
        return;
      }
      reject(core.toApiError(result && result.statusCode, body));
    });
  });
}

async function uploadImage(storeId, filePath) {
  assertStoreId(storeId);
  if (!filePath) throw ApiError.client('IMAGE_REQUIRED', '请选择图片后再上传');
  let token = session.getToken();
  if (!token) {
    await requestService.demoRelogin();
    token = session.getToken();
    if (!token) throw ApiError.client('AUTH_REQUIRED', '请先登录店主账号');
  }
  try {
    return await uploadImageRequest(storeId, filePath, token);
  } catch (error) {
    if (!(error instanceof ApiError) || !core.shouldRetryAuth(error.statusCode, error.code)) {
      throw error;
    }
    await requestService.demoRelogin();
    token = session.getToken();
    if (!token) throw ApiError.client('AUTH_REQUIRED', '店主登录已过期，请重新登录');
    return uploadImageRequest(storeId, filePath, token);
  }
}

module.exports = {
  listOrders,
  updateOrderStatus,
  listProducts,
  updateAvailability,
  createCategory,
  updateCategory,
  createProduct,
  updateProduct,
  updateProductPrice,
  listPosters,
  createPoster,
  updatePoster,
  deletePoster,
  reorderPosters,
  uploadImage,
};
