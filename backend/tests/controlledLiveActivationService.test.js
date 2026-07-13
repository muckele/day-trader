const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIVE_APPROVAL_CONFIRMATION,
  LIVE_DOSSIER_CONFIRMATION,
  LIVE_HEARTBEAT_CONFIRMATION,
  LIVE_REVIEW_CONFIRMATION,
  LIVE_REVOCATION_CONFIRMATION,
  approveControlledLive,
  claimControlledLiveAttempt,
  buildCanaryDossier,
  buildReadinessFingerprint,
  enforceControlledLiveWatchdog,
  heartbeatControlledLive,
  normalizeCanaryLimits,
  recordControlledLiveOutcome,
  revalidateControlledLiveAttempt,
  revokeControlledLive,
  reviewControlledLiveCanary,
  sealCanaryDossier,
  SUPERVISION_TIMEOUT_MS,
  validateControlledLiveSubmission
} = require('../services/controlledLiveActivationService');

const liveEnv = {
  LIVE_TRADING_ENABLED: 'true',
  APCA_LIVE_API_KEY_ID: 'explicit-live-key',
  APCA_LIVE_API_SECRET_KEY: 'explicit-live-secret',
  APCA_LIVE_BASE_URL: 'https://api.alpaca.markets'
};

function readyAssessment() {
  return {
    technicalReady: true,
    gates: [
      { key: 'shadow_observation', passed: true, detail: '20/20 runs' },
      { key: 'operator_runbook_reviewed', passed: true, detail: 'Valid until 2026-08-01T00:00:00.000Z' }
    ]
  };
}

test('controlled-live limits are clamped to the hard canary envelope', () => {
  const limits = normalizeCanaryLimits({
    maxOrderNotionalUsd: 10000,
    maxDailyOrders: 50,
    maxDailyCumulativeNotionalUsd: 10000,
    activationHours: 100
  });
  assert.deepEqual(limits, {
    maxOrderNotionalUsd: 100,
    maxDailyOrders: 1,
    maxDailyCumulativeNotionalUsd: 100,
    activationHours: 24
  });
});

test('controlled-live approval is bound to a passing readiness fingerprint', async () => {
  let update = null;
  const Model = {
    findOneAndUpdate: async (_query, value) => {
      update = value.$set;
      return { _id: 'activation-1', ...value.$set };
    }
  };
  const activation = await approveControlledLive({
    userId: 'user-1',
    confirmation: LIVE_APPROVAL_CONFIRMATION,
    limits: { maxOrderNotionalUsd: 25 },
    allowedSymbols: ['aapl'],
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    RoboLiveActivation: Model,
    buildReadinessAssessment: async () => readyAssessment(),
    validateRepeatCanaryApproval: async () => ({ required: false, dossierCount: 0 })
  });

  assert.equal(activation.status, 'approved');
  assert.deepEqual(activation.allowedSymbols, ['AAPL']);
  assert.equal(activation.readinessFingerprint, buildReadinessFingerprint(readyAssessment()));
  assert.equal(update.limits.maxOrderNotionalUsd, 25);
});

test('controlled-live submission fails closed while the deployment flag is disabled', async () => {
  const result = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 25 }
  }, {});
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, 'LIVE_DEPLOYMENT_FLAG_DISABLED');
});

test('controlled-live submission enforces activation, allowlist, order, and daily limits', async () => {
  const assessment = readyAssessment();
  const activation = {
    _id: 'activation-1',
    readinessFingerprint: buildReadinessFingerprint(assessment),
    allowedSymbols: ['AAPL'],
    limits: {
      maxOrderNotionalUsd: 25,
      maxDailyOrders: 1,
      maxDailyCumulativeNotionalUsd: 25
    }
  };
  const Activation = {
    find: () => ({ lean: async () => [] }),
    findOne: () => ({ lean: async () => activation }),
    findOneAndUpdate: () => ({ lean: async () => ({ ...activation, attemptsUsed: 1 }) })
  };
  const emptyOrders = { find: () => ({ lean: async () => [] }) };
  const deps = {
    RoboLiveActivation: Activation,
    RoboTradeOrder: emptyOrders,
    buildReadinessAssessment: async () => assessment
  };
  const approved = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 25 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, deps);
  assert.equal(approved.approved, true);

  const wrongSymbol = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'MSFT', qty: 1, orderType: 'limit', limitPrice: 25 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, deps);
  assert.equal(wrongSymbol.reasonCode, 'CANARY_SYMBOL_NOT_ALLOWED');

  const existingOrders = {
    find: () => ({
      lean: async () => [{ symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 10 }]
    })
  };
  const dailyLimit = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 10 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, { ...deps, RoboTradeOrder: existingOrders });
  assert.equal(dailyLimit.reasonCode, 'CANARY_DAILY_ORDER_LIMIT_EXCEEDED');
});

