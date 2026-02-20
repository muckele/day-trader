const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.APCA_DATA_URL = process.env.APCA_DATA_URL || 'https://data.alpaca.markets';
process.env.APCA_API_KEY_ID = process.env.APCA_API_KEY_ID || 'test-key';
process.env.APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY || 'test-secret';

const recommendRouter = require('../routes/recommend');

function getRecommendHandler() {
  const layer = recommendRouter.stack.find(
    item => item.route && item.route.path === '/' && item.route.methods.get
  );
  assert.ok(layer, 'Expected GET / route to exist');
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

test('recommend route returns 200 with warning when daily bars are unavailable', async t => {
  t.mock.method(axios, 'get', async () => ({
    data: {
      code: 50010000,
      message: 'upstream error'
    }
  }));

  const handler = getRecommendHandler();
  const req = {};
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warning, 'DATA_UNAVAILABLE');
  assert.equal(res.body.message, 'Could not fetch daily bars');
  assert.ok(Array.isArray(res.body.recommendations));
  assert.equal(res.body.recommendations.length, 0);
});
