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

function comparableFill(order = {}) {
  return {
    orderId: String(order._id || ''),
    slippageBps: slippageForOrder(order),
    fillRatio: fillRatio(order),
    fillLatencyMs: fillLatencyMs(order)
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
        environment: 'paper',
        symbol,
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
  fillLatencyMs,
  fillRatio,
  percentile,
  slippageForOrder,
  summarizeSymbol
};
