const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const OrderIntent = require('../models/OrderIntent');
const { createAlpacaBroker } = require('./alpacaBroker');
const { buildClientOrderId } = require('../services/alpacaTradingClient');
const { normalizeSymbol } = require('./settingsService');
const { recordControlledLiveOutcome } = require('../services/controlledLiveActivationService');

const OPEN_STATUSES = ['pending_submit', 'accepted', 'new', 'pending_new', 'partially_filled', 'submitted'];
const PROTECTIVE_STOP_RETRY_STATUSES = ['canceled', 'cancelled', 'expired'];

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function mapAlpacaOrder(order = {}) {
  return {
    externalOrderId: order.id || null,
    clientOrderId: order.client_order_id || null,
    status: order.status || null,
    filledQty: toFiniteNumber(order.filled_qty, null),
    filledAvgPrice: toFiniteNumber(order.filled_avg_price, null),
    filledAt: order.filled_at || null,
    canceledAt: order.canceled_at || order.cancelled_at || null,
    rejectedAt: order.rejected_at || null,
    submittedAt: order.submitted_at || null,
    alpacaResponse: order
  };
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

function isPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function isProtectiveStopCandidate(order = {}) {
  return String(order.assetClass || '').toLowerCase() === 'stocks'
    && String(order.side || '').toLowerCase() === 'buy'
    && String(order.orderClass || 'simple').toLowerCase() === 'simple'
    && String(order.status || '').toLowerCase() === 'filled'
    && !order.exitReason
    && isPositiveNumber(order.riskStopPrice)
    && isPositiveNumber(order.filledQty ?? order.qty);
}

function getPositionQty(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  return toFiniteNumber(position?.qty, 0) || 0;
}

function buildPositionAvailabilityBySymbol(positions = [], existingStops = []) {
  const availability = new Map();
  for (const position of positions || []) {
    const symbol = normalizeSymbol(position.symbol);
    if (!symbol) continue;
    availability.set(symbol, Math.max(0, toFiniteNumber(position.qty, 0) || 0));
  }
  for (const stop of existingStops || []) {
    if (String(stop.exitReason || '') !== 'stop_loss') continue;
    if (String(stop.side || '').toLowerCase() !== 'sell') continue;
    const symbol = normalizeSymbol(stop.symbol);
    if (!symbol) continue;
    const remaining = Math.max(0, (availability.get(symbol) || 0) - (toFiniteNumber(stop.qty, 0) || 0));
    availability.set(symbol, remaining);
  }
  return availability;
}

async function readMaybeLean(queryOrValue) {
  if (queryOrValue && typeof queryOrValue.lean === 'function') {
    return queryOrValue.lean();
  }
  return queryOrValue;
}

async function writeAudit(userId, eventType, payload, deps) {
  if (!userId) return null;
  return deps.RoboAuditLog.create({ userId, eventType, payload: payload || {} });
}

async function recordCanaryOutcome(localOrder, status, details, deps) {
  if (!localOrder?.liveActivationId || typeof deps.recordControlledLiveOutcome !== 'function') return null;
  try {
    return await deps.recordControlledLiveOutcome({
      activationId: localOrder.liveActivationId,
      liveOrderId: localOrder._id,
      status,
      details,
      now: new Date()
    }, deps);
  } catch (_err) {
    return null;
  }
}

function mapBrokerLifecycle(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'filled') return { intentStatus: 'filled', decisionStatus: 'filled' };
  if (['canceled', 'cancelled', 'expired'].includes(normalized)) {
    return { intentStatus: 'cancelled', decisionStatus: 'cancelled' };
  }
  if (normalized === 'rejected') return { intentStatus: 'rejected', decisionStatus: 'rejected' };
  return { intentStatus: 'submitted', decisionStatus: 'submitted' };
}

