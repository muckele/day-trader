const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSettings } = require('../robotrader/settingsService');
const {
  adaptOrderForExistingPosition,
  adaptOrderForMarketSession,
  cleanupRoboAuditLogs,
  cleanupRoboTradeDecisions,
  emergencyStop,
  isAmbiguousSubmitError,
  previewRoboTraderForUser,
  resolveWorkerLockTtlMs,
  runRoboTraderForUser,
  submitPaperIntentForUser,
  submitAuthorizedIntentForUser,
  runWorkerTick
} = require('../robotrader/worker');
const { POLICY_VERSION } = require('../services/canonicalTradingPolicyService');
const { SUBMISSION_STATES } = require('../services/submissionOutcomeService');
const { createAlpacaBroker: createRealAlpacaBroker } = require('../robotrader/alpacaBroker');
const {
  findUnresolvedAlpacaPaperSubmission
} = require('../services/alpacaPaperSubmissionGuardService');

function chain(result) {
  return {
    sort: () => ({
      lean: async () => result
    })
  };
}

function createDeps({ approved = true } = {}) {
  const createdDecisions = [];
  const createdIntents = [];
  const createdOrders = [];
  const auditEvents = [];
  const brokerSubmissions = [];
  const deps = {
    env: {
      LIVE_TRADING_ENABLED: 'true',
      APCA_LIVE_API_KEY_ID: 'explicit-live-key',
      APCA_LIVE_API_SECRET_KEY: 'explicit-live-secret',
      APCA_LIVE_BASE_URL: 'https://api.alpaca.markets'
    },
    RoboSettings: {
      find: () => chain([{ userId: 'user-worker', isEnabled: true }]),
      updateOne: async () => ({ matchedCount: 1 })
    },
    RoboTradeDecision: {
      findOne: async query => createdDecisions.find(item => (
        (!query._id || String(item._id) === String(query._id))
        && (!query.idempotencyKey || item.idempotencyKey === query.idempotencyKey)
      )) || null,
      create: async payload => {
        const doc = {
          _id: `decision-${createdDecisions.length + 1}`,
          ...payload,
          save: async function save() {
            return this;
          }
        };
        createdDecisions.push(doc);
        return doc;
      }
    },
    OrderIntent: {
      findOne: async query => createdIntents.find(item => (
        (!query._id || (
          query._id.$ne
            ? String(item._id) !== String(query._id.$ne)
            : String(item._id) === String(query._id)
        ))
        && (!query.idempotencyKey || item.idempotencyKey === query.idempotencyKey)
        && (!query.userId || String(item.userId) === String(query.userId))
        && (!query.accountId || item.accountId === query.accountId)
        && (!query.broker || item.broker === query.broker)
        && (!query.environment || item.environment === query.environment)
        && (!query.origin || item.origin === query.origin)
        && (!query.status || (
          query.status.$in
            ? query.status.$in.includes(item.status)
            : item.status === query.status
        ))
      )) || null,
      findOneAndUpdate: async (query, update) => {
        const item = createdIntents.find(candidate => (
          String(candidate._id) === String(query._id)
          && (!query.status || candidate.status === query.status)
        ));
        if (!item) return null;
        Object.assign(item, update.$set || {});
        return item;
      },
      create: async payload => {
        const doc = {
          _id: `intent-${createdIntents.length + 1}`,
          ...payload,
          save: async function save() {
            createdIntents[createdIntents.length - 1] = this;
            return this;
          }
        };
        createdIntents.push(doc);
        return doc;
      }
    },
    RoboTradeOrder: {
      find: () => chain([]),
      findOne: async query => query?._id
        ? createdOrders.find(item => (
            String(item._id) === String(query._id)
            && (!query.accountId || item.accountId === query.accountId)
          )) || null
        : null,
      create: async payload => {
        const doc = {
          _id: `order-${createdOrders.length + 1}`,
          ...payload,
          save: async function save() {
            createdOrders[createdOrders.length - 1] = this;
            return this;
          }
        };
        createdOrders.push(doc);
        return doc;
      },
      updateMany: async () => ({ modifiedCount: 0 })
    },
    PaperOrder: {
      findOne: async () => null
    },
    RoboAuditLog: {
      create: async payload => {
        auditEvents.push(payload);
        return payload;
      }
    },
    getOrCreateRoboTraderSettings: async userId => ({
      userId,
      isEnabled: true,
      enabled: true,
      controlGeneration: 0,
      mode: 'paper',
      allowedAssetClasses: ['stocks'],
      allowedSymbols: ['AAPL'],
      blockedSymbols: [],
      maxTradeAmount: 1000,
      maxPositionSize: 5000,
      maxDailyLoss: 500,
      maxOpenPositions: 5,
      maxTradesPerDay: 3,
      allowFractionalShares: true,
      riskLevel: 'balanced'
    }),
    mapSettings,
    hasBrokerOperatorAccess: async () => true,
    updateRoboTraderSettings: async () => ({ isEnabled: false, enabled: false }),
    buildClientOrderId: () => 'daytrader-robotrader-AAPL-fixed',
    acquireAlpacaPaperSubmissionLock: async (_accountId, owner) => ({ owner }),
    releaseAlpacaPaperSubmissionLock: async () => ({ matchedCount: 1 }),
    renewAlpacaPaperSubmissionLock: async () => true,
    findUnresolvedAlpacaPaperSubmission,
    isAmbiguousSubmitError,
    buildResearchBatch: async () => [{
      symbol: 'AAPL',
      assetClass: 'stocks',
      price: 200,
      quote: {
        symbol: 'AAPL',
        price: 200,
        bidPrice: 199.95,
        askPrice: 200.05,
        timestamp: '2026-07-13T14:00:00.000Z',
        source: 'alpaca',
        isMock: false
      },
      indicators: { avgVolume20: 1000000 },
      marketContext: {}
    }],
    evaluateResearchBatch: () => [{
      symbol: 'AAPL',
      assetClass: 'stocks',
      action: 'buy',
      confidenceScore: 80,
      rewardRiskRatio: 2,
      strategyId: 'TEST_STRATEGY',
      strategyName: 'Test strategy',
      reasoningSummary: 'Test decision.',
      recommendedOrder: {
        symbol: 'AAPL',
        assetClass: 'stocks',
        side: 'buy',
        orderType: 'market',
        orderClass: 'bracket',
        timeInForce: 'day',
        qty: 1,
        estimatedNotional: 100,
        stopLoss: { stop_price: 190 },
        takeProfit: { limit_price: 210 }
      }
    }],
    evaluateRoboRisk: () => ({
      approved,
      checks: [{ name: 'test', passed: approved, message: approved ? null : 'Rejected by test.' }],
      rejectionReasons: approved ? [] : ['Rejected by test.']
    }),
    // Submission-outcome tests isolate the worker lifecycle from the separately
    // covered external-execution market-data/session gate.
    evaluateExecutionQuality: () => ({
      approved: true,
      veto: false,
      checks: [{ name: 'trusted_execution_data', passed: true, message: 'Test fixture.' }],
      rejectionReasons: [],
      metrics: {}
    }),
    validateControlledLiveSubmission: async () => ({ approved: true }),
    claimControlledLiveAttempt: async () => ({ _id: 'activation-1', attemptsUsed: 1 }),
    revalidateControlledLiveAttempt: async () => ({ _id: 'activation-1', status: 'active' }),
    recordControlledLiveOutcome: async () => null,
    createAlpacaBroker: () => ({
      getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
      getClock: async () => ({
        is_open: true,
        next_close: '2026-07-13T20:00:00.000Z'
      }),
      getPositions: async () => [],
      listOrders: async () => [],
      submitOrder: async input => {
        brokerSubmissions.push(input);
        return {
          payload: { client_order_id: input.clientOrderId },
          order: {
            id: 'alpaca-order-1',
            client_order_id: input.clientOrderId,
            status: 'accepted',
            submitted_at: '2026-05-19T00:00:00.000Z'
          }
        };
      }
    })
  };
  return { deps, createdDecisions, createdIntents, createdOrders, auditEvents, brokerSubmissions };
}

