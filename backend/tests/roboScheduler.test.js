const test = require('node:test');
const assert = require('node:assert/strict');
const roboEngine = require('../services/roboTraderEngine');
const roboTraderWorker = require('../robotrader/worker');
const { startRoboScheduler } = require('../services/roboScheduler');

test('startRoboScheduler runs scheduler tick and retention cleanup', async t => {
  const previousDisabled = process.env.ROBO_SCHEDULER_DISABLED;
  const previousRequireDb = process.env.ROBO_SCHEDULER_REQUIRE_DB;
  const previousWorkerDisabled = process.env.ROBOTRADER_WORKER_DISABLED;
  delete process.env.ROBO_SCHEDULER_DISABLED;
  process.env.ROBO_SCHEDULER_REQUIRE_DB = 'false';
  process.env.ROBOTRADER_WORKER_DISABLED = 'true';

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
