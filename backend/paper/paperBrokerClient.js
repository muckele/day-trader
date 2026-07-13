const PaperSettings = require('../models/PaperSettings');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const PaperEquity = require('../models/PaperEquity');
const PaperGuardrailEvent = require('../models/PaperGuardrailEvent');
const PaperAccountLock = require('../models/PaperAccountLock');
const RegimeSnapshot = require('../models/RegimeSnapshot');
const { fetchQuotes } = require('../services/marketData');
const { getMarketStatus } = require('../utils/marketStatus');
const {
  applyTradeToPosition,
  buildPositions,
  calculateCash,
  calculateDailyPnl,
  calculatePositionMetrics
} = require('./paperMath');
const { evaluateGuardrails, updateCooldownState } = require('./guardrails');
const { evaluateUnifiedRisk } = require('./riskEngine');
const {
  inferAssetClass,
  normalizeCompactSymbol,
  getShortBorrowProfile
} = require('./marketMeta');
const { detectRegime } = require('../signal/regimeDetector');
const { getStrategy } = require('../signal/strategies');
const { linkTradeToPlan } = require('../tradePlanEngine');
const {
  recordFilledExecution,
  recordRejectedExecution
} = require('../services/executionTelemetryService');
const {
  buildClientOrderId,
  readAlpacaPaperOrder,
  shouldSyncPaperTradesToAlpaca,
  submitAlpacaPaperOrder
} = require('../services/alpacaTradingClient');

const ACCOUNT_ID = 'default';
const MAX_EQUITY_QTY_DECIMALS = 6;
const MAX_CRYPTO_QTY_DECIMALS = 8;
const activeOpenOrderReconciliations = new Map();
const PAPER_ORDER_LOCK_MS = 10 * 60 * 1000;

function normalizePaperAccountId(accountId = ACCOUNT_ID) {
  const normalized = String(accountId || '').trim();
  return normalized || ACCOUNT_ID;
}

function getDecimalPlaces(value) {
  const text = String(value);
  if (!text.includes('.')) return 0;
  return text.split('.')[1].length;
}

function hasPositiveOrderPrice(value) {
  const numeric = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numeric) && numeric > 0;
}

function shouldSubmitAlpacaAttachedExits({
  assetClass,
  qty,
  takeProfitPrice,
  stopLossPrice
} = {}) {
  const hasAttachedExit = hasPositiveOrderPrice(takeProfitPrice) || hasPositiveOrderPrice(stopLossPrice);
  if (!hasAttachedExit) return true;
  if (assetClass !== 'equity') return true;
  return Number.isInteger(Number(qty));
}

function normalizeOrderInput({
  symbol,
  side,
  qty,
  assetClass,
  orderType = 'market',
  limitPrice,
  timeInForce = 'day',
  goodTilDate,
  takeProfitPrice,
  stopLossPrice,
  trailingStopPct,
  stopPrice,
  maxPricePerShare,
  allowExtendedHours = false
}) {
  const rawSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedSymbol = normalizeCompactSymbol(rawSymbol);
  if (!normalizedSymbol) {
    throw new Error('Symbol is required.');
  }
  const normalizedAssetClass = inferAssetClass({
    symbol: rawSymbol || normalizedSymbol,
    assetClass
  });

  const normalizedSide = side === 'sell' ? 'sell' : side === 'buy' ? 'buy' : null;
  if (!normalizedSide) {
    throw new Error('side must be buy or sell.');
  }

  const numericQty = Number(qty);
  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    throw new Error('qty must be a positive number.');
  }
  const maxQtyDecimals = normalizedAssetClass === 'crypto'
    ? MAX_CRYPTO_QTY_DECIMALS
    : MAX_EQUITY_QTY_DECIMALS;
  if (getDecimalPlaces(numericQty) > maxQtyDecimals) {
    throw new Error(`qty supports up to ${maxQtyDecimals} decimal places.`);
  }

  const normalizedOrderType = String(orderType || 'market').toLowerCase();
  if (!['market', 'limit', 'stop_limit', 'trailing_stop'].includes(normalizedOrderType)) {
    throw new Error('orderType must be market, limit, stop_limit, or trailing_stop.');
  }

  const parsedLimitPrice = limitPrice !== undefined && limitPrice !== null && limitPrice !== ''
    ? Number(limitPrice)
    : null;
  if (normalizedOrderType === 'limit' || normalizedOrderType === 'stop_limit') {
    if (!Number.isFinite(parsedLimitPrice) || parsedLimitPrice <= 0) {
      throw new Error('limitPrice must be a positive number for limit orders.');
    }
  }

  const parsedStopTriggerPrice = stopPrice !== undefined && stopPrice !== null && stopPrice !== ''
    ? Number(stopPrice)
    : null;
  if (normalizedOrderType === 'stop_limit') {
    if (!Number.isFinite(parsedStopTriggerPrice) || parsedStopTriggerPrice <= 0) {
      throw new Error('stopPrice must be a positive number for stop-limit orders.');
    }
  }

  let normalizedTimeInForce = String(timeInForce || 'day').toLowerCase();
  if (!['day', 'gtc', 'gtd', 'ioc'].includes(normalizedTimeInForce)) {
    throw new Error('timeInForce must be day, gtc, gtd, or ioc.');
  }
  if (normalizedAssetClass === 'crypto') {
    if (normalizedTimeInForce === 'day') {
      normalizedTimeInForce = 'gtc';
    }
    if (!['gtc', 'ioc'].includes(normalizedTimeInForce)) {
      throw new Error('Crypto timeInForce must be gtc or ioc.');
    }
  }
  const parsedGoodTilDate = goodTilDate ? new Date(goodTilDate) : null;
  if (normalizedTimeInForce === 'gtd') {
    if (!parsedGoodTilDate || Number.isNaN(parsedGoodTilDate.getTime())) {
      throw new Error('goodTilDate is required for GTD orders.');
    }
    if (parsedGoodTilDate <= new Date()) {
      throw new Error('goodTilDate must be in the future.');
    }
  }

  const parsedTakeProfitPrice = takeProfitPrice !== undefined && takeProfitPrice !== null && takeProfitPrice !== ''
    ? Number(takeProfitPrice)
    : null;
  if (parsedTakeProfitPrice !== null && (!Number.isFinite(parsedTakeProfitPrice) || parsedTakeProfitPrice <= 0)) {
    throw new Error('takeProfitPrice must be a positive number.');
  }

  const parsedStopLossPrice = stopLossPrice !== undefined && stopLossPrice !== null && stopLossPrice !== ''
    ? Number(stopLossPrice)
    : null;
  if (parsedStopLossPrice !== null && (!Number.isFinite(parsedStopLossPrice) || parsedStopLossPrice <= 0)) {
    throw new Error('stopLossPrice must be a positive number.');
  }

  const parsedTrailingStopPct = trailingStopPct !== undefined && trailingStopPct !== null && trailingStopPct !== ''
    ? Number(trailingStopPct)
    : null;
  if (normalizedOrderType === 'trailing_stop' && (!Number.isFinite(parsedTrailingStopPct) || parsedTrailingStopPct <= 0)) {
    throw new Error('trailingStopPct must be a positive number for trailing stop orders.');
  }
  if (parsedTrailingStopPct !== null && (!Number.isFinite(parsedTrailingStopPct) || parsedTrailingStopPct <= 0)) {
    throw new Error('trailingStopPct must be a positive number.');
  }

  const parsedMaxPricePerShare = maxPricePerShare !== undefined && maxPricePerShare !== null && maxPricePerShare !== ''
    ? Number(maxPricePerShare)
    : null;
  if (parsedMaxPricePerShare !== null) {
    if (!Number.isFinite(parsedMaxPricePerShare) || parsedMaxPricePerShare <= 0) {
      throw new Error('maxPricePerShare must be a positive number.');
    }
    if (normalizedSide !== 'buy') {
      throw new Error('maxPricePerShare is only supported for buy orders.');
    }
  }

  return {
    normalizedSymbol,
    rawSymbol,
    normalizedAssetClass,
    normalizedSide,
    numericQty,
    normalizedOrderType,
    normalizedTimeInForce,
    parsedGoodTilDate,
    parsedLimitPrice,
    parsedTakeProfitPrice,
    parsedStopLossPrice,
    parsedTrailingStopPct,
    parsedStopTriggerPrice,
    parsedMaxPricePerShare,
    allowExtendedHours: allowExtendedHours === true
  };
}

