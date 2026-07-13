const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRoboRisk } = require('../robotrader/riskGate');

const baseSettings = {
  isEnabled: true,
  mode: 'paper',
  liveTradingExplicitlyEnabled: false,
  allowedAssetClasses: ['stocks'],
  allowedSymbols: [],
  blockedSymbols: [],
  maxTradeAmount: 1000,
  maxPositionSize: 5000,
  maxDailyLoss: 500,
  maxOpenPositions: 5,
  maxTradesPerDay: 3,
  allowShortSelling: false,
  allowFractionalShares: true,
  allowExtendedHours: false,
  allowOptionsTrading: false,
  allowCryptoTrading: false,
  riskLevel: 'balanced',
  requireManualApprovalAboveDollarAmount: 0
};

const baseDecision = {
  symbol: 'AAPL',
  assetClass: 'stocks',
  action: 'buy',
  confidenceScore: 76,
  rewardRiskRatio: 1.8
};

const baseOrder = {
  symbol: 'AAPL',
  assetClass: 'stocks',
  side: 'buy',
  orderType: 'market',
  orderClass: 'bracket',
  timeInForce: 'day',
  qty: 1,
  stopLoss: { stop_price: '190' },
  takeProfit: { limit_price: '205' },
  estimatedNotional: 250
};

test('robotrader risk gate approves a valid paper stock trade', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    environment: 'paper'
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('robotrader risk gate approves simple fractional stock entries with internal risk stop', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: {
      ...baseOrder,
      orderClass: 'simple',
      qty: 1.25,
      stopLoss: null,
      takeProfit: null,
      riskStopPrice: 190
    },
    environment: 'paper'
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('robotrader risk gate rejects fractionals when Alpaca asset is not fractionable', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: {
      ...baseOrder,
      orderClass: 'simple',
      qty: 1.25,
      stopLoss: null,
      takeProfit: null,
      riskStopPrice: 190
    },
    asset: { symbol: 'AAPL', status: 'active', tradable: true, fractionable: false },
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('AAPL is not marked fractionable by Alpaca.'));
});

test('robotrader risk gate rejects when Alpaca asset lookup fails', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    assetLookupError: 'Alpaca 404: asset not found',
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('Alpaca 404: asset not found'));
});

test('robotrader risk gate rejects when Alpaca asset is not tradable', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    asset: { symbol: 'AAPL', status: 'inactive', tradable: false, fractionable: true },
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('AAPL is not currently tradable on Alpaca.'));
});

