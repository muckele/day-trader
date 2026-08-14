const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMarketDataProvenance
} = require('../services/marketDataProvenanceService');

const now = new Date('2026-08-14T16:00:00.000Z');

function buildInput(quote = {}) {
  return {
    symbol: 'AAPL',
    quote: {
      symbol: 'AAPL',
      price: 200,
      bidPrice: 199.95,
      askPrice: 200.05,
      timestamp: '2026-08-14T15:59:55.000Z',
      source: 'alpaca',
      isMock: false,
      ...quote
    },
    bars: [{ t: '2026-08-13T20:00:00.000Z', c: 199 }],
    historicalProvider: 'alpaca',
    historicalTimestamp: '2026-08-13T20:00:00.000Z',
    now
  };
}

test('trusted current AAPL quote and Alpaca history are execution eligible', () => {
  const result = buildMarketDataProvenance(buildInput());
  assert.equal(result.trustedForExecution, true);
  assert.equal(result.provider, 'alpaca');
  assert.equal(result.ageSeconds, 5);
});

for (const [name, quote, failedCheck] of [
  ['mock', { source: 'mock', isMock: true }, 'provider_trusted'],
  ['stale', { timestamp: '2026-08-14T15:00:00.000Z' }, 'quote_fresh'],
  ['malformed', { bidPrice: -1, askPrice: null }, 'quote_shape_valid'],
  ['mismatched-symbol', { symbol: 'MSFT' }, 'symbol_matches'],
  ['missing-timestamp', { timestamp: null }, 'quote_timestamp_present']
]) {
  test(`${name} market data is not execution eligible`, () => {
    const result = buildMarketDataProvenance(buildInput(quote));
    assert.equal(result.trustedForExecution, false);
    assert.equal(result.checks.find(check => check.key === failedCheck).passed, false);
  });
}
