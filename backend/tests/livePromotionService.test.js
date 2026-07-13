const test = require('node:test');
const assert = require('node:assert/strict');
const { hashCanonicalEvidence } = require('../services/canaryEvidenceService');
const {
  PROMOTION_APPROVAL_CONFIRMATION,
  PROMOTION_REVOCATION_CONFIRMATION,
  approveRepeatCanaryPromotion,
  buildLivePromotionAssessment,
  enforceStrategyEvidenceDemotion,
  expireLivePromotions,
  revokeRepeatCanaryPromotion,
  validateRepeatCanaryApproval
} = require('../services/livePromotionService');

function readyAssessment() {
  return { technicalReady: true, status: 'ready_for_go_no_go' };
}

function passingStrategyEvidence() {
  return {
    passed: true,
    fingerprint: 'strategy-evidence-fingerprint',
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    parameterVersionId: 'params-1',
    gates: []
  };
}

function passingDiscrepancy() {
  return {
    passed: true,
    fingerprint: 'paper-live-discrepancy-fingerprint',
    slippageDegradationBps: 5,
    gates: []
  };
}

function buildDossier(index, overrides = {}) {
  return {
    schemaVersion: 2,
    activation: {
      canaryId: `canary-${index}`,
      lifecycleStatus: 'reviewed',
      outcome: { status: 'reconciled' },
      reviewNotes: 'Broker fill, position, and protection independently checked.'
    },
    order: {
      _id: `order-${index}`,
      accountId: 'user:matt',
      symbol: 'AAPL',
      side: 'buy',
      assetClass: 'stocks',
      strategyId: 'trend-pullback',
      policyVersion: 'controlled-live-readiness-v2',
      orderClass: 'bracket',
      stopLoss: { stopPrice: 95 },
      status: 'filled',
      filledQty: 1,
      filledAvgPrice: 100,
      reconciliationStatus: 'matched',
      discrepancy: null
    },
    protectiveOrders: [],
    exposure: { breached: false, grossExposurePct: 1 },
    alerts: [],
    audit: [],
    ...overrides
  };
}

function archive(index, sealedAt, overrides = {}) {
  const dossierSnapshot = buildDossier(index, overrides.dossier || {});
  const dossierHash = overrides.dossierHash || hashCanonicalEvidence(dossierSnapshot).hash;
  return {
    _id: `archive-${index}`,
    canaryId: `canary-${index}`,
    sealedAt: new Date(sealedAt),
    dossierHash,
    dossierSnapshot
  };
}

function dossierModel(items) {
  return {
    countDocuments: async () => items.length,
    find: () => {
      const query = {
        sort: () => query,
        limit: () => query,
        lean: async () => items.slice(0, 3)
      };
      return query;
    }
  };
}

const validCohort = [
  archive(3, '2026-07-03T12:00:00.000Z'),
  archive(2, '2026-07-02T12:00:00.000Z'),
  archive(1, '2026-07-01T12:00:00.000Z')
];

test('repeat-canary promotion requires three verified successful dossiers across three days', async () => {
  const assessment = await buildLivePromotionAssessment({
    userId: 'user-1',
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboCanaryDossier: dossierModel(validCohort),
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => passingStrategyEvidence(),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  });

  assert.equal(assessment.eligible, true);
  assert.equal(assessment.dossierCount, 3);
  assert.equal(assessment.distinctDays, 3);
  assert.deepEqual(assessment.allowedSymbols, ['AAPL']);
  assert.equal(assessment.strategyId, 'trend-pullback');
  assert.equal(assessment.gates.every(item => item.passed), true);
});

test('tampered dossier or unsuccessful reconciliation fails promotion closed', async () => {
  const tampered = [
    archive(3, '2026-07-03T12:00:00.000Z', { dossierHash: 'not-the-real-hash' }),
    archive(2, '2026-07-02T12:00:00.000Z'),
    archive(1, '2026-07-01T12:00:00.000Z')
  ];
  const assessment = await buildLivePromotionAssessment({
    userId: 'user-1',
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboCanaryDossier: dossierModel(tampered),
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => passingStrategyEvidence(),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  });

  assert.equal(assessment.eligible, false);
  assert.equal(assessment.gates.find(item => item.key === 'dossier_integrity').passed, false);
});

