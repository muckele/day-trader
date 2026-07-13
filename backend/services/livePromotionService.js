const RoboCanaryDossier = require('../models/RoboCanaryDossier');
const RoboLivePromotion = require('../models/RoboLivePromotion');
const RoboLiveActivation = require('../models/RoboLiveActivation');
const RoboSettings = require('../models/RoboSettings');
const RoboAuditLog = require('../models/RoboAuditLog');
const { buildReadinessAssessment, createOperationalAlertFromAudit } = require('./roboReadinessService');
const { hashCanonicalEvidence } = require('./canaryEvidenceService');
const { buildStrategyValidationAssessment } = require('./strategyValidationService');
const { buildExecutionDiscrepancyAssessment } = require('./executionDiscrepancyService');

const PROMOTION_POLICY_VERSION = 'controlled-live-promotion-v1';
const PROMOTION_APPROVAL_CONFIRMATION = 'I approve one repeat canary under unchanged hard limits.';
const PROMOTION_REVOCATION_CONFIRMATION = 'Revoke repeat canary promotion now.';
const MIN_PROMOTION_DOSSIERS = 3;
const MIN_PROMOTION_DAYS = 3;
const PROMOTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROMOTION_VALID_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function hasVerifiedProtection(dossier = {}) {
  const order = dossier.order || {};
  if (String(order.side || '').toLowerCase() === 'sell') return true;
  const orderClass = String(order.orderClass || '').toLowerCase();
  if (['bracket', 'oto'].includes(orderClass) && order.stopLoss) return true;
  return (dossier.protectiveOrders || []).some(protection => (
    protection.exitReason === 'stop_loss'
    && protection.externalOrderId
    && protection.reconciliationStatus === 'matched'
    && String(protection.status || '').toLowerCase() !== 'rejected'
  ));
}

function successfulDossier(dossier = {}) {
  const order = dossier.order || {};
  return Boolean(
    dossier.activation?.lifecycleStatus === 'reviewed'
    && dossier.activation?.outcome?.status === 'reconciled'
    && String(order.status || '').toLowerCase() === 'filled'
    && order.reconciliationStatus === 'matched'
    && !order.discrepancy
    && Number(order.filledQty || 0) > 0
    && Number(order.filledAvgPrice || 0) > 0
  );
}

function gate(key, label, passed, detail) {
  return { key, label, passed: passed === true, detail };
}

