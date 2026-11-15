const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getOperationalEvidence,
  summarizeBlotter,
  summarizeExposures,
  summarizePaperCoverage,
  summarizeStrategyRuns
} = require('../services/operationalEvidenceService');

function createModel(items, calls, name) {
  return {
    async countDocuments(query) {
      calls.push({ name: `${name}:count`, query });
      return items.length;
    },
    find(query) {
      calls.push({ name, query });
      let selectedLimit = items.length;
      const request = {
        populate() {
          return request;
        },
        sort() {
          return request;
        },
        limit(value) {
          selectedLimit = value;
          return request;
        },
        async lean() {
          return items.slice(0, selectedLimit);
        }
      };
      return request;
    }
  };
}

test('strategy scorecards expose qualifying walk-forward evidence and aggregate metrics', () => {
  const scorecards = summarizeStrategyRuns([
    {
      strategyId: 'ROBO_TREND_FOLLOWING_V1',
      strategyName: 'Trend',
      symbol: 'AAPL',
      status: 'completed',
      startedAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:01:00.000Z',
      parameterVersionId: { version: 3 },
      summary: { validationType: 'walk_forward', passed: true },
      metrics: { tradeCount: 36, winRate: 58, avgR: 0.42, maxDrawdown: 6.5, positiveWindowRatePct: 75 }
    },
    {
      strategyId: 'ROBO_TREND_FOLLOWING_V1',
      strategyName: 'Trend',
      symbol: 'MSFT',
      status: 'completed',
      startedAt: '2026-07-02T00:00:00.000Z',
      completedAt: '2026-07-02T00:01:00.000Z',
      parameterVersionId: { version: 3 },
      summary: { validationType: 'walk_forward', passed: false },
      metrics: { tradeCount: 30, winRate: 50, avgR: 0.1, maxDrawdown: 9, positiveWindowRatePct: 60 }
    }
  ]);

  assert.equal(scorecards.length, 1);
  assert.equal(scorecards[0].status, 'validated');
  assert.equal(scorecards[0].walkForwardRunCount, 2);
  assert.equal(scorecards[0].qualifyingWalkForwardRunCount, 1);
  assert.equal(scorecards[0].metricBasis, 'walk_forward');
  assert.deepEqual(scorecards[0].symbols, ['AAPL', 'MSFT']);
  assert.deepEqual(scorecards[0].parameterVersions, ['3']);
  assert.equal(scorecards[0].metrics.meanTradeCount, 33);
  assert.equal(scorecards[0].metrics.meanAverageR, 0.26);
  assert.equal(scorecards[0].metrics.worstMaxDrawdown, 9);
});

test('exposure summary reports peaks, breaches, and chronological chart points', () => {
  const exposure = summarizeExposures([
    {
      capturedAt: '2026-07-02T00:00:00.000Z',
      environment: 'live',
      equity: 10050,
      grossExposurePct: 12,
      netExposurePct: 8,
      totalDrawdownPct: 2,
      dailyDrawdownPct: 1,
      positionCount: 2,
      breached: true,
      breachReasonCodes: ['GROSS_EXPOSURE']
    },
    {
      capturedAt: '2026-07-01T00:00:00.000Z',
      environment: 'paper',
      equity: 10000,
      grossExposurePct: 5,
      netExposurePct: 5,
      totalDrawdownPct: 1,
      dailyDrawdownPct: 0.5,
      positionCount: 1,
      breached: false
    }
  ]);

  assert.equal(exposure.summary.snapshotCount, 2);
  assert.equal(exposure.summary.breachCount, 1);
  assert.equal(exposure.summary.peakGrossExposurePct, 12);
  assert.equal(exposure.summary.latest.environment, 'live');
  assert.equal(exposure.series[0].environment, 'paper');
  assert.equal(exposure.series[1].environment, 'live');
});

