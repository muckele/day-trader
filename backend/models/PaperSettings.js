const mongoose = require('mongoose');

const paperSettingsSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', unique: true },
    startingCash: { type: Number, default: 100000 },
    slippageBps: { type: Number, default: 5 },
    commission: { type: Number, default: 0 },
    maxPositionPct: { type: Number, default: 5 },
    maxDailyLossPct: { type: Number, default: 2 },
    cooldownHours: { type: Number, default: 4 },
    consecutiveLosses: { type: Number, default: 0 },
    cooldownUntil: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperSettings', paperSettingsSchema);