test('promoted submission fails closed when bound strategy evidence is no longer current', async () => {
  const assessment = readyAssessment();
  const activation = {
    _id: 'activation-1',
    promotionId: 'promotion-1',
    readinessFingerprint: buildReadinessFingerprint(assessment),
    allowedSymbols: ['AAPL'],
    limits: { maxOrderNotionalUsd: 25, maxDailyOrders: 1, maxDailyCumulativeNotionalUsd: 25 }
  };
  const result = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 10 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, {
    RoboLiveActivation: {
      find: () => ({ lean: async () => [] }),
      findOne: () => ({ lean: async () => activation })
    },
    RoboLivePromotion: { findOne: () => ({ lean: async () => null }) }
  });
  assert.equal(result.reasonCode, 'PROMOTED_STRATEGY_EVIDENCE_EXPIRED');
});

test('promoted submission revalidates walk-forward and paper/live discrepancy fingerprint', async () => {
  const assessment = readyAssessment();
  const activation = {
    _id: 'activation-1',
    promotionId: 'promotion-1',
    readinessFingerprint: buildReadinessFingerprint(assessment),
    allowedSymbols: ['AAPL'],
    limits: { maxOrderNotionalUsd: 25, maxDailyOrders: 1, maxDailyCumulativeNotionalUsd: 25 }
  };
  const result = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 10 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, {
    RoboLiveActivation: {
      find: () => ({ lean: async () => [] }),
      findOne: () => ({ lean: async () => activation })
    },
    RoboLivePromotion: {
      findOne: () => ({
        lean: async () => ({ assessmentFingerprint: 'approved-fingerprint' })
      })
    },
    buildLivePromotionAssessment: async () => ({
      eligible: true,
      assessmentFingerprint: 'changed-fingerprint'
    })
  });
  assert.equal(result.reasonCode, 'PROMOTED_EVIDENCE_CHANGED');
});

test('the activation attempt slot is claimed atomically only at the broker boundary', async () => {
  const assessment = readyAssessment();
  const activation = {
    _id: 'activation-1',
    readinessFingerprint: buildReadinessFingerprint(assessment),
    allowedSymbols: ['AAPL'],
    limits: { maxOrderNotionalUsd: 25, maxDailyOrders: 1, maxDailyCumulativeNotionalUsd: 25 }
  };
  const validation = await validateControlledLiveSubmission({
    userId: 'user-1',
    orderInput: { symbol: 'AAPL', qty: 1, orderType: 'limit', limitPrice: 10 },
    now: new Date('2026-07-10T14:00:00.000Z'),
    env: liveEnv
  }, {
    RoboLiveActivation: {
      find: () => ({ lean: async () => [] }),
      findOne: () => ({ lean: async () => activation }),
      findOneAndUpdate: () => ({ lean: async () => null })
    },
    RoboTradeOrder: { find: () => ({ lean: async () => [] }) },
    buildReadinessAssessment: async () => assessment
  });
  assert.equal(validation.approved, true);
  const blocked = await claimControlledLiveAttempt({
    activationId: activation._id,
    userId: 'user-1',
    now: new Date('2026-07-10T14:00:00.000Z')
  }, {
    RoboLiveActivation: {
      findOneAndUpdate: () => ({ lean: async () => null })
    }
  });
  assert.equal(blocked, null);

  let outcomeUpdate = null;
  await recordControlledLiveOutcome({
    activationId: 'activation-1',
    status: 'submission_uncertain',
    now: new Date('2026-07-10T14:01:00.000Z')
  }, {
    RoboLiveActivation: {
      findOneAndUpdate: async (_query, update) => {
        outcomeUpdate = update.$set;
        return update.$set;
      }
    }
  });
  assert.equal(outcomeUpdate.status, 'revoked');
  assert.equal(outcomeUpdate.lifecycleStatus, 'failed');

  const record = {
    status: 'active',
    save: async function save() { return this; }
  };
  const reviewed = await reviewControlledLiveCanary({
    userId: 'user-1',
    confirmation: LIVE_REVIEW_CONFIRMATION,
    notes: 'Broker and protection reconciled.',
    now: new Date('2026-07-10T14:05:00.000Z')
  }, { RoboLiveActivation: { findOne: async () => record } });
  assert.equal(reviewed.lifecycleStatus, 'reviewed');
  assert.equal(reviewed.status, 'revoked');
});

