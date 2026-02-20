const test = require('node:test');
const assert = require('node:assert/strict');
const roboEngine = require('../services/roboTraderEngine');
const { startRoboScheduler } = require('../services/roboScheduler');

test('startRoboScheduler runs scheduler tick and retention cleanup', async t => {
  const previousDisabled = process.env.ROBO_SCHEDULER_DISABLED;
  delete process.env.ROBO_SCHEDULER_DISABLED;

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
