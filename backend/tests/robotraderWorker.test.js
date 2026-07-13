const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSettings } = require('../robotrader/settingsService');
const {
  adaptOrderForMarketSession,
  cleanupRoboAuditLogs,
  cleanupRoboTradeDecisions,
  emergencyStop,
  isAmbiguousSubmitError,
  previewRoboTraderForUser,
  resolveWorkerLockTtlMs,
  runRoboTraderForUser,
  submitAuthorizedIntentForUser,
  runWorkerTick
} = require('../robotrader/worker');
const { POLICY_VERSION } = require('../services/canonicalTradingPolicyService');

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
    RoboSettings: {
      find: () => chain([{ userId: 'user-worker', isEnabled: true }]),
      updateOne: async () => ({ matchedCount: 1 })
    },
    RoboTradeDecision: {
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
    updateRoboTraderSettings: async () => ({ isEnabled: false, enabled: false }),
    buildClientOrderId: () => 'daytrader-robotrader-AAPL-fixed',
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
      throw new Error('network timeout after submit');
    }
  });

  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.createdOrders[0].status, 'pending_submit');
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_error_pending_reconciliation');
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
  assert.equal(context.createdOrders[0].reconciliationStatus, 'submit_rejected');
  assert.equal(context.createdOrders[0].discrepancy, 'Alpaca 422: qty must be whole shares for advanced order class');
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
  assert.equal(context.createdDecisions[0].error, 'Alpaca 422: qty must be whole shares for advanced order class');
  assert.equal(context.brokerSubmissions[0].clientOrderId, context.createdOrders[0].clientOrderId);
  assert.equal(context.auditEvents.some(event => event.eventType === 'robotrader_order_rejected'), true);
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

  assert.equal(result.retentionDays, 7);
  assert.equal(result.deletedCount, 42);
  assert.equal(deleteQueries[0].createdAt.$lt.toISOString(), '2026-01-03T00:00:00.000Z');
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
