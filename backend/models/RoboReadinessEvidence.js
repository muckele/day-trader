const mongoose = require('mongoose');

const roboReadinessEvidenceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  key: { type: String, required: true, index: true },
  status: { type: String, enum: ['complete', 'revoked'], default: 'complete', index: true },
  notes: { type: String, default: null },
  recordedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true }
}, { timestamps: true });

roboReadinessEvidenceSchema.index({ userId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('RoboReadinessEvidence', roboReadinessEvidenceSchema);
