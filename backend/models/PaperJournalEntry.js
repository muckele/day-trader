const mongoose = require('mongoose');

const paperJournalEntrySchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    tradeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    username: { type: String, default: null },
    thesis: { type: String, default: '', maxlength: 5000 },
    plan: { type: String, default: '', maxlength: 5000 },
    emotions: { type: String, default: '', maxlength: 500 },
    postTradeNotes: { type: String, default: '', maxlength: 5000 },
    rating: { type: Number, default: null, min: 1, max: 5 },
    tags: {
      type: [{ type: String, maxlength: 40 }],
      default: [],
      validate: {
        validator: value => Array.isArray(value) && value.length <= 12,
        message: 'A journal entry can have at most 12 tags.'
      }
    }
  },
  { timestamps: true }
);

paperJournalEntrySchema.index({ accountId: 1, tradeId: 1 }, { unique: true });

module.exports = mongoose.model('PaperJournalEntry', paperJournalEntrySchema);
