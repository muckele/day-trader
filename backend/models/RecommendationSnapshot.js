const mongoose = require('mongoose');

const recommendationIdeaSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    assetClass: { type: String, default: 'equity' },
    bias: { type: String, default: 'LONG' },
    confidenceScore: { type: Number, default: 0 },
    strategyBucket: { type: String, default: null },
    paperEligible: { type: Boolean, default: true },
    liveEligible: { type: Boolean, default: false },
    thesisTags: { type: [String], default: [] },
    whyItRankedHighly: { type: [String], default: [] },
    disqualifyingRisks: { type: [String], default: [] },
    preferredEntryType: { type: String, default: null },
    suggestedStopFramework: { type: String, default: null },
    suggestedTakeProfitFramework: { type: String, default: null },
    suggestedHoldingPeriod: { type: String, default: null },
    factors: { type: mongoose.Schema.Types.Mixed, default: {} },
    qualityGate: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { _id: false }
);

const recommendationSnapshotSchema = new mongoose.Schema(
  {
    snapshotKey: { type: String, required: true, unique: true, index: true },
    asOf: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true },
    engineVersion: { type: String, required: true },
    benchmarkSymbol: { type: String, default: 'SPY' },
    universe: { type: [String], default: [] },
    regime: { type: mongoose.Schema.Types.Mixed, default: null },
    regimeKey: { type: String, default: null, index: true },
    warnings: { type: [String], default: [] },
    topIdeas: { type: [recommendationIdeaSchema], default: [] },
    lists: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

recommendationSnapshotSchema.index({ createdAt: -1 });
recommendationSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RecommendationSnapshot', recommendationSnapshotSchema);
