const OrderIntent = require('../models/OrderIntent');
const TradeAuthorization = require('../models/TradeAuthorization');
const {
  POLICY_VERSION,
  normalizeApprovalPolicy
} = require('./canonicalTradingPolicyService');

const SPECIFIC_ORDER_CONFIRMATION_TEXT = 'I authorize this specific live order.';

function buildAuthorizationExpiry(now, ttlSeconds) {
  const policy = normalizeApprovalPolicy({ authorizationTtlSeconds: ttlSeconds });
  return new Date(now.getTime() + policy.authorizationTtlSeconds * 1000);
}

async function createTradeAuthorization({
  userId,
  accountId,
  intent,
  confirmation,
  approvalPolicy,
  now = new Date(),
  TradeAuthorizationModel = TradeAuthorization
} = {}) {
  if (confirmation !== SPECIFIC_ORDER_CONFIRMATION_TEXT) {
    const err = new Error('Exact specific-order authorization confirmation is required.');
    err.status = 400;
    err.code = 'SPECIFIC_ORDER_CONFIRMATION_REQUIRED';
    throw err;
  }
  if (!intent || intent.environment !== 'live') {
    const err = new Error('Only a live trade intent can be authorized.');
    err.status = 400;
    err.code = 'LIVE_INTENT_REQUIRED';
    throw err;
  }
  if (!intent.orderFingerprint) {
    const err = new Error('Trade intent is missing its immutable order fingerprint.');
    err.status = 409;
    err.code = 'ORDER_FINGERPRINT_MISSING';
    throw err;
  }
  if (intent.policyVersion !== POLICY_VERSION) {
    const err = new Error('The trade intent was evaluated under a different policy version and must be regenerated.');
    err.status = 409;
    err.code = 'AUTHORIZATION_POLICY_VERSION_MISMATCH';
    throw err;
  }
  if (!['awaiting_authorization', 'policy_approved', 'authorized'].includes(intent.status)) {
    const err = new Error(`Trade intent cannot be authorized from status ${intent.status}.`);
    err.status = 409;
    err.code = 'INTENT_NOT_AUTHORIZABLE';
    throw err;
  }

  const policy = normalizeApprovalPolicy(approvalPolicy || intent.approvalPolicy);
  const expiresAt = buildAuthorizationExpiry(now, policy.authorizationTtlSeconds);
  await TradeAuthorizationModel.updateMany(
    {
      userId,
      accountId,
      intentId: intent._id,
      orderFingerprint: intent.orderFingerprint,
      policyVersion: intent.policyVersion || POLICY_VERSION,
      status: 'active',
      expiresAt: { $lte: now }
    },
    { $set: { status: 'expired' } }
  );
  const existing = await TradeAuthorizationModel.findOne({
    userId,
    accountId,
    intentId: intent._id,
    orderFingerprint: intent.orderFingerprint,
    policyVersion: intent.policyVersion || POLICY_VERSION,
    status: 'active',
    expiresAt: { $gt: now }
  });
  if (existing) return existing;

  try {
    return await TradeAuthorizationModel.create({
      userId,
      accountId,
      intentId: intent._id,
      orderFingerprint: intent.orderFingerprint,
      policyVersion: intent.policyVersion || POLICY_VERSION,
      status: 'active',
      authorizedAt: now,
      expiresAt
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const raced = await TradeAuthorizationModel.findOne({
      userId,
      accountId,
      intentId: intent._id,
      orderFingerprint: intent.orderFingerprint,
      policyVersion: intent.policyVersion || POLICY_VERSION,
      status: 'active',
      expiresAt: { $gt: now }
    });
    if (raced) return raced;
    throw err;
  }
}

async function findActiveTradeAuthorization({
  userId,
  accountId,
  intentId,
  orderFingerprint,
  policyVersion = POLICY_VERSION,
  now = new Date(),
  TradeAuthorizationModel = TradeAuthorization
} = {}) {
  if (!intentId || !orderFingerprint || policyVersion !== POLICY_VERSION) return null;
  return TradeAuthorizationModel.findOne({
    userId,
    accountId,
    intentId,
    orderFingerprint,
    policyVersion,
    status: 'active',
    expiresAt: { $gt: now }
  }).sort({ authorizedAt: -1 });
}

async function claimTradeAuthorization({
  authorizationId,
  userId,
  accountId,
  intentId,
  orderFingerprint,
  policyVersion = POLICY_VERSION,
  runId,
  now = new Date(),
  TradeAuthorizationModel = TradeAuthorization
} = {}) {
  if (!authorizationId || !intentId || !orderFingerprint || policyVersion !== POLICY_VERSION) return null;
  return TradeAuthorizationModel.findOneAndUpdate(
    {
      _id: authorizationId,
      userId,
      accountId,
      intentId,
      orderFingerprint,
      policyVersion,
      status: 'active',
      expiresAt: { $gt: now }
    },
    {
      $set: {
        status: 'consumed',
        consumedAt: now,
        consumedByRunId: runId || null
      }
    },
    { new: true }
  );
}

async function expireStaleTradeAuthorizations({
  userId = null,
  accountId = null,
  now = new Date(),
  TradeAuthorizationModel = TradeAuthorization,
  OrderIntentModel = OrderIntent
} = {}) {
  const query = {
    status: 'active',
    expiresAt: { $lte: now }
  };
  if (userId) query.userId = userId;
  if (accountId) query.accountId = accountId;
  const stale = await TradeAuthorizationModel.find(query).select('_id intentId').lean();
  if (!stale.length) return { expiredCount: 0 };
  const ids = stale.map(item => item._id);
  const intentIds = stale.map(item => item.intentId).filter(Boolean);
  const result = await TradeAuthorizationModel.updateMany(
    { _id: { $in: ids }, status: 'active' },
    { $set: { status: 'expired' } }
  );
  if (intentIds.length && OrderIntentModel?.updateMany) {
    await OrderIntentModel.updateMany(
      { _id: { $in: intentIds }, status: 'authorized' },
      { $set: { status: 'awaiting_authorization', authorizationStatus: 'expired' } }
    );
  }
  return { expiredCount: Number(result?.modifiedCount || 0) };
}

async function revokeTradeAuthorization({
  userId,
  accountId,
  intentId,
  now = new Date(),
  TradeAuthorizationModel = TradeAuthorization,
  OrderIntentModel = OrderIntent
} = {}) {
  if (!userId || !accountId || !intentId) return null;
  const authorization = await TradeAuthorizationModel.findOneAndUpdate(
    {
      userId,
      accountId,
      intentId,
      status: 'active'
    },
    {
      $set: {
        status: 'revoked',
        revokedAt: now
      }
    },
    { new: true }
  );
  if (authorization && OrderIntentModel?.updateOne) {
    await OrderIntentModel.updateOne(
      { _id: intentId, userId, accountId, status: 'authorized' },
      {
        $set: {
          status: 'awaiting_authorization',
          authorizationStatus: 'revoked',
          rejectionReason: 'Trade authorization was revoked by the user.'
        }
      }
    );
  }
  return authorization;
}

module.exports = {
  SPECIFIC_ORDER_CONFIRMATION_TEXT,
  buildAuthorizationExpiry,
  claimTradeAuthorization,
  createTradeAuthorization,
  expireStaleTradeAuthorizations,
  findActiveTradeAuthorization,
  revokeTradeAuthorization
};
