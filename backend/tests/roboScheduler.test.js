const test = require('node:test');
const assert = require('node:assert/strict');
const roboEngine = require('../services/roboTraderEngine');
const roboTraderWorker = require('../robotrader/worker');
const roboReconciliation = require('../robotrader/reconciliation');
const RoboSettings = require('../models/RoboSettings');
const {
  getScheduledReconciliationModes,
  startRoboScheduler
} = require('../services/roboScheduler');

const LIVE_ALPACA_ENV_NAMES = [
  'APCA_LIVE_API_KEY_ID',
  'APCA_LIVE_API_SECRET_KEY',
  'APCA_LIVE_BASE_URL',
  'ALPACA_LIVE_API_KEY',
  'ALPACA_LIVE_API_SECRET',
  'ALPACA_LIVE_BASE_URL'
];

function preserveEnv(names) {
  const previous = new Map(names.map(name => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('startRoboScheduler runs scheduler tick and retention cleanup', async t => {
  const previousDisabled = process.env.ROBO_SCHEDULER_DISABLED;
  const previousRequireDb = process.env.ROBO_SCHEDULER_REQUIRE_DB;
  const previousWorkerDisabled = process.env.ROBOTRADER_WORKER_DISABLED;
  const previousLegacyEnabled = process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
  delete process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'false';
  process.env.ROBOTRADER_WORKER_DISABLED = 'true';
  process.env.ROBO_LEGACY_SCHEDULER_ENABLED = 'true';

  let tickCalls = 0;
  const cleanupCalls = [];
  t.mock.method(roboEngine, 'runSchedulerTick', async () => {
    tickCalls += 1;
  });
  t.mock.method(roboEngine, 'cleanupSignalExecutions', async args => {
    cleanupCalls.push(args);
    return { deletedCount: 0, retentionDays: 7 };
  });

  try {
    const stop = startRoboScheduler({
      intervalMs: 30,
      cleanupIntervalMs: 40,
      retentionDays: 7,
      startupDelayMs: 0
    });

    await new Promise(resolve => setTimeout(resolve, 140));
    stop();

    assert.ok(tickCalls >= 2);
    assert.ok(cleanupCalls.length >= 1);
    assert.equal(cleanupCalls[0].olderThanDays, 7);
  } finally {
    if (previousDisabled === undefined) delete process.env.ROBO_SCHEDULER_DISABLED;
    else process.env.ROBO_SCHEDULER_DISABLED = previousDisabled;
    if (previousRequireDb === undefined) delete process.env.ROBO_SCHEDULER_REQUIRE_DB;
    else process.env.ROBO_SCHEDULER_REQUIRE_DB = previousRequireDb;
    if (previousWorkerDisabled === undefined) delete process.env.ROBOTRADER_WORKER_DISABLED;
    else process.env.ROBOTRADER_WORKER_DISABLED = previousWorkerDisabled;
    if (previousLegacyEnabled === undefined) delete process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
    else process.env.ROBO_LEGACY_SCHEDULER_ENABLED = previousLegacyEnabled;
  }
});

test('startRoboScheduler defaults to Phase 1 worker without running legacy scheduler', async t => {
  const previousDisabled = process.env.ROBO_SCHEDULER_DISABLED;
  const previousRequireDb = process.env.ROBO_SCHEDULER_REQUIRE_DB;
  const previousWorkerDisabled = process.env.ROBOTRADER_WORKER_DISABLED;
  const previousLegacyEnabled = process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
  const previousLegacyDisabled = process.env.ROBO_LEGACY_SCHEDULER_DISABLED;
  const previousDualAutomation = process.env.ROBO_ALLOW_DUAL_AUTOMATION;
  const previousReconciliationDisabled = process.env.ROBOTRADER_RECONCILIATION_DISABLED;

  delete process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'false';
  delete process.env.ROBOTRADER_WORKER_DISABLED;
  delete process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
  delete process.env.ROBO_LEGACY_SCHEDULER_DISABLED;
  delete process.env.ROBO_ALLOW_DUAL_AUTOMATION;
  process.env.ROBOTRADER_RECONCILIATION_DISABLED = 'true';

  let legacyCalls = 0;
  let workerCalls = 0;
  t.mock.method(roboEngine, 'runSchedulerTick', async () => {
    legacyCalls += 1;
  });
  t.mock.method(roboEngine, 'cleanupSignalExecutions', async () => ({ deletedCount: 0, retentionDays: 7 }));
  t.mock.method(roboTraderWorker, 'runWorkerTick', async () => {
    workerCalls += 1;
    return { ok: true, usersChecked: 0, results: [] };
  });

  try {
    const stop = startRoboScheduler({
      intervalMs: 25,
      cleanupIntervalMs: 1000,
      startupDelayMs: 0,
      isDbReady: () => true
    });

    await new Promise(resolve => setTimeout(resolve, 90));
    stop();

    assert.equal(legacyCalls, 0);
    assert.ok(workerCalls >= 1);
  } finally {
    if (previousDisabled === undefined) delete process.env.ROBO_SCHEDULER_DISABLED;
    else process.env.ROBO_SCHEDULER_DISABLED = previousDisabled;
    if (previousRequireDb === undefined) delete process.env.ROBO_SCHEDULER_REQUIRE_DB;
    else process.env.ROBO_SCHEDULER_REQUIRE_DB = previousRequireDb;
    if (previousWorkerDisabled === undefined) delete process.env.ROBOTRADER_WORKER_DISABLED;
    else process.env.ROBOTRADER_WORKER_DISABLED = previousWorkerDisabled;
    if (previousLegacyEnabled === undefined) delete process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
    else process.env.ROBO_LEGACY_SCHEDULER_ENABLED = previousLegacyEnabled;
    if (previousLegacyDisabled === undefined) delete process.env.ROBO_LEGACY_SCHEDULER_DISABLED;
    else process.env.ROBO_LEGACY_SCHEDULER_DISABLED = previousLegacyDisabled;
    if (previousDualAutomation === undefined) delete process.env.ROBO_ALLOW_DUAL_AUTOMATION;
    else process.env.ROBO_ALLOW_DUAL_AUTOMATION = previousDualAutomation;
    if (previousReconciliationDisabled === undefined) delete process.env.ROBOTRADER_RECONCILIATION_DISABLED;
    else process.env.ROBOTRADER_RECONCILIATION_DISABLED = previousReconciliationDisabled;
  }
});

test('getScheduledReconciliationModes keeps paper only without live opt-in', async t => {
  const restoreEnv = preserveEnv([
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED'
  ]);
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED;
  t.mock.method(RoboSettings, 'exists', query => {
    assert.deepEqual(query, {
      mode: 'live',
      liveTradingExplicitlyEnabled: true
    });
    return { lean: async () => null };
  });

  try {
    const modes = await getScheduledReconciliationModes();
    assert.deepEqual(modes, ['paper']);
  } finally {
    restoreEnv();
  }
});

test('getScheduledReconciliationModes adds live when explicitly enabled by env', async t => {
  const restoreEnv = preserveEnv([
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED',
    ...LIVE_ALPACA_ENV_NAMES
  ]);
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED = 'true';
  process.env.APCA_LIVE_API_KEY_ID = 'live-key';
  process.env.APCA_LIVE_API_SECRET_KEY = 'live-secret';
  process.env.APCA_LIVE_BASE_URL = 'https://api.alpaca.markets';
  t.mock.method(RoboSettings, 'exists', () => {
    throw new Error('settings lookup should be skipped when env opt-in is set');
  });

  try {
    const modes = await getScheduledReconciliationModes();
    assert.deepEqual(modes, ['paper', 'live']);
  } finally {
    restoreEnv();
  }
});

test('getScheduledReconciliationModes keeps paper only when live credentials are missing', async t => {
  const restoreEnv = preserveEnv([
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED',
    ...LIVE_ALPACA_ENV_NAMES
  ]);
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED = 'true';
  LIVE_ALPACA_ENV_NAMES.forEach(name => {
    delete process.env[name];
  });
  t.mock.method(RoboSettings, 'exists', () => {
    throw new Error('settings lookup should be skipped when live credentials are missing');
  });

  try {
    const modes = await getScheduledReconciliationModes();
    assert.deepEqual(modes, ['paper']);
  } finally {
    restoreEnv();
  }
});

test('getScheduledReconciliationModes adds live when a live-enabled setting exists', async t => {
  const restoreEnv = preserveEnv([
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED',
    ...LIVE_ALPACA_ENV_NAMES
  ]);
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED;
  process.env.APCA_LIVE_API_KEY_ID = 'live-key';
  process.env.APCA_LIVE_API_SECRET_KEY = 'live-secret';
  process.env.APCA_LIVE_BASE_URL = 'https://api.alpaca.markets';
  t.mock.method(RoboSettings, 'exists', () => ({ lean: async () => ({ _id: 'settings-live' }) }));

  try {
    const modes = await getScheduledReconciliationModes();
    assert.deepEqual(modes, ['paper', 'live']);
  } finally {
    restoreEnv();
  }
});

test('startRoboScheduler reconciles paper only when live reconciliation is not enabled', async t => {
  const restoreEnv = preserveEnv([
    'ROBO_SCHEDULER_DISABLED',
    'ROBO_SCHEDULER_REQUIRE_DB',
    'ROBOTRADER_WORKER_DISABLED',
    'ROBO_LEGACY_SCHEDULER_ENABLED',
    'ROBO_LEGACY_SCHEDULER_DISABLED',
    'ROBOTRADER_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED'
  ]);
  delete process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'false';
  process.env.ROBOTRADER_WORKER_DISABLED = 'true';
  delete process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
  process.env.ROBO_LEGACY_SCHEDULER_DISABLED = 'true';
  delete process.env.ROBOTRADER_RECONCILIATION_DISABLED;
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED;

  const reconciliationModes = [];
  t.mock.method(roboEngine, 'cleanupSignalExecutions', async () => ({ deletedCount: 0, retentionDays: 7 }));
  t.mock.method(RoboSettings, 'exists', () => ({ lean: async () => null }));
  t.mock.method(roboReconciliation, 'reconcileRoboOrders', async ({ mode }) => {
    reconciliationModes.push(mode);
    return { ok: true, environment: mode };
  });

  try {
    const stop = startRoboScheduler({
      intervalMs: 25,
      cleanupIntervalMs: 1000,
      reconciliationIntervalMs: 20,
      startupDelayMs: 0,
      isDbReady: () => true
    });

    await new Promise(resolve => setTimeout(resolve, 75));
    stop();

    assert.ok(reconciliationModes.includes('paper'));
    assert.equal(reconciliationModes.includes('live'), false);
  } finally {
    restoreEnv();
  }
});

test('startRoboScheduler reconciles live when live reconciliation is explicitly enabled', async t => {
  const restoreEnv = preserveEnv([
    'ROBO_SCHEDULER_DISABLED',
    'ROBO_SCHEDULER_REQUIRE_DB',
    'ROBOTRADER_WORKER_DISABLED',
    'ROBO_LEGACY_SCHEDULER_ENABLED',
    'ROBO_LEGACY_SCHEDULER_DISABLED',
    'ROBOTRADER_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_DISABLED',
    'ROBOTRADER_LIVE_RECONCILIATION_ENABLED',
    ...LIVE_ALPACA_ENV_NAMES
  ]);
  delete process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'false';
  process.env.ROBOTRADER_WORKER_DISABLED = 'true';
  delete process.env.ROBO_LEGACY_SCHEDULER_ENABLED;
  process.env.ROBO_LEGACY_SCHEDULER_DISABLED = 'true';
  delete process.env.ROBOTRADER_RECONCILIATION_DISABLED;
  delete process.env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED;
  process.env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED = 'true';
  process.env.APCA_LIVE_API_KEY_ID = 'live-key';
  process.env.APCA_LIVE_API_SECRET_KEY = 'live-secret';
  process.env.APCA_LIVE_BASE_URL = 'https://api.alpaca.markets';

  const reconciliationModes = [];
  t.mock.method(roboEngine, 'cleanupSignalExecutions', async () => ({ deletedCount: 0, retentionDays: 7 }));
  t.mock.method(roboReconciliation, 'reconcileRoboOrders', async ({ mode }) => {
    reconciliationModes.push(mode);
    return { ok: true, environment: mode };
  });

  try {
    const stop = startRoboScheduler({
      intervalMs: 25,
      cleanupIntervalMs: 1000,
      reconciliationIntervalMs: 20,
      startupDelayMs: 0,
      isDbReady: () => true
    });

    await new Promise(resolve => setTimeout(resolve, 75));
    stop();

    assert.ok(reconciliationModes.includes('paper'));
    assert.ok(reconciliationModes.includes('live'));
  } finally {
    restoreEnv();
  }
});

test('startRoboScheduler returns no-op when disabled', async t => {
  const previousDisabled = process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_DISABLED = 'true';

  let tickCalls = 0;
  t.mock.method(roboEngine, 'runSchedulerTick', async () => {
    tickCalls += 1;
  });

  try {
    const stop = startRoboScheduler({ intervalMs: 20, startupDelayMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 70));
    stop();

    assert.equal(tickCalls, 0);
  } finally {
    if (previousDisabled === undefined) delete process.env.ROBO_SCHEDULER_DISABLED;
    else process.env.ROBO_SCHEDULER_DISABLED = previousDisabled;
  }
});

test('startRoboScheduler skips ticks when DB is unavailable and requirement is enabled', async t => {
  const previousRequired = process.env.ROBO_SCHEDULER_REQUIRE_DB;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'true';

  let tickCalls = 0;
  let cleanupCalls = 0;
  t.mock.method(roboEngine, 'runSchedulerTick', async () => {
    tickCalls += 1;
  });
  t.mock.method(roboEngine, 'cleanupSignalExecutions', async () => {
    cleanupCalls += 1;
    return { deletedCount: 0, retentionDays: 7 };
  });

  try {
    const stop = startRoboScheduler({
      intervalMs: 20,
      cleanupIntervalMs: 20,
      startupDelayMs: 0,
      isDbReady: () => false
    });

    await new Promise(resolve => setTimeout(resolve, 80));
    stop();

    assert.equal(tickCalls, 0);
    assert.equal(cleanupCalls, 0);
  } finally {
    if (previousRequired === undefined) delete process.env.ROBO_SCHEDULER_REQUIRE_DB;
    else process.env.ROBO_SCHEDULER_REQUIRE_DB = previousRequired;
  }
});
