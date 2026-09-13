// backend/routes/trade.js

const router = require('express').Router();
const auth   = require('../middleware/auth'); // your JWT middleware
const requireMongo = require('../middleware/requireMongo');
const paperBroker = require('../paper/paperBrokerClient');
const { getRequestAccountId } = require('../utils/accountScope');

// POST /api/trade/execute
router.post('/execute', auth, requireMongo, async (req, res, next) => {
  const accountId = getRequestAccountId(req);
  try {
    const payload = req.body || {};
    const result = await paperBroker.placeOrder({
      accountId,
      userId: req.user.userId,
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
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
    if (!require('../services/alpacaTradingClient').shouldSyncPaperTradesToAlpaca()) await paperBroker.recordRejectedOrder({
      ...payload,
      accountId,
      origin: 'manual',
      metadata: {
        ...(payload.metadata || {}),
        source: 'api_trade_execute'
      }
    }, err.message).catch(() => {});
    res.status(err.statusCode || err.status || 400).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
