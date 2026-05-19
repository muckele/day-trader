// backend/routes/trade.js

const router = require('express').Router();
const auth   = require('../middleware/auth'); // your JWT middleware
const requireMongo = require('../middleware/requireMongo');
const paperBroker = require('../paper/paperBrokerClient');

// POST /api/trade/execute
router.post('/execute', auth, requireMongo, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const result = await paperBroker.placeOrder({
      symbol: payload.symbol,
      side: payload.side,
      qty: payload.qty,
      assetClass: payload.assetClass,
      orderType: payload.orderType || 'market',
      timeInForce: payload.timeInForce || 'day',
      goodTilDate: payload.goodTilDate,
      takeProfitPrice: payload.takeProfitPrice,
      stopLossPrice: payload.stopLossPrice,
      trailingStopPct: payload.trailingStopPct,
      limitPrice: payload.limitPrice,
      maxPricePerShare: payload.maxPricePerShare,
      allowExtendedHours: payload.allowExtendedHours === true,
      strategyId: payload.strategyId,
      setupType: payload.setupType,
      strategyTags: payload.strategyTags,
      stopPrice: payload.stopPrice,
      origin: 'manual',
      metadata: {
        ...(payload.metadata || {}),
        source: 'api_trade_execute'
      }
    });
    res.json(result);
  } catch (err) {
    const payload = req.body || {};
    await paperBroker.recordRejectedOrder({
      ...payload,
      origin: 'manual',
      metadata: {
        ...(payload.metadata || {}),
        source: 'api_trade_execute'
      }
    }, err.message).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
