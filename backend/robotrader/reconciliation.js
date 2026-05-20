const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const { createAlpacaBroker } = require('./alpacaBroker');

const OPEN_STATUSES = ['pending_submit', 'accepted', 'new', 'pending_new', 'partially_filled', 'submitted'];

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

async function writeAudit(userId, eventType, payload, deps) {
  if (!userId) return null;
  return deps.RoboAuditLog.create({ userId, eventType, payload: payload || {} });
}

async function applyAlpacaOrder(localOrder, alpacaOrder, deps) {
  const mapped = mapAlpacaOrder(alpacaOrder);
  Object.assign(localOrder, mapped, {
    reconciliationStatus: 'matched',
    discrepancy: null,
    lastReconciledAt: new Date()
  });
  await localOrder.save();
  await writeAudit(localOrder.userId, 'robotrader_order_status_changed', {
    orderId: localOrder.externalOrderId,
    clientOrderId: localOrder.clientOrderId,
    status: localOrder.status
  }, deps);
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
      discrepancies.push({
        type: 'alpaca_lookup_failed',
        localOrderId: String(localOrder._id),
        reason: localOrder.discrepancy
      });
    }
  }

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
    updated,
    discrepancies
  };
}

const defaultDeps = {
  RoboTradeOrder,
  RoboAuditLog,
  createAlpacaBroker
};

module.exports = {
  reconcileRoboOrders
};
