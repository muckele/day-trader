const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecommendation, validateRecommendation } = require('../utils/recommendationSchema');

test('recommendation schema validates build output', () => {
  const rec = buildRecommendation({
    symbol: 'AAPL',
    recommendation: 'LONG',
    latestClose: 182.12,
    sma20: 180.55,
    sma50: 175.42,
    indicators: {
      atr: 2.1,
      atrPct: 0.02,
      avgDollarVolume: 30000000,
      avgRangePct: 0.02,
      rsi: 48.2
    },
    barsCount: 200
  }, {
    regime: {
      trendChop: 'TREND',
      vol: 'CONTRACTION',
      risk: 'RISK_ON',
      notes: []
    }
  });

  const { valid, errors } = validateRecommendation(rec);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});
