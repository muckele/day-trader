const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getBucketStart,
  evaluateNotionalAgainstLimits,
  runRoboTradeForUser
} = require('../services/roboTraderEngine');

test('getBucketStart returns UTC day/week/month anchors', () => {
  const now = new Date('2026-02-18T15:42:10.000Z'); // Wednesday

  const day = getBucketStart(now, 'day');
  const week = getBucketStart(now, 'week');
  const month = getBucketStart(now, 'month');

  assert.equal(day.toISOString(), '2026-02-18T00:00:00.000Z');
  assert.equal(week.toISOString(), '2026-02-16T00:00:00.000Z'); // Monday
  assert.equal(month.toISOString(), '2026-02-01T00:00:00.000Z');
});

test('evaluateNotionalAgainstLimits detects daily/weekly/monthly violations', () => {
  const result = evaluateNotionalAgainstLimits({
    settings: {
      dailyLimit: 100,
      weeklyLimit: 500,
      monthlyLimit: 1000
    },
    usageSnapshot: {
      day: { spentNotional: 95 },
      week: { spentNotional: 495 },
      month: { spentNotional: 990 }
    },
    attemptNotional: 11
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(result.violations.sort(), ['daily', 'monthly', 'weekly']);
});

test('runRoboTradeForUser skips execution and logs when robo is disabled', async () => {
  const events = [];
  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: false,
        dailyLimit: 0,
        weeklyLimit: 0,
        monthlyLimit: 0
      })
    },
    RoboUsage: {},
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboLock: {},
    paperBroker: {},
    fetchQuotes: async () => [],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'noop' })
    }
  };

  const result = await runRoboTradeForUser({ userId: 'user-disabled' }, deps);

  assert.equal(result.executed, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'ROBO_DISABLED');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'robo_disabled');
});

test('runRoboTradeForUser executes trade, updates usage, and sends email', async () => {
  const events = [];
  const usageUpdates = [];
  const emailCalls = [];
  const orderCalls = [];

  const settingsDoc = {
    enabled: true,
    dailyLimit: 500,
    weeklyLimit: 2000,
    monthlyLimit: 5000
  };

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      findOne: async () => settingsDoc
    },
    RoboUsage: {
      find: () => ({
        lean: async () => []
      }),
      updateOne: async (query, update, options) => {
        usageUpdates.push({ query, update, options });
        return { acknowledged: true };
      }
    },
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-1' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async payload => {
        orderCalls.push(payload);
        return {
          order: { id: 'order-123', notional: 100 },
          trade: { notional: 100 }
        };
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async args => {
        emailCalls.push(args);
        return { provider: 'log', messageId: 'email-1' };
      }
    }
  };

  const result = await runRoboTradeForUser(
    {
      userId: 'user-1',
      now: new Date('2026-02-20T15:00:00.000Z'),
      signal: {
        symbol: 'AAPL',
        side: 'buy',
        qty: 1,
        strategyName: 'Momentum Test'
      }
    },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(orderCalls.length, 1);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].to, 'trader@example.com');
  assert.equal(emailCalls[0].details.orderId, 'order-123');

  assert.equal(usageUpdates.length, 3);
  usageUpdates.forEach(update => {
    assert.equal(update.update.$inc.spentNotional, 100);
  });

  const eventTypes = events.map(event => event.eventType);
  assert.ok(eventTypes.includes('trade_executed'));
  assert.ok(eventTypes.includes('email_sent'));
});

test('runRoboTradeForUser skips trade when limit would be exceeded', async () => {
  const events = [];
  let placeOrderCalled = false;

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 50,
        weeklyLimit: 100,
        monthlyLimit: 200
      })
    },
    RoboUsage: {
      find: () => ({
        lean: async () => []
      }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-2' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => {
        placeOrderCalled = true;
        return { order: { id: 'never' }, trade: {} };
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-2' })
    }
  };

  const result = await runRoboTradeForUser(
    {
      userId: 'user-limit',
      signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
      now: new Date('2026-02-20T15:00:00.000Z')
    },
    deps
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'LIMIT_EXCEEDED');
  assert.equal(placeOrderCalled, false);

  assert.equal(events.some(event => event.eventType === 'trade_skipped_limit'), true);
});
