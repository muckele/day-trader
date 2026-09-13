const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationForOrder, sweepOrderNotifications } = require('../services/roboNotificationService');
test('notification sweep advances cursor instead of repeatedly overlooking older records', async () => {
  const queued = [];
  let cursor = null;
  const orders = Array.from({ length: 205 }, (_, i) => ({ _id: i + 1 }));
  const deps = {
    readCursor: async () => cursor,
    writeCursor: async value => { cursor = value; },
    readBatch: async after => orders.filter(order => order._id > (after || 0)).slice(0, 200),
    enqueue: async order => { queued.push(order._id); }
  };
  await sweepOrderNotifications(deps);
  await sweepOrderNotifications(deps);
  assert.equal(new Set(queued).size, 205);
  assert.equal(cursor, null);
});
test('uncertainty generates a distinct notification from original pending intent', () => {
  const order = { _id: 'order', accountId: 'account', environment: 'paper', status: 'pending_submit' };
  assert.notEqual(notificationForOrder(order).eventKey, notificationForOrder({ ...order, reconciliationStatus: 'submit_error_pending_reconciliation' }).eventKey);
});
