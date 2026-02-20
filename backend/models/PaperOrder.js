const mongoose = require('mongoose');

const paperOrderSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    qty: { type: Number, required: true },
    orderType: { type: String, default: 'market' },
    limitPrice: { type: Number, default: null },
    maxPricePerShare: { type: Number, default: null },
    allowExtendedHours: { type: Boolean, default: true },
    extendedHours: { type: Boolean, default: false },
    marketSession: { type: String, enum: ['regular', 'extended'], default: 'regular' },
    strategyId: { type: String, default: null },
    setupType: { type: String, default: null },
    strategyTags: { type: [String], default: [] },
    stopPrice: { type: Number, default: null },
    status: { type: String, default: 'filled' },
    fillPrice: { type: Number, required: true },
    commission: { type: Number, default: 0 },
    slippageBps: { type: Number, default: 0 },
    notional: { type: Number, required: true },
    filledAt: { type: Date, default: Date.now },
    rejectedReason: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperOrder', paperOrderSchema);