function enforceMarketHours({
  allowExtendedHours,
  assetClass = 'equity',
  now = new Date(),
  marketStatusProvider = getMarketStatus
}) {
  if (assetClass === 'crypto') {
    return {
      marketStatus: 'OPEN',
      extendedHours: false,
      marketSession: 'crypto'
    };
  }

  const market = marketStatusProvider(now);
  const marketOpen = market.status === 'OPEN';
  if (!marketOpen && !allowExtendedHours) {
    throw new Error('Market is closed. Enable extended-hours trading to place this order.');
  }

  return {
    marketStatus: market.status,
    extendedHours: !marketOpen,
    marketSession: marketOpen ? 'regular' : 'extended'
  };
}

function enforcePriceControls({
  side,
  fillPrice,
  orderType,
  limitPrice,
  stopTriggerPrice,
  maxPricePerShare
}) {
  if (orderType === 'limit' && Number.isFinite(limitPrice)) {
    if (side === 'buy' && fillPrice > limitPrice) {
      throw new Error('Limit price too low for fill.');
    }
    if (side === 'sell' && fillPrice < limitPrice) {
      throw new Error('Limit price too high for fill.');
    }
  }

  if (orderType === 'stop_limit' && Number.isFinite(stopTriggerPrice)) {
    if (side === 'buy' && fillPrice < stopTriggerPrice) {
      throw new Error('Stop trigger not reached for stop-limit buy order.');
    }
    if (side === 'sell' && fillPrice > stopTriggerPrice) {
      throw new Error('Stop trigger not reached for stop-limit sell order.');
    }
    if (side === 'buy' && fillPrice > limitPrice) {
      throw new Error('Limit price too low for stop-limit buy order.');
    }
    if (side === 'sell' && fillPrice < limitPrice) {
      throw new Error('Limit price too high for stop-limit sell order.');
    }
  }

  if (side === 'buy' && Number.isFinite(maxPricePerShare) && fillPrice > maxPricePerShare) {
    throw new Error(`Estimated fill $${fillPrice.toFixed(2)} exceeds max price per share $${maxPricePerShare.toFixed(2)}.`);
  }
}

function mapAlpacaPaperOrderStatus(order = {}) {
  const status = String(order.status || '').toLowerCase();
  if (status === 'filled') return 'filled';
  if (['canceled', 'cancelled', 'expired'].includes(status)) return 'cancelled';
  if (status === 'rejected') return 'rejected';
  return 'open';
}

function isTerminalAlpacaStatus(status) {
  return ['filled', 'canceled', 'cancelled', 'expired', 'rejected'].includes(String(status || '').toLowerCase());
}

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.name === 'MongoServerError' && err?.code === 11000;
}

function getAlpacaPaperRejectionReason(order = {}) {
  return order.reject_reason
    || order.rejected_reason
    || order.reason
    || order.message
    || 'Alpaca rejected the paper order.';
}

function getAlpacaFilledQty(order = {}, fallback = 0) {
  const filledQty = Number(order.filled_qty ?? order.filledQty);
  return Number.isFinite(filledQty) && filledQty > 0 ? filledQty : fallback;
}

function getAlpacaFillPrice(order = {}, fallback = null) {
  const filledAvgPrice = Number(order.filled_avg_price ?? order.filledAvgPrice);
  return Number.isFinite(filledAvgPrice) && filledAvgPrice > 0 ? filledAvgPrice : fallback;
}

async function getSettings({ accountId = ACCOUNT_ID } = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  const existing = await PaperSettings.findOne({ accountId: scopedAccountId });
  if (existing) return existing;
  return PaperSettings.create({ accountId: scopedAccountId });
}

async function updateSettings(updates, { accountId = ACCOUNT_ID } = {}) {
  const allowed = [
    'startingCash',
    'slippageBps',
    'commission',
    'maxPositionPct',
    'maxDailyLossPct',
    'maxSymbolExposurePct',
    'maxSectorExposurePct',
    'maxCorrelationClusterPct',
    'maxVarPct',
    'varVolatilityPct',
    'cryptoMaxPositionPct',
    'cryptoMaxDailyLossPct',
    'cryptoMinNotional',
    'cryptoLotSize',
    'cryptoVarVolPct',
    'shortMaintenanceMarginPct',
    'shortMaxBorrowFeeApr',
    'shortForceBuyInDays',
    'cooldownHours'
  ];
  const filtered = {};
  allowed.forEach(key => {
    if (updates[key] !== undefined) {
      filtered[key] = Number(updates[key]);
    }
  });

  const settings = await getSettings({ accountId });
  Object.assign(settings, filtered);
  await settings.save();
  return settings;
}

