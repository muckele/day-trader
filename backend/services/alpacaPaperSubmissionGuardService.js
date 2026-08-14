const PaperAccountLock = require('../models/PaperAccountLock');
const PaperOrder = require('../models/PaperOrder');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const OrderIntent = require('../models/OrderIntent');
const { SUBMISSION_STATES } = require('./submissionOutcomeService');

const ALPACA_PAPER_SUBMISSION_LOCK_MS = 10 * 60 * 1000;
const UNRESOLVED_SUBMISSION_STATES = [
  SUBMISSION_STATES.PENDING,
  SUBMISSION_STATES.UNKNOWN
];
const LEGACY_UNRESOLVED_BROKER_STATUSES = [
  'pending_submit',
  'submit_unknown'
];
const UNRESOLVED_INTENT_STATUSES = [
  'submitting',
  'submission_uncertain'
];

function normalizeSubmissionAccountId(accountId = 'default') {
  const normalized = String(accountId || '').trim();
  return normalized || 'default';
}

async function resolveFindOne(model, filter, {
  select = null,
  sort = { createdAt: 1 }
} = {}) {
  if (typeof model?.findOne !== 'function') return null;
  let query = model.findOne(filter);
  if (select && typeof query?.select === 'function') query = query.select(select);
  if (sort && typeof query?.sort === 'function') query = query.sort(sort);
  if (typeof query?.lean === 'function') query = query.lean();
  return query;
}

function buildPaperUnresolvedQuery(accountId, excludePaperOrderId = null) {
  return {
    accountId: normalizeSubmissionAccountId(accountId),
    broker: 'alpaca',
    ...(excludePaperOrderId ? { _id: { $ne: excludePaperOrderId } } : {}),
    $or: [
      { submissionState: { $in: UNRESOLVED_SUBMISSION_STATES } },
      {
        status: 'open',
        brokerOrderStatus: { $in: LEGACY_UNRESOLVED_BROKER_STATUSES }
      }
    ]
  };
}

function buildRoboUnresolvedQuery(accountId, excludeRoboOrderId = null) {
  return {
    accountId: normalizeSubmissionAccountId(accountId),
    broker: 'alpaca',
    environment: 'paper',
    ...(excludeRoboOrderId ? { _id: { $ne: excludeRoboOrderId } } : {}),
    $or: [
      { submissionState: SUBMISSION_STATES.PENDING },
      { submissionState: SUBMISSION_STATES.UNKNOWN },
      { submissionState: { $exists: false }, status: 'pending_submit' },
      { submissionState: null, status: 'pending_submit' }
    ]
  };
}

function buildIntentUnresolvedQuery(accountId, excludeIntentId = null) {
  return {
    accountId: normalizeSubmissionAccountId(accountId),
    broker: 'alpaca',
    environment: 'paper',
    ...(excludeIntentId ? { _id: { $ne: excludeIntentId } } : {}),
    status: { $in: UNRESOLVED_INTENT_STATUSES }
  };
}

async function findUnresolvedAlpacaPaperSubmission({
  accountId = 'default',
  excludePaperOrderId = null,
  excludeRoboOrderId = null,
  excludeIntentId = null
} = {}, {
  PaperOrderModel = PaperOrder,
  RoboTradeOrderModel = RoboTradeOrder,
  OrderIntentModel = OrderIntent
} = {}) {
  const paperOrder = await resolveFindOne(
    PaperOrderModel,
    buildPaperUnresolvedQuery(accountId, excludePaperOrderId),
    {
      select: '_id accountId externalOrderId clientOrderId brokerOrderStatus submissionState status',
      sort: { createdAt: 1 }
    }
  );
  if (paperOrder) return { source: 'paper', order: paperOrder };

  const roboOrder = await resolveFindOne(
    RoboTradeOrderModel,
    buildRoboUnresolvedQuery(accountId, excludeRoboOrderId),
    {
      select: '_id accountId externalOrderId clientOrderId reconciliationStatus submissionState status',
      sort: { createdAt: 1 }
    }
  );
  if (roboOrder) return { source: 'robotrader', order: roboOrder };

  // The explicit-submit route atomically marks its frozen intent as
  // `submitting` before a durable RoboTradeOrder identity is created. If the
  // process dies in that narrow interval, this intent is the durable account
  // freeze that prevents a replacement order from being minted after restart.
  const intent = await resolveFindOne(
    OrderIntentModel,
    buildIntentUnresolvedQuery(accountId, excludeIntentId),
    {
      select: '_id accountId submissionIdempotencyKey orderFingerprint status',
      sort: { createdAt: 1 }
    }
  );
  return intent ? { source: 'intent', order: intent } : null;
}

async function acquireAlpacaPaperSubmissionLock(
  accountId,
  owner,
  now = new Date(),
  { PaperAccountLockModel = PaperAccountLock } = {}
) {
  const scopedAccountId = normalizeSubmissionAccountId(accountId);
  try {
    return await PaperAccountLockModel.findOneAndUpdate(
      {
        accountId: scopedAccountId,
        $or: [
          { lockedUntil: { $lte: now } },
          { owner }
        ]
      },
      {
        $set: {
          owner,
          lockedUntil: new Date(now.getTime() + ALPACA_PAPER_SUBMISSION_LOCK_MS)
        }
      },
      { new: true, upsert: true, runValidators: true }
    );
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

async function releaseAlpacaPaperSubmissionLock(
  accountId,
  owner,
  { PaperAccountLockModel = PaperAccountLock } = {}
) {
  return PaperAccountLockModel.updateOne(
    {
      accountId: normalizeSubmissionAccountId(accountId),
      owner
    },
    { $set: { lockedUntil: new Date(0) } }
  );
}

async function renewAlpacaPaperSubmissionLock(
  accountId,
  owner,
  now = new Date(),
  { PaperAccountLockModel = PaperAccountLock } = {}
) {
  const result = await PaperAccountLockModel.updateOne(
    {
      accountId: normalizeSubmissionAccountId(accountId),
      owner,
      lockedUntil: { $gt: now }
    },
    {
      $set: {
        lockedUntil: new Date(now.getTime() + ALPACA_PAPER_SUBMISSION_LOCK_MS)
      }
    }
  );
  return Number(result?.matchedCount ?? result?.n ?? 0) === 1;
}

module.exports = {
  ALPACA_PAPER_SUBMISSION_LOCK_MS,
  LEGACY_UNRESOLVED_BROKER_STATUSES,
  UNRESOLVED_INTENT_STATUSES,
  UNRESOLVED_SUBMISSION_STATES,
  acquireAlpacaPaperSubmissionLock,
  buildPaperUnresolvedQuery,
  buildRoboUnresolvedQuery,
  buildIntentUnresolvedQuery,
  findUnresolvedAlpacaPaperSubmission,
  normalizeSubmissionAccountId,
  releaseAlpacaPaperSubmissionLock,
  renewAlpacaPaperSubmissionLock
};
