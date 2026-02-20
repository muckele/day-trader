const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateQualityGate } = require('../signal/qualityGate');

test('quality gate blocks low dollar volume', () => {
  const result = evaluateQualityGate({
    latestClose: 20,
    avgDollarVolume: 1000000,
    atrPct: 0.02,
    avgRangePct: 0.02,
    barsCount: 200
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockedReasons.length > 0);
});

test('quality gate blocks high ATR percent', () => {
  const result = evaluateQualityGate({
    latestClose: 50,
    avgDollarVolume: 50000000,
    atrPct: 0.2,
    avgRangePct: 0.02,
    barsCount: 200
  });
  assert.equal(result.passed, false);
});
