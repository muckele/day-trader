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
