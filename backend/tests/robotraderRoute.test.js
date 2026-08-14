const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const RoboAuditLog = require('../models/RoboAuditLog');
const OrderIntent = require('../models/OrderIntent');
const TradeAuthorization = require('../models/TradeAuthorization');
const RoboExposureSnapshot = require('../models/RoboExposureSnapshot');
const RoboCanaryDossier = require('../models/RoboCanaryDossier');
const {
  SPECIFIC_ORDER_CONFIRMATION_TEXT
} = require('../services/tradeAuthorizationService');
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

function allowBrokerOperator(t, usernames = 'matt') {
  const previous = process.env.ROBOTRADER_OPERATOR_USERNAMES;
  process.env.ROBOTRADER_OPERATOR_USERNAMES = usernames;
  t.after(() => {
    if (previous === undefined) delete process.env.ROBOTRADER_OPERATOR_USERNAMES;
    else process.env.ROBOTRADER_OPERATOR_USERNAMES = previous;
  });
}

test('Sprint 6 through 9 supervision, dossier, promotion, strategy, and discrepancy endpoints are registered', () => {
  getRouteHandler('/live-activation/heartbeat', 'post');
  getRouteHandler('/live-activation/dossier', 'get');
  getRouteHandler('/live-activation/dossier/seal', 'post');
  getRouteHandler('/live-activation/dossiers', 'get');
  getRouteHandler('/live-activation/dossiers/:canaryId', 'get');
  getRouteHandler('/live-promotion', 'get');
  getRouteHandler('/live-promotions', 'get');
  getRouteHandler('/strategy-evidence', 'get');
  getRouteHandler('/execution-discrepancy', 'get');
  getRouteHandler('/live-promotion/approve', 'post');
  getRouteHandler('/live-promotion/revoke', 'post');
});

