const mongoose = require('mongoose');

const riskEventSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, index: true },
    severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning', index: true },
    eventType: { type: String, required: true, index: true },
    symbol: { type: String, default: null },
    strategyId: { type: String, default: null },
    assetClass: { type: String, default: null },
    message: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

riskEventSchema.index({ createdAt: -1, source: 1, severity: 1 });

module.exports = mongoose.model('RiskEvent', riskEventSchema);