async function buildLivePromotionAssessment({ userId, now = new Date(), env = process.env } = {}, deps = {}) {
  const Dossier = deps.RoboCanaryDossier || RoboCanaryDossier;
  const readinessBuilder = deps.buildReadinessAssessment || buildReadinessAssessment;
  const promotionGradeQuery = { userId, 'dossierSnapshot.schemaVersion': { $gte: 2 } };
  const query = Dossier.find(promotionGradeQuery);
  const recent = await query.sort({ sealedAt: -1 }).limit(MIN_PROMOTION_DOSSIERS).lean();
  const cohort = recent || [];
  const dossiers = cohort.map(item => item.dossierSnapshot || {});
  const distinctDays = new Set(cohort.map(item => new Date(item.sealedAt).toISOString().slice(0, 10))).size;
  const newestSealedAt = cohort.length
    ? new Date(Math.max(...cohort.map(item => new Date(item.sealedAt).getTime())))
    : null;
  const cooldownEndsAt = newestSealedAt
    ? new Date(newestSealedAt.getTime() + PROMOTION_COOLDOWN_MS)
    : null;
  const integrityResults = cohort.map(item => (
    hashCanonicalEvidence(item.dossierSnapshot || {}).hash === item.dossierHash
  ));
  const strategyIds = [...new Set(dossiers.map(item => String(item.order?.strategyId || '')).filter(Boolean))];
  const policyVersions = [...new Set(dossiers.map(item => String(item.order?.policyVersion || '')).filter(Boolean))];
  const accountIds = [...new Set(dossiers.map(item => String(item.order?.accountId || '')).filter(Boolean))];
  const allowedSymbols = [...new Set(dossiers.map(item => normalizeSymbol(item.order?.symbol)).filter(Boolean))].sort();
  const criticalAlerts = dossiers.flatMap(item => item.alerts || []).filter(alert => (
    alert.severity === 'critical' && ['open', 'acknowledged'].includes(alert.status)
  ));
  const readiness = await readinessBuilder({ userId, now, env });
  const strategyEvidenceBuilder = deps.buildStrategyValidationAssessment || buildStrategyValidationAssessment;
  const strategyEvidence = await strategyEvidenceBuilder({
    accountId: accountIds.length === 1 ? accountIds[0] : null,
    strategyId: strategyIds.length === 1 ? strategyIds[0] : null,
    symbols: allowedSymbols,
    dossiers,
    now
  });
  const discrepancyBuilder = deps.buildExecutionDiscrepancyAssessment || buildExecutionDiscrepancyAssessment;
  const executionDiscrepancy = await discrepancyBuilder({
    accountId: accountIds.length === 1 ? accountIds[0] : null,
    strategyId: strategyIds.length === 1 ? strategyIds[0] : null,
    symbols: allowedSymbols,
    dossiers,
    now
  });
  const gates = [
    gate(
      'sealed_cohort_size',
      'Three sealed canary dossiers',
      cohort.length >= MIN_PROMOTION_DOSSIERS,
      `${cohort.length}/${MIN_PROMOTION_DOSSIERS} most recent sealed dossiers`
    ),
    gate(
      'distinct_canary_days',
      'Canaries span three UTC days',
      distinctDays >= MIN_PROMOTION_DAYS,
      `${distinctDays}/${MIN_PROMOTION_DAYS} distinct UTC days`
    ),
    gate(
      'dossier_schema',
      'Dossiers include machine-verifiable protection evidence',
      dossiers.length >= MIN_PROMOTION_DOSSIERS && dossiers.every(item => Number(item.schemaVersion) >= 2),
      `${dossiers.filter(item => Number(item.schemaVersion) >= 2).length}/${MIN_PROMOTION_DOSSIERS} schema-v2 dossiers`
    ),
    gate(
      'dossier_integrity',
      'Every dossier hash verifies',
      integrityResults.length >= MIN_PROMOTION_DOSSIERS && integrityResults.every(Boolean),
      `${integrityResults.filter(Boolean).length}/${MIN_PROMOTION_DOSSIERS} hashes verified`
    ),
    gate(
      'successful_reconciliation',
      'Every canary filled and reconciled without discrepancy',
      dossiers.length >= MIN_PROMOTION_DOSSIERS && dossiers.every(successfulDossier),
      `${dossiers.filter(successfulDossier).length}/${MIN_PROMOTION_DOSSIERS} successful reconciliations`
    ),
    gate(
      'protection_verified',
      'Every canary has broker-verifiable protection',
      dossiers.length >= MIN_PROMOTION_DOSSIERS && dossiers.every(hasVerifiedProtection),
      `${dossiers.filter(hasVerifiedProtection).length}/${MIN_PROMOTION_DOSSIERS} protected canaries`
    ),
    gate(
      'exposure_clear',
      'Every canary exposure snapshot is present and clear',
      dossiers.length >= MIN_PROMOTION_DOSSIERS && dossiers.every(item => item.exposure && item.exposure.breached !== true),
      `${dossiers.filter(item => item.exposure && item.exposure.breached !== true).length}/${MIN_PROMOTION_DOSSIERS} clear snapshots`
    ),
    gate(
      'cohort_alerts_clear',
      'No unresolved critical alert in the cohort',
      criticalAlerts.length === 0,
      `${criticalAlerts.length} unresolved critical cohort alert(s)`
    ),
    gate(
      'strategy_consistent',
      'One strategy across the cohort',
      strategyIds.length === 1,
      strategyIds.length === 1 ? strategyIds[0] : `${strategyIds.length} strategies found`
    ),
    gate(
      'account_consistent',
      'One account scope across the cohort',
      accountIds.length === 1,
      accountIds.length === 1 ? accountIds[0] : `${accountIds.length} account scopes found`
    ),
    gate(
      'policy_consistent',
      'One canonical policy version across the cohort',
      policyVersions.length === 1,
      policyVersions.length === 1 ? policyVersions[0] : `${policyVersions.length} policy versions found`
    ),
    gate(
      'strategy_evidence',
      'Recent parameter-bound backtests and execution drift pass',
      strategyEvidence.passed === true,
      strategyEvidence.passed
        ? `Evidence ${strategyEvidence.fingerprint.slice(0, 12)}… valid until ${strategyEvidence.expiresAt?.toISOString() || 'unknown'}`
        : strategyEvidence.gates.filter(item => !item.passed).map(item => item.key).join(', ') || 'Strategy evidence unavailable.'
    ),
    gate(
      'paper_live_discrepancy',
      'Paper-versus-live execution discrepancy remains bounded',
      executionDiscrepancy.passed === true,
      executionDiscrepancy.passed
        ? `${executionDiscrepancy.slippageDegradationBps} bps live slippage degradation`
        : executionDiscrepancy.gates.filter(item => !item.passed).map(item => item.key).join(', ') || 'Discrepancy evidence unavailable.'
    ),
    gate(
      'cooling_period',
      'Twenty-four-hour observation period completed',
      Boolean(cooldownEndsAt && now >= cooldownEndsAt),
      cooldownEndsAt ? `Available after ${cooldownEndsAt.toISOString()}` : 'No sealed cohort exists.'
    ),
    gate(
      'current_readiness',
      'Current controlled-live readiness still passes',
      readiness.technicalReady === true,
      readiness.status || 'not_ready'
    )
  ];
  const fingerprintInput = {
    policyVersion: PROMOTION_POLICY_VERSION,
    stage: 'repeat_canary',
    dossierHashes: cohort.map(item => item.dossierHash),
    strategyId: strategyIds.length === 1 ? strategyIds[0] : null,
    executionPolicyVersion: policyVersions.length === 1 ? policyVersions[0] : null,
    strategyEvidenceFingerprint: strategyEvidence.fingerprint,
    executionDiscrepancyFingerprint: executionDiscrepancy.fingerprint,
    allowedSymbols
  };
  const assessmentFingerprint = hashCanonicalEvidence(fingerprintInput).hash;
  return {
    policyVersion: PROMOTION_POLICY_VERSION,
    stage: 'repeat_canary',
    eligible: gates.every(item => item.passed),
    assessedAt: now,
    cooldownEndsAt,
    cohort: cohort.map(item => ({
      canaryId: item.canaryId,
      dossierHash: item.dossierHash,
      sealedAt: item.sealedAt
    })),
    dossierCount: cohort.length,
    distinctDays,
    allowedSymbols,
    strategyId: strategyIds.length === 1 ? strategyIds[0] : null,
    executionPolicyVersion: policyVersions.length === 1 ? policyVersions[0] : null,
    strategyEvidence,
    executionDiscrepancy,
    assessmentFingerprint,
    gates,
    readiness: {
      status: readiness.status,
      technicalReady: readiness.technicalReady
    }
  };
}