async function applyAlpacaOrder(localOrder, alpacaOrder, deps) {
  const mapped = mapAlpacaOrder(alpacaOrder);
  Object.assign(localOrder, mapped, {
    reconciliationStatus: 'matched',
    discrepancy: null,
    lastReconciledAt: new Date()
  });
  await localOrder.save();
  const brokerStatus = String(localOrder.status || '').toLowerCase();
  const canaryOutcomeStatus = brokerStatus === 'filled'
    ? 'reconciled'
    : (brokerStatus === 'rejected'
        ? 'rejected'
        : (['canceled', 'cancelled', 'expired'].includes(brokerStatus) ? 'reconciled' : 'broker_pending'));
  await recordCanaryOutcome(
    localOrder,
    canaryOutcomeStatus,
    { brokerStatus: localOrder.status, reconciliationStatus: localOrder.reconciliationStatus },
    deps
  );
  if (localOrder.intentId) {
    const lifecycle = mapBrokerLifecycle(localOrder.status);
    const lifecycleUpdates = [];
    if (deps.OrderIntent?.updateOne) {
      lifecycleUpdates.push(deps.OrderIntent.updateOne(
        { _id: localOrder.intentId, userId: localOrder.userId },
        {
          $set: {
            status: lifecycle.intentStatus,
            roboTradeOrderId: localOrder._id,
            rejectionReason: lifecycle.intentStatus === 'rejected'
              ? (localOrder.discrepancy || 'Broker rejected the order.')
              : null
          }
        }
      ));
    }
    if (localOrder.decisionId && deps.RoboTradeDecision?.updateOne) {
      lifecycleUpdates.push(deps.RoboTradeDecision.updateOne(
        { _id: localOrder.decisionId, userId: localOrder.userId },
        {
          $set: {
            status: lifecycle.decisionStatus,
            alpacaResponse: alpacaOrder,
            error: lifecycle.decisionStatus === 'rejected'
              ? (localOrder.discrepancy || 'Broker rejected the order.')
              : null
          }
        }
      ));
    }
    await Promise.all(lifecycleUpdates);
  }
  await writeAudit(localOrder.userId, 'robotrader_order_status_changed', {
    orderId: localOrder.externalOrderId,
    clientOrderId: localOrder.clientOrderId,
    status: localOrder.status
  }, deps);
}

function buildProtectiveStopParentQuery(parentOrder) {
  const parentMatches = [];
  if (parentOrder._id) parentMatches.push({ parentOrderId: parentOrder._id });
  if (parentOrder.clientOrderId) parentMatches.push({ parentClientOrderId: parentOrder.clientOrderId });
  if (!parentMatches.length) return null;
  return {
    environment: parentOrder.environment,
    exitReason: 'stop_loss',
    status: { $nin: PROTECTIVE_STOP_RETRY_STATUSES },
    $or: parentMatches
  };
}

async function findExistingProtectiveStop(parentOrder, deps) {
  const query = buildProtectiveStopParentQuery(parentOrder);
  if (!query) return null;
  return readMaybeLean(deps.RoboTradeOrder.findOne(query));
}

async function hasExistingProtectiveStop(parentOrder, deps) {
  const existing = await findExistingProtectiveStop(parentOrder, deps);
  return Boolean(existing);
}

