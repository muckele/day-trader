const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileRoboOrders } = require('../robotrader/reconciliation');

test('robotrader reconciliation updates local order status from Alpaca', async () => {
  const saved = [];
  const localOrder = {
    _id: 'local-order-1',
    userId: 'user-1',
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
  const deps = {
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
  assert.equal(auditEvents[0].eventType, 'robotrader_order_status_changed');
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
