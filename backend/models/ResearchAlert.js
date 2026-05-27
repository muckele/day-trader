const mongoose = require('mongoose');

const researchAlertSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    username: { type: String, default: null },
    symbol: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ['price_above', 'price_below', 'volume_spike', 'rsi_above', 'rsi_below', 'news_keyword', 'thesis_change'],
      required: true,
      index: true
    },
    threshold: { type: Number, default: null },
    keyword: { type: String, default: '' },
    message: { type: String, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    triggeredAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

researchAlertSchema.index({ accountId: 1, symbol: 1, isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('ResearchAlert', researchAlertSchema);
