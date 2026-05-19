const router = require('express').Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const requireMongo = require('../middleware/requireMongo');
const User = require('../models/User');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const { ALPACA_CAPABILITY_MATRIX } = require('../robotrader/alpacaCapabilities');
const { createAlpacaBroker } = require('../robotrader/alpacaBroker');
const { reconcileRoboOrders } = require('../robotrader/reconciliation');
const {
  LIVE_CONFIRMATION_TEXT,
  getOrCreateRoboTraderSettings,
  mapSettings,
  updateRoboTraderSettings
} = require('../robotrader/settingsService');
const {
  emergencyStop,
  runRoboTraderForUser
} = require('../robotrader/worker');

router.use(requireMongo);
router.use(auth);

const rateState = new Map();

function sensitiveRateLimit({ windowMs = 60 * 1000, max = 20 } = {}) {
  return function limiter(req, res, next) {
    const key = `${req.user?.username || 'anonymous'}:${req.ip || req.socket?.remoteAddress || 'local'}`;
    const now = Date.now();
    const current = rateState.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }
    current.count += 1;
    rateState.set(key, current);
    if (current.count > max) {
      return res.status(429).json({ message: 'Too many RoboTrader requests. Try again shortly.' });
    }
    next();
  };
}

async function getCurrentUser(req) {
  const username = req.user?.username;
  if (!username) return null;
  return User.findOne({ username });
}

function handleRouteError(err, res, next) {
  if (err?.status) {
    return res.status(err.status).json({ message: err.message });
  }
  return next(err);
}

function buildOrderLookup(userId, orderId) {
  const or = [
    { externalOrderId: orderId },
    { clientOrderId: orderId }
  ];
  if (mongoose.Types.ObjectId.isValid(orderId)) {
    or.unshift({ _id: orderId });
  }
  return { userId, $or: or };
}

async function getMappedSettingsForUser(userId) {
  return mapSettings(await getOrCreateRoboTraderSettings(userId));
}

function ensureLiveTradingAllowed(settings, action = 'Live trading') {
  if (settings.liveTradingExplicitlyEnabled) return null;
  const err = new Error(`${action} requires explicit live trading opt-in.`);
  err.status = 403;
  throw err;
}

router.get('/settings', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getOrCreateRoboTraderSettings(user._id);
    res.json({
      settings: mapSettings(settings),
      capabilities: ALPACA_CAPABILITY_MATRIX,
      liveConfirmationText: LIVE_CONFIRMATION_TEXT
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', sensitiveRateLimit(), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await updateRoboTraderSettings(user._id, req.body || {});
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_settings_updated',
      payload: {
        settings: mapSettings(settings)
      }
    });
    res.json({ settings: mapSettings(settings) });
  } catch (err) {
    handleRouteError(err, res, next);
  }
});

router.post('/enable', sensitiveRateLimit(), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await updateRoboTraderSettings(user._id, {
      ...(req.body || {}),
      isEnabled: true,
      enabled: true,
      pausedReason: null
    });
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_enabled',
      payload: { mode: settings.mode }
    });
    res.json({ settings: mapSettings(settings) });
  } catch (err) {
    handleRouteError(err, res, next);
  }
});

router.post('/disable', sensitiveRateLimit(), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await updateRoboTraderSettings(user._id, {
      isEnabled: false,
      enabled: false,
      pausedReason: req.body?.reason || 'Disabled by user.'
    });
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_disabled',
      payload: { reason: settings.pausedReason || 'Disabled by user.' }
    });
    res.json({ settings: mapSettings(settings) });
  } catch (err) {
    handleRouteError(err, res, next);
  }
});

