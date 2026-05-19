const mongoose = require('mongoose');

const featureFlagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    scope: { type: String, enum: ['global', 'user', 'strategy'], default: 'global' },
    strategyId: { type: String, default: null },
    notes: { type: String, default: '' },
    updatedBy: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeatureFlag', featureFlagSchema);
