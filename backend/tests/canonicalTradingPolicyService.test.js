const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPROVAL_MODES,
  POLICY_VERSION,
  REASON_CODES,
  buildOrderFingerprint,
  evaluateCanonicalTradingPolicy,
  normalizeApprovalPolicy
} = require('../services/canonicalTradingPolicyService');

const baseOrder = {
  symbol: 'AAPL',
  assetClass: 'stocks',
  side: 'buy',
  orderType: 'limit',
  orderClass: 'simple',
  timeInForce: 'day',
  qty: 1,
  limitPrice: 200,
  estimatedNotional: 200,
  stopLoss: { stop_price: 190 },
  strategyId: 'TEST_STRATEGY'
};

const passingRisk = {
  approved: true,
  checks: [{ name: 'market_hours', passed: true, message: 'Market is open.' }],
  rejectionReasons: []
};

test('order fingerprints are deterministic across object key order', () => {
  const first = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: baseOrder
  });
  const second = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: {
      limitPrice: 200,
      qty: 1,
      side: 'buy',
      symbol: 'aapl',
      strategyId: 'TEST_STRATEGY',
      stopLoss: { stop_price: 190 },
      assetClass: 'stocks',
      orderClass: 'simple',
      orderType: 'limit',
      timeInForce: 'day',
      estimatedNotional: 200
    }
  });

  assert.equal(first.orderFingerprint, second.orderFingerprint);
  assert.deepEqual(first.orderSnapshot, second.orderSnapshot);
});

test('order fingerprints change when an execution field changes', () => {
  const first = buildOrderFingerprint({ accountId: 'account-1', environment: 'live', orderInput: baseOrder });
  const second = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: { ...baseOrder, limitPrice: 201 }
  });

  assert.notEqual(first.orderFingerprint, second.orderFingerprint);
});

test('paper policy does not require per-order authorization', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'paper',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: passingRisk
  });

  assert.equal(result.approved, true);
  assert.equal(result.approval.required, false);
  assert.equal(result.approval.status, 'not_required');
  assert.equal(result.policyVersion, POLICY_VERSION);
});

test('live every-trade policy blocks without authorization', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: passingRisk,
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approved, false);
  assert.equal(result.decisionStatus, 'pending_manual_approval');
  assert.deepEqual(result.reasonCodes, [REASON_CODES.AUTHORIZATION_REQUIRED]);
});

test('live authorization must be active, unexpired, and match the exact order', () => {
  const fingerprint = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: baseOrder
  }).orderFingerprint;
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: passingRisk,
    authorization: {
      id: 'authorization-1',
      status: 'active',
      policyVersion: POLICY_VERSION,
      orderFingerprint: fingerprint,
      expiresAt: '2026-07-13T14:05:00.000Z'
    },
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approved, true);
  assert.equal(result.approval.status, 'valid');
  assert.equal(result.approval.authorizationId, 'authorization-1');
});

test('authorization mismatch produces a stable veto code', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: passingRisk,
    authorization: {
      status: 'active',
      policyVersion: POLICY_VERSION,
      orderFingerprint: 'different-order',
      expiresAt: '2026-07-13T14:05:00.000Z'
    },
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approved, false);
  assert.ok(result.reasonCodes.includes(REASON_CODES.AUTHORIZATION_ORDER_MISMATCH));
});

test('failed risk checks map to stable reason codes', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'paper',
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: {
      approved: false,
      checks: [
        { name: 'market_hours', passed: false, message: 'Market is closed.' },
        { name: 'buying_power', passed: false, message: 'Buying power is insufficient.' }
      ],
      rejectionReasons: ['Market is closed.', 'Buying power is insufficient.']
    }
  });

  assert.equal(result.approved, false);
  assert.deepEqual(result.reasonCodes, [
    REASON_CODES.MARKET_CLOSED,
    REASON_CODES.BUYING_POWER_INSUFFICIENT
  ]);
});

test('legacy positive manual threshold maps to above-threshold approval mode', () => {
  const policy = normalizeApprovalPolicy({}, 25);
  assert.equal(policy.mode, APPROVAL_MODES.ABOVE_THRESHOLD);
  assert.equal(policy.thresholdUsd, 25);
});

test('above-threshold policy fails closed when live notional is unknown', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: {
      approvalPolicy: { mode: APPROVAL_MODES.ABOVE_THRESHOLD, thresholdUsd: 25 }
    },
    decision: { confidenceScore: 80 },
    orderInput: {
      ...baseOrder,
      qty: null,
      notional: null,
      estimatedNotional: null,
      limitPrice: null
    },
    riskResult: passingRisk,
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approved, false);
  assert.equal(result.approval.required, true);
  assert.ok(result.reasonCodes.includes(REASON_CODES.ORDER_NOTIONAL_UNVERIFIED));
  assert.ok(result.reasonCodes.includes(REASON_CODES.AUTHORIZATION_REQUIRED));
});