async function createFilledTradeFromSyncedOrder(order, brokerOrder = {}, {
  now = new Date()
} = {}) {
  const accountId = normalizePaperAccountId(order.accountId);
  const filledQty = getAlpacaFilledQty(brokerOrder, order.qty);
  const fillPrice = getAlpacaFillPrice(brokerOrder, order.fillPrice || order.estimatedPrice);
  if (!Number.isFinite(filledQty) || filledQty <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }

  const filledAt = brokerOrder.filled_at ? new Date(brokerOrder.filled_at) : now;
  const brokerOrderStatus = brokerOrder.status || order.brokerOrderStatus || null;
  const existingTrade = await PaperTrade.findOne({ accountId, orderId: order._id });
  if (existingTrade) {
    const sameQty = Math.abs(Number(existingTrade.qty || 0) - filledQty) < 1e-9;
    const samePrice = Math.abs(Number(existingTrade.price || 0) - fillPrice) < 1e-9;
    const sameStatus = String(existingTrade.brokerOrderStatus || '') === String(brokerOrderStatus || '');
    if (sameQty && samePrice && sameStatus) return existingTrade;
  }

  const settings = await getSettings({ accountId });
  const tradeQuery = {
    accountId,
    filledAt: { $lte: filledAt }
  };
  if (existingTrade?._id) {
    tradeQuery._id = { $ne: existingTrade._id };
  }
  const trades = await PaperTrade.find(tradeQuery).sort({ filledAt: 1 }).lean();
  const { positions } = buildPositions(trades);
  const currentPosition = positions[order.symbol] || { qty: 0, avgCost: 0 };
  const shortOpenQty = calculateShortOpenQty(currentPosition.qty, order.side, filledQty);
  const borrowProfile = shortOpenQty > 0 && order.assetClass !== 'crypto'
    ? getShortBorrowProfile(order.symbol)
    : null;
  const borrowFeeAccrued = shortOpenQty > 0 && borrowProfile
    ? Number(((shortOpenQty * fillPrice) * (borrowProfile.feeApr / 100) / 365).toFixed(4))
    : 0;
  const { realizedPnl } = applyTradeToPosition(currentPosition, {
    side: order.side,
    qty: filledQty,
    price: fillPrice
  });
  const commission = Number(order.commission || settings.commission || 0);
  const tradeRealized = realizedPnl - commission - borrowFeeAccrued;
  const stopValue = Number.isFinite(Number(order.stopLossPrice))
    ? Number(order.stopLossPrice)
    : (Number.isFinite(Number(order.stopPrice)) ? Number(order.stopPrice) : null);
  const riskPerShare = stopValue ? Math.abs(fillPrice - stopValue) : null;
  const isClosing = currentPosition.qty !== 0
    && currentPosition.qty * (order.side === 'buy' ? filledQty : -filledQty) < 0;
  const rMultiple = isClosing && riskPerShare
    ? tradeRealized / (riskPerShare * filledQty)
    : null;
  const regimeAtTrade = await getRegimeAtTrade(filledAt);
  const notional = Number((filledQty * fillPrice).toFixed(2));

  const tradePayload = {
    accountId,
    broker: 'alpaca',
    externalOrderId: brokerOrder.id || order.externalOrderId || null,
    clientOrderId: brokerOrder.client_order_id || order.clientOrderId || null,
    brokerOrderStatus,
    symbol: order.symbol,
    assetClass: order.assetClass,
    side: order.side,
    qty: filledQty,
    price: fillPrice,
    extendedHours: Boolean(order.extendedHours),
    marketSession: order.marketSession,
    strategyId: order.strategyId || null,
    setupType: order.setupType || null,
    strategyTags: order.strategyTags || [],
    metadata: order.metadata || {},
    researchSnapshot: order.researchSnapshot || order.metadata?.researchSnapshot || null,
    estimatedPrice: order.estimatedPrice,
    effectiveSlippageBps: Number.isFinite(Number(order.estimatedPrice)) && Number(order.estimatedPrice) > 0
      ? Number((((order.side === 'buy'
        ? (fillPrice - Number(order.estimatedPrice))
        : (Number(order.estimatedPrice) - fillPrice)) / Number(order.estimatedPrice)) * 10000).toFixed(2))
      : order.effectiveSlippageBps,
    fillLatencyMs: order.fillLatencyMs,
    shortBorrowFeeApr: borrowProfile?.feeApr || order.shortBorrowFeeApr || null,
    borrowFeeAccrued,
    forcedBuyIn: false,
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
    notional,
    realizedPnl: tradeRealized,
    orderId: order._id,
    filledAt
  };

  let trade = existingTrade;
  let createdTrade = false;
  if (trade) {
    Object.assign(trade, tradePayload);
    await trade.save();
  } else {
    try {
      trade = await PaperTrade.create(tradePayload);
      createdTrade = true;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return PaperTrade.findOne({ accountId, orderId: order._id });
      }
      throw err;
    }
  }

  const hasAttachedOrders = await PaperOrder.exists({ accountId, parentOrderId: order._id });
  if (!hasAttachedOrders) {
    await createAttachedExitOrders({
      parentOrder: order,
      accountId,
      now: filledAt,
      side: order.side,
      qty: filledQty,
      assetClass: order.assetClass,
      strategyId: order.strategyId || null,
      setupType: order.setupType || null,
      strategyTags: order.strategyTags || [],
      metadata: order.metadata || {},
      researchSnapshot: order.researchSnapshot || order.metadata?.researchSnapshot || null,
      allowExtendedHours: order.allowExtendedHours,
      marketSession: order.marketSession,
      extendedHours: order.extendedHours,
      timeInForce: order.timeInForce,
      goodTilDate: order.goodTilDate || null,
      takeProfitPrice: Number.isFinite(Number(order.takeProfitPrice)) ? Number(order.takeProfitPrice) : null,
      stopLossPrice: Number.isFinite(Number(order.stopLossPrice)) ? Number(order.stopLossPrice) : null,
      trailingStopPct: Number.isFinite(Number(order.trailingStopPct)) ? Number(order.trailingStopPct) : null
    });
  } else {
    await PaperOrder.updateMany(
      { accountId, parentOrderId: order._id, status: 'open' },
      { $set: { qty: filledQty } }
    );
  }

  const tradePlanId = trade.tradePlanId ? null : await linkTradeToPlan(trade, accountId);
  if (tradePlanId) {
    trade.tradePlanId = tradePlanId;
    await trade.save();
  }

  if (createdTrade) {
    const { consecutiveLosses, cooldownUntil } = updateCooldownState(
      settings,
      tradeRealized,
      filledAt
    );
    settings.consecutiveLosses = consecutiveLosses;
    settings.cooldownUntil = cooldownUntil;
    await settings.save();
  }

  const updatedAccount = await getAccount({ reconcile: false, accountId });
  await PaperEquity.create({
    accountId,
    timestamp: filledAt,
    equity: updatedAccount.equity,
    cash: updatedAccount.cash,
    positionsValue: updatedAccount.positionsValue,
    dailyPnl: updatedAccount.dailyPnl,
    totalPnl: updatedAccount.totalPnl
  });

  if (createdTrade) {
    await recordFilledExecution({
      broker: 'alpaca',
      origin: order.origin || order.setupType || 'manual',
      request: {
        accountId,
        origin: order.origin || 'manual',
        broker: 'paper',
        symbol: order.symbol,
        assetClass: order.assetClass,
        side: order.side,
        qty: filledQty,
        orderType: order.orderType,
        timeInForce: order.timeInForce,
        limitPrice: order.limitPrice,
        stopPrice: order.stopPrice,
        takeProfitPrice: order.takeProfitPrice,
        stopLossPrice: order.stopLossPrice,
        trailingStopPct: order.trailingStopPct,
        maxPricePerShare: order.maxPricePerShare,
        allowExtendedHours: order.allowExtendedHours,
        strategyId: order.strategyId || null,
        setupType: order.setupType || null,
        metadata: { reconciledFromAlpacaPaperOrder: true }
      },
      order,
      trade,
      brokerOrder
    });
  }

  return trade;
}

async function reconcileAlpacaPaperOrder(order, {
  now = new Date(),
  readOrder = readAlpacaPaperOrder,
  createTradeFromOrder = createFilledTradeFromSyncedOrder
} = {}) {
  if (!order?.externalOrderId) return { ok: false, reason: 'MISSING_EXTERNAL_ORDER_ID' };

  const brokerOrder = await readOrder(order.externalOrderId);
  const localStatus = mapAlpacaPaperOrderStatus(brokerOrder);
  const brokerFilledQty = getAlpacaFilledQty(brokerOrder, 0);
  const brokerFillPrice = getAlpacaFillPrice(brokerOrder, null);
  const hasFill = brokerFilledQty > 0 && Number.isFinite(brokerFillPrice) && brokerFillPrice > 0;
  const shouldCreateTrade = hasFill;

  order.externalOrderId = brokerOrder.id || order.externalOrderId;
  order.clientOrderId = brokerOrder.client_order_id || order.clientOrderId;
  order.brokerOrderStatus = brokerOrder.status || order.brokerOrderStatus;
  order.status = localStatus;
  if (hasFill) {
    order.fillPrice = brokerFillPrice;
    order.notional = Number((brokerFilledQty * brokerFillPrice).toFixed(2));
  }
  if (brokerOrder.filled_at) {
    order.filledAt = new Date(brokerOrder.filled_at);
  } else if (localStatus !== 'filled') {
    order.filledAt = null;
  }
  if (localStatus === 'rejected') {
    order.rejectedReason = brokerOrder.reject_reason || brokerOrder.rejected_reason || order.rejectedReason;
  }
  await order.save();

  const trade = shouldCreateTrade
    ? await createTradeFromOrder(order, brokerOrder, { now })
    : null;

  return {
    ok: true,
    order,
    trade,
    brokerOrder,
    status: localStatus
  };
}

