const AUTH_CODES = ['AUTH_REQUIRED', 'AUTH_INVALID'];
const CATALOG_CODES = ['PRODUCT_UNAVAILABLE', 'PRODUCT_NOT_FOUND', 'STORE_NOT_FOUND'];
const NETWORK_CODE = 'NETWORK_ERROR';
const TIMEOUT_CODE = 'REQUEST_TIMEOUT';

const MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请检查后端服务是否已启动',
  REQUEST_TIMEOUT: '请求超时，请稍后重试',
  AUTH_REQUIRED: '登录状态已失效，请重新登录',
  AUTH_INVALID: '登录凭证无效，请重新登录',
  FORBIDDEN: '当前身份没有该门店的操作权限',
  STORE_NOT_FOUND: '门店不存在或已下线',
  TABLE_REQUIRED: '堂食订单需要桌号，请扫描桌台二维码',
  TABLE_NOT_FOUND: '该桌号不属于当前门店，请重新扫码',
  PRODUCT_UNAVAILABLE: '有商品已停售，请刷新菜单后重新选择',
  PRODUCT_NOT_FOUND: '商品已下架或不存在',
  VALIDATION_ERROR: '填写内容不符合要求，请检查后重试',
  IDEMPOTENCY_CONFLICT: '本次提交内容与上次不一致，请重新结算',
  INVALID_STATUS_TRANSITION: '当前订单状态不支持该操作',
  STATUS_CONFLICT: '订单状态已变化，请刷新后重试',
  MERCHANT_CANNOT_HANDLE_UNPAID: '顾客尚未完成模拟支付，暂不能接单',
  DEMO_LOGIN_DISABLED: '当前环境未开启演示登录',
  DEMO_PAYMENT_DISABLED: '当前环境未开启演示模拟支付',
  WECHAT_NOT_CONFIGURED: '服务端未配置微信登录，暂只能使用演示登录',
  WECHAT_UPSTREAM_ERROR: '微信登录服务暂时不可用，请稍后重试',
  ORDER_NOT_FOUND: '订单不存在或无权查看',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务端开小差了，请稍后重试',
};

const ACTIONS = {
  AUTH_REQUIRED: '重新登录',
  AUTH_INVALID: '重新登录',
  PRODUCT_UNAVAILABLE: '刷新菜单',
  PRODUCT_NOT_FOUND: '刷新菜单',
  TABLE_REQUIRED: '重新扫码',
  TABLE_NOT_FOUND: '重新扫码',
  STATUS_CONFLICT: '刷新订单',
  INVALID_STATUS_TRANSITION: '刷新订单',
  NETWORK_ERROR: '检查网络后重试',
  REQUEST_TIMEOUT: '重试',
};

function normalizeError(error) {
  const source = error && typeof error === 'object' ? error : {};
  const code = typeof source.code === 'string' && source.code ? source.code : NETWORK_CODE;
  const message = typeof source.message === 'string' && source.message ? source.message : MESSAGES[code] || MESSAGES.NETWORK_ERROR;
  return {
    code,
    message,
    requestId: source.requestId || '',
    statusCode: Number(source.statusCode) || 0,
    details: source.details && typeof source.details === 'object' ? source.details : {},
  };
}

function describeError(error) {
  const normalized = normalizeError(error);
  return {
    code: normalized.code,
    message: MESSAGES[normalized.code] || normalized.message,
    action: ACTIONS[normalized.code] || '',
    requestId: normalized.requestId,
    statusCode: normalized.statusCode,
  };
}

function isAuthError(code) {
  return AUTH_CODES.indexOf(code) >= 0;
}

function isCatalogError(code) {
  return CATALOG_CODES.indexOf(code) >= 0;
}

module.exports = {
  NETWORK_CODE,
  TIMEOUT_CODE,
  MESSAGES,
  ACTIONS,
  normalizeError,
  describeError,
  isAuthError,
  isCatalogError,
};