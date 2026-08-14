const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const tradeLogic = require('../tradeLogic');
const PaperJournalEntry = require('../models/PaperJournalEntry');
const PaperTrade = require('../models/PaperTrade');
const TradePlan = require('../models/TradePlan');
const ResearchAlert = require('../models/ResearchAlert');

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

function loadRoute(relativePath) {
  const routePath = require.resolve(relativePath);
  delete require.cache[routePath];
  return require(relativePath);
}

function getRouteHandler(router, path, method = 'get') {
  const layer = router.stack.find(
    item => item.route && item.route.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack[0].handle;
}

test('market quotes route rejects oversized symbol batches before provider calls', async () => {
  const marketRouter = loadRoute('../routes/market');
  const handler = getRouteHandler(marketRouter, '/quotes', 'post');
  const res = createMockRes();

  await handler({
    body: {
      symbols: Array.from({ length: 51 }, (_, index) => `SYM${index}`)
    }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /limited to 50/);
});

test('market bars route caps provider limit and validates timeframe', async t => {
  const previousKey = process.env.APCA_API_KEY_ID;
  const previousSecret = process.env.APCA_API_SECRET_KEY;
  process.env.APCA_API_KEY_ID = 'test-key';
  process.env.APCA_API_SECRET_KEY = 'test-secret';

  try {
    const marketRouter = loadRoute('../routes/market');
    const handler = getRouteHandler(marketRouter, '/:symbol/bars', 'get');
    const res = createMockRes();
    let providerParams = null;
    t.mock.method(axios, 'get', async (_url, options) => {
      providerParams = options.params;
      return { data: { AAPL: [{ t: '2026-01-01T00:00:00Z', c: 100 }] } };
    });

    await handler({
      params: { symbol: 'aapl' },
      query: { timeframe: '1Day', limit: '1000000' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(providerParams.limit, 500);
    assert.equal(providerParams.timeframe, '1Day');

    const invalidRes = createMockRes();
    await handler({
      params: { symbol: 'aapl' },
      query: { timeframe: '1Second', limit: '10' }
    }, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
  } finally {
    if (previousKey === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = previousKey;
    if (previousSecret === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = previousSecret;
  }
});

test('market intraday and historical routes reject invalid symbols before provider calls', async t => {
  const marketRouter = loadRoute('../routes/market');
  const intradayHandler = getRouteHandler(marketRouter, '/intraday/:symbol', 'get');
  const historicalHandler = getRouteHandler(marketRouter, '/historical/:symbol', 'get');
  t.mock.method(tradeLogic, 'fetchIntraday', async () => {
    throw new Error('provider should not be called for invalid intraday symbol');
  });
  t.mock.method(tradeLogic, 'fetchDaily', async () => {
    throw new Error('provider should not be called for invalid historical symbol');
  });
  t.mock.method(axios, 'get', async () => {
    throw new Error('provider should not be called for invalid market symbol');
  });

  const intradayRes = createMockRes();
  await intradayHandler({ params: { symbol: 'bad symbol!' } }, intradayRes);

  assert.equal(intradayRes.statusCode, 400);
  assert.equal(intradayRes.body.error, 'Invalid symbol.');

  const historicalRes = createMockRes();
  await historicalHandler({ params: { symbol: 'bad symbol!' } }, historicalRes);

  assert.equal(historicalRes.statusCode, 400);
  assert.equal(historicalRes.body.error, 'Invalid symbol.');
});

test('journal search escapes regex metacharacters and caps length', async t => {
  const journalRouter = loadRoute('../routes/journal');
  const handler = getRouteHandler(journalRouter, '/', 'get');
  let journalQuery = null;

  t.mock.method(PaperTrade, 'find', () => ({
    sort: () => ({
      lean: async () => [{ _id: 'trade-1', symbol: 'AAPL' }]
    })
  }));
  t.mock.method(PaperJournalEntry, 'find', query => {
    journalQuery = query;
    return { lean: async () => [] };
  });

  const res = createMockRes();
  await handler({
    user: { username: 'alice' },
    query: { search: '(a+)+' }
  }, res, err => {
    throw err;
  });

  assert.equal(res.statusCode, 200);
  assert.equal(journalQuery.$or.length, 4);
  const regex = journalQuery.$or[0].thesis;
  assert.equal(regex.test('(a+)+'), true);
  assert.equal(regex.test('aaaa'), false);

  const longRes = createMockRes();
  await handler({
    user: { username: 'alice' },
    query: { search: 'x'.repeat(81) }
  }, longRes);
  assert.equal(longRes.statusCode, 400);
});

test('journal writes reject invalid ids and oversized user content before persistence', async t => {
  const journalRouter = loadRoute('../routes/journal');
  const handler = getRouteHandler(journalRouter, '/:tradeId', 'put');
  let persisted = false;
  t.mock.method(PaperJournalEntry, 'findOneAndUpdate', async () => {
    persisted = true;
    return {};
  });

  const invalidIdRes = createMockRes();
  await handler({
    params: { tradeId: 'not-an-object-id' },
    body: {},
    user: { username: 'alice' }
  }, invalidIdRes);
  assert.equal(invalidIdRes.statusCode, 400);

  const oversizedRes = createMockRes();
  await handler({
    params: { tradeId: '507f1f77bcf86cd799439011' },
    body: { thesis: 'x'.repeat(5001) },
    user: { username: 'alice' }
  }, oversizedRes);
  assert.equal(oversizedRes.statusCode, 400);
  assert.match(oversizedRes.body.error, /thesis is limited/);
  assert.equal(persisted, false);
});

test('backtest routes reject invalid symbols and date ranges before creating a run', async () => {
  const backtestRouter = loadRoute('../routes/backtest');
  const handler = getRouteHandler(backtestRouter, '/', 'post');
  const invalidSymbolRes = createMockRes();

  await handler({
    body: { symbol: 'bad symbol!', strategyId: 'SMA_CROSS' },
    user: { username: 'alice' }
  }, invalidSymbolRes);
  assert.equal(invalidSymbolRes.statusCode, 400);
  assert.equal(invalidSymbolRes.body.error, 'Invalid symbol.');

  const invertedDateRes = createMockRes();
  await handler({
    body: { symbol: 'AAPL', strategyId: 'SMA_CROSS', start: '2026-02-01', end: '2026-01-01' },
    user: { username: 'alice' }
  }, invertedDateRes);
  assert.equal(invertedDateRes.statusCode, 400);
  assert.match(invertedDateRes.body.error, /start must be on or before end/);
});

test('research alert updates reject non-numeric thresholds before persistence', async t => {
  const researchRouter = loadRoute('../routes/research');
  const handler = getRouteHandler(researchRouter, '/alerts/:alertId', 'patch');
  let persisted = false;
  t.mock.method(ResearchAlert, 'findOneAndUpdate', async () => {
    persisted = true;
    return {};
  });
  const res = createMockRes();

  await handler({
    params: { alertId: '507f1f77bcf86cd799439011' },
    body: { threshold: 'not-a-number' },
    user: { username: 'alice' }
  }, res, err => { throw err; });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /positive number/);
  assert.equal(persisted, false);
});

test('trade plan history clamps day range and caps provider symbol fanout', async t => {
  const fetchedSymbols = [];
  t.mock.method(tradeLogic, 'fetchDaily', async symbol => {
    fetchedSymbols.push(symbol);
    return [{ t: '2026-01-02T00:00:00Z', h: 200, l: 50, c: 100 }];
  });
  const tradePlanRouter = loadRoute('../routes/tradePlan');
  const handler = getRouteHandler(tradePlanRouter, '/history', 'get');
  let tradePlanQuery = null;
  t.mock.method(TradePlan, 'find', query => {
    tradePlanQuery = query;
    return {
      sort: () => ({
        lean: async () => [{
          _id: 'plan-1',
          tradeIdeas: Array.from({ length: 30 }, (_, index) => ({
            _id: `idea-${index}`,
            symbol: `SYM${index}`,
            status: 'PENDING',
            bias: 'LONG',
            target: 150
          }))
        }]
      })
    };
  });
  t.mock.method(PaperTrade, 'find', () => ({
    lean: async () => []
  }));

  const res = createMockRes();
  await handler({
    user: { username: 'alice' },
    query: { days: '9999' }
  }, res, err => {
    throw err;
  });

  const minStart = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(res.statusCode, 200);
  assert.equal(tradePlanQuery.accountId, 'user:alice');
  assert.ok(tradePlanQuery.date.$gte >= minStart);
  assert.equal(fetchedSymbols.length, 25);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].code, 'MISSED_WINNERS_PARTIAL');
  assert.equal(res.body.warnings[0].symbolLimit, 25);
  assert.equal(res.body.warnings[0].symbolCount, 30);
  assert.equal(res.body.history[0].metrics.missedWinnersPartial, true);
});