test('blotter joins account intents to robo orders and surfaces stale and failed controls', () => {
  const now = new Date('2026-07-19T18:00:00.000Z');
  const blotter = summarizeBlotter([
    {
      _id: 'intent-1',
      requestedAt: '2026-07-19T17:00:00.000Z',
      symbol: 'AAPL',
      environment: 'live',
      status: 'submitted',
      authorizationStatus: 'consumed',
      riskChecks: [{ name: 'drawdown', passed: false, severity: 'critical', message: 'limit' }]
    },
    {
      _id: 'intent-2',
      requestedAt: '2026-07-19T16:00:00.000Z',
      symbol: 'MSFT',
      environment: 'paper',
      status: 'policy_blocked',
      reasonCodes: ['SYMBOL_BLOCKED']
    }
  ], [
    {
      _id: 'order-1',
      intentId: 'intent-1',
      status: 'accepted',
      submittedAt: '2026-07-19T17:00:00.000Z',
      reconciliationStatus: 'pending',
      discrepancy: 'fill not confirmed'
    }
  ], now);

  assert.equal(blotter.rows.length, 2);
  assert.equal(blotter.rows[0].orderId, 'order-1');
  assert.equal(blotter.rows[0].stale, true);
  assert.equal(blotter.rows[0].riskFailures[0].name, 'drawdown');
  assert.equal(blotter.summary.policyBlockedCount, 1);
  assert.equal(blotter.summary.discrepancyCount, 1);
  assert.equal(blotter.summary.staleOpenOrderCount, 1);
});

test('paper coverage groups fills by exact strategy and symbol', () => {
  const coverage = summarizePaperCoverage([
    {
      environment: 'paper',
      strategyId: 'ROBO_TREND',
      symbol: 'aapl',
      status: 'filled',
      qty: 1,
      filledQty: 1,
      submittedAt: '2026-07-18T12:00:00.000Z',
      filledAt: '2026-07-18T12:00:01.000Z',
      side: 'buy',
      filledAvgPrice: 100,
      executionQuality: { metrics: { quote: { price: 99.98 } } }
    },
    { environment: 'paper', strategyId: 'ROBO_TREND', symbol: 'AAPL', status: 'rejected' },
    { environment: 'live', strategyId: 'ROBO_TREND', symbol: 'AAPL', status: 'filled' }
  ]);

  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].filledOrders, 1);
  assert.equal(coverage[0].comparableFills, 1);
  assert.equal(coverage[0].rejectedOrders, 1);
  assert.equal(coverage[0].coveragePct, 5);
});

test('operational evidence queries every collection with the authenticated account scope', async () => {
  const calls = [];
  const deps = {
    isMongoReady: () => true,
    StrategyRun: createModel([], calls, 'StrategyRun'),
    RoboExposureSnapshot: createModel([], calls, 'RoboExposureSnapshot'),
    OrderIntent: createModel([], calls, 'OrderIntent'),
    RoboTradeOrder: createModel([], calls, 'RoboTradeOrder')
  };
  const evidence = await getOperationalEvidence({
    accountId: 'user:abc',
    days: 30,
    limit: 25,
    now: new Date('2026-07-19T00:00:00.000Z')
  }, deps);

  assert.equal(evidence.lookbackDays, 30);
  assert.equal(calls.length, 10);
  assert.ok(calls.every(call => call.query.accountId === 'user:abc'));
  assert.ok(calls.every(call => Object.values(call.query).some(value => value?.$gte instanceof Date)));
  assert.equal(evidence.completeness.complete, true);
});

test('operational evidence preserves missing numeric values and reports truncated collections', async () => {
  const calls = [];
  const manyRuns = Array.from({ length: 3 }, (_, index) => ({
    strategyId: 'ROBO_TEST',
    status: 'completed',
    startedAt: new Date(`2026-07-1${index + 1}T00:00:00.000Z`),
    metrics: { tradeCount: null }
  }));
  const deps = {
    isMongoReady: () => true,
    StrategyRun: createModel(manyRuns, calls, 'StrategyRun'),
    RoboExposureSnapshot: createModel([], calls, 'RoboExposureSnapshot'),
    OrderIntent: createModel([], calls, 'OrderIntent'),
    RoboTradeOrder: createModel([], calls, 'RoboTradeOrder')
  };
  const evidence = await getOperationalEvidence({
    accountId: 'user:abc',
    limit: 2,
    now: new Date('2026-07-19T00:00:00.000Z')
  }, deps);

  assert.equal(evidence.strategyScorecards[0].metrics.meanTradeCount, null);
  assert.equal(evidence.completeness.complete, false);
  assert.equal(evidence.completeness.collections.strategyRuns.truncated, true);
});
