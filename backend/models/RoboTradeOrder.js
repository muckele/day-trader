const mongoose = require('mongoose');

const riskCheckSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    passed: { type: Boolean, required: true },
    message: { type: String, default: null },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const roboTradeOrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    accountId: { type: String, default: 'default', index: true },
    decisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboTradeDecision', default: null, index: true },
    environment: { type: String, enum: ['paper', 'live'], default: 'paper', index: true },
    broker: { type: String, enum: ['alpaca'], default: 'alpaca', index: true },
    externalOrderId: { type: String, default: null, index: true },
    clientOrderId: { type: String, default: null },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, enum: ['stocks', 'crypto', 'options'], default: 'stocks', index: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    orderType: { type: String, default: 'market' },
    orderClass: { type: String, default: 'simple' },
    timeInForce: { type: String, default: 'day' },
    qty: { type: Number, default: null },
    notional: { type: Number, default: null },
    limitPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    trailPrice: { type: Number, default: null },
    trailPercent: { type: Number, default: null },
    takeProfit: { type: mongoose.Schema.Types.Mixed, default: null },
    stopLoss: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, default: 'pending_submit', index: true },
    filledQty: { type: Number, default: null },
    filledAvgPrice: { type: Number, default: null },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: {} },
    alpacaResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    reasoningSummary: { type: String, default: null },
    strategyId: { type: String, default: null, index: true },
    riskChecks: { type: [riskCheckSchema], default: [] },
    submittedAt: { type: Date, default: null, index: true },
    filledAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    reconciliationStatus: { type: String, default: 'pending' },
    discrepancy: { type: String, default: null }
  },
  { timestamps: true }
);

roboTradeOrderSchema.index({ clientOrderId: 1 }, { unique: true, sparse: true });
roboTradeOrderSchema.index({ userId: 1, symbol: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model('RoboTradeOrder', roboTradeOrderSchema);
