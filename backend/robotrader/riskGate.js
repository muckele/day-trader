const { validateAlpacaOrderRequest } = require('./alpacaCapabilities');
const { normalizeAssetClass, normalizeSymbol } = require('./settingsService');

const CONFIDENCE_MINIMUMS = Object.freeze({
  conservative: 72,
  balanced: 65,
  aggressive: 58
});

const REWARD_RISK_MINIMUMS = Object.freeze({
  conservative: 1.8,
  balanced: 1.5,
  aggressive: 1.25
});

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function addCheck(checks, name, passed, message, severity = 'warning', metadata = {}) {
  checks.push({ name, passed: Boolean(passed), message: message || null, severity, metadata });
}

function getAccountBuyingPower(account = {}) {
  return toFiniteNumber(account.buying_power ?? account.buyingPower ?? account.cash, 0);
}

function isAccountRestricted(account = {}) {
  return Boolean(
    account.trading_blocked ||
    account.account_blocked ||
    account.transfers_blocked ||
    ['INACTIVE', 'ACCOUNT_CLOSED'].includes(String(account.status || '').toUpperCase())
  );
}

function countOpenPositions(positions = []) {
  return (positions || []).filter(position => Math.abs(toFiniteNumber(position.qty, 0)) > 0).length;
}

function getPositionValue(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  if (!position) return 0;
  return Math.abs(toFiniteNumber(position.market_value ?? position.marketValue, 0));
}

function getPositionQty(symbol, positions = []) {
  const normalized = normalizeSymbol(symbol);
  const position = (positions || []).find(item => normalizeSymbol(item.symbol) === normalized);
  if (!position) return 0;
  return toFiniteNumber(position.qty, 0);
}

function isReducingPosition(side, currentPositionQty) {
  return (side === 'sell' && currentPositionQty > 0) || (side === 'buy' && currentPositionQty < 0);
}

function getProjectedPositionValue({ currentValue, currentQty, side, estimatedNotional }) {
  const safeCurrentValue = Math.max(0, toFiniteNumber(currentValue, 0));
  const safeEstimatedNotional = Math.max(0, toFiniteNumber(estimatedNotional, 0));
  if (isReducingPosition(side, currentQty)) {
    return Math.max(0, safeCurrentValue - safeEstimatedNotional);
  }
  return safeCurrentValue + safeEstimatedNotional;
}

function hasDuplicateOpenOrder(symbol, openOrders = []) {
  const normalized = normalizeSymbol(symbol);
  return (openOrders || []).some(order => {
    const status = String(order.status || '').toLowerCase();
    return normalizeSymbol(order.symbol) === normalized
      && !['filled', 'canceled', 'cancelled', 'expired', 'rejected'].includes(status);
  });
}

function tradedTooRecently(symbol, recentOrders = [], now = new Date(), cooldownMinutes = 30) {
  const normalized = normalizeSymbol(symbol);
  const cutoff = now.getTime() - cooldownMinutes * 60 * 1000;
  return (recentOrders || []).some(order => {
    if (normalizeSymbol(order.symbol) !== normalized) return false;
    const when = new Date(order.submittedAt || order.createdAt || order.updatedAt || 0).getTime();
    return Number.isFinite(when) && when >= cutoff;
  });
}

