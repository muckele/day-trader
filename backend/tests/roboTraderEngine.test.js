const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getBucketStart,
  evaluateNotionalAgainstLimits,
  cleanupSignalExecutions,
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
    RoboSignalExecution: {
      create: async () => ({ _id: 'signal-disabled' }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async () => ({ acknowledged: true })
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

test('runRoboTradeForUser skips while circuit breaker is active', async () => {
  const events = [];
  let orderAttempted = false;

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 100,
        weeklyLimit: 500,
        monthlyLimit: 1000,
        failureStreak: 3,
        pausedUntil: new Date('2026-02-20T16:30:00.000Z')
      })
    },
    RoboUsage: {},
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboSignalExecution: {
      create: async () => ({ _id: 'unused' }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'unused' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => {
        orderAttempted = true;
        return {};
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'noop' })
    }
  };

  const result = await runRoboTradeForUser(
    {
      userId: 'user-paused',
      signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
      now: new Date('2026-02-20T16:00:00.000Z')
    },
    deps
  );

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'CIRCUIT_BREAKER');
  assert.equal(orderAttempted, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'trade_skipped_circuit_breaker');
});

test('runRoboTradeForUser executes trade, updates usage, and sends email', async () => {
  const events = [];
  const usageUpdates = [];
  const emailCalls = [];
  const orderCalls = [];
  const signalUpdates = [];

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
    RoboSignalExecution: {
      create: async payload => ({ _id: 'signal-1', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async (query, update) => {
        signalUpdates.push({ query, update });
        return { acknowledged: true };
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
  assert.equal(signalUpdates.length, 1);
  assert.equal(signalUpdates[0].update.$set.status, 'executed');

  const eventTypes = events.map(event => event.eventType);
  assert.ok(eventTypes.includes('trade_executed'));
  assert.ok(eventTypes.includes('email_sent'));
});

test('runRoboTradeForUser resets circuit-breaker state after successful trade', async () => {
  const settingsUpdates = [];
  const events = [];

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 500,
        weeklyLimit: 1000,
        monthlyLimit: 2000,
        failureStreak: 2,
        pausedUntil: new Date('2026-02-20T10:00:00.000Z')
      }),
      updateOne: async (query, update) => {
        settingsUpdates.push({ query, update });
        return { acknowledged: true };
      }
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
    RoboSignalExecution: {
      create: async payload => ({ _id: 'signal-reset', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-reset' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => ({
        order: { id: 'order-reset', notional: 100 },
        trade: { notional: 100 }
      })
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-reset' })
    }
  };

  const result = await runRoboTradeForUser(
    {
      userId: 'user-reset',
      signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
      now: new Date('2026-02-20T16:00:00.000Z')
    },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(settingsUpdates.length, 1);
  assert.equal(settingsUpdates[0].update.$set.failureStreak, 0);
  assert.equal(settingsUpdates[0].update.$set.pausedUntil, null);
  assert.equal(events.some(event => event.eventType === 'circuit_breaker_reset'), true);
  assert.equal(events.some(event => event.eventType === 'trade_executed'), true);
});

test('runRoboTradeForUser arms circuit breaker after consecutive execution failures', async () => {
  const settingsUpdates = [];
  const signalUpdates = [];
  const events = [];
  const originalFailureThreshold = process.env.ROBO_CIRCUIT_FAILURE_THRESHOLD;
  const originalCooldownMinutes = process.env.ROBO_CIRCUIT_COOLDOWN_MINUTES;
  process.env.ROBO_CIRCUIT_FAILURE_THRESHOLD = '3';
  process.env.ROBO_CIRCUIT_COOLDOWN_MINUTES = '60';

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 500,
        weeklyLimit: 1000,
        monthlyLimit: 2000,
        failureStreak: 2,
        pausedUntil: null
      }),
      updateOne: async (query, update) => {
        settingsUpdates.push({ query, update });
        return { acknowledged: true };
      }
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
    RoboSignalExecution: {
      create: async payload => ({ _id: 'signal-fail', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async (query, update) => {
        signalUpdates.push({ query, update });
        return { acknowledged: true };
      }
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-fail' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => {
        throw new Error('paper broker unavailable');
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-fail' })
    }
  };

  try {
    await assert.rejects(
      runRoboTradeForUser(
        {
          userId: 'user-fail',
          signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
          now: new Date('2026-02-20T16:00:00.000Z')
        },
        deps
      ),
      /paper broker unavailable/
    );
  } finally {
    if (originalFailureThreshold === undefined) delete process.env.ROBO_CIRCUIT_FAILURE_THRESHOLD;
    else process.env.ROBO_CIRCUIT_FAILURE_THRESHOLD = originalFailureThreshold;
    if (originalCooldownMinutes === undefined) delete process.env.ROBO_CIRCUIT_COOLDOWN_MINUTES;
    else process.env.ROBO_CIRCUIT_COOLDOWN_MINUTES = originalCooldownMinutes;
  }

  assert.equal(settingsUpdates.length, 1);
  assert.equal(settingsUpdates[0].update.$set.failureStreak, 3);
  assert.equal(settingsUpdates[0].update.$set.pausedUntil instanceof Date, true);
  assert.equal(signalUpdates.length, 1);
  assert.equal(signalUpdates[0].update.$set.status, 'failed');
  assert.equal(events.some(event => event.eventType === 'trade_failed'), true);
  assert.equal(events.some(event => event.eventType === 'circuit_breaker_armed'), true);
});

test('runRoboTradeForUser skips trade when limit would be exceeded', async () => {
  const events = [];
  let placeOrderCalled = false;
  const signalUpdates = [];

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
    RoboSignalExecution: {
      create: async payload => ({ _id: 'signal-2', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async (query, update) => {
        signalUpdates.push({ query, update });
        return { acknowledged: true };
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
  assert.equal(signalUpdates.length, 1);
  assert.equal(signalUpdates[0].update.$set.status, 'skipped');
  assert.equal(signalUpdates[0].update.$set.reason, 'LIMIT_EXCEEDED');

  assert.equal(events.some(event => event.eventType === 'trade_skipped_limit'), true);
});

test('runRoboTradeForUser skips duplicate signalId and does not place order', async () => {
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
        dailyLimit: 500,
        weeklyLimit: 500,
        monthlyLimit: 500
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
    RoboSignalExecution: {
      create: async () => {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      },
      findOne: () => ({
        lean: async () => ({ status: 'executed', orderId: 'existing-order-1' })
      }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-3' }),
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
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-3' })
    }
  };

  const result = await runRoboTradeForUser(
    {
      userId: 'user-duplicate',
      signal: { symbol: 'AAPL', side: 'buy', qty: 1, signalId: 'sig-123' },
      now: new Date('2026-02-20T15:00:00.000Z')
    },
    deps
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DUPLICATE_SIGNAL');
  assert.equal(result.signalId, 'sig-123');
  assert.equal(placeOrderCalled, false);
  assert.equal(events.some(event => event.eventType === 'trade_skipped_duplicate_signal'), true);
});

test('cleanupSignalExecutions deletes stale completed signal records', async () => {
  const deleteQueries = [];
  const deps = {
    RoboSignalExecution: {
      deleteMany: async query => {
        deleteQueries.push(query);
        return { deletedCount: 4 };
      }
    }
  };

  const now = new Date('2026-02-20T00:00:00.000Z');
  const result = await cleanupSignalExecutions({ olderThanDays: 30, now }, deps);

  assert.equal(result.retentionDays, 30);
  assert.equal(result.cutoff.toISOString(), '2026-01-21T00:00:00.000Z');
  assert.equal(result.deletedCount, 4);
  assert.equal(deleteQueries.length, 1);
  assert.equal(deleteQueries[0].updatedAt.$lt.toISOString(), '2026-01-21T00:00:00.000Z');
});

test('cleanupSignalExecutions falls back to default retention when invalid value is provided', async () => {
  const deleteQueries = [];
  const deps = {
    RoboSignalExecution: {
      deleteMany: async query => {
        deleteQueries.push(query);
        return { deletedCount: 0 };
      }
    }
  };

  const now = new Date('2026-02-20T00:00:00.000Z');
  const result = await cleanupSignalExecutions({ olderThanDays: 0, now }, deps);

  assert.equal(result.retentionDays, 90);
  assert.equal(result.cutoff.toISOString(), '2025-11-22T00:00:00.000Z');
  assert.equal(result.deletedCount, 0);
  assert.equal(deleteQueries.length, 1);
});
