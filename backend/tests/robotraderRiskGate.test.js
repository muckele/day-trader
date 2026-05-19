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
  assert.ok(result.rejectionReasons.includes('Live trading is not explicitly enabled by the user.'));
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
