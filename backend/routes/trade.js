// backend/routes/trade.js

const router = require('express').Router();
const axios  = require('axios');
const auth   = require('../middleware/auth'); // your JWT middleware

// POST /api/trade/execute
router.post('/execute', auth, async (req, res, next) => {
  const { symbol, side, qty } = req.body; 
  try {
    const resp = await axios.post(
      `${process.env.ALPACA_BASE_URL}/v2/orders`,
      { symbol, qty, side, type: 'market', time_in_force: 'day' },
      {
        headers: {
          'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET
        }
      }
    );
    res.json({ order: resp.data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
