const mongoose = require('mongoose');

const researchNoteSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    username: { type: String, default: null },
    symbol: { type: String, required: true, index: true },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    stance: { type: String, enum: ['bullish', 'neutral', 'bearish'], default: 'neutral', index: true },
    pinned: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

researchNoteSchema.index({ accountId: 1, symbol: 1, updatedAt: -1 });

module.exports = mongoose.model('ResearchNote', researchNoteSchema);
