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
const { getSchedulerStatus, isLegacySchedulerEnabled, isPhase1WorkerEnabled } = require('../services/roboScheduler');
const {
  LIVE_CONFIRMATION_TEXT,
  getOrCreateRoboTraderSettings,
  mapSettings,
  sanitizeSettingsUpdate,
  updateRoboTraderSettings
} = require('../robotrader/settingsService');
const {
  emergencyStop,
  previewRoboTraderForUser,
  runRoboTraderForUser
} = require('../robotrader/worker');

router.use((req, res, next) => {
  if (req.path === '/health') return next();
  return requireMongo(req, res, next);
});
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

function resolveRequestedEnvironment(req, settings) {
  if (req.query?.environment === 'live') return 'live';
  if (req.query?.environment === 'paper') return 'paper';
  return settings?.mode === 'live' ? 'live' : 'paper';
}

function mapMongoReadyState(state) {
  switch (state) {
    case 0: return 'disconnected';
    case 1: return 'connected';
    case 2: return 'connecting';
    case 3: return 'disconnecting';
    default: return 'unknown';
  }
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const TERMINAL_LOCAL_STATUSES = ['rejected', 'canceled', 'cancelled', 'filled', 'expired'];
const MATCHED_RECONCILIATION_STATUSES = [
  'matched',
  'synced',
  'updated',
  'cancel_requested',
  'replace_requested',
  'emergency_stop'
];
const TERMINAL_RECONCILIATION_STATUSES = [
  ...MATCHED_RECONCILIATION_STATUSES,
  'submit_rejected',
  'orphan_alpaca_order'
];

function hasDiscrepancy(order = {}) {
  return Boolean(String(order.discrepancy || '').trim());
}

function isArchivedReconciliation(order = {}) {
  return Boolean(order.reconciliationArchivedAt);
}

function isHistoricalReconciliationRecord(order = {}) {
  if (isArchivedReconciliation(order) || !hasDiscrepancy(order)) return false;
  const localStatus = String(order.status || '').toLowerCase();
  const reconciliationStatus = String(order.reconciliationStatus || 'pending').toLowerCase();
  return TERMINAL_LOCAL_STATUSES.includes(localStatus)
    || TERMINAL_RECONCILIATION_STATUSES.includes(reconciliationStatus);
}

function isCurrentReconciliationRecord(order = {}) {
  return !isArchivedReconciliation(order) && !isHistoricalReconciliationRecord(order);
}

function buildUnarchivedReconciliationQuery(query = {}) {
  return {
    ...query,
    reconciliationArchivedAt: null
  };
}

function buildHistoricalArchiveQuery({ userId, environment, cutoff, includeOrphans = false }) {
  const ownership = includeOrphans ? { userId: null } : { userId };
  return buildUnarchivedReconciliationQuery({
    ...ownership,
    environment,
    discrepancy: { $nin: [null, ''] },
    createdAt: { $lte: cutoff },
    $or: [
      { status: { $in: TERMINAL_LOCAL_STATUSES } },
      { reconciliationStatus: { $in: TERMINAL_RECONCILIATION_STATUSES } }
    ]
  });
}

function summarizeReconciliationOrders(orders = []) {
  const summary = {
    total: orders.length,
    pending: 0,
    matched: 0,
    discrepancies: 0,
    missingAlpacaConfirmation: 0,
    orphanAlpacaOrders: 0,
    lastReconciledAt: null
  };

  for (const order of orders) {
    const status = String(order.reconciliationStatus || 'pending').toLowerCase();
    const terminalLocalStatus = ['rejected', 'canceled', 'cancelled', 'filled'].includes(
      String(order.status || '').toLowerCase()
    );
    const terminalReconciliationStatus = [
      ...TERMINAL_RECONCILIATION_STATUSES
    ].includes(status);
    if ((!order.lastReconciledAt || status === 'pending') && !terminalLocalStatus && !terminalReconciliationStatus) {
      summary.pending += 1;
    }
    if (MATCHED_RECONCILIATION_STATUSES.includes(status)) {
      summary.matched += 1;
    }
    if (status === 'missing_alpaca_confirmation') summary.missingAlpacaConfirmation += 1;
    if (status === 'orphan_alpaca_order') summary.orphanAlpacaOrders += 1;
    if (order.discrepancy) {
      summary.discrepancies += 1;
    }
    if (order.lastReconciledAt) {
      const current = new Date(order.lastReconciledAt).getTime();
      const latest = summary.lastReconciledAt ? new Date(summary.lastReconciledAt).getTime() : 0;
      if (Number.isFinite(current) && current > latest) summary.lastReconciledAt = order.lastReconciledAt;
    }
  }

  return summary;
}

function summarizeHistoricalReconciliationOrders(orders = [], archivedCount = 0) {
  return orders.reduce((summary, order) => {
    summary.total += 1;
    if (hasDiscrepancy(order)) summary.discrepancies += 1;
    if (String(order.reconciliationStatus || '').toLowerCase() === 'orphan_alpaca_order') {
      summary.orphanAlpacaOrders += 1;
    }
    if (String(order.reconciliationStatus || '').toLowerCase() === 'submit_rejected') {
      summary.submitRejected += 1;
    }
    if (order.createdAt) {
      const createdAt = new Date(order.createdAt).getTime();
      const latest = summary.latestCreatedAt ? new Date(summary.latestCreatedAt).getTime() : 0;
      const oldest = summary.oldestCreatedAt ? new Date(summary.oldestCreatedAt).getTime() : Infinity;
      if (Number.isFinite(createdAt) && createdAt > latest) summary.latestCreatedAt = order.createdAt;
      if (Number.isFinite(createdAt) && createdAt < oldest) summary.oldestCreatedAt = order.createdAt;
    }
    return summary;
  }, {
    total: 0,
    discrepancies: 0,
    orphanAlpacaOrders: 0,
    submitRejected: 0,
    archived: archivedCount,
    oldestCreatedAt: null,
    latestCreatedAt: null
  });
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

router.get('/health', async (req, res, next) => {
  try {
    const mongoConnected = mongoose.connection.readyState === 1;
    let settings = mapSettings({});
    let latestReconciledOrder = null;
    let latestError = null;

    if (mongoConnected) {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ message: 'User not found.' });

      [settings, latestReconciledOrder, latestError] = await Promise.all([
        getMappedSettingsForUser(user._id),
        RoboTradeOrder.findOne({ userId: user._id, lastReconciledAt: { $ne: null } })
          .sort({ lastReconciledAt: -1 })
          .lean(),
        RoboAuditLog.findOne({
          userId: user._id,
          eventType: /robotrader_.*(error|blocked|discrepancy)/
        }).sort({ createdAt: -1 }).lean()
      ]);
    }

    let alpacaPaper = {
      connected: false,
      checkedAt: new Date().toISOString(),
      accountStatus: null,
      tradingBlocked: null,
      buyingPower: null,
      error: null
    };
    try {
      const account = await createAlpacaBroker({ mode: 'paper' }).getAccount();
      alpacaPaper = {
        ...alpacaPaper,
        connected: true,
        accountStatus: account?.status || null,
        tradingBlocked: Boolean(account?.trading_blocked || account?.account_blocked),
        buyingPower: toFiniteNumber(account?.buying_power ?? account?.buyingPower, null),
        error: null
      };
    } catch (err) {
      alpacaPaper.error = err?.message || 'Could not reach Alpaca paper account.';
    }

    const scheduler = getSchedulerStatus();
    res.json({
      mongo: {
        connected: mongoConnected,
        readyState: mongoose.connection.readyState,
        status: mapMongoReadyState(mongoose.connection.readyState),
        host: mongoose.connection.host || null,
        name: mongoose.connection.name || null
      },
      alpaca: {
        paper: alpacaPaper,
        live: {
          enabled: Boolean(settings.liveTradingExplicitlyEnabled && settings.mode === 'live'),
          checked: false,
          reason: 'Live account health is not checked unless live trading is explicitly enabled.'
        }
      },
      robotrader: {
        isEnabled: settings.isEnabled,
        mode: settings.mode,
        riskLevel: settings.riskLevel,
        lastRunAt: settings.lastRunAt,
        pausedReason: settings.pausedReason
      },
      scheduler: {
        ...scheduler,
        legacySchedulerEnabled: scheduler.legacySchedulerEnabled ?? isLegacySchedulerEnabled(),
        phase1WorkerEnabled: scheduler.phase1WorkerEnabled ?? isPhase1WorkerEnabled()
      },
      reconciliation: {
        lastReconciledAt: latestReconciledOrder?.lastReconciledAt || scheduler.lastReconciliationAt || null,
        latestStatus: latestReconciledOrder?.reconciliationStatus || null,
        latestDiscrepancy: latestReconciledOrder?.discrepancy || null
      },
      latestError: latestError
        ? {
            eventType: latestError.eventType,
            message: latestError.payload?.reason || latestError.payload?.error || latestError.payload?.message || null,
            createdAt: latestError.createdAt,
            payload: latestError.payload || {}
          }
        : null
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
    const settings = await getMappedSettingsForUser(user._id);
    const environment = resolveRequestedEnvironment(req, settings);
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live decisions require explicit live trading opt-in.' });
    }
    const query = { userId: user._id, environment };
    if (req.query.status) query.status = req.query.status;
    const decisions = await RoboTradeDecision.find(query).sort({ decidedAt: -1 }).limit(limit).lean();
    res.json({ decisions });
  } catch (err) {
    next(err);
  }
});

router.get('/decisions/:decisionId', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    if (!mongoose.Types.ObjectId.isValid(req.params.decisionId)) {
      return res.status(400).json({ message: 'Invalid RoboTrader decision id.' });
    }
    const decision = await RoboTradeDecision.findOne({
      _id: req.params.decisionId,
      userId: user._id
    }).lean();
    if (!decision) return res.status(404).json({ message: 'RoboTrader decision not found.' });
    const orders = await RoboTradeOrder.find({
      userId: user._id,
      decisionId: decision._id
    }).sort({ createdAt: -1 }).lean();
    res.json({ decision, orders });
  } catch (err) {
    next(err);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 250);
    const settings = await getMappedSettingsForUser(user._id);
    const environment = resolveRequestedEnvironment(req, settings);
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live orders require explicit live trading opt-in.' });
    }
    const query = { userId: user._id, environment };
    if (req.query.status) query.status = req.query.status;
    const orders = await RoboTradeOrder.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

