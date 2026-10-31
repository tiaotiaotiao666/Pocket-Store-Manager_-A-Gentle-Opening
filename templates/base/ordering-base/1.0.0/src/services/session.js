const config = require('../config/env.js');
const platform = require('./platform.js');

const STORAGE_KEY = config.STORAGE_PREFIX + '_session';
const EXPIRY_GUARD_MS = 60 * 1000;

let cache = null;
let cacheLoaded = false;
let identityRevision = 0;

function load() {
  if (cacheLoaded) {
    return cache;
  }
  const raw = platform.storage.get(STORAGE_KEY);
  if (raw && typeof raw === 'object' && typeof raw.token === 'string') {
    cache = {
      token: raw.token,
      expiresAt: Number(raw.expiresAt) || 0,
      user: raw.user && typeof raw.user === 'object' ? raw.user : null,
      identity: typeof raw.identity === 'string' ? raw.identity : config.DEFAULT_IDENTITY,
    };
  } else {
    cache = null;
  }
  cacheLoaded = true;
  return cache;
}

function persist(next) {
  cache = next;
  cacheLoaded = true;
  if (!next) {
    platform.storage.remove(STORAGE_KEY);
    return;
  }
  platform.storage.set(STORAGE_KEY, next);
}

function saveLogin(loginResult, identity, expectedIdentityRevision) {
  const result = loginResult && typeof loginResult === 'object' ? loginResult : {};
  if (!result.token) {
    return null;
  }
  const targetIdentity = identity || config.DEFAULT_IDENTITY;
  const current = load();
  if (
    (typeof expectedIdentityRevision === 'number' && expectedIdentityRevision !== identityRevision) ||
    (current && current.identity && current.identity !== targetIdentity)
  ) {
    return null;
  }
  const expiresIn = Number(result.expiresIn) || 0;
  const next = {
    token: result.token,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    user: result.user && typeof result.user === 'object' ? result.user : null,
    identity: targetIdentity,
  };
  persist(next);
  return next;
}

function saveUser(user) {
  const current = load();
  if (!current) {
    return null;
  }
  persist(Object.assign({}, current, { user: user && typeof user === 'object' ? user : current.user }));
  return cache;
}

function clear() {
  identityRevision += 1;
  persist(null);
}

function getToken() {
  const current = load();
  if (!current || !current.token) {
    return '';
  }
  if (current.expiresAt > 0 && current.expiresAt - EXPIRY_GUARD_MS <= Date.now()) {
    return '';
  }
  return current.token;
}

function isLoggedIn() {
  return Boolean(getToken());
}

function getUser() {
  const current = load();
  return current ? current.user : null;
}

function getIdentity() {
  const current = load();
  if (current && current.identity) {
    return current.identity;
  }
  return config.DEFAULT_IDENTITY;
}

function setIdentity(identityKey) {
  const current = load();
  if (current && current.identity === identityKey) {
    return current;
  }
  identityRevision += 1;
  persist(null);
  const preset = config.DEMO_IDENTITIES[identityKey] || config.DEMO_IDENTITIES[config.DEFAULT_IDENTITY];
  persist({
    token: '',
    expiresAt: 0,
    user: null,
    identity: preset.key,
  });
  return cache;
}

function memberships() {
  const user = getUser();
  return user && Array.isArray(user.memberships) ? user.memberships : [];
}

function findMembership(storeId) {
  const list = memberships();
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] && list[index].storeId === storeId) {
      return list[index];
    }
  }
  return null;
}

function isMerchantOf(storeId) {
  const membership = findMembership(storeId);
  return Boolean(membership && (membership.role === 'OWNER' || membership.role === 'STAFF'));
}

function getExpiresAt() {
  const current = load();
  return current ? current.expiresAt : 0;
}

function getIdentityRevision() {
  return identityRevision;
}

module.exports = {
  STORAGE_KEY,
  load,
  saveLogin,
  saveUser,
  clear,
  getToken,
  isLoggedIn,
  getUser,
  getIdentity,
  setIdentity,
  memberships,
  findMembership,
  isMerchantOf,
  getExpiresAt,
  getIdentityRevision,
};