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

const roboTradeDecisionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: String, default: 'default', index: true },
    intentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderIntent', default: null, index: true },
    environment: { type: String, enum: ['paper', 'shadow', 'live'], default: 'paper', index: true },
    runId: { type: String, required: true, index: true },
    idempotencyKey: { type: String, required: true },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, enum: ['stocks', 'crypto', 'options'], default: 'stocks', index: true },
    action: { type: String, enum: ['buy', 'sell', 'short', 'cover', 'hold'], default: 'hold' },
    status: {
      type: String,
      enum: ['approved', 'rejected', 'submitted', 'filled', 'cancelled', 'error', 'pending_manual_approval'],
      default: 'rejected',
      index: true
    },
    confidenceScore: { type: Number, default: 0 },
    rewardRiskRatio: { type: Number, default: null },
    strategyId: { type: String, default: null, index: true },
    strategyName: { type: String, default: null },
    reasoningSummary: { type: String, default: null },
    researchSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    recommendedOrder: { type: mongoose.Schema.Types.Mixed, default: {} },
    riskChecks: { type: [riskCheckSchema], default: [] },
    executionQuality: { type: mongoose.Schema.Types.Mixed, default: null },
    exposureSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboExposureSnapshot', default: null },
    policyVersion: { type: String, default: null, index: true },
    reasonCodes: { type: [String], default: [] },
    orderFingerprint: { type: String, default: null, index: true },
    approval: { type: mongoose.Schema.Types.Mixed, default: null },
    rejectionReasons: { type: [String], default: [] },
    alpacaResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    decidedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

roboTradeDecisionSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
roboTradeDecisionSchema.index({ userId: 1, decidedAt: -1 });
roboTradeDecisionSchema.index({ status: 1, decidedAt: 1, _id: 1 });

module.exports = mongoose.model('RoboTradeDecision', roboTradeDecisionSchema);
