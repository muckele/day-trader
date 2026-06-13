const RoboSettings = require('../models/RoboSettings');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboLock = require('../models/RoboLock');
const User = require('../models/User');
const { getRecommendationUniverse } = require('../config/tradingConfig');
const { getAccountIdForUser } = require('../utils/accountScope');
const { isCryptoSymbol } = require('../services/marketData');
const { buildClientOrderId } = require('../services/alpacaTradingClient');
const {
  getOrCreateRoboTraderSettings,
  mapSettings,
  normalizeAssetClass,
  normalizeSymbol,
  updateRoboTraderSettings
} = require('./settingsService');
const { summarizeResearchSnapshot } = require('./researchSnapshotSummary');
const { buildResearchBatch } = require('./researchService');
const { evaluateResearchBatch } = require('./strategyEngine');
const { evaluateRoboRisk } = require('./riskGate');
const { createAlpacaBroker } = require('./alpacaBroker');
const { submitProtectiveStopForEntry } = require('./reconciliation');

const TERMINAL_ORDER_STATUSES = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_DECISION_STATUSES = ['approved', 'rejected', 'error', 'pending_manual_approval'];
const DEFAULT_DECISION_RETENTION_DAYS = 3;
const DEFAULT_AUDIT_LOG_RETENTION_DAYS = RoboAuditLog.DEFAULT_ROBO_AUDIT_LOG_RETENTION_DAYS || 7;