async function expireLivePromotions({ userId = null, now = new Date() } = {}, deps = {}) {
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const query = {
    status: 'approved',
    $or: [
      { expiresAt: { $lte: now } },
      { 'strategyEvidence.expiresAt': { $lte: now } }
    ]
  };
  if (userId) query.userId = userId;
  return Promotion.updateMany(query, { $set: { status: 'expired', revokedAt: now } });
}

async function approveRepeatCanaryPromotion({ userId, confirmation, notes, now = new Date(), env = process.env } = {}, deps = {}) {
  if (confirmation !== PROMOTION_APPROVAL_CONFIRMATION) {
    const err = new Error('Exact repeat-canary promotion confirmation is required.');
    err.status = 400;
    throw err;
  }
  await expireLivePromotions({ userId, now }, deps);
  const assessment = await buildLivePromotionAssessment({ userId, now, env }, deps);
  if (!assessment.eligible) {
    const err = new Error('The repeat-canary promotion gates are not complete.');
    err.status = 409;
    err.assessment = assessment;
    throw err;
  }
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const payload = {
    userId,
    assessmentFingerprint: assessment.assessmentFingerprint,
    stage: 'repeat_canary',
    status: 'approved',
    cohort: assessment.cohort,
    gates: assessment.gates,
    allowedSymbols: assessment.allowedSymbols,
    strategyId: assessment.strategyId,
    policyVersion: assessment.executionPolicyVersion,
    strategyEvidence: assessment.strategyEvidence,
    executionDiscrepancy: assessment.executionDiscrepancy,
    approvedAt: now,
    expiresAt: new Date(now.getTime() + PROMOTION_VALID_MS),
    consumedAt: null,
    revokedAt: null,
    notes: notes ? String(notes).slice(0, 1000) : null
  };
  const existingQuery = Promotion.findOne({
    userId,
    assessmentFingerprint: assessment.assessmentFingerprint
  });
  const existing = typeof existingQuery?.lean === 'function' ? await existingQuery.lean() : await existingQuery;
  if (existing?.consumedAt) {
    const err = new Error('This canary cohort already authorized an activation and cannot be promoted again.');
    err.status = 409;
    throw err;
  }
  if (existing) {
    const rearmQuery = Promotion.findOneAndUpdate(
      { _id: existing._id, status: { $in: ['expired', 'revoked'] }, consumedAt: null },
      { $set: payload },
      { new: true, runValidators: true }
    );
    const rearmed = typeof rearmQuery?.lean === 'function' ? await rearmQuery.lean() : await rearmQuery;
    if (rearmed) return rearmed;
    const err = new Error('This canary cohort already has an active promotion approval.');
    err.status = 409;
    throw err;
  }
  try {
    return await Promotion.create(payload);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const err = new Error('This canary cohort already has an active promotion approval.');
    err.status = 409;
    throw err;
  }
}

