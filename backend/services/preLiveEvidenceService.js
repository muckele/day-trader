const User = require('../models/User');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const { POLICY_VERSION } = require('./canonicalTradingPolicyService');
const { buildStrategyValidationAssessment } = require('./strategyValidationService');
const { buildPaperExecutionReadinessAssessment } = require('./executionDiscrepancyService');
const { hashCanonicalEvidence } = require('./canaryEvidenceService');
const { getAccountIdForUser } = require('../utils/accountScope');

const PRE_LIVE_EVIDENCE_POLICY_VERSION = 'pre-live-evidence-v1';
const SHADOW_CANDIDATE_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeSymbols(symbols = []) {
  return [...new Set(
    symbols.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
  )].sort();
}

async function readUser(userId, UserModel) {
  const query = UserModel.findById(userId);
  return typeof query?.lean === 'function' ? query.lean() : query;
}

async function buildPreLiveEvidenceAssessment({
  userId,
  allowedSymbols = [],
  now = new Date()
} = {}, deps = {}) {
  const UserModel = deps.User || User;
  const DecisionModel = deps.RoboTradeDecision || RoboTradeDecision;
  const buildStrategy = deps.buildStrategyValidationAssessment || buildStrategyValidationAssessment;
  const buildPaper = deps.buildPaperExecutionReadinessAssessment || buildPaperExecutionReadinessAssessment;
  const symbols = normalizeSymbols(allowedSymbols);
  const cutoff = new Date(now.getTime() - SHADOW_CANDIDATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const user = userId ? await readUser(userId, UserModel) : null;
  const accountId = user ? getAccountIdForUser(user) : null;

  let decisions = [];
  if (user && symbols.length) {
    decisions = await DecisionModel.find({
      userId,
      environment: 'shadow',
      status: 'approved',
      symbol: { $in: symbols },
      decidedAt: { $gte: cutoff }
    }).sort({ decidedAt: -1 }).lean();
  }

  const latestBySymbol = new Map();
  for (const decision of decisions || []) {
    const symbol = String(decision.symbol || '').toUpperCase();
    if (symbols.includes(symbol) && !latestBySymbol.has(symbol)) latestBySymbol.set(symbol, decision);
  }
  const selectedDecisions = symbols.map(symbol => latestBySymbol.get(symbol)).filter(Boolean);
  const strategyIds = [...new Set(selectedDecisions.map(item => item.strategyId).filter(Boolean))];
  const policyVersions = [...new Set(selectedDecisions.map(item => item.policyVersion).filter(Boolean))];
  const parameterVersionIds = [...new Set(
    selectedDecisions.map(item => item.parameterVersionId ? String(item.parameterVersionId) : null).filter(Boolean)
  )];
  const strategyId = strategyIds.length === 1 ? strategyIds[0] : null;
  const parameterVersionId = parameterVersionIds.length === 1 ? parameterVersionIds[0] : null;

  const strategyAssessment = accountId && strategyId && symbols.length
    ? await buildStrategy({
        accountId,
        strategyId,
        expectedParameterVersionId: parameterVersionId,
        symbols,
        dossiers: [],
        requireCanarySlippage: false,
        now
      }, deps)
    : null;
  const paperAssessment = accountId && strategyId && parameterVersionId && symbols.length
    ? await buildPaper({ accountId, strategyId, parameterVersionId, symbols, now }, deps)
    : null;
  const strategyParameterMatches = Boolean(
    parameterVersionId
    && String(strategyAssessment?.parameterVersionId || '') === parameterVersionId
  );
  const paperParameterMatches = Boolean(
    parameterVersionId
    && String(paperAssessment?.parameterVersionId || '') === parameterVersionId
  );

  const gates = [
    {
      key: 'shadow_candidate_coverage',
      passed: symbols.length > 0 && selectedDecisions.length === symbols.length,
      detail: `${selectedDecisions.length}/${symbols.length || 0} intended symbols have a policy-approved shadow candidate from the last ${SHADOW_CANDIDATE_MAX_AGE_DAYS} days`
    },
    {
      key: 'shadow_strategy_consistent',
      passed: strategyIds.length === 1 && parameterVersionIds.length === 1,
      detail: strategyId && parameterVersionId
        ? `${strategyId} · parameter version ${parameterVersionId}`
        : `${strategyIds.length} strategy and ${parameterVersionIds.length} parameter-version identifiers found`
    },
    {
      key: 'shadow_policy_current',
      passed: policyVersions.length === 1 && policyVersions[0] === POLICY_VERSION,
      detail: policyVersions.length === 1
        ? `${policyVersions[0]} / ${POLICY_VERSION}`
        : `${policyVersions.length} distinct policy versions found`
    },
    {
      key: 'walk_forward_strategy_evidence',
      passed: strategyAssessment?.passed === true && strategyParameterMatches,
      detail: strategyAssessment?.passed && strategyParameterMatches
        ? 'Every intended symbol has current, parameter-consistent, qualifying walk-forward evidence.'
        : 'Qualifying walk-forward evidence is incomplete, blocked, or bound to a different parameter version.'
    },
    {
      key: 'paper_execution_evidence',
      passed: paperAssessment?.passed === true && paperParameterMatches && Boolean(paperAssessment?.fingerprint),
      detail: paperAssessment?.passed && paperParameterMatches && paperAssessment?.fingerprint
        ? 'Every intended symbol has sufficient complete paper fills within the execution thresholds.'
        : 'Comparable, parameter-bound paper-fill coverage, rejection rate, or completion evidence is blocked.'
    }
  ];
  const selectedShadow = selectedDecisions.map(item => ({
    decisionId: String(item._id || ''),
    symbol: String(item.symbol || '').toUpperCase(),
    strategyId: item.strategyId || null,
    policyVersion: item.policyVersion || null,
    parameterVersionId: item.parameterVersionId ? String(item.parameterVersionId) : null,
    decidedAt: item.decidedAt || null,
    orderFingerprint: item.orderFingerprint || null
  }));
  const snapshot = {
    policyVersion: PRE_LIVE_EVIDENCE_POLICY_VERSION,
    userId: String(userId || ''),
    accountId,
    symbols,
    strategyId,
    parameterVersionId,
    selectedShadow,
    strategyFingerprint: strategyAssessment?.fingerprint || null,
    paperEvidenceFingerprint: paperAssessment?.fingerprint || null,
    paperEvidence: (paperAssessment?.perSymbol || []).map(item => ({
      symbol: item.symbol,
      totalOrders: item.totalOrders,
      comparableFills: item.comparableFills,
      paperRejectionRatePct: item.paperRejectionRatePct,
      meanSlippageBps: item.meanSlippageBps,
      p95FillLatencyMs: item.p95FillLatencyMs,
      meanFillRatio: item.meanFillRatio
    }))
  };
  const expiryCandidates = [strategyAssessment?.expiresAt]
    .concat(selectedShadow.map(item => {
      const decidedAt = new Date(item.decidedAt);
      return Number.isNaN(decidedAt.getTime())
        ? null
        : new Date(decidedAt.getTime() + SHADOW_CANDIDATE_MAX_AGE_DAYS * DAY_MS);
    }))
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(value => !Number.isNaN(value.getTime()));
  const expiresAt = expiryCandidates.length
    ? new Date(Math.min(...expiryCandidates.map(value => value.getTime())))
    : null;

  return {
    policyVersion: PRE_LIVE_EVIDENCE_POLICY_VERSION,
    passed: gates.every(gate => gate.passed),
    assessedAt: now,
    expiresAt,
    userId: userId || null,
    accountId,
    symbols,
    strategyId,
    parameterVersionId,
    selectedShadow,
    strategyAssessment,
    paperAssessment,
    gates,
    fingerprint: hashCanonicalEvidence(snapshot).hash
  };
}

module.exports = {
  PRE_LIVE_EVIDENCE_POLICY_VERSION,
  SHADOW_CANDIDATE_MAX_AGE_DAYS,
  buildPreLiveEvidenceAssessment,
  normalizeSymbols
};