async function submitProtectiveStopForEntry(parentOrder, {
  broker,
  positions = [],
  now = new Date()
}, deps) {
  if (!isProtectiveStopCandidate(parentOrder)) return null;
  if (await hasExistingProtectiveStop(parentOrder, deps)) return null;

  const currentPositionQty = getPositionQty(parentOrder.symbol, positions);
  const filledQty = toFiniteNumber(parentOrder.filledQty ?? parentOrder.qty, 0) || 0;
  const closeQty = Math.min(Math.max(0, currentPositionQty), filledQty);
  if (!isPositiveNumber(closeQty)) {
    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_skipped', {
      parentOrderId: String(parentOrder._id),
      clientOrderId: parentOrder.clientOrderId,
      symbol: parentOrder.symbol,
      reason: 'No positive long position was available for a protective stop order.'
    }, deps);
    return null;
  }

  const clientOrderId = deps.buildClientOrderId({
    origin: 'robotrader-stop',
    symbol: parentOrder.symbol,
    now
  });
  const stopInput = {
    symbol: parentOrder.symbol,
    assetClass: 'stocks',
    side: 'sell',
    orderType: 'stop',
    orderClass: 'simple',
    timeInForce: 'day',
    qty: closeQty,
    stopPrice: parentOrder.riskStopPrice,
    clientOrderId
  };
  let stopOrder = null;
  try {
    stopOrder = await deps.RoboTradeOrder.create({
      userId: parentOrder.userId,
      accountId: parentOrder.accountId || 'default',
      decisionId: parentOrder.decisionId || null,
      environment: parentOrder.environment,
      broker: 'alpaca',
      parentOrderId: parentOrder._id,
      parentClientOrderId: parentOrder.clientOrderId || null,
      exitReason: 'stop_loss',
      symbol: normalizeSymbol(parentOrder.symbol),
      assetClass: 'stocks',
      side: 'sell',
      orderType: 'stop',
      orderClass: 'simple',
      timeInForce: 'day',
      qty: closeQty,
      stopPrice: parentOrder.riskStopPrice,
      clientOrderId,
      status: 'pending_submit',
      reasoningSummary: 'Protective stop generated for a filled RoboTrader simple/fractional stock entry.',
      strategyId: parentOrder.strategyId || null,
      riskChecks: parentOrder.riskChecks || []
    });
  } catch (err) {
    if (err?.code === 11000) {
      return findExistingProtectiveStop(parentOrder, deps);
    }
    throw err;
  }

  try {
    const result = await broker.submitOrder(stopInput);
    const alpacaOrder = result.order || {};
    stopOrder.externalOrderId = alpacaOrder.id || null;
    stopOrder.clientOrderId = alpacaOrder.client_order_id || result.payload?.client_order_id || stopOrder.clientOrderId;
    stopOrder.status = alpacaOrder.status || 'submitted';
    stopOrder.rawPayload = result.payload || {};
    stopOrder.alpacaResponse = alpacaOrder;
    stopOrder.submittedAt = alpacaOrder.submitted_at || now;
    stopOrder.reconciliationStatus = 'matched';
    stopOrder.discrepancy = null;
    stopOrder.lastReconciledAt = now;
    await stopOrder.save();

    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_submitted', {
      parentOrderId: String(parentOrder._id),
      parentClientOrderId: parentOrder.clientOrderId || null,
      orderId: stopOrder.externalOrderId,
      clientOrderId: stopOrder.clientOrderId,
      symbol: stopOrder.symbol,
      qty: stopOrder.qty,
      stopPrice: stopOrder.stopPrice,
      environment: stopOrder.environment
    }, deps);
    return stopOrder;
  } catch (err) {
    const reason = getBrokerErrorMessage(err);
    stopOrder.status = 'rejected';
    stopOrder.reconciliationStatus = 'submit_rejected';
    stopOrder.rejectedAt = now;
    stopOrder.discrepancy = reason;
    stopOrder.rawPayload = err.alpacaPayload || {};
    stopOrder.alpacaResponse = {
      status: getSubmitErrorStatus(err),
      data: getBrokerErrorPayload(err),
      message: reason
    };
    await stopOrder.save();

    await writeAudit(parentOrder.userId, 'robotrader_protective_stop_rejected', {
      parentOrderId: String(parentOrder._id),
      parentClientOrderId: parentOrder.clientOrderId || null,
      clientOrderId: stopOrder.clientOrderId,
      symbol: stopOrder.symbol,
      reason,
      environment: stopOrder.environment
    }, deps);
    return stopOrder;
  }
}