test('promotion fails when Sprint 8 strategy evidence or execution drift is blocked', async () => {
  const assessment = await buildLivePromotionAssessment({
    userId: 'user-1',
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboCanaryDossier: dossierModel(validCohort),
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => ({
      passed: false,
      fingerprint: 'blocked-evidence',
      expiresAt: null,
      gates: [{ key: 'execution_drift', passed: false }]
    }),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  });

  assert.equal(assessment.eligible, false);
  assert.equal(assessment.gates.find(item => item.key === 'strategy_evidence').passed, false);
});

test('promotion approval is fingerprint-bound, short-lived, and exact-confirmation only', async () => {
  let persisted = null;
  const Promotion = {
    updateMany: async () => ({ modifiedCount: 0 }),
    findOne: () => ({ lean: async () => null }),
    create: async payload => {
      persisted = payload;
      return { _id: 'promotion-1', ...payload };
    }
  };
  const now = new Date('2026-07-05T12:00:00.000Z');
  const promotion = await approveRepeatCanaryPromotion({
    userId: 'user-1',
    confirmation: PROMOTION_APPROVAL_CONFIRMATION,
    notes: 'Reviewed the complete three-canary cohort.',
    now
  }, {
    RoboCanaryDossier: dossierModel(validCohort),
    RoboLivePromotion: Promotion,
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => passingStrategyEvidence(),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  });

  assert.equal(promotion.status, 'approved');
  assert.equal(promotion.allowedSymbols[0], 'AAPL');
  assert.equal(persisted.assessmentFingerprint, promotion.assessmentFingerprint);
  assert.ok(new Date(promotion.expiresAt) > now);
  await assert.rejects(
    approveRepeatCanaryPromotion({ userId: 'user-1', confirmation: 'yes' }),
    /Exact repeat-canary promotion confirmation/
  );
});

test('a promotion is atomically consumed for exactly one subsequent canary approval', async () => {
  let claims = 0;
  const Promotion = {
    findOneAndUpdate: () => ({
      lean: async () => {
        claims += 1;
        return claims === 1 ? { _id: 'promotion-1', status: 'consumed' } : null;
      }
    })
  };
  const deps = {
    RoboCanaryDossier: dossierModel(validCohort),
    RoboLivePromotion: Promotion,
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => passingStrategyEvidence(),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  };
  const input = {
    userId: 'user-1',
    allowedSymbols: ['AAPL'],
    now: new Date('2026-07-05T12:00:00.000Z')
  };
  const first = await validateRepeatCanaryApproval(input, deps);
  assert.equal(first.required, true);
  assert.equal(first.promotion.status, 'consumed');
  await assert.rejects(
    validateRepeatCanaryApproval(input, deps),
    /current, unconsumed repeat-canary promotion/
  );
});

test('an unconsumed expired cohort can be reviewed again but a consumed cohort cannot', async () => {
  const now = new Date('2026-07-05T12:00:00.000Z');
  const common = {
    RoboCanaryDossier: dossierModel(validCohort),
    buildReadinessAssessment: async () => readyAssessment(),
    buildStrategyValidationAssessment: async () => passingStrategyEvidence(),
    buildExecutionDiscrepancyAssessment: async () => passingDiscrepancy()
  };
  const rearmed = await approveRepeatCanaryPromotion({
    userId: 'user-1',
    confirmation: PROMOTION_APPROVAL_CONFIRMATION,
    now
  }, {
    ...common,
    RoboLivePromotion: {
      updateMany: async () => ({ modifiedCount: 1 }),
      findOne: () => ({ lean: async () => ({ _id: 'promotion-expired', status: 'expired', consumedAt: null }) }),
      findOneAndUpdate: () => ({ lean: async () => ({ _id: 'promotion-expired', status: 'approved' }) })
    }
  });
  assert.equal(rearmed.status, 'approved');

  await assert.rejects(
    approveRepeatCanaryPromotion({
      userId: 'user-1',
      confirmation: PROMOTION_APPROVAL_CONFIRMATION,
      now
    }, {
      ...common,
      RoboLivePromotion: {
        updateMany: async () => ({ modifiedCount: 0 }),
        findOne: () => ({ lean: async () => ({ _id: 'promotion-consumed', status: 'consumed', consumedAt: now }) })
      }
    }),
    /already authorized an activation/
  );
});

