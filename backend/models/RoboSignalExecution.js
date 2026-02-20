const mongoose = require('mongoose');

const roboSignalExecutionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    signalId: { type: String, required: true },
    status: { type: String, enum: ['processing', 'executed', 'skipped', 'failed'], required: true },
    symbol: { type: String, default: null },
    side: { type: String, default: null },
    qty: { type: Number, default: null },
    strategyId: { type: String, default: null },
    strategyName: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    executedAt: { type: Date, default: null },
    orderId: { type: String, default: null },
    notional: { type: Number, default: null },
    reason: { type: String, default: null }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

roboSignalExecutionSchema.index({ userId: 1, signalId: 1 }, { unique: true });
roboSignalExecutionSchema.index({ userId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('RoboSignalExecution', roboSignalExecutionSchema);
