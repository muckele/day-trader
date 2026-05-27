const mongoose = require('mongoose');

const researchSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    scope: {
      type: String,
      enum: ['dashboard', 'stock', 'compare'],
      required: true,
      index: true
    },
    symbols: { type: [String], default: [], index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    providerHealth: { type: [mongoose.Schema.Types.Mixed], default: [] },
    staleWarnings: { type: [String], default: [] },
    generatedAt: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

researchSnapshotSchema.index({ scope: 1, symbols: 1, expiresAt: 1 });

module.exports = mongoose.model('ResearchSnapshot', researchSnapshotSchema);