router.post('/emergency-stop', sensitiveRateLimit({ max: 10 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const result = await emergencyStop({
      userId: user._id,
      cancelOpenOrders: req.body?.cancelOpenOrders === true,
      environment: req.body?.environment === 'live' ? 'live' : 'paper'
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/decisions', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 250);
    const query = { userId: user._id };
    if (req.query.status) query.status = req.query.status;
    const decisions = await RoboTradeDecision.find(query).sort({ decidedAt: -1 }).limit(limit).lean();
    res.json({ decisions });
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 250);
    const query = { userId: user._id };
    if (req.query.status) query.status = req.query.status;
    const orders = await RoboTradeOrder.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:orderId/cancel', sensitiveRateLimit({ max: 12 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const order = await RoboTradeOrder.findOne(buildOrderLookup(user._id, req.params.orderId));
    if (!order) return res.status(404).json({ message: 'RoboTrader order not found.' });
    if (!order.externalOrderId) {
      return res.status(400).json({ message: 'Order does not have an Alpaca order id.' });
    }
    const broker = createAlpacaBroker({ mode: order.environment });
    const response = await broker.cancelOrder(order.externalOrderId);
    order.status = 'canceled';
    order.canceledAt = new Date();
    order.lastReconciledAt = new Date();
    order.reconciliationStatus = 'cancel_requested';
    order.alpacaResponse = response || order.alpacaResponse;
    await order.save();
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_order_cancel_requested',
      payload: {
        orderId: order.externalOrderId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol
      }
    });
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:orderId/replace', sensitiveRateLimit({ max: 12 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const order = await RoboTradeOrder.findOne(buildOrderLookup(user._id, req.params.orderId));
    if (!order) return res.status(404).json({ message: 'RoboTrader order not found.' });
    if (!order.externalOrderId) {
      return res.status(400).json({ message: 'Order does not have an Alpaca order id.' });
    }
    if (order.environment === 'live') {
      ensureLiveTradingAllowed(await getMappedSettingsForUser(user._id), 'Live order replacement');
    }
    const broker = createAlpacaBroker({ mode: order.environment });
    const response = await broker.replaceOrder(order.externalOrderId, req.body || {});
    order.alpacaResponse = response || order.alpacaResponse;
    order.status = response?.status || order.status;
    order.lastReconciledAt = new Date();
    order.reconciliationStatus = 'replace_requested';
    await order.save();
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_order_replace_requested',
      payload: {
        orderId: order.externalOrderId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        replacement: req.body || {}
      }
    });
    res.json({ order });
  } catch (err) {
    handleRouteError(err, res, next);
  }
});

router.post('/positions/:symbol/close', sensitiveRateLimit({ max: 12 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    const environment = req.body?.environment === 'live' ? 'live' : settings.mode;
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live position closing requires explicit live trading opt-in.' });
    }
    const broker = createAlpacaBroker({ mode: environment });
    const response = await broker.closePosition(req.params.symbol, req.body?.close || {});
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_position_close_requested',
      payload: {
        symbol: req.params.symbol.toUpperCase(),
        environment,
        response
      }
    });
    res.json({ response });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const logs = await RoboAuditLog.find({
      userId: user._id,
      eventType: /^robotrader_/
    }).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ events: logs });
  } catch (err) {
    next(err);
  }
});

router.get('/performance', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    const environment = req.query.environment === 'live' ? 'live' : settings.mode;
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live performance data requires explicit live trading opt-in.' });
    }
    const [decisions, orders] = await Promise.all([
      RoboTradeDecision.find({ userId: user._id }).sort({ decidedAt: -1 }).limit(250).lean(),
      RoboTradeOrder.find({ userId: user._id }).sort({ createdAt: -1 }).limit(250).lean()
    ]);
    let account = null;
    let positions = [];
    let brokerError = null;
    try {
      const broker = createAlpacaBroker({ mode: environment });
      [account, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
    } catch (err) {
      brokerError = err?.message || 'Could not load Alpaca account context.';
    }
    const submitted = orders.filter(order => !['rejected', 'pending_submit'].includes(String(order.status || '').toLowerCase()));
    const filled = orders.filter(order => String(order.status || '').toLowerCase() === 'filled');
    const rejected = decisions.filter(decision => decision.status === 'rejected');
    res.json({
      summary: {
        decisions: decisions.length,
        submittedOrders: submitted.length,
        filledOrders: filled.length,
        rejectedDecisions: rejected.length,
        lastRunAt: settings.lastRunAt
      },
      account,
      positions,
      brokerError
    });
  } catch (err) {
    next(err);
  }
});

router.post('/run-once-paper', sensitiveRateLimit({ max: 8 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const result = await runRoboTraderForUser({
      userId: user._id,
      modeOverride: 'paper',
      runOnce: true
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

router.post('/reconcile', sensitiveRateLimit({ max: 8 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    const requestedMode = req.body?.mode === 'live' ? 'live' : 'paper';
    if (requestedMode === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live reconciliation requires explicit live trading opt-in.' });
    }
    const result = await reconcileRoboOrders({
      mode: requestedMode
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
