const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true },
  accountId: { type: String, required: true },
  environment: { type: String, enum: ['paper'], required: true },
  subject: { type: String, required: true },
  text: { type: String, required: true },
  state: { type: String, enum: ['pending', 'sending', 'retryable', 'provider_accepted', 'failed'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseOwner: String,
  leaseUntil: Date,
  lastError: String,
  providerMessageId: String,
  providerAcceptedAt: Date
}, { timestamps: true });
schema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = mongoose.model('NotificationOutbox', schema);