test('GET /robotrader/live-activation/dossiers/:canaryId scopes archived evidence to the user', async t => {
  const userId = '507f1f77bcf86cd799439090';
  let dossierQuery = null;
  t.mock.method(User, 'findOne', async () => ({ _id: userId }));
  t.mock.method(RoboCanaryDossier, 'findOne', query => {
    dossierQuery = query;
    return { lean: async () => ({ canaryId: query.canaryId, dossierHash: 'sealed-hash' }) };
  });

  const handler = getRouteHandler('/live-activation/dossiers/:canaryId', 'get');
  const req = { user: { username: 'matt' }, params: { canaryId: 'canary-1' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(dossierQuery.userId, userId);
  assert.equal(dossierQuery.canaryId, 'canary-1');
  assert.equal(res.body.dossier.dossierHash, 'sealed-hash');
});

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

test('PUT /robotrader/settings rejects live mode for a non-operator', async t => {
  t.mock.method(User, 'findOne', async () => ({
    _id: '507f1f77bcf86cd799439099',
    username: 'non-operator'
  }));
  t.mock.method(RoboSettings, 'findOne', async () => ({
    isEnabled: false,
    mode: 'paper',
    liveTradingExplicitlyEnabled: false,
    allowedAssetClasses: ['stocks']
  }));

  const handler = getRouteHandler('/settings', 'put');
  const req = {
    user: { username: 'non-operator' },
    body: { mode: 'live', liveTradingExplicitlyEnabled: true }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /broker-operator/i);
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

test('POST /robotrader/intents/:intentId/authorize binds approval to the exact fingerprint', async t => {
  const userId = '507f1f77bcf86cd799439020';
  const intentId = '507f1f77bcf86cd799439021';
  const authorizationId = '507f1f77bcf86cd799439022';
  const intent = {
    _id: intentId,
    userId,
    accountId: 'user:matt',
    environment: 'live',
    status: 'awaiting_authorization',
    orderFingerprint: 'fingerprint-1',
    policyVersion: 'controlled-live-readiness-v2',
    approvalPolicy: { mode: 'every_trade', authorizationTtlSeconds: 300 },
    save: async function save() { return this; }
  };
  t.mock.method(User, 'findOne', async () => ({ _id: userId }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: async () => ({
      mode: 'live',
      liveTradingExplicitlyEnabled: true,
      approvalPolicy: { mode: 'every_trade', authorizationTtlSeconds: 300 },
      allowedAssetClasses: ['stocks']
    })
  }));
  t.mock.method(OrderIntent, 'findOne', async () => intent);
  t.mock.method(TradeAuthorization, 'updateMany', async () => ({ modifiedCount: 0 }));
  t.mock.method(TradeAuthorization, 'findOne', async () => null);
  t.mock.method(TradeAuthorization, 'create', async payload => ({
    _id: authorizationId,
    ...payload
  }));
  t.mock.method(RoboAuditLog, 'create', async payload => payload);

  const handler = getRouteHandler('/intents/:intentId/authorize', 'post');
  const req = {
    user: { username: 'matt' },
    params: { intentId },
    body: {
      orderFingerprint: 'fingerprint-1',
      confirmation: SPECIFIC_ORDER_CONFIRMATION_TEXT
    }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(intent.status, 'authorized');
  assert.equal(intent.authorizationStatus, 'active');
  assert.equal(String(intent.authorizationId), authorizationId);
  assert.equal(res.body.authorization.orderFingerprint, 'fingerprint-1');
});

test('trade authorization rejects a stale live opt-in while settings are in paper mode', async t => {
  const userId = '507f1f77bcf86cd799439023';
  const intentId = '507f1f77bcf86cd799439024';
  t.mock.method(User, 'findOne', async () => ({ _id: userId }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: async () => ({
      mode: 'paper',
      liveTradingExplicitlyEnabled: true,
      approvalPolicy: { mode: 'every_trade' },
      allowedAssetClasses: ['stocks']
    })
  }));
  t.mock.method(OrderIntent, 'findOne', async () => ({
    _id: intentId,
    userId,
    environment: 'live',
    status: 'awaiting_authorization',
    orderFingerprint: 'fingerprint-stale-opt-in',
    policyVersion: 'controlled-live-readiness-v2'
  }));

  const handler = getRouteHandler('/intents/:intentId/authorize', 'post');
  const req = {
    user: { username: 'matt' },
    params: { intentId },
    body: {
      orderFingerprint: 'fingerprint-stale-opt-in',
      confirmation: SPECIFIC_ORDER_CONFIRMATION_TEXT
    }
  };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /explicit live trading opt-in/);
});

test('GET /robotrader/approval-queue returns live intents with their latest authorization', async t => {
  const userId = '507f1f77bcf86cd799439025';
  const intentId = '507f1f77bcf86cd799439026';
  t.mock.method(User, 'findOne', async () => ({ _id: userId }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: async () => ({
      mode: 'live',
      liveTradingExplicitlyEnabled: true,
      allowedAssetClasses: ['stocks']
    })
  }));
  t.mock.method(OrderIntent, 'find', () => ({
    sort: () => ({
      limit: () => ({
        lean: async () => [{
          _id: intentId,
          userId,
          environment: 'live',
          status: 'authorized',
          symbol: 'AAPL'
        }]
      })
    })
  }));
  t.mock.method(TradeAuthorization, 'find', query => {
    if (query.status === 'active') {
      return { select: () => ({ lean: async () => [] }) };
    }
    return {
      sort: () => ({
        lean: async () => [{
          _id: '507f1f77bcf86cd799439027',
          intentId,
          status: 'active'
        }]
      })
    };
  });

  const handler = getRouteHandler('/approval-queue', 'get');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.intents.length, 1);
  assert.equal(res.body.intents[0].latestAuthorization.status, 'active');
});