async function submitMissingProtectiveStops({
  mode,
  userId,
  accountId,
  limit,
  broker,
  now = new Date()
}, deps) {
  const query = {
    environment: mode,
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    riskStopPrice: { $gt: 0 },
    $or: [
      { exitReason: null },
      { exitReason: { $exists: false } }
    ]
  };
  if (userId) query.userId = userId;
  if (accountId) query.accountId = accountId;

  const candidates = await deps.RoboTradeOrder.find(query)
    .sort({ filledAt: -1, updatedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const eligible = (candidates || []).filter(isProtectiveStopCandidate);
  if (!eligible.length) return [];

  const positions = typeof broker.getPositions === 'function'
    ? await broker.getPositions()
    : [];
  const existingStopQuery = {
    environment: mode,
    assetClass: 'stocks',
    side: 'sell',
    exitReason: 'stop_loss',
    status: { $in: OPEN_STATUSES }
  };
  if (userId) existingStopQuery.userId = userId;
  if (accountId) existingStopQuery.accountId = accountId;
  const existingStops = await deps.RoboTradeOrder.find(existingStopQuery)
    .sort({ submittedAt: -1, createdAt: -1 })
    .limit(500);
  const availableQtyBySymbol = buildPositionAvailabilityBySymbol(positions, existingStops);
  const submitted = [];
  for (const order of eligible) {
    const symbol = normalizeSymbol(order.symbol);
    const availableQty = availableQtyBySymbol.get(symbol) || 0;
    const protectiveStop = await submitProtectiveStopForEntry(order, {
      broker,
      positions: [{ symbol, qty: availableQty }],
      now
    }, deps);
    if (protectiveStop) {
      submitted.push(protectiveStop);
      if (String(protectiveStop.status || '').toLowerCase() !== 'rejected') {
        availableQtyBySymbol.set(symbol, Math.max(0, availableQty - (toFiniteNumber(protectiveStop.qty, 0) || 0)));
      }
    }
  }
  return submitted;
}

async function loadAlpacaOrderForLocal(localOrder, broker) {
  if (localOrder.externalOrderId) {
    return broker.getOrder(localOrder.externalOrderId);
  }
  if (localOrder.clientOrderId && typeof broker.getOrderByClientOrderId === 'function') {
    return broker.getOrderByClientOrderId(localOrder.clientOrderId);
  }
  return null;
}

async function reconcileRoboOrders({
  mode = 'paper',
  limit = 100,
  userId = null,
  accountId = null
} = {}, deps = defaultDeps) {
  const broker = deps.createAlpacaBroker({ mode });
  const localOrderQuery = {
    environment: mode,
    status: { $in: OPEN_STATUSES }
  };
  if (userId) localOrderQuery.userId = userId;
  if (accountId) localOrderQuery.accountId = accountId;

  const localOrders = await deps.RoboTradeOrder.find(localOrderQuery)
    .sort({ submittedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const updated = [];
  const discrepancies = [];

  for (const localOrder of localOrders) {
    if (!localOrder.externalOrderId && !localOrder.clientOrderId) {
      localOrder.reconciliationStatus = 'missing_alpaca_confirmation';
      localOrder.discrepancy = 'Local RoboTradeOrder does not have an Alpaca order id.';
      localOrder.lastReconciledAt = new Date();
      await localOrder.save();
      await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'missing_alpaca_confirmation' }, deps);
      discrepancies.push({ type: 'missing_alpaca_confirmation', localOrderId: String(localOrder._id) });
      await writeAudit(localOrder.userId, 'robotrader_reconciliation_discrepancy', {
        type: 'missing_alpaca_confirmation',
        localOrderId: String(localOrder._id)
      }, deps);
      continue;
    }

    try {
      const alpacaOrder = await loadAlpacaOrderForLocal(localOrder, broker);
      if (!alpacaOrder) {
        localOrder.reconciliationStatus = 'missing_alpaca_confirmation';
        localOrder.discrepancy = localOrder.clientOrderId
          ? 'Local RoboTradeOrder has a client_order_id but could not be looked up by client_order_id.'
          : 'Local RoboTradeOrder does not have an Alpaca order id.';
        localOrder.lastReconciledAt = new Date();
        await localOrder.save();
        await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'missing_alpaca_confirmation' }, deps);
        discrepancies.push({ type: 'missing_alpaca_confirmation', localOrderId: String(localOrder._id) });
        await writeAudit(localOrder.userId, 'robotrader_reconciliation_discrepancy', {
          type: 'missing_alpaca_confirmation',
          localOrderId: String(localOrder._id),
          clientOrderId: localOrder.clientOrderId || null
        }, deps);
        continue;
      }
      await applyAlpacaOrder(localOrder, alpacaOrder, deps);
      updated.push(String(localOrder._id));
    } catch (err) {
      localOrder.reconciliationStatus = 'alpaca_lookup_failed';
      localOrder.discrepancy = err?.message || 'Alpaca order lookup failed.';
      localOrder.lastReconciledAt = new Date();
      await localOrder.save();
      await recordCanaryOutcome(localOrder, 'reconciliation_failed', { type: 'alpaca_lookup_failed', reason: localOrder.discrepancy }, deps);
      discrepancies.push({
        type: 'alpaca_lookup_failed',
        localOrderId: String(localOrder._id),
        reason: localOrder.discrepancy
      });
    }
  }

  const protectiveStops = await submitMissingProtectiveStops({
    mode,
    userId,
    accountId,
    limit,
    broker,
    now: new Date()
  }, deps);

  const recentAlpacaOrders = await broker.listOrders({
    status: 'all',
    limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
    nested: true
  });
  for (const order of recentAlpacaOrders || []) {
    const clientOrderId = order.client_order_id || null;
    if (!clientOrderId || (!clientOrderId.includes('robotrader') && !clientOrderId.includes('robo'))) continue;
    const exists = await deps.RoboTradeOrder.findOne({
      $or: [
        { externalOrderId: order.id },
        { clientOrderId }
      ]
    }).lean();
    if (!exists) {
      if (userId) {
        discrepancies.push({
          type: 'unattributed_alpaca_order',
          reason: 'A RoboTrader Alpaca order exists without a local record, but it cannot be safely attributed to the requesting user.'
        });
        continue;
      }
      discrepancies.push({
        type: 'alpaca_order_missing_local_record',
        externalOrderId: order.id,
        clientOrderId
      });
      await deps.RoboTradeOrder.create({
        userId: null,
        environment: mode,
        externalOrderId: order.id || null,
        clientOrderId,
        symbol: order.symbol,
        assetClass: order.asset_class === 'crypto' ? 'crypto' : 'stocks',
        side: order.side,
        orderType: order.type,
        orderClass: order.order_class || 'simple',
        timeInForce: order.time_in_force,
        qty: toFiniteNumber(order.qty, null),
        notional: toFiniteNumber(order.notional, null),
        status: order.status || 'unknown',
        alpacaResponse: order,
        reconciliationStatus: 'orphan_alpaca_order',
        discrepancy: 'Alpaca order was not found in local RoboTradeOrder records.',
        submittedAt: order.submitted_at || null,
        lastReconciledAt: new Date()
      });
    }
  }

  return {
    ok: true,
    environment: mode,
    updatedCount: updated.length,
    discrepancyCount: discrepancies.length,
    protectiveStopsSubmitted: protectiveStops.length,
    updated,
    discrepancies
  };
}

const defaultDeps = {
  OrderIntent,
  RoboTradeOrder,
  recordControlledLiveOutcome,
  RoboTradeDecision,
  RoboAuditLog,
  createAlpacaBroker,
  buildClientOrderId
};

module.exports = {
  reconcileRoboOrders,
  submitProtectiveStopForEntry,
  submitMissingProtectiveStops
};
