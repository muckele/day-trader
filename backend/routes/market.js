// backend/routes/market.js
const router = require('express').Router();
const axios  = require('axios');

// Base URLs & headers from .env
const DATA_URL = process.env.APCA_DATA_URL;
const HEADERS  = {
  'APCA-API-KEY-ID':     process.env.BROKER_API_KEY,
  'APCA-API-SECRET-KEY': process.env.BROKER_API_SECRET
};

// 5-min intraday bars (~last 5 days)
router.get('/intraday/:symbol', async (req, res, next) => {
  try {
    const resp = await axios.get(
      `${DATA_URL}/stocks/${req.params.symbol}/bars`,
      { headers: HEADERS, params: { timeframe: '5Min', limit: 500 } }
    );
    const bars = resp.data.bars.map(b => ({
      time:   new Date(b.t).toISOString(),
      open:   b.o, high: b.h, low: b.l, close: b.c, volume: b.v
    }));
    res.json(bars);
  } catch (err) {
    next(err);
  }
});

// Daily bars (last year)
router.get('/historical/:symbol', async (req, res, next) => {
  try {
    const resp = await axios.get(
      `${DATA_URL}/stocks/${req.params.symbol}/bars`,
      { headers: HEADERS, params: { timeframe: '1Day', limit: 365 } }
    );
    const bars = resp.data.bars.map(b => ({
      date:   new Date(b.t).toISOString().slice(0,10),
      open:   b.o, high: b.h, low: b.l, close: b.c, volume: b.v
    }));
    res.json(bars);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