test('risk-reducing position exits are converted to simple orders before persistence', () => {
  const adapted = adaptOrderForExistingPosition({
    symbol: 'MSFT',
    side: 'sell',
    qty: 1,
    orderType: 'market',
    orderClass: 'bracket',
    takeProfit: { limit_price: 390 },
    stopLoss: { stop_price: 410 }
  }, [{ symbol: 'MSFT', qty: 2 }]);

  assert.equal(adapted.orderClass, 'simple');
  assert.equal(adapted.takeProfit, null);
  assert.equal(adapted.stopLoss, null);
});

test('short-entry bracket orders are not rewritten when no long position can be reduced', () => {
  const original = {
    symbol: 'MSFT',
    side: 'sell',
    qty: 1,
    orderClass: 'bracket',
    takeProfit: { limit_price: 390 },
    stopLoss: { stop_price: 410 }
  };

  assert.equal(adaptOrderForExistingPosition(original, []).orderClass, 'bracket');
});

test('robotrader worker saves approved decisions and submitted orders', async () => {
  const context = createDeps({ approved: true });
  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdDecisions.length, 1);
  assert.equal(context.createdIntents.length, 1);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdDecisions[0].accountId, 'user:user-worker');
  assert.equal(context.createdDecisions[0].researchSnapshot.summaryVersion, 1);
  assert.equal(context.createdDecisions[0].researchSnapshot.symbol, 'AAPL');
  assert.equal(context.createdDecisions[0].researchSnapshot.bars, undefined);
  assert.equal(context.createdOrders[0].accountId, 'user:user-worker');
  assert.equal(context.createdOrders[0].intentId, context.createdIntents[0]._id);
  assert.equal(context.createdIntents[0].status, 'submitted');
  assert.equal(context.createdIntents[0].orderFingerprint, context.createdOrders[0].orderFingerprint);
  assert.equal(context.createdOrders[0].externalOrderId, 'alpaca-order-1');
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 1);
  assert.ok(context.createdOrders[0].submissionLastAttemptAt);
  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.brokerSubmissions[0].clientOrderId, context.createdOrders[0].clientOrderId);
});

test('robotrader worker aborts submission when a stop changes the control generation', async () => {
  const context = createDeps({ approved: true });
  const settingsUpdates = [];
  context.deps.readControlGeneration = async () => 1;
  context.deps.RoboSettings.updateOne = async (query, update) => {
    settingsUpdates.push({ query, update });
    return { matchedCount: 1 };
  };

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.createdIntents[0].status, 'policy_blocked');
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_submission_control_invalidated'),
    true
  );
  assert.equal(settingsUpdates.length, 1);
  assert.deepEqual(settingsUpdates[0].update.$set, {
    lastRunAt: new Date('2026-07-13T14:00:00.000Z')
  });
});

test('robotrader worker records an immediate broker fill on the intent and decision', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => ({
      payload: { client_order_id: input.clientOrderId },
      order: {
        id: 'alpaca-filled-1',
        client_order_id: input.clientOrderId,
        status: 'filled',
        filled_qty: '1',
        filled_avg_price: '200',
        filled_at: '2026-05-19T00:00:01.000Z'
      }
    })
  });

  await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(context.createdOrders[0].status, 'filled');
  assert.equal(context.createdIntents[0].status, 'filled');
  assert.equal(context.createdDecisions[0].status, 'filled');
});

test('robotrader worker keeps failed submissions reconcilable by client order id', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      const err = new Error('network timeout after submit');
      err.code = 'ETIMEDOUT';
      err.alpacaPayload = {
        symbol: input.symbol,
        client_order_id: input.clientOrderId,
        qty: String(input.qty)
      };
      throw err;
    }
  });

  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
  assert.equal(context.createdOrders[0].rejectedAt, null);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 1);
  assert.deepEqual(context.createdOrders[0].rawPayload, {
    symbol: 'AAPL',
    client_order_id: 'daytrader-robotrader-AAPL-fixed',
    qty: '1'
  });
  assert.equal(context.createdDecisions[0].status, 'error');
  assert.equal(context.brokerSubmissions[0].clientOrderId, context.createdOrders[0].clientOrderId);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_order_submit_uncertain'), true);
});

