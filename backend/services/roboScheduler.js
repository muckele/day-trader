const roboEngine = require('./roboTraderEngine');
const mongoose = require('mongoose');

const schedulerState = {
  enabled: true,
  running: false,
  tickCount: 0,
  skippedTicks: 0,
  lastSkipReason: null,
  lastTickAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastDurationMs: null,
  lastCleanupAt: null
};

function toFinitePositiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isSchedulerDbRequired() {
  return process.env.ROBO_SCHEDULER_REQUIRE_DB !== 'false';
}

function defaultIsDbReady() {
  return mongoose.connection.readyState === 1;
}

function startRoboScheduler({
  intervalMs = 60 * 1000,
  cleanupIntervalMs = Number(process.env.ROBO_SIGNAL_CLEANUP_INTERVAL_MS) || (6 * 60 * 60 * 1000),
  retentionDays = process.env.ROBO_SIGNAL_RETENTION_DAYS,
  startupDelayMs = 5000,
  isDbReady = defaultIsDbReady
} = {}) {
  if (process.env.ROBO_SCHEDULER_DISABLED === 'true') {
    schedulerState.enabled = false;
    return () => {};
  }

  schedulerState.enabled = true;
  const tickEveryMs = toFinitePositiveInt(intervalMs, 60 * 1000);
  const cleanupEveryMs = toFinitePositiveInt(cleanupIntervalMs, 6 * 60 * 60 * 1000);
  const dbRequired = isSchedulerDbRequired();
  const skipLogIntervalMs = Math.max(
    1000,
    toFinitePositiveInt(process.env.ROBO_SCHEDULER_SKIP_LOG_INTERVAL_MS, 60 * 1000)
  );
  let lastSkipLogAt = 0;
  let lastCleanupAt = 0;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    schedulerState.running = true;
    schedulerState.lastTickAt = new Date();
    schedulerState.tickCount += 1;
    const startMs = Date.now();
    try {
      if (dbRequired && !isDbReady()) {
        schedulerState.skippedTicks += 1;
        schedulerState.lastSkipReason = 'DB_UNAVAILABLE';
        schedulerState.lastError = 'MongoDB unavailable; scheduler tick skipped';
        const nowMs = Date.now();
        if ((nowMs - lastSkipLogAt) >= skipLogIntervalMs) {
          lastSkipLogAt = nowMs;
          console.warn('Robo scheduler skipped tick: MongoDB unavailable.');
        }
        return;
      }

      schedulerState.lastSkipReason = null;
      await roboEngine.runSchedulerTick();
      schedulerState.lastSuccessAt = new Date();
      schedulerState.lastError = null;
      const nowMs = Date.now();
      if ((nowMs - lastCleanupAt) >= cleanupEveryMs) {
        lastCleanupAt = nowMs;
        schedulerState.lastCleanupAt = new Date(nowMs);
        try {
          const result = await roboEngine.cleanupSignalExecutions({
            olderThanDays: retentionDays
          });
          if (result.deletedCount > 0) {
            console.log(`[robo-scheduler] cleaned ${result.deletedCount} signal records older than ${result.retentionDays} days`);
          }
        } catch (err) {
          console.error('Robo scheduler cleanup failed:', err.message);
        }
      }
    } catch (err) {
      schedulerState.lastError = err?.message || 'Unknown scheduler error';
      console.error('Robo scheduler tick failed:', err.message);
    } finally {
      running = false;
      schedulerState.running = false;
      schedulerState.lastDurationMs = Date.now() - startMs;
    }
  };

  // slight startup delay to avoid competing with cold-start tasks
  const startTimeout = setTimeout(() => {
    tick();
  }, toFinitePositiveInt(startupDelayMs, 5000));
  const timer = setInterval(tick, tickEveryMs);

  return () => {
    clearTimeout(startTimeout);
    clearInterval(timer);
  };
}

function getSchedulerStatus() {
  return {
    enabled: schedulerState.enabled,
    running: schedulerState.running,
    tickCount: schedulerState.tickCount,
    skippedTicks: schedulerState.skippedTicks,
    lastSkipReason: schedulerState.lastSkipReason,
    lastTickAt: schedulerState.lastTickAt,
    lastSuccessAt: schedulerState.lastSuccessAt,
    lastError: schedulerState.lastError,
    lastDurationMs: schedulerState.lastDurationMs,
    lastCleanupAt: schedulerState.lastCleanupAt
  };
}

module.exports = {
  startRoboScheduler,
  getSchedulerStatus
};
