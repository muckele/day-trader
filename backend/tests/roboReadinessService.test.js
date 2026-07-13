const test = require('node:test');
const assert = require('node:assert/strict');
const {
  READINESS_CONFIRMATION_TEXT,
  REQUIRED_EVIDENCE,
  createOperationalAlertFromAudit,
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
    }
  });

  assert.equal(alert.severity, 'critical');
  assert.equal(alert.category, 'portfolio_risk');
  assert.equal(created.length, 1);
  assert.equal(activationRevoked, true);
  assert.equal(promotionRevoked, true);
  assert.equal(settingsInvalidated, true);
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
