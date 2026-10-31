export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ErrorMessages = {
  BAD_REQUEST: '请求格式不正确。',
  AUTH_REQUIRED: '请先登录。',
  AUTH_INVALID: '登录状态已失效，请重新登录。',
  FORBIDDEN: '没有该门店的操作权限。',
  STORE_NOT_FOUND: '门店不存在。',
  ORDER_NOT_FOUND: '订单不存在。',
  PRODUCT_NOT_FOUND: '商品不存在。',
  TABLE_REQUIRED: '堂食订单必须提供桌号。',
  TABLE_NOT_FOUND: '桌号不属于该门店。',
  PRODUCT_UNAVAILABLE: '商品已停售，请刷新菜单。',
  INVALID_STATUS_TRANSITION: '当前订单状态不允许该操作。',
  STATUS_CONFLICT: '订单状态已被其他操作更新，请刷新后重试。',
  MERCHANT_CANNOT_HANDLE_UNPAID: '待付款订单不能由店主处理。',
  IDEMPOTENCY_CONFLICT: '同一幂等键对应的请求内容不一致。',
  VALIDATION_ERROR: '请求参数校验失败。',
  DEMO_LOGIN_DISABLED: '当前环境不允许模拟登录。',
  DEMO_PAYMENT_DISABLED: '当前环境不允许模拟支付。',
  WECHAT_LOGIN_FAILED: '微信登录凭证无效，请重新获取。',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试。',
} as const;