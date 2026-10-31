const CURRENCY_SYMBOL = '¥';

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

module.exports = {
  CURRENCY_SYMBOL,
  toSafeCents,
  formatAmount,
  formatCents,
  sumCents,
};