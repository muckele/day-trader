const RoboSettings = require('../models/RoboSettings');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const { getRecommendationUniverse } = require('../config/tradingConfig');
const { isCryptoSymbol } = require('../services/marketData');
const {
  getOrCreateRoboTraderSettings,
  mapSettings,
  normalizeAssetClass,
  normalizeSymbol,
  updateRoboTraderSettings
} = require('./settingsService');
const { buildResearchBatch } = require('./researchService');
const { evaluateResearchBatch } = require('./strategyEngine');
const { evaluateRoboRisk } = require('./riskGate');
const { createAlpacaBroker } = require('./alpacaBroker');

const TERMINAL_ORDER_STATUSES = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildRunId(userId, now = new Date()) {
  return `robotrader-${String(userId)}-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
}

function minuteBucket(now = new Date()) {
  const date = new Date(now);
  date.setUTCSeconds(0, 0);
  return date.toISOString().replace(/[^0-9]/g, '').slice(0, 12);
}

function buildDecisionIdempotencyKey({ userId, symbol, strategyId, now }) {
  return [
    String(userId),
    normalizeSymbol(symbol),
    String(strategyId || 'NO_STRATEGY'),
    minuteBucket(now)
  ].join(':');
}

function normalizeAlpacaPosition(position = {}) {
  return {
    symbol: normalizeSymbol(position.symbol),
    qty: toFiniteNumber(position.qty, 0),
    market_value: toFiniteNumber(position.market_value ?? position.marketValue, 0),
    avg_entry_price: toFiniteNumber(position.avg_entry_price, null)
  };
}

function normalizeAlpacaOrder(order = {}) {
  return {
    id: order.id || null,
    client_order_id: order.client_order_id || null,
    symbol: normalizeSymbol(order.symbol),
    status: String(order.status || '').toLowerCase(),
    side: order.side || null,
    qty: toFiniteNumber(order.qty, null),
    notional: toFiniteNumber(order.notional, null),
    submittedAt: order.submitted_at || order.created_at || null,
    createdAt: order.created_at || null,
    raw: order
  };
}

function inferAssetClass(symbol, settings) {
  if (isCryptoSymbol(symbol)) return 'crypto';
  if ((settings.allowedAssetClasses || []).includes('stocks')) return 'stocks';
  return settings.allowedAssetClasses?.[0] || 'stocks';
}

function buildSymbolUniverse(settings) {
  if (settings.allowedSymbols?.length) {
    return settings.allowedSymbols.map(symbol => ({
      symbol,
      assetClass: inferAssetClass(symbol, settings)
    }));
  }
  const configured = String(process.env.ROBOTRADER_SYMBOL_UNIVERSE || '')
    .split(',')
    .map(item => normalizeSymbol(item))
    .filter(Boolean);
  const universe = configured.length ? configured : getRecommendationUniverse();
  return universe
    .map(symbol => ({ symbol, assetClass: inferAssetClass(symbol, settings) }))
    .filter(item => (settings.allowedAssetClasses || ['stocks']).includes(item.assetClass))
    .slice(0, Math.max(1, Number(process.env.ROBOTRADER_MAX_SYMBOLS_PER_RUN || 5)));
}

async function writeAudit(userId, eventType, payload, deps) {
  return deps.RoboAuditLog.create({ userId, eventType, payload: payload || {} });
}

function buildOrderInputFromDecision(decision, settings) {
  const order = decision.recommendedOrder || {};
  return {
    symbol: order.symbol || decision.symbol,
    assetClass: normalizeAssetClass(order.assetClass || decision.assetClass) || 'stocks',
    side: order.side || (decision.action === 'sell' || decision.action === 'short' ? 'sell' : 'buy'),
    orderType: order.orderType || 'market',
    orderClass: order.orderClass || 'simple',
    timeInForce: order.timeInForce || (order.assetClass === 'crypto' ? 'gtc' : 'day'),
    qty: order.qty || null,
    notional: order.notional || null,
    limitPrice: order.limitPrice || null,
    stopPrice: order.stopPrice || null,
    trailPrice: order.trailPrice || null,
    trailPercent: order.trailPercent || null,
    takeProfit: order.takeProfit || null,
    stopLoss: order.stopLoss || null,
    extendedHours: Boolean(settings.allowExtendedHours && order.extendedHours),
    estimatedNotional: order.estimatedNotional || order.notional || null,
    strategyId: decision.strategyId || order.strategyId || null
  };
}

async function getRecentLocalOrders(userId, now, deps) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return deps.RoboTradeOrder.find({
    userId,
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 }).lean();
}

async function saveDecision({
  userId,
  accountId = 'default',
  environment,
  runId,
  research,
  decision,
  riskResult,
  orderInput,
  now,
  deps
}) {
  const idempotencyKey = buildDecisionIdempotencyKey({
    userId,
    symbol: decision.symbol,
    strategyId: decision.strategyId,
    now
  });
  const status = riskResult.approved
    ? 'approved'
    : (riskResult.rejectionReasons.includes('Trade requires manual approval above configured dollar amount.')
      ? 'pending_manual_approval'
      : 'rejected');

  try {
    return await deps.RoboTradeDecision.create({
      userId,
      accountId,
      environment,
      runId,
      idempotencyKey,
      symbol: decision.symbol,
      assetClass: normalizeAssetClass(decision.assetClass) || 'stocks',
      action: decision.action || 'hold',
      status,
      confidenceScore: decision.confidenceScore || 0,
      rewardRiskRatio: decision.rewardRiskRatio || null,
      strategyId: decision.strategyId || null,
      strategyName: decision.strategyName || null,
      reasoningSummary: decision.reasoningSummary || null,
      researchSnapshot: research || {},
      recommendedOrder: orderInput || {},
      riskChecks: riskResult.checks || [],
      rejectionReasons: riskResult.rejectionReasons || [],
      decidedAt: now
    });
  } catch (err) {
    if (err?.code === 11000) {
      await writeAudit(userId, 'robotrader_duplicate_decision', {
        symbol: decision.symbol,
        strategyId: decision.strategyId,
        idempotencyKey,
        reason: 'Decision already exists for this symbol/strategy/minute.'
      }, deps);
      return null;
    }
    throw err;
  }
}

async function submitApprovedOrder({
  userId,
  environment,
  decisionDoc,
  orderInput,
  riskResult,
  broker,
  now,
  deps
}) {
  const pendingOrder = await deps.RoboTradeOrder.create({
    userId,
    accountId: 'default',
    decisionId: decisionDoc._id,
    environment,
    symbol: normalizeSymbol(orderInput.symbol),
    assetClass: normalizeAssetClass(orderInput.assetClass) || 'stocks',
    side: orderInput.side,
    orderType: orderInput.orderType,
    orderClass: orderInput.orderClass,
    timeInForce: orderInput.timeInForce,
    qty: orderInput.qty,
    notional: orderInput.notional,
    limitPrice: orderInput.limitPrice,
    stopPrice: orderInput.stopPrice,
    trailPrice: orderInput.trailPrice,
    trailPercent: orderInput.trailPercent,
    takeProfit: orderInput.takeProfit,
    stopLoss: orderInput.stopLoss,
    status: 'pending_submit',
    reasoningSummary: decisionDoc.reasoningSummary,
    strategyId: decisionDoc.strategyId,
    riskChecks: riskResult.checks || []
  });

  try {
    const result = await broker.submitOrder({
      ...orderInput,
      clientOrderId: pendingOrder.clientOrderId || undefined
    });
    const order = result.order || {};
    pendingOrder.externalOrderId = order.id || null;
    pendingOrder.clientOrderId = order.client_order_id || result.payload?.client_order_id || null;
    pendingOrder.status = order.status || 'submitted';
    pendingOrder.rawPayload = result.payload || {};
    pendingOrder.alpacaResponse = order;
    pendingOrder.submittedAt = order.submitted_at || now;
    pendingOrder.filledQty = toFiniteNumber(order.filled_qty, null);
    pendingOrder.filledAvgPrice = toFiniteNumber(order.filled_avg_price, null);
    pendingOrder.filledAt = order.filled_at || null;
    await pendingOrder.save();

    decisionDoc.status = 'submitted';
    decisionDoc.alpacaResponse = order;
    await decisionDoc.save();

    await writeAudit(userId, 'robotrader_order_submitted', {
      decisionId: String(decisionDoc._id),
      orderId: pendingOrder.externalOrderId,
      clientOrderId: pendingOrder.clientOrderId,
      symbol: pendingOrder.symbol,
      status: pendingOrder.status,
      environment
    }, deps);
    return pendingOrder;
  } catch (err) {
    pendingOrder.status = 'rejected';
    pendingOrder.rejectedAt = now;
    pendingOrder.discrepancy = err?.message || 'Alpaca order submission failed.';
    await pendingOrder.save();

    decisionDoc.status = 'error';
    decisionDoc.error = err?.message || 'Alpaca order submission failed.';
    await decisionDoc.save();

    await writeAudit(userId, 'robotrader_order_rejected', {
      decisionId: String(decisionDoc._id),
      symbol: pendingOrder.symbol,
      reason: err?.message || 'Alpaca order submission failed.',
      environment
    }, deps);
    return pendingOrder;
  }
}

async function runRoboTraderForUser({ userId, modeOverride = null, runOnce = false, now = new Date() } = {}, deps = defaultDeps) {
  const settingsDoc = await deps.getOrCreateRoboTraderSettings(userId);
  const settings = deps.mapSettings(settingsDoc);
  const environment = modeOverride || settings.mode || 'paper';
  const runId = buildRunId(userId, now);

  if (!settings.isEnabled && !runOnce) {
    await writeAudit(userId, 'robotrader_disabled', {
      reason: 'RoboTrader is disabled.',
      runId,
      at: now.toISOString()
    }, deps);
    return { ok: false, skipped: true, reason: 'ROBOTRADER_DISABLED', runId };
  }

  const broker = deps.createAlpacaBroker({ mode: environment });
  let account = {};
  let positions = [];
  let openOrders = [];
  try {
    [account, positions, openOrders] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.listOrders({ status: 'open', limit: 100, nested: true })
    ]);
  } catch (err) {
    await writeAudit(userId, 'robotrader_broker_error', {
      runId,
      environment,
      reason: err?.message || 'Could not load Alpaca account context.'
    }, deps);
    throw err;
  }

  const normalizedPositions = (positions || []).map(normalizeAlpacaPosition);
  const normalizedOpenOrders = (openOrders || []).map(normalizeAlpacaOrder);
  const symbols = buildSymbolUniverse(settings);
  const researchItems = await deps.buildResearchBatch(symbols, {
    account,
    positions: normalizedPositions,
    openOrders: normalizedOpenOrders
  });
  const decisions = deps.evaluateResearchBatch(researchItems, settings);
  const recentOrders = await getRecentLocalOrders(userId, now, deps);
  const tradesToday = recentOrders.filter(order => {
    const status = String(order.status || '').toLowerCase();
    return !TERMINAL_ORDER_STATUSES.includes(status) || status === 'filled';
  }).length;
  const dailyPnl = toFiniteNumber(account.equity, 0) - toFiniteNumber(account.last_equity, toFiniteNumber(account.equity, 0));
  const savedDecisions = [];
  let submittedOrder = null;

  for (const decision of decisions) {
    const research = researchItems.find(item => item.symbol === decision.symbol) || {};
    const orderInput = decision.recommendedOrder
      ? buildOrderInputFromDecision(decision, settings)
      : {
          symbol: decision.symbol,
          assetClass: decision.assetClass,
          side: 'buy',
          orderType: 'market',
          timeInForce: decision.assetClass === 'crypto' ? 'gtc' : 'day',
          qty: 1,
          estimatedNotional: 0
        };

    const riskResult = deps.evaluateRoboRisk({
      settings,
      account,
      positions: normalizedPositions,
      openOrders: normalizedOpenOrders,
      recentOrders,
      tradesToday,
      dailyPnl,
      decision,
      orderInput,
      environment,
      now
    });

    const decisionDoc = await saveDecision({
      userId,
      environment,
      runId,
      research,
      decision,
      riskResult,
      orderInput,
      now,
      deps
    });
    if (decisionDoc) savedDecisions.push(decisionDoc);

    if (!riskResult.approved || submittedOrder || !decisionDoc || !decision.recommendedOrder) {
      if (decisionDoc && !riskResult.approved) {
        await writeAudit(userId, 'robotrader_trade_rejected', {
          runId,
          decisionId: String(decisionDoc._id),
          symbol: decision.symbol,
          reasons: riskResult.rejectionReasons,
          strategyId: decision.strategyId
        }, deps);
      }
      continue;
    }

    submittedOrder = await submitApprovedOrder({
      userId,
      environment,
      decisionDoc,
      orderInput,
      riskResult,
      broker,
      now,
      deps
    });
  }

  await deps.RoboSettings.updateOne(
    { userId },
    { $set: { lastRunAt: now, enabled: settings.isEnabled, isEnabled: settings.isEnabled } }
  );
  await writeAudit(userId, 'robotrader_worker_run', {
    runId,
    environment,
    symbolsEvaluated: researchItems.length,
    decisionsSaved: savedDecisions.length,
    submittedOrderId: submittedOrder?.externalOrderId || null,
    at: now.toISOString()
  }, deps);

  return {
    ok: true,
    runId,
    environment,
    decisionsSaved: savedDecisions.length,
    submittedOrder: submittedOrder || null
  };
}

async function runWorkerTick(deps = defaultDeps) {
  const enabledSettings = await deps.RoboSettings.find({
    $or: [{ isEnabled: true }, { enabled: true }]
  }).lean();
  const results = [];
  for (const settings of enabledSettings) {
    try {
      results.push(await runRoboTraderForUser({ userId: settings.userId }, deps));
    } catch (err) {
      await writeAudit(settings.userId, 'robotrader_worker_error', {
        reason: err?.message || 'Unknown RoboTrader worker error.'
      }, deps);
      results.push({ ok: false, userId: String(settings.userId), error: err?.message || 'Unknown error' });
    }
  }
  return { ok: true, usersChecked: enabledSettings.length, results };
}

async function emergencyStop({ userId, cancelOpenOrders = false, environment = 'paper' } = {}, deps = defaultDeps) {
  const settings = await deps.updateRoboTraderSettings(userId, {
    isEnabled: false,
    enabled: false,
    pausedReason: 'Emergency stop triggered.'
  });
  let canceled = [];
  let cancelError = null;
  if (cancelOpenOrders) {
    try {
      const broker = deps.createAlpacaBroker({ mode: environment });
      const openOrders = await broker.listOrders({ status: 'open', limit: 100 });
      for (const order of openOrders || []) {
        const clientOrderId = String(order.client_order_id || '');
        if (!clientOrderId.includes('robotrader') && !clientOrderId.includes('robo')) continue;
        await broker.cancelOrder(order.id);
        canceled.push(order.id);
      }
      await deps.RoboTradeOrder.updateMany(
        {
          userId,
          externalOrderId: { $in: canceled },
          status: { $nin: TERMINAL_ORDER_STATUSES }
        },
        { $set: { status: 'canceled', canceledAt: new Date(), reconciliationStatus: 'emergency_stop' } }
      );
    } catch (err) {
      cancelError = err?.message || 'Could not cancel open RoboTrader orders.';
    }
  }

  await writeAudit(userId, 'robotrader_emergency_stop', {
    cancelOpenOrders,
    canceledOrderIds: canceled,
    cancelError
  }, deps);

  return {
    settings: deps.mapSettings(settings),
    canceledOrderIds: canceled,
    cancelError
  };
}

const defaultDeps = {
  RoboSettings,
  RoboTradeDecision,
  RoboTradeOrder,
  RoboAuditLog,
  buildResearchBatch,
  createAlpacaBroker,
  evaluateResearchBatch,
  evaluateRoboRisk,
  getOrCreateRoboTraderSettings,
  mapSettings,
  updateRoboTraderSettings
};

module.exports = {
  buildDecisionIdempotencyKey,
  buildRunId,
  buildSymbolUniverse,
  emergencyStop,
  runRoboTraderForUser,
  runWorkerTick
};
