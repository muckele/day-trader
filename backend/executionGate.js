const { computeRMultiple } = require('./analytics/analyticsUtils');

const MIN_TRADES = 30;
const MIN_SHARPE = 0.3;
const MAX_DAILY_DRAWDOWN_PCT = 1.5;
const MAX_CONSECUTIVE_LOSSES = 3;
const MAX_EXPOSURE_PCT = 20;

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function stdDev(values) {
  if (values.length <= 1) return 0;
  const mean = sum(values) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calculateStrategyStats(trades) {
  const ordered = [...trades].sort((a, b) => {
    const aTime = a.filledAt ? new Date(a.filledAt).getTime() : 0;
    const bTime = b.filledAt ? new Date(b.filledAt).getTime() : 0;
    return aTime - bTime;
  });

  const rValues = [];
  ordered.forEach(trade => {
    const r = computeRMultiple(trade);
    if (r !== null && Number.isFinite(r)) {
      rValues.push(r);
    }
  });

  const tradeCount = trades.length;
  const expectancy = rValues.length ? sum(rValues) / rValues.length : null;
  const avgR = expectancy;
  const stdDevR = rValues.length > 1 ? stdDev(rValues) : 0;
  const sharpeLikeRaw = stdDevR === 0
    ? (expectancy || 0)
    : expectancy / stdDevR;
  const sharpeLike = Math.min(sharpeLikeRaw, 5);
  const recentValues = rValues.length >= 5 ? rValues.slice(-5) : [];
  const recentAvgR = recentValues.length === 5 ? sum(recentValues) / recentValues.length : null;

  return {
    tradeCount,
    expectancy: expectancy !== null ? Number(expectancy.toFixed(2)) : null,
    avgR: avgR !== null ? Number(avgR.toFixed(2)) : null,
    stdDevR: Number(stdDevR.toFixed(2)),
    sharpeLike: Number(sharpeLike.toFixed(2)),
    recentAvgR: recentAvgR !== null ? Number(recentAvgR.toFixed(2)) : null
  };
}

function calculateAccountStats(account, settings) {
  const equityBase = account?.equity || settings?.startingCash || 0;
  const dailyPnl = account?.dailyPnl || 0;
  const dailyDrawdown = equityBase && dailyPnl < 0
    ? (Math.abs(dailyPnl) / equityBase) * 100
    : 0;
  const exposurePct = equityBase
    ? ((account?.positionsValue || 0) / equityBase) * 100
    : 0;

  return {
    dailyDrawdown: Number(dailyDrawdown.toFixed(2)),
    exposurePct: Number(exposurePct.toFixed(2)),
    consecutiveLosses: settings?.consecutiveLosses || 0
  };
}

function calculateProjectedStats({ idea, account, settings }) {
  const equityBase = account?.equity || settings?.startingCash || 0;
  const positionSizePct = Number(idea?.positionSizePct || 0);
  const entry = Number(idea?.entry || 0);
  const stop = Number(idea?.stop || 0);
  const plannedNotional = equityBase ? (equityBase * positionSizePct) / 100 : 0;
  const recommendedQty = entry > 0 ? Math.floor(plannedNotional / entry) : 0;
  const postTradeExposurePct = equityBase
    ? ((account?.positionsValue || 0) + plannedNotional) / equityBase * 100
    : 0;
  const projectedRiskPct = entry && stop
    ? (Math.abs(entry - stop) / entry) * positionSizePct
    : null;

  return {
    postTradeExposurePct: Number(postTradeExposurePct.toFixed(2)),
    projectedRiskPct: projectedRiskPct !== null ? Number(projectedRiskPct.toFixed(2)) : null,
    recommendedQty
  };
}

function evaluateExecutionGate({ idea, trades, account, settings }) {
  const reasonsBlocked = [];
  const strategyStats = calculateStrategyStats(trades);
  const accountStats = calculateAccountStats(account, settings);
  const projectedStats = calculateProjectedStats({ idea, account, settings });

  if (strategyStats.tradeCount < MIN_TRADES) {
    reasonsBlocked.push('Strategy trade count below 30.');
  }
  if (strategyStats.expectancy === null || strategyStats.expectancy <= 0) {
    reasonsBlocked.push('Strategy expectancy must be > 0.');
  }
  if (strategyStats.sharpeLike < MIN_SHARPE) {
    reasonsBlocked.push('Strategy Sharpe-like ratio below 0.3.');
  }
  if (strategyStats.recentAvgR === null) {
    reasonsBlocked.push('Insufficient recent R data.');
  } else if (strategyStats.recentAvgR < 0) {
    reasonsBlocked.push('Last 5 trades avg R below 0.');
  }

  if ((idea?.confidenceScore || 0) < 70) {
    reasonsBlocked.push('Plan confidence score below 70.');
  }
  if ((idea?.alignmentScore || 0) < 55) {
    reasonsBlocked.push('Plan alignment score below 55.');
  }

  if (accountStats.dailyDrawdown > MAX_DAILY_DRAWDOWN_PCT) {
    reasonsBlocked.push('Daily drawdown exceeds 1.5%.');
  }
  if (accountStats.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    reasonsBlocked.push('Consecutive losses threshold reached.');
  }
  if (projectedStats.postTradeExposurePct > MAX_EXPOSURE_PCT) {
    reasonsBlocked.push('Post-trade exposure exceeds 20%.');
  }
  if (projectedStats.recommendedQty < 1) {
    reasonsBlocked.push('Position size too small to execute.');
  }

  if (
    accountStats.dailyDrawdown > MAX_DAILY_DRAWDOWN_PCT
    || accountStats.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES
  ) {
    reasonsBlocked.push('Circuit breaker active for the day.');
  }

  return {
    eligible: reasonsBlocked.length === 0,
    reasonsBlocked,
    strategyStats: {
      expectancy: strategyStats.expectancy,
      sharpeLike: strategyStats.sharpeLike,
      tradeCount: strategyStats.tradeCount,
      recentAvgR: strategyStats.recentAvgR
    },
    accountStats: {
      dailyDrawdown: accountStats.dailyDrawdown,
      exposurePct: accountStats.exposurePct,
      consecutiveLosses: accountStats.consecutiveLosses
    },
    projectedStats: {
      postTradeExposurePct: projectedStats.postTradeExposurePct,
      projectedRiskPct: projectedStats.projectedRiskPct,
      recommendedQty: projectedStats.recommendedQty
    }
  };
}

module.exports = {
  evaluateExecutionGate,
  calculateStrategyStats,
  calculateAccountStats,
  calculateProjectedStats
};
