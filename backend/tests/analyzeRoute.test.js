const test = require('node:test');
const assert = require('node:assert/strict');
const analysisEngine = require('../analysisEngine');
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

test('analyze route returns deterministic analysis payload', async t => {
  t.mock.method(analysisEngine, 'analyzeDeterministic', async () => ({
    asOf: '2025-01-01T00:00:00.000Z',
    symbol: 'AAPL',
    timeframe: '1D',
    regime: { trendChop: 'TREND', vol: 'CONTRACTION', risk: 'RISK_ON', notes: [] },
    indicators: { sma20: 100, sma50: 98, rsi14: 48, atr: 2, atrPct: 1.2, momentum: 4.1 },
    qualityGate: { passed: true, reasons: [] },
    setup: { setupType: 'TREND_PULLBACK', bias: 'LONG', confidenceScore: 80 },
    levels: { entry: 101, stop: 99, target: 105, atr: 2 },
    rationale: ['test rationale'],
    invalidation: ['test invalidation']
  }));

  const handler = getAnalyzeHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.error, null);
  assert.equal(res.body.analysis.symbol, 'AAPL');
  assert.equal(res.body.analysis.setup.setupType, 'TREND_PULLBACK');
});

test('analyze route returns 200 ok:false for NO_DATA', async t => {
  t.mock.method(analysisEngine, 'analyzeDeterministic', async () => {
    const err = new Error('No bars found for AAPL.');
    err.code = 'NO_DATA';
    throw err;
  });

  const handler = getAnalyzeHandler();
  const req = { params: { symbol: 'aapl' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'NO_DATA');
  assert.equal(res.body.analysis, null);
});
