const mongoose = require('mongoose');

const paperEquitySchema = new mongoose.Schema(
  {
    accountId: { type: String, default: 'default', index: true },
    timestamp: { type: Date, default: Date.now },
    equity: { type: Number, required: true },
    cash: { type: Number, required: true },
    positionsValue: { type: Number, required: true },
    dailyPnl: { type: Number, required: true },
    totalPnl: { type: Number, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperEquity', paperEquitySchema);
