const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStrategyValidationAssessment,
  extractRealizedSlippageBps
} = require('../services/strategyValidationService');

function queryResult(items) {
  const query = {
    sort: () => query,
    lean: async () => items
  };
  return query;
}

function dossier(fillPrice = 100.1) {
  return {
    order: {
      side: 'buy',
      filledAvgPrice: fillPrice,
      executionQuality: { metrics: { quote: { price: 100 } } }
    }
  };
}

test('strategy evidence passes with recent parameter-consistent backtests and bounded live drift', async () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const assessment = await buildStrategyValidationAssessment({
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    symbols: ['AAPL', 'MSFT'],
    dossiers: [dossier(100.1), dossier(100.2), dossier(99.95)],
    now
  }, {
    StrategyRun: {
      find: () => queryResult([
        {
          _id: 'run-aapl',
          symbol: 'AAPL',
          parameterVersionId: 'params-1',
          completedAt: new Date('2026-07-01T00:00:00.000Z'),
          metrics: {
            tradeCount: 40,
            winRate: 55,
            avgR: 0.3,
            maxDrawdown: 5,
            windowCount: 4,
            positiveWindowRatePct: 75
          }
        },
        {
          _id: 'run-msft',
          symbol: 'MSFT',
          parameterVersionId: 'params-1',
          completedAt: new Date('2026-07-02T00:00:00.000Z'),
          metrics: {
            tradeCount: 35,
            winRate: 52,
            avgR: 0.2,
            maxDrawdown: 7,
            windowCount: 4,
            positiveWindowRatePct: 75
          }
        }
      ])
    },
    StrategyParameterVersion: {
      findOne: () => ({
        lean: async () => ({
          _id: 'params-1',
          version: 1,
          parameterHash: 'parameter-hash-1',
          parameters: { timeframe: '1D' },
          createdAt: new Date('2026-06-30T00:00:00.000Z')
        })
      })
    }
  });

  assert.equal(assessment.passed, true);
  assert.equal(assessment.parameterVersionId, 'params-1');
  assert.equal(assessment.meanSlippageBps, 8.33);
  assert.equal(assessment.gates.every(item => item.passed), true);
});

test('strategy evidence fails closed for stale coverage, weak metrics, parameter drift, or excessive slippage', async () => {
  const assessment = await buildStrategyValidationAssessment({
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    symbols: ['AAPL', 'MSFT'],
    dossiers: [dossier(100.8)],
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    StrategyRun: {
      find: () => queryResult([{
        _id: 'run-aapl',
        symbol: 'AAPL',
        parameterVersionId: 'params-1',
        completedAt: new Date('2026-07-01T00:00:00.000Z'),
        metrics: { tradeCount: 10, winRate: 40, avgR: -0.1, maxDrawdown: 15 }
      }])
    },
    StrategyParameterVersion: {
      findOne: () => ({ lean: async () => null })
    }
  });

  assert.equal(assessment.passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'backtest_coverage').passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'backtest_quality').passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'execution_drift').passed, false);
});

test('realized slippage is direction-aware and fails when reference evidence is missing', () => {
  assert.equal(extractRealizedSlippageBps(dossier(100.25)), 25);
  assert.equal(extractRealizedSlippageBps({
    order: {
      side: 'sell',
      filledAvgPrice: 99.75,
      executionQuality: { metrics: { quote: { price: 100 } } }
    }
  }), 25);
  assert.equal(extractRealizedSlippageBps({ order: { filledAvgPrice: 100 } }), null);
});
