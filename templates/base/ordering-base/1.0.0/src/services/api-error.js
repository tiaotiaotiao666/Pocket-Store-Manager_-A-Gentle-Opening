class ApiError extends Error {
  constructor(input) {
    const payload = input && typeof input === 'object' ? input : {};
    super(payload.message || '请求失败');
    this.name = 'ApiError';
    this.code = payload.code || 'INTERNAL_ERROR';
    this.requestId = payload.requestId || '';
    this.statusCode = Number(payload.statusCode) || 0;
    this.details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

ApiError.fromResponse = function fromResponse(statusCode, body, fallbackMessage) {
  const payload = body && typeof body === 'object' ? body : {};
  const code = typeof payload.code === 'string' && payload.code ? payload.code : 'INTERNAL_ERROR';
  const message = typeof payload.message === 'string' && payload.message ? payload.message : fallbackMessage || '请求失败';
  return new ApiError({
    code,
    message,
    requestId: payload.requestId || '',
    statusCode,
    details: payload.details,
  });
};

ApiError.network = function network(errMsg, timeout) {
  return new ApiError({
    code: timeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
    message: timeout ? '请求超时，请稍后重试' : '网络连接失败，请检查后端服务是否已启动',
    statusCode: 0,
    details: { errMsg: errMsg || '' },
  });
};

ApiError.client = function client(code, message, details) {
  return new ApiError({ code, message, statusCode: 0, details });
};

module.exports = ApiError;