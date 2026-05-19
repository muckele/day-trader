const mongoose = require('mongoose');

const paperTradeSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    externalOrderId: { type: String, default: null, index: true },
    clientOrderId: { type: String, default: null, index: true },
    brokerOrderStatus: { type: String, default: null },
    symbol: { type: String, required: true },
    assetClass: { type: String, enum: ['equity', 'crypto'], default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    extendedHours: { type: Boolean, default: false },
    marketSession: { type: String, enum: ['regular', 'extended', 'crypto'], default: 'regular' },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    strategyTags: { type: [String], default: [] },
    estimatedPrice: { type: Number, default: null },
    effectiveSlippageBps: { type: Number, default: null },
    fillLatencyMs: { type: Number, default: null },
    shortBorrowFeeApr: { type: Number, default: null },
    borrowFeeAccrued: { type: Number, default: 0 },
    forcedBuyIn: { type: Boolean, default: false },
    stopPrice: { type: Number, default: null },
    riskPerShare: { type: Number, default: null },
    rMultiple: { type: Number, default: null },
    regimeAtTrade: {
      date: { type: String, default: null },
      trendChop: { type: String, default: null },
      vol: { type: String, default: null },
      risk: { type: String, default: null },
      notes: { type: [String], default: [] }
    },
    commission: { type: Number, default: 0 },
    notional: { type: Number, required: true },
    realizedPnl: { type: Number, default: 0 },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaperOrder' },
    tradePlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradePlan', default: null },
    filledAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperTrade', paperTradeSchema);
