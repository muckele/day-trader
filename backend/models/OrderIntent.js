const mongoose = require('mongoose');

const orderIntentSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    origin: { type: String, default: 'manual', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    orderType: { type: String, default: 'market' },
    timeInForce: { type: String, default: 'day' },
    limitPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    takeProfitPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    trailingStopPct: { type: Number, default: null },
    maxPricePerShare: { type: Number, default: null },
    allowExtendedHours: { type: Boolean, default: true },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    status: { type: String, enum: ['created', 'filled', 'rejected'], default: 'created', index: true },
    rejectionReason: { type: String, default: null },
    requestedAt: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

orderIntentSchema.index({ accountId: 1, requestedAt: -1 });

module.exports = mongoose.model('OrderIntent', orderIntentSchema);
