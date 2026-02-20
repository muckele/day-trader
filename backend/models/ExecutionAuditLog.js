const mongoose = require('mongoose');

const executionAuditLogSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradePlan', default: null },
    ideaId: { type: mongoose.Schema.Types.ObjectId, default: null },
    strategyId: { type: String, default: null },
    eligible: { type: Boolean, default: false },
    reasonsBlocked: { type: [String], default: [] },
    accountSnapshot: {
      equity: { type: Number, default: null },
      positionsValue: { type: Number, default: null },
      dailyPnl: { type: Number, default: null },
      dailyDrawdown: { type: Number, default: null },
      exposurePct: { type: Number, default: null },
      consecutiveLosses: { type: Number, default: null }
    },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExecutionAuditLog', executionAuditLogSchema);
