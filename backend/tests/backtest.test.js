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

test('backtest results disclose optimistic same-close execution and omitted trading costs', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ t: new Date(2020, 0, i + 1).toISOString(), c: 100 + i }));
  const result = backtestStrategy(bars, 'SMA_CROSS');
  assert.equal(result.executionSource, 'historical-simulation');
  assert.equal(result.assumptions.fillTiming, 'same_signal_bar_close');
  assert.equal(result.assumptions.sharesPerTrade, 1);
  assert.equal(result.assumptions.startingEquity, 100000);
  assert.equal(result.assumptions.commissionPerTrade, 0);
  assert.equal(result.assumptions.slippageBps, 0);
  assert.match(result.assumptions.warning, /optimistic/i);
});
