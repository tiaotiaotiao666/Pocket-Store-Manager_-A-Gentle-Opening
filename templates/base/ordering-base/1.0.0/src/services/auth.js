const config = require('../config/env.js');
const platform = require('./platform.js');
const ApiError = require('./api-error.js');
const session = require('./session.js');
const { request } = require('./request.js');

let pendingLogin = null;

async function login(options) {
  const settings = options || {};
  const identityKey = settings.identity || session.getIdentity() || config.DEFAULT_IDENTITY;
  const preset = config.DEMO_IDENTITIES[identityKey] || config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY];
  const loginRevision = session.getIdentityRevision();

  let payload;
  if (settings.code) {
    payload = { code: settings.code };
  } else if (config.USE_WECHAT_CODE_LOGIN) {
    const code = await platform.loginWithWechatCode();
    payload = { code };
  } else {
    payload = { demoOpenId: preset.demoOpenId };
  }

  const result = await request({
    path: '/auth/wechat/login',
    method: 'POST',
    data: payload,
    auth: false,
    retryAuth: false,
  });

  const saved = session.saveLogin(result, preset.key, loginRevision);
  if (!saved) {
    throw ApiError.client('SESSION_SUPERSEDED', '登录状态已切换，请重试当前操作');
  }
  return result;
}

async function ensureLogin(identityKey) {
  const targetIdentity = identityKey || session.getIdentity();
  const current = session.load();
  if (current && current.token && current.identity === targetIdentity && session.getToken()) {
    const user = session.getUser();
    if (user) {
      return user;
    }
  }
  if (pendingLogin && pendingLogin.identity === targetIdentity) {
    return pendingLogin.promise;
  }
  if (current && current.identity !== targetIdentity) {
    session.setIdentity(targetIdentity);
  }
  const promise = login({ identity: targetIdentity }).then(
    (result) => {
      if (pendingLogin && pendingLogin.promise === promise) {
        pendingLogin = null;
      }
      return result.user;
    },
    (error) => {
      if (pendingLogin && pendingLogin.promise === promise) {
        pendingLogin = null;
      }
      throw error;
    },
  );
  pendingLogin = { identity: targetIdentity, promise };
  return promise;
}

async function refreshMe() {
  const user = await request({ path: '/auth/me', method: 'GET' });
  session.saveUser(user);
  return user;
}

async function switchIdentity(identityKey) {
  const preset = config.DEMO_IDENTITIES[identityKey];
  if (!preset) {
    throw ApiError.client('INVALID_IDENTITY', '未知的演示身份');
  }
  session.clear();
  session.setIdentity(preset.key);
  const result = await login({ identity: preset.key });
  return result.user;
}

function logout() {
  session.clear();
}

function currentUser() {
  return session.getUser();
}

function currentIdentity() {
  const key = session.getIdentity();
  return config.DEMO_IDENTITIES[key] || config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY];
}

function memberships() {
  return session.memberships();
}

module.exports = {
  login,
  ensureLogin,
  refreshMe,
  switchIdentity,
  logout,
  currentUser,
  currentIdentity,
  memberships,
};