test('robotrader risk gate rejects disabled and duplicate trades', () => {
  const result = evaluateRoboRisk({
    settings: { ...baseSettings, isEnabled: false },
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [{ symbol: 'AAPL', status: 'new' }],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('RoboTrader is disabled.'));
  assert.ok(result.rejectionReasons.includes('Trade duplicates an existing open order.'));
});

test('robotrader risk gate rejects live trading without explicit opt-in', () => {
  const result = evaluateRoboRisk({
    settings: { ...baseSettings, mode: 'live', liveTradingExplicitlyEnabled: false },
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    environment: 'live'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('The selected paper/shadow/live environment is not enabled by the user.'));
});

test('robotrader risk gate uses executable order fields over an understated estimate', () => {
  const result = evaluateRoboRisk({
    settings: {
      ...baseSettings,
      mode: 'live',
      liveTradingExplicitlyEnabled: true,
      maxTradeAmount: 5000
    },
    account: { buying_power: '50000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, confidenceScore: 80 },
    orderInput: {
      ...baseOrder,
      orderType: 'limit',
      qty: 100,
      limitPrice: 100,
      estimatedNotional: 100
    },
    environment: 'live',
    marketClock: { is_open: true }
  });

  assert.equal(result.approved, false);
  assert.equal(result.checks.find(check => check.name === 'trade_amount').metadata.estimatedNotional, 10000);
  assert.ok(result.rejectionReasons.includes('Trade amount exceeds user max trade amount.'));
});

test('robotrader risk gate rejects sell orders that would open shorts when disabled', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: { ...baseOrder, side: 'sell' },
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('Short selling is not enabled for this user.'));
});

test('robotrader risk gate rejects fractional short-opening stock orders', () => {
  const result = evaluateRoboRisk({
    settings: { ...baseSettings, allowShortSelling: true },
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: {
      ...baseOrder,
      side: 'sell',
      orderClass: 'simple',
      qty: 1.25,
      stopLoss: null,
      takeProfit: null,
      riskStopPrice: 210
    },
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('Alpaca does not support opening fractional short equity positions.'));
});

test('robotrader risk gate allows risk-reducing exits when exposure caps are already full', () => {
  const result = evaluateRoboRisk({
    settings: {
      ...baseSettings,
      maxTradeAmount: 100,
      maxPositionSize: 100,
      maxOpenPositions: 1
    },
    account: { buying_power: '50', status: 'ACTIVE' },
    positions: [{ symbol: 'AAPL', qty: 10, market_value: 2000 }],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: {
      ...baseOrder,
      side: 'sell',
      orderClass: 'simple',
      takeProfit: null,
      stopLoss: null,
      qty: 1,
      estimatedNotional: 200
    },
    environment: 'paper'
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('robotrader risk gate rejects overselling a long position when short selling is disabled', () => {
  const result = evaluateRoboRisk({
    settings: {
      ...baseSettings,
      maxTradeAmount: 5000
    },
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [{ symbol: 'AAPL', qty: 5, market_value: 1000 }],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: {
      ...baseOrder,
      side: 'sell',
      qty: 10,
      estimatedNotional: 2000,
      stopLoss: { stop_price: 220 },
      takeProfit: { limit_price: 180 }
    },
    environment: 'paper'
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('Short selling is not enabled for this user.'));
});

test('robotrader risk gate allows a full long exit without short selling enabled', () => {
  const result = evaluateRoboRisk({
    settings: {
      ...baseSettings,
      maxTradeAmount: 100,
      maxPositionSize: 100
    },
    account: { buying_power: '0', status: 'ACTIVE' },
    positions: [{ symbol: 'AAPL', qty: 5, market_value: 1000 }],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: {
      ...baseOrder,
      side: 'sell',
      orderClass: 'simple',
      takeProfit: null,
      stopLoss: null,
      qty: 5,
      estimatedNotional: 1000
    },
    environment: 'paper'
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('robotrader risk gate allows buy-to-cover exits even when buying power is low', () => {
  const result = evaluateRoboRisk({
    settings: {
      ...baseSettings,
      allowShortSelling: true,
      maxTradeAmount: 100,
      maxPositionSize: 100
    },
    account: { buying_power: '0', status: 'ACTIVE' },
    positions: [{ symbol: 'AAPL', qty: -5, market_value: 1000 }],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'cover' },
    orderInput: {
      ...baseOrder,
      side: 'buy',
      orderClass: 'simple',
      takeProfit: null,
      stopLoss: null,
      qty: 5,
      estimatedNotional: 1000
    },
    environment: 'paper'
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('robotrader risk gate rejects stock orders when the market is closed and order is not extended-hours valid', () => {
  const result = evaluateRoboRisk({
    settings: baseSettings,
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: baseOrder,
    environment: 'paper',
    marketClock: { is_open: false }
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes('Market is closed and this order is not marked as a valid extended-hours order.'));
});

test('robotrader risk gate blocks extended-hours entries that require broker stop protection', () => {
  const result = evaluateRoboRisk({
    settings: { ...baseSettings, allowExtendedHours: true },
    account: { buying_power: '5000', status: 'ACTIVE' },
    positions: [],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: baseDecision,
    orderInput: {
      ...baseOrder,
      orderType: 'limit',
      orderClass: 'simple',
      limitPrice: 201,
      takeProfit: null,
      stopLoss: null,
      extendedHours: true,
      riskStopPrice: 190,
      requiresRegularSessionForProtection: true
    },
    environment: 'paper',
    marketClock: { is_open: false }
  });

  assert.equal(result.approved, false);
  assert.ok(result.rejectionReasons.includes(
    'Extended-hours automated stock entries are blocked because broker-attached stop-loss/take-profit protection is unavailable outside regular market hours.'
  ));
});

test('robotrader risk gate allows extended-hours risk-reducing exits even with protection marker', () => {
  const result = evaluateRoboRisk({
    settings: { ...baseSettings, allowExtendedHours: true },
    account: { buying_power: '0', status: 'ACTIVE' },
    positions: [{ symbol: 'AAPL', qty: 5, market_value: 1000 }],
    openOrders: [],
    recentOrders: [],
    tradesToday: 0,
    dailyPnl: 0,
    decision: { ...baseDecision, action: 'sell' },
    orderInput: {
      ...baseOrder,
      side: 'sell',
      orderType: 'limit',
      orderClass: 'simple',
      limitPrice: 199,
      takeProfit: null,
      stopLoss: null,
      extendedHours: true,
      qty: 5,
      estimatedNotional: 1000,
      requiresRegularSessionForProtection: true
    },
    environment: 'paper',
    marketClock: { is_open: false }
  });

  assert.equal(result.approved, true);
  assert.equal(result.rejectionReasons.length, 0);
});
