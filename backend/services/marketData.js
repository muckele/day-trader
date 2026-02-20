const axios = require('axios');
const { getCache, setCache } = require('../utils/cache');

const RAW_DATA_URL =
  process.env.APCA_DATA_URL ||
  process.env.ALPACA_DATA_URL ||
  'https://data.alpaca.markets';

const DATA_URL = RAW_DATA_URL.replace(/\/v2\/?$/, '');

const API_KEY =
  process.env.BROKER_API_KEY ||
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY;

const API_SECRET =
  process.env.BROKER_API_SECRET ||
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET;

function missingCredentials() {
  return !API_KEY || !API_SECRET;
}

function toNumber(value) {
  return typeof value === 'number' ? value : Number(value);
}

function mockQuote(symbol) {
  const base = 100 + Math.random() * 200;
  const change = (Math.random() - 0.5) * 4;
  return {
    symbol,
    price: Number(base.toFixed(2)),
    change: Number(change.toFixed(2)),
    changePercent: Number((change / base * 100).toFixed(2))
  };
}

function mockSparkline(symbol, points = 40) {
  const start = 100 + Math.random() * 200;
  let price = start;
  const now = Date.now();
  return Array.from({ length: points }).map((_, idx) => {
    price += (Math.random() - 0.5) * 1.5;
    return {
      time: new Date(now - (points - idx) * 60 * 1000).toISOString(),
      price: Number(price.toFixed(2)),
      symbol
    };
  });
}

async function fetchQuotes(symbols) {
  const normalized = symbols.map(sym => sym.toUpperCase());
  const cacheKey = `quotes:${normalized.sort().join(',')}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (missingCredentials()) {
    const data = normalized.map(mockQuote);
    setCache(cacheKey, data, 60 * 1000);
    return data;
  }

  const resp = await axios.get(
    `${DATA_URL}/v2/stocks/quotes/latest`,
    {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET
      },
      params: { symbols: normalized.join(',') }
    }
  );

  const quotes = resp.data?.quotes || {};
  const data = normalized.map(symbol => {
    const quote = quotes[symbol];
    const price = quote?.ap || quote?.bp || 0;
    const prev = quote?.bp || quote?.ap || price;
    const change = price - prev;
    return {
      symbol,
      price: Number(toNumber(price).toFixed(2)),
      change: Number(toNumber(change).toFixed(2)),
      changePercent: prev ? Number((change / prev * 100).toFixed(2)) : 0
    };
  });

  setCache(cacheKey, data, 60 * 1000);
  return data;
}

async function fetchSparkline(symbol, range = '1D') {
  const cacheKey = `sparkline:${symbol}:${range}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (missingCredentials()) {
    const data = mockSparkline(symbol, 48);
    setCache(cacheKey, data, 60 * 1000);
    return data;
  }

  const limit = range === '1D' ? 78 : 150;
  const resp = await axios.get(
    `${DATA_URL}/v2/stocks/${symbol}/bars`,
    {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET
      },
      params: { timeframe: '5Min', limit }
    }
  );

  const bars = resp.data?.bars || [];
  const data = bars.map(bar => ({
    time: new Date(bar.t).toISOString(),
    price: Number(toNumber(bar.c).toFixed(2)),
    symbol
  }));

  setCache(cacheKey, data, 60 * 1000);
  return data;
}

module.exports = { fetchQuotes, fetchSparkline };
