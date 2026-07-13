const mongoose = require('mongoose');

const approvalPolicySchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ['every_trade', 'above_threshold', 'autonomous'],
      default: 'every_trade'
    },
    thresholdUsd: { type: Number, default: 0, min: 0 },
    authorizationTtlSeconds: { type: Number, default: 300, min: 30, max: 3600 },
    requireExactOrderMatch: { type: Boolean, default: true }
  },
  { _id: false }
);

const executionPolicySchema = new mongoose.Schema(
  {
    maxQuoteAgeSeconds: { type: Number, default: 15, min: 1, max: 300 },
    maxSpreadBps: { type: Number, default: 35, min: 1, max: 500 },
    minAverageDailyDollarVolume: { type: Number, default: 20000000, min: 0 },
    maxEstimatedSlippageBps: { type: Number, default: 25, min: 1, max: 500 },
    cutoffMinutesBeforeClose: { type: Number, default: 15, min: 0, max: 120 },
    regularSessionCutoffEt: { type: String, default: '15:45' }
  },
  { _id: false }
);

const portfolioPolicySchema = new mongoose.Schema(
  {
    maxGrossExposurePct: { type: Number, default: 100, min: 0, max: 1000 },
    maxNetExposurePct: { type: Number, default: 100, min: 0, max: 1000 },
    maxDailyDrawdownPct: { type: Number, default: 2, min: 0, max: 100 },
    maxTotalDrawdownPct: { type: Number, default: 5, min: 0, max: 100 },
    pauseOnBreach: { type: Boolean, default: true }
  },
  { _id: false }
);

const roboSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    isEnabled: { type: Boolean, default: false, index: true },
    controlGeneration: { type: Number, default: 0, min: 0 },
    mode: { type: String, enum: ['paper', 'shadow', 'live'], default: 'paper', index: true },
    liveTradingExplicitlyEnabled: { type: Boolean, default: false },
    allowedAssetClasses: {
      type: [String],
      enum: ['stocks', 'crypto', 'options'],
      default: ['stocks']
    },
    allowedSymbols: { type: [String], default: [] },
    blockedSymbols: { type: [String], default: [] },
    maxTradeAmount: { type: Number, default: 1000 },
    maxPositionSize: { type: Number, default: 5000 },
    maxDailyLoss: { type: Number, default: 500 },
    maxOpenPositions: { type: Number, default: 5 },
    maxTradesPerDay: { type: Number, default: 3 },
    allowShortSelling: { type: Boolean, default: false },
    allowFractionalShares: { type: Boolean, default: true },
    allowExtendedHours: { type: Boolean, default: false },
    allowOptionsTrading: { type: Boolean, default: false },
    allowCryptoTrading: { type: Boolean, default: false },
    riskLevel: { type: String, enum: ['conservative', 'balanced', 'aggressive'], default: 'balanced' },
    // Keep this absent on legacy documents so the settings mapper can migrate
    // requireManualApprovalAboveDollarAmount without a schema default masking it.
    approvalPolicy: { type: approvalPolicySchema, default: undefined },
    executionPolicy: { type: executionPolicySchema, default: () => ({}) },
    portfolioPolicy: { type: portfolioPolicySchema, default: () => ({}) },
    // Deprecated compatibility field. New code uses approvalPolicy.
    requireManualApprovalAboveDollarAmount: { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null },
    pausedReason: { type: String, default: null },
    dailyLimit: { type: Number, default: 0 },
    weeklyLimit: { type: Number, default: 0 },
    monthlyLimit: { type: Number, default: 0 },
    failureStreak: { type: Number, default: 0 },
    pausedUntil: { type: Date, default: null }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

roboSettingsSchema.pre('save', function syncEnabledFields(next) {
  if (this.isModified('enabled') && !this.isModified('isEnabled')) {
    this.isEnabled = this.enabled;
  } else if (this.isModified('isEnabled') && !this.isModified('enabled')) {
    this.enabled = this.isEnabled;
  }
  next();
});

module.exports = mongoose.model('RoboSettings', roboSettingsSchema);
