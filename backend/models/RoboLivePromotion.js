const mongoose = require('mongoose');

const roboLivePromotionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  stage: { type: String, enum: ['repeat_canary'], default: 'repeat_canary', index: true },
  status: { type: String, enum: ['approved', 'consumed', 'revoked', 'expired'], required: true, index: true },
  assessmentFingerprint: { type: String, required: true, index: true },
  cohort: { type: mongoose.Schema.Types.Mixed, required: true },
  gates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  allowedSymbols: { type: [String], default: [] },
  strategyId: { type: String, required: true },
  policyVersion: { type: String, required: true },
  strategyEvidence: { type: mongoose.Schema.Types.Mixed, required: true },
  executionDiscrepancy: { type: mongoose.Schema.Types.Mixed, required: true },
  approvedAt: { type: Date, required: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  notes: { type: String, default: null }
}, { timestamps: true });

roboLivePromotionSchema.index({ userId: 1, createdAt: -1 });
roboLivePromotionSchema.index(
  { userId: 1, assessmentFingerprint: 1 },
  { unique: true }
);

module.exports = mongoose.model('RoboLivePromotion', roboLivePromotionSchema);
