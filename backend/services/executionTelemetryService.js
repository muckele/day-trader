const mongoState = require('../utils/mongoState');
const OrderIntent = require('../models/OrderIntent');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sanitizeRequest(request = {}) {
  return {
    accountId: request.accountId || 'default',
    origin: request.origin || 'manual',
    broker: request.broker || 'paper',
    symbol: String(request.symbol || '').toUpperCase(),
    assetClass: request.assetClass || 'equity',
    side: request.side === 'sell' ? 'sell' : 'buy',
    qty: toFiniteNumber(request.qty, 0),
    orderType: request.orderType || 'market',
    timeInForce: request.timeInForce || 'day',
    limitPrice: toFiniteNumber(request.limitPrice),
    stopPrice: toFiniteNumber(request.stopPrice),
    takeProfitPrice: toFiniteNumber(request.takeProfitPrice),
    stopLossPrice: toFiniteNumber(request.stopLossPrice),
    trailingStopPct: toFiniteNumber(request.trailingStopPct),
    maxPricePerShare: toFiniteNumber(request.maxPricePerShare),
    allowExtendedHours: request.allowExtendedHours !== false,
    strategyId: request.strategyId || null,
    setupType: request.setupType || null,
    metadata: request.metadata || {}
  };
}

async function recordFilledExecution({ request, order, trade, brokerOrder, broker = 'paper', origin = 'manual' } = {}) {
  if (!mongoState.isMongoReady()) return null;
  try {
    const intentPayload = sanitizeRequest({ ...request, broker, origin });
    if (!intentPayload.symbol || !intentPayload.qty) return null;

    const intent = await OrderIntent.create({
      ...intentPayload,
      status: 'filled',
      requestedAt: order?.filledAt || trade?.filledAt || new Date()
    });

    const orderRecord = await BrokerOrder.create({
      accountId: intentPayload.accountId,
      broker,
      intentId: intent._id,
      paperOrderId: order?._id || null,
      externalOrderId: brokerOrder?.id || order?.id || order?._id?.toString?.() || null,
      origin,
      symbol: intentPayload.symbol,
      assetClass: intentPayload.assetClass,
      side: intentPayload.side,
      qty: intentPayload.qty,
      orderType: intentPayload.orderType,
      status: 'filled',
      estimatedPrice: toFiniteNumber(order?.estimatedPrice, toFiniteNumber(trade?.estimatedPrice)),
      fillPrice: toFiniteNumber(order?.fillPrice, toFiniteNumber(trade?.price)),
      notional: toFiniteNumber(order?.notional, toFiniteNumber(trade?.notional)),
      slippageBps: toFiniteNumber(order?.effectiveSlippageBps, toFiniteNumber(trade?.effectiveSlippageBps)),
      fillLatencyMs: toFiniteNumber(order?.fillLatencyMs, toFiniteNumber(trade?.fillLatencyMs)),
      submittedAt: order?.filledAt || trade?.filledAt || new Date(),
      filledAt: order?.filledAt || trade?.filledAt || new Date(),
      metadata: request?.metadata || {}
    });

    const fill = await Fill.create({
      accountId: intentPayload.accountId,
      broker,
      intentId: intent._id,
      brokerOrderId: orderRecord._id,
      paperTradeId: trade?._id || null,
      symbol: intentPayload.symbol,
      assetClass: intentPayload.assetClass,
      side: intentPayload.side,
      qty: intentPayload.qty,
      price: toFiniteNumber(trade?.price, toFiniteNumber(order?.fillPrice, 0)),
      notional: toFiniteNumber(trade?.notional, toFiniteNumber(order?.notional)),
      strategyId: trade?.strategyId || intentPayload.strategyId,
      setupType: trade?.setupType || intentPayload.setupType,
      regimeAtTrade: trade?.regimeAtTrade || null,
      realizedPnl: toFiniteNumber(trade?.realizedPnl),
      filledAt: trade?.filledAt || order?.filledAt || new Date(),
      metadata: request?.metadata || {}
    });

    return { intent, order: orderRecord, fill };
  } catch (_err) {
    return null;
  }
}

async function recordRejectedExecution({ request, rejectedReason = 'Order rejected', broker = 'paper', origin = 'manual' } = {}) {
  if (!mongoState.isMongoReady()) return null;
  try {
    const intentPayload = sanitizeRequest({ ...request, broker, origin });
    if (!intentPayload.symbol || !intentPayload.qty) return null;

    const intent = await OrderIntent.create({
      ...intentPayload,
      status: 'rejected',
      rejectionReason: rejectedReason,
      requestedAt: new Date()
    });

    const order = await BrokerOrder.create({
      accountId: intentPayload.accountId,
      broker,
      intentId: intent._id,
      origin,
      symbol: intentPayload.symbol,
      assetClass: intentPayload.assetClass,
      side: intentPayload.side,
      qty: intentPayload.qty,
      orderType: intentPayload.orderType,
      status: 'rejected',
      rejectionReason: rejectedReason,
      submittedAt: new Date(),
      metadata: request?.metadata || {}
    });

    return { intent, order };
  } catch (_err) {
    return null;
  }
}

async function listRecentExecution({ limit = 25 } = {}) {
  if (!mongoState.isMongoReady()) {
    return { orders: [], fills: [] };
  }
  try {
    const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const [orders, fills] = await Promise.all([
      BrokerOrder.find({}).sort({ submittedAt: -1 }).limit(cap).lean(),
      Fill.find({}).sort({ filledAt: -1 }).limit(cap).lean()
    ]);
    return { orders, fills };
  } catch (_err) {
    return { orders: [], fills: [] };
  }
}

module.exports = {
  listRecentExecution,
  recordFilledExecution,
  recordRejectedExecution,
  sanitizeRequest
};
