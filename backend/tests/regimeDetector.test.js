const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTrend, classifyVolatility } = require('../signal/regimeDetector');

test('classifyTrend returns TREND with strong spread and slope', () => {
  const result = classifyTrend({ sma20: 110, sma50: 100, slope20: 0.2 });
  assert.equal(result, 'TREND');
});

test('classifyTrend returns CHOP with weak spread', () => {
  const result = classifyTrend({ sma20: 101, sma50: 100, slope20: 0.001 });
  assert.equal(result, 'CHOP');
});

test('classifyVolatility returns EXPANSION when ATR pct exceeds vol proxy', () => {
  const result = classifyVolatility({ atrPct: 0.05, rollingVol: 0.02 });
  assert.equal(result, 'EXPANSION');
});
