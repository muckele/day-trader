const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICY_VERSION } = require('../services/canonicalTradingPolicyService');
const { buildPreLiveEvidenceAssessment } = require('../services/preLiveEvidenceService');

function queryResult(items) {
  const query = {
    sort: () => query,
    lean: async () => items
  };
  return query;
}

function passingDeps(decisions) {
  return {
    User: {
      findById: () => ({ lean: async () => ({ _id: 'user-1', username: 'matt' }) })
    },
    RoboTradeDecision: { find: () => queryResult(decisions) },
    buildStrategyValidationAssessment: async args => ({
      passed: true,
      parameterVersionId: 'parameter-version-1',
      fingerprint: 'strategy-fingerprint',
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      symbols: args.symbols,
      gates: []
    }),
    buildPaperExecutionReadinessAssessment: async args => ({
      passed: true,
      fingerprint: 'paper-evidence-fingerprint',
      parameterVersionId: args.parameterVersionId,
      symbols: args.symbols,
      gates: [],
      perSymbol: args.symbols.map(symbol => ({
        symbol,
        totalOrders: 25,
        comparableFills: 20,
        paperRejectionRatePct: 0,
        meanSlippageBps: 5,
        p95FillLatencyMs: 1500,
        meanFillRatio: 1,
        passed: true
      }))
    })
  };
}

test('pre-live evidence binds approved shadow candidates to qualifying strategy and paper evidence', async () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const decisions = ['AAPL', 'MSFT'].map((symbol, index) => ({
    _id: `decision-${index}`,
    symbol,
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameterVersionId: 'parameter-version-1',
    policyVersion: POLICY_VERSION,
    decidedAt: now,
    orderFingerprint: `fingerprint-${index}`
  }));
  const assessment = await buildPreLiveEvidenceAssessment({
    userId: 'user-1',
    allowedSymbols: ['msft', 'aapl'],
    now
  }, passingDeps(decisions));

  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.symbols, ['AAPL', 'MSFT']);
  assert.equal(assessment.strategyId, 'ROBO_TREND_FOLLOWING_V1');
  assert.equal(typeof assessment.fingerprint, 'string');
  assert.equal(assessment.paperAssessment.fingerprint, 'paper-evidence-fingerprint');
  assert.equal(assessment.expiresAt.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(assessment.gates.every(gate => gate.passed), true);
});

test('pre-live evidence fails closed when passing paper aggregates lack an evidence fingerprint', async () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const decisions = [{
    _id: 'decision-aapl',
    symbol: 'AAPL',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameterVersionId: 'parameter-version-1',
    policyVersion: POLICY_VERSION,
    decidedAt: now
  }];
  const deps = passingDeps(decisions);
  deps.buildPaperExecutionReadinessAssessment = async () => ({ passed: true, perSymbol: [], gates: [] });

  const assessment = await buildPreLiveEvidenceAssessment({
    userId: 'user-1',
    allowedSymbols: ['AAPL'],
    now
  }, deps);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.gates.find(gate => gate.key === 'paper_execution_evidence').passed, false);
});

test('pre-live evidence fails closed when an intended symbol lacks an approved shadow candidate', async () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const assessment = await buildPreLiveEvidenceAssessment({
    userId: 'user-1',
    allowedSymbols: ['AAPL', 'MSFT'],
    now
  }, passingDeps([{
    _id: 'decision-aapl',
    symbol: 'AAPL',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameterVersionId: 'parameter-version-1',
    policyVersion: POLICY_VERSION,
    decidedAt: now
  }]));

  assert.equal(assessment.passed, false);
  assert.equal(
    assessment.gates.find(gate => gate.key === 'shadow_candidate_coverage').passed,
    false
  );
});

test('pre-live evidence fails closed when walk-forward or paper evidence uses another parameter version', async () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const decisions = [{
    _id: 'decision-aapl',
    symbol: 'AAPL',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameterVersionId: 'parameter-version-1',
    policyVersion: POLICY_VERSION,
    decidedAt: now
  }];
  const deps = passingDeps(decisions);
  deps.buildStrategyValidationAssessment = async () => ({
    passed: true,
    parameterVersionId: 'different-parameter-version',
    fingerprint: 'strategy-fingerprint',
    gates: []
  });

  const assessment = await buildPreLiveEvidenceAssessment({
    userId: 'user-1',
    allowedSymbols: ['AAPL'],
    now
  }, deps);

  assert.equal(assessment.passed, false);
  assert.equal(assessment.gates.find(gate => gate.key === 'walk_forward_strategy_evidence').passed, false);
});
