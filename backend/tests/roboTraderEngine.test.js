const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {
  getBucketStart,
  evaluateNotionalAgainstLimits,
  cleanupSignalExecutions,
  buildAutoSignalForUser,
  runSchedulerTick,
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

test('buildAutoSignalForUser selects strongest candidate from multi-symbol universe with sell support', async () => {
  const previousUniverse = process.env.ROBO_SIGNAL_UNIVERSE;
  const previousSides = process.env.ROBO_ALLOWED_SIDES;
  const previousThreshold = process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;
  const previousTargetNotional = process.env.ROBO_TARGET_NOTIONAL;

  process.env.ROBO_SIGNAL_UNIVERSE = 'AAPL,TLT,QQQ';
  process.env.ROBO_ALLOWED_SIDES = 'buy,sell';
  process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = '0.4';
  process.env.ROBO_TARGET_NOTIONAL = '900';

  const deps = {
    fetchQuotes: async () => ([
      { symbol: 'AAPL', price: 180, changePercent: 0.1 },
      { symbol: 'TLT', price: 90, changePercent: -1.2 },
      { symbol: 'QQQ', price: 450, changePercent: 0.8 }
    ]),
    RoboSignalExecution: {
      find: () => ({
        sort: () => ({
          limit: () => ({
            lean: async () => []
          })
        })
      })
    }
  };

  try {
    const signal = await buildAutoSignalForUser(
      {
        userId: 'user-multi',
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(signal.symbol, 'TLT');
    assert.equal(signal.side, 'sell');
    assert.equal(signal.qty, 10);
    assert.equal(signal.strategyId, 'ROBO_MULTI_SYMBOL_V1');
    assert.equal(signal.strategyName, 'ROBO_MULTI_SYMBOL');
  } finally {
    if (previousUniverse === undefined) delete process.env.ROBO_SIGNAL_UNIVERSE;
    else process.env.ROBO_SIGNAL_UNIVERSE = previousUniverse;
    if (previousSides === undefined) delete process.env.ROBO_ALLOWED_SIDES;
    else process.env.ROBO_ALLOWED_SIDES = previousSides;
    if (previousThreshold === undefined) delete process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;
    else process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = previousThreshold;
    if (previousTargetNotional === undefined) delete process.env.ROBO_TARGET_NOTIONAL;
    else process.env.ROBO_TARGET_NOTIONAL = previousTargetNotional;
  }
});

test('buildAutoSignalForUser maps short/cover aliases to canonical sides', async () => {
  const previousUniverse = process.env.ROBO_SIGNAL_UNIVERSE;
  const previousSides = process.env.ROBO_ALLOWED_SIDES;

  process.env.ROBO_SIGNAL_UNIVERSE = 'AAPL,QQQ';
  process.env.ROBO_ALLOWED_SIDES = 'short';

  const deps = {
    fetchQuotes: async () => ([
      { symbol: 'AAPL', price: 180, changePercent: 0.4 },
      { symbol: 'QQQ', price: 450, changePercent: -0.8 }
    ]),
    RoboSignalExecution: {
      find: () => ({
        sort: () => ({
          limit: () => ({
            lean: async () => []
          })
        })
      })
    }
  };

  try {
    const signal = await buildAutoSignalForUser(
      {
        userId: 'user-short-alias',
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(signal.symbol, 'QQQ');
    assert.equal(signal.side, 'sell');
  } finally {
    if (previousUniverse === undefined) delete process.env.ROBO_SIGNAL_UNIVERSE;
    else process.env.ROBO_SIGNAL_UNIVERSE = previousUniverse;
    if (previousSides === undefined) delete process.env.ROBO_ALLOWED_SIDES;
    else process.env.ROBO_ALLOWED_SIDES = previousSides;
  }
});

test('buildAutoSignalForUser avoids recently traded symbol when alternatives exist', async () => {
  const previousUniverse = process.env.ROBO_SIGNAL_UNIVERSE;
  const previousSides = process.env.ROBO_ALLOWED_SIDES;
  const previousThreshold = process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;

  process.env.ROBO_SIGNAL_UNIVERSE = 'AAPL,TLT,QQQ';
  process.env.ROBO_ALLOWED_SIDES = 'buy,sell';
  process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = '0.2';

  const deps = {
    fetchQuotes: async () => ([
      { symbol: 'AAPL', price: 180, changePercent: 0.1 },
      { symbol: 'TLT', price: 90, changePercent: -1.2 },
      { symbol: 'QQQ', price: 450, changePercent: 0.8 }
    ]),
    RoboSignalExecution: {
      find: () => ({
        sort: () => ({
          limit: () => ({
            lean: async () => [{ symbol: 'TLT' }]
          })
        })
      })
    }
  };

  try {
    const signal = await buildAutoSignalForUser(
      {
        userId: 'user-rotation',
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(signal.symbol, 'QQQ');
    assert.equal(signal.side, 'buy');
  } finally {
    if (previousUniverse === undefined) delete process.env.ROBO_SIGNAL_UNIVERSE;
    else process.env.ROBO_SIGNAL_UNIVERSE = previousUniverse;
    if (previousSides === undefined) delete process.env.ROBO_ALLOWED_SIDES;
    else process.env.ROBO_ALLOWED_SIDES = previousSides;
    if (previousThreshold === undefined) delete process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;
    else process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = previousThreshold;
  }
});

test('runSchedulerTick uses auto-generated multi-symbol signals', async () => {
  const previousUniverse = process.env.ROBO_SIGNAL_UNIVERSE;
  const previousSides = process.env.ROBO_ALLOWED_SIDES;
  const previousThreshold = process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;
  const previousShortFlag = process.env.SHORT_SELLING_ENABLED;

  process.env.ROBO_SIGNAL_UNIVERSE = 'AAPL,TLT,QQQ';
  process.env.ROBO_ALLOWED_SIDES = 'buy,sell';
  process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = '0.2';
  process.env.SHORT_SELLING_ENABLED = 'true';

  const events = [];
  const orderCalls = [];
  const settingsDoc = {
    enabled: true,
    dailyLimit: 10000,
    weeklyLimit: 50000,
    monthlyLimit: 100000,
    failureStreak: 0,
    pausedUntil: null
  };

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      find: () => ({
        lean: async () => [{ userId: 'user-scheduler', enabled: true }]
      }),
      findOne: async () => settingsDoc
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
      find: () => ({
        sort: () => ({
          limit: () => ({
            lean: async () => []
          })
        })
      }),
      findOne: () => ({
        sort: () => ({
          lean: async () => null
        })
      }),
      countDocuments: async () => 0,
      create: async payload => ({ _id: 'signal-scheduler', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-scheduler' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async payload => {
        orderCalls.push(payload);
        return {
          order: { id: 'order-scheduler-1', notional: 100 },
          trade: { notional: 100 }
        };
      }
    },
    fetchQuotes: async symbols => {
      if (Array.isArray(symbols) && symbols.length > 1) {
        return [
          { symbol: 'AAPL', price: 180, changePercent: 0.1 },
          { symbol: 'TLT', price: 90, changePercent: -1.2 },
          { symbol: 'QQQ', price: 450, changePercent: 0.8 }
        ];
      }
      return [{ symbol: 'TLT', price: 90, changePercent: -1.2 }];
    },
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-scheduler' })
    }
  };

  try {
    await runSchedulerTick(deps);
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0].symbol, 'TLT');
    assert.equal(orderCalls[0].side, 'sell');
    assert.equal(events.some(event => event.eventType === 'trade_executed'), true);
  } finally {
    if (previousUniverse === undefined) delete process.env.ROBO_SIGNAL_UNIVERSE;
    else process.env.ROBO_SIGNAL_UNIVERSE = previousUniverse;
    if (previousSides === undefined) delete process.env.ROBO_ALLOWED_SIDES;
    else process.env.ROBO_ALLOWED_SIDES = previousSides;
    if (previousThreshold === undefined) delete process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT;
    else process.env.ROBO_SIGNAL_CHANGE_THRESHOLD_PCT = previousThreshold;
    if (previousShortFlag === undefined) delete process.env.SHORT_SELLING_ENABLED;
    else process.env.SHORT_SELLING_ENABLED = previousShortFlag;
  }
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

test('runRoboTradeForUser skips when execution cooldown is active', async () => {
  const events = [];
  let orderAttempted = false;
  const previousCooldown = process.env.ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS;
  process.env.ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS = '30';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        failureStreak: 0,
        pausedUntil: null
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
      findOne: () => ({
        sort: () => ({
          lean: async () => ({ executedAt: new Date('2026-02-20T15:40:00.000Z') })
        })
      }),
      create: async payload => ({ _id: 'signal-cooldown', ...payload }),
      updateOne: async () => ({ acknowledged: true }),
      countDocuments: async () => 0
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-cooldown' }),
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

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-cooldown',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'COOLDOWN_ACTIVE');
    assert.equal(orderAttempted, false);
    assert.equal(events.some(event => event.eventType === 'trade_skipped_cooldown'), true);
  } finally {
    if (previousCooldown === undefined) delete process.env.ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS;
    else process.env.ROBO_MIN_MINUTES_BETWEEN_EXECUTIONS = previousCooldown;
  }
});

test('runRoboTradeForUser skips when max executions per day is reached', async () => {
  const events = [];
  let orderAttempted = false;
  const previousDailyCap = process.env.ROBO_MAX_EXECUTIONS_PER_DAY;
  process.env.ROBO_MAX_EXECUTIONS_PER_DAY = '2';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        failureStreak: 0,
        pausedUntil: null
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
      countDocuments: async () => 2,
      findOne: () => ({ lean: async () => null }),
      create: async payload => ({ _id: 'signal-max', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-max' }),
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

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-max',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MAX_TRADES_REACHED');
    assert.equal(orderAttempted, false);
    assert.equal(events.some(event => event.eventType === 'trade_skipped_max_trades'), true);
  } finally {
    if (previousDailyCap === undefined) delete process.env.ROBO_MAX_EXECUTIONS_PER_DAY;
    else process.env.ROBO_MAX_EXECUTIONS_PER_DAY = previousDailyCap;
  }
});

test('runRoboTradeForUser uses settings maxTradesPerDay when no env cap is configured', async () => {
  const events = [];
  let orderAttempted = false;
  const previousDailyCap = process.env.ROBO_MAX_EXECUTIONS_PER_DAY;
  const previousSymbolCooldown = process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
  delete process.env.ROBO_MAX_EXECUTIONS_PER_DAY;
  process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS = '0';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        maxTradesPerDay: 2,
        failureStreak: 0,
        pausedUntil: null
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
      countDocuments: async () => 2,
      findOne: () => ({ lean: async () => null }),
      create: async payload => ({ _id: 'signal-settings-max', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-settings-max' }),
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

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-settings-max',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MAX_TRADES_REACHED');
    assert.equal(orderAttempted, false);
    assert.equal(events.some(event => event.eventType === 'trade_skipped_max_trades'), true);
  } finally {
    if (previousDailyCap === undefined) delete process.env.ROBO_MAX_EXECUTIONS_PER_DAY;
    else process.env.ROBO_MAX_EXECUTIONS_PER_DAY = previousDailyCap;
    if (previousSymbolCooldown === undefined) delete process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
    else process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS = previousSymbolCooldown;
  }
});

test('runRoboTradeForUser skips when kill switch is enabled', async () => {
  const events = [];
  const previousKillSwitch = process.env.ROBO_KILL_SWITCH;
  process.env.ROBO_KILL_SWITCH = 'true';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000
      })
    },
    RoboUsage: {},
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboSignalExecution: {},
    RoboLock: {},
    paperBroker: {},
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'noop' })
    }
  };

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-kill-switch',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'KILL_SWITCH');
    assert.equal(events.some(event => event.eventType === 'trade_skipped_kill_switch'), true);
  } finally {
    if (previousKillSwitch === undefined) delete process.env.ROBO_KILL_SWITCH;
    else process.env.ROBO_KILL_SWITCH = previousKillSwitch;
  }
});

