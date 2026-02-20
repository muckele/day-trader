const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const aiEngine = require('../aiEngine');
const tradeLogic = require('../tradeLogic');
const analyzeRouter = require('../routes/analyze');

function getAnalyzeHandler() {
  const layer = analyzeRouter.stack.find(
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

test('analyze route returns 200 when AI provider reports insufficient balance', async t => {
  const originalNewsApiKey = process.env.NEWSAPI_KEY;
  process.env.NEWSAPI_KEY = 'test-news-key';

  t.mock.method(tradeLogic, 'fetchDaily', async () => [
    { t: '2025-01-01T00:00:00.000Z', c: 123.45 }
  ]);
  t.mock.method(axios, 'get', async () => ({
    data: {
      articles: [{ title: 'Test headline' }]
    }
  }));
  t.mock.method(aiEngine, 'analyze', async () => {
    const err = new Error('Insufficient Balance');
    err.code = 'AI_PROVIDER_ERROR';
    throw err;
  });

  const handler = getAnalyzeHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  try {
    await handler(req, res, err => {
      nextErr = err;
    });
  } finally {
    process.env.NEWSAPI_KEY = originalNewsApiKey;
  }

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: false,
    error: 'AI_UNAVAILABLE',
    message: 'AI temporarily unavailable',
    analysis: null
  });
});
