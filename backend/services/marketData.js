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
  const bidPrice = Number((base - 0.02).toFixed(2));
  const askPrice = Number((base + 0.02).toFixed(2));
  return {
    symbol,
    price: Number(base.toFixed(2)),
    bidPrice,
    askPrice,
    bidSize: 100,
    askSize: 100,
    timestamp: new Date().toISOString(),
    source: 'mock',
    isMock: true,
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

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isCryptoSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (normalized.includes('/')) return true;
  if (/^[A-Z]{2,10}[-_/]?[A-Z]{2,6}$/.test(normalized) && /(USD|USDT|USDC)$/.test(normalized)) {
    return true;
  }
  return false;
}

function normalizeCryptoProviderSymbol(symbol) {
  const normalized = normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, '');
  if (!normalized) return normalized;
  if (normalized.endsWith('USDT')) {
    return `${normalized.slice(0, -4)}/USDT`;
  }
  if (normalized.endsWith('USDC')) {
    return `${normalized.slice(0, -4)}/USDC`;
  }
  if (normalized.endsWith('USD')) {
    return `${normalized.slice(0, -3)}/USD`;
  }
  return normalized.includes('/') ? normalized : `${normalized}/USD`;
}

function quoteFromPayload(payload, keys = []) {
  for (const key of keys) {
    if (payload && payload[key]) return payload[key];
  }
  return null;
}

async function fetchStockQuotes(symbols) {
  const resp = await axios.get(
    `${DATA_URL}/v2/stocks/quotes/latest`,
    {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': API_SECRET
      },
      params: { symbols: symbols.join(',') }
    }
  );

  const quotes = resp.data?.quotes || {};
  return symbols.map(symbol => {
    const quote = quotes[symbol];
    const price = quote?.ap || quote?.bp || 0;
    const prev = quote?.bp || quote?.ap || price;
    const change = price - prev;
    return {
      symbol,
      assetClass: 'equity',
      price: Number(toNumber(price).toFixed(2)),
      bidPrice: Number.isFinite(toNumber(quote?.bp)) ? toNumber(quote.bp) : null,
      askPrice: Number.isFinite(toNumber(quote?.ap)) ? toNumber(quote.ap) : null,
      bidSize: Number.isFinite(toNumber(quote?.bs)) ? toNumber(quote.bs) : null,
      askSize: Number.isFinite(toNumber(quote?.as)) ? toNumber(quote.as) : null,
      timestamp: quote?.t || null,
      source: 'alpaca',
      isMock: false,
      change: Number(toNumber(change).toFixed(2)),
      changePercent: prev ? Number((change / prev * 100).toFixed(2)) : 0
    };
  });
}

async function fetchCryptoQuotes(symbols) {
  const providerSymbols = symbols.map(normalizeCryptoProviderSymbol);
  const headers = {
    'APCA-API-KEY-ID': API_KEY,
    'APCA-API-SECRET-KEY': API_SECRET
  };

  try {
    const resp = await axios.get(
      `${DATA_URL}/v1beta3/crypto/us/latest/quotes`,
      {
        headers,
        params: { symbols: providerSymbols.join(',') }
      }
    );
    const quotes = resp.data?.quotes || {};
    return symbols.map(symbol => {
      const providerSymbol = normalizeCryptoProviderSymbol(symbol);
      const compactSymbol = providerSymbol.replace('/', '');
      const quote = quoteFromPayload(quotes, [providerSymbol, compactSymbol, normalizeSymbol(symbol)]);
      const ask = toNumber(quote?.ap ?? quote?.ask_price);
      const bid = toNumber(quote?.bp ?? quote?.bid_price);
      const price = Number.isFinite(ask) && ask > 0
        ? ask
        : (Number.isFinite(bid) && bid > 0 ? bid : 0);
      const prev = Number.isFinite(bid) && bid > 0 ? bid : price;
      const change = price - prev;
      return {
        symbol: normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, ''),
        assetClass: 'crypto',
        price: Number(toNumber(price).toFixed(2)),
        bidPrice: Number.isFinite(bid) ? bid : null,
        askPrice: Number.isFinite(ask) ? ask : null,
        bidSize: toNumber(quote?.bs ?? quote?.bid_size) || null,
        askSize: toNumber(quote?.as ?? quote?.ask_size) || null,
        timestamp: quote?.t || null,
        source: 'alpaca',
        isMock: false,
        change: Number(toNumber(change).toFixed(2)),
        changePercent: prev ? Number((change / prev * 100).toFixed(2)) : 0
      };
    });
  } catch (_quoteErr) {
    // Fallback to latest trades endpoint when quote endpoint is unavailable.
    const resp = await axios.get(
      `${DATA_URL}/v1beta3/crypto/us/latest/trades`,
      {
        headers,
        params: { symbols: providerSymbols.join(',') }
      }
    );
    const trades = resp.data?.trades || {};
    return symbols.map(symbol => {
      const providerSymbol = normalizeCryptoProviderSymbol(symbol);
      const compactSymbol = providerSymbol.replace('/', '');
      const trade = quoteFromPayload(trades, [providerSymbol, compactSymbol, normalizeSymbol(symbol)]);
      const price = toNumber(trade?.p ?? 0);
      return {
        symbol: normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, ''),
        assetClass: 'crypto',
        price: Number(toNumber(price).toFixed(2)),
        bidPrice: null,
        askPrice: null,
        bidSize: null,
        askSize: null,
        timestamp: trade?.t || null,
        source: 'alpaca_trade_fallback',
        isMock: false,
        change: 0,
        changePercent: 0
      };
    });
  }
}

