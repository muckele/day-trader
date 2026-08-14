function normalizeMarketSymbol(value, { maxLength = 20 } = {}) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!symbol || symbol.length > maxLength || !/^[A-Z0-9./_-]+$/.test(symbol)) return '';
  return symbol;
}

function normalizeIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized
    ? normalized
    : '';
}

module.exports = {
  normalizeIsoDate,
  normalizeMarketSymbol
};
