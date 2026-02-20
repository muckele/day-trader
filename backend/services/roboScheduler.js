const roboEngine = require('./roboTraderEngine');

function toFinitePositiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function startRoboScheduler({
  intervalMs = 60 * 1000,
  cleanupIntervalMs = Number(process.env.ROBO_SIGNAL_CLEANUP_INTERVAL_MS) || (6 * 60 * 60 * 1000),
  retentionDays = process.env.ROBO_SIGNAL_RETENTION_DAYS,
  startupDelayMs = 5000
} = {}) {
  if (process.env.ROBO_SCHEDULER_DISABLED === 'true') {
    return () => {};
  }

  const tickEveryMs = toFinitePositiveInt(intervalMs, 60 * 1000);
  const cleanupEveryMs = toFinitePositiveInt(cleanupIntervalMs, 6 * 60 * 60 * 1000);
  let lastCleanupAt = 0;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await roboEngine.runSchedulerTick();
      const nowMs = Date.now();
      if ((nowMs - lastCleanupAt) >= cleanupEveryMs) {
        lastCleanupAt = nowMs;
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
      console.error('Robo scheduler tick failed:', err.message);
    } finally {
      running = false;
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

module.exports = {
  startRoboScheduler
};
