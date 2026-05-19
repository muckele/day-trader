const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateUnifiedRisk } = require('../paper/riskEngine');

test('evaluateUnifiedRisk blocks when projected symbol exposure exceeds cap', () => {
  const result = evaluateUnifiedRisk({
    symbol: 'AAPL',
    side: 'buy',
    assetClass: 'equity',
    orderNotional: 25000,
    currentPositionQty: 10,
    account: {
      equity: 100000,
      dailyPnl: 0,
      positions: [
        { symbol: 'AAPL', qty: 10, marketValue: 10000, assetClass: 'equity' }
      ]
    },
    settings: {
      maxDailyLossPct: 2,
      maxSymbolExposurePct: 20,
      maxSectorExposurePct: 50,
      maxCorrelationClusterPct: 60,
      maxVarPct: 25,
      varVolatilityPct: 2.5
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Per-symbol exposure cap exceeded/i);
});

test('evaluateUnifiedRisk blocks when projected VaR exceeds limit', () => {
  const result = evaluateUnifiedRisk({
    symbol: 'NVDA',
    side: 'buy',
    assetClass: 'equity',
    orderNotional: 40000,
    currentPositionQty: 0,
    account: {
      equity: 100000,
      dailyPnl: 0,
      positions: [
        { symbol: 'AAPL', qty: 50, marketValue: 30000, assetClass: 'equity' },
        { symbol: 'MSFT', qty: 40, marketValue: 28000, assetClass: 'equity' }
      ]
    },
    settings: {
      maxDailyLossPct: 2,
      maxSymbolExposurePct: 60,
      maxSectorExposurePct: 90,
      maxCorrelationClusterPct: 90,
      maxVarPct: 1.5,
      varVolatilityPct: 3
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Projected VaR guardrail exceeded/i);
});

test('evaluateUnifiedRisk allows valid crypto trade under separate limits', () => {
  const result = evaluateUnifiedRisk({
    symbol: 'BTCUSD',
    side: 'buy',
    assetClass: 'crypto',
    orderNotional: 1200,
    currentPositionQty: 0,
    account: {
      equity: 50000,
      dailyPnl: -200,
      positions: [
        { symbol: 'AAPL', qty: 10, marketValue: 2000, assetClass: 'equity' }
      ]
    },
    settings: {
      maxDailyLossPct: 2,
      cryptoMaxDailyLossPct: 5,
      maxSymbolExposurePct: 10,
      cryptoMaxPositionPct: 20,
      maxSectorExposurePct: 60,
      maxCorrelationClusterPct: 60,
      maxVarPct: 12,
      varVolatilityPct: 2.5,
      cryptoVarVolPct: 4
    }
  });

  assert.equal(result.ok, true);
});
