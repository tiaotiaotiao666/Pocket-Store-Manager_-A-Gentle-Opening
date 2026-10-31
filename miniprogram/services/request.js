const config = require('../config/env.js');
const platform = require('./platform.js');
const core = require('./request-core.js');
const ApiError = require('./api-error.js');
const session = require('./session.js');

let reloginPromise = null;

function buildHeaders(options) {
  const headers = { 'content-type': 'application/json' };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }
  if (options.auth !== false) {
    const token = session.getToken();
    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }
  }
  if (options.header && typeof options.header === 'object') {
    Object.keys(options.header).forEach((key) => {
      headers[key] = options.header[key];
    });
  }
  return headers;
}

function rawRequest(options) {
  const settings = options || {};
  const url = core.buildUrl(config.API_BASE_URL, settings.path, settings.query);
  const header = buildHeaders(settings);
  const method = (settings.method || 'GET').toUpperCase();

  return new Promise((resolve, reject) => {
    platform.sendRequest(
      {
        url,
        method,
        header,
        data: settings.data,
        timeout: settings.timeout || config.REQUEST_TIMEOUT_MS,
      },
      (result) => {
        if (result && result.error) {
          const timeout = Boolean(result.error.timeout) || core.isTimeoutMessage(result.error.errMsg);
          reject(ApiError.network(result.error.errMsg, timeout));
          return;
        }
        const body = core.parseBody(result.data);
        if (core.isSuccess(result.statusCode)) {
          resolve({ data: body, statusCode: result.statusCode, header: result.header || {} });
          return;
        }
        reject(core.toApiError(result.statusCode, body));
      },
    );
  });
}

function demoRelogin() {
  if (reloginPromise) {
    return reloginPromise;
  }
  const identityKey = session.getIdentity();
  const preset = config.DEMO_IDENTITIES[identityKey] || config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY];

  reloginPromise = (async () => {
    let payload;
    if (config.USE_WECHAT_CODE_LOGIN) {
      const code = await platform.loginWithWechatCode();
      payload = { code };
    } else {
      payload = { demoOpenId: preset.demoOpenId };
    }
    const response = await rawRequest({
      path: '/auth/wechat/login',
      method: 'POST',
      data: payload,
      auth: false,
    });
    session.saveLogin(response.data, preset.key);
    return response.data;
  })();

  reloginPromise
    .catch(() => null)
    .then(() => {
      reloginPromise = null;
    });

  return reloginPromise;
}

async function request(options) {
  const settings = options || {};
  try {
    const response = await rawRequest(settings);
    return response.data;
  } catch (error) {
    const retryable =
      settings.auth !== false &&
      settings.retryAuth !== false &&
      error instanceof ApiError &&
      core.shouldRetryAuth(error.statusCode, error.code);
    if (!retryable) {
      throw error;
    }
    try {
      await demoRelogin();
    } catch (loginError) {
      throw error;
    }
    const retried = await rawRequest(Object.assign({}, settings, { retryAuth: false }));
    return retried.data;
  }
}

function resetRelogin() {
  reloginPromise = null;
}

module.exports = {
  request,
  rawRequest,
  demoRelogin,
  resetRelogin,
};