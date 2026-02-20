const express = require('express');
const axios = require('axios');
const router = express.Router();

const RAW_TRADING_URL =
  process.env.APCA_API_BASE_URL ||
  process.env.ALPACA_API_BASE_URL ||
  process.env.APCA_BASE_URL ||
  process.env.ALPACA_BASE_URL;

function normalizeBaseUrl(url) {
  return url.replace(/\/v2\/?$/, '').replace(/\/+$/, '');
}

const TRADING_BASE_URLS = [
  RAW_TRADING_URL,
  'https://paper-api.alpaca.markets',
  'https://api.alpaca.markets'
]
  .filter(Boolean)
  .map(normalizeBaseUrl)
  .filter((value, index, list) => list.indexOf(value) === index);

const API_KEY =
  process.env.BROKER_API_KEY ||
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY;

const API_SECRET =
  process.env.BROKER_API_SECRET ||
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET;

router.get('/:symbol', async (req, res) => {
  if (!API_KEY || !API_SECRET) {
    return res.status(500).json({
      error: 'Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).'
    });
  }

  const symbol = req.params.symbol.toUpperCase();

  try {
    let asset = null;
    let sawNotFound = false;
    let lastError = null;

    for (const baseUrl of TRADING_BASE_URLS) {
      try {
        const resp = await axios.get(
          `${baseUrl}/v2/assets/${symbol}`,
          {
            headers: {
              'APCA-API-KEY-ID': API_KEY,
              'APCA-API-SECRET-KEY': API_SECRET
            }
          }
        );
        asset = resp.data;
        break;
      } catch (err) {
        if (err.response?.status === 404) {
          sawNotFound = true;
          continue;
        }
        lastError = err;
      }
    }

    if (!asset) {
      if (sawNotFound) {
        return res.status(404).json({ error: `No asset found for ${symbol}` });
      }
      throw lastError || new Error('No trading API base URL available for company lookup.');
    }

    res.json({
      company: {
        symbol: asset.symbol,
        name: asset.name,
        exchange: asset.exchange,
        asset_class: asset.asset_class,
        status: asset.status
      },
      stats: {
        marketcap: null,
        peRatio: null,
        dividendYield: null,
        employees: null
      }
    });
  } catch (err) {
    console.error('company.js error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch company info' });
  }
});

module.exports = router;
