const mongoose = require('mongoose');

const paperJournalEntrySchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    tradeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    username: { type: String, default: null },
    thesis: { type: String, default: '' },
    plan: { type: String, default: '' },
    emotions: { type: String, default: '' },
    postTradeNotes: { type: String, default: '' },
    rating: { type: Number, default: null },
    tags: { type: [String], default: [] }
  },
  { timestamps: true }
);

paperJournalEntrySchema.index({ accountId: 1, tradeId: 1 }, { unique: true });

module.exports = mongoose.model('PaperJournalEntry', paperJournalEntrySchema);
