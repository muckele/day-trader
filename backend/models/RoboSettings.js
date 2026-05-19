const mongoose = require('mongoose');

const roboSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    isEnabled: { type: Boolean, default: false, index: true },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper', index: true },
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
