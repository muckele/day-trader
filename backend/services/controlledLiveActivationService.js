const crypto = require('node:crypto');
const RoboLiveActivation = require('../models/RoboLiveActivation');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const OrderIntent = require('../models/OrderIntent');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboOperationalAlert = require('../models/RoboOperationalAlert');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboExposureSnapshot = require('../models/RoboExposureSnapshot');
const RoboSettings = require('../models/RoboSettings');
const RoboCanaryDossier = require('../models/RoboCanaryDossier');
const RoboLivePromotion = require('../models/RoboLivePromotion');
const { deriveEffectiveNotional } = require('./canonicalTradingPolicyService');
const { buildReadinessAssessment, createOperationalAlertFromAudit } = require('./roboReadinessService');
const { getAlpacaConfigForMode } = require('../robotrader/alpacaBroker');
const { isPaperTradingEndpoint } = require('./alpacaTradingClient');
const { hashCanonicalEvidence } = require('./canaryEvidenceService');

const LIVE_APPROVAL_CONFIRMATION = 'I approve a controlled live canary.';
const LIVE_ACTIVATION_CONFIRMATION = 'Activate controlled live canary now.';
const LIVE_REVOCATION_CONFIRMATION = 'Revoke controlled live canary now.';
const LIVE_REVIEW_CONFIRMATION = 'I reviewed and reconciled this canary.';
const LIVE_HEARTBEAT_CONFIRMATION = 'I am actively supervising this canary.';
const LIVE_DOSSIER_CONFIRMATION = 'Seal this canary evidence dossier.';
const SUPERVISION_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_LIMITS = Object.freeze({
  maxOrderNotionalUsd: 100,
  maxDailyOrders: 1,
  maxDailyCumulativeNotionalUsd: 100,
  maxActivationHours: 24
});

function clamp(value, fallback, min, max) {
  const numeric = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : fallback));
}

function normalizeSymbols(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(item => String(item || '').trim().toUpperCase().replace(/[^A-Z0-9./-]/g, '')).filter(Boolean))];
}

function normalizeCanaryLimits(input = {}) {
  return {
    maxOrderNotionalUsd: clamp(input.maxOrderNotionalUsd, 25, 1, HARD_LIMITS.maxOrderNotionalUsd),
    maxDailyOrders: Math.floor(clamp(input.maxDailyOrders, 1, 1, HARD_LIMITS.maxDailyOrders)),
    maxDailyCumulativeNotionalUsd: clamp(
      input.maxDailyCumulativeNotionalUsd,
      25,
      1,
      HARD_LIMITS.maxDailyCumulativeNotionalUsd
    ),
    activationHours: clamp(input.activationHours, 4, 1, HARD_LIMITS.maxActivationHours)
  };
}

