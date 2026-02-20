const mongoose = require('mongoose');

const roboUsageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bucketType: { type: String, enum: ['day', 'week', 'month'], required: true },
    bucketStart: { type: Date, required: true },
    spentNotional: { type: Number, default: 0 }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

roboUsageSchema.index({ userId: 1, bucketType: 1, bucketStart: 1 }, { unique: true });

module.exports = mongoose.model('RoboUsage', roboUsageSchema);