async function fetchQuotes(symbols, options = {}) {
  const normalized = symbols.map(sym => normalizeSymbol(sym)).filter(Boolean);
  const requestedAssetClass = options?.assetClass === 'crypto' || options?.assetClass === 'equity'
    ? options.assetClass
    : null;
  const cacheKey = `quotes:${normalized.sort().join(',')}:${requestedAssetClass || 'mixed'}`;
  const cached = options.bypassCache ? null : getCache(cacheKey);
  if (cached) return cached;

  if (missingCredentials()) {
    const data = normalized.map(symbol => ({
      ...mockQuote(symbol),
      assetClass: requestedAssetClass || (isCryptoSymbol(symbol) ? 'crypto' : 'equity')
    }));
    if (!options.bypassCache) setCache(cacheKey, data, 60 * 1000);
    return data;
  }

  const equitySymbols = [];
  const cryptoSymbols = [];
  normalized.forEach(symbol => {
    if (requestedAssetClass === 'crypto') {
      cryptoSymbols.push(symbol);
      return;
    }
    if (requestedAssetClass === 'equity') {
      equitySymbols.push(symbol);
      return;
    }
    if (isCryptoSymbol(symbol)) cryptoSymbols.push(symbol);
    else equitySymbols.push(symbol);
  });

  const [equityData, cryptoData] = await Promise.all([
    equitySymbols.length ? fetchStockQuotes(equitySymbols) : Promise.resolve([]),
    cryptoSymbols.length ? fetchCryptoQuotes(cryptoSymbols) : Promise.resolve([])
  ]);
  const bySymbol = {};
  [...equityData, ...cryptoData].forEach(entry => {
    bySymbol[normalizeSymbol(entry.symbol).replace(/[^A-Z0-9]/g, '')] = entry;
  });
  const data = normalized.map(symbol => {
    const key = normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, '');
    return bySymbol[key] || {
      symbol: key,
      assetClass: requestedAssetClass || (isCryptoSymbol(symbol) ? 'crypto' : 'equity'),
      price: 0,
      bidPrice: null,
      askPrice: null,
      bidSize: null,
      askSize: null,
      timestamp: null,
      source: 'unavailable',
      isMock: false,
      change: 0,
      changePercent: 0
    };
  });

  if (!options.bypassCache) setCache(cacheKey, data, 60 * 1000);
  return data;
}

async function fetchSparkline(symbol, range = '1D', options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const requestedAssetClass = options?.assetClass === 'crypto' || options?.assetClass === 'equity'
    ? options.assetClass
    : (isCryptoSymbol(normalizedSymbol) ? 'crypto' : 'equity');
  const cacheKey = `sparkline:${normalizedSymbol}:${range}:${requestedAssetClass}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (missingCredentials()) {
    const data = mockSparkline(normalizedSymbol, 48);
    setCache(cacheKey, data, 60 * 1000);
    return data;
  }

  const limit = range === '1D' ? 78 : 150;
  const headers = {
    'APCA-API-KEY-ID': API_KEY,
    'APCA-API-SECRET-KEY': API_SECRET
  };
  let bars = [];
  if (requestedAssetClass === 'crypto') {
    const providerSymbol = normalizeCryptoProviderSymbol(normalizedSymbol);
    const resp = await axios.get(
      `${DATA_URL}/v1beta3/crypto/us/bars`,
      {
        headers,
        params: {
          symbols: providerSymbol,
          timeframe: '5Min',
          limit
        }
      }
    );
    const container = resp.data?.bars || {};
    bars = container[providerSymbol] || container[providerSymbol.replace('/', '')] || [];
  } else {
    const resp = await axios.get(
      `${DATA_URL}/v2/stocks/${normalizedSymbol}/bars`,
      {
        headers,
        params: { timeframe: '5Min', limit }
      }
    );
    bars = resp.data?.bars || [];
  }
  const data = bars.map(bar => ({
    time: new Date(bar.t).toISOString(),
    price: Number(toNumber(bar.c).toFixed(2)),
    symbol: normalizedSymbol
  }));

  setCache(cacheKey, data, 60 * 1000);
  return data;
}

module.exports = {
  fetchQuotes,
  fetchSparkline,
  isCryptoSymbol,
  normalizeCryptoProviderSymbol
};
