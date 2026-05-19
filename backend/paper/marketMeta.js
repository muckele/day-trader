function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeCompactSymbol(symbol) {
  return normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, '');
}

function isCryptoSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (normalized.includes('/')) return true;
  if (/(USD|USDT|USDC)$/.test(normalized) && normalized.length >= 6) return true;
  return false;
}

function inferAssetClass({ symbol, assetClass } = {}) {
  if (assetClass === 'crypto' || assetClass === 'equity') return assetClass;
  return isCryptoSymbol(symbol) ? 'crypto' : 'equity';
}

function mapSymbolSector(symbol, assetClass = 'equity') {
  if (assetClass === 'crypto') return 'CRYPTO';
  const compact = normalizeCompactSymbol(symbol);
  const sectorMap = {
    TECHNOLOGY: new Set(['AAPL', 'MSFT', 'NVDA', 'AMD', 'GOOG', 'META', 'NFLX', 'SHOP']),
    COMMUNICATION: new Set(['DIS', 'NFLX', 'GOOG', 'META']),
    CONSUMER: new Set(['AMZN', 'TSLA', 'COST']),
    FINANCIALS: new Set(['JPM', 'BAC', 'GS']),
    INDEX: new Set(['SPY', 'QQQ', 'IWM', 'DIA'])
  };
  for (const [sector, symbols] of Object.entries(sectorMap)) {
    if (symbols.has(compact)) return sector;
  }
  return 'OTHER';
}

function mapCorrelationCluster(symbol, assetClass = 'equity') {
  const compact = normalizeCompactSymbol(symbol);
  if (assetClass === 'crypto') return 'CRYPTO_MAJOR';

  if (['AAPL', 'MSFT', 'GOOG', 'META', 'AMZN', 'QQQ', 'NVDA', 'AMD', 'TSLA'].includes(compact)) {
    return 'US_TECH_BETA';
  }
  if (['SPY', 'DIA', 'IWM'].includes(compact)) {
    return 'US_INDEX';
  }
  if (['JPM', 'BAC', 'GS'].includes(compact)) {
    return 'US_FINANCIALS';
  }
  return 'UNCLUSTERED';
}

function parseSymbolSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => normalizeCompactSymbol(item))
      .filter(Boolean)
  );
}

function getShortBorrowProfile(symbol) {
  const compact = normalizeCompactSymbol(symbol);
  const hardToBorrowSymbols = parseSymbolSet(process.env.SHORT_HARD_TO_BORROW_SYMBOLS);
  const nonBorrowableSymbols = parseSymbolSet(process.env.SHORT_NON_BORROWABLE_SYMBOLS);

  const defaultBorrowFeeApr = toFiniteNumber(process.env.SHORT_BORROW_FEE_APR, 8);
  const hardBorrowFeeApr = toFiniteNumber(process.env.SHORT_HARD_TO_BORROW_FEE_APR, 28);
  const hardToBorrow = hardToBorrowSymbols.has(compact);
  const borrowable = !nonBorrowableSymbols.has(compact);
  return {
    symbol: compact,
    borrowable,
    hardToBorrow: hardToBorrow || !borrowable,
    feeApr: borrowable ? (hardToBorrow ? hardBorrowFeeApr : defaultBorrowFeeApr) : hardBorrowFeeApr
  };
}

module.exports = {
  inferAssetClass,
  isCryptoSymbol,
  normalizeSymbol,
  normalizeCompactSymbol,
  mapSymbolSector,
  mapCorrelationCluster,
  getShortBorrowProfile
};