function buildReadinessFingerprint(assessment = {}) {
  const snapshot = {
    technicalReady: assessment.technicalReady === true,
    gates: (assessment.gates || []).map(gate => ({
      key: gate.key,
      passed: gate.passed === true,
      evidenceValidity: String(gate.detail || '').startsWith('Valid until ') ? gate.detail : null
    })).sort((a, b) => a.key.localeCompare(b.key))
  };
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function hasExplicitLiveCredentials(env = process.env) {
  const config = getAlpacaConfigForMode('live', env);
  return Boolean(
    (env.APCA_LIVE_API_KEY_ID || env.ALPACA_LIVE_API_KEY)
    && (env.APCA_LIVE_API_SECRET_KEY || env.ALPACA_LIVE_API_SECRET)
    && config.apiKey
    && config.apiSecret
    && !isPaperTradingEndpoint(config.baseUrl)
  );
}

async function approveControlledLive({ userId, confirmation, limits, allowedSymbols, notes, now = new Date(), env = process.env } = {}, deps = {}) {
  if (confirmation !== LIVE_APPROVAL_CONFIRMATION) {
    const err = new Error('Exact controlled-live approval confirmation is required.');
    err.status = 400;
    throw err;
  }
  const assessment = await (deps.buildReadinessAssessment || buildReadinessAssessment)({ userId, now, env });
  if (!assessment.technicalReady) {
    const err = new Error('Sprint 3 readiness gates must all pass before controlled-live approval.');
    err.status = 409;
    throw err;
  }
  const symbols = normalizeSymbols(allowedSymbols);
  if (!symbols.length) {
    const err = new Error('At least one explicit canary symbol is required.');
    err.status = 400;
    throw err;
  }
  const validatePromotion = deps.validateRepeatCanaryApproval
    || require('./livePromotionService').validateRepeatCanaryApproval;
  const promotionValidation = await validatePromotion({ userId, allowedSymbols: symbols, now, env }, deps);
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const normalizedLimits = normalizeCanaryLimits(limits);
  return Model.findOneAndUpdate(
    { userId },
    { $set: {
      status: 'approved',
      canaryId: crypto.randomUUID(),
      promotionId: promotionValidation?.promotion?._id || null,
      readinessFingerprint: buildReadinessFingerprint(assessment),
      limits: normalizedLimits,
      allowedSymbols: symbols,
      approvedAt: now,
      approvalExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      activatedAt: null,
      activationExpiresAt: null,
      revokedAt: null,
      attemptsUsed: 0,
      lastAttemptAt: null,
      liveOrderId: null,
      lifecycleStatus: 'armed',
      outcome: null,
      reviewedAt: null,
      reviewNotes: null,
      supervisionHeartbeatAt: null,
      supervisionDeadlineAt: null,
      supervisorSessionId: null,
      dossierHash: null,
      dossierSealedAt: null,
      dossierSnapshot: null,
      notes: notes ? String(notes).slice(0, 1000) : null
    } },
    { new: true, upsert: true, runValidators: true }
  );
}

async function activateControlledLive({ userId, confirmation, now = new Date(), env = process.env } = {}, deps = {}) {
  if (confirmation !== LIVE_ACTIVATION_CONFIRMATION) {
    const err = new Error('Exact controlled-live activation confirmation is required.');
    err.status = 400;
    throw err;
  }
  if (String(env.LIVE_TRADING_ENABLED || '').toLowerCase() !== 'true' || !hasExplicitLiveCredentials(env)) {
    const err = new Error('Deployment live flag and explicit live-only Alpaca credentials are required.');
    err.status = 409;
    throw err;
  }
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const record = await Model.findOne({ userId, status: 'approved', approvalExpiresAt: { $gt: now } });
  if (!record) {
    const err = new Error('A current controlled-live approval is required.');
    err.status = 409;
    throw err;
  }
  const assessment = await (deps.buildReadinessAssessment || buildReadinessAssessment)({ userId, now, env });
  if (!assessment.technicalReady || buildReadinessFingerprint(assessment) !== record.readinessFingerprint) {
    const err = new Error('Readiness evidence changed after approval; approve a new controlled-live snapshot.');
    err.status = 409;
    throw err;
  }
  record.status = 'active';
  record.activatedAt = now;
  record.activationExpiresAt = new Date(now.getTime() + record.limits.activationHours * 60 * 60 * 1000);
  record.attemptsUsed = 0;
  record.lifecycleStatus = 'armed';
  record.supervisionHeartbeatAt = null;
  record.supervisionDeadlineAt = new Date(now.getTime() + SUPERVISION_TIMEOUT_MS);
  record.supervisorSessionId = null;
  await record.save();
  return record;
}

async function validateControlledLiveSubmission({ userId, orderInput, now = new Date(), env = process.env } = {}, deps = {}) {
  const fail = (reasonCode, message, metadata = {}) => ({ approved: false, reasonCode, message, metadata });
  if (String(env.LIVE_TRADING_ENABLED || '').toLowerCase() !== 'true') {
    return fail('LIVE_DEPLOYMENT_FLAG_DISABLED', 'The deployment live-trading flag is disabled.');
  }
  if (!hasExplicitLiveCredentials(env)) {
    return fail('LIVE_CREDENTIALS_NOT_CONFIGURED', 'Explicit live-only Alpaca credentials are not configured.');
  }
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const Orders = deps.RoboTradeOrder || RoboTradeOrder;
  await enforceControlledLiveWatchdog({ userId, now }, deps);
  const activation = await Activation.findOne({
    userId,
    status: 'active',
    activationExpiresAt: { $gt: now },
    supervisionDeadlineAt: { $gt: now }
  }).lean();
  if (!activation) return fail('CONTROLLED_LIVE_NOT_ACTIVE', 'No current controlled-live activation exists.');
  if (activation.promotionId) {
    const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
    const promotion = await Promotion.findOne({
      _id: activation.promotionId,
      userId,
      status: 'consumed',
      'strategyEvidence.expiresAt': { $gt: now }
    }).lean();
    if (!promotion) {
      return fail('PROMOTED_STRATEGY_EVIDENCE_EXPIRED', 'The promoted activation no longer has current strategy-validation evidence.');
    }
    const promotionAssessmentBuilder = deps.buildLivePromotionAssessment
      || require('./livePromotionService').buildLivePromotionAssessment;
    const currentPromotionAssessment = await promotionAssessmentBuilder({ userId, now, env }, deps);
    if (
      !currentPromotionAssessment.eligible
      || currentPromotionAssessment.assessmentFingerprint !== promotion.assessmentFingerprint
    ) {
      return fail('PROMOTED_EVIDENCE_CHANGED', 'The promoted strategy, walk-forward, or paper/live discrepancy evidence changed after approval.');
    }
  }
  const assessment = await (deps.buildReadinessAssessment || buildReadinessAssessment)({ userId, now, env });
  if (!assessment.technicalReady || buildReadinessFingerprint(assessment) !== activation.readinessFingerprint) {
    return fail('READINESS_CHANGED', 'Readiness gates or evidence changed after controlled-live approval.');
  }
  const symbol = normalizeSymbols([orderInput?.symbol])[0];
  if (!symbol || !activation.allowedSymbols.includes(symbol)) {
    return fail('CANARY_SYMBOL_NOT_ALLOWED', 'The symbol is outside the controlled-live canary allowlist.', { symbol });
  }
  const notional = deriveEffectiveNotional(orderInput);
  if (!notional.authoritative || notional.value <= 0) {
    return fail('CANARY_NOTIONAL_UNVERIFIED', 'Controlled-live order notional could not be verified.');
  }
  if (notional.value > activation.limits.maxOrderNotionalUsd) {
    return fail('CANARY_ORDER_LIMIT_EXCEEDED', 'The order exceeds the controlled-live per-order limit.', { notional: notional.value });
  }
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const orders = await Orders.find({
    userId,
    environment: 'live',
    createdAt: { $gte: dayStart }
  }).lean();
  const usedNotional = orders.reduce((sum, order) => sum + deriveEffectiveNotional(order).value, 0);
  if (orders.length >= activation.limits.maxDailyOrders) {
    return fail('CANARY_DAILY_ORDER_LIMIT_EXCEEDED', 'The controlled-live daily order limit is exhausted.');
  }
  if (usedNotional + notional.value > activation.limits.maxDailyCumulativeNotionalUsd) {
    return fail('CANARY_DAILY_NOTIONAL_LIMIT_EXCEEDED', 'The controlled-live daily cumulative notional limit would be exceeded.');
  }
  return { approved: true, activationId: activation._id, notional: notional.value, symbol };
}

async function claimControlledLiveAttempt({ activationId, userId, now = new Date() } = {}, deps = {}) {
  if (!activationId || !userId) return null;
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const claimedQuery = Activation.findOneAndUpdate(
    {
      _id: activationId,
      userId,
      status: 'active',
      activationExpiresAt: { $gt: now },
      supervisionDeadlineAt: { $gt: now },
      attemptsUsed: { $lt: 1 }
    },
    {
      $inc: { attemptsUsed: 1 },
      $set: { lastAttemptAt: now, lifecycleStatus: 'attempt_claimed' }
    },
    { new: true }
  );
  return typeof claimedQuery?.lean === 'function' ? claimedQuery.lean() : claimedQuery;
}

async function revalidateControlledLiveAttempt({ activationId, userId, now = new Date() } = {}, deps = {}) {
  if (!activationId || !userId) return null;
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const query = Activation.findOne({
    _id: activationId,
    userId,
    status: 'active',
    activationExpiresAt: { $gt: now },
    supervisionDeadlineAt: { $gt: now },
    attemptsUsed: 1,
    lifecycleStatus: 'attempt_claimed'
  });
  return typeof query?.lean === 'function' ? query.lean() : query;
}

async function recordControlledLiveOutcome({ activationId, liveOrderId = null, status, details = {}, now = new Date() } = {}, deps = {}) {
  if (!activationId) return null;
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const failure = [
    'submission_uncertain',
    'rejected',
    'protection_failed',
    'reconciliation_failed',
    'control_invalidated',
    'activation_revoked'
  ].includes(status);
  const lifecycleStatus = failure
    ? 'failed'
    : (status === 'filled' ? 'filled' : (status === 'reconciled' ? 'reconciled' : 'broker_pending'));
  return Model.findOneAndUpdate(
    { _id: activationId },
    { $set: {
      lifecycleStatus,
      liveOrderId,
      outcome: { status, details, recordedAt: now },
      ...(failure ? { status: 'revoked', revokedAt: now } : {})
    } },
    { new: true }
  );
}

async function reviewControlledLiveCanary({ userId, confirmation, notes, now = new Date() } = {}, deps = {}) {
  if (confirmation !== LIVE_REVIEW_CONFIRMATION) {
    const err = new Error('Exact controlled-live review confirmation is required.');
    err.status = 400;
    throw err;
  }
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const record = await Model.findOne({
    userId,
    attemptsUsed: { $gte: 1 },
    lifecycleStatus: { $in: ['filled', 'reconciled', 'failed'] }
  });
  if (!record) {
    const err = new Error('A terminal or reconciled canary outcome is required before review.');
    err.status = 409;
    throw err;
  }
  record.lifecycleStatus = 'reviewed';
  record.reviewedAt = now;
  record.reviewNotes = notes ? String(notes).slice(0, 1000) : null;
  if (record.status === 'active') {
    record.status = 'revoked';
    record.revokedAt = now;
  }
  await record.save();
  return record;
}

async function expireControlledLiveActivations({ now = new Date() } = {}, deps = {}) {
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  return Model.updateMany(
    { status: 'active', activationExpiresAt: { $lte: now } },
    { $set: { status: 'expired', revokedAt: now } }
  );
}

async function heartbeatControlledLive({ userId, confirmation, sessionId, now = new Date() } = {}, deps = {}) {
  if (confirmation !== LIVE_HEARTBEAT_CONFIRMATION) {
    const err = new Error('Exact active-supervision confirmation is required.');
    err.status = 400;
    throw err;
  }
  const normalizedSessionId = String(sessionId || '').trim().slice(0, 128);
  if (!normalizedSessionId) {
    const err = new Error('A supervisor session id is required.');
    err.status = 400;
    throw err;
  }
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const record = await Model.findOneAndUpdate(
    {
      userId,
      status: 'active',
      activationExpiresAt: { $gt: now },
      supervisionDeadlineAt: { $gt: now }
    },
    { $set: {
      supervisionHeartbeatAt: now,
      supervisionDeadlineAt: new Date(now.getTime() + SUPERVISION_TIMEOUT_MS),
      supervisorSessionId: normalizedSessionId
    } },
    { new: true }
  );
  if (!record) {
    const err = new Error('No active controlled-live canary is available for supervision.');
    err.status = 409;
    throw err;
  }
  return record;
}

async function enforceControlledLiveWatchdog({ userId = null, now = new Date() } = {}, deps = {}) {
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const Settings = deps.RoboSettings || RoboSettings;
  const Audit = deps.RoboAuditLog || RoboAuditLog;
  const createAlert = deps.createOperationalAlertFromAudit || createOperationalAlertFromAudit;
  const query = {
    status: 'active',
    $or: [
      { activationExpiresAt: { $lte: now } },
      { supervisionDeadlineAt: { $lte: now } },
      { supervisionDeadlineAt: null }
    ]
  };
  if (userId) query.userId = userId;
  const candidatesQuery = Model.find(query);
  const candidates = typeof candidatesQuery?.lean === 'function'
    ? await candidatesQuery.lean()
    : await candidatesQuery;
  const revoked = [];
  for (const candidate of candidates || []) {
    const activationExpired = candidate.activationExpiresAt && new Date(candidate.activationExpiresAt) <= now;
    const outcomeStatus = activationExpired ? 'activation_expired' : 'supervision_lost';
    const updateQuery = Model.findOneAndUpdate(
      { ...query, _id: candidate._id },
      { $set: {
        status: 'revoked',
        revokedAt: now,
        lifecycleStatus: 'failed',
        outcome: {
          status: outcomeStatus,
          details: {
            supervisionDeadlineAt: candidate.supervisionDeadlineAt || null,
            activationExpiresAt: candidate.activationExpiresAt || null
          },
          recordedAt: now
        }
      } },
      { new: true }
    );
    const updated = typeof updateQuery?.lean === 'function' ? await updateQuery.lean() : await updateQuery;
    if (updated) revoked.push(updated);
  }

  const affectedUsers = [...new Set(revoked.map(item => String(item.userId || '')).filter(Boolean))];
  if (affectedUsers.length && typeof Settings?.updateMany === 'function') {
    await Settings.updateMany(
      { userId: { $in: affectedUsers } },
      {
        $set: {
          enabled: false,
          isEnabled: false,
          pausedReason: 'Controlled-live supervision heartbeat expired.'
        },
        $inc: { controlGeneration: 1 }
      }
    );
  }

  for (const activation of revoked) {
    const activationId = String(activation._id);
    const outcomeStatus = activation.outcome?.status || 'supervision_lost';
    await Audit.create({
      userId: activation.userId,
      eventType: 'robotrader_controlled_live_supervision_lost',
      payload: {
        activationId,
        environment: 'live',
        reason: outcomeStatus === 'activation_expired'
          ? 'Controlled-live activation expired.'
          : 'Controlled-live supervisor heartbeat expired.',
        supervisionDeadlineAt: activation.supervisionDeadlineAt || null,
        activationExpiresAt: activation.activationExpiresAt || null
      }
    });
    await createAlert({
      userId: activation.userId,
      eventType: 'robotrader_controlled_live_supervision_lost',
      payload: {
        activationId,
        environment: 'live',
        reason: outcomeStatus === 'activation_expired'
          ? 'Controlled-live activation expired.'
          : 'Controlled-live supervisor heartbeat expired.'
      },
      now
    }, deps);
  }

  return { matchedCount: (candidates || []).length, modifiedCount: revoked.length, activations: revoked };
}

function activationEvidenceSnapshot(activation = {}) {
  const snapshot = { ...activation };
  delete snapshot.__v;
  delete snapshot.updatedAt;
  delete snapshot.dossierHash;
  delete snapshot.dossierSealedAt;
  delete snapshot.dossierSnapshot;
  return snapshot;
}

async function buildCanaryDossier({ userId, now = new Date() } = {}, deps = {}) {
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const activation = await Activation.findOne({ userId }).lean();
  if (!activation) return null;
  const Order = deps.RoboTradeOrder || RoboTradeOrder;
  const Intent = deps.OrderIntent || OrderIntent;
  const Decision = deps.RoboTradeDecision || RoboTradeDecision;
  const Alerts = deps.RoboOperationalAlert || RoboOperationalAlert;
  const Audit = deps.RoboAuditLog || RoboAuditLog;
  const Exposure = deps.RoboExposureSnapshot || RoboExposureSnapshot;
  const schemaVersion = activation.dossierSnapshot?.schemaVersion || 2;
  const evidenceStart = activation.approvedAt || new Date(0);
  const evidenceEnd = activation.dossierSealedAt || now;
  const order = activation.liveOrderId ? await Order.findOne({ _id: activation.liveOrderId, userId }).lean() : null;
  const [intent, decision, exposure, protectiveOrders, alerts, audit] = await Promise.all([
    order?.intentId ? Intent.findOne({ _id: order.intentId, userId }).lean() : null,
    order?.decisionId ? Decision.findOne({ _id: order.decisionId, userId }).lean() : null,
    order?.exposureSnapshotId ? Exposure.findOne({ _id: order.exposureSnapshotId, userId }).lean() : null,
    schemaVersion >= 2 && order
      ? Order.find({ parentOrderId: order._id, userId }).sort({ createdAt: 1 }).lean()
      : [],
    Alerts.find({ userId, firstOccurredAt: { $gte: evidenceStart, $lte: evidenceEnd } })
      .sort({ firstOccurredAt: 1 }).limit(100).lean(),
    Audit.find({
      userId,
      'payload.activationId': String(activation._id),
      createdAt: { $gte: evidenceStart, $lte: evidenceEnd },
      eventType: { $ne: 'robotrader_controlled_live_dossier_sealed' }
    }).sort({ createdAt: 1 }).limit(250).lean()
  ]);
  const dossierInput = {
    schemaVersion,
    activation: activationEvidenceSnapshot(activation),
    order,
    intent,
    decision,
    exposure,
    alerts,
    audit
  };
  if (schemaVersion >= 2) dossierInput.protectiveOrders = protectiveOrders;
  const { canonical: dossier, hash } = hashCanonicalEvidence(dossierInput);
  return {
    dossier,
    hash,
    sealedHash: activation.dossierHash || null,
    sealedAt: activation.dossierSealedAt || null,
    sealedDossier: activation.dossierSnapshot || null
  };
}

async function sealCanaryDossier({ userId, confirmation, now = new Date() } = {}, deps = {}) {
  if (confirmation !== LIVE_DOSSIER_CONFIRMATION) {
    const err = new Error('Exact dossier-sealing confirmation is required.');
    err.status = 400;
    throw err;
  }
  const built = await buildCanaryDossier({ userId, now }, deps);
  if (!built || built.dossier.activation.lifecycleStatus !== 'reviewed') {
    const err = new Error('A reviewed canary is required before sealing its evidence dossier.');
    err.status = 409;
    throw err;
  }
  if (built.sealedHash) {
    const err = new Error('This canary evidence dossier has already been sealed.');
    err.status = 409;
    throw err;
  }
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const Dossier = deps.RoboCanaryDossier || RoboCanaryDossier;
  const canaryId = built.dossier.activation.canaryId
    || `${String(built.dossier.activation._id)}:${String(built.dossier.activation.approvedAt)}`;
  const archived = await Dossier.findOneAndUpdate(
    { userId, canaryId },
    { $setOnInsert: {
      userId,
      canaryId,
      activationId: built.dossier.activation._id,
      dossierHash: built.hash,
      dossierSnapshot: built.dossier,
      sealedAt: now
    } },
    { new: true, upsert: true, runValidators: true }
  );
  const sealedHash = archived.dossierHash || built.hash;
  const sealedAt = archived.sealedAt || now;
  const sealedDossier = archived.dossierSnapshot || built.dossier;
  const activation = await Model.findOneAndUpdate(
    { userId, lifecycleStatus: 'reviewed', dossierHash: null },
    { $set: { dossierHash: sealedHash, dossierSealedAt: sealedAt, dossierSnapshot: sealedDossier } },
    { new: true }
  );
  if (!activation) {
    const err = new Error('This canary evidence dossier was already sealed.');
    err.status = 409;
    throw err;
  }
  return { activation, hash: sealedHash, dossier: sealedDossier };
}

async function revokeControlledLive({ userId, confirmation, now = new Date() } = {}, deps = {}) {
  if (confirmation !== LIVE_REVOCATION_CONFIRMATION) {
    const err = new Error('Exact controlled-live revocation confirmation is required.');
    err.status = 400;
    throw err;
  }
  const Model = deps.RoboLiveActivation || RoboLiveActivation;
  const Settings = deps.RoboSettings || RoboSettings;
  if (typeof Settings?.updateOne === 'function') {
    await Settings.updateOne(
      { userId },
      {
        $set: {
          enabled: false,
          isEnabled: false,
          pausedReason: 'Controlled-live activation revoked.'
        },
        $inc: { controlGeneration: 1 }
      }
    );
  }
  return Model.findOneAndUpdate(
    { userId, status: { $in: ['approved', 'active'] } },
    { $set: { status: 'revoked', revokedAt: now } },
    { new: true }
  );
}

module.exports = {
  HARD_LIMITS,
  LIVE_ACTIVATION_CONFIRMATION,
  LIVE_APPROVAL_CONFIRMATION,
  LIVE_REVOCATION_CONFIRMATION,
  LIVE_REVIEW_CONFIRMATION,
  LIVE_HEARTBEAT_CONFIRMATION,
  LIVE_DOSSIER_CONFIRMATION,
  SUPERVISION_TIMEOUT_MS,
  activateControlledLive,
  approveControlledLive,
  buildReadinessFingerprint,
  normalizeCanaryLimits,
  claimControlledLiveAttempt,
  expireControlledLiveActivations,
  enforceControlledLiveWatchdog,
  heartbeatControlledLive,
  buildCanaryDossier,
  sealCanaryDossier,
  recordControlledLiveOutcome,
  reviewControlledLiveCanary,
  revokeControlledLive,
  revalidateControlledLiveAttempt,
  validateControlledLiveSubmission
};
