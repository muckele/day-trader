const mongoose = require('mongoose');

const tradePlanLogSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    date: { type: String, default: null },
    marketStatus: { type: String, default: null },
    status: { type: String, enum: ['CREATED', 'BLOCKED', 'DUPLICATE', 'FAILED'], required: true },
    reason: { type: String, default: '' },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradePlan', default: null },
    attemptedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TradePlanLog', tradePlanLogSchema);