test('controlled-live heartbeat requires explicit supervision and advances a five-minute deadline', async () => {
  const now = new Date('2026-07-10T14:00:00.000Z');
  let update = null;
  const activation = await heartbeatControlledLive({
    userId: 'user-1',
    confirmation: LIVE_HEARTBEAT_CONFIRMATION,
    sessionId: 'dashboard-session-1',
    now
  }, {
    RoboLiveActivation: {
      findOneAndUpdate: async (_query, value) => {
        update = value.$set;
        return { _id: 'activation-1', ...value.$set };
      }
    }
  });

  assert.equal(activation.supervisorSessionId, 'dashboard-session-1');
  assert.equal(update.supervisionDeadlineAt.getTime(), now.getTime() + SUPERVISION_TIMEOUT_MS);
  await assert.rejects(
    heartbeatControlledLive({ userId: 'user-1', confirmation: 'yes', sessionId: 'session' }),
    /Exact active-supervision confirmation/
  );
});

test('controlled-live revocation invalidates the worker generation before revoking activation', async () => {
  const operations = [];
  const activation = await revokeControlledLive({
    userId: 'user-1',
    confirmation: LIVE_REVOCATION_CONFIRMATION,
    now: new Date('2026-07-10T14:00:00.000Z')
  }, {
    RoboSettings: {
      updateOne: async (_query, update) => {
        operations.push({ type: 'settings', update });
      }
    },
    RoboLiveActivation: {
      findOneAndUpdate: async (_query, update) => {
        operations.push({ type: 'activation', update });
        return { _id: 'activation-1', ...update.$set };
      }
    }
  });
  assert.equal(operations[0].type, 'settings');
  assert.equal(operations[0].update.$inc.controlGeneration, 1);
  assert.equal(operations[1].type, 'activation');
  assert.equal(activation.status, 'revoked');
});

test('final controlled-live revalidation requires the claimed active lifecycle', async () => {
  let receivedQuery = null;
  const result = await revalidateControlledLiveAttempt({
    activationId: 'activation-1',
    userId: 'user-1',
    now: new Date('2026-07-10T14:00:00.000Z')
  }, {
    RoboLiveActivation: {
      findOne: query => {
        receivedQuery = query;
        return { lean: async () => ({ _id: 'activation-1' }) };
      }
    }
  });
  assert.equal(result._id, 'activation-1');
  assert.equal(receivedQuery.status, 'active');
  assert.equal(receivedQuery.attemptsUsed, 1);
  assert.equal(receivedQuery.lifecycleStatus, 'attempt_claimed');
});

test('watchdog atomically revokes stale supervision, disables automation, and raises an alert', async () => {
  const now = new Date('2026-07-10T14:10:00.000Z');
  const candidate = {
    _id: 'activation-1',
    userId: 'user-1',
    supervisionDeadlineAt: new Date('2026-07-10T14:05:00.000Z'),
    activationExpiresAt: new Date('2026-07-10T18:00:00.000Z')
  };
  let settingsUpdate = null;
  const auditEvents = [];
  const alerts = [];
  const result = await enforceControlledLiveWatchdog({ now }, {
    RoboLiveActivation: {
      find: () => ({ lean: async () => [candidate] }),
      findOneAndUpdate: (_query, update) => ({
        lean: async () => ({ ...candidate, ...update.$set })
      })
    },
    RoboSettings: {
      updateMany: async (query, update) => {
        settingsUpdate = { query, update };
      }
    },
    RoboAuditLog: { create: async event => auditEvents.push(event) },
    createOperationalAlertFromAudit: async event => alerts.push(event)
  });

  assert.equal(result.modifiedCount, 1);
  assert.equal(result.activations[0].status, 'revoked');
  assert.equal(result.activations[0].outcome.status, 'supervision_lost');
  assert.equal(settingsUpdate.update.$set.isEnabled, false);
  assert.equal(settingsUpdate.update.$inc.controlGeneration, 1);
  assert.equal(auditEvents[0].eventType, 'robotrader_controlled_live_supervision_lost');
  assert.equal(alerts[0].eventType, 'robotrader_controlled_live_supervision_lost');
});

