const mongoose = require('mongoose');

const tradeAuthorizationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: String, required: true, index: true },
    intentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderIntent', required: true, index: true },
    orderFingerprint: { type: String, required: true, immutable: true, index: true },
    policyVersion: { type: String, required: true, immutable: true },
    status: {
      type: String,
      enum: ['active', 'consumed', 'revoked', 'expired'],
      default: 'active',
      index: true
    },
    authorizedAt: { type: Date, default: Date.now, immutable: true },
    expiresAt: { type: Date, required: true, index: true, immutable: true },
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    consumedByRunId: { type: String, default: null },
    confirmationVersion: { type: String, default: 'specific-order-v1', immutable: true }
  },
  { timestamps: true }
);

tradeAuthorizationSchema.index({
  userId: 1,
  accountId: 1,
  orderFingerprint: 1,
  status: 1,
  expiresAt: 1
});
tradeAuthorizationSchema.index(
  { intentId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' }
  }
);

module.exports = mongoose.model('TradeAuthorization', tradeAuthorizationSchema);