router.get('/reconciliation-status', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    const environment = resolveRequestedEnvironment(req, settings);
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live reconciliation status requires explicit live trading opt-in.' });
    }
    const [orders, orphanOrders, archivedUserCount, archivedOrphanCount] = await Promise.all([
      RoboTradeOrder.find(buildUnarchivedReconciliationQuery({ userId: user._id, environment }))
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(250)
        .lean(),
      RoboTradeOrder.find(buildUnarchivedReconciliationQuery({
        userId: null,
        environment,
        reconciliationStatus: 'orphan_alpaca_order'
      }))
        .sort({ lastReconciledAt: -1, createdAt: -1 })
        .limit(25)
        .lean(),
      RoboTradeOrder.countDocuments({
        userId: user._id,
        environment,
        reconciliationArchivedAt: { $ne: null }
      }),
      RoboTradeOrder.countDocuments({
        userId: null,
        environment,
        reconciliationStatus: 'orphan_alpaca_order',
        reconciliationArchivedAt: { $ne: null }
      })
    ]);
    const currentOrders = orders.filter(isCurrentReconciliationRecord);
    const historicalOrders = [
      ...orders.filter(isHistoricalReconciliationRecord),
      ...orphanOrders.filter(isHistoricalReconciliationRecord)
    ];
    const summary = summarizeReconciliationOrders(currentOrders);
    const orphanSummary = summarizeReconciliationOrders(orphanOrders.filter(isCurrentReconciliationRecord));
    const historicalSummary = summarizeHistoricalReconciliationOrders(
      historicalOrders,
      archivedUserCount + archivedOrphanCount
    );
    summary.orphanAlpacaOrders = orphanSummary.orphanAlpacaOrders;
    summary.discrepancies += orphanSummary.discrepancies;
    if (!summary.lastReconciledAt && orphanSummary.lastReconciledAt) {
      summary.lastReconciledAt = orphanSummary.lastReconciledAt;
    }
    const latestDiscrepancies = currentOrders
      .filter(order => order.discrepancy)
      .slice(0, 10)
      .map(order => ({
        _id: order._id,
        symbol: order.symbol,
        status: order.status,
        reconciliationStatus: order.reconciliationStatus,
        discrepancy: order.discrepancy,
        lastReconciledAt: order.lastReconciledAt,
        clientOrderId: order.clientOrderId,
        externalOrderId: order.externalOrderId
      }));
    const historicalDiscrepancies = historicalOrders
      .slice(0, 10)
      .map(order => ({
        _id: order._id,
        symbol: order.symbol,
        status: order.status,
        reconciliationStatus: order.reconciliationStatus,
        discrepancy: order.discrepancy,
        lastReconciledAt: order.lastReconciledAt,
        clientOrderId: order.clientOrderId,
        externalOrderId: order.externalOrderId,
        createdAt: order.createdAt
      }));
    res.json({
      summary,
      orphanSummary: {
        count: orphanOrders.filter(isCurrentReconciliationRecord).length,
        lastReconciledAt: orphanSummary.lastReconciledAt
      },
      historicalSummary,
      latestDiscrepancies,
      historicalDiscrepancies,
      orders: currentOrders.slice(0, 50).map(order => ({
        _id: order._id,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        filledQty: order.filledQty,
        filledAvgPrice: order.filledAvgPrice,
        reconciliationStatus: order.reconciliationStatus,
        discrepancy: order.discrepancy,
        lastReconciledAt: order.lastReconciledAt,
        clientOrderId: order.clientOrderId,
        externalOrderId: order.externalOrderId,
        environment: order.environment,
        updatedAt: order.updatedAt,
        createdAt: order.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reconciliation/archive-history', sensitiveRateLimit({ max: 6 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    const environment = req.body?.environment === 'live' ? 'live' : 'paper';
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live reconciliation cleanup requires explicit live trading opt-in.' });
    }
    const olderThanDays = Math.min(Math.max(Number(req.body?.olderThanDays || 0), 0), 3650);
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const archiveReason = String(req.body?.reason || 'Archived terminal historical reconciliation discrepancies.').slice(0, 240);
    const archiveUpdate = {
      $set: {
        reconciliationArchivedAt: now,
        reconciliationArchivedBy: user._id,
        reconciliationArchiveReason: archiveReason
      }
    };

    const [userResult, orphanResult] = await Promise.all([
      RoboTradeOrder.updateMany(
        buildHistoricalArchiveQuery({ userId: user._id, environment, cutoff }),
        archiveUpdate
      ),
      RoboTradeOrder.updateMany(
        buildHistoricalArchiveQuery({ userId: user._id, environment, cutoff, includeOrphans: true }),
        archiveUpdate
      )
    ]);
    const archivedUserOrders = userResult.modifiedCount ?? userResult.nModified ?? 0;
    const archivedOrphanOrders = orphanResult.modifiedCount ?? orphanResult.nModified ?? 0;
    const archivedCount = archivedUserOrders + archivedOrphanOrders;

    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_reconciliation_history_archived',
      payload: {
        environment,
        olderThanDays,
        cutoff: cutoff.toISOString(),
        archivedUserOrders,
        archivedOrphanOrders,
        archivedCount,
        reason: archiveReason
      }
    });

    res.json({
      archivedCount,
      archivedUserOrders,
      archivedOrphanOrders,
      cutoff,
      environment
    });
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
    const environment = resolveRequestedEnvironment(req, settings);
    if (environment === 'live' && !settings.liveTradingExplicitlyEnabled) {
      return res.status(403).json({ message: 'Live performance data requires explicit live trading opt-in.' });
    }
    const [decisions, orders] = await Promise.all([
      RoboTradeDecision.find({ userId: user._id, environment }).sort({ decidedAt: -1 }).limit(250).lean(),
      RoboTradeOrder.find({ userId: user._id, environment }).sort({ createdAt: -1 }).limit(250).lean()
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

router.post('/preview-paper', sensitiveRateLimit({ max: 12 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const currentSettings = await getMappedSettingsForUser(user._id);
    const sanitizedPreviewSettings = sanitizeSettingsUpdate({
      ...(req.body?.settings || {}),
      mode: 'paper',
      liveTradingExplicitlyEnabled: false
    }, currentSettings);
    const settingsOverride = mapSettings({
      ...currentSettings,
      ...sanitizedPreviewSettings,
      mode: 'paper',
      liveTradingExplicitlyEnabled: false
    });
    const preview = await previewRoboTraderForUser({
      userId: user._id,
      settingsOverride,
      modeOverride: 'paper'
    });
    res.json({ preview });
  } catch (err) {
    next(err);
  }
});

router.post('/run-once-paper', sensitiveRateLimit({ max: 8 }), async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'User not found.' });
    const settings = await getMappedSettingsForUser(user._id);
    if (!settings.isEnabled) {
      return res.status(400).json({ message: 'Enable RoboTrader before running a paper test.' });
    }
    if (settings.mode !== 'paper') {
      return res.status(400).json({ message: 'Run Once Paper is only available while RoboTrader is in paper mode.' });
    }
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
      mode: requestedMode,
      userId: user._id
    });
    await RoboAuditLog.create({
      userId: user._id,
      eventType: 'robotrader_manual_reconciliation',
      payload: {
        environment: requestedMode,
        updatedCount: result.updatedCount || 0,
        discrepancyCount: result.discrepancyCount || 0
      }
    });
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
