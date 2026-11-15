const RoboOperationalAlert = require('../models/RoboOperationalAlert');
const RoboReadinessEvidence = require('../models/RoboReadinessEvidence');
const RoboLiveActivation = require('../models/RoboLiveActivation');
const RoboLivePromotion = require('../models/RoboLivePromotion');
const RoboExposureSnapshot = require('../models/RoboExposureSnapshot');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboSettings = require('../models/RoboSettings');
const { getOrCreateRoboTraderSettings, mapSettings } = require('../robotrader/settingsService');
const { getAlpacaConfigForMode } = require('../robotrader/alpacaBroker');
const { isPaperTradingEndpoint } = require('./alpacaTradingClient');
const { getBrokerOperatorConfiguration } = require('./brokerOperatorService');
const {
  getOperationalAlertDeliveryConfiguration,
  notifyOperationalAlert
} = require('./operationalAlertNotifier');

const READINESS_CONFIRMATION_TEXT = 'I completed this readiness check.';
const REQUIRED_EVIDENCE = Object.freeze([
  { key: 'operator_runbook_reviewed', label: 'Operator runbook reviewed', validDays: 90 },
  { key: 'secrets_reviewed', label: 'Secrets and least-privilege review completed', validDays: 90 },
  { key: 'database_indexes_verified', label: 'Production database indexes verified', validDays: 30 },
  { key: 'emergency_stop_drill', label: 'Emergency-stop drill completed', validDays: 30 },
  { key: 'paper_broker_acceptance', label: 'Tiny paper-order broker acceptance completed', validDays: 30 },
  { key: 'disaster_recovery_drill', label: 'Disaster-recovery exercise completed', validDays: 90 }
]);

const ALERT_RULES = Object.freeze({
  robotrader_portfolio_risk_pause: ['critical', 'portfolio_risk', 'Portfolio risk paused RoboTrader.'],
  robotrader_submission_control_invalidated: ['critical', 'control_plane', 'An in-flight submission was invalidated by a settings change or emergency stop.'],
  robotrader_controlled_live_blocked: ['critical', 'controlled_live', 'The controlled-live boundary blocked a broker submission.'],
  robotrader_controlled_live_supervision_lost: ['critical', 'controlled_live', 'The controlled-live supervisor heartbeat expired.'],
  robotrader_strategy_evidence_expired: ['critical', 'controlled_live', 'A promoted activation lost current strategy, walk-forward, or paper/live discrepancy evidence.'],
  robotrader_broker_error: ['critical', 'broker', 'RoboTrader could not load broker account context.'],
  robotrader_order_submit_uncertain: ['critical', 'reconciliation', 'Broker submission outcome is uncertain and requires reconciliation.'],
  robotrader_emergency_stop_unowned_broker_orders: ['critical', 'reconciliation', 'Emergency stop found RoboTrader-like broker orders not owned by the local account record.'],
  robotrader_protective_stop_error: ['critical', 'protection', 'A filled entry did not receive its expected protective stop.'],
  robotrader_order_rejected: ['warning', 'broker', 'The broker rejected a RoboTrader order.'],
  robotrader_authorized_intent_revalidation_failed: ['warning', 'policy', 'An authorized intent failed fresh submission-time revalidation.']
});

