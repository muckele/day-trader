const StrategyRun = require('../models/StrategyRun');
const StrategyParameterVersion = require('../models/StrategyParameterVersion');
const { hashCanonicalEvidence } = require('./canaryEvidenceService');

const STRATEGY_EVIDENCE_POLICY_VERSION = 'controlled-live-strategy-evidence-v1';
const BACKTEST_MAX_AGE_DAYS = 90;
const MIN_BACKTEST_TRADES = 30;
const MIN_BACKTEST_AVG_R = 0;
const MAX_BACKTEST_DRAWDOWN_PCT = 10;
const MAX_CANARY_SLIPPAGE_BPS = 50;
const MAX_MEAN_CANARY_SLIPPAGE_BPS = 25;
const MIN_WALK_FORWARD_WINDOWS = 3;
const MIN_POSITIVE_WINDOW_RATE_PCT = 60;

function toFinite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function extractRealizedSlippageBps(dossier = {}) {
  const order = dossier.order || {};
  const referencePrice = toFinite(
    order.executionQuality?.metrics?.quote?.price
      ?? order.executionQuality?.metrics?.quote?.midPrice,
    null
  );
  const fillPrice = toFinite(order.filledAvgPrice, null);
  if (!referencePrice || referencePrice <= 0 || !fillPrice || fillPrice <= 0) return null;
  const side = String(order.side || '').toLowerCase();
  const adverseMove = side === 'sell'
    ? referencePrice - fillPrice
    : fillPrice - referencePrice;
  return Number(((adverseMove / referencePrice) * 10000).toFixed(2));
}

function summarizeRun(run = {}) {
  return {
    runId: String(run._id || ''),
    symbol: String(run.symbol || '').toUpperCase(),
    parameterVersionId: run.parameterVersionId ? String(run.parameterVersionId) : null,
    completedAt: run.completedAt || null,
    metrics: {
      tradeCount: toFinite(run.metrics?.tradeCount, 0),
      winRate: toFinite(run.metrics?.winRate, null),
      avgR: toFinite(run.metrics?.avgR, null),
      maxDrawdown: toFinite(run.metrics?.maxDrawdown, null),
      windowCount: toFinite(run.metrics?.windowCount, 0),
      positiveWindowRatePct: toFinite(run.metrics?.positiveWindowRatePct, 0)
    }
  };
}

