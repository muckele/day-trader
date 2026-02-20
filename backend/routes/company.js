const express = require('express');
const axios = require('axios');
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

router.get('/:symbol', async (req, res) => {
  if (!API_KEY || !API_SECRET) {
    return res.status(500).json({
      error: 'Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).'
    });
  }

  const symbol = req.params.symbol.toUpperCase();

  try {
    // v1 assets returns a list, so we filter down to our symbol
    const resp = await axios.get(
      `${DATA_URL}/v1/assets`,
      {
        headers: {
          'APCA-API-KEY-ID': API_KEY,
          'APCA-API-SECRET-KEY': API_SECRET
        },
        params: {
          asset_class: 'us_equity',
          status: 'active'
        }
      }
    );

    const asset = resp.data.find(a => a.symbol === symbol);
    if (!asset) {
      return res.status(404).json({ error: `No asset found for ${symbol}` });
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
