const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileRoboOrders,
  submitProtectiveStopForEntry
} = require('../robotrader/reconciliation');

test('robotrader reconciliation updates local order status from Alpaca', async () => {
  const saved = [];
  const localOrder = {
    _id: 'local-order-1',
    userId: 'user-1',
    intentId: 'intent-1',
    decisionId: 'decision-1',
    environment: 'paper',
    externalOrderId: 'alpaca-order-1',
    clientOrderId: 'robotrader-client-1',
    status: 'accepted',
    save: async function save() {
      saved.push({ status: this.status, filledQty: this.filledQty, reconciliationStatus: this.reconciliationStatus });
      return this;
    }
  };
  const auditEvents = [];
  const intentUpdates = [];
  const decisionUpdates = [];
  const deps = {
    OrderIntent: {
      updateOne: async (query, update) => {
        intentUpdates.push({ query, update });
      }
    },
    RoboTradeDecision: {
      updateOne: async (query, update) => {
        decisionUpdates.push({ query, update });
      }
    },
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: 'local-order-1' }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => {
        auditEvents.push(payload);
        return payload;
      }
    },
    createAlpacaBroker: () => ({
      getOrder: async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'robotrader-client-1',
        status: 'filled',
        filled_qty: '1',
        filled_avg_price: '201.5'
      }),
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);
  assert.equal(result.updatedCount, 1);
  assert.equal(saved[0].status, 'filled');
  assert.equal(saved[0].filledQty, 1);
  assert.equal(saved[0].reconciliationStatus, 'matched');
  assert.equal(intentUpdates[0].update.$set.status, 'filled');
  assert.equal(decisionUpdates[0].update.$set.status, 'filled');
  assert.equal(auditEvents[0].eventType, 'robotrader_order_status_changed');
});

