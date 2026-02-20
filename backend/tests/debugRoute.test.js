const test = require('node:test');
const assert = require('node:assert/strict');
const tradeLogic = require('../tradeLogic');
const debugRouter = require('../routes/debug');

function getDebugBarsHandler() {
  const layer = debugRouter.stack.find(
    item => item.route && item.route.path === '/bars/:symbol' && item.route.methods.get
  );
  assert.ok(layer, 'Expected GET /bars/:symbol route to exist');
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

test('debug bars route returns summary fields for latest bar', async t => {
  t.mock.method(tradeLogic, 'fetchDaily', async () => [
    { t: '2025-01-02T00:00:00Z', c: 101.25 },
    { timestamp: '2025-01-03T00:00:00Z', close: 103.75 }
  ]);

  const handler = getDebugBarsHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    symbol: 'AAPL',
    barCount: 2,
    lastBarTime: '2025-01-03T00:00:00Z',
    lastClose: 103.75
  });
});

test('debug bars route returns explicit empty payload when bars are empty', async t => {
  t.mock.method(tradeLogic, 'fetchDaily', async () => []);

  const handler = getDebugBarsHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    symbol: 'AAPL',
    barCount: 0,
    lastBarTime: null,
    lastClose: null
  });
});

test('debug bars route returns 200 DATA_UNAVAILABLE payload', async t => {
  t.mock.method(tradeLogic, 'fetchDaily', async () => {
    const err = new Error('Could not fetch daily bars for AAPL: No daily bars returned');
    err.code = 'DATA_UNAVAILABLE';
    throw err;
  });

  const handler = getDebugBarsHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.symbol, 'AAPL');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'DATA_UNAVAILABLE');
  assert.equal(typeof res.body.message, 'string');
  assert.ok(res.body.message.length > 0);
});