function evaluateRoboRisk({
  settings = {},
  account = {},
  positions = [],
  openOrders = [],
  recentOrders = [],
  tradesToday = 0,
  dailyPnl = 0,
  decision = {},
  orderInput = {},
  environment = 'paper',
  now = new Date()
} = {}) {
  const checks = [];
  const rejectionReasons = [];
  const symbol = normalizeSymbol(orderInput.symbol || decision.symbol);
  const assetClass = normalizeAssetClass(orderInput.assetClass || decision.assetClass) || 'stocks';
  const side = String(orderInput.side || '').toLowerCase();
  const confidenceMinimum = CONFIDENCE_MINIMUMS[settings.riskLevel] || CONFIDENCE_MINIMUMS.balanced;
  const rewardRiskMinimum = REWARD_RISK_MINIMUMS[settings.riskLevel] || REWARD_RISK_MINIMUMS.balanced;
  const notional = toFiniteNumber(orderInput.notional, 0);
  const qty = toFiniteNumber(orderInput.qty, 0);
  const estimatedNotional = notional || toFiniteNumber(orderInput.estimatedNotional, 0);
  const currentPositionQty = getPositionQty(symbol, positions);
  const currentPositionValue = getPositionValue(symbol, positions);
  const reducingPosition = isReducingPosition(side, currentPositionQty);
  const projectedPositionValue = getProjectedPositionValue({
    currentValue: currentPositionValue,
    currentQty: currentPositionQty,
    side,
    estimatedNotional
  });

  const runCheck = (name, passed, message, severity = 'warning', metadata = {}) => {
    addCheck(checks, name, passed, message, severity, metadata);
    if (!passed) rejectionReasons.push(message);
  };

  runCheck('robotrader_enabled', Boolean(settings.isEnabled || settings.enabled), 'RoboTrader is disabled.');
  runCheck('mode_allowed', environment === 'paper' || (settings.mode === 'live' && settings.liveTradingExplicitlyEnabled), 'Live trading is not explicitly enabled by the user.');
  runCheck('mode_match', environment === 'paper' || settings.mode === environment, 'User is in paper/live mode mismatch.');
  runCheck('account_allowed', !isAccountRestricted(account), 'Alpaca account is restricted.');
  runCheck('symbol_present', Boolean(symbol), 'Symbol is required.');
  runCheck('symbol_not_blocked', !(settings.blockedSymbols || []).includes(symbol), `${symbol} is blocked by user settings.`);
  runCheck(
    'symbol_allowed',
    !(settings.allowedSymbols || []).length || settings.allowedSymbols.includes(symbol),
    `${symbol} is not in the allowed symbols list.`
  );
  runCheck(
    'asset_class_allowed',
    (settings.allowedAssetClasses || ['stocks']).includes(assetClass),
    `${assetClass} is not enabled in allowed asset classes.`
  );
  runCheck(
    'crypto_enabled',
    assetClass !== 'crypto' || settings.allowCryptoTrading === true,
    'Crypto trading is not explicitly enabled for this user.'
  );
  runCheck(
    'options_enabled',
    assetClass !== 'options' || settings.allowOptionsTrading === true,
    'Options trading is not explicitly enabled for this user.'
  );
  runCheck(
    'short_allowed',
    !(side === 'sell' && currentPositionQty <= 0) || settings.allowShortSelling === true,
    'Short selling is not enabled for this user.'
  );

  const capability = validateAlpacaOrderRequest(orderInput);
  runCheck('order_capability', capability.ok, capability.errors.join(' ') || 'Order capability allowed.');
  runCheck('daily_loss_limit', Math.abs(Math.min(0, toFiniteNumber(dailyPnl, 0))) < toFiniteNumber(settings.maxDailyLoss, 0), 'Max daily loss is exceeded.');
  runCheck('trades_per_day', toFiniteNumber(tradesToday, 0) < toFiniteNumber(settings.maxTradesPerDay, 0), 'Max trades per day is exceeded.');
  runCheck(
    'open_positions',
    reducingPosition || currentPositionQty !== 0 || countOpenPositions(positions) < toFiniteNumber(settings.maxOpenPositions, 0),
    'Max open positions is exceeded.'
  );
  runCheck(
    'trade_amount',
    reducingPosition || estimatedNotional <= toFiniteNumber(settings.maxTradeAmount, 0),
    'Trade amount exceeds user max trade amount.',
    'warning',
    { estimatedNotional, maxTradeAmount: settings.maxTradeAmount }
  );
  runCheck(
    'position_size',
    reducingPosition || projectedPositionValue <= toFiniteNumber(settings.maxPositionSize, 0),
    'Position size would exceed user limit.',
    'warning',
    { projectedPositionValue, maxPositionSize: settings.maxPositionSize }
  );
  runCheck('buying_power', side !== 'buy' || estimatedNotional <= getAccountBuyingPower(account), 'Buying power is insufficient.');
  runCheck('duplicate_order', !hasDuplicateOpenOrder(symbol, openOrders), 'Trade duplicates an existing open order.');
  runCheck('symbol_cooldown', !tradedTooRecently(symbol, recentOrders, now), 'The same symbol was traded too recently.');
  runCheck(
    'confidence',
    toFiniteNumber(decision.confidenceScore, 0) >= confidenceMinimum,
    'Confidence score is below threshold.',
    'warning',
    { confidenceScore: decision.confidenceScore, minimum: confidenceMinimum }
  );
  runCheck(
    'reward_risk',
    toFiniteNumber(decision.rewardRiskRatio, 0) >= rewardRiskMinimum,
    'Reward/risk ratio is below threshold.',
    'warning',
    { rewardRiskRatio: decision.rewardRiskRatio, minimum: rewardRiskMinimum }
  );
  runCheck(
    'stop_loss_required',
    reducingPosition || Boolean(orderInput.stopLoss || orderInput.stop_loss || orderInput.stopPrice || orderInput.stop_price || assetClass !== 'stocks'),
    'Required stop loss is missing.'
  );
  runCheck(
    'fractional_allowed',
    settings.allowFractionalShares === true || !qty || Number.isInteger(qty),
    'Fractional share order is not allowed by user settings.'
  );

  if (settings.requireManualApprovalAboveDollarAmount > 0 && estimatedNotional > settings.requireManualApprovalAboveDollarAmount) {
    runCheck('manual_approval', false, 'Trade requires manual approval above configured dollar amount.', 'critical');
  } else {
    addCheck(checks, 'manual_approval', true, 'Manual approval threshold not triggered.', 'info');
  }

  return {
    approved: rejectionReasons.length === 0,
    checks,
    rejectionReasons
  };
}

module.exports = {
  CONFIDENCE_MINIMUMS,
  REWARD_RISK_MINIMUMS,
  evaluateRoboRisk,
  getProjectedPositionValue,
  isReducingPosition
};
