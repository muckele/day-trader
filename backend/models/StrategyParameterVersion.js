const mongoose = require('mongoose');

const strategyParameterVersionSchema = new mongoose.Schema(
  {
    strategyId: { type: String, required: true, index: true },
    accountId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    parameterHash: { type: String, required: true, index: true },
    source: { type: String, enum: ['backtest', 'robo', 'manual', 'system'], default: 'system' },
    parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

strategyParameterVersionSchema.index({ accountId: 1, strategyId: 1, version: 1 }, { unique: true });
strategyParameterVersionSchema.index({ accountId: 1, strategyId: 1, parameterHash: 1 }, { unique: true });

module.exports = mongoose.model('StrategyParameterVersion', strategyParameterVersionSchema);
