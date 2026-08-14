// backend/routes/trade.js

const router = require('express').Router();
const auth   = require('../middleware/auth'); // your JWT middleware
const requireMongo = require('../middleware/requireMongo');
const paperBroker = require('../paper/paperBrokerClient');
const { getRequestAccountId } = require('../utils/accountScope');
const { SUBMIT_UNKNOWN } = require('../services/submissionOutcomeService');

function getIdempotencyKey(req) {
  return req.get?.('Idempotency-Key')
    || req.headers?.['idempotency-key']
    || null;
}

// POST /api/trade/execute
router.post('/execute', auth, requireMongo, async (req, res, next) => {
  const accountId = getRequestAccountId(req);
  try {
    const payload = req.body || {};
    const result = await paperBroker.placeOrder({
      accountId,
      idempotencyKey: getIdempotencyKey(req),
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
    const isSubmitUnknown = err.code === SUBMIT_UNKNOWN
      || err.submissionOutcome === SUBMIT_UNKNOWN;
    res.status(isSubmitUnknown ? 409 : (err.statusCode || 400)).json({
      error: err.message,
      code: isSubmitUnknown ? SUBMIT_UNKNOWN : (err.code || undefined),
      submissionState: isSubmitUnknown ? SUBMIT_UNKNOWN : (err.submissionOutcome || undefined),
      submissionPhase: err.submissionPhase || undefined,
      submissionAttempted: typeof err.submissionAttempted === 'boolean'
        ? err.submissionAttempted
        : undefined,
      reconciliationRequired: err.reconciliationRequired === true || undefined,
      brokerOrderPersisted: typeof err.brokerOrderPersisted === 'boolean'
        ? err.brokerOrderPersisted
        : undefined,
      idempotentReplay: err.idempotentReplay === true || undefined,
      clientOrderId: err.clientOrderId || err.paperOrder?.clientOrderId || undefined,
      order: err.paperOrder || undefined,
      brokerOrder: err.brokerOrder || undefined
    });
  }
});

module.exports = router;
