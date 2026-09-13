const { createHash, randomUUID } = require('node:crypto');
const OrderIntent = require('../models/OrderIntent');
const OrderProtection = require('../models/OrderProtection');
const OrderProtectionLock = require('../models/OrderProtectionLock');
const NotificationOutbox = require('../models/NotificationOutbox');
const RoboAuditLog = require('../models/RoboAuditLog');
const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected']);
function flattenOrders(orders = []) { return orders.flatMap(order => [order, ...flattenOrders(order.legs || [])]); }
const ACTIVE = new Set(['new', 'accepted', 'partially_filled']);
const quantity = value => Math.max(0, Number(value) || 0);
function protectionClientId(intentId, generation) {
  return `robo-stop-${createHash('sha256').update(`${intentId}:${generation}`).digest('hex').slice(0, 32)}`;
}
function createOrderProtection({ broker, ownerId = process.env.OWNER_USER_ID,
  expectedAccountId = process.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID,
  Intent = OrderIntent, Protection = OrderProtection, Lock = OrderProtectionLock,
  Audit = RoboAuditLog, Outbox = NotificationOutbox } = {}) {
  async function identity() {
    const account = await broker.getAccount();
    if (!ownerId || !expectedAccountId || String(account.id) !== String(expectedAccountId) || broker.mode === 'live') {
      throw Object.assign(new Error('Protective order paper account identity failed.'), { code: 'PROTECTION_IDENTITY_REQUIRED' });
    }
  }
  async function mark(record, state, extra = {}) {
    Object.assign(record, extra, { state });
    await record.save();
    await Intent.updateOne({ _id: record.intentId }, { $set: { protectionState: {
      status: state, confirmedQty: record.confirmedQty, clientOrderId: record.clientOrderId,
      brokerOrderId: record.brokerOrderId, error: record.error || null
    } } });
    await Audit.create({ userId: ownerId, eventType: 'order_protection_state', payload: {
      intentId: String(record.intentId), state, qty: record.qty, confirmedQty: record.confirmedQty,
      clientOrderId: record.clientOrderId, error: record.error || null
    } });
    if (['unprotected', 'uncertain', 'cancel_pending'].includes(state)) {
      const eventKey = `${record.accountId}:protection:${record.intentId}:${record.generation}:${state}`;
      await Outbox.updateOne({ eventKey }, { $setOnInsert: { eventKey, accountId: record.accountId,
        environment: 'paper', subject: `Alpaca PAPER ${record.symbol} protection ${state}`,
        text: `Required protective stop is ${state}. Automated entries are blocked until protection is confirmed. Intent ${record.intentId}; requested quantity ${record.qty}; ${record.error || 'Reconciliation pending.'}`,
        state: 'pending' } }, { upsert: true });
    }
    return record;
  }
  async function reconcile({ intentId }) {
    const intent = await Intent.findById(intentId);
    if (!intent || intent.executionSource !== 'alpaca-paper' || intent.side !== 'buy') return null;
    if (String(intent.userId) !== String(ownerId) || String(intent.accountId) !== String(expectedAccountId)) throw new Error('Protection intent ownership mismatch.');
    const stopPrice = Number(intent.orderInput?.riskStopPrice || intent.orderInput?.stopLossPrice || intent.stopLossPrice);
    if (!/^robo/i.test(intent.origin) && !(stopPrice > 0)) return null;
    if (!(quantity(intent.filledQty) > 0)) return null;
    await identity();
    const token = randomUUID();
    let lease;
    try {
      lease = await Lock.findOneAndUpdate({ accountId: expectedAccountId, $or: [
        { expiresAt: { $lte: new Date() } }, { expiresAt: { $exists: false } }
      ] }, { $set: { owner: token, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true, new: true });
    } catch (error) { if (error.code === 11000) return { state: 'busy' }; throw error; }
    if (!lease) return { state: 'busy' };
    const heartbeat = setInterval(() => {
      Lock.updateOne({ accountId: expectedAccountId, owner: token, expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: new Date(Date.now() + 60000) } }).catch(() => {});
    }, 15000);
    heartbeat.unref?.();
    const assertLease = async () => {
      await identity();
      const held = await Lock.findOne({ accountId: expectedAccountId, owner: token, expiresAt: { $gt: new Date() } });
      if (!held) throw new Error('Protection lease lost.');
    };
    try {
      const closing = await require('../models/PositionClose').findOne({ accountId: expectedAccountId, symbol: intent.symbol, active: true });
      if (closing) return { state: 'close_pending', error: closing.error || 'Coordinated close reserves protection management.' };
      let record = await Protection.findOneAndUpdate({ intentId }, { $setOnInsert: {
        accountId: expectedAccountId, userId: ownerId, symbol: intent.symbol, state: 'required'
      } }, { upsert: true, new: true });
      if (!(stopPrice > 0)) return mark(record, 'unprotected', { error: 'Required stop price missing.' });
      let current = null;
      if (record.clientOrderId) {
        try { current = record.brokerOrderId ? await broker.getOrder(record.brokerOrderId) : await broker.getOrderByClientOrderId(record.clientOrderId); }
        catch (error) { return mark(record, 'uncertain', { error: error.message }); }
        if (!current?.id) return mark(record, 'uncertain', { error: 'Protective order lookup unresolved; automatic resubmit prohibited.' });
        if (current.client_order_id !== record.clientOrderId || current.symbol !== intent.symbol || current.side !== 'sell'
          || current.type !== 'stop' || Number(current.stop_price) !== stopPrice) return mark(record, 'unprotected', { confirmedQty: 0, error: 'Protective broker identity or stop terms mismatch.' });
        record.brokerOrderId = current.id;
        record.brokerSnapshot = current;
      }
      const [positions, openOrders] = await Promise.all([broker.getPositions(), broker.listOrders({ status: 'open', nested: true, limit: 500 })]);
      const position = (positions || []).find(p => p.symbol === intent.symbol);
      const unresolvedSell = await Intent.exists({ accountId: expectedAccountId, executionSource: 'alpaca-paper',
        side: 'sell', symbol: intent.symbol, status: { $in: ['intent_created', 'reserved', 'submitting', 'submission_uncertain', 'reconciliation_required', 'replace_pending'] } });
      if (unresolvedSell) return mark(record, 'unprotected', { error: 'An unresolved reducing exit reserves this position.' });
      const otherExits = flattenOrders(openOrders || []).filter(o => o.symbol === intent.symbol && o.side === 'sell' && o.id !== current?.id)
        .reduce((sum, o) => sum + Math.max(0, quantity(o.qty) - quantity(o.filled_qty)), 0);
      const available = position?.qty_available == null ? quantity(position?.qty)
        : quantity(position.qty_available) + (current && !TERMINAL.has(current.status) ? Math.max(0, quantity(current.qty) - quantity(current.filled_qty)) : 0);
      const desired = Math.min(quantity(intent.filledQty), available, Math.max(0, quantity(position?.qty) - otherExits));
      if (current && !TERMINAL.has(current.status)) {
        const remaining = Math.max(0, quantity(current.qty) - quantity(current.filled_qty));
        if (ACTIVE.has(current.status) && remaining === desired && desired > 0) return mark(record, 'protected', { confirmedQty: remaining, error: null });
        // Persist cancellation before writing. A restart only polls this ID until terminal evidence.
        if (record.state !== 'cancel_pending') {
          await mark(record, 'cancel_pending', { confirmedQty: 0 });
          await assertLease();
          try { await broker.cancelOrder(current.id); }
          catch (error) { await mark(record, 'cancel_pending', { error: error.message }); }
        }
        return record;
      }
      if (current?.status === 'rejected') return mark(record, 'unprotected', { confirmedQty: 0, error: 'Broker rejected protective stop; operator review required.' });
      if (!desired) return mark(record, quantity(position?.qty) > 0 ? 'unprotected' : 'flat', { confirmedQty: 0, error: quantity(position?.qty) > 0 ? 'Remaining position is reserved by other exits; stop coverage requires review.' : null });
      // A new generation is legal only after the previous broker ID is terminal.
      record.generation += 1;
      record.clientOrderId = protectionClientId(intentId, record.generation);
      record.brokerOrderId = null;
      await mark(record, 'submitting', { qty: desired, confirmedQty: 0, error: null });
      await assertLease();
      try {
        const result = await broker.submitOrder({ symbol: intent.symbol, assetClass: 'stocks', side: 'sell',
          orderType: 'stop', orderClass: 'simple', timeInForce: 'gtc', qty: desired,
          stopPrice, clientOrderId: record.clientOrderId });
        const order = result.order || result;
        const confirmed = order.id && order.client_order_id === record.clientOrderId && order.symbol === intent.symbol
          && order.side === 'sell' && order.type === 'stop' && Number(order.stop_price) === stopPrice
          && quantity(order.qty) === desired && ACTIVE.has(order.status);
        return await mark(record, confirmed ? 'protected' : 'uncertain', {
          brokerOrderId: order.id, brokerSnapshot: order,
          confirmedQty: confirmed ? Math.max(0, quantity(order.qty) - quantity(order.filled_qty)) : 0
        });
      } catch (error) {
        // Includes local persistence failures after broker acknowledgement. Never retry POST.
        return mark(record, 'uncertain', { error: error.message, confirmedQty: 0 });
      }
    } finally { clearInterval(heartbeat); await Lock.updateOne({ accountId: expectedAccountId, owner: token }, { $set: { expiresAt: new Date(0) } }); }
  }
  async function assertProtected() {
    const entries = await Intent.find({ accountId: expectedAccountId, userId: ownerId,
      executionSource: 'alpaca-paper', side: 'buy', filledQty: { $gt: 0 } });
    for (const entry of entries) {
      if (!/^robo/i.test(entry.origin) && !(Number(entry.orderInput?.stopLossPrice || entry.orderInput?.riskStopPrice || entry.stopLossPrice) > 0)) continue;
      const result = await reconcile({ intentId: entry._id });
      if (!result || !['protected', 'flat'].includes(result.state)) throw Object.assign(new Error('Existing automated position protection is unresolved.'), { code: 'AUTOMATED_PROTECTION_REQUIRED' });
    }
  }
  return { reconcile, assertProtected };
}
async function withProtectionAccountLock({ accountId, symbol, coordinatedClose = false }, fn) {
  const owner = randomUUID();
  try {
    await OrderProtectionLock.findOneAndUpdate({ accountId, $or: [
      { expiresAt: { $lte: new Date() } }, { expiresAt: { $exists: false } }
    ] }, { $set: { owner, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true, new: true });
  } catch (error) {
    if (error.code === 11000) throw Object.assign(new Error('Account exit operation is already running.'), { status: 409, code: 'EXIT_BUSY' });
    throw error;
  }
  const heartbeat = setInterval(() => {
    OrderProtectionLock.updateOne({ accountId, owner, expiresAt: { $gt: new Date() } },
      { $set: { expiresAt: new Date(Date.now() + 60000) } }).catch(() => {});
  }, 15000);
  heartbeat.unref?.();
  try {
    if (!coordinatedClose && await require('../models/PositionClose').exists({ accountId, ...(symbol ? { symbol } : {}), active: true })) throw Object.assign(new Error('A coordinated close reserves this position.'), { status: 409, code: 'EXIT_CLOSE_RESERVED' });
    const reserved = await OrderProtection.exists({ accountId, ...(symbol ? { symbol } : {}),
      $or: [{ confirmedQty: { $gt: 0 } }, { state: { $in: ['submitting', 'uncertain', 'cancel_pending'] } }] });
    if (reserved && !coordinatedClose) throw Object.assign(new Error('Protective orders reserve this position; reconcile or cancel the linked stop before another exit.'), { status: 409, code: 'EXIT_PROTECTION_RESERVED' });
    return await fn(async () => {
      if (!await OrderProtectionLock.exists({ accountId, owner, expiresAt: { $gt: new Date() } })) throw new Error('Exit lease lost.');
    });
  } finally {
    clearInterval(heartbeat);
    await OrderProtectionLock.updateOne({ accountId, owner }, { $set: { expiresAt: new Date(0) } });
  }
}
module.exports = { createOrderProtection, protectionClientId, withProtectionAccountLock };
