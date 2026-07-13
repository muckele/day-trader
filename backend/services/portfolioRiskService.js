const { deriveEffectiveNotional } = require('./canonicalTradingPolicyService');

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : 0;
}

function normalizeWorkingOrder(order = {}) {
  const raw = order.raw || {};
  const orderInput = {
    qty: order.qty ?? raw.qty,
    notional: order.notional ?? raw.notional,
    estimatedNotional: order.estimatedNotional ?? order.estimated_notional,
    orderType: order.orderType ?? order.type ?? raw.type,
    limitPrice: order.limitPrice ?? order.limit_price ?? raw.limit_price,
    stopPrice: order.stopPrice ?? order.stop_price ?? raw.stop_price,
    referencePrice: order.referencePrice ?? order.reference_price
  };
  const qty = Math.abs(toFiniteNumber(orderInput.qty));
  const notional = deriveEffectiveNotional(orderInput);
  return {
    id: order.id || order.externalOrderId || null,
    clientOrderId: order.client_order_id || order.clientOrderId || null,
    symbol: String(order.symbol || raw.symbol || '').trim().toUpperCase(),
    side: String(order.side || raw.side || '').trim().toLowerCase(),
    qty,
    notional: notional.value,
    notionalVerified: notional.authoritative,
    orderType: String(orderInput.orderType || 'market').trim().toLowerCase(),
    limitPrice: toFiniteNumber(orderInput.limitPrice, null),
    stopPrice: toFiniteNumber(orderInput.stopPrice, null)
  };
}

function buildWorkingOrderExposure(orders = [], positions = []) {
  const positionQtyBySymbol = new Map(
    positions.map(position => [position.symbol, toFiniteNumber(position.qty)])
  );
  const workingOrders = (orders || [])
    .map(normalizeWorkingOrder)
    .filter(order => order.symbol && ['buy', 'sell'].includes(order.side));
  const groups = new Map();

  for (const order of workingOrders) {
    const key = `${order.symbol}:${order.side}`;
    const group = groups.get(key) || {
      symbol: order.symbol,
      side: order.side,
      qty: 0,
      pricedQty: 0,
      pricedNotional: 0,
      notionalOnly: 0,
      unpricedCount: 0
    };
    if (order.qty > 0) {
      group.qty += order.qty;
      if (order.notionalVerified && order.notional > 0) {
        group.pricedQty += order.qty;
        group.pricedNotional += order.notional;
      } else {
        group.unpricedCount += 1;
      }
    } else if (order.notionalVerified && order.notional > 0) {
      // A notional-only working order cannot be proven to be a bounded close,
      // so reserve all of it as risk-increasing exposure.
      group.notionalOnly += order.notional;
    } else {
      group.unpricedCount += 1;
    }
    groups.set(key, group);
  }

  let reservedLongExposure = 0;
  let reservedShortExposure = 0;
  let unpricedWorkingOrderCount = 0;
  const groupSummaries = [];
  for (const group of groups.values()) {
    const positionQty = positionQtyBySymbol.get(group.symbol) || 0;
    const closingCapacity = group.side === 'buy'
      ? Math.max(0, -positionQty)
      : Math.max(0, positionQty);
    const riskIncreasingQty = Math.max(0, group.qty - closingCapacity);
    const pricedRiskFraction = group.qty > 0 ? riskIncreasingQty / group.qty : 0;
    const riskIncreasingNotional = group.notionalOnly + (group.pricedNotional * pricedRiskFraction);
    if (riskIncreasingQty > group.pricedQty || (riskIncreasingQty > 0 && group.unpricedCount > 0)) {
      unpricedWorkingOrderCount += group.unpricedCount;
    }
    if (group.side === 'buy') reservedLongExposure += riskIncreasingNotional;
    else reservedShortExposure += riskIncreasingNotional;
    groupSummaries.push({
      symbol: group.symbol,
      side: group.side,
      qty: round(group.qty, 6),
      closingCapacity: round(closingCapacity, 6),
      riskIncreasingQty: round(riskIncreasingQty, 6),
      riskIncreasingNotional: round(riskIncreasingNotional),
      verified: !(riskIncreasingQty > group.pricedQty || (riskIncreasingQty > 0 && group.unpricedCount > 0))
    });
  }

  return {
    workingOrders,
    groups: groupSummaries,
    reservedLongExposure,
    reservedShortExposure,
    unpricedWorkingOrderCount
  };
}

