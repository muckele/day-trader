const mongoose = require('mongoose');

const roboCanaryDossierSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  canaryId: { type: String, required: true, unique: true, index: true },
  activationId: { type: mongoose.Schema.Types.ObjectId, ref: 'RoboLiveActivation', required: true, index: true },
  dossierHash: { type: String, required: true, index: true },
  dossierSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  sealedAt: { type: Date, required: true, index: true }
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

roboCanaryDossierSchema.index({ userId: 1, sealedAt: -1 });

module.exports = mongoose.model('RoboCanaryDossier', roboCanaryDossierSchema);
