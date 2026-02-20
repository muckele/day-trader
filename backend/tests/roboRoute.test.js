const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const roboEngine = require('../services/roboTraderEngine');
const roboRouter = require('../routes/robo');

function getRouteHandler(path, method) {
  const layer = roboRouter.stack.find(
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

test('GET /settings returns robo settings and usage payload', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-1' }));
  t.mock.method(roboEngine, 'getOrCreateSettings', async () => ({
    enabled: true,
    dailyLimit: 100,
    weeklyLimit: 300,
    monthlyLimit: 800,
    updatedAt: '2026-02-20T00:00:00.000Z'
  }));
  t.mock.method(roboEngine, 'getUsageSnapshotForUser', async () => ({
    day: { spentNotional: 25, remaining: 75, limit: 100 },
    week: { spentNotional: 40, remaining: 260, limit: 300 },
    month: { spentNotional: 60, remaining: 740, limit: 800 }
  }));

  const handler = getRouteHandler('/settings', 'get');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.enabled, true);
  assert.equal(res.body.settings.dailyLimit, 100);
  assert.equal(res.body.usage.day.spentNotional, 25);
});

test('PUT /settings updates robo settings and returns updated usage', async t => {
  const calls = [];
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-2' }));
  t.mock.method(roboEngine, 'updateSettingsForUser', async (userId, updates) => {
    calls.push({ userId, updates });
    return {
      enabled: false,
      dailyLimit: 50,
      weeklyLimit: 200,
      monthlyLimit: 500,
      updatedAt: '2026-02-20T00:01:00.000Z'
    };
  });
  t.mock.method(roboEngine, 'getUsageSnapshotForUser', async () => ({
    day: { spentNotional: 10, remaining: 40, limit: 50 },
    week: { spentNotional: 10, remaining: 190, limit: 200 },
    month: { spentNotional: 10, remaining: 490, limit: 500 }
  }));

  const handler = getRouteHandler('/settings', 'put');
  const req = {
    user: { username: 'matt' },
    body: {
      enabled: false,
      dailyLimit: 50,
      weeklyLimit: 200,
      monthlyLimit: 500
    }
  };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    userId: 'user-2',
    updates: {
      enabled: false,
      dailyLimit: 50,
      weeklyLimit: 200,
      monthlyLimit: 500
    }
  });
  assert.equal(res.body.settings.monthlyLimit, 500);
  assert.equal(res.body.usage.day.remaining, 40);
});

test('GET /audit returns robo audit events list', async t => {
  const auditCalls = [];
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-3' }));
  t.mock.method(roboEngine, 'getAuditLogsForUser', async (userId, filters) => {
    auditCalls.push({ userId, filters });
    return [
      {
        _id: 'event-1',
        eventType: 'trade_executed',
        payload: { symbol: 'AAPL' },
        createdAt: '2026-02-20T00:02:00.000Z'
      }
    ];
  });

  const handler = getRouteHandler('/audit', 'get');
  const req = {
    user: { username: 'matt' },
    query: { from: '2026-02-01', to: '2026-02-20', limit: '25' }
  };
  const res = createMockRes();
  let nextErr = null;

  await handler(req, res, err => {
    nextErr = err;
  });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(Array.isArray(res.body.events), true);
  assert.equal(res.body.events.length, 1);
  assert.deepEqual(auditCalls[0], {
    userId: 'user-3',
    filters: {
      from: '2026-02-01',
      to: '2026-02-20',
      limit: 25
    }
  });
});
