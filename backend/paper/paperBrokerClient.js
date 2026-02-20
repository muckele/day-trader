const PaperSettings = require('../models/PaperSettings');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const PaperEquity = require('../models/PaperEquity');
const PaperGuardrailEvent = require('../models/PaperGuardrailEvent');
const RegimeSnapshot = require('../models/RegimeSnapshot');
const { fetchQuotes } = require('../services/marketData');
const {
  applyTradeToPosition,
  buildPositions,
  calculateCash,
  calculateDailyPnl,
  calculatePositionMetrics
} = require('./paperMath');
const { evaluateGuardrails, updateCooldownState } = require('./guardrails');
const { detectRegime } = require('../signal/regimeDetector');
const { getStrategy } = require('../signal/strategies');
const { linkTradeToPlan } = require('../tradePlanEngine');

const ACCOUNT_ID = 'default';

async function getSettings() {
  const existing = await PaperSettings.findOne({ accountId: ACCOUNT_ID });
  if (existing) return existing;
  return PaperSettings.create({ accountId: ACCOUNT_ID });
}

async function updateSettings(updates) {
  const allowed = [
    'startingCash',
    'slippageBps',
    'commission',
    'maxPositionPct',
    'maxDailyLossPct',
    'cooldownHours'
  ];
  const filtered = {};
  allowed.forEach(key => {
    if (updates[key] !== undefined) {
      filtered[key] = Number(updates[key]);
    }
  });

  const settings = await getSettings();
  Object.assign(settings, filtered);
  await settings.save();
  return settings;
}

async function getTrades() {
  return PaperTrade.find({ accountId: ACCOUNT_ID }).sort({ filledAt: -1 }).lean();
}

async function getOrders() {
  return PaperOrder.find({ accountId: ACCOUNT_ID }).sort({ filledAt: -1 }).lean();
}

async function getPositions() {
  const trades = await PaperTrade.find({ accountId: ACCOUNT_ID }).sort({ filledAt: 1 }).lean();
  const { positions } = buildPositions(trades);
  const symbols = Object.keys(positions).filter(symbol => positions[symbol].qty !== 0);
  const quotes = symbols.length ? await fetchQuotes(symbols) : [];
  const quoteMap = {};
  quotes.forEach(quote => {
    quoteMap[quote.symbol] = quote;
  });

  return symbols.map(symbol => {
    const position = positions[symbol];
    const quote = quoteMap[symbol];
    const marketPrice = quote?.price || position.avgCost || 0;
    const metrics = calculatePositionMetrics(position, marketPrice);
    return {
      symbol,
      qty: position.qty,
      avgCost: Number(position.avgCost.toFixed(2)),
      marketPrice,
      ...metrics
    };
  });
}

async function getAccount() {
  const settings = await getSettings();
  const trades = await PaperTrade.find({ accountId: ACCOUNT_ID }).sort({ filledAt: 1 }).lean();
  const positions = await getPositions();
  const cash = calculateCash(trades, settings.startingCash);
  const positionsValue = positions.reduce((sum, pos) => sum + pos.marketValue, 0);
  const equity = cash + positionsValue;
  const dailyPnl = calculateDailyPnl(trades, new Date());
  const totalPnl = equity - settings.startingCash;

  return {
    cash,
    positionsValue,
    equity,
    dailyPnl,
    totalPnl,
    positions,
    settings
  };
}

async function getEquityCurve() {
  return PaperEquity.find({ accountId: ACCOUNT_ID }).sort({ timestamp: 1 }).lean();
}

async function getRegimeAtTrade(now) {
  const date = now.toISOString().slice(0, 10);
  let snapshot = await RegimeSnapshot.findOne({ date: { $lte: date } })
    .sort({ date: -1 })
    .lean();
  if (!snapshot) {
    const detected = await detectRegime();
    snapshot = await RegimeSnapshot.create({
      date,
      trendChop: detected.trendChop,
      vol: detected.vol,
      risk: detected.risk,
      notes: detected.notes
    });
  }
  return snapshot;
}