async function validateRepeatCanaryApproval({ userId, allowedSymbols = [], now = new Date(), env = process.env } = {}, deps = {}) {
  const Dossier = deps.RoboCanaryDossier || RoboCanaryDossier;
  const dossierCount = await Dossier.countDocuments({
    userId,
    'dossierSnapshot.schemaVersion': { $gte: 2 }
  });
  if (dossierCount < MIN_PROMOTION_DOSSIERS) {
    return { required: false, dossierCount };
  }
  const assessment = await buildLivePromotionAssessment({ userId, now, env }, deps);
  if (!assessment.eligible) {
    const err = new Error('Repeat-canary promotion gates must pass before another controlled-live approval.');
    err.status = 409;
    err.assessment = assessment;
    throw err;
  }
  const requestedSymbols = [...new Set((allowedSymbols || []).map(normalizeSymbol).filter(Boolean))];
  if (requestedSymbols.some(symbol => !assessment.allowedSymbols.includes(symbol))) {
    const err = new Error('Repeat-canary symbols must be drawn from the verified promotion cohort.');
    err.status = 409;
    throw err;
  }
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const claim = Promotion.findOneAndUpdate(
    {
      userId,
      stage: 'repeat_canary',
      status: 'approved',
      assessmentFingerprint: assessment.assessmentFingerprint,
      expiresAt: { $gt: now },
      consumedAt: null
    },
    { $set: { status: 'consumed', consumedAt: now } },
    { new: true }
  );
  const promotion = typeof claim?.lean === 'function' ? await claim.lean() : await claim;
  if (!promotion) {
    const err = new Error('A current, unconsumed repeat-canary promotion approval is required.');
    err.status = 409;
    throw err;
  }
  return { required: true, dossierCount, assessment, promotion };
}

async function revokeRepeatCanaryPromotion({ userId, confirmation, now = new Date() } = {}, deps = {}) {
  if (confirmation !== PROMOTION_REVOCATION_CONFIRMATION) {
    const err = new Error('Exact repeat-canary promotion revocation confirmation is required.');
    err.status = 400;
    throw err;
  }
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const activationQuery = Activation.findOne({
    userId,
    promotionId: { $ne: null },
    status: { $in: ['approved', 'active'] }
  });
  const currentActivation = typeof activationQuery?.lean === 'function'
    ? await activationQuery.lean()
    : await activationQuery;
  const promotions = await Promotion.find({ userId, status: 'approved' }).lean();
  const promotionIds = [...new Set([
    ...(promotions || []).map(item => String(item._id)),
    ...(currentActivation?.promotionId ? [String(currentActivation.promotionId)] : [])
  ])];
  if (currentActivation) {
    const Settings = deps.RoboSettings || RoboSettings;
    if (typeof Settings?.updateOne === 'function') {
      await Settings.updateOne(
        { userId },
        {
          $set: {
            enabled: false,
            isEnabled: false,
            pausedReason: 'Repeat-canary promotion revoked.'
          },
          $inc: { controlGeneration: 1 }
        }
      );
    }
  }
  const promotionUpdate = await Promotion.updateMany(
    { _id: { $in: promotionIds } },
    { $set: { status: 'revoked', revokedAt: now } }
  );
  const activation = currentActivation
    ? await Activation.findOneAndUpdate(
        {
          _id: currentActivation._id,
          userId,
          promotionId: currentActivation.promotionId,
          status: { $in: ['approved', 'active'] }
        },
        { $set: { status: 'revoked', revokedAt: now } },
        { new: true }
      )
    : null;
  return { promotionUpdate, activation };
}