test('runRoboTradeForUser skips short execution when policy flags disable short-selling', async () => {
  const previousShortFlag = process.env.SHORT_SELLING_ENABLED;
  delete process.env.SHORT_SELLING_ENABLED;
  const events = [];
  let orderAttempted = false;

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000
      })
    },
    RoboUsage: {},
    RoboAuditLog: {
      create: async entry => {
        events.push(entry);
        return entry;
      }
    },
    RoboSignalExecution: {},
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-policy' }),
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

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-policy-blocked',
        signal: { symbol: 'AAPL', side: 'sell', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'POLICY_BLOCKED');
    assert.equal(orderAttempted, false);
    assert.equal(events.some(event => event.eventType === 'trade_skipped_policy'), true);
  } finally {
    if (previousShortFlag === undefined) delete process.env.SHORT_SELLING_ENABLED;
    else process.env.SHORT_SELLING_ENABLED = previousShortFlag;
  }
});

test('runRoboTradeForUser skips when symbol cooldown is active', async () => {
  const events = [];
  const previousCooldown = process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
  process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS = '30';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        failureStreak: 0,
        pausedUntil: null
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
      findOne: query => ({
        sort: () => ({
          lean: async () => (query?.symbol === 'AAPL' ? { executedAt: new Date('2026-02-20T15:45:00.000Z') } : null)
        })
      }),
      countDocuments: async () => 0,
      create: async payload => ({ _id: 'signal-symbol-cooldown', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-symbol-cooldown' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => ({})
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'noop' })
    }
  };

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-symbol-cooldown',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SYMBOL_COOLDOWN');
    assert.equal(events.some(event => event.eventType === 'trade_skipped_symbol_cooldown'), true);
  } finally {
    if (previousCooldown === undefined) delete process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
    else process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS = previousCooldown;
  }
});

