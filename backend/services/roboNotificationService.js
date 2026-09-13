const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Outbox = require('../models/NotificationOutbox');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const { sendNotificationEmail } = require('./roboEmail');
const MAX_ATTEMPTS = 5;

function known(value) {
  return value !== null && value !== undefined && value !== '' ? String(value) : 'unavailable';
}
function notificationForOrder(order) {
  if (order.environment !== 'paper') return null;
  const status = String(order.status || 'pending_submit');
  const phase = ['accepted', 'new', 'pending_new', 'submitted'].includes(status) ? 'acknowledged' : status;
  const problem = ['submit_error_pending_reconciliation', 'missing_alpaca_confirmation', 'alpaca_lookup_failed', 'protection_failed'].includes(order.reconciliationStatus) ? order.reconciliationStatus : '';
  const identity = order.clientOrderId || order._id;
  if (!identity || !order.accountId) return null;
  return {
    eventKey: `${order.accountId}:paper:${identity}:${phase}${problem ? `:${problem}` : ''}`,
    accountId: order.accountId,
    environment: 'paper',
    subject: `Alpaca PAPER ${order.symbol} ${phase}`,
    text: [
      'Alpaca PAPER — RoboTrader order event',
      `State: ${phase}`, `Reconciliation: ${problem || 'no reported discrepancy'}`, `Symbol: ${known(order.symbol)}`, `Side: ${known(order.side)}`,
      `Requested quantity: ${known(order.qty)}`, `Confirmed filled quantity: ${known(order.filledQty)}`,
      `Confirmed average fill price: ${known(order.filledAvgPrice)}`,
      `Timestamp: ${known(order.filledAt || order.submittedAt || order.updatedAt)}`,
      `Strategy: ${known(order.strategyId)}`, `Reason: ${known(order.reasoningSummary)}`,
      `Broker order ID: ${known(order.externalOrderId)}`, `Client order ID: ${known(order.clientOrderId)}`,
      'Acknowledgement is not a fill. Stop orders do not guarantee execution price.'
    ].join('\n')
  };
}
async function enqueueOrderNotification(order, { now = new Date() } = {}, deps = { Outbox }) {
  const event = notificationForOrder(order);
  if (!event) return null;
  try {
    return await deps.Outbox.updateOne({ eventKey: event.eventKey }, { $setOnInsert: { ...event, state: 'pending', nextAttemptAt: now } }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
}
async function deliverNext({ now = new Date(), recipient = process.env.ROBO_NOTIFICATION_RECIPIENT } = {}, deps = { Outbox, send: sendNotificationEmail }) {
  if (!recipient) return { state: 'unconfigured' };
  const owner = randomUUID();
  const event = await deps.Outbox.findOneAndUpdate({
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [
      { state: { $in: ['pending', 'retryable'] }, nextAttemptAt: { $lte: now } },
      { state: 'sending', leaseUntil: { $lte: now } }
    ]
  }, { $set: { state: 'sending', leaseOwner: owner, leaseUntil: new Date(now.getTime() + 120_000) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1 } });
  if (!event) return { state: 'idle' };
  let update;
  try {
    const response = await deps.send({ to: recipient, subject: event.subject, text: event.text });
    if (response?.provider !== 'smtp' || !response.accepted?.includes(recipient)) throw new Error('Provider did not accept recipient');
    update = { state: 'provider_accepted', providerMessageId: response.messageId || null, providerAcceptedAt: now, lastError: null };
  } catch (_) {
    update = { state: event.attempts >= MAX_ATTEMPTS ? 'failed' : 'retryable', lastError: 'EMAIL_DELIVERY_FAILED', nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 30_000 * 2 ** event.attempts)) };
  }
  await deps.Outbox.updateOne({ _id: event._id, leaseOwner: owner }, { $set: update, $unset: { leaseOwner: '', leaseUntil: '' } });
  return { state: update.state };
}
async function sweepOrderNotifications(deps) {
  const after = await deps.readCursor();
  const batch = await deps.readBatch(after);
  for (const order of batch) await deps.enqueue(order);
  await deps.writeCursor(batch.length < 200 ? null : batch[batch.length - 1]._id);
}
async function runNotificationTick() {
  if (!process.env.OWNER_USER_ID) return;
  const cursors = mongoose.connection.collection('notificationcursors');
  const cursorId = `paper:${process.env.OWNER_USER_ID}`;
  await sweepOrderNotifications({
    readCursor: async () => (await cursors.findOne({ _id: cursorId }))?.after || null,
    writeCursor: async after => cursors.updateOne({ _id: cursorId }, { $set: { after } }, { upsert: true }),
    readBatch: after => RoboTradeOrder.find({ environment: 'paper', userId: process.env.OWNER_USER_ID, ...(after ? { _id: { $gt: after } } : {}) }).sort({ _id: 1 }).limit(200).lean(),
    enqueue: enqueueOrderNotification
  });
  // Expired final attempts need an explicit terminal state after process death.
  await Outbox.updateMany({ state: 'sending', attempts: { $gte: MAX_ATTEMPTS }, leaseUntil: { $lte: new Date() } }, { $set: { state: 'failed', lastError: 'EMAIL_DELIVERY_UNCERTAIN' } });
  for (let i = 0; i < 10; i += 1) {
    const result = await deliverNext();
    if (['idle', 'unconfigured'].includes(result.state)) break;
  }
}
module.exports = { notificationForOrder, enqueueOrderNotification, deliverNext, runNotificationTick, sweepOrderNotifications };
