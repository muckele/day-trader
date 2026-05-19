const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResearch } = require('../robotrader/strategyEngine');

test('strategy engine does not mark bracket stock orders as extended-hours just because the setting is enabled', () => {
  const decision = evaluateResearch({
    symbol: 'AAPL',
    assetClass: 'stocks',
    price: 200,
    indicators: {
      twentyDayChangePct: 8,
      volumeRatio: 2,
      sma20: 210,
      sma50: 190,
      sma200: 180,
      atrPct: 2
    }
  }, {
    allowExtendedHours: true,
    allowFractionalShares: true,
    maxTradeAmount: 1000,
    riskLevel: 'balanced'
  });

  assert.equal(decision.action, 'buy');
  assert.equal(decision.recommendedOrder.orderClass, 'bracket');
  assert.equal(decision.recommendedOrder.extendedHours, false);
});