test('the first three canaries remain bootstrap canaries and do not require promotion', async () => {
  const result = await validateRepeatCanaryApproval({ userId: 'user-1' }, {
    RoboCanaryDossier: dossierModel(validCohort.slice(0, 2))
  });
  assert.deepEqual(result, { required: false, dossierCount: 2 });
});

test('legacy schema-v1 dossiers do not trigger an impossible promotion requirement', async () => {
  let countQuery = null;
  const result = await validateRepeatCanaryApproval({ userId: 'user-1' }, {
    RoboCanaryDossier: {
      countDocuments: async query => {
        countQuery = query;
        return 0;
      }
    }
  });
  assert.equal(result.required, false);
  assert.deepEqual(countQuery['dossierSnapshot.schemaVersion'], { $gte: 2 });
});

test('promotion revocation also revokes a linked approved or active canary', async () => {
  let activationQuery = null;
  const result = await revokeRepeatCanaryPromotion({
    userId: 'user-1',
    confirmation: PROMOTION_REVOCATION_CONFIRMATION,
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboLivePromotion: {
      find: () => ({ lean: async () => [] }),
      updateMany: async () => ({ modifiedCount: 1 })
    },
    RoboLiveActivation: {
      findOne: () => ({
        lean: async () => ({
          _id: 'activation-1',
          promotionId: 'promotion-1',
          status: 'active'
        })
      }),
      findOneAndUpdate: async (query, update) => {
        activationQuery = query;
        return { _id: 'activation-1', ...update.$set };
      }
    },
    RoboSettings: {
      updateOne: async () => ({ modifiedCount: 1 })
    }
  });

  assert.equal(result.activation.status, 'revoked');
  assert.equal(activationQuery.promotionId, 'promotion-1');
});

test('promotion expiry watchdog also demotes stale strategy evidence', async () => {
  let expiryQuery = null;
  await expireLivePromotions({
    userId: 'user-1',
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboLivePromotion: {
      updateMany: async query => {
        expiryQuery = query;
        return { modifiedCount: 1 };
      }
    }
  });

  assert.equal(expiryQuery.userId, 'user-1');
  assert.deepEqual(expiryQuery.$or[1]['strategyEvidence.expiresAt'], {
    $lte: new Date('2026-07-05T12:00:00.000Z')
  });
});

test('stale evidence revokes a consumed promoted activation and disables automation', async () => {
  let settingsUpdate = null;
  const audits = [];
  const alerts = [];
  const activation = {
    _id: 'activation-1',
    userId: 'user-1',
    promotionId: 'promotion-1',
    status: 'active'
  };
  const result = await enforceStrategyEvidenceDemotion({
    now: new Date('2026-07-05T12:00:00.000Z')
  }, {
    RoboLiveActivation: {
      find: () => ({ lean: async () => [activation] }),
      findOneAndUpdate: () => ({
        lean: async () => ({ ...activation, status: 'revoked', lifecycleStatus: 'failed' })
      })
    },
    RoboLivePromotion: {
      findOne: () => ({
        lean: async () => ({
          _id: 'promotion-1',
          status: 'consumed',
          assessmentFingerprint: 'approved-fingerprint'
        })
      }),
      updateOne: async () => ({ modifiedCount: 1 })
    },
    RoboSettings: {
      updateOne: async (_query, update) => {
        settingsUpdate = update;
        return { modifiedCount: 1 };
      }
    },
    RoboAuditLog: { create: async event => audits.push(event) },
    createOperationalAlertFromAudit: async event => alerts.push(event),
    buildLivePromotionAssessment: async () => ({
      eligible: true,
      assessmentFingerprint: 'changed-fingerprint'
    })
  });

  assert.equal(result.revokedCount, 1);
  assert.equal(settingsUpdate.$set.isEnabled, false);
  assert.equal(settingsUpdate.$inc.controlGeneration, 1);
  assert.equal(audits[0].eventType, 'robotrader_strategy_evidence_expired');
  assert.equal(alerts[0].eventType, 'robotrader_strategy_evidence_expired');
});
