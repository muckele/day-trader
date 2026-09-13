const RoboTradeOrder = require('../models/RoboTradeOrder');
const OrderIntent = require('../models/OrderIntent');
const { createAlpacaBroker } = require('./alpacaBroker');
const { createOrderProtection } = require('../services/orderProtectionService');

async function submitProtectiveStopForEntry(parentOrder, { broker }, deps = {}) {
  // Legacy projections are insufficient authority for a broker write.
  if (!parentOrder.intentId) return null;
  return createOrderProtection({ broker, ...(deps.protectionDeps || {}) }).reconcile({ intentId: parentOrder.intentId });
}
async function submitMissingProtectiveStops({ broker, userId }, deps = {}) {
  const intents = await (deps.OrderIntent || OrderIntent).find({ userId: String(userId || process.env.OWNER_USER_ID),
    executionSource: 'alpaca-paper', origin: /^robo/i, side: 'buy', filledQty: { $gt: 0 } });
  const protection = createOrderProtection({ broker, ...(deps.protectionDeps || {}) });
  const results = [];
  for (const intent of intents) results.push(await protection.reconcile({ intentId: intent._id }));
  return results.filter(Boolean);
}
async function reconcileRoboOrders({ mode = 'paper', limit = 100, userId = process.env.OWNER_USER_ID,
  accountId = null } = {}, deps = {}) {
  if (mode !== 'paper') throw new Error('This release is paper-only.');
  const broker = (deps.createAlpacaBroker || createAlpacaBroker)({ mode });
  const lifecycle = await (deps.getOrderLifecycle || require('../services/orderLifecycleService').getOrderLifecycle)({ broker });
  const query = { userId: String(userId), executionSource: 'alpaca-paper' };
  // Reconcile all shared intents, including manual entries and terminal partially filled orders.
  if (accountId) query.accountId = accountId;
  const intents = await (deps.OrderIntent || OrderIntent).find(query).sort({ updatedAt: 1 }).limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const updated = [], discrepancies = [];
  for (const intent of intents) {
    try {
      const result = await lifecycle.reconcile({ intentId: intent._id });
      await (deps.RoboTradeOrder || RoboTradeOrder).updateOne({ intentId: intent._id }, { $set: {
        status: result.intent.status, filledQty: result.intent.filledQty,
        externalOrderId: result.order?.externalOrderId || result.brokerOrder?.externalOrderId || null,
        alpacaResponse: result.order || {}, lastReconciledAt: new Date(), reconciliationStatus: 'matched'
      } });
      updated.push(String(intent._id));
    } catch (error) { discrepancies.push({ intentId: String(intent._id), reason: error.message }); }
  }
  return { ok: discrepancies.length === 0, environment: mode, executionSource: 'alpaca-paper',
    updatedCount: updated.length, discrepancyCount: discrepancies.length, updated, discrepancies };
}
module.exports = { reconcileRoboOrders, submitProtectiveStopForEntry, submitMissingProtectiveStops, createOrderProtection };
