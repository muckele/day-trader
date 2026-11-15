const test = require('node:test');
const assert = require('node:assert/strict');
const {
  READINESS_CONFIRMATION_TEXT,
  REQUIRED_EVIDENCE,
  createOperationalAlertFromAudit,
  deliverPendingOperationalAlerts,
  evaluateReadiness,
  recordReadinessEvidence
} = require('../services/roboReadinessService');

function buildShadowSnapshots() {
  return Array.from({ length: 20 }, (_, index) => ({
    capturedAt: new Date(Date.UTC(2026, 6, 1 + (index % 7), 14, index)),
    breached: false
  }));
}

test('readiness remains fail-closed without observation and operator evidence', () => {
  const result = evaluateReadiness({
    settings: { mode: 'shadow', isEnabled: true },
    now: new Date('2026-07-10T00:00:00.000Z')
  });

  assert.equal(result.technicalReady, false);
  assert.equal(result.goLiveReady, false);
  assert.equal(result.status, 'not_ready');
  assert.equal(result.gates.find(gate => gate.key === 'shadow_observation').passed, false);
  assert.equal(result.gates.find(gate => gate.key === 'operator_runbook_reviewed').passed, false);
});

test('failed critical-alert deliveries are retried from the durable alert record', async () => {
  const now = new Date('2026-07-10T00:10:00.000Z');
  let saved = false;
  const alert = {
    severity: 'critical',
    notification: { status: 'failed', attempts: 1, lastAttemptAt: new Date('2026-07-10T00:00:00.000Z') },
    save: async () => { saved = true; }
  };
  const result = await deliverPendingOperationalAlerts({
    now,
    env: {
      NODE_ENV: 'production',
      ROBOTRADER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
      ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN: 'test-token'
    }
  }, {
    RoboOperationalAlert: {
      find: () => ({
        sort: () => ({ limit: async () => [alert] })
      })
    },
    notifyOperationalAlert: async () => ({ delivered: true, status: 'sent', detail: 'Delivered.' })
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.delivered, 1);
  assert.equal(alert.notification.status, 'sent');
  assert.equal(saved, true);
});

test('legacy critical alerts without notification state are included in retry delivery', async () => {
  let capturedQuery = null;
  const alert = {
    severity: 'critical',
    save: async () => null
  };
  const result = await deliverPendingOperationalAlerts({
    now: new Date('2026-07-10T00:10:00.000Z'),
    env: {
      NODE_ENV: 'production',
      ROBOTRADER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
      ROBOTRADER_ALERT_WEBHOOK_BEARER_TOKEN: 'test-token'
    }
  }, {
    RoboOperationalAlert: {
      find: query => {
        capturedQuery = query;
        return { sort: () => ({ limit: async () => [alert] }) };
      }
    },
    notifyOperationalAlert: async () => ({ delivered: true, status: 'sent', detail: 'Delivered.' })
  });

  assert.equal(result.delivered, 1);
  assert.equal(
    capturedQuery.$and[0].$or.some(item => item['notification.status']?.$exists === false),
    true
  );
  assert.equal(alert.notification.status, 'sent');
});

test('readiness reaches go-no-go review only when every technical and evidence gate passes', () => {
  const now = new Date('2026-07-10T00:00:00.000Z');
  const evidence = REQUIRED_EVIDENCE.map(item => ({
    key: item.key,
    status: 'complete',
    expiresAt: new Date('2026-08-10T00:00:00.000Z')
  }));
  const result = evaluateReadiness({
    settings: { mode: 'shadow', isEnabled: true },
    shadowSnapshots: buildShadowSnapshots(),
    evidence,
    activeCriticalAlerts: 0,
    reconciliationIssues: 0,
    brokerOperatorConfigured: true,
    brokerOperatorDetail: 'Exactly one broker-operator identifier is configured.',
    operationalAlertDeliveryConfigured: true,
    operationalAlertDeliveryDetail: 'Operational-alert webhook is configured.',
    now
  });

  assert.equal(result.technicalReady, true);
  assert.equal(result.status, 'ready_for_go_no_go');
  assert.equal(result.goLiveReady, false);
  assert.equal(result.gates.every(gate => gate.passed), true);
});

test('critical audit events create durable operational alerts', async () => {
  const created = [];
  let activationRevoked = false;
  let promotionRevoked = false;
  let settingsInvalidated = false;
  let notificationSent = false;
  const Model = {
    findOne: async () => null,
    create: async payload => {
      created.push(payload);
      return payload;
    }
  };
  const alert = await createOperationalAlertFromAudit({
    userId: 'user-1',
    eventType: 'robotrader_portfolio_risk_pause',
    payload: { environment: 'shadow', reason: 'Gross exposure exceeded.' },
    now: new Date('2026-07-10T00:00:00.000Z')
  }, {
    RoboOperationalAlert: Model,
    RoboLiveActivation: {
      updateOne: async () => {
        activationRevoked = true;
        return { matchedCount: 1 };
      }
    },
    RoboLivePromotion: {
      updateMany: async () => {
        promotionRevoked = true;
        return { modifiedCount: 1 };
      }
    },
    RoboSettings: {
      updateOne: async (_query, update) => {
        settingsInvalidated = update.$inc?.controlGeneration === 1;
        return { modifiedCount: 1 };
      }
    },
    notifyOperationalAlert: async alertPayload => {
      notificationSent = alertPayload.severity === 'critical';
      return { delivered: true, status: 'sent', detail: 'Delivered.' };
    }
  });

  assert.equal(alert.severity, 'critical');
  assert.equal(alert.category, 'portfolio_risk');
  assert.equal(created.length, 1);
  assert.equal(activationRevoked, true);
  assert.equal(promotionRevoked, true);
  assert.equal(settingsInvalidated, true);
  assert.equal(notificationSent, true);
});

test('readiness evidence requires exact confirmation and verified emergency drills', async () => {
  const Model = {
    findOneAndUpdate: async (_query, update) => ({ key: 'emergency_stop_drill', ...update.$set })
  };
  await assert.rejects(
    recordReadinessEvidence({
      userId: 'user-1',
      key: 'operator_runbook_reviewed',
      confirmation: 'close enough'
    }, { RoboReadinessEvidence: Model }),
    /Exact readiness confirmation/
  );
  await assert.rejects(
    recordReadinessEvidence({
      userId: 'user-1',
      key: 'emergency_stop_drill',
      confirmation: READINESS_CONFIRMATION_TEXT
    }, { RoboReadinessEvidence: Model }),
    /must be recorded by running/
  );
  const evidence = await recordReadinessEvidence({
    userId: 'user-1',
    key: 'emergency_stop_drill',
    confirmation: READINESS_CONFIRMATION_TEXT,
    verifiedAction: true,
    now: new Date('2026-07-10T00:00:00.000Z')
  }, { RoboReadinessEvidence: Model });
  assert.equal(evidence.status, 'complete');
});
