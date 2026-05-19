const mongoose = require('mongoose');

const paperSettingsSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', unique: true },
    startingCash: { type: Number, default: 100000 },
    slippageBps: { type: Number, default: 5 },
    commission: { type: Number, default: 0 },
    maxPositionPct: { type: Number, default: 5 },
    maxDailyLossPct: { type: Number, default: 2 },
    maxSymbolExposurePct: { type: Number, default: 10 },
    maxSectorExposurePct: { type: Number, default: 35 },
    maxCorrelationClusterPct: { type: Number, default: 45 },
    maxVarPct: { type: Number, default: 6 },
    varVolatilityPct: { type: Number, default: 2.5 },
    cryptoMaxPositionPct: { type: Number, default: 12 },
    cryptoMaxDailyLossPct: { type: Number, default: 3 },
    cryptoMinNotional: { type: Number, default: 5 },
    cryptoLotSize: { type: Number, default: 0.0001 },
    cryptoVarVolPct: { type: Number, default: 4 },
    shortMaintenanceMarginPct: { type: Number, default: 30 },
    shortMaxBorrowFeeApr: { type: Number, default: 35 },
    shortForceBuyInDays: { type: Number, default: 5 },
    cooldownHours: { type: Number, default: 4 },
    consecutiveLosses: { type: Number, default: 0 },
    cooldownUntil: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperSettings', paperSettingsSchema);
