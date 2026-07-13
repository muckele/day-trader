const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExecutionDiscrepancyAssessment,
  fillLatencyMs,
  fillRatio
} = require('../services/executionDiscrepancyService');

function queryResult(items) {
  const query = {
    sort: () => query,
    limit: () => query,
    lean: async () => items
  };
  return query;
}

function order(index, { environment = 'paper', symbol = 'AAPL', fillPrice = 100.05, status = 'filled', latencyMs = 1000 } = {}) {
  const submittedAt = new Date(Date.UTC(2026, 6, 1, 14, 0, index));
  return {
    _id: `${environment}-${symbol}-${index}`,
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    environment,
    symbol,
    side: 'buy',
    qty: 1,
    filledQty: status === 'filled' ? 1 : 0,
    filledAvgPrice: status === 'filled' ? fillPrice : null,
    status,
    submittedAt,
    filledAt: status === 'filled' ? new Date(submittedAt.getTime() + latencyMs) : null,
    executionQuality: { metrics: { quote: { price: 100 } } },
    createdAt: submittedAt
  };
}

function dossierFromOrder(value) {
  return { order: value };
}

test('paper-versus-live discrepancy passes with adequate comparable fills and bounded degradation', async () => {
  const paperOrders = [
    ...Array.from({ length: 20 }, (_, index) => order(index, { symbol: 'AAPL', fillPrice: 100.05 })),
    ...Array.from({ length: 20 }, (_, index) => order(index + 30, { symbol: 'MSFT', fillPrice: 100.06 }))
  ];
  const assessment = await buildExecutionDiscrepancyAssessment({
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    symbols: ['AAPL', 'MSFT'],
    dossiers: [
      dossierFromOrder(order(70, { environment: 'live', symbol: 'AAPL', fillPrice: 100.1, latencyMs: 1500 })),
      dossierFromOrder(order(71, { environment: 'live', symbol: 'MSFT', fillPrice: 100.12, latencyMs: 1800 }))
    ],
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    RoboTradeOrder: { find: () => queryResult(paperOrders) }
  });

  assert.equal(assessment.passed, true);
  assert.equal(assessment.perSymbol.every(item => item.comparableFills === 20), true);
  assert.ok(assessment.slippageDegradationBps <= 15);
  assert.equal(assessment.gates.every(item => item.passed), true);
});

test('paper-versus-live discrepancy fails closed on poor coverage, rejects, partial fills, or drift', async () => {
  const paperOrders = [
    ...Array.from({ length: 5 }, (_, index) => order(index)),
    order(20, { status: 'rejected' }),
    order(21, { status: 'rejected' })
  ];
  const partialLive = order(30, { environment: 'live', fillPrice: 101, latencyMs: 10000 });
  partialLive.filledQty = 0.5;
  const assessment = await buildExecutionDiscrepancyAssessment({
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    symbols: ['AAPL'],
    dossiers: [dossierFromOrder(partialLive)],
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    RoboTradeOrder: { find: () => queryResult(paperOrders) }
  });

  assert.equal(assessment.passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'paper_fill_coverage').passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'paper_rejection_rate').passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'fill_completeness').passed, false);
  assert.equal(assessment.gates.find(item => item.key === 'slippage_discrepancy').passed, false);
});

test('fill comparison helpers reject missing or inverted evidence', () => {
  assert.equal(fillRatio({ qty: 2, filledQty: 1 }), 0.5);
  assert.equal(fillRatio({ notional: 100, filledQty: 1 }), null);
  assert.equal(fillLatencyMs({ submittedAt: '2026-07-01T00:00:00Z', filledAt: '2026-07-01T00:00:01Z' }), 1000);
  assert.equal(fillLatencyMs({ submittedAt: '2026-07-01T00:00:02Z', filledAt: '2026-07-01T00:00:01Z' }), null);
});

test('a healthy high-volume symbol cannot dilute another symbol rejection rate', async () => {
  const aapl = Array.from({ length: 200 }, (_, index) => order(index, { symbol: 'AAPL' }));
  const msft = [
    ...Array.from({ length: 20 }, (_, index) => order(index + 300, { symbol: 'MSFT' })),
    ...Array.from({ length: 20 }, (_, index) => order(index + 400, { symbol: 'MSFT', status: 'rejected' }))
  ];
  const assessment = await buildExecutionDiscrepancyAssessment({
    accountId: 'user:matt',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    symbols: ['AAPL', 'MSFT'],
    dossiers: [
      dossierFromOrder(order(700, { environment: 'live', symbol: 'AAPL' })),
      dossierFromOrder(order(701, { environment: 'live', symbol: 'MSFT' }))
    ],
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    RoboTradeOrder: {
      find: query => queryResult(query.symbol === 'AAPL' ? aapl : msft)
    }
  });
  assert.equal(assessment.passed, false);
  assert.equal(assessment.perSymbol.find(item => item.symbol === 'MSFT').paperRejectionRatePct, 50);
  assert.equal(assessment.gates.find(item => item.key === 'paper_rejection_rate').passed, false);
});

test('notional orders can produce a bounded fill ratio', () => {
  assert.equal(fillRatio({ notional: 100, filledQty: 1, filledAvgPrice: 99 }), 0.99);
});
