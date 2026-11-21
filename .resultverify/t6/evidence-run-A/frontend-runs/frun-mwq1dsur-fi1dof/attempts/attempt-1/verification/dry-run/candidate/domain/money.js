const CURRENCY_SYMBOL = '¥';
const MAX_PRICE_CENTS = 999999;

function toSafeCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.round(number);
}

function formatAmount(cents) {
  const safe = toSafeCents(cents);
  const negative = safe < 0;
  const absolute = Math.abs(safe);
  const yuan = Math.floor(absolute / 100);
  const fen = absolute % 100;
  return (negative ? '-' : '') + yuan + '.' + String(fen).padStart(2, '0');
}

function formatCents(cents) {
  const safe = toSafeCents(cents);
  return (safe < 0 ? '-' : '') + CURRENCY_SYMBOL + formatAmount(Math.abs(safe));
}

function sumCents(values) {
  if (!Array.isArray(values)) {
    return 0;
  }
  return values.reduce((total, value) => total + toSafeCents(value), 0);
}

function parseYuanToCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const parts = value.split('.');
  const cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_PRICE_CENTS) {
    return null;
  }
  return cents;
}

module.exports = {
  CURRENCY_SYMBOL,
  MAX_PRICE_CENTS,
  toSafeCents,
  formatAmount,
  formatCents,
  sumCents,
  parseYuanToCents,
};