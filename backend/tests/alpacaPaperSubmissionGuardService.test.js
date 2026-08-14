const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireAlpacaPaperSubmissionLock,
  buildIntentUnresolvedQuery,
  buildPaperUnresolvedQuery,
  buildRoboUnresolvedQuery,
  findUnresolvedAlpacaPaperSubmission,
  releaseAlpacaPaperSubmissionLock,
  renewAlpacaPaperSubmissionLock
} = require('../services/alpacaPaperSubmissionGuardService');
const { SUBMISSION_STATES } = require('../services/submissionOutcomeService');

function createInMemoryLockModel() {
  let row = null;
  return {
    get row() {
      return row;
    },
    async findOneAndUpdate(filter, update) {
      const now = filter.$or[0].lockedUntil.$lte;
      const mayAcquire = !row
        || row.lockedUntil <= now
        || row.owner === filter.$or[1].owner;
      if (!mayAcquire) {
        const duplicate = new Error('duplicate account lock');
        duplicate.code = 11000;
        throw duplicate;
      }
      row = {
        accountId: filter.accountId,
        owner: update.$set.owner,
        lockedUntil: update.$set.lockedUntil
      };
      return { ...row };
    },
    async updateOne(filter, update) {
      if (!row || row.accountId !== filter.accountId || row.owner !== filter.owner) {
        return { matchedCount: 0 };
      }
      if (filter.lockedUntil?.$gt && !(row.lockedUntil > filter.lockedUntil.$gt)) {
        return { matchedCount: 0 };
      }
      row = { ...row, ...update.$set };
      return { matchedCount: 1 };
    }
  };
}

test('shared unresolved guard checks PaperOrder and RoboTradeOrder for one Alpaca-paper account', async () => {
  const seen = [];
  const roboUnknown = {
    _id: 'robo-unknown',
    broker: 'alpaca',
    environment: 'paper',
    submissionState: SUBMISSION_STATES.UNKNOWN
  };
  const result = await findUnresolvedAlpacaPaperSubmission({
    accountId: 'user:alice'
  }, {
    PaperOrderModel: {
      findOne: async query => {
        seen.push({ source: 'paper', query });
        return null;
      }
    },
    RoboTradeOrderModel: {
      findOne: async query => {
        seen.push({ source: 'robotrader', query });
        return roboUnknown;
      }
    },
    OrderIntentModel: {
      findOne: async query => {
        seen.push({ source: 'intent', query });
        return null;
      }
    }
  });

  assert.equal(result.source, 'robotrader');
  assert.equal(result.order, roboUnknown);
  assert.equal(seen[0].query.accountId, 'user:alice');
  assert.equal(seen[0].query.broker, 'alpaca');
  assert.equal(seen[1].query.accountId, 'user:alice');
  assert.equal(seen[1].query.broker, 'alpaca');
  assert.equal(seen[1].query.environment, 'paper');
});

test('a submitting frozen intent survives as the account freeze before an order identity exists', async () => {
  const orphanIntent = {
    _id: 'intent-before-order',
    accountId: 'user:alice',
    broker: 'alpaca',
    environment: 'paper',
    status: 'submitting',
    submissionIdempotencyKey: 'submit-once'
  };
  let intentQuery = null;
  const result = await findUnresolvedAlpacaPaperSubmission({
    accountId: 'user:alice'
  }, {
    PaperOrderModel: { findOne: async () => null },
    RoboTradeOrderModel: { findOne: async () => null },
    OrderIntentModel: {
      findOne: async query => {
        intentQuery = query;
        return orphanIntent;
      }
    }
  });

  assert.equal(result.source, 'intent');
  assert.equal(result.order, orphanIntent);
  assert.deepEqual(
    intentQuery.status.$in,
    ['submitting', 'submission_uncertain']
  );
  assert.equal(intentQuery.accountId, 'user:alice');
  assert.equal(intentQuery.environment, 'paper');
  assert.deepEqual(
    buildIntentUnresolvedQuery('user:alice', 'current-intent')._id,
    { $ne: 'current-intent' }
  );
});

test('explicit unknown state freezes even when a legacy lifecycle status is inconsistent', () => {
  const paperQuery = buildPaperUnresolvedQuery('user:alice');
  const roboQuery = buildRoboUnresolvedQuery('user:alice');

  assert.equal(Object.hasOwn(paperQuery, 'status'), false);
  assert.deepEqual(
    paperQuery.$or[0].submissionState.$in,
    [SUBMISSION_STATES.PENDING, SUBMISSION_STATES.UNKNOWN]
  );
  assert.equal(Object.hasOwn(roboQuery, 'status'), false);
  assert.equal(roboQuery.broker, 'alpaca');
  assert.equal(roboQuery.environment, 'paper');
});

test('one durable account lease admits only one owner and release is owner-scoped', async () => {
  const model = createInMemoryLockModel();
  const deps = { PaperAccountLockModel: model };
  const now = new Date('2026-07-23T12:00:00.000Z');

  const ownerA = await acquireAlpacaPaperSubmissionLock(
    'user:alice',
    'owner-a',
    now,
    deps
  );
  const ownerBWhileHeld = await acquireAlpacaPaperSubmissionLock(
    'user:alice',
    'owner-b',
    now,
    deps
  );
  assert.equal(ownerA.owner, 'owner-a');
  assert.equal(ownerBWhileHeld, null);

  await releaseAlpacaPaperSubmissionLock('user:alice', 'owner-b', deps);
  assert.equal(model.row.owner, 'owner-a');
  assert.equal(
    await acquireAlpacaPaperSubmissionLock('user:alice', 'owner-b', now, deps),
    null
  );

  await releaseAlpacaPaperSubmissionLock('user:alice', 'owner-a', deps);
  const ownerBAfterRelease = await acquireAlpacaPaperSubmissionLock(
    'user:alice',
    'owner-b',
    now,
    deps
  );
  assert.equal(ownerBAfterRelease.owner, 'owner-b');
});

test('concurrent submission callbacks for one account can produce at most one broker POST', async () => {
  const model = createInMemoryLockModel();
  const deps = { PaperAccountLockModel: model };
  const now = new Date('2026-07-23T12:00:00.000Z');
  let releaseFirst;
  const firstMayFinish = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let brokerPosts = 0;

  const runSubmission = async owner => {
    const lock = await acquireAlpacaPaperSubmissionLock(
      'user:alice',
      owner,
      now,
      deps
    );
    if (!lock) return false;
    brokerPosts += 1;
    if (owner === 'owner-a') await firstMayFinish;
    await releaseAlpacaPaperSubmissionLock('user:alice', owner, deps);
    return true;
  };

  const first = runSubmission('owner-a');
  await Promise.resolve();
  const second = runSubmission('owner-b');
  assert.equal(await second, false);
  assert.equal(brokerPosts, 1);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(brokerPosts, 1);
});

test('an expired lease cannot be silently renewed by its former owner', async () => {
  const model = createInMemoryLockModel();
  const deps = { PaperAccountLockModel: model };
  const acquiredAt = new Date('2026-07-23T12:00:00.000Z');
  await acquireAlpacaPaperSubmissionLock(
    'user:alice',
    'owner-a',
    acquiredAt,
    deps
  );

  const afterExpiry = new Date('2026-07-23T12:11:00.000Z');
  const renewed = await renewAlpacaPaperSubmissionLock(
    'user:alice',
    'owner-a',
    afterExpiry,
    deps
  );
  assert.equal(renewed, false);
  assert.equal(model.row.owner, 'owner-a');
});
