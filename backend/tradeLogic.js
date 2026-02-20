// backend/tradeLogic.js

const axios = require('axios');
const {
  atr,
  rsi,
  averageDollarVolume,
  averageRangePct
} = require('./signal/indicators');

// Base URL for Alpaca market data (e.g. "https://data.alpaca.markets/v2")
const API_URL =
  process.env.APCA_DATA_URL ||
  process.env.ALPACA_DATA_URL ||
  process.env.ALPACA_DATA_BASE_URL;

const API_KEY =
  process.env.BROKER_API_KEY ||
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY;

const API_SECRET =
  process.env.BROKER_API_SECRET ||
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET;

function getAlpacaConfig() {
  if (!API_URL) {
    throw new Error('Missing Alpaca data base URL (APCA_DATA_URL or ALPACA_DATA_URL).');
  }
  if (!API_KEY || !API_SECRET) {
    throw new Error('Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).');
  }
  const dataBaseUrl = API_URL.replace(/\/v2\/?$/, '').replace(/\/+$/, '');
  return {
    dataBaseUrl,
    headers: {
      'APCA-API-KEY-ID': API_KEY,
      'APCA-API-SECRET-KEY': API_SECRET
    }
  };
}

function buildDailyBarsError(symbol, detail) {
  const error = new Error(`Could not fetch daily bars for ${symbol}${detail ? `: ${detail}` : ''}`);
  error.code = 'DATA_UNAVAILABLE';
  return error;
}

function extractBarsPayload(data, symbol) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.bars)) return data.bars;
  if (data.bars === null) return null;
  if (Array.isArray(data[symbol])) return data[symbol];
  if (Array.isArray(data[symbol?.toUpperCase?.()])) return data[symbol.toUpperCase()];
  if (Array.isArray(data[symbol?.toLowerCase?.()])) return data[symbol.toLowerCase()];
  return null;
}

function isFeedRelatedMessage(value) {
  return String(value || '').toLowerCase().includes('feed');
}

function hasUpstreamErrorPayload(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data.code !== undefined || data.message !== undefined)
  );
}

/**
 * Fetches recent daily bars for a symbol from Alpaca.
 * We always provide a date range to avoid empty responses from endpoint defaults.
 * Returns an array of { t, o, h, l, c, v } objects, newest last.
 */
async function fetchDaily(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const { dataBaseUrl, headers } = getAlpacaConfig();
  const url = `${dataBaseUrl}/v2/stocks/${normalizedSymbol}/bars`;
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 400);
  // Allow deploy-time override of Alpaca data feed; default to iex for broad compatibility.
  const feed = process.env.APCA_DATA_FEED || 'iex';
  const baseParams = {
    timeframe: '1Day',
    limit: 200,
    adjustment: 'raw',
    start: start.toISOString(),
    end: end.toISOString()
  };

  const requestBars = async includeFeed => {
    const params = includeFeed ? { ...baseParams, feed } : baseParams;
    const resp = await axios.get(url, { headers, params });
    return resp.data;
  };

  let triedWithoutFeed = false;
  const retryWithoutFeed = async reason => {
    if (triedWithoutFeed) {
      throw buildDailyBarsError(normalizedSymbol, reason || 'No daily bars returned');
    }
    triedWithoutFeed = true;
    try {
      return await requestBars(false);
    } catch (retryErr) {
      throw buildDailyBarsError(normalizedSymbol, retryErr.response?.data?.message || retryErr.message);
    }
  };

  let data;
  try {
    data = await requestBars(true);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    const canRetryWithoutFeed = (status === 400 || status === 404 || status === 422)
      && isFeedRelatedMessage(detail);
    if (canRetryWithoutFeed) {
      data = await retryWithoutFeed(detail);
    } else {
      throw buildDailyBarsError(normalizedSymbol, detail);
    }
  }

  if (hasUpstreamErrorPayload(data) && isFeedRelatedMessage(data.message || data.code)) {
    data = await retryWithoutFeed(data.message || data.code);
  }

  if (hasUpstreamErrorPayload(data)) {
    throw buildDailyBarsError(normalizedSymbol, data.message || data.code);
  }

  let bars = extractBarsPayload(data, normalizedSymbol);
  if (!Array.isArray(bars) || bars.length === 0) {
    data = await retryWithoutFeed('No daily bars returned');
    if (hasUpstreamErrorPayload(data)) {
      throw buildDailyBarsError(normalizedSymbol, data.message || data.code);
    }
    bars = extractBarsPayload(data, normalizedSymbol);
    if (!Array.isArray(bars) || bars.length === 0) {
      throw buildDailyBarsError(normalizedSymbol, 'No daily bars returned');
    }
  }

  return bars;
}

