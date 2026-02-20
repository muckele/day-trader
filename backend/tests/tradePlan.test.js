const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canGeneratePlan,
  applyExposureCap,
  applyTradeToPlan,
  buildPlanOutcome,
  rankStrategies,
  detectMissedWinners
} = require('../tradePlanEngine');

test('plan generation blocked when market is closed', () => {
  assert.equal(canGeneratePlan('CLOSED'), false);
  assert.equal(canGeneratePlan('OPEN'), true);
});

test('applyExposureCap enforces total exposure limit', () => {
  const ideas = [
    { symbol: 'AAPL', positionSizePct: 12 },
    { symbol: 'MSFT', positionSizePct: 10 }
  ];
  const result = applyExposureCap(ideas, 20);
  assert.equal(result.totalSuggestedExposurePct, 20);
  assert.equal(result.tradeIdeas.length, 2);
  assert.equal(result.tradeIdeas[1].positionSizePct, 8);
});

test('rankStrategies orders by higher expectancy and win rate', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const smaTrades = Array.from({ length: 15 }).map(() => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: 10,
    rMultiple: 1,
    regimeAtTrade: regime
  }));
  const meanTrades = Array.from({ length: 15 }).map((_, idx) => ({
    strategyId: 'MEAN_REVERSION_RSI',
    realizedPnl: idx < 6 ? 5 : -5,
    rMultiple: 0.2,
    regimeAtTrade: regime
  }));
  const trades = [...smaTrades, ...meanTrades];

  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked[0].strategyId, 'SMA_CROSS');
});

test('strategy excluded when tradeCount < 15', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const trades = Array.from({ length: 14 }).map(() => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: 5,
    rMultiple: 0.5,
    regimeAtTrade: regime
  }));
  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked.length, 0);
});

test('strategy excluded when expectancy <= 0', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const trades = Array.from({ length: 15 }).map(() => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: -5,
    rMultiple: -0.2,
    regimeAtTrade: regime
  }));
  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked.length, 0);
});

test('strategy excluded when Sharpe-like ratio too low', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const trades = Array.from({ length: 15 }).map((_, idx) => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: idx % 2 === 0 ? 2 : -2,
    rMultiple: idx % 2 === 0 ? 2 : -2,
    regimeAtTrade: regime
  }));
  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked.length, 0);
});

test('strategy excluded when variance too high', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const trades = Array.from({ length: 15 }).map((_, idx) => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: idx % 2 === 0 ? 2 : -1,
    rMultiple: idx % 2 === 0 ? 2 : -1,
    regimeAtTrade: regime
  }));
  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked.length, 0);
});

test('rankStrategies caps sharpe-like before normalization', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const trades = Array.from({ length: 15 }).map(() => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: 10,
    rMultiple: 10,
    regimeAtTrade: regime
  }));
  const ranked = rankStrategies(trades, regime);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sharpeLike, 5);
  assert.equal(ranked[0].sharpeNormalized, 100);
});

test('score reduced when recent performance is weak', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const baseTrades = Array.from({ length: 15 }).map((_, idx) => ({
    strategyId: 'SMA_CROSS',
    realizedPnl: 5,
    rMultiple: 1,
    regimeAtTrade: regime,
    filledAt: new Date(`2024-01-${String(idx + 1).padStart(2, '0')}`)
  }));
  const baseline = rankStrategies(baseTrades, regime);

  const weakRecent = [
    ...baseTrades.slice(0, 10),
    ...Array.from({ length: 5 }).map((_, idx) => ({
      strategyId: 'SMA_CROSS',
      realizedPnl: -2,
      rMultiple: -0.2,
      regimeAtTrade: regime,
      filledAt: new Date(`2024-02-${String(idx + 1).padStart(2, '0')}`)
    }))
  ];
  const ranked = rankStrategies(weakRecent, regime);
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].score < baseline[0].score);
});

test('plan contains no ideas if no viable strategies', () => {
  const outcome = buildPlanOutcome({
    rankedStrategies: [],
    tradeIdeas: [{ symbol: 'AAPL' }],
    totalSuggestedExposurePct: 10
  });
  assert.equal(outcome.tradeIdeas.length, 0);
  assert.equal(outcome.notes, 'No statistically stable strategies today.');
});

test('ranking produces zero list when dataset empty', () => {
  const regime = { trendChop: 'TREND', vol: 'EXPANSION', risk: 'RISK_ON' };
  const ranked = rankStrategies([], regime);
  assert.equal(ranked.length, 0);
});

test('applyTradeToPlan links matching trade to idea', () => {
  const plan = {
    tradeIdeas: [
      { symbol: 'AAPL', strategyId: 'SMA_CROSS', status: 'PENDING' }
    ]
  };
  const trade = { _id: 'trade-1', symbol: 'AAPL', strategyId: 'SMA_CROSS', filledAt: new Date() };
  const idea = applyTradeToPlan(plan, trade);
  assert.equal(idea.status, 'EXECUTED');
  assert.equal(idea.executedTradeId, 'trade-1');
});

test('detectMissedWinners counts unexecuted ideas hitting target', async () => {
  const plan = {
    date: '2024-04-01',
    tradeIdeas: [
      { symbol: 'AAPL', bias: 'LONG', target: 110, status: 'PENDING' },
      { symbol: 'TSLA', bias: 'SHORT', target: 180, status: 'SKIPPED' },
      { symbol: 'MSFT', bias: 'LONG', target: 400, status: 'EXECUTED' }
    ]
  };
  const barsBySymbol = {
    AAPL: [{ t: '2024-04-01T00:00:00Z', h: 115, l: 95 }],
    TSLA: [{ t: '2024-04-01T00:00:00Z', h: 200, l: 175 }]
  };

  const missed = await detectMissedWinners(plan, barsBySymbol, { skipFetch: true });
  assert.equal(missed, 2);
});
