const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPECIFIC_ORDER_CONFIRMATION_TEXT,
  claimTradeAuthorization,
  createTradeAuthorization,
  revokeTradeAuthorization
} = require('../services/tradeAuthorizationService');
const { POLICY_VERSION } = require('../services/canonicalTradingPolicyService');

function createAuthorizationModel() {
  const calls = { updates: [], creates: [], claims: [] };
  const model = {
    updateMany: async (query, update) => {
      calls.updates.push({ query, update });
      return { modifiedCount: 0 };
    },
    findOne: async () => null,
    create: async payload => {
      calls.creates.push(payload);
      return { _id: 'authorization-1', ...payload };
    },
    findOneAndUpdate: async (query, update, options) => {
      calls.claims.push({ query, update, options });
      return { _id: query._id, ...update.$set };
    }
  };
  return { model, calls };
}

test('trade authorization requires the exact confirmation phrase', async () => {
  const { model } = createAuthorizationModel();
  await assert.rejects(
    createTradeAuthorization({
      userId: 'user-1',
      accountId: 'account-1',
      intent: {
        _id: 'intent-1',
        environment: 'live',
        status: 'awaiting_authorization',
        orderFingerprint: 'fingerprint-1',
        policyVersion: POLICY_VERSION
      },
      confirmation: 'yes',
      TradeAuthorizationModel: model
    }),
    /Exact specific-order authorization confirmation/
  );
});

test('trade authorization is short-lived and bound to one fingerprint', async () => {
  const { model, calls } = createAuthorizationModel();
  const authorization = await createTradeAuthorization({
    userId: 'user-1',
    accountId: 'account-1',
    intent: {
      _id: 'intent-1',
      environment: 'live',
      status: 'awaiting_authorization',
      orderFingerprint: 'fingerprint-1',
      policyVersion: POLICY_VERSION
    },
    confirmation: SPECIFIC_ORDER_CONFIRMATION_TEXT,
    approvalPolicy: { mode: 'every_trade', authorizationTtlSeconds: 120 },
    now: new Date('2026-07-13T14:00:00.000Z'),
    TradeAuthorizationModel: model
  });

  assert.equal(authorization.orderFingerprint, 'fingerprint-1');
  assert.equal(authorization.expiresAt.toISOString(), '2026-07-13T14:02:00.000Z');
  assert.equal(calls.creates.length, 1);
});

test('trade authorization rejects an intent from an obsolete policy version', async () => {
  const { model } = createAuthorizationModel();
  await assert.rejects(
    createTradeAuthorization({
      userId: 'user-1',
      accountId: 'account-1',
      intent: {
        _id: 'intent-old-policy',
        environment: 'live',
        status: 'awaiting_authorization',
        orderFingerprint: 'fingerprint-old-policy',
        policyVersion: 'obsolete-policy'
      },
      confirmation: SPECIFIC_ORDER_CONFIRMATION_TEXT,
      TradeAuthorizationModel: model
    }),
    error => error.code === 'AUTHORIZATION_POLICY_VERSION_MISMATCH'
  );
});

test('claiming an authorization atomically consumes it once', async () => {
  const { model, calls } = createAuthorizationModel();
  const claimed = await claimTradeAuthorization({
    authorizationId: 'authorization-1',
    userId: 'user-1',
    accountId: 'account-1',
    intentId: 'intent-1',
    orderFingerprint: 'fingerprint-1',
    policyVersion: POLICY_VERSION,
    runId: 'run-1',
    now: new Date('2026-07-13T14:01:00.000Z'),
    TradeAuthorizationModel: model
  });

  assert.equal(claimed.status, 'consumed');
  assert.equal(calls.claims[0].query.status, 'active');
  assert.equal(calls.claims[0].query.intentId, 'intent-1');
  assert.equal(calls.claims[0].query.policyVersion, POLICY_VERSION);
  assert.equal(calls.claims[0].query.orderFingerprint, 'fingerprint-1');
  assert.equal(calls.claims[0].update.$set.consumedByRunId, 'run-1');
  assert.equal(calls.claims[0].options.new, true);
});

test('revoking an authorization returns its intent to the approval queue', async () => {
  const updates = [];
  const authorization = await revokeTradeAuthorization({
    userId: 'user-1',
    accountId: 'account-1',
    intentId: 'intent-1',
    now: new Date('2026-07-13T14:02:00.000Z'),
    TradeAuthorizationModel: {
      findOneAndUpdate: async (query, update) => ({
        _id: 'authorization-1',
        ...query,
        ...update.$set
      })
    },
    OrderIntentModel: {
      updateOne: async (query, update) => {
        updates.push({ query, update });
      }
    }
  });

  assert.equal(authorization.status, 'revoked');
  assert.equal(updates[0].update.$set.status, 'awaiting_authorization');
  assert.equal(updates[0].update.$set.authorizationStatus, 'revoked');
});
