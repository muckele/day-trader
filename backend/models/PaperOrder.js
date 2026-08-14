const mongoose = require('mongoose');
const { SUBMISSION_STATES } = require('../services/submissionOutcomeService');

const paperOrderSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    broker: { type: String, enum: ['paper', 'alpaca'], default: 'paper', index: true },
    externalOrderId: { type: String, default: null, index: true },
    brokerRequestId: { type: String, default: null, index: true },
    clientOrderId: { type: String, default: null, index: true },
    idempotencyKey: { type: String, default: null },
    idempotencyFingerprint: { type: String, default: null },
    brokerOrderStatus: { type: String, default: null },
    submissionState: {
      type: String,
      enum: Object.values(SUBMISSION_STATES),
      default: SUBMISSION_STATES.NOT_ATTEMPTED,
      index: true
    },
    submissionAttemptCount: { type: Number, min: 0, default: 0 },
    submissionLastAttemptAt: { type: Date, default: null },
    submissionLastError: { type: mongoose.Schema.Types.Mixed, default: null },
    submissionLastReconciledAt: { type: Date, default: null },
    symbol: { type: String, required: true },
    assetClass: { type: String, enum: ['equity', 'crypto'], default: 'equity' },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    orderType: { type: String, default: 'market' },
    timeInForce: { type: String, enum: ['day', 'gtc', 'gtd', 'ioc'], default: 'day' },
    goodTilDate: { type: Date, default: null },
    limitPrice: { type: Number, default: null },
    takeProfitPrice: { type: Number, default: null },
    stopLossPrice: { type: Number, default: null },
    trailingStopPct: { type: Number, default: null },
    parentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaperOrder', default: null },
    ocoGroupId: { type: String, default: null },
    maxPricePerShare: { type: Number, default: null },
    allowExtendedHours: { type: Boolean, default: false },
    extendedHours: { type: Boolean, default: false },
    marketSession: { type: String, enum: ['regular', 'extended', 'crypto'], default: 'regular' },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    strategyTags: { type: [String], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    researchSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    estimatedPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },
    status: { type: String, enum: ['open', 'filled', 'cancelled', 'rejected'], default: 'filled' },
    fillPrice: { type: Number, default: null },
    fillLatencyMs: { type: Number, default: null },
    effectiveSlippageBps: { type: Number, default: null },
    shortBorrowFeeApr: { type: Number, default: null },
    borrowStatus: { type: String, enum: ['none', 'borrowable', 'hard_to_borrow', 'unavailable'], default: 'none' },
    forcedBuyIn: { type: Boolean, default: false },
    commission: { type: Number, default: 0 },
    slippageBps: { type: Number, default: 0 },
    notional: { type: Number, default: null },
    filledAt: { type: Date, default: Date.now },
    rejectedReason: { type: String, default: null }
  },
  { timestamps: true }
);

paperOrderSchema.index(
  { accountId: 1, broker: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' }
    }
  }
);

paperOrderSchema.index(
  { broker: 1, clientOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      broker: 'alpaca',
      clientOrderId: { $type: 'string' }
    }
  }
);

module.exports = mongoose.model('PaperOrder', paperOrderSchema);
