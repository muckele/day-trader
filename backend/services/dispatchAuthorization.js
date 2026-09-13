const mongoose = require('mongoose');
const { createHash, randomUUID } = require('node:crypto');
const Capacity = require('../models/AccountCapacity');
const Settings = require('../models/RoboSettings');
const Intent = require('../models/OrderIntent');
const WorkerLock = require('../models/RoboLock');
const ExitLock = require('../models/OrderProtectionLock');

const terminal = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];
const denied = message => Object.assign(new Error(message), { code: 'DISPATCH_DENIED', beforeTransport: true });
async function accountGate(accountId, session) {
  return Capacity.findOneAndUpdate({ accountId }, { $inc: { version: 1 }, $setOnInsert: { reservedCents: 0 } }, { upsert: true, new: true, session });
}

// D is a one-use durable authorization, not evidence that T (HTTP) occurred.
// Call only after provider preflight. No external writes in this callback.
async function claimDispatch({ Model = Intent, id, accountId, userId, operation, payload, automated = false, generation = 0, lease, allowedStatuses, assertExecutor }) {
  const token = randomUUID();
  const key = createHash('sha256').update(operation).digest('hex');
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const session = await mongoose.startSession();
  let claim;
  try {
    await session.withTransaction(async () => {
      try { assertExecutor?.(); } catch (error) { throw denied(error.message); }
      await accountGate(accountId, session);
      const record = await Model.findOne({ _id: id, accountId, userId: String(userId) }).session(session);
      if (!record || allowedStatuses && !allowedStatuses.includes(record.status)) throw denied('Dispatch identity or state changed.');
      const previous = record.dispatchClaims?.[key];
      if (previous) throw Object.assign(new Error('Dispatch already claimed; reconcile the original identity.'), { code: 'DISPATCH_ALREADY_CLAIMED' });
      if (automated) {
        const settings = await Settings.findOne({ userId }).session(session);
        if (!settings || !settings.isEnabled || settings.mode !== 'paper' || settings.pausedReason || settings.pausedUntil && settings.pausedUntil > new Date() || (settings.controlGeneration || 0) !== generation) throw denied('RoboTrader controls changed; new entry blocked.');
      }
      if (operation.startsWith('replace:') && record.stopCancelRequested) throw denied('Emergency cancellation supersedes replacement.');
      if (lease) {
        const now = new Date();
        const query = lease.type === 'worker' ? { userId, owner: lease.owner, lockedUntil: { $gt: now } } : { accountId, owner: lease.owner, expiresAt: { $gt: now } };
        const result = await (lease.type === 'worker' ? WorkerLock : ExitLock).updateOne(query, { $set: { [lease.type === 'worker' ? 'lockedUntil' : 'expiresAt']: new Date(now.getTime() + 60000) } }, { session });
        if (result.matchedCount !== 1) throw denied('Dispatch lease lost or expired.');
      } else if (automated) throw denied('Automated dispatch requires its authorized worker lease.');
      claim = { token, operation, payloadHash, recordId: String(record._id), clientOrderId: payload?.client_order_id || record.clientOrderId, accountId, environment: 'paper', generation, executor: lease?.owner || String(userId), claimedAt: new Date(), state: 'delivery_unknown' };
      try { assertExecutor?.(); } catch (error) { throw denied(error.message); }
      await Model.updateOne({ _id: record._id }, { $set: { [`dispatchClaims.${key}`]: claim } }, { session });
    });
  } finally { await session.endSession(); }
  return claim;
}

async function stopStatus(userId, settings) {
  const paused = Boolean(settings.isEnabled && (settings.pausedReason || settings.pausedUntil && new Date(settings.pausedUntil) > new Date()));
  if (settings.isEnabled && settings.mode === 'paper' && !paused) return { state: 'running', admissionsDisabled: false, unresolved: [] };
  const pending = await Intent.find({ userId: String(userId), accountId: process.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID, executionSource: 'alpaca-paper', origin: /^robo/i, side: 'buy', status: { $nin: terminal } }).select('_id clientOrderId status dispatchClaims').lean();
  return { state: pending.length ? 'draining' : 'stopped', admissionsDisabled: true, ...(paused ? { paused: true } : {}), unresolved: pending.map(i => ({ intentId: String(i._id), clientOrderId: i.clientOrderId, status: i.status, dispatchClaimed: Object.keys(i.dispatchClaims || {}).length > 0 })) };
}
module.exports = { accountGate, claimDispatch, stopStatus };