test('robotrader worker marks explicit broker rejections terminal', async () => {
  const context = createDeps({ approved: true });
  const rejected = new Error('Request failed with status code 422');
  rejected.response = {
    status: 422,
    data: {
      code: 42210000,
      message: 'qty must be whole shares for advanced order class'
    }
  };
  rejected.alpacaPayload = {
    symbol: 'AAPL',
    qty: '1.25',
    order_class: 'bracket'
  };
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      throw rejected;
    }
  });

  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].status, 'rejected');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.REJECTED);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_rejected');
  assert.equal(context.createdOrders[0].discrepancy, 'Broker 422: qty must be whole shares for advanced order class');
  assert.deepEqual(context.createdOrders[0].rawPayload, {
    symbol: 'AAPL',
    qty: '1.25',
    order_class: 'bracket'
  });
  assert.deepEqual(context.createdOrders[0].alpacaResponse.data, {
    code: 42210000,
    message: 'qty must be whole shares for advanced order class'
  });
  assert.ok(context.createdOrders[0].rejectedAt);
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(context.createdDecisions[0].error, 'Broker 422: qty must be whole shares for advanced order class');
  assert.equal(context.brokerSubmissions[0].clientOrderId, context.createdOrders[0].clientOrderId);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_order_rejected'), true);
});

test('robotrader worker keeps Alpaca duplicate client identity errors unknown and reconcilable', async () => {
  const context = createDeps({ approved: true });
  const duplicate = new Error('Request failed with status code 422');
  duplicate.response = {
    status: 422,
    data: {
      code: 40010001,
      message: 'client_order_id must be unique'
    }
  };
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({
      buying_power: '10000',
      equity: '10000',
      last_equity: '10000',
      status: 'ACTIVE'
    }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      duplicate.clientOrderId = input.clientOrderId;
      duplicate.alpacaPayload = {
        symbol: input.symbol,
        client_order_id: input.clientOrderId,
        qty: String(input.qty)
      };
      duplicate.submissionAttempted = true;
      throw duplicate;
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
  assert.equal(context.createdOrders[0].rejectedAt, null);
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_order_rejected'),
    false
  );
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_order_submit_uncertain'),
    true
  );
});

test('robotrader worker treats a conclusive rejected acknowledgement as confirmed rejection', async () => {
  const context = createDeps({ approved: true });
  const rejectedAt = '2026-07-13T14:00:01.000Z';
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: { client_order_id: input.clientOrderId },
        order: {
          id: 'alpaca-rejected-ack-1',
          client_order_id: input.clientOrderId,
          status: 'rejected',
          rejected_at: rejectedAt
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].externalOrderId, 'alpaca-rejected-ack-1');
  assert.equal(context.createdOrders[0].status, 'rejected');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.REJECTED);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_rejected');
  assert.equal(context.createdOrders[0].rejectedAt, rejectedAt);
  assert.equal(context.createdIntents[0].status, 'rejected');
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_order_rejected'),
    true
  );
});

test('robotrader worker freezes account submissions before minting an identity when an outcome is unresolved', async () => {
  const context = createDeps({ approved: true });
  let generatedClientOrderIds = 0;
  let controlledLiveAttemptClaims = 0;
  let unresolvedQuery = null;
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    controlGeneration: 0,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    approvalPolicy: { mode: 'autonomous', thresholdUsd: 0, requireExactOrderMatch: true },
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });
  context.deps.claimControlledLiveAttempt = async () => {
    controlledLiveAttemptClaims += 1;
    return { _id: 'must-not-be-claimed' };
  };
  context.deps.buildClientOrderId = () => {
    generatedClientOrderIds += 1;
    return 'must-not-be-generated';
  };
  context.deps.RoboTradeOrder.findOne = query => {
    unresolvedQuery = query;
    return {
      select: () => ({
        lean: async () => ({
          _id: 'unknown-order-1',
          clientOrderId: 'original-unknown-client-id',
          status: 'pending_submit',
          submissionState: SUBMISSION_STATES.UNKNOWN
        })
      })
    };
  };

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(controlledLiveAttemptClaims, 0);
  assert.equal(unresolvedQuery.accountId, 'user:user-worker');
  assert.equal(unresolvedQuery.environment, 'live');
  assert.equal(
    unresolvedQuery.$or.some(clause => clause.submissionState === SUBMISSION_STATES.PENDING),
    true
  );
  assert.equal(
    unresolvedQuery.$or.some(clause => clause.submissionState === SUBMISSION_STATES.UNKNOWN),
    true
  );
  assert.equal(context.createdIntents[0].status, 'policy_blocked');
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_unknown_blocked'
      && event.payload.reasonCode === 'UNRESOLVED_SUBMIT_UNKNOWN'
      && event.payload.pendingOrderId === null
    )),
    true
  );
});

test('a manual PaperOrder unknown freezes the RoboTrader paper path under the shared account lease', async () => {
  const context = createDeps({ approved: true });
  let generatedClientOrderIds = 0;
  let roboUnresolvedReads = 0;
  const manualUnknown = {
    _id: 'paper-order-manual-unknown',
    accountId: 'user:user-worker',
    broker: 'alpaca',
    status: 'open',
    submissionState: SUBMISSION_STATES.UNKNOWN,
    clientOrderId: 'manual-client-original'
  };
  context.deps.PaperOrder.findOne = async () => manualUnknown;
  context.deps.RoboTradeOrder.findOne = async () => {
    roboUnresolvedReads += 1;
    return null;
  };
  context.deps.buildClientOrderId = () => {
    generatedClientOrderIds += 1;
    return 'must-not-be-generated';
  };

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(roboUnresolvedReads, 0);
  assert.equal(context.createdIntents[0].status, 'policy_blocked');
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_unknown_blocked'
      && event.payload.reasonCode === 'UNRESOLVED_SUBMIT_UNKNOWN'
    )),
    true
  );
});

test('shared Alpaca-paper lock contention is not attempted and performs zero broker POSTs', async () => {
  const context = createDeps({ approved: true });
  let generatedClientOrderIds = 0;
  context.deps.acquireAlpacaPaperSubmissionLock = async () => null;
  context.deps.buildClientOrderId = () => {
    generatedClientOrderIds += 1;
    return 'must-not-be-generated';
  };

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(generatedClientOrderIds, 0);
  assert.equal(context.createdIntents[0].status, 'cancelled');
  assert.equal(context.createdDecisions[0].status, 'cancelled');
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_lock_blocked'
      && event.payload.reasonCode === 'ALPACA_PAPER_SUBMISSION_LOCKED'
    )),
    true
  );
});

