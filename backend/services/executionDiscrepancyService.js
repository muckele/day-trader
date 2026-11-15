const RoboTradeOrder = require('../models/RoboTradeOrder');
const { hashCanonicalEvidence } = require('./canaryEvidenceService');
const { extractRealizedSlippageBps } = require('./strategyValidationService');

const DISCREPANCY_POLICY_VERSION = 'paper-live-discrepancy-v2';
const PAPER_LOOKBACK_DAYS = 90;
const PAPER_ORDER_LIMIT_PER_SYMBOL = 2000;
const MIN_PAPER_FILLS_PER_SYMBOL = 20;
const MAX_PAPER_REJECTION_RATE_PCT = 5;
const MAX_LIVE_SLIPPAGE_DEGRADATION_BPS = 15;
const MIN_FILL_RATIO = 0.99;
const MAX_FILL_LATENCY_DEGRADATION_MS = 5000;

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values = [], percentileValue = 0.95) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1);
  return ordered[Math.max(0, index)];
}

function fillRatio(order = {}) {
  const expectedQty = Number(order.qty || 0);
  const filledQty = Number(order.filledQty || 0);
  if (Number.isFinite(expectedQty) && expectedQty > 0 && Number.isFinite(filledQty)) {
    return Number((filledQty / expectedQty).toFixed(6));
  }
  const expectedNotional = Number(order.notional || 0);
  const filledPrice = Number(order.filledAvgPrice || 0);
  if (
    Number.isFinite(expectedNotional)
    && expectedNotional > 0
    && Number.isFinite(filledQty)
    && filledQty > 0
    && Number.isFinite(filledPrice)
    && filledPrice > 0
  ) {
    return Number(((filledQty * filledPrice) / expectedNotional).toFixed(6));
  }
  return null;
}

function fillLatencyMs(order = {}) {
  const submittedAt = new Date(order.submittedAt);
  const filledAt = new Date(order.filledAt);
  if (Number.isNaN(submittedAt.getTime()) || Number.isNaN(filledAt.getTime()) || filledAt < submittedAt) return null;
  return filledAt.getTime() - submittedAt.getTime();
}

function slippageForOrder(order = {}) {
  return extractRealizedSlippageBps({ order });
}

function hasTrustedReferenceQuote(order = {}) {
  const quote = order.executionQuality?.metrics?.quote || {};
  const referencePrice = Number(quote.price ?? quote.midPrice);
  const timestamp = new Date(quote.timestamp);
  return quote.trustedLiveSource === true
    && quote.isMock !== true
    && Boolean(String(quote.source || '').trim())
    && Number.isFinite(referencePrice)
    && referencePrice > 0
    && !Number.isNaN(timestamp.getTime());
}

function comparableFill(order = {}) {
  const trustedReferenceQuote = hasTrustedReferenceQuote(order);
  return {
    orderId: String(order._id || ''),
    slippageBps: trustedReferenceQuote ? slippageForOrder(order) : null,
    fillRatio: fillRatio(order),
    fillLatencyMs: fillLatencyMs(order),
    trustedReferenceQuote
  };
}

function canonicalPaperOrderEvidence(order = {}) {
  const quote = order.executionQuality?.metrics?.quote || {};
  return {
    orderId: String(order._id || ''),
    symbol: String(order.symbol || '').toUpperCase(),
    side: order.side || null,
    status: String(order.status || '').toLowerCase(),
    createdAt: order.createdAt || null,
    submittedAt: order.submittedAt || null,
    filledAt: order.filledAt || null,
    qty: order.qty ?? null,
    notional: order.notional ?? null,
    filledQty: order.filledQty ?? null,
    filledAvgPrice: order.filledAvgPrice ?? null,
    slippageBps: slippageForOrder(order),
    fillRatio: fillRatio(order),
    fillLatencyMs: fillLatencyMs(order),
    trustedQuote: {
      price: quote.price ?? null,
      bidPrice: quote.bidPrice ?? null,
      askPrice: quote.askPrice ?? null,
      timestamp: quote.timestamp ?? null,
      source: quote.source ?? null,
      isMock: quote.isMock ?? null,
      trustedLiveSource: quote.trustedLiveSource ?? null
    }
  };
}

