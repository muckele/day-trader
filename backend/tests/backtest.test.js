const test = require('node:test');
const assert = require('node:assert/strict');
const { backtestStrategy, computeMetrics } = require('../backtest/backtestEngine');

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

test('backtest engine accepts every canonical RoboTrader strategy id', () => {
  const bars = Array.from({ length: 260 }, (_, index) => {
    const wave = Math.sin(index / 8) * 8;
    const close = 100 + index * 0.08 + wave;
    return {
      t: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      c: close,
      h: close + 1,
      l: close - 1,
      v: 1000000 + (index % 30 === 0 ? 800000 : 0)
    };
  });
  for (const strategyId of [
    'ROBO_MOMENTUM_BREAKOUT_V1',
    'ROBO_MEAN_REVERSION_V1',
    'ROBO_TREND_FOLLOWING_V1',
    'ROBO_RISK_OFF_PROTECTION_V1'
  ]) {
    const result = backtestStrategy(bars, strategyId);
    assert.equal(result.strategyId, strategyId);
    assert.ok(Array.isArray(result.trades));
    assert.ok(Array.isArray(result.equityCurve));
  }
});

test('backtest trade-start boundary uses warm-up bars for indicators without carrying an in-sample position', () => {
  const closes = [
    ...Array.from({ length: 50 }, () => 100),
    ...Array.from({ length: 10 }, () => 110),
    ...Array.from({ length: 20 }, () => 90)
  ];
  const bars = closes.map((close, index) => ({
    t: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
    c: close,
    h: close + 1,
    l: close - 1,
    v: 1000000
  }));
  const result = backtestStrategy(bars, 'SMA_CROSS', { tradeStartAt: bars[60].t });
  assert.equal(result.tradeCount, 0);
});

test('drawdown includes loss from starting equity before the first curve point', () => {
  const metrics = computeMetrics({
    trades: [],
    equityCurve: [{ timestamp: '2026-01-01', equity: 90000 }],
    startingEquity: 100000
  });
  assert.equal(metrics.maxDrawdown, 10);
});

test('backtest closes terminal positions and reports explicit executable assumptions', () => {
  const closes = Array.from({ length: 80 }, (_, index) => 140 - index * 0.5);
  const bars = closes.map((close, index) => ({
    t: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    c: close,
    h: close + 0.2,
    l: close - 0.2,
    v: 2000000
  }));
  const result = backtestStrategy(bars, 'ROBO_MEAN_REVERSION_V1');
  assert.equal(result.assumptions.terminalPositionPolicy, 'close_at_window_end');
  assert.equal(result.assumptions.slippageBps, 25);
  assert.equal(result.trades.every(trade => Boolean(trade.exitReason)), true);
});

test('advertised breakout-volume strategy has an executable backtest path', () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({
    t: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    c: index === 79 ? 130 : 100 + Math.sin(index / 4),
    h: index === 79 ? 131 : 101 + Math.sin(index / 4),
    l: index === 79 ? 129 : 99 + Math.sin(index / 4),
    v: index === 79 ? 5000000 : 1000000
  }));
  const result = backtestStrategy(bars, 'BREAKOUT_VOLUME');
  assert.equal(result.strategyId, 'BREAKOUT_VOLUME');
  assert.ok(result.tradeCount >= 1);
});
