const mongoose = require('mongoose');

const researchEventSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, index: true },
    source: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ['earnings', 'analyst_rating', 'sec_filing', 'dividend', 'split', 'insider_activity'],
      required: true,
      index: true
    },
    eventDate: { type: Date, default: null, index: true },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    url: { type: String, default: null },
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative'], default: 'neutral', index: true },
    numericValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

researchEventSchema.index(
  { source: 1, externalId: 1, type: 1, symbol: 1 },
  { unique: true }
);
researchEventSchema.index({ symbol: 1, type: 1, eventDate: -1 });

module.exports = mongoose.model('ResearchEvent', researchEventSchema);
