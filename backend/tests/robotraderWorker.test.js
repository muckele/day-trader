const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSettings } = require('../robotrader/settingsService');
const {
  adaptOrderForMarketSession,
  emergencyStop,
  isAmbiguousSubmitError,
  previewRoboTraderForUser,
  resolveWorkerLockTtlMs,
  runRoboTraderForUser,
  runWorkerTick
} = require('../robotrader/worker');

function chain(result) {
  return {
    sort: () => ({
      lean: async () => result
    })
  };
}

function createDeps({ approved = true } = {}) {
  const createdDecisions = [];
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
      indicators: {},
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
    createAlpacaBroker: () => ({
      getAccount: async () => ({ buying_power: '10000', equity: '10000', last_equity: '10000', status: 'ACTIVE' }),
      getClock: async () => ({ is_open: true }),
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
  return { deps, createdDecisions, createdOrders, auditEvents, brokerSubmissions };
}

test('robotrader worker saves approved decisions and submitted orders', async () => {
  const context = createDeps({ approved: true });
  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'paper', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(context.createdDecisions.length, 1);
  assert.equal(context.createdOrders.length, 1);
  assert.equal(context.createdOrders[0].externalOrderId, 'alpaca-order-1');
  assert.equal(context.createdOrders[0].clientOrderId, 'daytrader-robotrader-AAPL-fixed');
  assert.equal(context.brokerSubmissions.length, 1);
  assert.equal(context.brokerSubmissions[0].clientOrderId, context.createdOrders[0].clientOrderId);
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

  const result = await runRoboTraderForUser({ userId: 'user-worker', modeOverride: 'live', runOnce: true }, context.deps);

  assert.equal(result.ok, true);
  assert.equal(findQueries.length, 1);
  assert.equal(findQueries[0].userId, 'user-worker');
  assert.equal(findQueries[0].environment, 'live');
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
