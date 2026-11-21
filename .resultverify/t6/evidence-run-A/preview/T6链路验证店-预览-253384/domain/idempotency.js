const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

function randomToken(random, length) {
  const size = length || 12;
  if (typeof random === 'function') {
    const value = random();
    if (typeof value === 'string' && value) {
      return value;
    }
    if (Number.isFinite(value)) {
      return Math.abs(Math.floor(value * 1e9)).toString(36);
    }
  }
  return Math.random().toString(36).slice(2, 2 + size);
}

function createIdempotencyKey(now, random) {
  const timestamp = Number.isFinite(now) ? Math.floor(now) : Date.now();
  const token = randomToken(random, 12);
  const key = 'idem_' + timestamp.toString(36) + '_' + token;
  return key.slice(0, MAX_LENGTH);
}

function isValidKey(key) {
  if (typeof key !== 'string') {
    return false;
  }
  if (key.length < MIN_LENGTH || key.length > MAX_LENGTH) {
    return false;
  }
  return /^[\x21-\x7e]+$/.test(key);
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  createIdempotencyKey,
  isValidKey,
};