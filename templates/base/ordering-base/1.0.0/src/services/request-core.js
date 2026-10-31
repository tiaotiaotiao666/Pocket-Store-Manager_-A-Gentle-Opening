const ApiError = require('./api-error.js');

function encodeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => encodeURIComponent(String(item))).join(',');
  }
  return encodeURIComponent(String(value));
}

function encodeQuery(query) {
  if (!query || typeof query !== 'object') {
    return '';
  }
  const pairs = [];
  Object.keys(query).forEach((key) => {
    const value = query[key];
    if (value === undefined || value === null || value === '') {
      return;
    }
    pairs.push(encodeURIComponent(key) + '=' + encodeValue(value));
  });
  return pairs.join('&');
}

function buildUrl(baseUrl, path, query) {
  const safeBase = String(baseUrl || '').replace(/\/+$/, '');
  const safePath = String(path || '').replace(/^\/+/, '');
  const url = safeBase + '/' + safePath;
  const search = encodeQuery(query);
  return search ? url + '?' + search : url;
}

function parseBody(body) {
  if (body === undefined || body === null || body === '') {
    return {};
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (error) {
      return {};
    }
  }
  return body;
}

function isSuccess(statusCode) {
  return Number(statusCode) >= 200 && Number(statusCode) < 300;
}

function toApiError(statusCode, body, fallbackMessage) {
  const payload = parseBody(body);
  if (payload && typeof payload === 'object' && typeof payload.code === 'string') {
    return ApiError.fromResponse(Number(statusCode), payload, fallbackMessage);
  }
  const message = typeof payload === 'string' && payload ? payload : fallbackMessage || '请求失败，请稍后重试';
  return new ApiError({
    code: 'INTERNAL_ERROR',
    message,
    statusCode: Number(statusCode) || 0,
  });
}

function shouldRetryAuth(statusCode, code) {
  return Number(statusCode) === 401 || code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID';
}

function isTimeoutMessage(errMsg) {
  return /timeout|超时/i.test(String(errMsg || ''));
}

module.exports = {
  encodeQuery,
  buildUrl,
  parseBody,
  isSuccess,
  toApiError,
  shouldRetryAuth,
  isTimeoutMessage,
};