test('GET /robotrader/exposure scopes snapshot history by environment', async t => {
  const userId = '507f1f77bcf86cd799439028';
  let exposureQuery = null;
  t.mock.method(User, 'findOne', async () => ({ _id: userId }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: async () => ({
      mode: 'shadow',
      allowedAssetClasses: ['stocks']
    })
  }));
  t.mock.method(RoboExposureSnapshot, 'find', query => {
    exposureQuery = query;
    return {
      sort: () => ({
        limit: () => ({
          lean: async () => [{ _id: 'exposure-route-1', environment: 'shadow', grossExposurePct: 20 }]
        })
      })
    };
  });

  const handler = getRouteHandler('/exposure', 'get');
  const req = { user: { username: 'matt' }, query: { environment: 'shadow' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(exposureQuery.userId, userId);
  assert.equal(exposureQuery.environment, 'shadow');
  assert.equal(res.body.latest.grossExposurePct, 20);
});

test('GET /robotrader/reconciliation-status summarizes local order matching state', async t => {
  allowBrokerOperator(t);
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
  allowBrokerOperator(t);
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

test('non-operators cannot read or archive deployment-wide reconciliation orphans', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439099' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({ mode: 'paper', liveTradingExplicitlyEnabled: false, allowedAssetClasses: ['stocks'] })
  }));
  const findQueries = [];
  const updateQueries = [];
  t.mock.method(RoboTradeOrder, 'find', query => {
    findQueries.push(query);
    return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) };
  });
  t.mock.method(RoboTradeOrder, 'countDocuments', async () => 0);
  t.mock.method(RoboTradeOrder, 'updateMany', async query => {
    updateQueries.push(query);
    return { modifiedCount: 1 };
  });
  t.mock.method(RoboAuditLog, 'create', async payload => payload);

  const statusRes = createMockRes();
  await getRouteHandler('/reconciliation-status', 'get')(
    { user: { username: 'ordinary-user' }, query: {} },
    statusRes,
    err => { throw err; }
  );
  assert.equal(statusRes.body.brokerOperator, false);
  assert.equal(findQueries.length, 1);
  assert.equal(findQueries[0].userId, '507f1f77bcf86cd799439099');

  const archiveRes = createMockRes();
  await getRouteHandler('/reconciliation/archive-history', 'post')(
    { user: { username: 'ordinary-user' }, body: { environment: 'paper' } },
    archiveRes,
    err => { throw err; }
  );
  assert.equal(archiveRes.body.archivedOrphanOrders, 0);
  assert.equal(updateQueries.length, 1);
  assert.equal(updateQueries[0].userId, '507f1f77bcf86cd799439099');
});

test('deployment broker position close rejects non-operators before any broker call', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: '507f1f77bcf86cd799439098' }));
  const req = {
    user: { username: 'ordinary-user' },
    params: { symbol: 'AAPL' },
    body: { environment: 'paper', confirmation: 'Close this broker position.' }
  };
  const res = createMockRes();
  let nextErr = null;
  await getRouteHandler('/positions/:symbol/close', 'post')(req, res, err => { nextErr = err; });
  assert.equal(nextErr?.status, 403);
  assert.equal(nextErr?.code, 'BROKER_OPERATOR_REQUIRED');
});