/**
 * Fetches recent intraday (5-minute) bars for a symbol from Alpaca.
 * Returns an array of { time, open, high, low, close, volume }, newest last.
 */
async function fetchIntraday(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const { dataBaseUrl, headers } = getAlpacaConfig();
  const resp = await axios.get(
    `${dataBaseUrl}/v2/stocks/${normalizedSymbol}/bars`,
    {
      headers,
      params: { timeframe: '5Min', limit: 500 }
    }
  );
  if (!resp.data.bars) {
    throw new Error(`Unexpected response from Alpaca for intraday bars of ${symbol}`);
  }
  return resp.data.bars.map(bar => ({
    time:   new Date(bar.t).toISOString(),
    open:   bar.o,
    high:   bar.h,
    low:    bar.l,
    close:  bar.c,
    volume: bar.v
  }));
}

/**
 * Helper: simple moving average over the last N closes.
 */
function sma(closes, N) {
  const slice = closes.slice(-N);
  const sum = slice.reduce((acc, c) => acc + c, 0);
  return sum / slice.length;
}

/**
 * Fetches daily bars, computes SMAs, and returns recommendation.
 * If SMAs are equal, returns 'HOLD'.
 */
async function getRecommendations(symbol) {
  const bars = await fetchDaily(symbol);
  const total = bars.length;
  if (total < 1) {
    throw new Error(`No data available for ${symbol}`);
  }

  const closes = bars.map(b => b.c);
  const latest = bars[total - 1];
  const period20 = Math.min(total, 20);
  const period50 = Math.min(total, 50);
  const sma20 = sma(closes, period20);
  const sma50 = sma(closes, period50);
  const atrValue = atr(bars, 14);
  const atrPct = atrValue && latest?.c ? atrValue / latest.c : null;
  const avgDollarVolume = averageDollarVolume(bars, 20);
  const avgRangePct = averageRangePct(bars, 20);
  const rsiValue = rsi(closes, 14);

  let recommendation;
  if (sma20 > sma50) recommendation = 'LONG';
  else if (sma20 < sma50) recommendation = 'SHORT';
  else recommendation = 'HOLD';

  const instructions = {
    LONG: [
      `1. In your brokerage platform, place a BUY order for ${symbol}.`,
      `2. Set a stop-loss roughly 5% below your entry price.`,
      `3. Set a take-profit roughly 10% above your entry price.`,
      `4. Monitor daily: if the ${period20}-day SMA crosses below the ${period50}-day SMA, exit your position.`
    ],
    SHORT: [
      `1. Borrow shares of ${symbol} via your broker.`,
      `2. SELL the borrowed shares at market price.`,
      `3. Place a buy-to-cover order roughly 5% below your sale price.`,
      `4. Monitor daily: if the ${period20}-day SMA crosses above the ${period50}-day SMA, cover your short position.`
    ],
    HOLD: [
      `No clear trend for ${symbol} as the ${period20}-day and ${period50}-day SMAs are equal. Consider monitoring price action and news before trading.`
    ]
  };

  return {
    symbol,
    latestClose: latest.c,
    latestTimestamp: latest.t,
    sma20: sma20.toFixed(2),
    sma50: sma50.toFixed(2),
    recommendation,
    indicators: {
      atr: atrValue ? Number(atrValue.toFixed(2)) : null,
      atrPct: atrPct ? Number(atrPct.toFixed(4)) : null,
      avgDollarVolume: avgDollarVolume ? Number(avgDollarVolume.toFixed(2)) : null,
      avgRangePct: avgRangePct ? Number(avgRangePct.toFixed(4)) : null,
      rsi: rsiValue ? Number(rsiValue.toFixed(2)) : null
    },
    barsCount: total,
    instructions: instructions[recommendation]
  };
}

module.exports = { getRecommendations, fetchIntraday, fetchDaily };
