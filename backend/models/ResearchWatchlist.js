const mongoose = require('mongoose');

const researchWatchlistSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    username: { type: String, default: null },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    symbols: { type: [String], default: [], index: true },
    pinnedSymbols: { type: [String], default: [] },
    isDefault: { type: Boolean, default: false, index: true },
    summarySnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    summaryGeneratedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

researchWatchlistSchema.index({ accountId: 1, updatedAt: -1 });
researchWatchlistSchema.index({ accountId: 1, name: 1 });
researchWatchlistSchema.index(
  { accountId: 1, isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true },
    name: 'one_default_research_watchlist_per_account'
  }
);

module.exports = mongoose.model('ResearchWatchlist', researchWatchlistSchema);