test('robotrader reconciliation can recover orders by client order id', async () => {
  const saved = [];
  const localOrder = {
    _id: 'local-order-client-1',
    userId: 'user-1',
    environment: 'paper',
    externalOrderId: null,
    clientOrderId: 'daytrader-robotrader-AAPL-fixed',
    status: 'pending_submit',
    save: async function save() {
      saved.push({
        externalOrderId: this.externalOrderId,
        status: this.status,
        reconciliationStatus: this.reconciliationStatus
      });
      return this;
    }
  };
  const deps = {
    RoboTradeOrder: {
      find: () => ({
        sort: () => ({
          limit: async () => [localOrder]
        })
      }),
      findOne: async () => ({ _id: 'local-order-client-1' }),
      create: async payload => payload
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async () => {
        throw new Error('should use client order lookup');
      },
      getOrderByClientOrderId: async clientOrderId => ({
        id: 'alpaca-order-by-client-1',
        client_order_id: clientOrderId,
        status: 'accepted',
        submitted_at: '2026-05-20T12:00:00.000Z'
      }),
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper' }, deps);

  assert.equal(result.updatedCount, 1);
  assert.equal(saved[0].externalOrderId, 'alpaca-order-by-client-1');
  assert.equal(saved[0].status, 'accepted');
  assert.equal(saved[0].reconciliationStatus, 'matched');
});

test('robotrader reconciliation scopes local orders by user and does not create unattributed orphans for user runs', async () => {
  let localOrderQuery = null;
  let orphanCreateAttempted = false;
  const deps = {
    RoboTradeOrder: {
      find: query => {
        localOrderQuery = query;
        return {
          sort: () => ({
            limit: async () => []
          })
        };
      },
      findOne: () => ({
        lean: async () => null
      }),
      create: async () => {
        orphanCreateAttempted = true;
        throw new Error('user-scoped reconciliation should not create unattributed orphan records');
      }
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    createAlpacaBroker: () => ({
      getOrder: async () => null,
      listOrders: async () => [{
        id: 'alpaca-orphan-1',
        client_order_id: 'daytrader-robotrader-AAPL-20260520120000-test',
        symbol: 'AAPL',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        status: 'filled'
      }]
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper', userId: 'user-1' }, deps);

  assert.equal(localOrderQuery.userId, 'user-1');
  assert.equal(result.discrepancyCount, 1);
  assert.equal(result.discrepancies[0].type, 'unattributed_alpaca_order');
  assert.equal(orphanCreateAttempted, false);
});

test('robotrader reconciliation submits protective stop for filled simple fractional entries', async () => {
  const filledEntry = {
    _id: 'parent-order-1',
    userId: 'user-1',
    accountId: 'default',
    decisionId: 'decision-1',
    environment: 'paper',
    broker: 'alpaca',
    externalOrderId: 'alpaca-parent-1',
    clientOrderId: 'daytrader-robotrader-AAPL-parent',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderType: 'market',
    orderClass: 'simple',
    timeInForce: 'day',
    qty: 1.25,
    filledQty: 1.25,
    status: 'filled',
    riskStopPrice: 190,
    riskTakeProfitPrice: 215,
    strategyId: 'TEST_STRATEGY',
    riskChecks: []
  };
  const createdOrders = [];
  const auditEvents = [];
  const deps = {
    RoboTradeOrder: {
      find: query => ({
        sort: () => ({
          limit: async () => {
            if (query.status === 'filled') return [filledEntry];
            return [];
          }
        })
      }),
      findOne: () => ({
        lean: async () => null
      }),
      create: async payload => {
        const doc = {
          _id: `protective-${createdOrders.length + 1}`,
          ...payload,
          save: async function save() {
            createdOrders[createdOrders.length - 1] = this;
            return this;
          }
        };
        createdOrders.push(doc);
        return doc;
      }
    },
    RoboAuditLog: {
      create: async payload => {
        auditEvents.push(payload);
        return payload;
      }
    },
    buildClientOrderId: () => 'daytrader-robotrader-stop-AAPL-fixed',
    createAlpacaBroker: () => ({
      getPositions: async () => [{ symbol: 'AAPL', qty: '1.25' }],
      submitOrder: async input => {
        assert.equal(input.symbol, 'AAPL');
        assert.equal(input.side, 'sell');
        assert.equal(input.orderType, 'stop');
        assert.equal(input.orderClass, 'simple');
        assert.equal(input.timeInForce, 'day');
        assert.equal(input.qty, 1.25);
        assert.equal(input.stopPrice, 190);
        return {
          payload: {
            symbol: 'AAPL',
            side: 'sell',
            type: 'stop',
            qty: '1.25',
            stop_price: '190',
            client_order_id: input.clientOrderId
          },
          order: {
            id: 'alpaca-stop-1',
            client_order_id: input.clientOrderId,
            status: 'accepted',
            submitted_at: '2026-05-24T17:00:00.000Z'
          }
        };
      },
      listOrders: async () => []
    })
  };

  const result = await reconcileRoboOrders({ mode: 'paper', userId: 'user-1' }, deps);

  assert.equal(result.protectiveStopsSubmitted, 1);
  assert.equal(createdOrders.length, 1);
  assert.equal(createdOrders[0].parentOrderId, 'parent-order-1');
  assert.equal(createdOrders[0].parentClientOrderId, 'daytrader-robotrader-AAPL-parent');
  assert.equal(createdOrders[0].exitReason, 'stop_loss');
  assert.equal(createdOrders[0].externalOrderId, 'alpaca-stop-1');
  assert.equal(createdOrders[0].status, 'accepted');
  assert.equal(createdOrders[0].reconciliationStatus, 'matched');
  assert.equal(auditEvents.some(event => event.eventType === 'robotrader_protective_stop_submitted'), true);
});

test('robotrader protective stop creation handles duplicate parent exit races', async () => {
  let findOneCalls = 0;
  let submitAttempted = false;
  const existingStop = {
    _id: 'existing-stop-1',
    parentOrderId: 'parent-order-1',
    exitReason: 'stop_loss',
    status: 'accepted'
  };
  const deps = {
    RoboTradeOrder: {
      findOne: () => ({
        lean: async () => {
          findOneCalls += 1;
          return findOneCalls === 1 ? null : existingStop;
        }
      }),
      create: async () => {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
    },
    RoboAuditLog: {
      create: async payload => payload
    },
    buildClientOrderId: () => 'daytrader-robotrader-stop-AAPL-fixed'
  };

  const result = await submitProtectiveStopForEntry({
    _id: 'parent-order-1',
    userId: 'user-1',
    accountId: 'default',
    environment: 'paper',
    clientOrderId: 'daytrader-robotrader-AAPL-parent',
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    orderClass: 'simple',
    status: 'filled',
    qty: 1.25,
    filledQty: 1.25,
    riskStopPrice: 190
  }, {
    positions: [{ symbol: 'AAPL', qty: '1.25' }],
    broker: {
      submitOrder: async () => {
        submitAttempted = true;
      }
    }
  }, deps);

  assert.equal(result, existingStop);
  assert.equal(submitAttempted, false);
});
