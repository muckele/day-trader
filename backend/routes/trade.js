// backend/routes/trade.js

const router = require('express').Router();
const axios  = require('axios');
const auth   = require('../middleware/auth'); // your JWT middleware

const BASE_URL =
  process.env.ALPACA_BASE_URL ||
  process.env.APCA_BASE_URL ||
  'https://paper-api.alpaca.markets';

const API_KEY =
  process.env.BROKER_API_KEY ||
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY;

const API_SECRET =
  process.env.BROKER_API_SECRET ||
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET;

// POST /api/trade/execute
router.post('/execute', auth, async (req, res, next) => {
  const { symbol, side, qty } = req.body; 
  try {
    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({
        error: 'Missing Alpaca API keys (BROKER_API_KEY/BROKER_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY).'
      });
    }

    const resp = await axios.post(
      `${BASE_URL}/v2/orders`,
      { symbol, qty, side, type: 'market', time_in_force: 'day' },
      {
        headers: {
          'APCA-API-KEY-ID': API_KEY,
          'APCA-API-SECRET-KEY': API_SECRET
        }
      }
    );
    res.json({ order: resp.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
