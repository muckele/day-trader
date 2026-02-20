const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot } = require('../analytics/snapshot');

test('buildSnapshot returns required fields', () => {
  const trades = [
    {
      strategyId: 'SMA_CROSS',
      realizedPnl: 100,
      rMultiple: 2,
      regimeAtTrade: { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' }
    },
    {
      strategyId: 'SMA_CROSS',
      realizedPnl: -50,
      rMultiple: -1,
      regimeAtTrade: { trendChop: 'CHOP', vol: 'CONTRACTION', risk: 'RISK_OFF' }
    }
  ];
  const equityPoints = [
    { timestamp: '2024-01-01', equity: 100 },
    { timestamp: '2024-01-02', equity: 120 },
    { timestamp: '2024-01-03', equity: 90 }
  ];

  const snapshot = buildSnapshot({
    range: '30d',
    trades,
    equityPoints,
    guardrailBlocks: 2
  });

  assert.equal(snapshot.range, '30d');
  assert.ok(snapshot.asOf);
  assert.ok(!Number.isNaN(Date.parse(snapshot.asOf)));
  assert.ok(Object.hasOwn(snapshot, 'expectancy'));
  assert.ok(Object.hasOwn(snapshot, 'sharpeLike'));
  assert.equal(typeof snapshot.drawdown.maxDrawdown, 'number');
  assert.ok(Array.isArray(snapshot.strategyBreakdown));
  assert.equal(typeof snapshot.regimeBreakdown, 'object');
  assert.equal(typeof snapshot.guardrailBlocks, 'number');
});

test('buildSnapshot caps sharpeLike at 5', () => {
  const trades = Array.from({ length: 3 }).map(() => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: 10,
    rMultiple: 10,
    regimeAtTrade: { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' }
  }));
  const equityPoints = [{ timestamp: '2024-01-01', equity: 100 }];

  const snapshot = buildSnapshot({
    range: '7d',
    trades,
    equityPoints,
    guardrailBlocks: 0
  });

  assert.equal(snapshot.sharpeLike, 5);
});