async function getLivePromotionStatus({ userId, now = new Date(), env = process.env } = {}, deps = {}) {
  await expireLivePromotions({ userId, now }, deps);
  const assessment = await buildLivePromotionAssessment({ userId, now, env }, deps);
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const query = Promotion.findOne({ userId, assessmentFingerprint: assessment.assessmentFingerprint });
  const sorted = typeof query?.sort === 'function' ? query.sort({ createdAt: -1 }) : query;
  const promotion = typeof sorted?.lean === 'function' ? await sorted.lean() : await sorted;
  return { promotion, assessment };
}

async function enforceStrategyEvidenceDemotion({ userId = null, now = new Date() } = {}, deps = {}) {
  const Activation = deps.RoboLiveActivation || RoboLiveActivation;
  const Promotion = deps.RoboLivePromotion || RoboLivePromotion;
  const Settings = deps.RoboSettings || RoboSettings;
  const Audit = deps.RoboAuditLog || RoboAuditLog;
  const createAlert = deps.createOperationalAlertFromAudit || createOperationalAlertFromAudit;
  const query = {
    promotionId: { $ne: null },
    status: { $in: ['approved', 'active'] }
  };
  if (userId) query.userId = userId;
  const activations = await Activation.find(query).lean();
  const revoked = [];
  for (const activation of activations || []) {
    const promotion = await Promotion.findOne({
      _id: activation.promotionId,
      userId: activation.userId,
      status: 'consumed',
      'strategyEvidence.expiresAt': { $gt: now }
    }).lean();
    if (promotion) {
      const assessmentBuilder = deps.buildLivePromotionAssessment || buildLivePromotionAssessment;
      const currentAssessment = await assessmentBuilder({ userId: activation.userId, now }, deps);
      if (
        currentAssessment.eligible
        && currentAssessment.assessmentFingerprint === promotion.assessmentFingerprint
      ) continue;
    }
    const updateQuery = Activation.findOneAndUpdate(
      { _id: activation._id, status: { $in: ['approved', 'active'] } },
      { $set: {
        status: 'revoked',
        revokedAt: now,
        lifecycleStatus: 'failed',
        outcome: { status: 'promoted_evidence_changed_or_expired', recordedAt: now }
      } },
      { new: true }
    );
    const updated = typeof updateQuery?.lean === 'function' ? await updateQuery.lean() : await updateQuery;
    if (!updated) continue;
    revoked.push(updated);
    await Promise.all([
      Promotion.updateOne(
        { _id: activation.promotionId, status: 'consumed' },
        { $set: { status: 'expired', revokedAt: now } }
      ),
      Settings.updateOne(
        { userId: activation.userId },
        {
          $set: {
            enabled: false,
            isEnabled: false,
            pausedReason: 'Promoted validation evidence changed or expired.'
          },
          $inc: { controlGeneration: 1 }
        }
      ),
      Audit.create({
        userId: activation.userId,
        eventType: 'robotrader_strategy_evidence_expired',
        payload: {
          activationId: String(activation._id),
          promotionId: String(activation.promotionId),
          environment: 'live',
          reason: 'Promoted strategy, walk-forward, or discrepancy evidence changed, expired, or no longer matched.'
        }
      })
    ]);
    await createAlert({
      userId: activation.userId,
      eventType: 'robotrader_strategy_evidence_expired',
      payload: {
        activationId: String(activation._id),
        promotionId: String(activation.promotionId),
        environment: 'live',
        reason: 'Promoted strategy, walk-forward, or discrepancy evidence changed, expired, or no longer matched.'
      },
      now
    }, deps);
  }
  return { checkedCount: (activations || []).length, revokedCount: revoked.length, activations: revoked };
}

module.exports = {
  MIN_PROMOTION_DAYS,
  MIN_PROMOTION_DOSSIERS,
  PROMOTION_APPROVAL_CONFIRMATION,
  PROMOTION_COOLDOWN_MS,
  PROMOTION_POLICY_VERSION,
  PROMOTION_REVOCATION_CONFIRMATION,
  PROMOTION_VALID_MS,
  approveRepeatCanaryPromotion,
  buildLivePromotionAssessment,
  expireLivePromotions,
  enforceStrategyEvidenceDemotion,
  getLivePromotionStatus,
  hasVerifiedProtection,
  revokeRepeatCanaryPromotion,
  successfulDossier,
  validateRepeatCanaryApproval
};
