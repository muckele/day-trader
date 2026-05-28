const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const robotraderRouter = require('../routes/robotrader');

function getRouteHandler(path, method) {
  const layer = robotraderRouter.stack.find(
    item => item.route && item.route.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('GET /robotrader/settings returns extended settings payload', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-1' }));
  t.mock.method(RoboSettings, 'findOne', async () => ({
    isEnabled: false,
    mode: 'paper',
    allowedAssetClasses: ['stocks']
  }));

  const handler = getRouteHandler('/settings', 'get');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.mode, 'paper');
  assert.ok(res.body.capabilities.stocks);
});

test('POST /robotrader/reconcile blocks requested live mode without explicit opt-in', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-live-block' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));

  const handler = getRouteHandler('/reconcile', 'post');
  const req = {
    user: { username: 'matt' },
    body: { mode: 'live' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /explicit live trading opt-in/);
});

test('GET /robotrader/decisions/:decisionId returns decision detail with linked orders', async t => {
  const decisionId = '507f1f77bcf86cd799439011';
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439012' }));
  t.mock.method(RoboTradeDecision, 'findOne', () => ({
    lean: async () => ({
      _id: decisionId,
      userId: '507f1f77bcf86cd799439012',
      symbol: 'AAPL',
      riskChecks: []
    })
  }));
  t.mock.method(RoboTradeOrder, 'find', () => ({
    sort: () => ({
      lean: async () => [{ _id: 'order-route-1', decisionId, symbol: 'AAPL' }]
    })
  }));

  const handler = getRouteHandler('/decisions/:decisionId', 'get');
  const req = {
    user: { username: 'matt' },
    params: { decisionId }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decision.symbol, 'AAPL');
  assert.equal(res.body.orders.length, 1);
});

test('GET /robotrader/reconciliation-status summarizes local order matching state', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439013' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));
  const findQueries = [];
  t.mock.method(RoboTradeOrder, 'find', query => ({
    sort: () => {
      findQueries.push(query);
      return {
        limit: () => ({
          lean: async () => query.userId === null
          ? [
              {
                _id: 'orphan-reconcile-1',
                symbol: 'GOOG',
                status: 'filled',
                reconciliationStatus: 'orphan_alpaca_order',
                discrepancy: 'Alpaca order was not found in local RoboTradeOrder records.',
                lastReconciledAt: new Date('2026-05-20T12:01:00.000Z')
              }
            ]
          : [
              {
                _id: 'order-reconcile-1',
                symbol: 'MSFT',
                status: 'accepted',
                reconciliationStatus: 'matched',
                lastReconciledAt: new Date('2026-05-20T12:00:00.000Z')
              },
              {
                _id: 'order-reconcile-2',
                symbol: 'AAPL',
                status: 'pending_submit',
                reconciliationStatus: 'missing_alpaca_confirmation',
                discrepancy: 'Local RoboTradeOrder does not have an Alpaca order id.'
              },
              {
                _id: 'order-reconcile-3',
                symbol: 'AMZN',
                status: 'rejected',
                reconciliationStatus: 'submit_rejected',
                discrepancy: 'Alpaca 422: qty must be whole shares for advanced order class.'
              }
            ]
        })
      };
    }
  }));
  t.mock.method(RoboTradeOrder, 'countDocuments', async query => {
    assert.equal(query.reconciliationArchivedAt.$ne, null);
    return query.userId === null ? 2 : 5;
  });

  const handler = getRouteHandler('/reconciliation-status', 'get');
  const req = {
    user: { username: 'matt' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.total, 2);
  assert.equal(res.body.summary.pending, 1);
  assert.equal(res.body.summary.discrepancies, 1);
  assert.equal(res.body.summary.missingAlpacaConfirmation, 1);
  assert.equal(res.body.summary.orphanAlpacaOrders, 0);
  assert.equal(res.body.historicalSummary.total, 2);
  assert.equal(res.body.historicalSummary.discrepancies, 2);
  assert.equal(res.body.historicalSummary.orphanAlpacaOrders, 1);
  assert.equal(res.body.historicalSummary.submitRejected, 1);
  assert.equal(res.body.historicalSummary.archived, 7);
  assert.equal(res.body.latestDiscrepancies.length, 1);
  assert.equal(res.body.historicalDiscrepancies.length, 2);
  assert.equal(findQueries[0].environment, 'paper');
  assert.equal(findQueries[0].userId, '507f1f77bcf86cd799439013');
  assert.equal(findQueries[0].reconciliationArchivedAt, null);
  assert.equal(findQueries[1].environment, 'paper');
  assert.equal(findQueries[1].reconciliationArchivedAt, null);
});

