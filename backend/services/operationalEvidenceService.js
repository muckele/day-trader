const mongoState = require('../utils/mongoState');
const OrderIntent = require('../models/OrderIntent');
const RoboExposureSnapshot = require('../models/RoboExposureSnapshot');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const StrategyRun = require('../models/StrategyRun');
const { fillLatencyMs, fillRatio, slippageForOrder } = require('./executionDiscrepancyService');

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_RECORD_LIMIT = 100;
const MAX_LOOKBACK_DAYS = 365;
const MAX_RECORD_LIMIT = 500;
const STALE_OPEN_ORDER_MS = 15 * 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const numeric = Math.floor(Number(value));
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : fallback));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mean(values = []) {
  const finite = values.map(finiteNumber).filter(value => value !== null);
  if (!finite.length) return null;
  return Number((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(2));
}

function stringId(value) {
  if (!value) return null;
  return String(value._id || value);
}

function runMetrics(run = {}) {
  return run.metrics || run.result?.metrics || {};
}

function summarizeStrategyRuns(runs = []) {
  const groups = new Map();
  for (const run of runs) {
    const strategyId = String(run.strategyId || 'UNASSIGNED');
    if (!groups.has(strategyId)) {
      groups.set(strategyId, {
        strategyId,
        strategyName: run.strategyName || null,
        runs: [],
        symbols: new Set(),
        parameterVersions: new Set()
      });
    }
    const group = groups.get(strategyId);
    group.runs.push(run);
    if (run.symbol) group.symbols.add(String(run.symbol).toUpperCase());
    const parameterVersion = run.parameterVersionId?.version;
    if (parameterVersion !== undefined && parameterVersion !== null) {
      group.parameterVersions.add(String(parameterVersion));
    }
  }

  return [...groups.values()].map(group => {
    const ordered = [...group.runs].sort((a, b) => (
      new Date(b.completedAt || b.startedAt || 0) - new Date(a.completedAt || a.startedAt || 0)
    ));
    const completed = ordered.filter(run => run.status === 'completed');
    const walkForward = completed.filter(run => run.summary?.validationType === 'walk_forward');
    const qualifyingWalkForward = walkForward.filter(run => run.summary?.passed === true);
    const metricRuns = walkForward.length ? walkForward : completed;
    const completedMetrics = metricRuns.map(runMetrics);
    return {
      strategyId: group.strategyId,
      strategyName: group.strategyName || group.strategyId,
      status: qualifyingWalkForward.length
        ? 'validated'
        : ordered.some(run => run.status === 'failed')
          ? 'attention'
          : 'collecting',
      latestRunAt: ordered[0]?.completedAt || ordered[0]?.startedAt || null,
      latestRunStatus: ordered[0]?.status || null,
      runCount: ordered.length,
      completedRunCount: completed.length,
      failedRunCount: ordered.filter(run => run.status === 'failed').length,
      walkForwardRunCount: walkForward.length,
      qualifyingWalkForwardRunCount: qualifyingWalkForward.length,
      metricBasis: walkForward.length ? 'walk_forward' : 'completed_runs',
      symbols: [...group.symbols].sort(),
      parameterVersions: [...group.parameterVersions].sort((a, b) => Number(a) - Number(b)),
      metrics: {
        meanTradeCount: mean(completedMetrics.map(metrics => metrics.tradeCount)),
        meanWinRate: mean(completedMetrics.map(metrics => metrics.winRate)),
        meanAverageR: mean(completedMetrics.map(metrics => metrics.avgR)),
        worstMaxDrawdown: (() => {
          const values = completedMetrics.map(metrics => finiteNumber(metrics.maxDrawdown)).filter(value => value !== null);
          return values.length ? Math.max(...values) : null;
        })(),
        meanPositiveWindowRatePct: mean(completedMetrics.map(metrics => metrics.positiveWindowRatePct))
      }
    };
  }).sort((a, b) => new Date(b.latestRunAt || 0) - new Date(a.latestRunAt || 0));
}

function summarizeExposures(snapshots = []) {
  const ordered = [...snapshots].sort((a, b) => new Date(a.capturedAt || 0) - new Date(b.capturedAt || 0));
  const grossValues = ordered.map(item => finiteNumber(item.grossExposurePct)).filter(value => value !== null);
  const drawdownValues = ordered.map(item => finiteNumber(item.totalDrawdownPct)).filter(value => value !== null);
  const dailyDrawdownValues = ordered.map(item => finiteNumber(item.dailyDrawdownPct)).filter(value => value !== null);
  const latest = ordered.at(-1) || null;
  return {
    summary: {
      snapshotCount: ordered.length,
      breachCount: ordered.filter(item => item.breached === true).length,
      peakGrossExposurePct: grossValues.length ? Math.max(...grossValues) : null,
      peakTotalDrawdownPct: drawdownValues.length ? Math.max(...drawdownValues) : null,
      peakDailyDrawdownPct: dailyDrawdownValues.length ? Math.max(...dailyDrawdownValues) : null,
      latest: latest ? {
        capturedAt: latest.capturedAt,
        environment: latest.environment,
        equity: finiteNumber(latest.equity),
        cash: finiteNumber(latest.cash),
        grossExposurePct: finiteNumber(latest.grossExposurePct),
        netExposurePct: finiteNumber(latest.netExposurePct),
        totalDrawdownPct: finiteNumber(latest.totalDrawdownPct),
        positionCount: finiteNumber(latest.positionCount),
        workingOrderCount: finiteNumber(latest.workingOrderCount),
        breached: latest.breached === true,
        breachReasonCodes: latest.breachReasonCodes || []
      } : null
    },
    series: ordered.map(item => ({
      capturedAt: item.capturedAt,
      environment: item.environment,
      equity: finiteNumber(item.equity),
      grossExposurePct: finiteNumber(item.grossExposurePct),
      netExposurePct: finiteNumber(item.netExposurePct),
      totalDrawdownPct: finiteNumber(item.totalDrawdownPct),
      dailyDrawdownPct: finiteNumber(item.dailyDrawdownPct),
      positionCount: finiteNumber(item.positionCount),
      breached: item.breached === true
    }))
  };
}

function failedRiskChecks(record = {}) {
  return (record.riskChecks || [])
    .filter(check => check?.passed === false)
    .map(check => ({
      name: check.name || 'unknown_check',
      severity: check.severity || 'warning',
      message: check.message || null
    }));
}

function summarizeBlotter(intents = [], roboOrders = [], now = new Date()) {
  const orderByIntent = new Map();
  for (const order of roboOrders) {
    const intentId = stringId(order.intentId);
    if (intentId && !orderByIntent.has(intentId)) orderByIntent.set(intentId, order);
  }

  const rows = intents.map(intent => {
    const order = orderByIntent.get(stringId(intent._id)) || null;
    const riskFailures = failedRiskChecks(intent);
    const submittedAt = order?.submittedAt || null;
    const openStatus = ['pending_submit', 'accepted', 'new', 'partially_filled', 'submitted'].includes(
      String(order?.status || '').toLowerCase()
    );
    const stale = Boolean(
      openStatus
      && submittedAt
      && now.getTime() - new Date(submittedAt).getTime() > STALE_OPEN_ORDER_MS
    );
    return {
      intentId: stringId(intent._id),
      orderId: stringId(order?._id),
      requestedAt: intent.requestedAt || intent.createdAt || null,
      submittedAt,
      symbol: intent.symbol,
      assetClass: intent.assetClass,
      environment: intent.environment,
      side: intent.side,
      qty: finiteNumber(intent.qty),
      estimatedNotional: finiteNumber(intent.estimatedNotional || intent.notional),
      strategyId: intent.strategyId || order?.strategyId || null,
      origin: intent.origin,
      intentStatus: intent.status,
      brokerStatus: order?.status || null,
      reconciliationStatus: order?.reconciliationStatus || null,
      authorizationStatus: intent.authorizationStatus || null,
      reasonCodes: intent.reasonCodes || [],
      rejectionReason: intent.rejectionReason || order?.discrepancy || null,
      riskFailures,
      slippageBps: finiteNumber(order?.executionQuality?.realizedSlippageBps ?? order?.executionQuality?.slippageBps),
      fillLatencyMs: (() => {
        if (!order?.submittedAt || !order?.filledAt) return null;
        const latency = new Date(order.filledAt) - new Date(order.submittedAt);
        return Number.isFinite(latency) && latency >= 0 ? latency : null;
      })(),
      discrepancy: order?.discrepancy || null,
      stale
    };
  }).sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

  const rejected = rows.filter(row => (
    row.intentStatus === 'rejected'
    || row.intentStatus === 'policy_blocked'
    || row.brokerStatus === 'rejected'
  ));
  const terminal = rows.filter(row => (
    ['filled', 'rejected', 'cancelled', 'policy_blocked'].includes(row.intentStatus)
    || ['filled', 'rejected', 'canceled', 'cancelled', 'expired'].includes(String(row.brokerStatus || '').toLowerCase())
  ));
  const environmentCounts = rows.reduce((acc, row) => {
    const key = row.environment || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    summary: {
      intentCount: rows.length,
      terminalCount: terminal.length,
      rejectedCount: rejected.length,
      rejectRatePct: terminal.length ? Number(((rejected.length / terminal.length) * 100).toFixed(2)) : 0,
      policyBlockedCount: rows.filter(row => row.intentStatus === 'policy_blocked').length,
      riskFailureCount: rows.filter(row => row.riskFailures.length > 0).length,
      discrepancyCount: rows.filter(row => Boolean(row.discrepancy)).length,
      staleOpenOrderCount: rows.filter(row => row.stale).length,
      environmentCounts
    },
    rows
  };
}

function summarizePaperCoverage(roboOrders = []) {
  const groups = new Map();
  for (const order of roboOrders.filter(item => item.environment === 'paper')) {
    const strategyId = order.strategyId || 'UNASSIGNED';
    const symbol = String(order.symbol || '').toUpperCase();
    if (!symbol) continue;
    const key = `${strategyId}|${symbol}`;
    if (!groups.has(key)) {
      groups.set(key, {
        strategyId,
        symbol,
        totalOrders: 0,
        filledOrders: 0,
        comparableFills: 0,
        rejectedOrders: 0
      });
    }
    const group = groups.get(key);
    group.totalOrders += 1;
    const status = String(order.status || '').toLowerCase();
    if (status === 'filled') {
      group.filledOrders += 1;
      const comparable = slippageForOrder(order) !== null
        && fillRatio(order) !== null
        && fillLatencyMs(order) !== null;
      if (comparable) group.comparableFills += 1;
    }
    if (status === 'rejected') group.rejectedOrders += 1;
  }
  return [...groups.values()].map(item => ({
    ...item,
    targetComparableFills: 20,
    coveragePct: Math.min(100, Number(((item.comparableFills / 20) * 100).toFixed(2)))
  })).sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.symbol.localeCompare(b.symbol));
}

async function leanQuery(model, query, sort, limit, populate = null) {
  let request = model.find(query);
  if (populate && typeof request.populate === 'function') request = request.populate(populate);
  return request.sort(sort).limit(limit).lean();
}

async function countQuery(model, query) {
  if (typeof model.countDocuments !== 'function') return null;
  return model.countDocuments(query);
}

function buildCompleteness(recordLimit, collections = {}, reason = null) {
  const entries = Object.entries(collections).map(([key, value]) => {
    const matchedCount = finiteNumber(value?.matchedCount);
    const returnedCount = finiteNumber(value?.returnedCount) ?? 0;
    const countKnown = matchedCount !== null;
    const truncated = countKnown ? matchedCount > returnedCount : true;
    return [key, {
      matchedCount,
      returnedCount,
      recordLimit,
      truncated,
      complete: countKnown && !truncated
    }];
  });
  const byCollection = Object.fromEntries(entries);
  return {
    complete: !reason && entries.length > 0 && entries.every(([, value]) => value.complete),
    reason,
    recordLimit,
    collections: byCollection
  };
}

async function getOperationalEvidence({ accountId, days, limit, now = new Date() } = {}, deps = {}) {
  const scopedAccountId = String(accountId || '').trim();
  if (!scopedAccountId) throw new Error('accountId is required.');
  const lookbackDays = clampInteger(days, DEFAULT_LOOKBACK_DAYS, 1, MAX_LOOKBACK_DAYS);
  const recordLimit = clampInteger(limit, DEFAULT_RECORD_LIMIT, 1, MAX_RECORD_LIMIT);
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  if (!(deps.isMongoReady || mongoState.isMongoReady)()) {
    return {
      generatedAt: now,
      lookbackDays,
      cutoff,
      strategyScorecards: [],
      exposure: summarizeExposures([]),
      blotter: summarizeBlotter([], [], now),
      paperCoverage: [],
      completeness: buildCompleteness(recordLimit, {
        strategyRuns: { matchedCount: null, returnedCount: 0 },
        exposureSnapshots: { matchedCount: null, returnedCount: 0 },
        orderIntents: { matchedCount: null, returnedCount: 0 },
        roboTradeOrders: { matchedCount: null, returnedCount: 0 }
      }, 'DATA_UNAVAILABLE')
    };
  }

  const Models = {
    StrategyRun: deps.StrategyRun || StrategyRun,
    RoboExposureSnapshot: deps.RoboExposureSnapshot || RoboExposureSnapshot,
    OrderIntent: deps.OrderIntent || OrderIntent,
    RoboTradeOrder: deps.RoboTradeOrder || RoboTradeOrder
  };
  const runQuery = { accountId: scopedAccountId, startedAt: { $gte: cutoff } };
  const exposureQuery = { accountId: scopedAccountId, capturedAt: { $gte: cutoff } };
  const intentQuery = { accountId: scopedAccountId, requestedAt: { $gte: cutoff } };
  const orderQuery = { accountId: scopedAccountId, createdAt: { $gte: cutoff } };
  const [
    runs,
    snapshots,
    intents,
    roboOrders,
    runCount,
    snapshotCount,
    intentCount,
    orderCount,
    breachCount,
    discrepancyCount
  ] = await Promise.all([
    leanQuery(Models.StrategyRun, runQuery, { startedAt: -1 }, recordLimit, 'parameterVersionId'),
    leanQuery(Models.RoboExposureSnapshot, exposureQuery, { capturedAt: -1 }, recordLimit),
    leanQuery(Models.OrderIntent, intentQuery, { requestedAt: -1 }, recordLimit),
    leanQuery(Models.RoboTradeOrder, orderQuery, { createdAt: -1 }, recordLimit),
    countQuery(Models.StrategyRun, runQuery),
    countQuery(Models.RoboExposureSnapshot, exposureQuery),
    countQuery(Models.OrderIntent, intentQuery),
    countQuery(Models.RoboTradeOrder, orderQuery),
    countQuery(Models.RoboExposureSnapshot, { ...exposureQuery, breached: true }),
    countQuery(Models.RoboTradeOrder, {
      ...orderQuery,
      discrepancy: { $type: 'string', $ne: '' }
    })
  ]);

  const exposure = summarizeExposures(snapshots);
  if (finiteNumber(breachCount) !== null) exposure.summary.breachCount = Number(breachCount);
  const blotter = summarizeBlotter(intents, roboOrders, now);
  if (finiteNumber(discrepancyCount) !== null) blotter.summary.discrepancyCount = Number(discrepancyCount);
  const completeness = buildCompleteness(recordLimit, {
    strategyRuns: { matchedCount: runCount, returnedCount: runs.length },
    exposureSnapshots: { matchedCount: snapshotCount, returnedCount: snapshots.length },
    orderIntents: { matchedCount: intentCount, returnedCount: intents.length },
    roboTradeOrders: { matchedCount: orderCount, returnedCount: roboOrders.length }
  });

  return {
    generatedAt: now,
    lookbackDays,
    cutoff,
    strategyScorecards: summarizeStrategyRuns(runs),
    exposure,
    blotter,
    paperCoverage: summarizePaperCoverage(roboOrders),
    completeness
  };
}

module.exports = {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RECORD_LIMIT,
  MAX_LOOKBACK_DAYS,
  MAX_RECORD_LIMIT,
  STALE_OPEN_ORDER_MS,
  buildCompleteness,
  finiteNumber,
  getOperationalEvidence,
  summarizeBlotter,
  summarizeExposures,
  summarizePaperCoverage,
  summarizeStrategyRuns
};
