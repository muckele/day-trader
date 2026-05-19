const { fetchDaily } = require('../tradeLogic');
const { fetchQuotes, fetchSparkline, isCryptoSymbol } = require('../services/marketData');
const {
  atr,
  rsi,
  rollingVolatility,
  sma
} = require('../signal/indicators');
const { normalizeAssetClass, normalizeSymbol } = require('./settingsService');

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeBar(bar = {}) {
  return {
    t: bar.t || bar.time || bar.timestamp || bar.date || null,
    o: toFiniteNumber(bar.o ?? bar.open, 0),
    h: toFiniteNumber(bar.h ?? bar.high, 0),
    l: toFiniteNumber(bar.l ?? bar.low, 0),
    c: toFiniteNumber(bar.c ?? bar.close ?? bar.price, 0),
    v: toFiniteNumber(bar.v ?? bar.volume, 0)
  };
}

function average(values) {
  const filtered = values.filter(value => Number.isFinite(Number(value)));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + Number(value), 0) / filtered.length;
}

function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function detectGap(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return { direction: 'flat', percent: 0 };
  const previous = bars[bars.length - 2];
  const latest = bars[bars.length - 1];
  const pct = percentChange(previous.c, latest.o) || 0;
  return {
    direction: pct > 1 ? 'up' : (pct < -1 ? 'down' : 'flat'),
    percent: Number(pct.toFixed(2))
  };
}

function resolvePortfolioExposure(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  if (!position) return { qty: 0, marketValue: 0, side: 'flat' };
  const qty = toFiniteNumber(position.qty, 0);
  const marketValue = Math.abs(toFiniteNumber(position.market_value ?? position.marketValue, 0));
  return {
    qty,
    marketValue,
    side: qty > 0 ? 'long' : (qty < 0 ? 'short' : 'flat')
  };
}

async function fetchBarsForResearch(symbol, assetClass) {
  if (assetClass === 'crypto' || isCryptoSymbol(symbol)) {
    const sparkline = await fetchSparkline(symbol, '1D', { assetClass: 'crypto' });
    return sparkline.map(item => normalizeBar(item));
  }
  return (await fetchDaily(symbol)).map(normalizeBar);
}

async function buildResearchForSymbol(symbol, {
  assetClass = 'stocks',
  account = null,
  positions = [],
  openOrders = []
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedAssetClass = normalizeAssetClass(assetClass) || (isCryptoSymbol(symbol) ? 'crypto' : 'stocks');
  const providerAssetClass = normalizedAssetClass === 'crypto' ? 'crypto' : 'equity';
  const [quote] = await fetchQuotes([normalizedSymbol], { assetClass: providerAssetClass });
  let bars = [];
  let dataError = null;
  try {
    bars = await fetchBarsForResearch(normalizedSymbol, normalizedAssetClass);
  } catch (err) {
    dataError = err?.message || 'Historical data unavailable.';
  }

  const closes = bars.map(bar => bar.c).filter(value => Number.isFinite(value) && value > 0);
  const volumes = bars.map(bar => bar.v).filter(value => Number.isFinite(value) && value >= 0);
  const latestClose = closes[closes.length - 1] || toFiniteNumber(quote?.price, 0);
  const day20Ago = closes.length >= 21 ? closes[closes.length - 21] : null;
  const day5Ago = closes.length >= 6 ? closes[closes.length - 6] : null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const atr14 = atr(bars, 14);
  const rsi14 = rsi(closes, 14);
  const volatility20 = rollingVolatility(closes, Math.min(20, Math.max(2, closes.length - 1)));
  const avgVolume20 = average(volumes.slice(-20));
  const recentVolume = volumes[volumes.length - 1] || null;
  const volumeRatio = avgVolume20 ? recentVolume / avgVolume20 : null;
  const openOrderCount = (openOrders || []).filter(order => normalizeSymbol(order.symbol) === normalizedSymbol).length;
  const exposure = resolvePortfolioExposure(normalizedSymbol, positions);

  return {
    symbol: normalizedSymbol,
    assetClass: normalizedAssetClass,
    quote: quote || null,
    price: toFiniteNumber(quote?.price, latestClose),
    bars: bars.slice(-220),
    indicators: {
      sma20,
      sma50,
      sma200,
      rsi14,
      atr14,
      atrPct: latestClose && atr14 ? (atr14 / latestClose) * 100 : null,
      volatility20,
      avgVolume20,
      recentVolume,
      volumeRatio,
      fiveDayChangePct: day5Ago ? percentChange(day5Ago, latestClose) : null,
      twentyDayChangePct: day20Ago ? percentChange(day20Ago, latestClose) : null,
      relativeStrength: null,
      gap: detectGap(bars)
    },
    news: {
      items: [],
      sentiment: 'unavailable',
      source: 'not_configured'
    },
    earnings: {
      nextReportDate: null,
      source: 'not_configured'
    },
    marketContext: {
      accountBuyingPower: toFiniteNumber(account?.buying_power ?? account?.buyingPower, null),
      openOrderCount,
      portfolioExposure: exposure
    },
    dataQuality: {
      barsAvailable: bars.length,
      dataError
    },
    asOf: new Date().toISOString()
  };
}

async function buildResearchBatch(symbols, context = {}) {
  const results = [];
  for (const item of symbols) {
    const symbol = typeof item === 'string' ? item : item.symbol;
    const assetClass = typeof item === 'string' ? context.assetClass : item.assetClass;
    if (!symbol) continue;
    // Sequential requests keep Alpaca free-tier rate pressure low.
    results.push(await buildResearchForSymbol(symbol, { ...context, assetClass }));
  }
  return results;
}

module.exports = {
  buildResearchBatch,
  buildResearchForSymbol
};
