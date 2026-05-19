const test = require('node:test');
const assert = require('node:assert/strict');
const paperTradesRouter = require('../routes/paperTrades');
const tradeRouter = require('../routes/trade');
const paperBroker = require('../paper/paperBrokerClient');

function getRouteHandler(router, path, method) {
  const layer = router.stack.find(
    item => item.route && item.route.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('paper trade routes require auth middleware', () => {
  const middlewareNames = paperTradesRouter.stack
    .filter(layer => !layer.route)
    .map(layer => layer.handle?.name);

  assert.ok(middlewareNames.includes('auth'));
});

test('trade execute route uses paper broker persistence pipeline', async t => {
  const calls = [];
  t.mock.method(paperBroker, 'placeOrder', async payload => {
    calls.push(payload);
    return {
      order: { _id: 'paper-order-1', symbol: payload.symbol },
      trade: { _id: 'paper-trade-1', symbol: payload.symbol },
      brokerOrder: { id: 'alpaca-order-1' }
    };
  });

  const handler = getRouteHandler(tradeRouter, '/execute', 'post');
  const req = {
    body: {
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      allowExtendedHours: true
    }
  };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'manual');
  assert.equal(calls[0].metadata.source, 'api_trade_execute');
  assert.equal(res.body.order._id, 'paper-order-1');
});