function completeFill(item = {}) {
  return item.slippageBps !== null && item.fillRatio !== null && item.fillLatencyMs !== null;
}

function summarizeSymbol(symbol, paperOrders, liveOrders) {
  const terminalPaperOrders = paperOrders.filter(order => (
    ['filled', 'rejected', 'canceled', 'cancelled', 'expired'].includes(String(order.status || '').toLowerCase())
  ));
  const rejectedPaperOrders = terminalPaperOrders.filter(order => String(order.status || '').toLowerCase() === 'rejected');
  const paperRejectionRatePct = terminalPaperOrders.length
    ? Number(((rejectedPaperOrders.length / terminalPaperOrders.length) * 100).toFixed(2))
    : null;
  const filledPaperOrders = paperOrders.filter(order => String(order.status || '').toLowerCase() === 'filled');
  const paperComparable = filledPaperOrders.map(comparableFill).filter(completeFill);
  const liveComparable = liveOrders.map(comparableFill);
  const liveComplete = liveComparable.length === liveOrders.length
    && liveComparable.length > 0
    && liveComparable.every(completeFill);
  const paperMeanSlippageBps = paperComparable.length
    ? Number(mean(paperComparable.map(item => item.slippageBps)).toFixed(2))
    : null;
  const liveMeanSlippageBps = liveComplete
    ? Number(mean(liveComparable.map(item => item.slippageBps)).toFixed(2))
    : null;
  const slippageDegradationBps = liveMeanSlippageBps !== null && paperMeanSlippageBps !== null
    ? Number((liveMeanSlippageBps - paperMeanSlippageBps).toFixed(2))
    : null;
  const paperP95LatencyMs = percentile(paperComparable.map(item => item.fillLatencyMs), 0.95);
  const liveMeanLatencyMs = liveComplete
    ? Number(mean(liveComparable.map(item => item.fillLatencyMs)).toFixed(2))
    : null;
  const gates = {
    paperFillCoverage: paperComparable.length >= MIN_PAPER_FILLS_PER_SYMBOL,
    paperRejectionRate: paperRejectionRatePct !== null && paperRejectionRatePct <= MAX_PAPER_REJECTION_RATE_PCT,
    fillCompleteness: liveComplete
      && liveComparable.every(item => item.fillRatio >= MIN_FILL_RATIO)
      && paperComparable.length > 0
      && paperComparable.every(item => item.fillRatio >= MIN_FILL_RATIO),
    slippageDiscrepancy: slippageDegradationBps !== null
      && slippageDegradationBps <= MAX_LIVE_SLIPPAGE_DEGRADATION_BPS,
    fillLatencyDiscrepancy: liveMeanLatencyMs !== null
      && paperP95LatencyMs !== null
      && liveMeanLatencyMs <= paperP95LatencyMs + MAX_FILL_LATENCY_DEGRADATION_MS
  };
  return {
    symbol,
    totalOrders: paperOrders.length,
    filledOrders: filledPaperOrders.length,
    comparableFills: paperComparable.length,
    paperRejectionRatePct,
    meanSlippageBps: paperMeanSlippageBps,
    liveMeanSlippageBps,
    slippageDegradationBps,
    p95FillLatencyMs: paperP95LatencyMs,
    liveMeanLatencyMs,
    meanFillRatio: paperComparable.length
      ? Number(mean(paperComparable.map(item => item.fillRatio)).toFixed(6))
      : null,
    paperComparable,
    liveComparable,
    gates,
    passed: Object.values(gates).every(Boolean)
  };
}