async function runOpenAlpacaPaperOrderReconciliation({
  limit = 50,
  now = new Date(),
  readOrder = readAlpacaPaperOrder,
  accountId = ACCOUNT_ID
} = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  const orders = await PaperOrder.find({
    accountId: scopedAccountId,
    broker: 'alpaca',
    status: 'open',
    externalOrderId: { $nin: [null, ''] }
  }).sort({ updatedAt: 1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

  let updated = 0;
  const errors = [];
  for (const order of orders) {
    try {
      await reconcileAlpacaPaperOrder(order, { now, readOrder });
      updated += 1;
    } catch (err) {
      errors.push({
        orderId: String(order._id),
        externalOrderId: order.externalOrderId,
        message: err?.message || 'Could not reconcile Alpaca paper order.'
      });
    }
  }

  return {
    ok: errors.length === 0,
    checked: orders.length,
    updated,
    errors
  };
}

async function reconcileOpenAlpacaPaperOrders(options = {}) {
  const accountId = normalizePaperAccountId(options.accountId);
  if (activeOpenOrderReconciliations.has(accountId)) {
    return activeOpenOrderReconciliations.get(accountId);
  }
  const reconciliation = runOpenAlpacaPaperOrderReconciliation({ ...options, accountId })
    .finally(() => {
      activeOpenOrderReconciliations.delete(accountId);
    });
  activeOpenOrderReconciliations.set(accountId, reconciliation);
  return reconciliation;
}

async function maybeReconcileOpenAlpacaPaperOrders(reconcile = true, accountId = ACCOUNT_ID) {
  if (!reconcile) return null;
  return reconcileOpenAlpacaPaperOrders({ accountId }).catch(() => null);
}

async function getTrades({ reconcile = true, accountId = ACCOUNT_ID } = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  await maybeReconcileOpenAlpacaPaperOrders(reconcile, scopedAccountId);
  return PaperTrade.find({ accountId: scopedAccountId }).sort({ filledAt: -1 }).lean();
}

async function getOrders({ reconcile = true, accountId = ACCOUNT_ID } = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  await maybeReconcileOpenAlpacaPaperOrders(reconcile, scopedAccountId);
  return PaperOrder.find({ accountId: scopedAccountId }).sort({ updatedAt: -1, filledAt: -1 }).lean();
}

async function getPositions({ reconcile = true, accountId = ACCOUNT_ID } = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  await maybeReconcileOpenAlpacaPaperOrders(reconcile, scopedAccountId);
  const trades = await PaperTrade.find({ accountId: scopedAccountId }).sort({ filledAt: 1 }).lean();
  const { positions } = buildPositions(trades);
  const symbolMeta = trades.reduce((acc, trade) => {
    const key = normalizeCompactSymbol(trade.symbol);
    acc[key] = {
      assetClass: trade.assetClass || inferAssetClass({ symbol: trade.symbol })
    };
    return acc;
  }, {});
  const symbols = Object.keys(positions).filter(symbol => positions[symbol].qty !== 0);
  const quotes = symbols.length ? await fetchQuotes(symbols) : [];
  const quoteMap = {};
  quotes.forEach(quote => {
    quoteMap[normalizeCompactSymbol(quote.symbol)] = quote;
  });

  return symbols.map(symbol => {
    const position = positions[symbol];
    const quote = quoteMap[normalizeCompactSymbol(symbol)];
    const marketPrice = quote?.price || position.avgCost || 0;
    const metrics = calculatePositionMetrics(position, marketPrice);
    return {
      symbol,
      assetClass: symbolMeta[symbol]?.assetClass || inferAssetClass({ symbol }),
      qty: position.qty,
      avgCost: Number(position.avgCost.toFixed(2)),
      marketPrice,
      ...metrics
    };
  });
}

async function getAccount({ reconcile = true, accountId = ACCOUNT_ID } = {}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  await maybeReconcileOpenAlpacaPaperOrders(reconcile, scopedAccountId);
  const settings = await getSettings({ accountId: scopedAccountId });
  const trades = await PaperTrade.find({ accountId: scopedAccountId }).sort({ filledAt: 1 }).lean();
  const positions = await getPositions({ reconcile: false, accountId: scopedAccountId });
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

async function getEquityCurve({ accountId = ACCOUNT_ID } = {}) {
  return PaperEquity.find({ accountId: normalizePaperAccountId(accountId) }).sort({ timestamp: 1 }).lean();
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

function calculateShortHoldingDays(trades, symbol, now = new Date()) {
  const normalizedSymbol = normalizeCompactSymbol(symbol);
  let qty = 0;
  let shortOpenedAt = null;

  trades
    .filter(trade => normalizeCompactSymbol(trade.symbol) === normalizedSymbol)
    .forEach(trade => {
      const deltaQty = trade.side === 'buy' ? Number(trade.qty || 0) : -Number(trade.qty || 0);
      const previousQty = qty;
      qty += deltaQty;

      if (previousQty >= 0 && qty < 0) {
        shortOpenedAt = new Date(trade.filledAt);
      } else if (qty >= 0) {
        shortOpenedAt = null;
      }
    });

  if (qty >= 0 || !shortOpenedAt) return 0;
  const msOpen = now.getTime() - shortOpenedAt.getTime();
  return msOpen > 0 ? (msOpen / (24 * 60 * 60 * 1000)) : 0;
}

function calculateShortOpenQty(currentQty, side, requestedQty) {
  if (side !== 'sell') return 0;
  if (currentQty < 0) return requestedQty;
  if (currentQty >= 0) return Math.max(0, requestedQty - currentQty);
  return 0;
}

async function createAttachedExitOrders({
  parentOrder,
  accountId = parentOrder?.accountId || ACCOUNT_ID,
  now,
  side,
  qty,
  assetClass,
  strategyId,
  setupType,
  strategyTags,
  metadata = {},
  researchSnapshot = null,
  allowExtendedHours,
  marketSession,
  extendedHours,
  timeInForce,
  goodTilDate,
  takeProfitPrice,
  stopLossPrice,
  trailingStopPct
}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  const exitSide = side === 'buy' ? 'sell' : 'buy';
  const hasBracket = Number.isFinite(takeProfitPrice) || Number.isFinite(stopLossPrice);
  const ocoGroupId = hasBracket && Number.isFinite(takeProfitPrice) && Number.isFinite(stopLossPrice)
    ? `oco:${parentOrder._id}`
    : null;
  const attached = [];

  if (Number.isFinite(takeProfitPrice)) {
    const order = await PaperOrder.create({
      accountId: scopedAccountId,
      parentOrderId: parentOrder._id,
      ocoGroupId,
      symbol: parentOrder.symbol,
      assetClass,
      side: exitSide,
      qty,
      orderType: 'take_profit',
      timeInForce,
      goodTilDate: goodTilDate || null,
      limitPrice: Number(takeProfitPrice.toFixed(4)),
      allowExtendedHours,
      extendedHours,
      marketSession,
      strategyId: strategyId || null,
      setupType: setupType || null,
      strategyTags: strategyTags || [],
      metadata,
      researchSnapshot,
      status: 'open',
      notional: Number((qty * takeProfitPrice).toFixed(2)),
      filledAt: now
    });
    attached.push(order);
  }

  if (Number.isFinite(stopLossPrice)) {
    const order = await PaperOrder.create({
      accountId: scopedAccountId,
      parentOrderId: parentOrder._id,
      ocoGroupId,
      symbol: parentOrder.symbol,
      assetClass,
      side: exitSide,
      qty,
      orderType: 'stop_loss',
      timeInForce,
      goodTilDate: goodTilDate || null,
      stopPrice: Number(stopLossPrice.toFixed(4)),
      allowExtendedHours,
      extendedHours,
      marketSession,
      strategyId: strategyId || null,
      setupType: setupType || null,
      strategyTags: strategyTags || [],
      metadata,
      researchSnapshot,
      status: 'open',
      notional: Number((qty * stopLossPrice).toFixed(2)),
      filledAt: now
    });
    attached.push(order);
  }

  if (Number.isFinite(trailingStopPct)) {
    const order = await PaperOrder.create({
      accountId: scopedAccountId,
      parentOrderId: parentOrder._id,
      ocoGroupId: ocoGroupId || `trail:${parentOrder._id}`,
      symbol: parentOrder.symbol,
      assetClass,
      side: exitSide,
      qty,
      orderType: 'trailing_stop',
      timeInForce,
      goodTilDate: goodTilDate || null,
      trailingStopPct: Number(trailingStopPct.toFixed(4)),
      allowExtendedHours,
      extendedHours,
      marketSession,
      strategyId: strategyId || null,
      setupType: setupType || null,
      strategyTags: strategyTags || [],
      metadata,
      researchSnapshot,
      status: 'open',
      filledAt: now
    });
    attached.push(order);
  }

  return attached;
}

async function placeOrderUnlocked({
  accountId = ACCOUNT_ID,
  symbol,
  side,
  qty,
  assetClass,
  orderType = 'market',
  limitPrice,
  timeInForce = 'day',
  goodTilDate,
  takeProfitPrice,
  stopLossPrice,
  trailingStopPct,
  maxPricePerShare,
  allowExtendedHours = false,
  strategyId,
  setupType,
  strategyTags,
  stopPrice,
  origin = 'manual',
  metadata = {}
}) {
  const scopedAccountId = normalizePaperAccountId(accountId);
  const requestStartMs = Date.now();
  const now = new Date();
  const settings = await getSettings({ accountId: scopedAccountId });
  const normalized = normalizeOrderInput({
    symbol,
    side,
    qty,
    assetClass,
    orderType,
    limitPrice,
    timeInForce,
    goodTilDate,
    takeProfitPrice,
    stopLossPrice,
    trailingStopPct,
    stopPrice,
    maxPricePerShare,
    allowExtendedHours
  });
  const {
    normalizedSymbol,
    normalizedAssetClass,
    normalizedSide,
    numericQty,
    normalizedOrderType,
    normalizedTimeInForce,
    parsedGoodTilDate,
    parsedLimitPrice,
    parsedTakeProfitPrice,
    parsedStopLossPrice,
    parsedTrailingStopPct,
    parsedStopTriggerPrice,
    parsedMaxPricePerShare
  } = normalized;

  if (normalizedAssetClass === 'crypto') {
    const minNotional = Number(settings.cryptoMinNotional || 0);
    const lotSize = Number(settings.cryptoLotSize || 0);
    if (lotSize > 0) {
      const lots = numericQty / lotSize;
      const roundedLots = Math.round(lots);
      if (Math.abs(lots - roundedLots) > 1e-6) {
        throw new Error(`Crypto quantity must align to lot size ${lotSize}.`);
      }
    }
    if (minNotional > 0 && Number.isFinite(parsedLimitPrice) && (parsedLimitPrice * numericQty) < minNotional) {
      throw new Error(`Crypto notional must be at least $${minNotional.toFixed(2)}.`);
    }
  }

  const [quote] = await fetchQuotes([normalizedSymbol], { assetClass: normalizedAssetClass });
  if (!quote || !quote.price) {
    throw new Error('Quote unavailable for symbol.');
  }

  const estimatedPrice = Number(Number(quote.price).toFixed(4));
  const marketContext = enforceMarketHours({
    allowExtendedHours: normalized.allowExtendedHours,
    assetClass: normalizedAssetClass,
    now
  });

  const slippageFactor = (settings.slippageBps || 0) / 10000;
  let fillPrice = estimatedPrice;
  fillPrice = normalizedSide === 'buy'
    ? fillPrice * (1 + slippageFactor)
    : fillPrice * (1 - slippageFactor);
  fillPrice = Number(fillPrice.toFixed(4));

  enforcePriceControls({
    side: normalizedSide,
    fillPrice,
    orderType: normalizedOrderType,
    limitPrice: parsedLimitPrice,
    stopTriggerPrice: parsedStopTriggerPrice,
    maxPricePerShare: parsedMaxPricePerShare
  });

  const account = await getAccount({ accountId: scopedAccountId });
  const trades = await PaperTrade.find({ accountId: scopedAccountId }).sort({ filledAt: 1 }).lean();
  const { positions } = buildPositions(trades);
  const currentPosition = positions[normalizedSymbol] || { qty: 0, avgCost: 0 };
  const equityBase = account.equity > 0 ? account.equity : settings.startingCash;
  const orderNotional = Number((fillPrice * numericQty).toFixed(2));

  if (normalizedAssetClass === 'crypto') {
    const minNotional = Number(settings.cryptoMinNotional || 0);
    if (minNotional > 0 && orderNotional < minNotional) {
      throw new Error(`Crypto notional must be at least $${minNotional.toFixed(2)}.`);
    }
  }

  const unifiedRisk = evaluateUnifiedRisk({
    symbol: normalizedSymbol,
    side: normalizedSide,
    assetClass: normalizedAssetClass,
    orderNotional,
    account,
    settings,
    currentPositionQty: currentPosition.qty
  });
  if (!unifiedRisk.ok) {
    await PaperGuardrailEvent.create({
      accountId: scopedAccountId,
      symbol: normalizedSymbol,
      orderNotional,
      reason: unifiedRisk.reason
    });
    throw new Error(unifiedRisk.reason);
  }

  const guardrail = evaluateGuardrails({
    equity: equityBase,
    orderNotional,
    dailyPnl: account.dailyPnl,
    settings,
    now
  });

  if (!guardrail.ok) {
    await PaperGuardrailEvent.create({
      accountId: scopedAccountId,
      symbol: normalizedSymbol,
      orderNotional,
      reason: guardrail.reason
    });
    throw new Error(guardrail.reason);
  }

  const shortOpenQty = calculateShortOpenQty(currentPosition.qty, normalizedSide, numericQty);
  const borrowProfile = shortOpenQty > 0 && normalizedAssetClass !== 'crypto'
    ? getShortBorrowProfile(normalizedSymbol)
    : null;
  if (shortOpenQty > 0 && normalizedAssetClass !== 'crypto') {
    if (!borrowProfile.borrowable) {
      throw new Error(`No shares available to borrow for short sale of ${normalizedSymbol}.`);
    }

    const maxBorrowFee = Number(settings.shortMaxBorrowFeeApr || 0);
    if (maxBorrowFee > 0 && borrowProfile.feeApr > maxBorrowFee) {
      throw new Error(
        `Borrow fee (${borrowProfile.feeApr.toFixed(2)}% APR) exceeds configured max (${maxBorrowFee.toFixed(2)}%).`
      );
    }

    const existingShortQty = currentPosition.qty < 0 ? Math.abs(currentPosition.qty) : 0;
    const projectedShortQty = existingShortQty + shortOpenQty;
    const maintenanceMarginPct = Number(settings.shortMaintenanceMarginPct || 30);
    const requiredMargin = projectedShortQty * fillPrice * (maintenanceMarginPct / 100);
    if (account.cash < requiredMargin) {
      throw new Error(
        `Insufficient margin for short position. Required $${requiredMargin.toFixed(2)} at ${maintenanceMarginPct}% maintenance.`
      );
    }

    const shortHoldDays = calculateShortHoldingDays(trades, normalizedSymbol, now);
    const shortForceBuyInDays = Number(settings.shortForceBuyInDays || 0);
    if (shortForceBuyInDays > 0 && shortHoldDays >= shortForceBuyInDays && borrowProfile.hardToBorrow) {
      const reason = `Forced buy-in simulation triggered for ${normalizedSymbol} after ${shortHoldDays.toFixed(1)} days hard-to-borrow short exposure.`;
      await PaperGuardrailEvent.create({
        accountId: scopedAccountId,
        symbol: normalizedSymbol,
        orderNotional,
        reason
      });
      throw new Error(reason);
    }
  }

  const isClosing = currentPosition.qty !== 0
    && currentPosition.qty * (normalizedSide === 'buy' ? numericQty : -numericQty) < 0;
  const commission = Number(settings.commission || 0);
  const stopValue = parsedStopLossPrice !== null
    ? parsedStopLossPrice
    : (stopPrice !== undefined && stopPrice !== null
      ? Number(stopPrice)
      : null);
  const stopTriggerValue = parsedStopTriggerPrice !== null
    ? parsedStopTriggerPrice
    : null;
  const strategy = strategyId ? getStrategy(strategyId) : null;
  const finalTags = Array.isArray(strategyTags) && strategyTags.length
    ? strategyTags
    : (strategy?.tags || []);
  const regimeAtTrade = await getRegimeAtTrade(now);
  const fillLatencyMs = Date.now() - requestStartMs;
  const effectiveSlippageBps = estimatedPrice > 0
    ? Number((((normalizedSide === 'buy'
      ? (fillPrice - estimatedPrice)
      : (estimatedPrice - fillPrice)) / estimatedPrice) * 10000).toFixed(2))
    : 0;
  const borrowStatus = borrowProfile
    ? (borrowProfile.borrowable
      ? (borrowProfile.hardToBorrow ? 'hard_to_borrow' : 'borrowable')
      : 'unavailable')
    : 'none';
  const orderMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const researchSnapshot = orderMetadata.researchSnapshot || orderMetadata.research || null;
  const baseOrderPayload = {
    accountId: scopedAccountId,
    symbol: normalizedSymbol,
    assetClass: normalizedAssetClass,
    side: normalizedSide,
    qty: numericQty,
    orderType: normalizedOrderType,
    timeInForce: normalizedTimeInForce,
    goodTilDate: parsedGoodTilDate || null,
    limitPrice: Number.isFinite(parsedLimitPrice) ? parsedLimitPrice : null,
    takeProfitPrice: Number.isFinite(parsedTakeProfitPrice) ? parsedTakeProfitPrice : null,
    stopLossPrice: Number.isFinite(parsedStopLossPrice) ? parsedStopLossPrice : null,
    trailingStopPct: Number.isFinite(parsedTrailingStopPct) ? parsedTrailingStopPct : null,
    maxPricePerShare: Number.isFinite(parsedMaxPricePerShare) ? parsedMaxPricePerShare : null,
    allowExtendedHours: normalized.allowExtendedHours,
    extendedHours: marketContext.extendedHours,
    marketSession: marketContext.marketSession,
    strategyId: strategyId || null,
    setupType: setupType || null,
    strategyTags: finalTags,
    metadata: orderMetadata,
    researchSnapshot,
    estimatedPrice,
    stopPrice: stopTriggerValue !== null ? stopTriggerValue : stopValue,
    fillLatencyMs,
    effectiveSlippageBps,
    shortBorrowFeeApr: borrowProfile?.feeApr || null,
    borrowStatus,
    forcedBuyIn: false,
    commission,
    slippageBps: settings.slippageBps || 0,
    notional: orderNotional
  };
  const executionRequest = {
    accountId: scopedAccountId,
    origin,
    broker: 'paper',
    symbol: normalizedSymbol,
    assetClass: normalizedAssetClass,
    side: normalizedSide,
    qty: numericQty,
    orderType: normalizedOrderType,
    timeInForce: normalizedTimeInForce,
    limitPrice: parsedLimitPrice,
    stopPrice: stopTriggerValue !== null ? stopTriggerValue : stopValue,
    takeProfitPrice: parsedTakeProfitPrice,
    stopLossPrice: parsedStopLossPrice,
    trailingStopPct: parsedTrailingStopPct,
    maxPricePerShare: parsedMaxPricePerShare,
    allowExtendedHours: normalized.allowExtendedHours,
    strategyId: strategyId || null,
    setupType: setupType || null,
    metadata: orderMetadata
  };
  let alpacaPaperOrder = null;
  let order = null;
  const syncToAlpaca = shouldSyncPaperTradesToAlpaca();
  if (syncToAlpaca) {
    const clientOrderId = buildClientOrderId({
      origin,
      symbol: normalizedSymbol,
      now
    });
    const submitAttachedExitsToAlpaca = shouldSubmitAlpacaAttachedExits({
      assetClass: normalizedAssetClass,
      qty: numericQty,
      takeProfitPrice: parsedTakeProfitPrice,
      stopLossPrice: parsedStopLossPrice
    });
    order = await PaperOrder.create({
      ...baseOrderPayload,
      broker: 'alpaca',
      clientOrderId,
      brokerOrderStatus: 'pending_submit',
      status: 'open',
      fillPrice: null,
      filledAt: null
    });
    try {
      alpacaPaperOrder = await submitAlpacaPaperOrder({
        symbol: normalizedSymbol,
        assetClass: normalizedAssetClass,
        side: normalizedSide,
        qty: numericQty,
        orderType: normalizedOrderType,
        timeInForce: normalizedTimeInForce,
        limitPrice: parsedLimitPrice,
        stopPrice: stopTriggerValue,
        takeProfitPrice: submitAttachedExitsToAlpaca ? parsedTakeProfitPrice : null,
        stopLossPrice: submitAttachedExitsToAlpaca ? parsedStopLossPrice : null,
        trailingStopPct: parsedTrailingStopPct,
        allowExtendedHours: marketContext.extendedHours && normalized.allowExtendedHours,
        clientOrderId
      }, {
        pollStatusAttempts: 3,
        pollStatusDelayMs: 300
      });
    } catch (err) {
      const rejectedReason = err.message || 'Alpaca paper order submission failed.';
      order.status = 'rejected';
      order.brokerOrderStatus = 'rejected';
      order.rejectedReason = rejectedReason;
      await order.save();
      await recordRejectedExecution({
        broker: 'alpaca',
        origin,
        rejectedReason,
        request: executionRequest
      });
      err.paperOrderRecorded = true;
      err.paperOrder = order;
      throw err;
    }

    const brokerOrder = alpacaPaperOrder?.order || {};
    const localStatus = mapAlpacaPaperOrderStatus(brokerOrder);
    const brokerFillPrice = getAlpacaFillPrice(brokerOrder, fillPrice);
    const brokerFilledQty = getAlpacaFilledQty(brokerOrder, numericQty);
    order.externalOrderId = brokerOrder.id || null;
    order.clientOrderId = brokerOrder.client_order_id || alpacaPaperOrder?.payload?.client_order_id || clientOrderId;
    order.brokerOrderStatus = brokerOrder.status || null;
    order.status = localStatus;
    order.fillPrice = localStatus === 'filled' ? brokerFillPrice : null;
    order.notional = localStatus === 'filled'
      ? Number((brokerFillPrice * brokerFilledQty).toFixed(2))
      : orderNotional;
    order.filledAt = localStatus === 'filled'
      ? (brokerOrder.filled_at ? new Date(brokerOrder.filled_at) : now)
      : null;
    if (localStatus === 'rejected') {
      order.rejectedReason = getAlpacaPaperRejectionReason(brokerOrder);
    }
    await order.save();

    if (localStatus === 'rejected') {
      const rejectedReason = order.rejectedReason || 'Alpaca rejected the paper order.';
      await recordRejectedExecution({
        broker: 'alpaca',
        origin,
        rejectedReason,
        request: executionRequest
      });
      const err = new Error(rejectedReason);
      err.statusCode = 400;
      err.paperOrderRecorded = true;
      err.paperOrder = order;
      err.brokerOrder = brokerOrder;
      throw err;
    }

    if (localStatus !== 'filled') {
      const updatedAccount = await getAccount({ accountId: scopedAccountId });
      return {
        order,
        trade: null,
        attachedOrders: [],
        brokerOrder,
        account: updatedAccount,
        positions: updatedAccount.positions
      };
    }
  } else {
    order = await PaperOrder.create({
      ...baseOrderPayload,
      broker: 'paper',
      status: 'filled',
      fillPrice,
      filledAt: now
    });
  }

  const executedQty = syncToAlpaca
    ? getAlpacaFilledQty(alpacaPaperOrder?.order || {}, numericQty)
    : numericQty;
  const executedFillPrice = syncToAlpaca
    ? getAlpacaFillPrice(alpacaPaperOrder?.order || {}, fillPrice)
    : fillPrice;
  const executedNotional = Number((executedQty * executedFillPrice).toFixed(2));
  const executedBorrowFeeAccrued = shortOpenQty > 0 && borrowProfile
    ? Number(((Math.min(shortOpenQty, executedQty) * executedFillPrice) * (borrowProfile.feeApr / 100) / 365).toFixed(4))
    : 0;
  const { realizedPnl: executedRealizedPnl } = applyTradeToPosition(currentPosition, {
    side: normalizedSide,
    qty: executedQty,
    price: executedFillPrice
  });
  const executedTradeRealized = executedRealizedPnl - commission - executedBorrowFeeAccrued;
  const executedRiskPerShare = stopValue ? Math.abs(executedFillPrice - stopValue) : null;
  const executedRMultiple = isClosing && executedRiskPerShare
    ? executedTradeRealized / (executedRiskPerShare * executedQty)
    : null;

  let trade = null;
  try {
    trade = await PaperTrade.create({
    accountId: scopedAccountId,
    broker: alpacaPaperOrder?.broker || 'paper',
    externalOrderId: alpacaPaperOrder?.order?.id || null,
    clientOrderId: alpacaPaperOrder?.order?.client_order_id || alpacaPaperOrder?.payload?.client_order_id || null,
    brokerOrderStatus: alpacaPaperOrder?.order?.status || null,
    symbol: normalizedSymbol,
    assetClass: normalizedAssetClass,
    side: normalizedSide,
    qty: executedQty,
    price: executedFillPrice,
    extendedHours: marketContext.extendedHours,
    marketSession: marketContext.marketSession,
    strategyId: strategyId || null,
    setupType: setupType || null,
    strategyTags: finalTags,
    metadata: orderMetadata,
    researchSnapshot,
    estimatedPrice,
    effectiveSlippageBps,
    fillLatencyMs,
    shortBorrowFeeApr: borrowProfile?.feeApr || null,
    borrowFeeAccrued: executedBorrowFeeAccrued,
    forcedBuyIn: false,
    stopPrice: stopValue,
    riskPerShare: executedRiskPerShare ? Number(executedRiskPerShare.toFixed(4)) : null,
    rMultiple: executedRMultiple !== null ? Number(executedRMultiple.toFixed(2)) : null,
    regimeAtTrade: regimeAtTrade ? {
      date: regimeAtTrade.date,
      trendChop: regimeAtTrade.trendChop,
      vol: regimeAtTrade.vol,
      risk: regimeAtTrade.risk,
      notes: regimeAtTrade.notes || []
    } : null,
    commission,
    notional: executedNotional,
    realizedPnl: executedTradeRealized,
    orderId: order._id,
    filledAt: now
    });
  } catch (err) {
    // Internal paper fills have no external side effect, so compensate the
    // earlier order write rather than leave a filled order without a trade.
    if (!syncToAlpaca && order?._id) {
      await PaperOrder.deleteOne({ _id: order._id, broker: 'paper' }).catch(() => {});
    }
    throw err;
  }

  const attachedOrders = await createAttachedExitOrders({
    parentOrder: order,
    accountId: scopedAccountId,
    now,
    side: normalizedSide,
    qty: executedQty,
    assetClass: normalizedAssetClass,
    strategyId: strategyId || null,
    setupType: setupType || null,
    strategyTags: finalTags,
    metadata: orderMetadata,
    researchSnapshot,
    allowExtendedHours: normalized.allowExtendedHours,
    marketSession: marketContext.marketSession,
    extendedHours: marketContext.extendedHours,
    timeInForce: normalizedTimeInForce,
    goodTilDate: parsedGoodTilDate || null,
    takeProfitPrice: Number.isFinite(parsedTakeProfitPrice) ? parsedTakeProfitPrice : null,
    stopLossPrice: Number.isFinite(parsedStopLossPrice) ? parsedStopLossPrice : null,
    trailingStopPct: Number.isFinite(parsedTrailingStopPct) ? parsedTrailingStopPct : null
  });

  const tradePlanId = await linkTradeToPlan(trade, scopedAccountId);
  if (tradePlanId) {
    trade.tradePlanId = tradePlanId;
  }

  const { consecutiveLosses, cooldownUntil } = updateCooldownState(
    settings,
    executedTradeRealized,
    now
  );
  settings.consecutiveLosses = consecutiveLosses;
  settings.cooldownUntil = cooldownUntil;
  await settings.save();

  const updatedAccount = await getAccount({ accountId: scopedAccountId });
  await PaperEquity.create({
    accountId: scopedAccountId,
    timestamp: now,
    equity: updatedAccount.equity,
    cash: updatedAccount.cash,
    positionsValue: updatedAccount.positionsValue,
    dailyPnl: updatedAccount.dailyPnl,
    totalPnl: updatedAccount.totalPnl
  });

  await recordFilledExecution({
    broker: alpacaPaperOrder?.broker || 'paper',
    origin,
    request: {
      accountId: scopedAccountId,
      origin,
      broker: 'paper',
      symbol: normalizedSymbol,
      assetClass: normalizedAssetClass,
      side: normalizedSide,
      qty: executedQty,
      orderType: normalizedOrderType,
      timeInForce: normalizedTimeInForce,
      limitPrice: parsedLimitPrice,
      stopPrice: stopTriggerValue !== null ? stopTriggerValue : stopValue,
      takeProfitPrice: parsedTakeProfitPrice,
      stopLossPrice: parsedStopLossPrice,
      trailingStopPct: parsedTrailingStopPct,
      maxPricePerShare: parsedMaxPricePerShare,
      allowExtendedHours: normalized.allowExtendedHours,
      strategyId: strategyId || null,
      setupType: setupType || null,
      metadata: orderMetadata
    },
    order,
    trade,
    brokerOrder: alpacaPaperOrder?.order || null
  });

  return {
    order,
    trade,
    attachedOrders,
    brokerOrder: alpacaPaperOrder?.order || null,
    account: updatedAccount,
    positions: updatedAccount.positions
  };
}

async function acquirePaperAccountLock(accountId, owner, now = new Date()) {
  try {
    return await PaperAccountLock.findOneAndUpdate(
      {
        accountId,
        $or: [
          { lockedUntil: { $lte: now } },
          { owner }
        ]
      },
      {
        $set: {
          owner,
          lockedUntil: new Date(now.getTime() + PAPER_ORDER_LOCK_MS)
        }
      },
      { new: true, upsert: true, runValidators: true }
    );
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

async function releasePaperAccountLock(accountId, owner) {
  await PaperAccountLock.updateOne(
    { accountId, owner },
    { $set: { lockedUntil: new Date(0) } }
  );
}

async function placeOrder(input = {}) {
  const accountId = normalizePaperAccountId(input.accountId);
  const owner = `paper-order:${accountId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const lock = await acquirePaperAccountLock(accountId, owner);
  if (!lock) {
    const err = new Error('Another paper order is already being processed for this account. Retry after it completes.');
    err.statusCode = 409;
    throw err;
  }
  try {
    return await placeOrderUnlocked({ ...input, accountId });
  } finally {
    await releasePaperAccountLock(accountId, owner).catch(() => {});
  }
}

async function recordRejectedOrder(payload = {}, rejectedReason = 'Order rejected') {
  try {
    const accountId = normalizePaperAccountId(payload.accountId);
    const now = new Date();
    let normalized = null;
    try {
      normalized = normalizeOrderInput(payload);
    } catch (_err) {
      // Best effort logging; proceed with raw values.
    }

    const symbol = normalizeCompactSymbol(normalized?.normalizedSymbol || payload.symbol || '');
    if (!symbol) return null;
    const side = normalized?.normalizedSide || (payload.side === 'sell' ? 'sell' : 'buy');
    const qty = Math.max(0.000001, Number(normalized?.numericQty || payload.qty || 0.000001));
    const assetClass = normalized?.normalizedAssetClass
      || inferAssetClass({ symbol: payload.symbol, assetClass: payload.assetClass });
    const orderTypeValue = String(normalized?.normalizedOrderType || payload.orderType || 'market').toLowerCase();
    const timeInForceValue = String(normalized?.normalizedTimeInForce || payload.timeInForce || 'day').toLowerCase();
    const limitPriceValue = normalized?.parsedLimitPrice ?? Number(payload.limitPrice);
    const stopPriceValue = normalized?.parsedStopTriggerPrice ?? Number(payload.stopPrice);
    const takeProfitValue = normalized?.parsedTakeProfitPrice ?? Number(payload.takeProfitPrice);
    const stopLossValue = normalized?.parsedStopLossPrice ?? Number(payload.stopLossPrice);
    const trailingStopValue = normalized?.parsedTrailingStopPct ?? Number(payload.trailingStopPct);
    const maxPriceValue = normalized?.parsedMaxPricePerShare ?? Number(payload.maxPricePerShare);
    const estimatedPrice = Number(payload.estimatedPrice);
    const notional = Number(payload.notional);

    const rejectedOrder = await PaperOrder.create({
      accountId,
      broker: shouldSyncPaperTradesToAlpaca() ? 'alpaca' : 'paper',
      symbol,
      assetClass,
      side,
      qty,
      orderType: orderTypeValue,
      timeInForce: ['day', 'gtc', 'gtd', 'ioc'].includes(timeInForceValue) ? timeInForceValue : 'day',
      goodTilDate: normalized?.parsedGoodTilDate || (payload.goodTilDate ? new Date(payload.goodTilDate) : null),
      limitPrice: Number.isFinite(limitPriceValue) ? limitPriceValue : null,
      stopPrice: Number.isFinite(stopPriceValue) ? stopPriceValue : null,
      takeProfitPrice: Number.isFinite(takeProfitValue) ? takeProfitValue : null,
      stopLossPrice: Number.isFinite(stopLossValue) ? stopLossValue : null,
      trailingStopPct: Number.isFinite(trailingStopValue) ? trailingStopValue : null,
      maxPricePerShare: Number.isFinite(maxPriceValue) ? maxPriceValue : null,
      allowExtendedHours: payload.allowExtendedHours === true,
      metadata: payload.metadata || {},
      researchSnapshot: payload.metadata?.researchSnapshot || payload.metadata?.research || null,
      status: 'rejected',
      estimatedPrice: Number.isFinite(estimatedPrice) ? estimatedPrice : null,
      notional: Number.isFinite(notional) ? notional : null,
      rejectedReason,
      filledAt: now
    });
    await recordRejectedExecution({
      broker: 'paper',
      origin: payload.origin || 'manual',
      rejectedReason,
      request: {
        accountId,
        origin: payload.origin || 'manual',
        broker: 'paper',
        symbol,
        assetClass,
        side,
        qty,
        orderType: orderTypeValue,
        timeInForce: timeInForceValue,
        limitPrice: Number.isFinite(limitPriceValue) ? limitPriceValue : null,
        stopPrice: Number.isFinite(stopPriceValue) ? stopPriceValue : null,
        takeProfitPrice: Number.isFinite(takeProfitValue) ? takeProfitValue : null,
        stopLossPrice: Number.isFinite(stopLossValue) ? stopLossValue : null,
        trailingStopPct: Number.isFinite(trailingStopValue) ? trailingStopValue : null,
        maxPricePerShare: Number.isFinite(maxPriceValue) ? maxPriceValue : null,
        allowExtendedHours: payload.allowExtendedHours === true,
        strategyId: payload.strategyId || null,
        setupType: payload.setupType || null,
        metadata: payload.metadata || {}
      }
    });
    return rejectedOrder;
  } catch (_err) {
    return null;
  }
}

module.exports = {
  acquirePaperAccountLock,
  getSettings,
  updateSettings,
  getTrades,
  getOrders,
  getPositions,
  getAccount,
  getEquityCurve,
  placeOrder,
  releasePaperAccountLock,
  recordRejectedOrder,
  createFilledTradeFromSyncedOrder,
  normalizeOrderInput,
  enforceMarketHours,
  enforcePriceControls,
  shouldSubmitAlpacaAttachedExits,
  getAlpacaFillPrice,
  getAlpacaFilledQty,
  isTerminalAlpacaStatus,
  mapAlpacaPaperOrderStatus,
  reconcileAlpacaPaperOrder,
  reconcileOpenAlpacaPaperOrders
};
