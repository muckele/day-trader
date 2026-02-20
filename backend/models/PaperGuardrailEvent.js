const mongoose = require('mongoose');

const paperGuardrailEventSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    symbol: { type: String, default: null },
    orderNotional: { type: Number, default: null },
    reason: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperGuardrailEvent', paperGuardrailEventSchema);
