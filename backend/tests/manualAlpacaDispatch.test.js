const test = require('node:test');
const assert = require('node:assert/strict');
const lifecycleModule = require('../services/orderLifecycleService');
const paperBroker = require('../paper/paperBrokerClient');
const simulatorModels = ['PaperSettings', 'PaperTrade', 'PaperOrder', 'PaperEquity'].map(name => require(`../models/${name}`));

for (const status of ['acknowledged', 'submission_uncertain']) {
  test(`Alpaca paper dispatch preserves ${status} through common lifecycle without simulator access`, async t => {
    const previous = process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
    process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = 'true';
    t.after(() => {
      if (previous === undefined) delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
      else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA = previous;
    });
    // These are fail-fast access traps, not fake simulator state. Any simulator
    // read/write would violate source separation and fail this unit test.
    for (const Model of simulatorModels) {
      for (const method of ['find', 'findOne', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'insertMany']) {
        t.mock.method(Model, method, () => { assert.fail(`Alpaca dispatch accessed ${Model.modelName}.${method}`); });
      }
      t.mock.method(Model.prototype, 'save', () => { assert.fail(`Alpaca dispatch mutated ${Model.modelName}`); });
    }
    const requests = [];
    const intent = { _id:'intent-durable-1', accountId:'paper-account', userId:'owner', environment:'paper',
      executionSource:'alpaca-paper', origin:'research', symbol:'AAPL', side:'buy', qty:4,
      orderType:'limit', limitPrice:201, status, filledQty:0, filledNotionalCents:0, clientOrderId:'stable-client' };
    const brokerOrder = status === 'acknowledged' ? {
      _id:'mongo-record-id', id:'mongo-record-id', externalOrderId:'alpaca-provider-id',
      clientOrderId:'stable-client', status:'new'
    } : null;
    t.mock.method(lifecycleModule, 'getOrderLifecycle', () => ({ submit: async request => {
      requests.push(request);
      return { intent, order:brokerOrder, brokerOrder, executionSource:'alpaca-paper' };
    } }));
    const payload = {userId:'owner',idempotencyKey:'browser-stable-key',origin:'research',symbol:'AAPL',
      side:'buy',qty:4,orderType:'limit',limitPrice:201,accountId:'local-simulator-account'};
    const result = await paperBroker.placeOrder(payload);
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0],{userId:'owner',idempotencyKey:'browser-stable-key',origin:'research',
      orderInput:{symbol:'AAPL',side:'buy',qty:4,orderType:'limit',limitPrice:201,accountId:'local-simulator-account'}});
    assert.equal(result.executionSource,'alpaca-paper'); assert.equal(result.broker,'alpaca');
    assert.equal(result.intent.status,status); assert.equal(result.trade,null); assert.deepEqual(result.attachedOrders,[]);
    assert.equal(result.order.externalOrderId,status==='acknowledged'?'alpaca-provider-id':null);
    assert.equal(result.brokerOrder?.id || null,status==='acknowledged'?'alpaca-provider-id':null);
    assert.equal(result.order.accountId,'paper-account');
  });
}