test('robotrader worker rechecks the unresolved latch at dispatch and blocks a late race', async () => {
  const context = createDeps({ approved: true });
  let unresolvedReads = 0;
  context.deps.RoboTradeOrder.findOne = async () => {
    unresolvedReads += 1;
    if (unresolvedReads === 1) return null;
    return {
      _id: 'late-unknown-order',
      clientOrderId: 'late-unknown-client-id',
      status: 'pending_submit',
      submissionState: SUBMISSION_STATES.UNKNOWN
    };
  };

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(unresolvedReads, 2);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].status, 'canceled');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 0);
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_unknown_blocked'
      && event.payload.pendingOrderId === context.createdOrders[0]._id
    )),
    true
  );
});

test('robotrader worker classifies a thrown final lease renewal as not attempted', async () => {
  const context = createDeps({ approved: true });
  let renewalCalls = 0;
  context.deps.renewAlpacaPaperSubmissionLock = async () => {
    renewalCalls += 1;
    if (renewalCalls === 2) throw new Error('lock database unavailable');
    return true;
  };

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(renewalCalls, 2);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].status, 'canceled');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 0);
  assert.equal(context.createdOrders[0].submissionLastAttemptAt, null);
  assert.equal(context.createdOrders[0].submissionLastError.submissionAttempted, false);
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_lock_blocked'
      && event.payload.reasonCode === 'ALPACA_PAPER_SUBMISSION_COORDINATION_FAILED'
    )),
    true
  );
});

test('robotrader worker classifies a thrown final unresolved query as not attempted', async () => {
  const context = createDeps({ approved: true });
  let unresolvedReads = 0;
  context.deps.findUnresolvedAlpacaPaperSubmission = async () => {
    unresolvedReads += 1;
    if (unresolvedReads === 2) throw new Error('order database unavailable');
    return null;
  };

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(unresolvedReads, 2);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].status, 'canceled');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 0);
  assert.equal(context.createdOrders[0].submissionLastAttemptAt, null);
  assert.equal(context.createdOrders[0].submissionLastError.submissionAttempted, false);
  assert.equal(
    context.auditEvents.some(event => (
      event.eventType === 'robotrader_submission_unknown_blocked'
      && event.payload.reasonCode === 'SUBMISSION_COORDINATION_FAILED'
    )),
    true
  );
});

test('robotrader worker treats a missing returned client identity as unknown', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: { client_order_id: 'must-not-replace-persisted-id' },
        order: {
          id: 'alpaca-order-without-returned-client-id',
          status: 'accepted'
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].externalOrderId, undefined);
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
});

test('robotrader worker treats a mismatched returned client identity as unknown', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: { client_order_id: input.clientOrderId },
        order: {
          id: 'alpaca-order-wrong-client',
          client_order_id: 'different-client-id',
          status: 'accepted'
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].externalOrderId, undefined);
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
});

test('robotrader worker treats a malformed returned broker identity as unknown', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: { client_order_id: input.clientOrderId },
        order: {
          id: { proxy: 'bad' },
          client_order_id: input.clientOrderId,
          status: 'accepted'
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].externalOrderId, undefined);
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
});

test('robotrader worker treats incomplete filled acknowledgement as unknown without a protective follow-on', async () => {
  const context = createDeps({ approved: true });
  let protectiveSubmissions = 0;
  context.deps.submitProtectiveStopForEntry = async () => {
    protectiveSubmissions += 1;
  };
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: { client_order_id: input.clientOrderId },
        order: {
          id: 'alpaca-incomplete-filled',
          client_order_id: input.clientOrderId,
          status: 'filled'
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(protectiveSubmissions, 0);
  assert.equal(context.createdOrders[0].externalOrderId, undefined);
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].filledQty, undefined);
  assert.equal(context.createdOrders[0].filledAvgPrice, undefined);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
});

test('robotrader worker treats an inconclusive acknowledgement as submit unknown', async () => {
  const context = createDeps({ approved: true });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: async input => {
      context.brokerSubmissions.push(input);
      return {
        payload: {
          symbol: input.symbol,
          client_order_id: input.clientOrderId,
          qty: String(input.qty)
        },
        order: {
          id: 'ack-with-invalid-status',
          client_order_id: input.clientOrderId,
          status: 'not-a-real-alpaca-status'
        }
      };
    }
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.UNKNOWN);
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_unknown');
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.deepEqual(context.createdOrders[0].rawPayload, {
    symbol: 'AAPL',
    client_order_id: 'daytrader-robotrader-AAPL-fixed',
    qty: '1'
  });
  assert.equal(context.createdOrders[0].rejectedAt, null);
});

test('robotrader worker resets attempt evidence when the real adapter proves no request began', async () => {
  const context = createDeps({ approved: true });
  let httpCalls = 0;
  const preflightBroker = createRealAlpacaBroker({
    mode: 'paper',
    env: {
      APCA_PAPER_BASE_URL: 'https://paper-api.alpaca.markets'
    },
    httpClient: async () => {
      httpCalls += 1;
      return { data: {} };
    }
  });
  context.deps.createAlpacaBroker = () => ({
    getAccount: async () => ({
      buying_power: '10000',
      equity: '10000',
      last_equity: '10000',
      status: 'ACTIVE'
    }),
    getClock: async () => ({ is_open: true }),
    getPositions: async () => [],
    listOrders: async () => [],
    submitOrder: preflightBroker.submitOrder
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    runOnce: true
  }, context.deps);

  assert.equal(httpCalls, 0);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].status, 'canceled');
  assert.equal(context.createdOrders[0].submissionState, SUBMISSION_STATES.NOT_ATTEMPTED);
  assert.equal(context.createdOrders[0].submissionAttemptCount, 0);
  assert.equal(context.createdOrders[0].submissionLastAttemptAt, null);
  assert.equal(context.createdOrders[0].submittedAt, null);
  assert.equal(context.createdOrders[0].filledAt, null);
  assert.equal(context.createdOrders[0].rejectedAt, null);
  assert.ok(context.createdOrders[0].canceledAt);
});