function buildPortfolioRiskSnapshot({
  userId,
  accountId,
  environment,
  account = {},
  positions = [],
  openOrders = [],
  portfolioPolicy = {},
  previousSnapshot = null,
  now = new Date()
} = {}) {
  const normalizedPositions = (positions || []).map(position => {
    const qty = toFiniteNumber(position.qty);
    const rawValue = toFiniteNumber(position.market_value ?? position.marketValue);
    const isShort = qty < 0 || rawValue < 0 || String(position.side || '').toLowerCase() === 'short';
    return {
      symbol: String(position.symbol || '').toUpperCase(),
      qty,
      marketValue: Math.abs(rawValue),
      side: isShort ? 'short' : 'long'
    };
  }).filter(position => position.symbol && position.qty !== 0);
  const positionLongExposure = normalizedPositions
    .filter(position => position.side === 'long')
    .reduce((sum, position) => sum + position.marketValue, 0);
  const positionShortExposure = normalizedPositions
    .filter(position => position.side === 'short')
    .reduce((sum, position) => sum + position.marketValue, 0);
  const workingOrderExposure = buildWorkingOrderExposure(openOrders, normalizedPositions);
  const longExposure = positionLongExposure + workingOrderExposure.reservedLongExposure;
  const shortExposure = positionShortExposure + workingOrderExposure.reservedShortExposure;
  const grossExposure = longExposure + shortExposure;
  const netExposure = longExposure - shortExposure;
  const equity = Math.max(0, toFiniteNumber(account.equity ?? account.portfolio_value));
  const lastEquity = Math.max(0, toFiniteNumber(account.last_equity ?? account.lastEquity, equity));
  const previousPeak = Math.max(0, toFiniteNumber(previousSnapshot?.peakEquity));
  const peakEquity = Math.max(equity, lastEquity, previousPeak);
  const grossExposurePct = equity > 0 ? (grossExposure / equity) * 100 : (grossExposure > 0 ? Infinity : 0);
  const netExposurePct = equity > 0 ? (Math.abs(netExposure) / equity) * 100 : (netExposure !== 0 ? Infinity : 0);
  const dailyDrawdownPct = lastEquity > 0 ? Math.max(0, ((lastEquity - equity) / lastEquity) * 100) : 0;
  const totalDrawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100) : 0;
  const limits = {
    maxGrossExposurePct: toFiniteNumber(portfolioPolicy.maxGrossExposurePct, 100),
    maxNetExposurePct: toFiniteNumber(portfolioPolicy.maxNetExposurePct, 100),
    maxDailyDrawdownPct: toFiniteNumber(portfolioPolicy.maxDailyDrawdownPct, 2),
    maxTotalDrawdownPct: toFiniteNumber(portfolioPolicy.maxTotalDrawdownPct, 5),
    pauseOnBreach: portfolioPolicy.pauseOnBreach !== false
  };
  const checks = [
    {
      name: 'working_order_exposure_verified',
      passed: workingOrderExposure.unpricedWorkingOrderCount === 0,
      message: 'One or more risk-increasing working orders could not be valued for portfolio exposure.',
      severity: 'critical',
      metadata: { unpricedWorkingOrderCount: workingOrderExposure.unpricedWorkingOrderCount }
    },
    {
      name: 'gross_exposure_limit',
      passed: grossExposurePct <= limits.maxGrossExposurePct,
      message: 'Gross portfolio exposure exceeds the configured limit.',
      severity: 'critical',
      metadata: { grossExposurePct: round(grossExposurePct), limit: limits.maxGrossExposurePct }
    },
    {
      name: 'net_exposure_limit',
      passed: netExposurePct <= limits.maxNetExposurePct,
      message: 'Absolute net portfolio exposure exceeds the configured limit.',
      severity: 'critical',
      metadata: { netExposurePct: round(netExposurePct), limit: limits.maxNetExposurePct }
    },
    {
      name: 'daily_drawdown_limit',
      passed: dailyDrawdownPct <= limits.maxDailyDrawdownPct,
      message: 'Daily account drawdown exceeds the configured limit.',
      severity: 'critical',
      metadata: { dailyDrawdownPct: round(dailyDrawdownPct), limit: limits.maxDailyDrawdownPct }
    },
    {
      name: 'total_drawdown_limit',
      passed: totalDrawdownPct <= limits.maxTotalDrawdownPct,
      message: 'Account drawdown from peak equity exceeds the configured limit.',
      severity: 'critical',
      metadata: { totalDrawdownPct: round(totalDrawdownPct), limit: limits.maxTotalDrawdownPct }
    }
  ];
  const breachReasonCodes = checks
    .filter(check => !check.passed)
    .map(check => check.name.toUpperCase());

  return {
    userId,
    accountId,
    environment,
    equity: round(equity),
    lastEquity: round(lastEquity),
    peakEquity: round(peakEquity),
    cash: round(account.cash),
    buyingPower: round(account.buying_power ?? account.buyingPower),
    positionLongExposure: round(positionLongExposure),
    positionShortExposure: round(positionShortExposure),
    reservedLongExposure: round(workingOrderExposure.reservedLongExposure),
    reservedShortExposure: round(workingOrderExposure.reservedShortExposure),
    reservedGrossExposure: round(
      workingOrderExposure.reservedLongExposure + workingOrderExposure.reservedShortExposure
    ),
    reservedNetExposure: round(
      workingOrderExposure.reservedLongExposure - workingOrderExposure.reservedShortExposure
    ),
    longExposure: round(longExposure),
    shortExposure: round(shortExposure),
    grossExposure: round(grossExposure),
    netExposure: round(netExposure),
    grossExposurePct: round(grossExposurePct),
    netExposurePct: round(netExposurePct),
    dailyDrawdownPct: round(dailyDrawdownPct),
    totalDrawdownPct: round(totalDrawdownPct),
    positionCount: normalizedPositions.length,
    positions: normalizedPositions,
    workingOrderCount: workingOrderExposure.workingOrders.length,
    workingOrders: workingOrderExposure.workingOrders,
    workingOrderGroups: workingOrderExposure.groups,
    unpricedWorkingOrderCount: workingOrderExposure.unpricedWorkingOrderCount,
    limits,
    checks,
    breached: breachReasonCodes.length > 0,
    breachReasonCodes,
    capturedAt: now
  };
}

