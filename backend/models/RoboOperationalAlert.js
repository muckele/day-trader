const mongoose = require('mongoose');

const roboOperationalAlertSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  environment: { type: String, enum: ['paper', 'shadow', 'live'], default: 'paper', index: true },
  eventType: { type: String, required: true, index: true },
  category: { type: String, required: true, index: true },
  severity: { type: String, enum: ['warning', 'critical'], required: true, index: true },
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },
  active: { type: Boolean, default: true, index: true },
  fingerprint: { type: String, required: true, index: true },
  message: { type: String, required: true },
  occurrences: { type: Number, default: 1, min: 1 },
  firstOccurredAt: { type: Date, default: Date.now },
  lastOccurredAt: { type: Date, default: Date.now, index: true },
  acknowledgedAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

roboOperationalAlertSchema.index({ userId: 1, status: 1, severity: 1, lastOccurredAt: -1 });
roboOperationalAlertSchema.index(
  { userId: 1, fingerprint: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

module.exports = mongoose.model('RoboOperationalAlert', roboOperationalAlertSchema);