test('robotrader worker makes zero broker calls when durable attempt evidence cannot be saved', async () => {
  const context = createDeps({ approved: true });
  let pendingOrder = null;
  context.deps.RoboTradeOrder.create = async payload => {
    pendingOrder = {
      _id: 'order-attempt-save-failure',
      ...payload,
      save: async () => {
        throw new Error('durable attempt marker unavailable');
      }
    };
    context.createdOrders.push(pendingOrder);
    return pendingOrder;
  };

  await assert.rejects(
    () => runRoboTraderForUser({
      userId: 'user-worker',
      modeOverride: 'paper',
      runOnce: true
    }, context.deps),
    /durable attempt marker unavailable/
  );

  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(pendingOrder.submissionState, SUBMISSION_STATES.PENDING);
  assert.equal(pendingOrder.submissionAttemptCount, 1);
});

test('robotrader worker does not reclassify a post-acknowledgement save fault as a broker rejection', async () => {
  const context = createDeps({ approved: true });
  let pendingOrder = null;
  let saveCount = 0;
  context.deps.RoboTradeOrder.create = async payload => {
    pendingOrder = {
      _id: 'order-post-ack-save-failure',
      ...payload,
      save: async function save() {
        saveCount += 1;
        if (saveCount === 2) throw new Error('post-acknowledgement save failed');
        return this;
      }
    };
    context.createdOrders.push(pendingOrder);
    return pendingOrder;
  };

  await assert.rejects(
    () => runRoboTraderForUser({
      userId: 'user-worker',
      modeOverride: 'paper',
      runOnce: true
    }, context.deps),
    /post-acknowledgement save failed/
  );

  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(pendingOrder.status, 'accepted');
  assert.equal(pendingOrder.submissionState, SUBMISSION_STATES.SUBMITTED);
  assert.equal(pendingOrder.rejectedAt, null);
  assert.equal(pendingOrder.reconciliationStatus, 'matched');
});

test('robotrader paper preview evaluates without saving or submitting orders', async () => {
  const context = createDeps({ approved: true });
  const result = await previewRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper' }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(result.environment, 'paper');
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].wouldSubmit, true);
  assert.equal(context.createdDecisions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_preview_run'), true);
});

function configureFrozenPaperMvp(context) {
  const parameterVersionId = '507f1f77bcf86cd799439011';
  context.deps.env = {
    LIVE_TRADING_ENABLED: 'false',
    PAPER_MVP_PARAMETER_VERSION_ID: parameterVersionId
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    controlGeneration: 0,
    mode: 'paper',
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 100,
    maxPositionSize: 250,
    maxDailyLoss: 50,
    maxOpenPositions: 1,
    maxTradesPerDay: 1,
    allowFractionalShares: true,
    riskLevel: 'balanced',
    activeStrategyId: 'ROBO_TREND_FOLLOWING_V1',
    activeParameterVersionId: parameterVersionId
  });
  context.deps.buildResearchBatch = async () => [{
    symbol: 'AAPL',
    assetClass: 'stocks',
    price: 200,
    quote: {
      symbol: 'AAPL',
      price: 200,
      bidPrice: 199.95,
      askPrice: 200.05,
      timestamp: '2026-07-13T14:00:00.000Z',
      source: 'alpaca',
      isMock: false
    },
    indicators: { avgVolume20: 1000000 },
    marketContext: {},
    dataProvenance: { trustedForExecution: true, provider: 'alpaca', symbol: 'AAPL' }
  }];
  context.deps.evaluateResearchBatch = () => [{
    symbol: 'AAPL',
    assetClass: 'stocks',
    action: 'buy',
    confidenceScore: 80,
    rewardRiskRatio: 2,
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameterVersionId,
    strategyName: 'Trend following',
    reasoningSummary: 'Frozen test decision.',
    recommendedOrder: {
      symbol: 'AAPL',
      assetClass: 'stocks',
      side: 'buy',
      orderType: 'market',
      orderClass: 'simple',
      timeInForce: 'day',
      qty: 0.5,
      estimatedNotional: 100
    }
  }];
  context.deps.fetchQuotes = async () => [{
    symbol: 'AAPL',
    price: 200,
    bidPrice: 199.95,
    askPrice: 200.05,
    timestamp: '2026-07-13T14:00:00.000Z',
    source: 'alpaca',
    isMock: false
  }];
  context.deps.getCurrentTime = () => new Date('2026-07-13T14:00:00.000Z');
  return parameterVersionId;
}

test('paper MVP preview durably freezes one exact AAPL intent without broker POST', async () => {
  const context = createDeps({ approved: true });
  configureFrozenPaperMvp(context);
  const result = await previewRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    persistIntent: true,
    idempotencyKey: 'preview-1',
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(result.decisions[0].symbol, 'AAPL');
  assert.equal(result.decisions[0].intentId, 'intent-1');
  assert.equal(context.createdIntents.length, 1);
  assert.equal(context.createdIntents[0].orderFingerprint, result.decisions[0].orderFingerprint);
  assert.equal(context.createdIntents[0].marketDataProvenance.trustedForExecution, true);
  assert.equal(context.brokerSubmissions.length, 0);
});