function asRiskResult(snapshot = {}) {
  const failed = (snapshot.checks || []).filter(check => !check.passed);
  return {
    approved: failed.length === 0,
    checks: snapshot.checks || [],
    rejectionReasons: failed.map(check => check.message)
  };
}

function evaluateProjectedPortfolioRisk(snapshot = {}, orderInput = {}) {
  const notional = deriveEffectiveNotional(orderInput).value;
  const symbol = String(orderInput.symbol || '').toUpperCase();
  const side = String(orderInput.side || '').toLowerCase();
  const requestedQty = Math.abs(toFiniteNumber(orderInput.qty));
  const position = (snapshot.positions || []).find(item => item.symbol === symbol);
  const positionQty = toFiniteNumber(position?.qty);
  const riskReducingOnly = requestedQty > 0 && (
    (side === 'sell' && positionQty > 0 && requestedQty <= positionQty)
    || (side === 'buy' && positionQty < 0 && requestedQty <= Math.abs(positionQty))
  );
  const grossDelta = riskReducingOnly
    ? -Math.min(notional, toFiniteNumber(position?.marketValue))
    : notional;
  const signedNetDelta = side === 'sell' ? -notional : notional;
  const projectedGrossExposure = Math.max(0, toFiniteNumber(snapshot.grossExposure) + grossDelta);
  const projectedNetExposure = toFiniteNumber(snapshot.netExposure) + signedNetDelta;
  const equity = toFiniteNumber(snapshot.equity);
  const projectedGrossExposurePct = equity > 0
    ? (projectedGrossExposure / equity) * 100
    : (projectedGrossExposure > 0 ? Infinity : 0);
  const projectedNetExposurePct = equity > 0
    ? (Math.abs(projectedNetExposure) / equity) * 100
    : (projectedNetExposure !== 0 ? Infinity : 0);
  const maxGrossExposurePct = toFiniteNumber(snapshot.limits?.maxGrossExposurePct, 100);
  const maxNetExposurePct = toFiniteNumber(snapshot.limits?.maxNetExposurePct, 100);
  const checks = [
    {
      name: 'projected_gross_exposure_limit',
      passed: riskReducingOnly || projectedGrossExposurePct <= maxGrossExposurePct,
      message: 'The proposed order would exceed the gross portfolio exposure limit.',
      severity: 'critical',
      metadata: {
        currentGrossExposurePct: snapshot.grossExposurePct,
        projectedGrossExposurePct: round(projectedGrossExposurePct),
        limit: maxGrossExposurePct,
        riskReducingOnly
      }
    },
    {
      name: 'projected_net_exposure_limit',
      passed: riskReducingOnly || projectedNetExposurePct <= maxNetExposurePct,
      message: 'The proposed order would exceed the absolute net portfolio exposure limit.',
      severity: 'critical',
      metadata: {
        currentNetExposurePct: snapshot.netExposurePct,
        projectedNetExposurePct: round(projectedNetExposurePct),
        limit: maxNetExposurePct,
        riskReducingOnly
      }
    }
  ];
  for (const currentCheck of (snapshot.checks || []).filter(check => [
    'working_order_exposure_verified',
    'daily_drawdown_limit',
    'total_drawdown_limit'
  ].includes(check.name))) {
    checks.push({
      ...currentCheck,
      passed: riskReducingOnly || currentCheck.passed,
      metadata: {
        ...(currentCheck.metadata || {}),
        riskReducingOnly
      }
    });
  }
  const failed = checks.filter(check => !check.passed);
  return {
    approved: failed.length === 0,
    checks,
    rejectionReasons: failed.map(check => check.message),
    metrics: {
      notional,
      projectedGrossExposure: round(projectedGrossExposure),
      projectedNetExposure: round(projectedNetExposure),
      projectedGrossExposurePct: round(projectedGrossExposurePct),
      projectedNetExposurePct: round(projectedNetExposurePct),
      riskReducingOnly
    }
  };
}

module.exports = {
  asRiskResult,
  buildWorkingOrderExposure,
  buildPortfolioRiskSnapshot,
  evaluateProjectedPortfolioRisk
};
