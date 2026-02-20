const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeDrawdownSeries,
  aggregateStrategies,
  aggregateRegimes,
  computeRMultiple
} = require('../analytics/analyticsUtils');

test('computeDrawdownSeries returns correct max drawdown', () => {
  const points = [
    { timestamp: '2024-01-01', equity: 100 },
    { timestamp: '2024-01-02', equity: 120 },
    { timestamp: '2024-01-03', equity: 110 },
    { timestamp: '2024-01-04', equity: 130 },
    { timestamp: '2024-01-05', equity: 90 }
  ];
  const result = computeDrawdownSeries(points);
  assert.equal(result.maxDrawdown, 30.77);
});

test('aggregateStrategies groups trades correctly', () => {
  const trades = [
    { strategyId: 'SMA_CROSS', realizedPnl: 100, qty: 1, price: 100, stopPrice: 90 },
    { strategyId: 'SMA_CROSS', realizedPnl: -50, qty: 1, price: 100, stopPrice: 90 },
    { strategyId: 'MEAN_REVERSION_RSI', realizedPnl: 20, qty: 1, price: 50, stopPrice: 45 }
  ];
  const result = aggregateStrategies(trades);
  const sma = result.find(item => item.strategyId === 'SMA_CROSS');
  assert.equal(sma.trades, 2);
  assert.equal(sma.winRate, 50);
});

test('aggregateRegimes maps regime buckets', () => {
  const trades = [
    { realizedPnl: 10, qty: 1, price: 100, stopPrice: 95, regimeAtTrade: { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' } },
    { realizedPnl: -5, qty: 1, price: 100, stopPrice: 95, regimeAtTrade: { trendChop: 'CHOP', vol: 'CONTRACTION', risk: 'RISK_OFF' } }
  ];
  const result = aggregateRegimes(trades);
  assert.equal(result.trendChop.length, 2);
  assert.equal(result.vol.length, 2);
  assert.equal(result.risk.length, 2);
});

test('computeRMultiple returns null when no stop', () => {
  const trade = { realizedPnl: 50, qty: 2, price: 100, stopPrice: null };
  const r = computeRMultiple(trade);
  assert.equal(r, null);
});

test('computeRMultiple calculates correctly with stop', () => {
  const trade = { realizedPnl: 50, qty: 5, price: 100, stopPrice: 90 };
  const r = computeRMultiple(trade);
  assert.equal(Number(r.toFixed(2)), 1);
});
