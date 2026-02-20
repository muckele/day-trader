const mongoose = require('mongoose');

const tradeIdeaSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    strategyId: { type: String, required: true },
    bias: { type: String, required: true },
    entry: { type: Number, required: true },
    stop: { type: Number, required: true },
    target: { type: Number, required: true },
    positionSizePct: { type: Number, required: true },
    signalScore: { type: Number, default: null },
    confidenceScore: { type: Number, required: true },
    alignmentScore: { type: Number, required: true },
    reason: { type: String, default: '' },
    status: { type: String, enum: ['PENDING', 'EXECUTED', 'SKIPPED'], default: 'PENDING' },
    executedTradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaperTrade', default: null },
    executedAt: { type: Date, default: null },
    skippedAt: { type: Date, default: null }
  },
  { _id: true }
);

const tradePlanSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    date: { type: String, required: true, index: true },
    marketStatus: { type: String, default: 'OPEN' },
    regime: {
      date: { type: String, default: null },
      trendChop: { type: String, default: null },
      vol: { type: String, default: null },
      risk: { type: String, default: null },
      notes: { type: [String], default: [] }
    },
    rankedStrategies: {
      type: [
        {
          strategyId: { type: String, required: true },
          score: { type: Number, default: 0 },
          expectancy: { type: Number, default: null },
          winRate: { type: Number, default: 0 },
          alignmentScore: { type: Number, default: 0 },
          tradeCount: { type: Number, default: 0 },
          sampleAdjusted: { type: Boolean, default: false }
        }
      ],
      default: []
    },
    tradeIdeas: { type: [tradeIdeaSchema], default: [] },
    totalSuggestedExposurePct: { type: Number, default: 0 },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

tradePlanSchema.index({ accountId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('TradePlan', tradePlanSchema);
