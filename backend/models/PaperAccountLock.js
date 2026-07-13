const mongoose = require('mongoose');

const paperAccountLockSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaperAccountLock', paperAccountLockSchema);
