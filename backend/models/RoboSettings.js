const mongoose = require('mongoose');

const roboSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    dailyLimit: { type: Number, default: 0 },
    weeklyLimit: { type: Number, default: 0 },
    monthlyLimit: { type: Number, default: 0 }
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
  }
);

module.exports = mongoose.model('RoboSettings', roboSettingsSchema);