async function buildExecutionDiscrepancyAssessment({
  accountId,
  strategyId,
  parameterVersionId = null,
  symbols = [],
  dossiers = [],
  now = new Date()
} = {}, deps = {}) {
  const Model = deps.RoboTradeOrder || RoboTradeOrder;
  const normalizedSymbols = [...new Set(symbols.map(value => String(value || '').toUpperCase()).filter(Boolean))].sort();
  const cutoff = new Date(now.getTime() - PAPER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const liveOrders = dossiers.map(item => item.order || {});
  const paperBySymbol = new Map();
  if (accountId && strategyId) {
    await Promise.all(normalizedSymbols.map(async symbol => {
      const orders = await Model.find({
        accountId,
        strategyId,
        ...(parameterVersionId ? { parameterVersionId } : {}),
        environment: 'paper',
        symbol,
        $or: [{ exitReason: null }, { exitReason: { $exists: false } }],
        createdAt: { $gte: cutoff }
      }).sort({ createdAt: -1 }).limit(PAPER_ORDER_LIMIT_PER_SYMBOL).lean();
      paperBySymbol.set(
        symbol,
        (orders || []).filter(order => String(order.symbol || '').toUpperCase() === symbol)
      );
    }));
  }
  const perSymbol = normalizedSymbols.map(symbol => summarizeSymbol(
    symbol,
    paperBySymbol.get(symbol) || [],
    liveOrders.filter(order => String(order.symbol || '').toUpperCase() === symbol)
  ));
  const paperComparable = perSymbol.flatMap(item => item.paperComparable);
  const liveComparable = perSymbol.flatMap(item => item.liveComparable);
  const rejectionRates = perSymbol.map(item => item.paperRejectionRatePct).filter(value => value !== null);
  const paperRejectionRatePct = perSymbol.length && rejectionRates.length === perSymbol.length
    ? Math.max(...rejectionRates)
    : null;
  const paperMeanSlippageBps = paperComparable.length
    ? Number(mean(paperComparable.map(item => item.slippageBps)).toFixed(2))
    : null;
  const liveComplete = liveComparable.length === dossiers.length && liveComparable.every(completeFill);
  const liveMeanSlippageBps = liveComplete && liveComparable.length
    ? Number(mean(liveComparable.map(item => item.slippageBps)).toFixed(2))
    : null;
  const slippageDegradationBps = perSymbol.length && perSymbol.every(item => item.slippageDegradationBps !== null)
    ? Number(Math.max(...perSymbol.map(item => item.slippageDegradationBps)).toFixed(2))
    : null;
  const paperLatencies = perSymbol.map(item => item.p95FillLatencyMs).filter(value => value !== null);
  const paperP95LatencyMs = paperLatencies.length === perSymbol.length && perSymbol.length
    ? Math.max(...paperLatencies)
    : null;
  const liveMeanLatencyMs = liveComplete && liveComparable.length
    ? Number(mean(liveComparable.map(item => item.fillLatencyMs)).toFixed(2))
    : null;
  const allSymbolsPass = key => perSymbol.length > 0 && perSymbol.every(item => item.gates[key]);
  const gates = [
    {
      key: 'paper_fill_coverage',
      passed: allSymbolsPass('paperFillCoverage'),
      detail: perSymbol.map(item => `${item.symbol} ${item.comparableFills}/${MIN_PAPER_FILLS_PER_SYMBOL}`).join(', ') || 'No cohort symbols.'
    },
    {
      key: 'paper_rejection_rate',
      passed: allSymbolsPass('paperRejectionRate'),
      detail: perSymbol.map(item => `${item.symbol} ${item.paperRejectionRatePct ?? 'n/a'}%/${MAX_PAPER_REJECTION_RATE_PCT}%`).join(', ') || 'No terminal paper orders.'
    },
    {
      key: 'fill_completeness',
      passed: allSymbolsPass('fillCompleteness'),
      detail: `Every paper/live symbol requires at least ${(MIN_FILL_RATIO * 100).toFixed(0)}% quantity or notional completion.`
    },
    {
      key: 'slippage_discrepancy',
      passed: allSymbolsPass('slippageDiscrepancy'),
      detail: perSymbol.map(item => `${item.symbol} ${item.slippageDegradationBps ?? 'n/a'} bps/${MAX_LIVE_SLIPPAGE_DEGRADATION_BPS} bps`).join(', ')
    },
    {
      key: 'fill_latency_discrepancy',
      passed: allSymbolsPass('fillLatencyDiscrepancy'),
      detail: perSymbol.map(item => `${item.symbol} ${item.liveMeanLatencyMs ?? 'n/a'} ms live vs ${item.p95FillLatencyMs ?? 'n/a'} ms paper p95`).join(', ')
    }
  ];
  const fingerprint = hashCanonicalEvidence({
    policyVersion: DISCREPANCY_POLICY_VERSION,
    accountId: accountId || null,
    strategyId: strategyId || null,
    parameterVersionId: parameterVersionId ? String(parameterVersionId) : null,
    symbols: normalizedSymbols,
    perSymbol: perSymbol.map(item => ({
      symbol: item.symbol,
      paperOrders: item.paperComparable,
      liveOrders: item.liveComparable,
      paperRejectionRatePct: item.paperRejectionRatePct
    }))
  }).hash;
  return {
    policyVersion: DISCREPANCY_POLICY_VERSION,
    passed: gates.every(gate => gate.passed),
    assessedAt: now,
    cutoff,
    accountId: accountId || null,
    strategyId: strategyId || null,
    parameterVersionId: parameterVersionId ? String(parameterVersionId) : null,
    symbols: normalizedSymbols,
    perSymbol,
    paperRejectionRatePct,
    paperMeanSlippageBps,
    liveMeanSlippageBps,
    slippageDegradationBps,
    paperP95LatencyMs,
    liveMeanLatencyMs,
    fingerprint,
    gates
  };
}

async function buildPaperExecutionReadinessAssessment({
  accountId,
  strategyId,
  parameterVersionId,
  symbols = [],
  now = new Date()
} = {}, deps = {}) {
  const Model = deps.RoboTradeOrder || RoboTradeOrder;
  const normalizedSymbols = [...new Set(
    symbols.map(value => String(value || '').toUpperCase()).filter(Boolean)
  )].sort();
  const cutoff = new Date(now.getTime() - PAPER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const perSymbol = [];
  const evidenceBySymbol = new Map();
  let liveFillCount = 0;

  for (const symbol of normalizedSymbols) {
    let orders = [];
    if (accountId && strategyId && parameterVersionId) {
      orders = await Model.find({
        accountId,
        strategyId,
        parameterVersionId,
        environment: 'paper',
        symbol,
        $or: [{ exitReason: null }, { exitReason: { $exists: false } }],
        createdAt: { $gte: cutoff }
      }).sort({ createdAt: -1 }).limit(PAPER_ORDER_LIMIT_PER_SYMBOL).lean();
      orders = (orders || []).filter(order => (
        String(order.environment || '').toLowerCase() === 'paper'
        && String(order.strategyId || '') === String(strategyId)
        && String(order.parameterVersionId || '') === String(parameterVersionId)
      ));

      const liveFills = await Model.find({
        accountId,
        strategyId,
        parameterVersionId,
        environment: 'live',
        symbol,
        status: 'filled',
        $or: [{ exitReason: null }, { exitReason: { $exists: false } }],
        createdAt: { $gte: cutoff }
      }).sort({ createdAt: -1 }).limit(PAPER_ORDER_LIMIT_PER_SYMBOL).lean();
      liveFillCount += (liveFills || []).filter(order => (
        String(order.environment || '').toLowerCase() === 'live'
        && String(order.status || '').toLowerCase() === 'filled'
        && String(order.strategyId || '') === String(strategyId)
        && String(order.parameterVersionId || '') === String(parameterVersionId)
      )).length;
    }
    evidenceBySymbol.set(symbol, (orders || []).map(canonicalPaperOrderEvidence));
    const summary = summarizeSymbol(symbol, orders || [], []);
    const paperFillCompleteness = summary.filledOrders >= MIN_PAPER_FILLS_PER_SYMBOL
      && summary.paperComparable.length === summary.filledOrders
      && summary.paperComparable.every(item => item.fillRatio >= MIN_FILL_RATIO);
    perSymbol.push({
      ...summary,
      gates: {
        paperFillCoverage: summary.comparableFills >= MIN_PAPER_FILLS_PER_SYMBOL,
        paperRejectionRate: summary.paperRejectionRatePct !== null
          && summary.paperRejectionRatePct <= MAX_PAPER_REJECTION_RATE_PCT,
        paperFillCompleteness
      },
      passed: summary.comparableFills >= MIN_PAPER_FILLS_PER_SYMBOL
        && summary.paperRejectionRatePct !== null
        && summary.paperRejectionRatePct <= MAX_PAPER_REJECTION_RATE_PCT
        && paperFillCompleteness
    });
  }

  const gates = [
    {
      key: 'strategy_parameter_version_bound',
      passed: Boolean(accountId && strategyId && parameterVersionId),
      detail: parameterVersionId
        ? `${strategyId} · parameter version ${parameterVersionId}`
        : 'An exact strategy parameter version is required.'
    },
    {
      key: 'paper_fill_coverage',
      passed: perSymbol.length > 0 && perSymbol.every(item => item.gates.paperFillCoverage),
      detail: perSymbol.map(item => `${item.symbol} ${item.comparableFills}/${MIN_PAPER_FILLS_PER_SYMBOL}`).join(', ')
        || 'No intended symbols were supplied.'
    },
    {
      key: 'paper_rejection_rate',
      passed: perSymbol.length > 0 && perSymbol.every(item => item.gates.paperRejectionRate),
      detail: perSymbol.map(item => `${item.symbol} ${item.paperRejectionRatePct ?? 'n/a'}%/${MAX_PAPER_REJECTION_RATE_PCT}%`).join(', ')
        || 'No terminal paper orders were found.'
    },
    {
      key: 'paper_fill_completeness',
      passed: perSymbol.length > 0 && perSymbol.every(item => item.gates.paperFillCompleteness),
      detail: `Every comparable paper fill must include trusted quote, quantity, fill-price, and latency evidence with at least ${(MIN_FILL_RATIO * 100).toFixed(0)}% completion.`
    },
    {
      key: 'pre_funds_no_live_fills',
      passed: liveFillCount === 0,
      detail: `${liveFillCount} live fill(s) found in the exact pre-funds strategy/parameter cohort.`
    }
  ];
  const policyVersion = `${DISCREPANCY_POLICY_VERSION}-pre-live`;
  const fingerprint = hashCanonicalEvidence({
    policyVersion,
    accountId: accountId || null,
    strategyId: strategyId || null,
    parameterVersionId: parameterVersionId ? String(parameterVersionId) : null,
    symbols: normalizedSymbols,
    paperOrders: normalizedSymbols.map(symbol => ({
      symbol,
      orders: evidenceBySymbol.get(symbol) || []
    }))
  }).hash;

  return {
    policyVersion,
    passed: gates.every(gate => gate.passed),
    assessedAt: now,
    cutoff,
    accountId: accountId || null,
    strategyId: strategyId || null,
    parameterVersionId: parameterVersionId ? String(parameterVersionId) : null,
    symbols: normalizedSymbols,
    liveFillCount,
    perSymbol,
    fingerprint,
    gates,
    thresholds: {
      minimumPaperFillsPerSymbol: MIN_PAPER_FILLS_PER_SYMBOL,
      maximumPaperRejectionRatePct: MAX_PAPER_REJECTION_RATE_PCT,
      minimumFillRatio: MIN_FILL_RATIO
    }
  };
}

module.exports = {
  DISCREPANCY_POLICY_VERSION,
  MAX_FILL_LATENCY_DEGRADATION_MS,
  MAX_LIVE_SLIPPAGE_DEGRADATION_BPS,
  MAX_PAPER_REJECTION_RATE_PCT,
  MIN_FILL_RATIO,
  MIN_PAPER_FILLS_PER_SYMBOL,
  PAPER_LOOKBACK_DAYS,
  PAPER_ORDER_LIMIT_PER_SYMBOL,
  buildExecutionDiscrepancyAssessment,
  buildPaperExecutionReadinessAssessment,
  canonicalPaperOrderEvidence,
  hasTrustedReferenceQuote,
  fillLatencyMs,
  fillRatio,
  percentile,
  slippageForOrder,
  summarizeSymbol
};
