const mongoose = require('mongoose');

const brokerOrderSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    intentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderIntent', default: null, index: true },
    paperOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaperOrder', default: null },
    externalOrderId: { type: String, default: null, index: true },
    origin: { type: String, default: 'manual', index: true },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    orderType: { type: String, default: 'market' },
    status: { type: String, enum: ['filled', 'rejected', 'cancelled', 'submitted'], default: 'submitted', index: true },
    estimatedPrice: { type: Number, default: null },
    fillPrice: { type: Number, default: null },
    notional: { type: Number, default: null },
    slippageBps: { type: Number, default: null },
    fillLatencyMs: { type: Number, default: null },
    rejectionReason: { type: String, default: null },
    submittedAt: { type: Date, default: Date.now },
    filledAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

brokerOrderSchema.index({ accountId: 1, submittedAt: -1 });

module.exports = mongoose.model('BrokerOrder', brokerOrderSchema);
