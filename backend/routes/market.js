const express = require('express');
const axios = require('axios');
const { fetchDaily, fetchIntraday } = require('../tradeLogic');
const {
  fetchQuotes,
  fetchSparkline,
  isCryptoSymbol,
  normalizeCryptoProviderSymbol
} = require('../services/marketData');
const { getMarketStatus } = require('../utils/marketStatus');

const router = express.Router();

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

const MAX_QUOTE_SYMBOLS = 50;
const ALLOWED_SPARKLINE_RANGES = new Set(['1D', '1W', '1M']);
const ALLOWED_BARS_TIMEFRAMES = new Set(['1Min', '5Min', '15Min', '1Hour', '1Day']);

function normalizeMarketSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!symbol || symbol.length > 20 || !/^[A-Z0-9./_-]+$/.test(symbol)) return '';
  return symbol;
}

function parsePositiveInt(value, { fallback, min = 1, max }) {
  const parsed = Math.floor(Number(value));
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, min), max);
}

function extractCryptoBars(payload, symbol) {
  const providerSymbol = normalizeCryptoProviderSymbol(symbol);
  const compactSymbol = providerSymbol.replace('/', '');
  const bars = payload?.bars || {};
  return bars[providerSymbol] || bars[compactSymbol] || bars[symbol] || [];
}

router.get('/intraday/:symbol', async (req, res) => {
  try {
    const symbol = normalizeMarketSymbol(req.params.symbol);
    if (!symbol) {
      return res.status(400).json({ error: 'Invalid symbol.' });
    }
    if (isCryptoSymbol(symbol)) {
      if (missingCredentials()) {
        return res.json([]);
      }
      const resp = await axios.get(
        `${DATA_URL}/v1beta3/crypto/us/bars`,
        {
          headers: {
            'APCA-API-KEY-ID': API_KEY,
            'APCA-API-SECRET-KEY': API_SECRET
          },
          params: {
            symbols: normalizeCryptoProviderSymbol(symbol),
            timeframe: '5Min',
            limit: 400
          }
        }
      );
      const bars = extractCryptoBars(resp.data, symbol);
      return res.json(
        bars.map(bar => ({
          time: new Date(bar.t).toISOString(),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v
        }))
      );
    }
    const data = await fetchIntraday(symbol);
    res.json(data);
  } catch (err) {
    console.error('market intraday error:', err.response?.data || err.message);
    if (err?.code === 'DATA_UNAVAILABLE') {
      return res.json([]);
    }
    res.status(500).json({ error: err.message || 'Failed to fetch intraday data' });
  }
});

router.get('/status', (req, res) => {
  res.json(getMarketStatus());
});

router.get('/historical/:symbol', async (req, res) => {
  try {
    const symbol = normalizeMarketSymbol(req.params.symbol);
    if (!symbol) {
      return res.status(400).json({ error: 'Invalid symbol.' });
    }
    if (isCryptoSymbol(symbol)) {
      if (missingCredentials()) {
        return res.json([]);
      }
      const resp = await axios.get(
        `${DATA_URL}/v1beta3/crypto/us/bars`,
        {
          headers: {
            'APCA-API-KEY-ID': API_KEY,
            'APCA-API-SECRET-KEY': API_SECRET
          },
          params: {
            symbols: normalizeCryptoProviderSymbol(symbol),
            timeframe: '1Day',
            limit: 365
          }
        }
      );
      const bars = extractCryptoBars(resp.data, symbol);
      return res.json(
        bars.map(bar => ({
          date: new Date(bar.t).toISOString().slice(0, 10),
          close: bar.c
        }))
      );
    }
    const bars = await fetchDaily(symbol);
    const data = bars.map(bar => ({
      date: new Date(bar.t).toISOString().slice(0, 10),
      close: bar.c
    }));
    res.json(data);
  } catch (err) {
    console.error('market historical error:', err.response?.data || err.message);
    if (err?.code === 'DATA_UNAVAILABLE') {
      return res.json([]);
    }
    res.status(500).json({ error: err.message || 'Failed to fetch historical data' });
  }
});

router.post('/quotes', async (req, res) => {
  const symbols = req.body?.symbols || [];
  const assetClass = req.body?.assetClass;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols must be a non-empty array.' });
  }
  if (symbols.length > MAX_QUOTE_SYMBOLS) {
    return res.status(400).json({ error: `symbols is limited to ${MAX_QUOTE_SYMBOLS} entries.` });
  }
  if (assetClass && !['equity', 'crypto'].includes(assetClass)) {
    return res.status(400).json({ error: 'assetClass must be equity or crypto.' });
  }
  const requestedSymbols = symbols.map(normalizeMarketSymbol);
  if (requestedSymbols.some(symbol => !symbol)) {
    return res.status(400).json({ error: 'symbols contains an invalid market symbol.' });
  }
  const normalizedSymbols = [...new Set(requestedSymbols)];

  try {
    const data = await fetchQuotes(normalizedSymbols, { assetClass });
    res.json(data);
  } catch (err) {
    console.error('market quotes error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

router.post('/sparkline', async (req, res) => {
  const symbol = normalizeMarketSymbol(req.body?.symbol);
  const range = String(req.body?.range || '1D').toUpperCase();
  const assetClass = req.body?.assetClass;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required.' });
  }
  if (!ALLOWED_SPARKLINE_RANGES.has(range)) {
    return res.status(400).json({ error: 'range must be one of 1D, 1W, or 1M.' });
  }
  if (assetClass && !['equity', 'crypto'].includes(assetClass)) {
    return res.status(400).json({ error: 'assetClass must be equity or crypto.' });
  }

  try {
    const data = await fetchSparkline(symbol, range, { assetClass });
    res.json(data);
  } catch (err) {
    console.error('market sparkline error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

router.get('/:symbol/bars', async (req, res) => {
  const symbol = normalizeMarketSymbol(req.params.symbol);
  const timeframe = String(req.query.timeframe || '1Day');
  const limit = parsePositiveInt(req.query.limit, { fallback: 1, max: 500 });
  if (!symbol) {
    return res.status(400).json({ error: 'Invalid symbol.' });
  }
  if (!ALLOWED_BARS_TIMEFRAMES.has(timeframe)) {
    return res.status(400).json({ error: 'timeframe must be one of 1Min, 5Min, 15Min, 1Hour, or 1Day.' });
  }
  if (missingCredentials()) {
    return res.status(500).json({
      error: 'Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).'
    });
  }

  try {
    // v1 bars endpoint takes a `symbols` param
    const resp = await axios.get(
      `${DATA_URL}/v1/bars`,
      {
        headers: {
          'APCA-API-KEY-ID': API_KEY,
          'APCA-API-SECRET-KEY': API_SECRET
        },
        params: {
          symbols: symbol,
          timeframe,
          limit
        }
      }
    );

    const bars = resp.data[symbol];
    if (!bars) {
      return res.status(404).json({ error: `No bar data for ${symbol}` });
    }

    res.json(bars);
  } catch (err) {
    console.error('market.js error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch market data' });
  }
});

module.exports = router;