test('runRoboTradeForUser applies the default symbol cooldown when env is unset', async () => {
  const events = [];
  let orderAttempted = false;
  const previousCooldown = process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
  delete process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        maxTradesPerDay: 3,
        failureStreak: 0,
        pausedUntil: null
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
      findOne: query => ({
        sort: () => ({
          lean: async () => (query?.symbol === 'AAPL' ? { executedAt: new Date('2026-02-20T12:00:00.000Z') } : null)
        })
      }),
      countDocuments: async () => 0,
      create: async payload => ({ _id: 'signal-default-symbol-cooldown', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-default-symbol-cooldown' }),
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

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-default-symbol-cooldown',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1 },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SYMBOL_COOLDOWN');
    assert.equal(orderAttempted, false);
    assert.equal(events.some(event => event.eventType === 'trade_skipped_symbol_cooldown'), true);
  } finally {
    if (previousCooldown === undefined) delete process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS;
    else process.env.ROBO_MIN_MINUTES_BETWEEN_SYMBOL_EXECUTIONS = previousCooldown;
  }
});

test('runRoboTradeForUser skips when strategy daily limit is reached', async () => {
  const events = [];
  const previousStrategyCap = process.env.ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY;
  process.env.ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY = '1';

  const deps = {
    User: {},
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 1000,
        weeklyLimit: 5000,
        monthlyLimit: 10000,
        failureStreak: 0,
        pausedUntil: null
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
      countDocuments: async query => (query?.strategyId ? 1 : 0),
      findOne: () => ({ lean: async () => null }),
      create: async payload => ({ _id: 'signal-strategy-cap', ...payload }),
      updateOne: async () => ({ acknowledged: true })
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-strategy-cap' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => ({})
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'noop' })
    }
  };

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-strategy-cap',
        signal: { symbol: 'AAPL', side: 'buy', qty: 1, strategyId: 'SMA_CROSS' },
        now: new Date('2026-02-20T16:00:00.000Z')
      },
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'STRATEGY_LIMIT');
    assert.equal(events.some(event => event.eventType === 'trade_skipped_strategy_limit'), true);
  } finally {
    if (previousStrategyCap === undefined) delete process.env.ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY;
    else process.env.ROBO_MAX_EXECUTIONS_PER_STRATEGY_PER_DAY = previousStrategyCap;
  }
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