test('conservative effective notional prevents understated estimates from bypassing approval', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: {
      approvalPolicy: { mode: APPROVAL_MODES.ABOVE_THRESHOLD, thresholdUsd: 5000 }
    },
    decision: { confidenceScore: 80 },
    orderInput: {
      ...baseOrder,
      qty: 100,
      limitPrice: 100,
      estimatedNotional: 100
    },
    riskResult: passingRisk,
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.effectiveNotional.value, 10000);
  assert.equal(result.approval.required, true);
  assert.equal(result.approved, false);
  assert.ok(result.reasonCodes.includes(REASON_CODES.AUTHORIZATION_REQUIRED));
});

test('score bands enforce no-trade and live review-only boundaries', () => {
  const evaluate = (score, environment = 'live') => evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment,
    settings: { approvalPolicy: { mode: APPROVAL_MODES.AUTONOMOUS } },
    decision: { confidenceScore: score },
    orderInput: baseOrder,
    riskResult: passingRisk
  });

  assert.equal(evaluate(69, 'paper').reasonCodes.includes(REASON_CODES.SCORE_BELOW_MINIMUM), true);
  assert.equal(evaluate(70).reasonCodes.includes(REASON_CODES.SCORE_REVIEW_ONLY), true);
  assert.equal(evaluate(79).approved, false);
  assert.equal(evaluate(80).approved, true);
  assert.equal(evaluate(89).scoreBand, '80_89');
  assert.equal(evaluate(90).scoreBand, '90_plus');
});

test('a valid authorization cannot override a below-minimum score', () => {
  const fingerprint = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: baseOrder
  }).orderFingerprint;
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 69 },
    orderInput: baseOrder,
    riskResult: passingRisk,
    authorization: {
      id: 'authorization-1',
      status: 'active',
      policyVersion: POLICY_VERSION,
      orderFingerprint: fingerprint,
      expiresAt: '2026-07-13T14:05:00.000Z'
    },
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approval.valid, true);
  assert.equal(result.approved, false);
  assert.equal(result.decisionStatus, 'rejected');
  assert.ok(result.reasonCodes.includes(REASON_CODES.SCORE_BELOW_MINIMUM));
});

test('authorization from another policy version is rejected', () => {
  const fingerprint = buildOrderFingerprint({
    accountId: 'account-1',
    environment: 'live',
    orderInput: baseOrder
  }).orderFingerprint;
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'live',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: passingRisk,
    authorization: {
      status: 'active',
      policyVersion: 'obsolete-policy',
      orderFingerprint: fingerprint,
      expiresAt: '2026-07-13T14:05:00.000Z'
    },
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(result.approved, false);
  assert.equal(result.approval.status, 'policy_version_mismatch');
  assert.ok(result.reasonCodes.includes(REASON_CODES.AUTHORIZATION_POLICY_VERSION_MISMATCH));
});

test('execution and portfolio vetoes map to stable canonical reason codes', () => {
  const result = evaluateCanonicalTradingPolicy({
    accountId: 'account-1',
    environment: 'shadow',
    settings: { approvalPolicy: { mode: APPROVAL_MODES.EVERY_TRADE } },
    decision: { confidenceScore: 80 },
    orderInput: baseOrder,
    riskResult: {
      approved: false,
      checks: [
        { name: 'quote_fresh', passed: false, message: 'The execution quote is stale.' },
        { name: 'gross_exposure_limit', passed: false, message: 'Gross exposure is too high.' },
        {
          name: 'working_order_exposure_verified',
          passed: false,
          message: 'Working-order exposure could not be valued.'
        }
      ],
      rejectionReasons: [
        'The execution quote is stale.',
        'Gross exposure is too high.',
        'Working-order exposure could not be valued.'
      ]
    }
  });

  assert.equal(result.approved, false);
  assert.ok(result.reasonCodes.includes(REASON_CODES.QUOTE_STALE));
  assert.ok(result.reasonCodes.includes(REASON_CODES.GROSS_EXPOSURE_LIMIT_EXCEEDED));
  assert.ok(result.reasonCodes.includes(REASON_CODES.WORKING_ORDER_EXPOSURE_UNVERIFIED));
  assert.equal(result.approval.required, false);
});
