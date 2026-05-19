// backend/routes/trade.js

const router = require('express').Router();
const auth   = require('../middleware/auth'); // your JWT middleware
const {
  buildClientOrderId,
  submitAlpacaPaperOrder
} = require('../services/alpacaTradingClient');

// POST /api/trade/execute
router.post('/execute', auth, async (req, res, next) => {
  const { symbol, side, qty } = req.body;
  try {
    const result = await submitAlpacaPaperOrder({
      symbol,
      qty,
      side,
      orderType: 'market',
      timeInForce: 'day',
      clientOrderId: buildClientOrderId({ origin: 'manual', symbol })
    });
    res.json({ order: result.order });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
