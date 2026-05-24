const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResearch } = require('../robotrader/strategyEngine');

test('strategy engine uses simple market orders for fractional stock sizing', () => {
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
  assert.equal(decision.recommendedOrder.orderClass, 'simple');
  assert.equal(decision.recommendedOrder.extendedHours, false);
  assert.equal(decision.recommendedOrder.stopLoss, null);
  assert.equal(decision.recommendedOrder.takeProfit, null);
  assert.equal(decision.recommendedOrder.riskStopPrice, 195.2);
  assert.equal(decision.recommendedOrder.riskTakeProfitPrice, 209.6);
});

test('strategy engine keeps broker bracket protection for whole-share stock sizing', () => {
  const decision = evaluateResearch({
    symbol: 'AAPL',
    assetClass: 'stocks',
    price: 250,
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
  assert.equal(decision.recommendedOrder.qty, 3);
  assert.equal(decision.recommendedOrder.orderClass, 'bracket');
  assert.deepEqual(decision.recommendedOrder.stopLoss, { stop_price: 244 });
  assert.deepEqual(decision.recommendedOrder.takeProfit, { limit_price: 262 });
  assert.equal(decision.recommendedOrder.extendedHours, false);
});