function readinessNumber(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasLiveAlpacaConfig(env = process.env) {
  const config = getAlpacaConfigForMode('live', env);
  const hasExplicitKey = Boolean(env.APCA_LIVE_API_KEY_ID || env.ALPACA_LIVE_API_KEY);
  const hasExplicitSecret = Boolean(env.APCA_LIVE_API_SECRET_KEY || env.ALPACA_LIVE_API_SECRET);
  return Boolean(
    hasExplicitKey
    && hasExplicitSecret
    && config.apiKey
    && config.apiSecret
    && !isPaperTradingEndpoint(config.baseUrl)
  );
}

function buildAlertFingerprint(eventType, payload = {}) {
  return [eventType, payload.environment || 'paper', payload.symbol || '', (payload.reasonCodes || []).join(',')].join(':');
}

async function invalidateControlledLiveForCriticalAlert(userId, severity, now, deps) {
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const Settings = deps.RoboSettings || RoboSettings;
  if (severity !== 'critical') return;
  if (typeof Settings?.updateOne === 'function') {
    await Settings.updateOne(
      { userId },
      {
        $set: {
          enabled: false,
          isEnabled: false,
          pausedReason: 'Critical operational alert invalidated controlled-live execution.'
        },
        $inc: { controlGeneration: 1 }
      }
    );
  }
  const updates = [];
  if (typeof Model?.updateOne === 'function') {
    updates.push(Model.updateOne(
      { userId, status: { $in: ['approved', 'active'] } },
      { $set: { status: 'revoked', revokedAt: now } }
    ));
  }
  if (typeof Promotion?.updateMany === 'function') {
    updates.push(Promotion.updateMany(
      { userId, status: 'approved' },
      { $set: { status: 'revoked', revokedAt: now } }
    ));
  }
  await Promise.all(updates);
}

async function deliverCriticalAlert(alert, severity, now, deps = {}) {
  if (severity !== 'critical' || !alert) return;
  try {
    const notify = deps.notifyOperationalAlert || notifyOperationalAlert;
    const result = await notify(alert, { env: deps.env || process.env });
    if (!alert.notification) alert.notification = {};
    alert.notification.status = result.status;
    alert.notification.attempts = Number(alert.notification.attempts || 0) + (result.status === 'disabled' ? 0 : 1);
    alert.notification.lastAttemptAt = result.status === 'disabled' ? null : now;
    alert.notification.lastDeliveredAt = result.delivered ? now : (alert.notification.lastDeliveredAt || null);
    alert.notification.detail = result.detail;
    if (typeof alert.save === 'function') await alert.save();
  } catch (err) {
    console.error('Operational-alert delivery state could not be recorded:', err?.message || err);
  }
}

async function deliverPendingOperationalAlerts({ now = new Date(), env = process.env } = {}, deps = {}) {
  const configuration = getOperationalAlertDeliveryConfiguration(env);
  if (!configuration.configured) return { configured: false, attempted: 0, delivered: 0 };
  const Model = deps.RoboOperationalAlert || RoboOperationalAlert;
  const retryCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  const query = Model.find({
    severity: 'critical',
    status: { $in: ['open', 'acknowledged'] },
    $and: [
      {
        $or: [
          { 'notification.status': { $in: ['failed', 'disabled'] } },
          { 'notification.status': { $exists: false } }
        ]
      },
      {
        $or: [
          { 'notification.lastAttemptAt': null },
          { 'notification.lastAttemptAt': { $exists: false } },
          { 'notification.lastAttemptAt': { $lte: retryCutoff } }
        ]
      }
    ]
  }).sort({ 'notification.lastAttemptAt': 1 }).limit(10);
  const alerts = await query;
  let delivered = 0;
  for (const alert of alerts) {
    await deliverCriticalAlert(alert, 'critical', now, {
      ...deps,
      env
    });
    if (alert.notification?.status === 'sent') delivered += 1;
  }
  return { configured: true, attempted: alerts.length, delivered };
}

async function createOperationalAlertFromAudit({ userId, eventType, payload = {}, now = new Date() }, deps = {}) {
  const rule = ALERT_RULES[eventType];
  const Model = deps.RoboOperationalAlert || RoboOperationalAlert;
  if (!rule || !Model?.findOne) return null;
  const [severity, category, defaultMessage] = rule;
  const fingerprint = buildAlertFingerprint(eventType, payload);
  const existing = await Model.findOne({ userId, fingerprint, active: true });
  if (existing) {
    existing.status = 'open';
    existing.acknowledgedAt = null;
    existing.lastOccurredAt = now;
    existing.occurrences = Number(existing.occurrences || 1) + 1;
    existing.payload = payload;
    await existing.save();
    await invalidateControlledLiveForCriticalAlert(userId, severity, now, deps);
    await deliverCriticalAlert(existing, severity, now, deps);
    return existing;
  }
  try {
    const created = await Model.create({
      userId,
      environment: ['paper', 'shadow', 'live'].includes(payload.environment) ? payload.environment : 'paper',
      eventType,
      category,
      severity,
      active: true,
      fingerprint,
      message: payload.reason || payload.error || defaultMessage,
      payload,
      firstOccurredAt: now,
      lastOccurredAt: now
    });
    await invalidateControlledLiveForCriticalAlert(userId, severity, now, deps);
    await deliverCriticalAlert(created, severity, now, deps);
    return created;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const raced = await Model.findOne({ userId, fingerprint, active: true });
    if (!raced) throw err;
    raced.status = 'open';
    raced.acknowledgedAt = null;
    raced.lastOccurredAt = now;
    raced.occurrences = Number(raced.occurrences || 1) + 1;
    raced.payload = payload;
    await raced.save();
    await invalidateControlledLiveForCriticalAlert(userId, severity, now, deps);
    await deliverCriticalAlert(raced, severity, now, deps);
    return raced;
  }
}

function evaluateReadiness({
  settings = {},
  shadowSnapshots = [],
  activeCriticalAlerts = 0,
  reconciliationIssues = 0,
  evidence = [],
  now = new Date(),
  minShadowRuns = 20,
  minShadowDays = 7,
  liveCredentialsConfigured = false,
  deploymentLiveFlag = false,
  brokerOperatorConfigured = false,
  brokerOperatorDetail = 'No broker operator is configured.',
  operationalAlertDeliveryConfigured = false,
  operationalAlertDeliveryDetail = 'No operational-alert delivery channel is configured.'
} = {}) {
  const validEvidence = new Map(
    evidence.filter(item => item.status === 'complete' && new Date(item.expiresAt) > now)
      .map(item => [item.key, item])
  );
  const snapshotDates = shadowSnapshots.map(item => new Date(item.capturedAt)).filter(date => !Number.isNaN(date.getTime()));
  const distinctDays = new Set(snapshotDates.map(date => date.toISOString().slice(0, 10))).size;
  const shadowBreaches = shadowSnapshots.filter(item => item.breached).length;
  const gates = [
    {
      key: 'single_broker_operator',
      label: 'Exactly one broker operator is configured',
      passed: brokerOperatorConfigured,
      detail: brokerOperatorDetail
    },
    {
      key: 'operational_alert_delivery',
      label: 'Critical operational alerts have an external delivery channel',
      passed: operationalAlertDeliveryConfigured,
      detail: operationalAlertDeliveryDetail
    },
    {
      key: 'shadow_observation',
      label: 'Sustained shadow-live observation',
      passed: shadowSnapshots.length >= minShadowRuns && distinctDays >= minShadowDays,
      detail: `${shadowSnapshots.length}/${minShadowRuns} runs across ${distinctDays}/${minShadowDays} UTC days`
    },
    {
      key: 'shadow_risk_clear',
      label: 'Shadow observation has no risk breach',
      passed: shadowSnapshots.length > 0 && shadowBreaches === 0,
      detail: `${shadowBreaches} breached snapshot(s) in the observation window`
    },
    {
      key: 'critical_alerts_clear',
      label: 'No active critical operational alerts',
      passed: activeCriticalAlerts === 0,
      detail: `${activeCriticalAlerts} active critical alert(s)`
    },
    {
      key: 'reconciliation_clear',
      label: 'No unresolved reconciliation discrepancy',
      passed: reconciliationIssues === 0,
      detail: `${reconciliationIssues} unresolved reconciliation issue(s)`
    },
    ...REQUIRED_EVIDENCE.map(requirement => ({
      key: requirement.key,
      label: requirement.label,
      passed: validEvidence.has(requirement.key),
      detail: validEvidence.has(requirement.key)
        ? `Valid until ${new Date(validEvidence.get(requirement.key).expiresAt).toISOString()}`
        : 'Evidence has not been recorded or has expired.'
    }))
  ];
  const technicalReady = gates.every(gate => gate.passed);
  return {
    status: technicalReady ? 'ready_for_go_no_go' : 'not_ready',
    technicalReady,
    goLiveReady: false,
    assessedAt: now,
    settings: { mode: settings.mode, isEnabled: settings.isEnabled },
    observation: { runs: shadowSnapshots.length, distinctDays, breaches: shadowBreaches, minShadowRuns, minShadowDays },
    safeguards: {
      liveCredentialsConfigured,
      deploymentLiveFlag,
      controlledLiveRemainsDisabled: !deploymentLiveFlag
    },
    gates,
    requiredEvidence: REQUIRED_EVIDENCE
  };
}

async function buildReadinessAssessment({ userId, now = new Date(), env = process.env } = {}, deps = {}) {
  const Settings = deps.getOrCreateRoboTraderSettings || getOrCreateRoboTraderSettings;
  const Exposure = deps.RoboExposureSnapshot || RoboExposureSnapshot;
  const Alerts = deps.RoboOperationalAlert || RoboOperationalAlert;
  const Orders = deps.RoboTradeOrder || RoboTradeOrder;
  const Evidence = deps.RoboReadinessEvidence || RoboReadinessEvidence;
  const minShadowRuns = readinessNumber(env.ROBOTRADER_READINESS_MIN_SHADOW_RUNS, 20);
  const minShadowDays = readinessNumber(env.ROBOTRADER_READINESS_MIN_SHADOW_DAYS, 7);
  const windowDays = readinessNumber(env.ROBOTRADER_READINESS_WINDOW_DAYS, 30);
  const operatorConfiguration = getBrokerOperatorConfiguration(env);
  const alertDeliveryConfiguration = getOperationalAlertDeliveryConfiguration(env);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const settingsDoc = await Settings(userId);
  const [shadowSnapshots, activeCriticalAlerts, reconciliationIssues, evidence] = await Promise.all([
    Exposure.find({ userId, environment: 'shadow', capturedAt: { $gte: cutoff } }).sort({ capturedAt: -1 }).limit(1000).lean(),
    Alerts.countDocuments({ userId, severity: 'critical', status: { $in: ['open', 'acknowledged'] } }),
    Orders.countDocuments({
      userId,
      $or: [
        { reconciliationStatus: { $in: ['submit_error_pending_reconciliation', 'missing_alpaca_confirmation', 'alpaca_lookup_failed', 'orphan_alpaca_order'] } },
        { discrepancy: { $exists: true, $nin: [null, ''] }, reconciliationArchivedAt: null }
      ]
    }),
    Evidence.find({ userId, status: 'complete', expiresAt: { $gt: now } }).lean()
  ]);
  return evaluateReadiness({
    settings: mapSettings(settingsDoc),
    shadowSnapshots,
    activeCriticalAlerts,
    reconciliationIssues,
    evidence,
    now,
    minShadowRuns,
    minShadowDays,
    liveCredentialsConfigured: hasLiveAlpacaConfig(env),
    deploymentLiveFlag: String(env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true',
    brokerOperatorConfigured: operatorConfiguration.configured,
    brokerOperatorDetail: operatorConfiguration.detail,
    operationalAlertDeliveryConfigured: alertDeliveryConfiguration.configured,
    operationalAlertDeliveryDetail: alertDeliveryConfiguration.detail
  });
}

async function recordReadinessEvidence({
  userId,
  key,
  confirmation,
  notes,
  verifiedAction = false,
  now = new Date()
} = {}, deps = {}) {
  const requirement = REQUIRED_EVIDENCE.find(item => item.key === key);
  if (!requirement) {
    const err = new Error('Unknown readiness evidence key.');
    err.status = 400;
    throw err;
  }
  if (confirmation !== READINESS_CONFIRMATION_TEXT) {
    const err = new Error('Exact readiness confirmation text is required.');
    err.status = 400;
    throw err;
  }
  if (key === 'emergency_stop_drill' && !verifiedAction) {
    const err = new Error('Emergency-stop evidence must be recorded by running the emergency-stop drill.');
    err.status = 409;
    throw err;
  }
  const Model = deps.RoboReadinessEvidence || RoboReadinessEvidence;
  const expiresAt = new Date(now.getTime() + requirement.validDays * 24 * 60 * 60 * 1000);
  return Model.findOneAndUpdate(
    { userId, key },
    { $set: { status: 'complete', notes: notes ? String(notes).slice(0, 1000) : null, recordedAt: now, expiresAt } },
    { new: true, upsert: true, runValidators: true }
  );
}

module.exports = {
  ALERT_RULES,
  READINESS_CONFIRMATION_TEXT,
  REQUIRED_EVIDENCE,
  buildReadinessAssessment,
  createOperationalAlertFromAudit,
  deliverCriticalAlert,
  deliverPendingOperationalAlerts,
  evaluateReadiness,
  recordReadinessEvidence
};