test('POST /robotrader/reconciliation/archive-history archives terminal historical records only', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439016' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));
  const updateQueries = [];
  t.mock.method(RoboTradeOrder, 'updateMany', async (query, update) => {
    updateQueries.push({ query, update });
    assert.ok(update.$set.reconciliationArchivedAt instanceof Date);
    assert.equal(String(update.$set.reconciliationArchivedBy), '507f1f77bcf86cd799439016');
    return { modifiedCount: query.userId === null ? 11 : 104 };
  });
  t.mock.method(RoboAuditLog, 'create', async payload => payload);

  const handler = getRouteHandler('/reconciliation/archive-history', 'post');
  const req = {
    user: { username: 'matt' },
    body: { environment: 'paper', reason: 'Reviewed historical records.' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.archivedUserOrders, 104);
  assert.equal(res.body.archivedOrphanOrders, 11);
  assert.equal(res.body.archivedCount, 115);
  assert.equal(updateQueries.length, 2);
  assert.equal(updateQueries[0].query.userId, '507f1f77bcf86cd799439016');
  assert.equal(updateQueries[0].query.environment, 'paper');
  assert.equal(updateQueries[0].query.reconciliationArchivedAt, null);
  assert.deepEqual(updateQueries[0].query.discrepancy.$nin, [null, '']);
  assert.equal(updateQueries[1].query.userId, null);
  assert.ok(updateQueries[1].query.$or.some(item => (
    Array.isArray(item.reconciliationStatus?.$in)
    && item.reconciliationStatus.$in.includes('orphan_alpaca_order')
  )));
});

test('GET /robotrader/decisions and orders scope list queries by environment', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439014' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));
  let decisionsQuery = null;
  let ordersQuery = null;
  t.mock.method(RoboTradeDecision, 'find', query => {
    decisionsQuery = query;
    return {
      sort: () => ({
        limit: () => ({
          lean: async () => []
        })
      })
    };
  });
  t.mock.method(RoboTradeOrder, 'find', query => {
    ordersQuery = query;
    return {
      sort: () => ({
        limit: () => ({
          lean: async () => []
        })
      })
    };
  });

  const decisionsHandler = getRouteHandler('/decisions', 'get');
  const ordersHandler = getRouteHandler('/orders', 'get');
  const req = {
    user: { username: 'matt' },
    query: { environment: 'paper', limit: '25' }
  };
  const decisionsRes = createMockRes();
  const ordersRes = createMockRes();
  let nextErr = null;

  await decisionsHandler(req, decisionsRes, err => { nextErr = err; });
  await ordersHandler(req, ordersRes, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(decisionsRes.statusCode, 200);
  assert.equal(ordersRes.statusCode, 200);
  assert.equal(decisionsQuery.userId, '507f1f77bcf86cd799439014');
  assert.equal(decisionsQuery.environment, 'paper');
  assert.equal(ordersQuery.userId, '507f1f77bcf86cd799439014');
  assert.equal(ordersQuery.environment, 'paper');
});

test('POST /robotrader/run-once-paper requires RoboTrader to be enabled', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-run-disabled' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      isEnabled: false,
      enabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));

  const handler = getRouteHandler('/run-once-paper', 'post');
  const req = {
    user: { username: 'matt' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Enable RoboTrader/);
});

test('GET /robotrader/performance blocks live account reads without explicit opt-in', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-live-performance-block' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));

  const handler = getRouteHandler('/performance', 'get');
  const req = {
    user: { username: 'matt' },
    query: { environment: 'live' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /explicit live trading opt-in/);
});

test('GET /robotrader/performance scopes decisions and orders by environment', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439015' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: false,
      allowedAssetClasses: ['stocks']
    })
  }));
  let decisionsQuery = null;
  let ordersQuery = null;
  t.mock.method(RoboTradeDecision, 'find', query => {
    decisionsQuery = query;
    return {
      sort: () => ({
        limit: () => ({
          lean: async () => []
        })
      })
    };
  });
  t.mock.method(RoboTradeOrder, 'find', query => {
    ordersQuery = query;
    return {
      sort: () => ({
        limit: () => ({
          lean: async () => []
        })
      })
    };
  });

  const handler = getRouteHandler('/performance', 'get');
  const req = {
    user: { username: 'matt' },
    query: { environment: 'paper' }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(decisionsQuery.userId, '507f1f77bcf86cd799439015');
  assert.equal(decisionsQuery.environment, 'paper');
  assert.equal(ordersQuery.userId, '507f1f77bcf86cd799439015');
  assert.equal(ordersQuery.environment, 'paper');
});
