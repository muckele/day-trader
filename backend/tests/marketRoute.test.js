const test = require('node:test');
const assert = require('node:assert/strict');
const tradeLogic = require('../tradeLogic');

function getRouteHandler(path) {
  const marketRoutePath = require.resolve('../routes/market');
  delete require.cache[marketRoutePath];
  const marketRouter = require('../routes/market');
  const layer = marketRouter.stack.find(
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

test('market intraday route returns data on happy path', async t => {
  t.mock.method(tradeLogic, 'fetchIntraday', async () => ([
    { time: '2025-01-02T14:30:00.000Z', open: 100, high: 101, low: 99.5, close: 100.5, volume: 10000 }
  ]));

  const handler = getRouteHandler('/intraday/:symbol');
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].close, 100.5);
});

test('market intraday route degrades gracefully on DATA_UNAVAILABLE', async t => {
  t.mock.method(tradeLogic, 'fetchIntraday', async () => {
    const err = new Error('Could not fetch intraday bars for AAPL: No intraday bars returned');
    err.code = 'DATA_UNAVAILABLE';
    throw err;
  });

  const handler = getRouteHandler('/intraday/:symbol');
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test('market historical route degrades gracefully on DATA_UNAVAILABLE', async t => {
  t.mock.method(tradeLogic, 'fetchDaily', async () => {
    const err = new Error('Could not fetch daily bars for AAPL: No daily bars returned');
    err.code = 'DATA_UNAVAILABLE';
    throw err;
  });

  const handler = getRouteHandler('/historical/:symbol');
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});