function resolveWorkerLockTtlMs(env = process.env) {
  const parsed = Number(env.ROBOTRADER_WORKER_LOCK_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 30 * 1000
    ? parsed
    : 10 * 60 * 1000;
}

const WORKER_LOCK_TTL_MS = resolveWorkerLockTtlMs();

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toFinitePositiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRetentionDays(value, fallback) {
  return Math.max(1, toFinitePositiveInt(value, fallback));
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

function getSubmitErrorStatus(err = {}) {
  const status = Number(err.status ?? err.response?.status ?? err.response?.statusCode);
  return Number.isFinite(status) ? status : null;
}

function getBrokerErrorPayload(err = {}) {
  const data = err.response?.data;
  if (data && typeof data === 'object') return data;
  if (typeof data === 'string' && data.trim()) return { message: data.trim() };
  return null;
}

function getBrokerErrorMessage(err = {}) {
  const payload = getBrokerErrorPayload(err);
  const message = payload?.message
    || payload?.error
    || payload?.error_message
    || payload?.detail
    || err.message
    || 'Alpaca order submission failed.';
  const status = getSubmitErrorStatus(err);
  return status && !String(message).includes(String(status))
    ? `Alpaca ${status}: ${message}`
    : String(message);
}

function buildBrokerErrorSnapshot(err = {}) {
  return {
    status: getSubmitErrorStatus(err),
    code: err.code || err.response?.data?.code || null,
    message: getBrokerErrorMessage(err),
    data: getBrokerErrorPayload(err)
  };
}

function isDuplicateClientOrderIdError(err = {}) {
  const message = String(
    err.response?.data?.message
    || err.response?.data?.error
    || err.message
    || ''
  ).toLowerCase();
  return /client[_\s-]?order[_\s-]?id/.test(message)
    && /(already|duplicate|exists|in use)/.test(message);
}

function isAmbiguousSubmitError(err = {}) {
  if (isDuplicateClientOrderIdError(err)) return true;
  const status = getSubmitErrorStatus(err);
  if (status !== null) return status === 408 || status >= 500;
  const code = String(err.code || '').toUpperCase();
  return !code || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code);
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

async function loadAssetMetadataForRisk(symbol, assetClass, broker) {
  if (normalizeAssetClass(assetClass) !== 'stocks' || typeof broker.getAsset !== 'function') {
    return { asset: null, assetLookupError: null };
  }
  try {
    const asset = await broker.getAsset(normalizeSymbol(symbol));
    return { asset: asset || null, assetLookupError: null };
  } catch (err) {
    return {
      asset: null,
      assetLookupError: getBrokerErrorMessage(err) || `Could not verify Alpaca asset metadata for ${normalizeSymbol(symbol)}.`
    };
  }
}

function normalizeOrderIdentifier(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function isRoboTraderClientOrderId(value) {
  const clientOrderId = String(value || '').toLowerCase();
  return clientOrderId.includes('robotrader') || clientOrderId.includes('robo');
}

function summarizeBrokerOrderForAudit(order = {}) {
  return {
    id: normalizeOrderIdentifier(order.id),
    clientOrderId: normalizeOrderIdentifier(order.client_order_id),
    symbol: normalizeSymbol(order.symbol),
    status: String(order.status || '').toLowerCase() || null
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

async function acquireWorkerLock(userId, owner, now = new Date(), deps = defaultDeps) {
  if (!deps.RoboLock?.findOneAndUpdate) return true;
  const lockedUntil = new Date(now.getTime() + WORKER_LOCK_TTL_MS);
  try {
    const lock = await deps.RoboLock.findOneAndUpdate(
      {
        userId,
        $or: [
          { lockedUntil: { $lte: now } },
          { lockedUntil: { $exists: false } }
        ]
      },
      {
        $set: {
          owner,
          lockedUntil
        }
      },
      {
        upsert: true,
        new: true
      }
    );
    return Boolean(lock);
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function releaseWorkerLock(userId, owner, deps = defaultDeps) {
  if (!deps.RoboLock?.updateOne) return;
  await deps.RoboLock.updateOne(
    { userId, owner },
    { $set: { lockedUntil: new Date(0) } }
  );
}

async function refreshWorkerLock(userId, owner, now = new Date(), deps = defaultDeps) {
  if (!deps.RoboLock?.updateOne) return;
  await deps.RoboLock.updateOne(
    { userId, owner },
    { $set: { lockedUntil: new Date(now.getTime() + WORKER_LOCK_TTL_MS) } }
  );
}

function startWorkerLockHeartbeat(userId, owner, deps = defaultDeps) {
  if (!deps.RoboLock?.updateOne) return () => {};
  const intervalMs = Math.max(15 * 1000, Math.floor(WORKER_LOCK_TTL_MS / 3));
  const timer = setInterval(() => {
    refreshWorkerLock(userId, owner, new Date(), deps).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function getNestedPrice(input, objectKey, fieldKey) {
  const camelKey = fieldKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = input?.[objectKey]?.[fieldKey] ?? input?.[objectKey]?.[camelKey];
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function extractRiskStopPrice(orderInput = {}) {
  const direct = Number(orderInput.riskStopPrice ?? orderInput.risk_stop_price);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const stopPrice = Number(orderInput.stopPrice ?? orderInput.stop_price);
  if (Number.isFinite(stopPrice) && stopPrice > 0) return stopPrice;
  return getNestedPrice(orderInput, orderInput.stop_loss ? 'stop_loss' : 'stopLoss', 'stop_price');
}

function roundOrderPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number(numeric.toFixed(numeric >= 1 ? 2 : 4));
}

function hasBrokerAttachedProtection(orderInput = {}) {
  const orderClass = String(orderInput.orderClass || orderInput.order_class || '').toLowerCase();
  return ['bracket', 'oco', 'oto'].includes(orderClass)
    || Boolean(
      orderInput.takeProfit
      || orderInput.take_profit
      || orderInput.stopLoss
      || orderInput.stop_loss
      || orderInput.stopPrice
      || orderInput.stop_price
      || orderInput.trailPrice
      || orderInput.trail_price
      || orderInput.trailPercent
      || orderInput.trail_percent
      || orderInput.riskStopPrice
      || orderInput.risk_stop_price
    );
}

function adaptOrderForMarketSession(orderInput = {}, {
  settings = {},
  marketClock = null,
  research = {}
} = {}) {
  const assetClass = normalizeAssetClass(orderInput.assetClass) || 'stocks';
  const marketOpen = marketClock ? Boolean(marketClock.is_open ?? marketClock.isOpen) : true;
  if (assetClass !== 'stocks' || marketOpen || settings.allowExtendedHours !== true) {
    return orderInput;
  }

  const referencePrice = Number(
    orderInput.limitPrice
    ?? orderInput.limit_price
    ?? research.price
    ?? research.quote?.price
  );
  const limitPrice = roundOrderPrice(orderInput.limitPrice ?? orderInput.limit_price)
    || roundOrderPrice(orderInput.side === 'sell' ? referencePrice * 0.995 : referencePrice * 1.005);
  if (!limitPrice) return orderInput;

  const timeInForce = ['day', 'gtc'].includes(String(orderInput.timeInForce || '').toLowerCase())
    ? String(orderInput.timeInForce).toLowerCase()
    : 'day';
  const requiresRegularSessionForProtection = hasBrokerAttachedProtection(orderInput);

  return {
    ...orderInput,
    orderType: 'limit',
    orderClass: 'simple',
    timeInForce,
    limitPrice,
    extendedHours: true,
    takeProfit: null,
    stopLoss: null,
    riskStopPrice: extractRiskStopPrice(orderInput),
    requiresRegularSessionForProtection,
    protectionBlockedReason: requiresRegularSessionForProtection
      ? 'Extended-hours automated stock entries are blocked because broker-attached stop-loss/take-profit protection is unavailable outside regular market hours.'
      : null
  };
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
    riskStopPrice: order.riskStopPrice || null,
    riskTakeProfitPrice: order.riskTakeProfitPrice || null,
    extendedHours: Boolean(settings.allowExtendedHours && order.extendedHours),
    estimatedNotional: order.estimatedNotional || order.notional || null,
    strategyId: decision.strategyId || order.strategyId || null
  };
}

function resolveDecisionStatus(riskResult = {}) {
  const rejectionReasons = riskResult.rejectionReasons || [];
  if (riskResult.approved) return 'approved';
  return rejectionReasons.includes('Trade requires manual approval above configured dollar amount.')
    ? 'pending_manual_approval'
    : 'rejected';
}

function buildDecisionPreview({
  decision,
  riskResult,
  orderInput,
  research,
  wouldSubmit = false
}) {
  return {
    symbol: decision.symbol,
    assetClass: normalizeAssetClass(decision.assetClass) || normalizeAssetClass(orderInput.assetClass) || 'stocks',
    action: decision.action || 'hold',
    status: resolveDecisionStatus(riskResult),
    wouldSubmit: Boolean(wouldSubmit),
    confidenceScore: decision.confidenceScore || 0,
    rewardRiskRatio: decision.rewardRiskRatio || null,
    strategyId: decision.strategyId || null,
    strategyName: decision.strategyName || null,
    reasoningSummary: decision.reasoningSummary || null,
    recommendedOrder: orderInput || {},
    riskChecks: riskResult.checks || [],
    rejectionReasons: riskResult.rejectionReasons || [],
    researchSummary: summarizeResearchSnapshot(research)
  };
}

async function getRecentLocalOrders(userId, environment, now, deps) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return deps.RoboTradeOrder.find({
    userId,
    environment,
    createdAt: { $gte: since }
  }).sort({ createdAt: -1 }).lean();
}

async function resolveAccountIdForUserId(userId, deps = defaultDeps) {
  if (typeof deps.resolveAccountIdForUserId === 'function') {
    return deps.resolveAccountIdForUserId(userId);
  }
  if (deps.User) {
    const query = deps.User.findById(userId);
    const user = typeof query?.lean === 'function' ? await query.lean() : await query;
    return user ? getAccountIdForUser(user) : null;
  }
  return getAccountIdForUser({ userId });
}

async function saveDecision({
  userId,
  accountId,
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
  const status = resolveDecisionStatus(riskResult);

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
      researchSnapshot: summarizeResearchSnapshot(research),
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

async function findCleanupDecisionCandidates(query, batchSize, deps) {
  const result = deps.RoboTradeDecision.find(query)
    .sort({ _id: 1 })
    .limit(batchSize)
    .select('_id');
  return typeof result?.lean === 'function' ? result.lean() : result;
}

async function cleanupRoboTradeDecisions({
  olderThanDays,
  now = new Date(),
  batchSize,
  maxScan
} = {}, deps = defaultDeps) {
  const retentionDays = normalizeRetentionDays(
    olderThanDays ?? process.env.ROBOTRADER_DECISION_RETENTION_DAYS,
    DEFAULT_DECISION_RETENTION_DAYS
  );
  const cleanupBatchSize = Math.min(
    5000,
    toFinitePositiveInt(batchSize ?? process.env.ROBOTRADER_DECISION_CLEANUP_BATCH_SIZE, 1000)
  );
  const scanLimit = Math.max(
    cleanupBatchSize,
    toFinitePositiveInt(maxScan ?? process.env.ROBOTRADER_DECISION_CLEANUP_MAX_SCAN, cleanupBatchSize * 100)
  );
  const cutoff = new Date(now.getTime() - (retentionDays * DAY_MS));
  let scannedCount = 0;
  let deletedCount = 0;
  let preservedLinkedCount = 0;
  let lastId = null;

  while (scannedCount < scanLimit) {
    const query = {
      status: { $in: CLEANUP_DECISION_STATUSES },
      decidedAt: { $lt: cutoff }
    };
    if (lastId) query._id = { $gt: lastId };

    const remainingScan = scanLimit - scannedCount;
    const candidates = await findCleanupDecisionCandidates(
      query,
      Math.min(cleanupBatchSize, remainingScan),
      deps
    );
    if (!Array.isArray(candidates) || candidates.length === 0) break;

    scannedCount += candidates.length;
    lastId = candidates[candidates.length - 1]._id;
    const candidateIds = candidates.map(item => item._id).filter(Boolean);
    if (!candidateIds.length) continue;

    const linkedIds = deps.RoboTradeOrder?.distinct
      ? await deps.RoboTradeOrder.distinct('decisionId', { decisionId: { $in: candidateIds } })
      : [];
    const linkedSet = new Set((linkedIds || []).map(String));
    const deletableIds = candidateIds.filter(id => !linkedSet.has(String(id)));
    preservedLinkedCount += candidateIds.length - deletableIds.length;
    if (!deletableIds.length) continue;

    const result = await deps.RoboTradeDecision.deleteMany({ _id: { $in: deletableIds } });
    deletedCount += Number(result?.deletedCount || 0);
  }

  return {
    retentionDays,
    cutoff,
    scannedCount,
    deletedCount,
    preservedLinkedCount
  };
}

async function cleanupRoboAuditLogs({
  olderThanDays,
  now = new Date()
} = {}, deps = defaultDeps) {
  const retentionDays = normalizeRetentionDays(
    olderThanDays ?? process.env.ROBOTRADER_AUDIT_LOG_RETENTION_DAYS,
    DEFAULT_AUDIT_LOG_RETENTION_DAYS
  );
  const cutoff = new Date(now.getTime() - (retentionDays * DAY_MS));
  const result = await deps.RoboAuditLog.deleteMany({ createdAt: { $lt: cutoff } });
  return {
    retentionDays,
    cutoff,
    deletedCount: Number(result?.deletedCount || 0)
  };
}

async function submitApprovedOrder({
  userId,
  accountId,
  environment,
  decisionDoc,
  orderInput,
  riskResult,
  broker,
  now,
  deps
}) {
  const clientOrderId = orderInput.clientOrderId || orderInput.client_order_id || deps.buildClientOrderId({
    origin: 'robotrader',
    symbol: orderInput.symbol,
    now
  });
  const pendingOrder = await deps.RoboTradeOrder.create({
    userId,
    accountId,
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
    riskStopPrice: orderInput.riskStopPrice,
    riskTakeProfitPrice: orderInput.riskTakeProfitPrice,
    clientOrderId,
    status: 'pending_submit',
    reasoningSummary: decisionDoc.reasoningSummary,
    strategyId: decisionDoc.strategyId,
    riskChecks: riskResult.checks || []
  });

  try {
    const result = await broker.submitOrder({
      ...orderInput,
      clientOrderId: pendingOrder.clientOrderId
    });
    const order = result.order || {};
    pendingOrder.externalOrderId = order.id || null;
    pendingOrder.clientOrderId = order.client_order_id || result.payload?.client_order_id || pendingOrder.clientOrderId;
    pendingOrder.status = order.status || 'submitted';
    pendingOrder.rawPayload = result.payload || {};
    pendingOrder.alpacaResponse = order;
    pendingOrder.submittedAt = order.submitted_at || now;
    pendingOrder.filledQty = toFiniteNumber(order.filled_qty, null);
    pendingOrder.filledAvgPrice = toFiniteNumber(order.filled_avg_price, null);
    pendingOrder.filledAt = order.filled_at || null;
    await pendingOrder.save();
    if (String(pendingOrder.status || '').toLowerCase() === 'filled' && typeof deps.submitProtectiveStopForEntry === 'function') {
      try {
        const positions = typeof broker.getPositions === 'function'
          ? await broker.getPositions()
          : [];
        await deps.submitProtectiveStopForEntry(pendingOrder, { broker, positions, now }, deps);
      } catch (err) {
        await writeAudit(userId, 'robotrader_protective_stop_error', {
          decisionId: String(decisionDoc._id),
          parentOrderId: String(pendingOrder._id),
          clientOrderId: pendingOrder.clientOrderId,
          symbol: pendingOrder.symbol,
          reason: err?.message || 'Could not create protective stop after immediate fill.',
          environment
        }, deps);
      }
    }

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
    const ambiguousSubmit = deps.isAmbiguousSubmitError(err);
    const brokerError = buildBrokerErrorSnapshot(err);
    const brokerErrorMessage = brokerError.message || 'Alpaca order submission failed.';
    pendingOrder.status = ambiguousSubmit ? 'pending_submit' : 'rejected';
    pendingOrder.reconciliationStatus = ambiguousSubmit
      ? 'submit_error_pending_reconciliation'
      : 'submit_rejected';
    if (!ambiguousSubmit) pendingOrder.rejectedAt = now;
    pendingOrder.discrepancy = brokerErrorMessage;
    pendingOrder.rawPayload = err.alpacaPayload || {};
    pendingOrder.alpacaResponse = brokerError;
    await pendingOrder.save();

    decisionDoc.status = ambiguousSubmit ? 'error' : 'rejected';
    decisionDoc.error = brokerErrorMessage;
    decisionDoc.alpacaResponse = brokerError;
    await decisionDoc.save();

    await writeAudit(userId, ambiguousSubmit ? 'robotrader_order_submit_uncertain' : 'robotrader_order_rejected', {
      decisionId: String(decisionDoc._id),
      clientOrderId: pendingOrder.clientOrderId,
      symbol: pendingOrder.symbol,
      reason: brokerErrorMessage,
      status: brokerError.status,
      brokerError,
      ambiguousSubmit,
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
  const accountId = await resolveAccountIdForUserId(userId, deps);

  if (!accountId) {
    await writeAudit(userId, 'robotrader_user_not_found', {
      reason: 'RoboTrader settings exist but the owning user could not be found.',
      runId,
      at: now.toISOString()
    }, deps);
    return { ok: false, skipped: true, reason: 'USER_NOT_FOUND', runId };
  }

  if (environment === 'live' && (settings.mode !== 'live' || !settings.liveTradingExplicitlyEnabled)) {
    await writeAudit(userId, 'robotrader_live_blocked', {
      reason: 'Live trading requires explicit user opt-in before broker access or order submission.',
      runId,
      at: now.toISOString()
    }, deps);
    return { ok: false, skipped: true, reason: 'LIVE_TRADING_NOT_ENABLED', runId };
  }

  if (!settings.isEnabled && !runOnce) {
    await writeAudit(userId, 'robotrader_disabled', {
      reason: 'RoboTrader is disabled.',
      runId,
      at: now.toISOString()
    }, deps);
    return { ok: false, skipped: true, reason: 'ROBOTRADER_DISABLED', runId };
  }

  const lockOwner = runId;
  const lockAcquired = typeof deps.acquireWorkerLock === 'function'
    ? await deps.acquireWorkerLock(userId, lockOwner, now, deps)
    : await acquireWorkerLock(userId, lockOwner, now, deps);
  if (!lockAcquired) {
    await writeAudit(userId, 'robotrader_worker_locked', {
      reason: 'Another RoboTrader worker run is already active for this user.',
      runId,
      at: now.toISOString()
    }, deps);
    return { ok: false, skipped: true, reason: 'ROBOTRADER_LOCKED', runId };
  }

  const stopLockHeartbeat = typeof deps.startWorkerLockHeartbeat === 'function'
    ? deps.startWorkerLockHeartbeat(userId, lockOwner, deps)
    : startWorkerLockHeartbeat(userId, lockOwner, deps);
  try {
  const broker = deps.createAlpacaBroker({ mode: environment });
  let account = {};
  let positions = [];
  let openOrders = [];
  let marketClock = null;
  try {
    [account, positions, openOrders, marketClock] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.listOrders({ status: 'open', limit: 100, nested: true }),
      typeof broker.getClock === 'function' ? broker.getClock() : Promise.resolve(null)
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
  const recentOrders = await getRecentLocalOrders(userId, environment, now, deps);
  const tradesToday = recentOrders.filter(order => {
    const status = String(order.status || '').toLowerCase();
    return !TERMINAL_ORDER_STATUSES.includes(status) || status === 'filled';
  }).length;
  const dailyPnl = toFiniteNumber(account.equity, 0) - toFiniteNumber(account.last_equity, toFiniteNumber(account.equity, 0));
  const savedDecisions = [];
  let submittedOrder = null;

  for (const decision of decisions) {
    const research = researchItems.find(item => item.symbol === decision.symbol) || {};
    const baseOrderInput = decision.recommendedOrder
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
    const orderInput = adaptOrderForMarketSession(baseOrderInput, {
      settings,
      marketClock,
      research
    });
    const assetContext = await loadAssetMetadataForRisk(
      orderInput.symbol || decision.symbol,
      orderInput.assetClass || decision.assetClass,
      broker
    );

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
      asset: assetContext.asset,
      assetLookupError: assetContext.assetLookupError,
      environment,
      marketClock,
      now
    });

    const decisionDoc = await saveDecision({
      userId,
      accountId,
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
      accountId,
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
  } finally {
    stopLockHeartbeat();
    try {
      const release = typeof deps.releaseWorkerLock === 'function'
        ? deps.releaseWorkerLock
        : releaseWorkerLock;
      await release(userId, lockOwner, deps);
    } catch (err) {
      await writeAudit(userId, 'robotrader_worker_lock_release_error', {
        runId,
        reason: err?.message || 'Could not release RoboTrader worker lock.'
      }, deps).catch(() => {});
    }
  }
}

async function previewRoboTraderForUser({
  userId,
  settingsOverride = null,
  modeOverride = 'paper',
  now = new Date()
} = {}, deps = defaultDeps) {
  const settingsDoc = settingsOverride || await deps.getOrCreateRoboTraderSettings(userId);
  const settings = deps.mapSettings(settingsDoc);
  const environment = modeOverride === 'live' ? 'live' : 'paper';
  const runId = buildRunId(userId, now);

  if (environment === 'live') {
    return {
      ok: false,
      skipped: true,
      reason: 'PREVIEW_PAPER_ONLY',
      runId,
      environment
    };
  }

  const broker = deps.createAlpacaBroker({ mode: environment });
  let account = {};
  let positions = [];
  let openOrders = [];
  let marketClock = null;
  try {
    [account, positions, openOrders, marketClock] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.listOrders({ status: 'open', limit: 100, nested: true }),
      typeof broker.getClock === 'function' ? broker.getClock() : Promise.resolve(null)
    ]);
  } catch (err) {
    await writeAudit(userId, 'robotrader_preview_broker_error', {
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
  const recentOrders = await getRecentLocalOrders(userId, environment, now, deps);
  const tradesToday = recentOrders.filter(order => {
    const status = String(order.status || '').toLowerCase();
    return !TERMINAL_ORDER_STATUSES.includes(status) || status === 'filled';
  }).length;
  const dailyPnl = toFiniteNumber(account.equity, 0) - toFiniteNumber(account.last_equity, toFiniteNumber(account.equity, 0));

  const previews = [];
  let firstSubmittableDecisionSeen = false;
  for (const decision of decisions) {
    const research = researchItems.find(item => item.symbol === decision.symbol) || {};
    const baseOrderInput = decision.recommendedOrder
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
    const orderInput = adaptOrderForMarketSession(baseOrderInput, {
      settings,
      marketClock,
      research
    });
    const assetContext = await loadAssetMetadataForRisk(
      orderInput.symbol || decision.symbol,
      orderInput.assetClass || decision.assetClass,
      broker
    );
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
      asset: assetContext.asset,
      assetLookupError: assetContext.assetLookupError,
      environment,
      marketClock,
      now
    });
    const wouldSubmit = Boolean(riskResult.approved && decision.recommendedOrder && !firstSubmittableDecisionSeen);
    if (wouldSubmit) firstSubmittableDecisionSeen = true;
    previews.push(buildDecisionPreview({
      decision,
      riskResult,
      orderInput,
      research,
      wouldSubmit
    }));
  }

  await writeAudit(userId, 'robotrader_preview_run', {
    runId,
    environment,
    symbolsEvaluated: researchItems.length,
    approvedCandidates: previews.filter(item => item.status === 'approved').length,
    wouldSubmitCount: previews.filter(item => item.wouldSubmit).length,
    at: now.toISOString()
  }, deps);

  return {
    ok: true,
    runId,
    environment,
    generatedAt: now.toISOString(),
    settingsSnapshot: {
      isEnabled: settings.isEnabled,
      mode: settings.mode,
      riskLevel: settings.riskLevel,
      allowedAssetClasses: settings.allowedAssetClasses,
      allowedSymbols: settings.allowedSymbols,
      blockedSymbols: settings.blockedSymbols,
      maxTradeAmount: settings.maxTradeAmount,
      maxPositionSize: settings.maxPositionSize,
      maxDailyLoss: settings.maxDailyLoss,
      maxOpenPositions: settings.maxOpenPositions,
      maxTradesPerDay: settings.maxTradesPerDay
    },
    accountSummary: {
      status: account.status || null,
      buyingPower: account.buying_power ?? account.buyingPower ?? null,
      equity: account.equity ?? null,
      tradingBlocked: Boolean(account.trading_blocked || account.account_blocked)
    },
    marketClock,
    symbolsEvaluated: researchItems.length,
    openOrderCount: normalizedOpenOrders.length,
    positionCount: normalizedPositions.length,
    decisions: previews
  };
}

async function runWorkerTick(deps = defaultDeps) {
  const query = deps.RoboSettings.find({
    $or: [{ isEnabled: true }, { enabled: true }]
  });
  const enabledSettings = typeof query?.sort === 'function'
    ? await query.sort({ isEnabled: -1, enabled: -1, updatedAt: -1, createdAt: -1 }).lean()
    : await query;
  const settingsByUser = new Map();
  for (const settings of (Array.isArray(enabledSettings) ? enabledSettings : [])) {
    const userId = String(settings.userId || '');
    if (!userId || settingsByUser.has(userId)) continue;
    settingsByUser.set(userId, settings);
  }
  const results = [];
  for (const settings of settingsByUser.values()) {
    try {
      results.push(await runRoboTraderForUser({ userId: settings.userId }, deps));
    } catch (err) {
      await writeAudit(settings.userId, 'robotrader_worker_error', {
        reason: err?.message || 'Unknown RoboTrader worker error.'
      }, deps);
      results.push({ ok: false, userId: String(settings.userId), error: err?.message || 'Unknown error' });
    }
  }
  return {
    ok: true,
    usersChecked: settingsByUser.size,
    settingsMatched: Array.isArray(enabledSettings) ? enabledSettings.length : 0,
    results
  };
}

async function emergencyStop({ userId, cancelOpenOrders = false, environment = 'paper' } = {}, deps = defaultDeps) {
  const settings = await deps.updateRoboTraderSettings(userId, {
    isEnabled: false,
    enabled: false,
    pausedReason: 'Emergency stop triggered.'
  });
  let canceled = [];
  let cancelErrors = [];
  let unownedBrokerOrders = [];
  let cancelError = null;
  if (cancelOpenOrders) {
    try {
      const broker = deps.createAlpacaBroker({ mode: environment });
      let localOpenOrdersQuery = deps.RoboTradeOrder.find({
        userId,
        environment,
        broker: 'alpaca',
        status: { $nin: TERMINAL_ORDER_STATUSES },
        $or: [
          { externalOrderId: { $exists: true, $nin: [null, ''] } },
          { clientOrderId: { $exists: true, $nin: [null, ''] } }
        ]
      });
      if (typeof localOpenOrdersQuery?.sort === 'function') {
        localOpenOrdersQuery = localOpenOrdersQuery.sort({ submittedAt: -1, createdAt: -1 });
      }
      if (typeof localOpenOrdersQuery?.lean === 'function') {
        localOpenOrdersQuery = localOpenOrdersQuery.lean();
      }
      const localOpenOrders = await localOpenOrdersQuery;
      const localOrdersByExternalId = new Map();
      const localOrdersByClientOrderId = new Map();
      for (const order of Array.isArray(localOpenOrders) ? localOpenOrders : []) {
        const externalOrderId = normalizeOrderIdentifier(order.externalOrderId);
        const clientOrderId = normalizeOrderIdentifier(order.clientOrderId);
        if (externalOrderId) localOrdersByExternalId.set(externalOrderId, order);
        if (clientOrderId) localOrdersByClientOrderId.set(clientOrderId, order);
      }

      const openOrders = await broker.listOrders({ status: 'open', limit: 500 });
      const canceledExternalOrderIds = [];
      const canceledClientOrderIds = [];
      for (const order of openOrders || []) {
        const externalOrderId = normalizeOrderIdentifier(order.id);
        const clientOrderId = normalizeOrderIdentifier(order.client_order_id);
        const localOrder = (externalOrderId && localOrdersByExternalId.get(externalOrderId))
          || (clientOrderId && localOrdersByClientOrderId.get(clientOrderId));
        if (!localOrder) {
          if (isRoboTraderClientOrderId(clientOrderId)) {
            unownedBrokerOrders.push(summarizeBrokerOrderForAudit(order));
          }
          continue;
        }

        const cancelTarget = externalOrderId || normalizeOrderIdentifier(localOrder.externalOrderId);
        if (!cancelTarget) continue;
        try {
          await broker.cancelOrder(cancelTarget);
          canceled.push(cancelTarget);
          if (externalOrderId) canceledExternalOrderIds.push(externalOrderId);
          if (clientOrderId) canceledClientOrderIds.push(clientOrderId);
        } catch (err) {
          cancelErrors.push({
            id: cancelTarget,
            clientOrderId,
            message: err?.message || 'Could not cancel order.'
          });
        }
      }

      if (unownedBrokerOrders.length) {
        await writeAudit(userId, 'robotrader_emergency_stop_unowned_broker_orders', {
          environment,
          orders: unownedBrokerOrders
        }, deps);
      }

      const updateMatches = [];
      if (canceledExternalOrderIds.length) {
        updateMatches.push({ externalOrderId: { $in: canceledExternalOrderIds } });
      }
      if (canceledClientOrderIds.length) {
        updateMatches.push({ clientOrderId: { $in: canceledClientOrderIds } });
      }
      if (updateMatches.length) {
        await deps.RoboTradeOrder.updateMany(
          {
            userId,
            environment,
            broker: 'alpaca',
            status: { $nin: TERMINAL_ORDER_STATUSES },
            $or: updateMatches
          },
          { $set: { status: 'canceled', canceledAt: new Date(), reconciliationStatus: 'emergency_stop' } }
        );
      }
      if (cancelErrors.length) {
        cancelError = cancelErrors.map(item => item.message).join('; ');
      }
    } catch (err) {
      cancelError = err?.message || 'Could not cancel open RoboTrader orders.';
    }
  }

  await writeAudit(userId, 'robotrader_emergency_stop', {
    cancelOpenOrders,
    canceledOrderIds: canceled,
    unownedBrokerOrders,
    cancelErrors,
    cancelError
  }, deps);

  return {
    settings: deps.mapSettings(settings),
    canceledOrderIds: canceled,
    unownedBrokerOrders,
    cancelErrors,
    cancelError
  };
}

const defaultDeps = {
  RoboSettings,
  RoboTradeDecision,
  RoboTradeOrder,
  RoboAuditLog,
  RoboLock,
  User,
  acquireWorkerLock,
  adaptOrderForMarketSession,
  buildResearchBatch,
  buildClientOrderId,
  createAlpacaBroker,
  evaluateResearchBatch,
  evaluateRoboRisk,
  isAmbiguousSubmitError,
  submitProtectiveStopForEntry,
  getOrCreateRoboTraderSettings,
  mapSettings,
  refreshWorkerLock,
  releaseWorkerLock,
  startWorkerLockHeartbeat,
  updateRoboTraderSettings
};

module.exports = {
  buildDecisionIdempotencyKey,
  buildRunId,
  buildSymbolUniverse,
  cleanupRoboAuditLogs,
  cleanupRoboTradeDecisions,
  getSubmitErrorStatus,
  isAmbiguousSubmitError,
  acquireWorkerLock,
  adaptOrderForMarketSession,
  emergencyStop,
  refreshWorkerLock,
  releaseWorkerLock,
  resolveWorkerLockTtlMs,
  startWorkerLockHeartbeat,
  previewRoboTraderForUser,
  runRoboTraderForUser,
  runWorkerTick
};
