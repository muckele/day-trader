const mongoose = require('mongoose');
const Capacity = require('../models/AccountCapacity');
const Intent = require('../models/OrderIntent');
const Fill = require('../models/Fill');
const Protection = require('../models/OrderProtection');
const { fillNotionalCents } = require('./orderLifecycleFinancial');

const source = 'alpaca-paper';
const terminal = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected']);
const unresolved = message => Object.assign(new Error(`Portfolio exposure requires reconciliation: ${message}`), { code: 'EXPOSURE_UNRESOLVED', status: 409 });
const retry = () => Object.assign(new Error('Portfolio changed while collecting broker observations.'), { code: 'EXPOSURE_SNAPSHOT_RETRY', status: 409 });
const flatten = orders => orders.flatMap(order => [order, ...flatten(order.legs || [])]);
function quantities(positions) {
  if (!Array.isArray(positions)) throw unresolved('positions unavailable');
  const result = {};
  for (const position of positions) {
    const qty = Number(position.qty);
    if (!position.symbol || !Number.isSafeInteger(qty) || qty < 0 || Object.hasOwn(result, position.symbol)) throw unresolved('invalid or unsupported position quantity');
    if (qty && (position.market_value == null || !Number.isFinite(Number(position.market_value)) || Number(position.market_value) <= 0)) throw unresolved('positive current position valuation unavailable');
    if (qty) result[position.symbol] = qty;
  }
  return result;
}
function fingerprint(orders) {
  return JSON.stringify(orders.map(order => [order.id, order.client_order_id || '', order.symbol, order.side, String(order.qty), String(order.filled_qty || 0), order.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
async function capture({ broker, accountId }) {
  const cap = await Capacity.findOne({ accountId }).lean();
  const readOrders = async () => {
    if (!broker.listOrders) return null;
    const raw = await broker.listOrders({ status: 'all', nested: true, limit: 500 });
    if (!Array.isArray(raw) || raw.length >= 500) throw unresolved('complete order discovery unavailable');
    return flatten(raw);
  };
  const before = await readOrders();
  const positions = await broker.getPositions();
  const after = await readOrders();
  // Two equal reads are not an atomic broker watermark. They detect activity during
  // collection; canonical-fill equality below is also required before admitting risk.
  if (before && fingerprint(before) !== fingerprint(after)) throw retry();
  return { version: cap?.version || 0, positions, quantities: quantities(positions), orders: after, observedAt: new Date() };
}
async function canonical({ accountId, session }) {
  const scope = { accountId, executionSource: source };
  const intents = await Intent.find(scope).session(session).lean();
  const fills = await Fill.find(scope).session(session).lean();
  const protections = await Protection.find({ accountId }).session(session).lean();
  const net = {}, totals = new Map();
  for (const fill of fills) {
    if (!Number.isSafeInteger(fill.qty) || fill.qty <= 0) throw unresolved('invalid canonical fill quantity');
    net[fill.symbol] = (net[fill.symbol] || 0) + (fill.side === 'buy' ? fill.qty : -fill.qty);
    if (fill.metadata?.kind !== 'protection') {
      const key = `${fill.intentId}:${fill.side}`;
      totals.set(key, (totals.get(key) || 0) + fill.qty);
    }
  }
  for (const intent of intents) {
    if ((totals.get(`${intent._id}:${intent.side}`) || 0) !== intent.filledQty) throw unresolved('canonical intent and fill quantities disagree');
  }
  const clients = new Set(intents.flatMap(intent => [intent.clientOrderId, intent.replacement?.clientOrderId]).filter(Boolean));
  for (const p of protections) {
    if (p.clientOrderId) clients.add(p.clientOrderId);
    // Older canceled stop generations remain app-owned even without a fill.
    for (let generation = 1; generation <= p.generation; generation += 1) clients.add(require('./orderProtectionService').protectionClientId(p.intentId, generation));
  }
  const ids = new Set(fills.map(fill => fill.externalOrderId).filter(Boolean));
  const filledByClient = new Map();
  for (const intent of intents) for (const client of [intent.clientOrderId, intent.replacement?.clientOrderId].filter(Boolean)) filledByClient.set(client, intent.filledQty);
  const filledById = new Map();
  for (const fill of fills) if (fill.metadata?.kind === 'protection') filledById.set(fill.externalOrderId, (filledById.get(fill.externalOrderId) || 0) + fill.qty);
  return { net, clients, ids, filledByClient, filledById, hasFills: fills.length > 0 };
}
async function certify({ accountId, snapshot, cap, session }) {
  // The caller has already acquired exactly one account write lock. A Mongo retry
  // with a changed version is rejected so the outer caller collects new inputs.
  if (cap.version !== snapshot.version + 1) throw retry();
  const known = await canonical({ accountId, session });
  for (const order of snapshot.orders || []) {
    if (!known.clients.has(order.client_order_id) && !known.ids.has(order.id)) continue;
    const filled = Number(order.filled_qty || 0);
    if (!Number.isSafeInteger(filled) || filled < 0 || filled > (known.filledByClient.get(order.client_order_id) ?? known.filledById.get(order.id) ?? 0)) throw unresolved('broker execution is ahead of canonical fill ingestion');
  }
  const foreign = (snapshot.orders || []).filter(order => !known.clients.has(order.client_order_id) && !known.ids.has(order.id));
  if (foreign.some(order => !terminal.has(order.status))) throw unresolved('unattributed active broker order');
  const foreignState = fingerprint(foreign);
  let baseline = cap.portfolioBaseline;
  if (!baseline) {
    // Existing inventory can mask an unobserved historical fill. Without a
    // baseline predating those executions, aggregate equality proves nothing.
    if (known.hasFills) throw unresolved('historical fills lack a trusted portfolio baseline; operator reconciliation required');
    baseline = { quantities: snapshot.quantities, canonicalNet: known.net, foreignState, observedAt: snapshot.observedAt };
  }
  if (snapshot.orders && baseline.foreignState !== foreignState) throw unresolved('unattributed broker activity changed since the baseline');
  const expected = {};
  for (const symbol of new Set([...Object.keys(baseline.quantities || {}), ...Object.keys(baseline.canonicalNet || {}), ...Object.keys(known.net), ...Object.keys(snapshot.quantities)])) {
    const qty = (baseline.quantities[symbol] || 0) + (known.net[symbol] || 0) - (baseline.canonicalNet[symbol] || 0);
    if (!Number.isSafeInteger(qty) || qty < 0 || qty !== (snapshot.quantities[symbol] || 0)) throw unresolved(`broker and canonical holdings disagree for ${symbol}`);
    if (qty) expected[symbol] = qty;
  }
  await Capacity.updateOne({ _id: cap._id }, { $set: { portfolioBaseline: baseline,
    portfolioObservation: { state: 'coherent', quantities: expected, canonicalNet: known.net, observedAt: snapshot.observedAt, version: cap.version } } }, { session });
  return snapshot.positions;
}
async function reducingPositions({ accountId, positions, cap, session }) {
  if (!cap.portfolioBaseline) return positions;
  const { net } = await canonical({ accountId, session });
  const baseline = cap.portfolioBaseline;
  return positions.map(position => {
    const qty = Math.max(0, (baseline.quantities[position.symbol] || 0) + (net[position.symbol] || 0) - (baseline.canonicalNet[position.symbol] || 0));
    return { ...position, qty_available: Math.min(Number(position.qty_available ?? position.qty), qty) };
  });
}
async function invalidate(accountId, session) {
  await Capacity.updateOne({ accountId }, { $set: { 'portfolioObservation.state': 'reconciliation_required' } }, { session });
}
async function refresh({ broker, accountId }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      const snapshot = await capture({ broker, accountId });
      await session.withTransaction(async () => {
        const cap = await Capacity.findOneAndUpdate({ accountId }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
        await certify({ accountId, snapshot, cap, session });
      });
      return { state: 'coherent', quantities: snapshot.quantities };
    } catch (error) {
      if (error.code === 'EXPOSURE_SNAPSHOT_RETRY' && attempt < 3) continue;
      if (['EXPOSURE_UNRESOLVED', 'EXPOSURE_SNAPSHOT_RETRY'].includes(error.code)) return { state: 'reconciliation_required', reason: error.message };
      throw error;
    } finally { await session.endSession(); }
  }
}
// Protective executions reuse Fill, with their broker identity and cumulative
// quantity. They never credit spending/cash or create a separate position ledger.
async function recordProtectionFill(record) {
  const raw = record.brokerSnapshot;
  if (!raw || !(Number(raw.filled_qty) > 0)) return;
  if (raw.id !== record.brokerOrderId || raw.client_order_id !== record.clientOrderId || raw.symbol !== record.symbol || raw.side !== 'sell' || raw.type !== 'stop') throw unresolved('protective execution identity mismatch');
  const qty = Number(raw.filled_qty), total = fillNotionalCents(qty, raw.filled_avg_price);
  if (!Number.isSafeInteger(qty) || qty < 0) throw unresolved('protective fill quantity invalid');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Capacity.findOneAndUpdate({ accountId: record.accountId }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
      const prior = await Fill.findOne({ accountId: record.accountId, executionSource: source, externalOrderId: raw.id }).sort({ cumulativeQty: -1 }).session(session);
      const delta = qty - (prior?.cumulativeQty || 0);
      if (delta <= 0) return;
      const previous = await Fill.find({ accountId: record.accountId, executionSource: source, externalOrderId: raw.id }).session(session);
      const cents = total - previous.reduce((sum, fill) => sum + fill.notionalCents, 0);
      if (cents < 0) throw unresolved('protective cumulative notional regressed');
      await Fill.create([{ accountId: record.accountId, executionSource: source, broker: 'alpaca', intentId: record.intentId,
        externalOrderId: raw.id, cumulativeQty: qty, symbol: record.symbol, side: 'sell', qty: delta,
        notionalCents: cents, notional: cents / 100, price: cents / delta / 100, metadata: { kind: 'protection' } }], { session });
      await invalidate(record.accountId, session);
    });
  } finally { await session.endSession(); }
}
module.exports = { capture, certify, refresh, invalidate, reducingPositions, recordProtectionFill };