async function buildStrategyValidationAssessment({
  accountId,
  strategyId,
  symbols = [],
  dossiers = [],
  now = new Date()
} = {}, deps = {}) {
  const Model = deps.StrategyRun || StrategyRun;
  const ParameterVersion = deps.StrategyParameterVersion || StrategyParameterVersion;
  const normalizedSymbols = [...new Set(symbols.map(value => String(value || '').toUpperCase()).filter(Boolean))].sort();
  const cutoff = new Date(now.getTime() - BACKTEST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  let runs = [];
  if (accountId && strategyId && normalizedSymbols.length) {
    runs = await Model.find({
      accountId,
      strategyId,
      runType: 'backtest',
      mode: 'simulation',
      status: 'completed',
      'summary.validationType': 'walk_forward',
      symbol: { $in: normalizedSymbols },
      completedAt: { $gte: cutoff }
    }).sort({ completedAt: -1 }).lean();
  }
  const latestBySymbol = new Map();
  for (const run of runs || []) {
    const symbol = String(run.symbol || '').toUpperCase();
    if (normalizedSymbols.includes(symbol) && !latestBySymbol.has(symbol)) latestBySymbol.set(symbol, run);
  }
  const selectedRuns = normalizedSymbols.map(symbol => latestBySymbol.get(symbol)).filter(Boolean);
  const summaries = selectedRuns.map(summarizeRun);
  const parameterVersions = [...new Set(summaries.map(run => run.parameterVersionId).filter(Boolean))];
  let parameterVersion = null;
  if (parameterVersions.length === 1) {
    const parameterQuery = ParameterVersion.findOne({
      _id: parameterVersions[0],
      accountId,
      strategyId
    });
    parameterVersion = typeof parameterQuery?.lean === 'function'
      ? await parameterQuery.lean()
      : await parameterQuery;
  }
  const parameterSnapshot = parameterVersion ? {
    id: String(parameterVersion._id),
    version: toFinite(parameterVersion.version, null),
    parameterHash: parameterVersion.parameterHash || null,
    parameters: parameterVersion.parameters || {},
    createdAt: parameterVersion.createdAt || null
  } : null;
  const metricsPass = summaries.length === normalizedSymbols.length && summaries.every(run => (
    run.metrics.tradeCount >= MIN_BACKTEST_TRADES
    && run.metrics.avgR !== null
    && run.metrics.avgR > MIN_BACKTEST_AVG_R
    && run.metrics.maxDrawdown !== null
    && run.metrics.maxDrawdown <= MAX_BACKTEST_DRAWDOWN_PCT
    && run.metrics.windowCount >= MIN_WALK_FORWARD_WINDOWS
    && run.metrics.positiveWindowRatePct >= MIN_POSITIVE_WINDOW_RATE_PCT
  ));
  const slippage = dossiers.map(extractRealizedSlippageBps);
  const slippageComplete = slippage.length === dossiers.length && slippage.every(value => value !== null);
  const meanSlippageBps = slippageComplete && slippage.length
    ? Number((slippage.reduce((sum, value) => sum + value, 0) / slippage.length).toFixed(2))
    : null;
  const slippagePass = slippageComplete
    && slippage.every(value => value <= MAX_CANARY_SLIPPAGE_BPS)
    && meanSlippageBps <= MAX_MEAN_CANARY_SLIPPAGE_BPS;
  const gates = [
    {
      key: 'backtest_coverage',
      passed: selectedRuns.length === normalizedSymbols.length && normalizedSymbols.length > 0,
      detail: `${selectedRuns.length}/${normalizedSymbols.length || 0} cohort symbols have a completed backtest from the last ${BACKTEST_MAX_AGE_DAYS} days`
    },
    {
      key: 'parameter_version_consistent',
      passed: parameterVersions.length === 1 && Boolean(parameterSnapshot?.parameterHash),
      detail: parameterSnapshot?.parameterHash
        ? `${parameterSnapshot.id} · v${parameterSnapshot.version} · ${parameterSnapshot.parameterHash.slice(0, 12)}…`
        : `${parameterVersions.length} valid parameter versions found`
    },
    {
      key: 'backtest_quality',
      passed: metricsPass,
      detail: `Each run requires ${MIN_WALK_FORWARD_WINDOWS}+ windows, ${MIN_POSITIVE_WINDOW_RATE_PCT}% positive windows, ${MIN_BACKTEST_TRADES}+ out-of-sample trades, positive average R, and no more than ${MAX_BACKTEST_DRAWDOWN_PCT}% drawdown`
    },
    {
      key: 'execution_drift',
      passed: slippagePass,
      detail: meanSlippageBps === null
        ? 'Realized adverse slippage could not be computed for every canary.'
        : `${meanSlippageBps} bps mean; ${Math.max(...slippage)} bps worst`
    }
  ];
  const fingerprint = hashCanonicalEvidence({
    policyVersion: STRATEGY_EVIDENCE_POLICY_VERSION,
    accountId: accountId || null,
    strategyId: strategyId || null,
    symbols: normalizedSymbols,
    runs: summaries,
    parameterVersion: parameterSnapshot,
    realizedSlippageBps: slippage
  }).hash;
  return {
    policyVersion: STRATEGY_EVIDENCE_POLICY_VERSION,
    passed: gates.every(gate => gate.passed),
    assessedAt: now,
    expiresAt: selectedRuns.length
      ? new Date(Math.min(...selectedRuns.map(run => new Date(run.completedAt).getTime())) + BACKTEST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
      : null,
    accountId: accountId || null,
    strategyId: strategyId || null,
    symbols: normalizedSymbols,
    parameterVersionId: parameterSnapshot?.id || null,
    parameterVersion: parameterSnapshot,
    runs: summaries,
    realizedSlippageBps: slippage,
    meanSlippageBps,
    fingerprint,
    gates
  };
}

module.exports = {
  BACKTEST_MAX_AGE_DAYS,
  MAX_BACKTEST_DRAWDOWN_PCT,
  MAX_CANARY_SLIPPAGE_BPS,
  MAX_MEAN_CANARY_SLIPPAGE_BPS,
  MIN_BACKTEST_AVG_R,
  MIN_BACKTEST_TRADES,
  MIN_POSITIVE_WINDOW_RATE_PCT,
  MIN_WALK_FORWARD_WINDOWS,
  STRATEGY_EVIDENCE_POLICY_VERSION,
  buildStrategyValidationAssessment,
  extractRealizedSlippageBps,
  summarizeRun
};