test('runRoboTradeForUser maps short signal side to sell execution', async () => {
  const previousShortFlag = process.env.SHORT_SELLING_ENABLED;
  process.env.SHORT_SELLING_ENABLED = 'true';
  const events = [];
  const usageUpdates = [];
  const orderCalls = [];

  const deps = {
    User: {
      findById: () => ({
        lean: async () => ({ email: 'trader@example.com' })
      })
    },
    RoboSettings: {
      findOne: async () => ({
        enabled: true,
        dailyLimit: 0,
        weeklyLimit: 0,
        monthlyLimit: 0
      })
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
      create: async payload => ({ _id: 'signal-short', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async () => ({ acknowledged: true }),
      countDocuments: async () => 0
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-short' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async payload => {
        orderCalls.push(payload);
        return {
          order: { id: 'order-short-1', notional: 100 },
          trade: { notional: 100 }
        };
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-short' })
    }
  };

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-short',
        now: new Date('2026-02-20T15:00:00.000Z'),
        signal: {
          symbol: 'AAPL',
          side: 'short',
          qty: 1,
          strategyName: 'Short Alias'
        }
      },
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(result.executed, true);
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0].side, 'sell');
    assert.equal(usageUpdates.length, 3);
    usageUpdates.forEach(update => {
      assert.equal(update.update.$inc.spentNotional, 0);
    });
    assert.equal(events.some(event => event.eventType === 'trade_executed'), true);
  } finally {
    if (previousShortFlag === undefined) delete process.env.SHORT_SELLING_ENABLED;
    else process.env.SHORT_SELLING_ENABLED = previousShortFlag;
  }
});

