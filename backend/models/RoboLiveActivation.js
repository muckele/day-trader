const mongoose = require('mongoose');

const roboLiveActivationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  canaryId: { type: String, default: null, index: true },
  promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboLivePromotion', default: null, index: true },
  status: { type: String, enum: ['approved', 'active', 'revoked', 'expired'], required: true, index: true },
  readinessFingerprint: { type: String, required: true },
  limits: { type: mongoose.Schema.Types.Mixed, required: true },
  allowedSymbols: { type: [String], required: true },
  approvedAt: { type: Date, required: true },
  approvalExpiresAt: { type: Date, required: true, index: true },
  activatedAt: { type: Date, default: null },
  activationExpiresAt: { type: Date, default: null, index: true },
  revokedAt: { type: Date, default: null },
  attemptsUsed: { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: null },
  liveOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboTradeOrder', default: null },
  lifecycleStatus: {
    type: String,
    enum: ['armed', 'attempt_claimed', 'broker_pending', 'filled', 'reconciled', 'failed', 'reviewed'],
    default: 'armed',
    index: true
  },
  outcome: { type: mongoose.Schema.Types.Mixed, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, default: null },
  supervisionHeartbeatAt: { type: Date, default: null },
  supervisionDeadlineAt: { type: Date, default: null, index: true },
  supervisorSessionId: { type: String, default: null },
  dossierHash: { type: String, default: null },
  dossierSealedAt: { type: Date, default: null },
  dossierSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  notes: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.model('RoboLiveActivation', roboLiveActivationSchema);
