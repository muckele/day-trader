const mongoose = require('mongoose');

const regimeSnapshotSchema = new mongoose.Schema(
  {
    date: { type: String, unique: true },
    trendChop: { type: String, required: true },
    vol: { type: String, required: true },
    risk: { type: String, required: true },
    notes: { type: [String], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RegimeSnapshot', regimeSnapshotSchema);