function listQuery(items) {
  const query = {
    sort: () => query,
    limit: () => query,
    lean: async () => items
  };
  return query;
}

test('reviewed canary dossier is canonical, durable, and sealed only once', async () => {
  const activation = {
    _id: { toHexString: () => 'activation-1' },
    userId: { toHexString: () => 'user-1' },
    lifecycleStatus: 'reviewed',
    approvedAt: new Date('2026-07-10T14:00:00.000Z'),
    reviewedAt: new Date('2026-07-10T14:10:00.000Z'),
    liveOrderId: 'order-1',
    dossierHash: null,
    dossierSealedAt: null,
    dossierSnapshot: null,
    updatedAt: new Date('2026-07-10T14:11:00.000Z')
  };
  const order = {
    _id: 'order-1',
    intentId: 'intent-1',
    decisionId: 'decision-1',
    exposureSnapshotId: 'exposure-1',
    reconciliationStatus: 'matched'
  };
  let sealUpdate = null;
  let archiveUpdate = null;
  const Activation = {
    findOne: () => ({ lean: async () => activation }),
    findOneAndUpdate: async (_query, update) => {
      sealUpdate = update.$set;
      return { ...activation, ...update.$set };
    }
  };
  const deps = {
    RoboLiveActivation: Activation,
    RoboCanaryDossier: {
      findOneAndUpdate: async (_query, update) => {
        archiveUpdate = update.$setOnInsert;
        return update.$setOnInsert;
      }
    },
    RoboTradeOrder: {
      findOne: () => ({ lean: async () => order }),
      find: () => listQuery([])
    },
    OrderIntent: { findOne: () => ({ lean: async () => ({ _id: 'intent-1', fingerprint: 'abc' }) }) },
    RoboTradeDecision: { findOne: () => ({ lean: async () => ({ _id: 'decision-1', status: 'filled' }) }) },
    RoboExposureSnapshot: { findOne: () => ({ lean: async () => ({ _id: 'exposure-1', breached: false }) }) },
    RoboOperationalAlert: { find: () => listQuery([{ _id: 'alert-1', status: 'resolved' }]) },
    RoboAuditLog: { find: () => listQuery([{ _id: 'audit-1', eventType: 'robotrader_controlled_live_reviewed' }]) }
  };
  const now = new Date('2026-07-10T14:12:00.000Z');
  const first = await buildCanaryDossier({ userId: 'user-1', now }, deps);
  const sealed = await sealCanaryDossier({
    userId: 'user-1',
    confirmation: LIVE_DOSSIER_CONFIRMATION,
    now
  }, deps);

  assert.equal(sealed.hash, first.hash);
  assert.deepEqual(sealUpdate.dossierSnapshot, first.dossier);
  assert.deepEqual(archiveUpdate.dossierSnapshot, first.dossier);
  assert.equal(first.dossier.activation.dossierHash, undefined);
  activation.dossierHash = sealed.hash;
  activation.dossierSealedAt = now;
  activation.dossierSnapshot = first.dossier;
  activation.updatedAt = new Date('2026-07-10T14:13:00.000Z');
  const rebuilt = await buildCanaryDossier({
    userId: 'user-1',
    now: new Date('2026-07-11T14:00:00.000Z')
  }, deps);
  assert.equal(rebuilt.hash, sealed.hash);
  await assert.rejects(
    sealCanaryDossier({ userId: 'user-1', confirmation: LIVE_DOSSIER_CONFIRMATION, now }, deps),
    /already been sealed/
  );
});