test('paper MVP explicitly submits the frozen intent once and safely replays the same idempotency key', async () => {
  const context = createDeps({ approved: true });
  configureFrozenPaperMvp(context);
  const preview = await previewRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    persistIntent: true,
    idempotencyKey: 'preview-2',
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  const intentId = preview.decisions[0].intentId;

  const first = await submitPaperIntentForUser({
    userId: 'user-worker',
    intentId,
    idempotencyKey: 'submit-2',
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  const replay = await submitPaperIntentForUser({
    userId: 'user-worker',
    intentId,
    idempotencyKey: 'submit-2',
    now: new Date('2026-07-13T14:00:01.000Z')
  }, context.deps);

  assert.equal(first.submitted, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
});

test('paper MVP idempotent replay reports an unresolved order without another broker POST', async () => {
  const context = createDeps({ approved: true });
  configureFrozenPaperMvp(context);
  const preview = await previewRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'paper',
    persistIntent: true,
    idempotencyKey: 'preview-unknown-replay',
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  const intentId = preview.decisions[0].intentId;

  await submitPaperIntentForUser({
    userId: 'user-worker',
    intentId,
    idempotencyKey: 'submit-unknown-replay',
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  context.createdOrders[0].status = 'pending_submit';
  context.createdOrders[0].submissionState = SUBMISSION_STATES.UNKNOWN;
  context.createdIntents[0].status = 'submission_uncertain';

  const replay = await submitPaperIntentForUser({
    userId: 'user-worker',
    intentId,
    idempotencyKey: 'submit-unknown-replay',
    now: new Date('2026-07-13T14:00:01.000Z')
  }, context.deps);

  assert.equal(replay.ok, false);
  assert.equal(replay.submitted, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reason, 'SUBMISSION_UNCERTAIN');
  assert.equal(context.brokerSubmissions.length, 1);
});

test('robotrader worker saves rejected decisions without submitting orders', async () => {
  const context = createDeps({ approved: false });
  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdDecisions.length, 1);
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.brokerSubmissions.length, 0);
});

test('robotrader decision cleanup deletes stale unlinked decisions only', async () => {
  const findQueries = [];
  const deleteQueries = [];
  const candidates = [
    { _id: 'old-linked' },
    { _id: 'old-unlinked' }
  ];
  const deps = {
    RoboTradeDecision: {
      find: query => {
        findQueries.push(query);
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({
                lean: async () => (query._id ? [] : candidates)
              })
            })
          })
        };
      },
      deleteMany: async query => {
        deleteQueries.push(query);
        return { deletedCount: query._id.$in.length };
      }
    },
    RoboTradeOrder: {
      distinct: async () => ['old-linked']
    }
  };

  const result = await cleanupRoboTradeDecisions({
    olderThanDays: 7,
    now: new Date('2026-01-10T00:00:00.000Z'),
    batchSize: 10
  }, deps);

  assert.equal(result.retentionDays, 7);
  assert.equal(result.scannedCount, 2);
  assert.equal(result.preservedLinkedCount, 1);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(deleteQueries[0]._id.$in, ['old-unlinked']);
  assert.deepEqual(findQueries[0].status.$in, ['approved', 'rejected', 'error', 'pending_manual_approval']);
});

test('robotrader decision cleanup defaults to three-day retention', async () => {
  const findQueries = [];
  const deps = {
    RoboTradeDecision: {
      find: query => {
        findQueries.push(query);
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({
                lean: async () => []
              })
            })
          })
        };
      },
      deleteMany: async () => ({ deletedCount: 0 })
    },
    RoboTradeOrder: {
      distinct: async () => []
    }
  };

  const result = await cleanupRoboTradeDecisions({
    now: new Date('2026-01-10T00:00:00.000Z'),
    batchSize: 10
  }, deps);

  assert.equal(result.retentionDays, 3);
  assert.equal(findQueries[0].decidedAt.$lt.toISOString(), '2026-01-07T00:00:00.000Z');
});

test('robotrader audit cleanup deletes old audit logs by retention cutoff', async () => {
  const deleteQueries = [];
  const deps = {
    RoboAuditLog: {
      deleteMany: async query => {
        deleteQueries.push(query);
        return { deletedCount: 42 };
      }
    }
  };

  const result = await cleanupRoboAuditLogs({
    now: new Date('2026-01-10T00:00:00.000Z')
  }, deps);

  assert.equal(result.retentionDays, 90);
  assert.equal(result.deletedCount, 42);
  assert.equal(deleteQueries[0].createdAt.$lt.toISOString(), '2025-10-12T00:00:00.000Z');
});

test('robotrader worker tick finds enabled users', async () => {
  const context = createDeps({ approved: false });
  const result = await runWorkerTick(context.deps);

  assert.equal(result.ok, true);
  assert.equal(result.usersChecked, 1);
  assert.equal(context.createdDecisions.length, 1);
});

test('robotrader worker tick dedupes duplicate enabled settings for a user', async () => {
  const context = createDeps({ approved: false });
  context.deps.RoboSettings.find = () => chain([
    { userId: 'user-worker', isEnabled: true },
    { userId: 'user-worker', enabled: true }
  ]);

  const result = await runWorkerTick(context.deps);

  assert.equal(result.ok, true);
  assert.equal(result.settingsMatched, 2);
  assert.equal(result.usersChecked, 1);
  assert.equal(context.createdDecisions.length, 1);
});

test('robotrader worker blocks live mode before broker access without explicit opt-in', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: false,
    allowedAssetClasses: ['stocks']
  });
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };

  const result = await runRoboTraderForUser({ userId: 'user-worker' }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LIVE_TRADING_NOT_ENABLED');
  assert.equal(brokerCreated, false);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_live_blocked'), true);
});

test('robotrader worker scopes recent orders to the active live environment', async () => {
  const context = createDeps({ approved: true });
  const findQueries = [];
  context.deps.RoboTradeOrder.find = query => {
    findQueries.push(query);
    return chain([]);
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(findQueries.length, 1);
  assert.equal(findQueries[0].userId, 'user-worker');
  assert.equal(findQueries[0].environment, 'live');
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdDecisions[0].status, 'pending_manual_approval');
  assert.equal(context.createdIntents[0].status, 'awaiting_authorization');
});

test('live worker fails closed before broker access for a non-operator', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.hasBrokerOperatorAccess = async () => false;
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL']
  });

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BROKER_OPERATOR_REQUIRED');
  assert.equal(brokerCreated, false);
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_live_blocked'),
    true
  );
});

test('live worker fails closed before broker access when the deployment gate is disabled', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.env = {};
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL']
  });

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LIVE_DEPLOYMENT_FLAG_DISABLED');
  assert.equal(brokerCreated, false);
});

test('authorized live intent fails closed before loading the broker for a non-operator', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.hasBrokerOperatorAccess = async () => false;
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true
  });

  const result = await submitAuthorizedIntentForUser({
    userId: 'user-worker',
    intentId: 'intent-non-operator',
    now: new Date('2026-07-13T14:01:00.000Z')
  }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BROKER_OPERATOR_REQUIRED');
  assert.equal(brokerCreated, false);
});

test('authorized live intent fails closed before loading the broker when live credentials are absent', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.env = { LIVE_TRADING_ENABLED: 'true' };
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true
  });

  const result = await submitAuthorizedIntentForUser({
    userId: 'user-worker',
    intentId: 'intent-no-live-credentials',
    now: new Date('2026-07-13T14:01:00.000Z')
  }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LIVE_CREDENTIALS_NOT_CONFIGURED');
  assert.equal(brokerCreated, false);
});

