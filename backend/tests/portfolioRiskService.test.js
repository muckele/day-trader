const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asRiskResult,
  buildPortfolioRiskSnapshot,
  evaluateProjectedPortfolioRisk
} = require('../services/portfolioRiskService');

const portfolioPolicy = {
  maxGrossExposurePct: 100,
  maxNetExposurePct: 75,
  maxDailyDrawdownPct: 2,
  maxTotalDrawdownPct: 5,
  pauseOnBreach: true
};

test('portfolio risk snapshot calculates long, short, gross, and net exposure', () => {
  const snapshot = buildPortfolioRiskSnapshot({
    userId: 'user-1',
    accountId: 'account-1',
    environment: 'shadow',
    account: { equity: 10000, last_equity: 10000, cash: 4000, buying_power: 8000 },
    positions: [
      { symbol: 'AAPL', qty: 10, market_value: 2000 },
      { symbol: 'TSLA', qty: -5, market_value: -1000 }
    ],
    portfolioPolicy,
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(snapshot.longExposure, 2000);
  assert.equal(snapshot.shortExposure, 1000);
  assert.equal(snapshot.grossExposure, 3000);
  assert.equal(snapshot.netExposure, 1000);
  assert.equal(snapshot.grossExposurePct, 30);
  assert.equal(snapshot.netExposurePct, 10);
  assert.equal(snapshot.breached, false);
  assert.equal(asRiskResult(snapshot).approved, true);
});

test('portfolio risk snapshot carries peak equity and vetoes exposure/drawdown breaches', () => {
  const snapshot = buildPortfolioRiskSnapshot({
    userId: 'user-1',
    accountId: 'account-1',
    environment: 'live',
    account: { equity: 9000, last_equity: 9300 },
    positions: [{ symbol: 'AAPL', qty: 100, market_value: 12000 }],
    portfolioPolicy,
    previousSnapshot: { peakEquity: 10000 },
    now: new Date('2026-07-13T14:00:00.000Z')
  });

  assert.equal(snapshot.peakEquity, 10000);
  assert.ok(snapshot.dailyDrawdownPct > 2);
  assert.equal(snapshot.totalDrawdownPct, 10);
  assert.equal(snapshot.breached, true);
  assert.ok(snapshot.breachReasonCodes.includes('GROSS_EXPOSURE_LIMIT'));
  assert.ok(snapshot.breachReasonCodes.includes('DAILY_DRAWDOWN_LIMIT'));
  assert.ok(snapshot.breachReasonCodes.includes('TOTAL_DRAWDOWN_LIMIT'));
  assert.equal(asRiskResult(snapshot).approved, false);
});

test('projected portfolio risk blocks an order that would cross the gross exposure cap', () => {
  const projected = evaluateProjectedPortfolioRisk({
    equity: 10000,
    grossExposure: 9500,
    netExposure: 9500,
    grossExposurePct: 95,
    netExposurePct: 95,
    positions: [{ symbol: 'MSFT', qty: 10, marketValue: 9500, side: 'long' }],
    limits: { maxGrossExposurePct: 100, maxNetExposurePct: 110 }
  }, {
    symbol: 'AAPL',
    side: 'buy',
    orderType: 'limit',
    qty: 10,
    limitPrice: 100,
    estimatedNotional: 1000
  });

  assert.equal(projected.metrics.projectedGrossExposurePct, 105);
  assert.equal(projected.approved, false);
  assert.equal(projected.checks.find(check => check.name === 'projected_gross_exposure_limit').passed, false);
});

test('portfolio risk reserves working-order exposure before evaluating a new order', () => {
  const snapshot = buildPortfolioRiskSnapshot({
    userId: 'user-1',
    accountId: 'account-1',
    environment: 'live',
    account: { equity: 10000, last_equity: 10000 },
    positions: [{ symbol: 'SPY', qty: 90, market_value: 9000 }],
    openOrders: [{
      id: 'working-msft',
      symbol: 'MSFT',
      side: 'buy',
      qty: 10,
      orderType: 'limit',
      limitPrice: 100
    }],
    portfolioPolicy
  });
  const projected = evaluateProjectedPortfolioRisk(snapshot, {
    symbol: 'AAPL',
    side: 'buy',
    orderType: 'limit',
    qty: 10,
    limitPrice: 100
  });

  assert.equal(snapshot.reservedGrossExposure, 1000);
  assert.equal(snapshot.grossExposure, 10000);
  assert.equal(snapshot.workingOrderCount, 1);
  assert.equal(projected.metrics.projectedGrossExposurePct, 110);
  assert.equal(projected.approved, false);
});

test('portfolio risk fails closed for an unpriced risk-increasing working order', () => {
  const snapshot = buildPortfolioRiskSnapshot({
    userId: 'user-1',
    accountId: 'account-1',
    environment: 'live',
    account: { equity: 10000, last_equity: 10000 },
    positions: [],
    openOrders: [{ id: 'working-market', symbol: 'AAPL', side: 'buy', qty: 10, orderType: 'market' }],
    portfolioPolicy
  });

  assert.equal(snapshot.unpricedWorkingOrderCount, 1);
  assert.equal(snapshot.breached, true);
  assert.equal(
    snapshot.checks.find(check => check.name === 'working_order_exposure_verified').passed,
    false
  );
  const projected = evaluateProjectedPortfolioRisk(snapshot, {
    symbol: 'MSFT',
    side: 'buy',
    orderType: 'limit',
    qty: 1,
    limitPrice: 100
  });
  assert.equal(projected.approved, false);
  assert.equal(
    projected.checks.find(check => check.name === 'working_order_exposure_verified').passed,
    false
  );
});

test('aggregate working closes reserve only the quantity that can cross into a new position', () => {
  const snapshot = buildPortfolioRiskSnapshot({
    userId: 'user-1',
    accountId: 'account-1',
    environment: 'live',
    account: { equity: 10000, last_equity: 10000 },
    positions: [{ symbol: 'AAPL', qty: 10, market_value: 1000 }],
    openOrders: [
      { id: 'sell-1', symbol: 'AAPL', side: 'sell', qty: 10, orderType: 'limit', limitPrice: 100 },
      { id: 'sell-2', symbol: 'AAPL', side: 'sell', qty: 10, orderType: 'limit', limitPrice: 100 }
    ],
    portfolioPolicy
  });

  assert.equal(snapshot.reservedShortExposure, 1000);
  assert.equal(snapshot.workingOrderGroups[0].closingCapacity, 10);
  assert.equal(snapshot.workingOrderGroups[0].riskIncreasingQty, 10);
});

test('projected portfolio risk allows a bounded risk-reducing exit', () => {
  const projected = evaluateProjectedPortfolioRisk({
    equity: 10000,
    grossExposure: 11000,
    netExposure: 11000,
    grossExposurePct: 110,
    netExposurePct: 110,
    positions: [{ symbol: 'AAPL', qty: 100, marketValue: 11000, side: 'long' }],
    limits: { maxGrossExposurePct: 100, maxNetExposurePct: 100 }
  }, {
    symbol: 'AAPL',
    side: 'sell',
    orderType: 'limit',
    qty: 10,
    limitPrice: 100,
    estimatedNotional: 1000
  });

  assert.equal(projected.metrics.riskReducingOnly, true);
  assert.equal(projected.approved, true);
});
