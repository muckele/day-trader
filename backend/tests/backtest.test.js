const test = require('node:test');
const assert = require('node:assert/strict');
const { backtestStrategy } = require('../backtest/backtestEngine');

test('backtest SMA_CROSS produces trades and metrics', () => {
  const closes = [
    ...Array.from({ length: 50 }, () => 100),
    ...Array.from({ length: 10 }, () => 110),
    ...Array.from({ length: 10 }, () => 90),
    ...Array.from({ length: 10 }, () => 100)
  ];
  const bars = closes.map((close, index) => ({
    t: new Date(2020, 0, index + 1).toISOString(),
    c: close,
    h: close + 1,
    l: close - 1,
    v: 1000000
  }));

  const result = backtestStrategy(bars, 'SMA_CROSS');
  assert.equal(result.strategyId, 'SMA_CROSS');
  assert.ok(result.tradeCount >= 1);
  assert.ok(Array.isArray(result.trades));
  assert.ok(Array.isArray(result.equityCurve));
});
