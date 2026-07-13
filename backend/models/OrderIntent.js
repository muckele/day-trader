const mongoose = require('mongoose');

const orderIntentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    accountId: { type: String, default: 'default', index: true },
    decisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboTradeDecision', default: null, index: true },
    idempotencyKey: { type: String, default: null },
    origin: { type: String, default: 'manual', index: true },
    broker: { type: String, enum: ['paper', 'alpaca', 'robinhood'], default: 'paper', index: true },
    environment: { type: String, enum: ['paper', 'shadow', 'live'], default: 'paper', index: true },
    symbol: { type: String, required: true, index: true },
    assetClass: { type: String, default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, default: null },
    notional: { type: Number, default: null },
    estimatedNotional: { type: Number, default: null },
    orderType: { type: String, default: 'market' },
    orderClass: { type: String, default: 'simple' },
    timeInForce: { type: String, default: 'day' },
    limitPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    takeProfitPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    trailingStopPct: { type: Number, default: null },
    maxPricePerShare: { type: Number, default: null },
    allowExtendedHours: { type: Boolean, default: false },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    status: {
      type: String,
      enum: [
        'created',
        'policy_blocked',
        'policy_approved',
        'awaiting_authorization',
        'authorized',
        'submitting',
        'submitted',
        'submission_uncertain',
        'filled',
        'cancelled',
        'rejected'
      ],
      default: 'created',
      index: true
    },
    policyVersion: { type: String, default: null, immutable: true, index: true },
    reasonCodes: { type: [String], default: [] },
    riskChecks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    executionQuality: { type: mongoose.Schema.Types.Mixed, default: null },
    exposureSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboExposureSnapshot', default: null },
    orderFingerprint: { type: String, default: null, immutable: true, index: true },
    orderSnapshot: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    approvalPolicy: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    authorizationStatus: {
      type: String,
      enum: ['not_required', 'missing', 'active', 'valid', 'consumed', 'expired', 'revoked', 'mismatch', 'policy_version_mismatch'],
      default: 'not_required',
      index: true
    },
    authorizationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    authorizationExpiresAt: { type: Date, default: null },
    authorizedAt: { type: Date, default: null },
    roboTradeOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboTradeOrder', default: null },
    rejectionReason: { type: String, default: null },
    requestedAt: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

orderIntentSchema.index({ accountId: 1, requestedAt: -1 });
orderIntentSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      userId: { $type: 'objectId' },
      idempotencyKey: { $type: 'string' }
    }
  }
);
orderIntentSchema.index({ userId: 1, environment: 1, status: 1, requestedAt: -1 });

module.exports = mongoose.model('OrderIntent', orderIntentSchema);