test('live submission fails closed when the controlled-live boundary rejects it', async () => {
  const context = createDeps({ approved: true });
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    controlGeneration: 0,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    approvalPolicy: { mode: 'autonomous', thresholdUsd: 0, requireExactOrderMatch: true },
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });
  context.deps.validateControlledLiveSubmission = async () => ({
    approved: false,
    reasonCode: 'CONTROLLED_LIVE_NOT_ACTIVE',
    message: 'No current controlled-live activation exists.'
  });

  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.createdIntents[0].status, 'policy_blocked');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_controlled_live_blocked'),
    true
  );
});

test('shadow-live worker applies live-like gates and never submits a broker order', async () => {
  const context = createDeps({ approved: true });
  const createPaperBroker = context.deps.createAlpacaBroker;
  let brokerMode = null;
  context.deps.createAlpacaBroker = ({ mode }) => {
    brokerMode = mode;
    return createPaperBroker();
  };
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'shadow',
    liveTradingExplicitlyEnabled: false,
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'shadow',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(result.environment, 'shadow');
  assert.equal(result.shadowApprovedCount, 1);
  assert.equal(brokerMode, 'paper');
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.createdDecisions[0].status, 'approved');
  assert.equal(context.createdIntents[0].status, 'policy_approved');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_shadow_candidate_approved'),
    true
  );
});

test('portfolio breach vetoes shadow candidates and pauses automation', async () => {
  const context = createDeps({ approved: true });
  const baseBroker = context.deps.createAlpacaBroker();
  const settingsUpdates = [];
  context.deps.RoboSettings.updateOne = async (query, update) => {
    settingsUpdates.push({ query, update });
    return { matchedCount: 1 };
  };
  context.deps.RoboExposureSnapshot = {
    findOne: () => ({
      sort: () => ({
        lean: async () => null
      })
    }),
    create: async payload => ({ _id: 'exposure-1', ...payload })
  };
  context.deps.createAlpacaBroker = () => ({
    ...baseBroker,
    getPositions: async () => [{ symbol: 'AAPL', qty: 10, market_value: 2000 }]
  });
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'shadow',
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced',
    portfolioPolicy: {
      maxGrossExposurePct: 10,
      maxNetExposurePct: 100,
      maxDailyDrawdownPct: 2,
      maxTotalDrawdownPct: 5,
      pauseOnBreach: true
    }
  });

  const result = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'shadow',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);

  assert.equal(result.exposureSnapshot.breached, true);
  assert.equal(context.createdDecisions[0].status, 'rejected');
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(
    settingsUpdates.some(call => call.update.$set?.isEnabled === false),
    true
  );
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_portfolio_risk_pause'),
    true
  );
});

test('authorized-intent submission reloads and submits only the exact persisted intent', async () => {
  const context = createDeps({ approved: true });
  let claimCount = 0;
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    approvalPolicy: {
      mode: 'every_trade',
      thresholdUsd: 0,
      authorizationTtlSeconds: 300,
      requireExactOrderMatch: true
    },
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });
  const initial = await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  assert.equal(initial.ok, true);
  assert.equal(context.brokerSubmissions.length, 0);
  const intent = context.createdIntents[0];
  const decision = context.createdDecisions[0];
  intent.status = 'authorized';
  intent.authorizationStatus = 'active';
  context.deps.OrderIntent.findOne = async query => (
    String(query._id) === String(intent._id) ? intent : null
  );
  context.deps.RoboTradeDecision.findOne = async query => (
    String(query._id) === String(decision._id) ? decision : null
  );
  context.deps.findActiveTradeAuthorization = async args => ({
    id: 'authorization-1',
    status: 'active',
    intentId: args.intentId,
    policyVersion: POLICY_VERSION,
    orderFingerprint: args.orderFingerprint,
    expiresAt: '2026-07-13T14:05:00.000Z'
  });
  context.deps.fetchQuotes = async () => [{
    symbol: 'AAPL',
    price: 200,
    bidPrice: 199.95,
    askPrice: 200.05,
    timestamp: '2026-07-13T14:01:00.000Z',
    source: 'alpaca',
    isMock: false
  }];
  context.deps.claimTradeAuthorization = async args => {
    claimCount += 1;
    assert.equal(String(args.intentId), String(intent._id));
    assert.equal(args.policyVersion, POLICY_VERSION);
    return { id: 'authorization-1', status: 'consumed', orderFingerprint: args.orderFingerprint };
  };

  const result = await submitAuthorizedIntentForUser({
    userId: 'user-worker',
    intentId: intent._id,
    now: new Date('2026-07-13T14:01:00.000Z')
  }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(claimCount, 1);
  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.createdDecisions[0].status, 'submitted');
  assert.equal(context.createdIntents[0].authorizationStatus, 'consumed');
  assert.equal(context.createdIntents[0].status, 'submitted');
  assert.equal(context.createdOrders[0].orderFingerprint, context.createdIntents[0].orderFingerprint);
});

test('authorized-intent submission fails closed when authorization was already consumed', async () => {
  const context = createDeps({ approved: true });
  context.deps.getOrCreateRoboTraderSettings = async userId => ({
    userId,
    isEnabled: true,
    enabled: true,
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    approvalPolicy: { mode: 'every_trade', requireExactOrderMatch: true },
    allowedAssetClasses: ['stocks'],
    allowedSymbols: ['AAPL'],
    blockedSymbols: [],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 5,
    maxTradesPerDay: 3,
    allowFractionalShares: true,
    riskLevel: 'balanced'
  });
  await runRoboTraderForUser({
    userId: 'user-worker',
    modeOverride: 'live',
    runOnce: true,
    now: new Date('2026-07-13T14:00:00.000Z')
  }, context.deps);
  const intent = context.createdIntents[0];
  const decision = context.createdDecisions[0];
  intent.status = 'authorized';
  intent.authorizationStatus = 'active';
  context.deps.OrderIntent.findOne = async () => intent;
  context.deps.RoboTradeDecision.findOne = async () => decision;
  context.deps.findActiveTradeAuthorization = async args => ({
    id: 'authorization-1',
    status: 'active',
    intentId: args.intentId,
    policyVersion: POLICY_VERSION,
    orderFingerprint: args.orderFingerprint,
    expiresAt: '2026-07-13T14:05:00.000Z'
  });
  context.deps.fetchQuotes = async () => [{
    symbol: 'AAPL',
    price: 200,
    bidPrice: 199.95,
    askPrice: 200.05,
    timestamp: '2026-07-13T14:01:00.000Z',
    source: 'alpaca',
    isMock: false
  }];
  context.deps.claimTradeAuthorization = async () => null;

  const result = await submitAuthorizedIntentForUser({
    userId: 'user-worker',
    intentId: intent._id,
    now: new Date('2026-07-13T14:01:00.000Z')
  }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AUTHORIZATION_CLAIM_FAILED');
  assert.equal(context.brokerSubmissions.length, 0);
  assert.equal(context.createdOrders.length, 0);
  assert.equal(context.createdDecisions[0].status, 'pending_manual_approval');
  assert.equal(context.createdIntents[0].status, 'awaiting_authorization');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_authorization_claim_failed'),
    true
  );
});

