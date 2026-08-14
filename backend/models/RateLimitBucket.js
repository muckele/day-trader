const mongoose = require('mongoose');

const rateLimitBucketSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  resetAt: { type: Date, required: true }
}, { timestamps: true });

rateLimitBucketSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimitBucket', rateLimitBucketSchema);
