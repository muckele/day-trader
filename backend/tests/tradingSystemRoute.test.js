const test = require('node:test');
const assert = require('node:assert/strict');
const tradingSystemRouter = require('../routes/tradingSystem');

function getHandler(path) {
  const layer = tradingSystemRouter.stack.find(
    item => item.route && item.route.path === path && item.route.methods.get
  );
  assert.ok(layer, `Expected GET ${path} route to exist`);
  return layer.route.stack[0].handle;
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

test('trading-system status route returns config, flags, and strategies', async () => {
  const handler = getHandler('/status');
  const res = createMockRes();
  let nextErr = null;

  await handler({}, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.environment.paperTradingEnabled, 'boolean');
  assert.equal(typeof res.body.featureFlags.liveTradingEnabled, 'boolean');
  assert.equal(typeof res.body.mongo.state, 'string');
  assert.ok(Array.isArray(res.body.strategies));
  assert.ok(res.body.strategies.length >= 1);
});

test('trading-system strategy-runs route returns a schema-shaped payload', async () => {
  const handler = getHandler('/strategy-runs');
  const res = createMockRes();
  let nextErr = null;

  await handler({ query: { limit: '5' } }, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items));
  if (res.body.warning) {
    assert.equal(res.body.warning, 'DATA_UNAVAILABLE');
  }
});

test('trading-system strategy-parameters route returns a schema-shaped payload', async () => {
  const handler = getHandler('/strategy-parameters');
  const res = createMockRes();
  let nextErr = null;

  await handler({ query: { limit: '5' } }, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items));
  if (res.body.warning) {
    assert.equal(res.body.warning, 'DATA_UNAVAILABLE');
  }
});

test('trading-system execution route returns summary, orders, and fills', async () => {
  const handler = getHandler('/execution');
  const res = createMockRes();
  let nextErr = null;

  await handler({ query: { limit: '5' } }, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.orders));
  assert.ok(Array.isArray(res.body.fills));
  assert.equal(typeof res.body.summary.attemptedOrders, 'number');
  assert.equal(typeof res.body.summary.rejectRate, 'number');
  if (res.body.warning) {
    assert.equal(res.body.warning, 'DATA_UNAVAILABLE');
  }
});