async function placeOrder({
  symbol,
  side,
  qty,
  orderType = 'market',
  limitPrice,
  strategyId,
  setupType,
  strategyTags,
  stopPrice
}) {
  const now = new Date();
  const settings = await getSettings();
  const normalizedSymbol = symbol.toUpperCase();
  const numericQty = Number(qty);

  if (!normalizedSymbol) {
    throw new Error('Symbol is required.');
  }
  if (!['buy', 'sell'].includes(side)) {
    throw new Error('side must be buy or sell.');
  }
  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    throw new Error('qty must be a positive number.');
  }

  const [quote] = await fetchQuotes([normalizedSymbol]);
  if (!quote || !quote.price) {
    throw new Error('Quote unavailable for symbol.');
  }

  const slippageFactor = (settings.slippageBps || 0) / 10000;
  let fillPrice = quote.price;
  fillPrice = side === 'buy'
    ? fillPrice * (1 + slippageFactor)
    : fillPrice * (1 - slippageFactor);
  fillPrice = Number(fillPrice.toFixed(2));

  if (orderType === 'limit' && typeof limitPrice === 'number') {
    if (side === 'buy' && fillPrice > limitPrice) {
      throw new Error('Limit price too low for fill.');
    }
    if (side === 'sell' && fillPrice < limitPrice) {
      throw new Error('Limit price too high for fill.');
    }
  }

  const account = await getAccount();
  const equityBase = account.equity > 0 ? account.equity : settings.startingCash;
  const orderNotional = fillPrice * numericQty;
  const guardrail = evaluateGuardrails({
    equity: equityBase,
    orderNotional,
    dailyPnl: account.dailyPnl,
    settings,
    now
  });

  if (!guardrail.ok) {
    await PaperGuardrailEvent.create({
      accountId: ACCOUNT_ID,
      symbol: normalizedSymbol,
      orderNotional,
      reason: guardrail.reason
    });
    throw new Error(guardrail.reason);
  }

  const trades = await PaperTrade.find({ accountId: ACCOUNT_ID }).sort({ filledAt: 1 }).lean();
  const { positions } = buildPositions(trades);
  const currentPosition = positions[normalizedSymbol] || { qty: 0, avgCost: 0 };
  const { realizedPnl } = applyTradeToPosition(currentPosition, {
    side,
    qty: numericQty,
    price: fillPrice
  });
  const isClosing = currentPosition.qty !== 0
    && currentPosition.qty * (side === 'buy' ? numericQty : -numericQty) < 0;
  const commission = settings.commission || 0;
  const tradeRealized = realizedPnl - commission;
  const stopValue = stopPrice !== undefined && stopPrice !== null
    ? Number(stopPrice)
    : null;
  const riskPerShare = stopValue ? Math.abs(fillPrice - stopValue) : null;
  const rMultiple = isClosing && riskPerShare
    ? tradeRealized / (riskPerShare * numericQty)
    : null;
  const strategy = strategyId ? getStrategy(strategyId) : null;
  const finalTags = Array.isArray(strategyTags) && strategyTags.length
    ? strategyTags
    : (strategy?.tags || []);
  const regimeAtTrade = await getRegimeAtTrade(now);

  const order = await PaperOrder.create({
    accountId: ACCOUNT_ID,
    symbol: normalizedSymbol,
    side,
    qty: numericQty,
    orderType,
    limitPrice: typeof limitPrice === 'number' ? limitPrice : null,
    strategyId: strategyId || null,
    setupType: setupType || null,
    strategyTags: finalTags,
    stopPrice: stopValue,
    status: 'filled',
    fillPrice,
    commission,
    slippageBps: settings.slippageBps || 0,
    notional: orderNotional,
    filledAt: now
  });

  const trade = await PaperTrade.create({
    accountId: ACCOUNT_ID,
    symbol: normalizedSymbol,
    side,
    qty: numericQty,
    price: fillPrice,
    strategyId: strategyId || null,
    setupType: setupType || null,
    strategyTags: finalTags,
    stopPrice: stopValue,
    riskPerShare: riskPerShare ? Number(riskPerShare.toFixed(4)) : null,
    rMultiple: rMultiple !== null ? Number(rMultiple.toFixed(2)) : null,
    regimeAtTrade: regimeAtTrade ? {
      date: regimeAtTrade.date,
      trendChop: regimeAtTrade.trendChop,
      vol: regimeAtTrade.vol,
      risk: regimeAtTrade.risk,
      notes: regimeAtTrade.notes || []
    } : null,
    commission,
    notional: orderNotional,
    realizedPnl: tradeRealized,
    orderId: order._id,
    filledAt: now
  });

  const tradePlanId = await linkTradeToPlan(trade, ACCOUNT_ID);
  if (tradePlanId) {
    trade.tradePlanId = tradePlanId;
  }

  const { consecutiveLosses, cooldownUntil } = updateCooldownState(
    settings,
    tradeRealized,
    now
  );
  settings.consecutiveLosses = consecutiveLosses;
  settings.cooldownUntil = cooldownUntil;
  await settings.save();

  const updatedAccount = await getAccount();
  await PaperEquity.create({
    accountId: ACCOUNT_ID,
    timestamp: now,
    equity: updatedAccount.equity,
    cash: updatedAccount.cash,
    positionsValue: updatedAccount.positionsValue,
    dailyPnl: updatedAccount.dailyPnl,
    totalPnl: updatedAccount.totalPnl
  });

  return { order, trade, account: updatedAccount, positions: updatedAccount.positions };
}

module.exports = {
  getSettings,
  updateSettings,
  getTrades,
  getOrders,
  getPositions,
  getAccount,
  getEquityCurve,
  placeOrder
};