test('runRoboTradeForUser executes via Alpaca backend when configured', async t => {
  const previousBackend = process.env.ROBO_EXECUTION_BACKEND;
  const previousApiKey = process.env.APCA_API_KEY_ID;
  const previousApiSecret = process.env.APCA_API_SECRET_KEY;
  const previousBaseUrl = process.env.APCA_BASE_URL;

  process.env.ROBO_EXECUTION_BACKEND = 'alpaca';
  process.env.APCA_API_KEY_ID = 'alpaca-key';
  process.env.APCA_API_SECRET_KEY = 'alpaca-secret';
  process.env.APCA_BASE_URL = 'https://paper-api.alpaca.markets';

  const events = [];
  const usageUpdates = [];
  const orderCalls = [];

  t.mock.method(axios, 'post', async (...args) => {
    orderCalls.push(args);
    return {
      data: {
        id: 'alpaca-order-1',
        filled_avg_price: '101.5',
        filled_qty: '1',
        notional: '101.5'
      }
    };
  });

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
        weeklyLimit: 2000,
        monthlyLimit: 5000
      })
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
      create: async payload => ({ _id: 'signal-alpaca', ...payload }),
      findOne: () => ({ lean: async () => null }),
      updateOne: async () => ({ acknowledged: true }),
      countDocuments: async () => 0
    },
    RoboLock: {
      findOneAndUpdate: async () => ({ _id: 'lock-alpaca' }),
      updateOne: async () => ({ acknowledged: true })
    },
    paperBroker: {
      placeOrder: async () => {
        throw new Error('paper broker should not be called in alpaca execution mode');
      }
    },
    fetchQuotes: async () => [{ symbol: 'AAPL', price: 100 }],
    emailService: {
      sendTradeEmail: async () => ({ provider: 'log', messageId: 'email-alpaca' })
    }
  };

  try {
    const result = await runRoboTradeForUser(
      {
        userId: 'user-alpaca',
        now: new Date('2026-02-20T15:00:00.000Z'),
        signal: {
          symbol: 'AAPL',
          side: 'buy',
          qty: 1,
          strategyName: 'Alpaca Test'
        }
      },
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(result.executed, true);
    assert.equal(orderCalls.length, 1);
    assert.equal(orderCalls[0][0], 'https://paper-api.alpaca.markets/v2/orders');
    assert.equal(orderCalls[0][1].symbol, 'AAPL');
    assert.equal(orderCalls[0][1].side, 'buy');
    assert.equal(usageUpdates.length, 3);

    const tradeEvent = events.find(event => event.eventType === 'trade_executed');
    assert.ok(tradeEvent);
    assert.equal(tradeEvent.payload.executionBackend, 'alpaca');
    assert.equal(tradeEvent.payload.orderId, 'alpaca-order-1');
  } finally {
    if (previousBackend === undefined) delete process.env.ROBO_EXECUTION_BACKEND;
    else process.env.ROBO_EXECUTION_BACKEND = previousBackend;
    if (previousApiKey === undefined) delete process.env.APCA_API_KEY_ID;
    else process.env.APCA_API_KEY_ID = previousApiKey;
    if (previousApiSecret === undefined) delete process.env.APCA_API_SECRET_KEY;
    else process.env.APCA_API_SECRET_KEY = previousApiSecret;
    if (previousBaseUrl === undefined) delete process.env.APCA_BASE_URL;
    else process.env.APCA_BASE_URL = previousBaseUrl;
  }
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
