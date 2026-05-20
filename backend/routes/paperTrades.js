const router = require('express').Router();
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const paperBroker = require('../paper/paperBrokerClient');
const { getRequestAccountId } = require('../utils/accountScope');

router.use(requireMongo);
router.use(auth);

router.post('/order', async (req, res) => {
  const accountId = getRequestAccountId(req);
  try {
    const {
      symbol,
      side,
      qty,
      assetClass,
      orderType,
      timeInForce,
      goodTilDate,
      takeProfitPrice,
      stopLossPrice,
      trailingStopPct,
      limitPrice,
      maxPricePerShare,
      allowExtendedHours,
      strategyId,
      setupType,
      strategyTags,
      stopPrice,
      origin,
      metadata
    } = req.body || {};
    const resolvedOrigin = origin || (strategyId ? 'trade_plan' : 'manual');
    const result = await paperBroker.placeOrder({
      accountId,
      symbol,
      side,
      qty,
      assetClass,
      orderType,
      timeInForce,
      goodTilDate,
      takeProfitPrice,
      stopLossPrice,
      trailingStopPct,
      limitPrice,
      maxPricePerShare,
      allowExtendedHours,
      strategyId,
      setupType,
      strategyTags,
      stopPrice,
      origin: resolvedOrigin,
      metadata: metadata || {}
    });
    res.json(result);
  } catch (err) {
    const payload = req.body || {};
    if (!err.paperOrderRecorded) {
      await paperBroker.recordRejectedOrder({
        ...payload,
        accountId,
        origin: payload.origin || (payload.strategyId ? 'trade_plan' : 'manual'),
        metadata: payload.metadata || {}
      }, err.message).catch(() => {});
    }
    res.status(err.statusCode || 400).json({
      error: err.message,
      order: err.paperOrder || undefined,
      brokerOrder: err.brokerOrder || undefined
    });
  }
});

router.get('/account', async (req, res, next) => {
  try {
    const account = await paperBroker.getAccount({ accountId: getRequestAccountId(req) });
    res.json(account);
  } catch (err) {
    next(err);
  }
});

router.get('/positions', async (req, res, next) => {
  try {
    const positions = await paperBroker.getPositions({ accountId: getRequestAccountId(req) });
    res.json(positions);
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const orders = await paperBroker.getOrders({ accountId: getRequestAccountId(req) });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

router.get('/trades', async (req, res, next) => {
  try {
    const trades = await paperBroker.getTrades({ accountId: getRequestAccountId(req) });
    res.json(trades);
  } catch (err) {
    next(err);
  }
});

router.get('/equity', async (req, res, next) => {
  try {
    const equity = await paperBroker.getEquityCurve({ accountId: getRequestAccountId(req) });
    res.json(equity);
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await paperBroker.getSettings({ accountId: getRequestAccountId(req) });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const settings = await paperBroker.updateSettings(req.body || {}, { accountId: getRequestAccountId(req) });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
