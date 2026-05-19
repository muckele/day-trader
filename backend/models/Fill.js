const mongoose = require('mongoose');

const fillSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    intentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderIntent', default: null, index: true },
    brokerOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerOrder', default: null, index: true },
    paperTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaperTrade', default: null },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    notional: { type: Number, default: null },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    regimeAtTrade: { type: mongoose.Schema.Types.Mixed, default: null },
    realizedPnl: { type: Number, default: null },
    filledAt: { type: Date, default: Date.now, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

fillSchema.index({ accountId: 1, filledAt: -1 });

module.exports = mongoose.model('Fill', fillSchema);
