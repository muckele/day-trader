const mongoose = require('mongoose');

const researchNewsSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, index: true },
    source: { type: String, default: 'alpaca', index: true },
    symbols: { type: [String], default: [], index: true },
    headline: { type: String, required: true },
    summary: { type: String, default: '' },
    url: { type: String, default: null },
    author: { type: String, default: null },
    images: { type: [mongoose.Schema.Types.Mixed], default: [] },
    category: { type: String, default: 'general', index: true },
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative'], default: 'neutral', index: true },
    sentimentScore: { type: Number, default: 0 },
    whyItMatters: { type: String, default: '' },
    publishedAt: { type: Date, default: null, index: true },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

researchNewsSchema.index(
  { source: 1, externalId: 1 },
  { unique: true }
);
researchNewsSchema.index({ symbols: 1, publishedAt: -1 });

module.exports = mongoose.model('ResearchNews', researchNewsSchema);