test('robotrader paper preview scopes recent orders to paper environment', async () => {
  const context = createDeps({ approved: true });
  const findQueries = [];
  context.deps.RoboTradeOrder.find = query => {
    findQueries.push(query);
    return chain([]);
  };

  const result = await previewRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper' }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(findQueries.length, 1);
  assert.equal(findQueries[0].userId, 'user-worker');
  assert.equal(findQueries[0].environment, 'paper');
});

test('robotrader emergency stop cancels only locally owned open orders', async () => {
  const context = createDeps({ approved: true });
  const findQueries = [];
  const updateCalls = [];
  const canceledBrokerOrderIds = [];
  context.deps.RoboTradeOrder.find = query => {
    findQueries.push(query);
    return chain([
      {
        _id: 'local-order-by-id',
        userId: 'user-worker',
        environment: 'paper',
        broker: 'alpaca',
        externalOrderId: 'alpaca-owned-1',
        clientOrderId: 'daytrader-robotrader-owned-1',
        status: 'accepted'
      },
      {
        _id: 'local-order-by-client-id',
        userId: 'user-worker',
        environment: 'paper',
        broker: 'alpaca',
        externalOrderId: null,
        clientOrderId: 'daytrader-robotrader-owned-2',
        status: 'pending_submit'
      }
    ]);
  };
  context.deps.RoboTradeOrder.updateMany = async (query, update) => {
    updateCalls.push({ query, update });
    return { modifiedCount: 2 };
  };
  context.deps.createAlpacaBroker = ({ mode }) => {
    assert.equal(mode, 'paper');
    return {
      listOrders: async ({ status, limit }) => {
        assert.equal(status, 'open');
        assert.equal(limit, 500);
        return [
          {
            id: 'alpaca-owned-1',
            client_order_id: 'daytrader-robotrader-owned-1',
            symbol: 'AAPL',
            status: 'accepted'
          },
          {
            id: 'alpaca-owned-2',
            client_order_id: 'daytrader-robotrader-owned-2',
            symbol: 'MSFT',
            status: 'new'
          },
          {
            id: 'alpaca-other-user',
            client_order_id: 'daytrader-robotrader-other-user',
            symbol: 'TSLA',
            status: 'accepted'
          },
          {
            id: 'manual-order',
            client_order_id: 'manual-order',
            symbol: 'GOOG',
            status: 'accepted'
          }
        ];
      },
      cancelOrder: async id => {
        canceledBrokerOrderIds.push(id);
        return { id };
      }
    };
  };

  const result = await emergencyStop({
    userId: 'user-worker',
    cancelOpenOrders: true,
    environment: 'paper'
  }, context.deps);

  assert.deepEqual(canceledBrokerOrderIds, ['alpaca-owned-1', 'alpaca-owned-2']);
  assert.deepEqual(result.canceledOrderIds, ['alpaca-owned-1', 'alpaca-owned-2']);
  assert.equal(result.unownedBrokerOrders.length, 1);
  assert.equal(result.unownedBrokerOrders[0].id, 'alpaca-other-user');
  assert.equal(findQueries[0].userId, 'user-worker');
  assert.equal(findQueries[0].environment, 'paper');
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].query.userId, 'user-worker');
  assert.equal(updateCalls[0].query.environment, 'paper');
  assert.deepEqual(updateCalls[0].query.status, { $nin: ['filled', 'canceled', 'cancelled', 'expired', 'rejected'] });
  assert.equal(updateCalls[0].update.$set.status, 'canceled');
  assert.equal(
    context.auditEvents.some(event => event.eventType === 'robotrader_emergency_stop_unowned_broker_orders'),
    true
  );
});

test('robotrader worker skips when a per-user lock is already held', async () => {
  const context = createDeps({ approved: true });
  let brokerCreated = false;
  context.deps.acquireWorkerLock = async () => false;
  context.deps.releaseWorkerLock = async () => {
    throw new Error('release should not be called when lock was not acquired');
  };
  context.deps.createAlpacaBroker = () => {
    brokerCreated = true;
    throw new Error('broker should not be created');
  };

  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ROBOTRADER_LOCKED');
  assert.equal(brokerCreated, false);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_worker_locked'), true);
});

test('robotrader worker lock TTL falls back when env value is invalid', () => {
  assert.equal(resolveWorkerLockTtlMs({ ROBOTRADER_WORKER_LOCK_TTL_MS: 'bad' }), 10 * 60 * 1000);
  assert.equal(resolveWorkerLockTtlMs({ ROBOTRADER_WORKER_LOCK_TTL_MS: '1000' }), 10 * 60 * 1000);
  assert.equal(resolveWorkerLockTtlMs({ ROBOTRADER_WORKER_LOCK_TTL_MS: '45000' }), 45000);
});

test('robotrader worker converts stock orders to valid extended-hours limit orders', () => {
  const order = adaptOrderForMarketSession({
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderType: 'market',
    orderClass: 'bracket',
    timeInForce: 'day',
    qty: 1,
    estimatedNotional: 200,
    stopLoss: { stop_price: 190 },
    takeProfit: { limit_price: 215 }
  }, {
    settings: { allowExtendedHours: true },
    marketClock: { is_open: false },
    research: { price: 200 }
  });

  assert.equal(order.orderType, 'limit');
  assert.equal(order.orderClass, 'simple');
  assert.equal(order.extendedHours, true);
  assert.equal(order.limitPrice, 201);
  assert.equal(order.stopLoss, null);
  assert.equal(order.takeProfit, null);
  assert.equal(order.riskStopPrice, 190);
  assert.equal(order.requiresRegularSessionForProtection, true);
});
