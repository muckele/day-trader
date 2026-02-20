const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.APCA_API_KEY_ID = process.env.APCA_API_KEY_ID || 'test-key';
process.env.APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY || 'test-secret';

const companyRouter = require('../routes/company');

function getCompanyHandler() {
  const layer = companyRouter.stack.find(
    item => item.route && item.route.path === '/:symbol' && item.route.methods.get
  );
  assert.ok(layer, 'Expected GET /:symbol route to exist');
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

test('company route returns company payload from Alpaca asset endpoint', async t => {
  const calledUrls = [];
  t.mock.method(axios, 'get', async (url) => {
    calledUrls.push(url);
    return {
      data: {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NASDAQ',
        asset_class: 'us_equity',
        status: 'active'
      }
    };
  });

  const handler = getCompanyHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.company.symbol, 'AAPL');
  assert.equal(res.body.company.name, 'Apple Inc.');
  assert.ok(calledUrls.some(url => url.endsWith('/v2/assets/AAPL')));
});

test('company route returns 404 when asset is not found', async t => {
  t.mock.method(axios, 'get', async () => {
    const err = new Error('Not found');
    err.response = { status: 404 };
    throw err;
  });

  const handler = getCompanyHandler();
  const req = { params: { symbol: 'xxxx' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'No asset found for XXXX' });
});
