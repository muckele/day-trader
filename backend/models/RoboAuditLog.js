const mongoose = require('mongoose');

const roboAuditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    eventType: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false }
  }
);

roboAuditLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('RoboAuditLog', roboAuditLogSchema);
