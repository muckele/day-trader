const mongoose = require('mongoose');

const riskLimitConfigSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['global', 'strategy', 'user'], default: 'global', index: true },
    strategyId: { type: String, default: null, index: true },
    active: { type: Boolean, default: true, index: true },
    limits: {
      maxDailyRealizedLossPct: { type: Number, default: null },
      maxDailyTotalLossPct: { type: Number, default: null },
      maxWeeklyDrawdownPct: { type: Number, default: null },
      maxMonthlyDrawdownPct: { type: Number, default: null },
      maxConcurrentPositions: { type: Number, default: null },
      maxGrossExposurePct: { type: Number, default: null },
      maxNetExposurePct: { type: Number, default: null },
      maxLongExposurePct: { type: Number, default: null },
      maxShortExposurePct: { type: Number, default: null },
      maxPerPositionRiskPct: { type: Number, default: null },
      maxStrategyAllocationPct: { type: Number, default: null },
      maxLeveragedEtfExposurePct: { type: Number, default: null },
      maxInverseEtfExposurePct: { type: Number, default: null },
      maxCryptoExposurePct: { type: Number, default: null },
      maxOptionsPremiumRiskPct: { type: Number, default: null }
    },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

riskLimitConfigSchema.index({ scope: 1, strategyId: 1, active: 1, updatedAt: -1 });

module.exports = mongoose.model('RiskLimitConfig', riskLimitConfigSchema);
