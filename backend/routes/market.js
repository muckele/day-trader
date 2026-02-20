const express = require('express');
const axios = require('axios');
const { fetchDaily, fetchIntraday } = require('../tradeLogic');
const { fetchQuotes, fetchSparkline } = require('../services/marketData');
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

router.get('/intraday/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await fetchIntraday(symbol);
    res.json(data);
  } catch (err) {
    console.error('market intraday error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch intraday data' });
  }
});

router.get('/status', (req, res) => {
  res.json(getMarketStatus());
});

router.get('/historical/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const bars = await fetchDaily(symbol);
    const data = bars.map(bar => ({
      date: new Date(bar.t).toISOString().slice(0, 10),
      close: bar.c
    }));
    res.json(data);
  } catch (err) {
    console.error('market historical error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch historical data' });
  }
});

router.post('/quotes', async (req, res) => {
  const symbols = req.body?.symbols || [];
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols must be a non-empty array.' });
  }

  try {
    const data = await fetchQuotes(symbols);
    res.json(data);
  } catch (err) {
    console.error('market quotes error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

router.post('/sparkline', async (req, res) => {
  const symbol = req.body?.symbol?.toUpperCase();
  const range = req.body?.range || '1D';
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required.' });
  }

  try {
    const data = await fetchSparkline(symbol, range);
    res.json(data);
  } catch (err) {
    console.error('market sparkline error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

router.get('/:symbol/bars', async (req, res) => {
  if (missingCredentials()) {
    return res.status(500).json({
      error: 'Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).'
    });
  }

  const symbol = req.params.symbol.toUpperCase();
  const timeframe = req.query.timeframe || '1Day';
  const limit = parseInt(req.query.limit, 10) || 1;

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
