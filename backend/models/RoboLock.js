const mongoose = require('mongoose');

const roboLockSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

module.exports = mongoose.model('RoboLock', roboLockSchema);
