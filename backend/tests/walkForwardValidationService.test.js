const test = require('node:test');
const assert = require('node:assert/strict');
const backtestRouter = require('../routes/backtest');
const {
  aggregateWindowMetrics,
  normalizeWalkForwardParameters,
  runWalkForwardValidation
} = require('../services/walkForwardValidationService');

test('walk-forward validation creates ordered train/test windows without look-ahead', () => {
  const bars = Array.from({ length: 260 }, (_, index) => {
    const close = 100 + Math.sin(index / 5) * 12 + index * 0.02;
    return {
      t: new Date(Date.UTC(2024, 0, index + 1)).toISOString(),
      c: close,
      h: close + 1,
      l: close - 1,
      v: 1000000 + (index % 15 === 0 ? 500000 : 0)
    };
  });
  const result = runWalkForwardValidation({
    bars,
    strategyId: 'ROBO_MEAN_REVERSION_V1',
    trainBars: 100,
    testBars: 20,
    stepBars: 20
  });

  assert.ok(result.windows.length >= 3);
  assert.ok(result.windows.every(window => window.trainEnd < window.testStart));
  assert.equal(result.parameters.trainBars, 100);
  assert.equal(result.validationType, 'walk_forward');
});

test('walk-forward aggregate metrics preserve out-of-sample stability', () => {
  const windows = [1, 2, 3].map((index, windowIndex) => ({
    outOfSample: {
      metrics: { avgR: windowIndex === 2 ? -0.1 : 0.5, maxDrawdown: 4 + windowIndex },
      trades: Array.from({ length: 10 }, (_, tradeIndex) => ({
        pnl: tradeIndex < 6 ? 1 : -1,
        rMultiple: tradeIndex < 6 ? 0.5 : -0.25,
        window: index
      }))
    }
  }));
  const metrics = aggregateWindowMetrics(windows);
  assert.equal(metrics.tradeCount, 30);
  assert.equal(metrics.positiveWindowRatePct, 66.67);
  assert.equal(metrics.maxDrawdown, 6);
});

test('authenticated walk-forward backtest endpoint is registered', () => {
  const route = backtestRouter.stack.find(layer => (
    layer.route?.path === '/walk-forward' && layer.route.methods.post
  ));
  assert.ok(route);
});

test('promotion-grade walk-forward windows cannot overlap', () => {
  const normalized = normalizeWalkForwardParameters({ trainBars: 252, testBars: 120, stepBars: 20 });
  assert.equal(normalized.testBars, 120);
  assert.equal(normalized.stepBars, 120);
});

test('aggregate metrics deduplicate a repeated trade identity defensively', () => {
  const trade = {
    symbol: 'AAPL',
    entryDate: '2026-01-01',
    exitDate: '2026-01-02',
    side: 'long',
    entryPrice: 100,
    exitPrice: 102,
    pnl: 2,
    rMultiple: 1
  };
  const metrics = aggregateWindowMetrics([
    { outOfSample: { metrics: { avgR: 1, maxDrawdown: 1 }, trades: [trade] } },
    { outOfSample: { metrics: { avgR: 1, maxDrawdown: 1 }, trades: [trade] } }
  ]);
  assert.equal(metrics.tradeCount, 1);
});
