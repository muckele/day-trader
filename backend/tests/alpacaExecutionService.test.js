const test = require('node:test');
const assert = require('node:assert/strict');
const { submitAlpacaEntry } = require('../services/alpacaExecutionService');
test('manual adapter preserves owner and stable key and never invents a filled trade', async () => {
  let captured;
  const result = await submitAlpacaEntry({ userId: 'owner', idempotencyKey: 'stable-request', symbol: 'SPY', side: 'buy', qty: 1, orderType: 'limit', limitPrice: 100, origin: 'research' }, { submit: async input => { captured = input; return { intent: { _id: 'intent', status: 'submission_uncertain', filledQty: 0 }, brokerOrder: null }; } });
  assert.equal(captured.userId, 'owner');
  assert.equal(captured.idempotencyKey, 'stable-request');
  assert.equal(captured.origin, 'research');
  assert.equal(result.executionSource, 'alpaca-paper');
  assert.equal(result.order.status, 'submission_uncertain');
  assert.equal(result.trade, null);
});

test('manual response serializes mongoose intent and exposes only broker-issued ID', async () => {
  const OrderIntent = require('../models/OrderIntent');
  const BrokerOrder = require('../models/BrokerOrder');
  const intent = new OrderIntent({ symbol: 'SPY', side: 'buy', qty: 1, status: 'acknowledged' });
  const brokerOrder = new BrokerOrder({ externalOrderId: 'alpaca-issued-id' });
  const result = await submitAlpacaEntry({ userId: 'owner' }, { submit: async () => ({ intent, order: brokerOrder, brokerOrder }) });
  assert.equal(result.order.symbol, 'SPY');
  assert.equal(result.order.status, 'acknowledged');
  assert.equal(result.brokerOrder.id, 'alpaca-issued-id');
  assert.equal(result.order.externalOrderId, 'alpaca-issued-id');
  assert.equal(result.order._doc, undefined);
});
