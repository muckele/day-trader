const mongoose = require('mongoose');

const strategyRunSchema = new mongoose.Schema(
  {
    strategyId: { type: String, required: true, index: true },
    strategyName: { type: String, default: null },
    runType: { type: String, enum: ['backtest', 'robo', 'scheduler'], required: true, index: true },
    mode: { type: String, enum: ['paper', 'live', 'simulation'], default: 'paper' },
    status: { type: String, enum: ['running', 'completed', 'skipped', 'failed'], default: 'running', index: true },
    symbol: { type: String, default: null },
    universe: { type: [String], default: [] },
    parameterVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategyParameterVersion', default: null },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, default: {} },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: null }
  },
  { timestamps: true }
);

strategyRunSchema.index({ strategyId: 1, startedAt: -1 });
strategyRunSchema.index({ runType: 1, status: 1, startedAt: -1 });

module.exports = mongoose.model('StrategyRun', strategyRunSchema);
