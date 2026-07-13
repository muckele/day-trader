const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateExecutionQuality,
  getEasternTimeParts
} = require('../services/executionQualityService');

const executionPolicy = {
  maxQuoteAgeSeconds: 15,
  maxSpreadBps: 35,
  minAverageDailyDollarVolume: 20000000,
  maxEstimatedSlippageBps: 25,
  cutoffMinutesBeforeClose: 15
};

function buildInput(overrides = {}) {
  return {
    environment: 'live',
    assetClass: 'stocks',
    orderInput: {
      symbol: 'AAPL',
      assetClass: 'stocks',
      side: 'buy',
      orderType: 'market',
      qty: 5,
      referencePrice: 200,
      estimatedNotional: 1000
    },
    research: {
      price: 200,
      quote: {
        bidPrice: 199.95,
        askPrice: 200.05,
        timestamp: '2026-07-13T13:59:55.000Z',
        source: 'alpaca',
        isMock: false
      },
      indicators: { avgVolume20: 1000000 }
    },
    marketClock: {
      is_open: true,
      next_close: '2026-07-13T20:00:00.000Z'
    },
    executionPolicy,
    now: new Date('2026-07-13T14:00:00.000Z'),
    ...overrides
  };
}

test('execution quality approves a fresh, liquid, tight-spread live equity order', () => {
  const result = evaluateExecutionQuality(buildInput());

  assert.equal(result.approved, true);
  assert.equal(result.veto, false);
  assert.equal(result.metrics.quoteAgeSeconds, 5);
  assert.equal(result.metrics.averageDailyDollarVolume, 200000000);
  assert.ok(result.metrics.estimatedSlippageBps < executionPolicy.maxEstimatedSlippageBps);
});

test('execution quality fails closed on stale quotes and mock data', () => {
  const input = buildInput();
  input.research.quote.timestamp = '2026-07-13T13:59:00.000Z';
  input.research.quote.source = 'mock';
  input.research.quote.isMock = true;
  const result = evaluateExecutionQuality(input);

  assert.equal(result.approved, false);
  assert.equal(result.checks.find(check => check.name === 'quote_fresh').passed, false);
  assert.equal(result.checks.find(check => check.name === 'market_data_live').passed, false);
});

test('execution quality rejects materially future-dated quote timestamps', () => {
  const input = buildInput();
  input.research.quote.timestamp = '2026-07-13T14:01:00.000Z';
  const result = evaluateExecutionQuality(input);

  assert.equal(result.checks.find(check => check.name === 'quote_fresh').passed, false);
  assert.equal(result.metrics.rawQuoteAgeSeconds, -60);
});

test('execution quality enforces the 3:45 PM ET new-order cutoff', () => {
  const input = buildInput({ now: new Date('2026-07-13T19:46:00.000Z') });
  input.research.quote.timestamp = '2026-07-13T19:45:58.000Z';
  const result = evaluateExecutionQuality(input);

  assert.equal(getEasternTimeParts(input.now).minutesSinceMidnight, 15 * 60 + 46);
  assert.equal(result.checks.find(check => check.name === 'new_order_cutoff').passed, false);
});

test('execution quality includes adverse movement from the reviewed reference price', () => {
  const input = buildInput();
  input.research.price = 202;
  input.research.quote.bidPrice = 201.95;
  input.research.quote.askPrice = 202.05;
  const result = evaluateExecutionQuality(input);

  assert.ok(result.metrics.adverseReferenceMoveBps >= 99);
  assert.equal(result.checks.find(check => check.name === 'slippage_allowed').passed, false);
});

test('execution quality uses the broker calendar close for early-close sessions', () => {
  const input = buildInput({
    now: new Date('2026-11-27T17:46:00.000Z'),
    marketClock: {
      is_open: true,
      next_close: '2026-11-27T18:00:00.000Z'
    }
  });
  input.research.quote.timestamp = '2026-11-27T17:45:58.000Z';
  const result = evaluateExecutionQuality(input);

  assert.equal(result.checks.find(check => check.name === 'new_order_cutoff').passed, false);
});

test('execution quality fails closed when the open-session close is missing or belongs to another date', () => {
  const missingClose = buildInput({ marketClock: { is_open: true } });
  const missingResult = evaluateExecutionQuality(missingClose);
  assert.equal(missingResult.checks.find(check => check.name === 'new_order_cutoff').passed, false);

  const wrongSession = buildInput({
    marketClock: {
      is_open: true,
      next_close: '2026-07-14T20:00:00.000Z'
    }
  });
  const wrongSessionResult = evaluateExecutionQuality(wrongSession);
  assert.equal(wrongSessionResult.checks.find(check => check.name === 'new_order_cutoff').passed, false);
  assert.equal(wrongSessionResult.metrics.nextClose.toISOString(), '2026-07-14T20:00:00.000Z');
});

test('execution quality requires explicit trusted quote provenance', () => {
  const missingSource = buildInput();
  delete missingSource.research.quote.source;
  const missingSourceResult = evaluateExecutionQuality(missingSource);
  assert.equal(missingSourceResult.checks.find(check => check.name === 'market_data_live').passed, false);

  const unknownSource = buildInput();
  unknownSource.research.quote.source = 'unknown-provider';
  const unknownSourceResult = evaluateExecutionQuality(unknownSource);
  assert.equal(unknownSourceResult.checks.find(check => check.name === 'market_data_live').passed, false);

  const missingMarker = buildInput();
  delete missingMarker.research.quote.isMock;
  const missingMarkerResult = evaluateExecutionQuality(missingMarker);
  assert.equal(missingMarkerResult.checks.find(check => check.name === 'market_data_live').passed, false);

  const mixedCaseMock = buildInput();
  mixedCaseMock.research.quote.source = 'MoCk';
  mixedCaseMock.research.quote.isMock = false;
  const mixedCaseMockResult = evaluateExecutionQuality(mixedCaseMock);
  assert.equal(mixedCaseMockResult.checks.find(check => check.name === 'market_data_live').passed, false);
});

test('new-order cutoff does not veto a quantity-bounded risk-reducing exit', () => {
  const input = buildInput({
    now: new Date('2026-07-13T19:46:00.000Z'),
    positions: [{ symbol: 'AAPL', qty: 10, market_value: 2000 }]
  });
  input.orderInput.side = 'sell';
  input.orderInput.qty = 5;
  input.research.quote.timestamp = '2026-07-13T19:45:58.000Z';
  const result = evaluateExecutionQuality(input);

  assert.equal(result.metrics.riskReducingOnly, true);
  assert.equal(result.checks.find(check => check.name === 'new_order_cutoff').passed, true);
});

test('paper execution records informational checks without live-like vetoes', () => {
  const result = evaluateExecutionQuality(buildInput({
    environment: 'paper',
    research: { price: 200, indicators: {} },
    marketClock: null
  }));

  assert.equal(result.approved, true);
  assert.equal(result.checks.every(check => check.passed), true);
});
