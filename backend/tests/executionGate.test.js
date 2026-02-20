const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExecutionGate, calculateStrategyStats } = require('../executionGate');

function makeTrades(rValues) {
  return rValues.map((r, idx) => ({
    strategyId: 'SMA_CROSS',
    rMultiple: r,
    realizedPnl: r,
    filledAt: new Date(2024, 0, idx + 1)
  }));
}

const baseIdea = {
  symbol: 'AAPL',
  strategyId: 'SMA_CROSS',
  bias: 'LONG',
  entry: 100,
  stop: 95,
  positionSizePct: 5,
  confidenceScore: 75,
  alignmentScore: 60
};

const baseAccount = {
  equity: 100000,
  positionsValue: 0,
  dailyPnl: 0
};

const baseSettings = {
  startingCash: 100000,
  consecutiveLosses: 0
};

test('execution gate blocks when tradeCount < 30', () => {
  const trades = makeTrades(Array.from({ length: 29 }, () => 0.5));
  const result = evaluateExecutionGate({
    idea: baseIdea,
    trades,
    account: baseAccount,
    settings: baseSettings
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonsBlocked.some(reason => reason.includes('trade count')));
});

test('execution gate blocks when Sharpe-like ratio too low', () => {
  const rValues = Array.from({ length: 30 }).map((_, idx) => (idx % 2 === 0 ? 1 : -0.8));
  const trades = makeTrades(rValues);
  const result = evaluateExecutionGate({
    idea: baseIdea,
    trades,
    account: baseAccount,
    settings: baseSettings
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonsBlocked.some(reason => reason.includes('Sharpe-like')));
});

test('execution gate blocks when daily drawdown exceeds 1.5%', () => {
  const trades = makeTrades(Array.from({ length: 30 }, () => 0.6));
  const result = evaluateExecutionGate({
    idea: baseIdea,
    trades,
    account: { ...baseAccount, dailyPnl: -2000 },
    settings: baseSettings
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonsBlocked.some(reason => reason.includes('drawdown')));
});

test('execution gate allows when all conditions satisfied', () => {
  const trades = makeTrades(Array.from({ length: 30 }, () => 0.6));
  const result = evaluateExecutionGate({
    idea: baseIdea,
    trades,
    account: baseAccount,
    settings: baseSettings
  });
  assert.equal(result.eligible, true);
});

test('execution gate circuit breaker blocks on consecutive losses', () => {
  const trades = makeTrades(Array.from({ length: 30 }, () => 0.6));
  const result = evaluateExecutionGate({
    idea: baseIdea,
    trades,
    account: baseAccount,
    settings: { ...baseSettings, consecutiveLosses: 3 }
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasonsBlocked.some(reason => reason.includes('Circuit breaker')));
});

test('calculateStrategyStats caps sharpe-like at 5', () => {
  const trades = makeTrades(Array.from({ length: 30 }, () => 10));
  const stats = calculateStrategyStats(trades);
  assert.equal(stats.sharpeLike, 5);
});
