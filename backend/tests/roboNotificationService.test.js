const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationForOrder, deliverNext } = require('../services/roboNotificationService');

test('acknowledgement and confirmed fills have separate stable event identities', () => {
  const order = { _id: 'local', accountId: 'bound', environment: 'paper', clientOrderId: 'stable', symbol: 'SPY', side: 'buy', qty: 2, status: 'accepted' };
  const submitted = notificationForOrder(order);
  const partial = notificationForOrder({ ...order, status: 'partially_filled', filledQty: 1, filledAvgPrice: 100 });
  const filled = notificationForOrder({ ...order, status: 'filled', filledQty: 2, filledAvgPrice: 101 });
  assert.notEqual(submitted.eventKey, filled.eventKey);
  assert.match(submitted.text, /acknowledged/);
  assert.match(submitted.text, /Confirmed filled quantity: unavailable/);
  assert.match(filled.text, /Confirmed filled quantity: 2/);
  assert.equal(partial.eventKey, notificationForOrder({ ...order, status: 'partially_filled', filledQty: 1.5 }).eventKey);
});

test('SMTP failure schedules retry without changing an order or leaking error text', async () => {
  let update;
  const now = new Date('2026-09-12T12:00:00Z');
  const deps = {
    Outbox: { findOneAndUpdate: async () => ({ _id: 'event', attempts: 1, text: 'text', subject: 'subject' }), updateOne: async (filter, value) => { update = value.$set; } },
    send: async () => { throw new Error('smtp://secret@host credential'); }
  };
  const result = await deliverNext({ now, recipient: 'test@example.com' }, deps);
  assert.equal(result.state, 'retryable');
  assert.equal(update.lastError, 'EMAIL_DELIVERY_FAILED');
  assert.ok(update.nextAttemptAt > now);
  assert.ok(!JSON.stringify(update).includes('secret'));
});

test('provider acceptance is distinct from recipient receipt', async () => {
  let update;
  const deps = {
    Outbox: { findOneAndUpdate: async () => ({ _id: 'event', attempts: 1 }), updateOne: async (filter, value) => { update = value.$set; } },
    send: async () => ({ provider: 'smtp', messageId: 'provider-id', accepted: ['test@example.com'] })
  };
  const result = await deliverNext({ recipient: 'test@example.com' }, deps);
  assert.equal(result.state, 'provider_accepted');
  assert.equal(update.state, 'provider_accepted');
});