test('live order replacement is fail-closed before external id, operator, settings, payload, or mutation', async t => {
  const userId = '507f1f77bcf86cd799439097';
  const previousLiveFlag = process.env.LIVE_TRADING_ENABLED;
  const previousOperators = process.env.ROBOTRADER_OPERATOR_USERNAMES;
  let activeOrder = null;
  let activeSettings = null;
  let settingsReads = 0;
  let saveCalls = 0;
  let auditCalls = 0;

  t.after(() => {
    if (previousLiveFlag === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = previousLiveFlag;
    if (previousOperators === undefined) delete process.env.ROBOTRADER_OPERATOR_USERNAMES;
    else process.env.ROBOTRADER_OPERATOR_USERNAMES = previousOperators;
  });
  t.mock.method(User, 'findOne', async () => ({ _id: userId, username: 'matt' }));
  t.mock.method(RoboTradeOrder, 'findOne', async query => {
    assert.equal(query.userId, userId);
    return activeOrder;
  });
  t.mock.method(RoboSettings, 'findOne', () => {
    settingsReads += 1;
    return { sort: async () => activeSettings };
  });
  t.mock.method(RoboAuditLog, 'create', async payload => {
    auditCalls += 1;
    return payload;
  });

  const cases = [
    {
      name: 'all legacy gates enabled with widening economics',
      liveFlag: 'true',
      operators: 'matt',
      settings: { mode: 'live', liveTradingExplicitlyEnabled: true },
      externalOrderId: 'alpaca-live-1',
      body: {
        qty: 100000,
        limitPrice: 9999,
        stopPrice: 0.01,
        timeInForce: 'GTC',
        clientOrderId: 'replacement-client-id'
      }
    },
    {
      name: 'deployment flag disabled with invalid payload',
      liveFlag: 'false',
      operators: 'matt',
      settings: { mode: 'live', liveTradingExplicitlyEnabled: true },
      externalOrderId: 'alpaca-live-2',
      body: { qty: -1, trailPrice: 1, trailPercent: 2 }
    },
    {
      name: 'non-operator and empty payload',
      liveFlag: 'true',
      operators: 'ordinary-user',
      settings: { mode: 'live', liveTradingExplicitlyEnabled: true },
      externalOrderId: 'alpaca-live-3',
      body: {}
    },
    {
      name: 'settings disabled and external order id missing',
      liveFlag: 'true',
      operators: 'matt',
      settings: { mode: 'paper', liveTradingExplicitlyEnabled: false },
      externalOrderId: null,
      body: { symbol: 'MSFT', side: 'sell' }
    }
  ];
  const handler = getRouteHandler('/orders/:orderId/replace', 'post');

  for (const scenario of cases) {
    process.env.LIVE_TRADING_ENABLED = scenario.liveFlag;
    process.env.ROBOTRADER_OPERATOR_USERNAMES = scenario.operators;
    activeSettings = scenario.settings;
    activeOrder = {
      environment: 'live',
      externalOrderId: scenario.externalOrderId,
      clientOrderId: 'original-client-id',
      symbol: 'AAPL',
      qty: 1,
      limitPrice: 100,
      stopPrice: 90,
      timeInForce: 'day',
      orderFingerprint: 'original-fingerprint',
      status: 'accepted',
      reconciliationStatus: 'matched',
      lastReconciledAt: new Date('2026-01-02T03:04:05.000Z'),
      alpacaResponse: { id: scenario.externalOrderId },
      save: async function save() {
        saveCalls += 1;
        return this;
      }
    };
    const originalState = {
      externalOrderId: activeOrder.externalOrderId,
      clientOrderId: activeOrder.clientOrderId,
      qty: activeOrder.qty,
      limitPrice: activeOrder.limitPrice,
      stopPrice: activeOrder.stopPrice,
      timeInForce: activeOrder.timeInForce,
      orderFingerprint: activeOrder.orderFingerprint,
      status: activeOrder.status,
      reconciliationStatus: activeOrder.reconciliationStatus,
      lastReconciledAt: activeOrder.lastReconciledAt,
      alpacaResponse: activeOrder.alpacaResponse
    };
    const res = createMockRes();
    let nextErr = null;

    await handler(
      {
        user: { username: 'matt' },
        params: { orderId: `local-${scenario.name}` },
        body: scenario.body
      },
      res,
      err => { nextErr = err; }
    );

    assert.equal(nextErr, null, scenario.name);
    assert.equal(res.statusCode, 409, scenario.name);
    assert.deepEqual(res.body, {
      message: 'Live order replacement is disabled until amendments use a new immutable, re-authorized intent.',
      code: 'LIVE_ORDER_REPLACEMENT_DISABLED'
    }, scenario.name);
    assert.deepEqual({
      externalOrderId: activeOrder.externalOrderId,
      clientOrderId: activeOrder.clientOrderId,
      qty: activeOrder.qty,
      limitPrice: activeOrder.limitPrice,
      stopPrice: activeOrder.stopPrice,
      timeInForce: activeOrder.timeInForce,
      orderFingerprint: activeOrder.orderFingerprint,
      status: activeOrder.status,
      reconciliationStatus: activeOrder.reconciliationStatus,
      lastReconciledAt: activeOrder.lastReconciledAt,
      alpacaResponse: activeOrder.alpacaResponse
    }, originalState, scenario.name);
  }

  assert.equal(settingsReads, 0);
  assert.equal(saveCalls, 0);
  assert.equal(auditCalls, 0);
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

test('POST /robotrader/run-once-paper is disabled in favor of frozen preview and explicit submit', async () => {
  const handler = getRouteHandler('/run-once-paper', 'post');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'FROZEN_PAPER_INTENT_REQUIRED');
  assert.match(res.body.message, /Preview and explicitly submit/);
});

test('POST /robotrader/run-once-shadow requires shadow mode', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-shadow-mode' }));
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: () => ({
      mode: 'paper',
      isEnabled: true,
      enabled: true,
      allowedAssetClasses: ['stocks']
    })
  }));

  const handler = getRouteHandler('/run-once-shadow', 'post');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /only available.*shadow mode/i);
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
  assert.equal(res.body.brokerAccountRestricted, true);
  assert.equal(res.body.account, null);
  assert.deepEqual(res.body.positions, []);
});
