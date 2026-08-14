const DEFAULT_SCHEDULER_STALE_MS = 3 * 60 * 1000;
const DEFAULT_STARTUP_GRACE_MS = 20 * 1000;
const DEFAULT_RECONCILIATION_STALE_MS = 12 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dateAgeMs(value, now) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? now.getTime() - timestamp : null;
}

function evaluateRuntimeReadiness({
  mongoReady = false,
  mongo = {},
  scheduler = {},
  now = new Date(),
  processUptimeMs = 0,
  schedulerStaleMs = DEFAULT_SCHEDULER_STALE_MS,
  reconciliationStaleMs = DEFAULT_RECONCILIATION_STALE_MS,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS
} = {}) {
  const schedulerRequired = scheduler.enabled !== false;
  const inStartupGrace = processUptimeMs < startupGraceMs;
  const lastSuccessAgeMs = dateAgeMs(scheduler.lastSuccessAt, now);
  const schedulerFresh = !schedulerRequired || (
    !scheduler.lastError
    && lastSuccessAgeMs !== null
    && lastSuccessAgeMs >= 0
    && lastSuccessAgeMs <= schedulerStaleMs
  );
  const schedulerReady = !schedulerRequired || schedulerFresh || inStartupGrace;
  const reconciliationRequired = schedulerRequired && scheduler.reconciliationEnabled !== false;
  const reconciliationAgeMs = dateAgeMs(scheduler.lastReconciliationSuccessAt, now);
  const reconciliationFresh = !reconciliationRequired || (
    !scheduler.lastReconciliationError
    && reconciliationAgeMs !== null
    && reconciliationAgeMs >= 0
    && reconciliationAgeMs <= reconciliationStaleMs
  );
  const reconciliationReady = !reconciliationRequired || reconciliationFresh || inStartupGrace;
  const checks = [
    {
      key: 'mongo',
      passed: mongoReady,
      detail: mongoReady
        ? 'MongoDB and required indexes are ready.'
        : `MongoDB is not request-ready (state=${mongo.state || 'unknown'}, indexes=${mongo.indexes?.state || 'unknown'}).`
    },
    {
      key: 'scheduler',
      passed: schedulerReady,
      detail: !schedulerRequired
        ? 'Scheduler is intentionally disabled for this deployment.'
        : inStartupGrace && !schedulerFresh
          ? 'Scheduler is within its startup grace period.'
          : schedulerFresh
            ? `Scheduler last succeeded ${lastSuccessAgeMs}ms ago.`
            : `Scheduler is stale or unhealthy; last success age is ${lastSuccessAgeMs ?? 'unknown'}ms.`
    },
    {
      key: 'reconciliation',
      passed: reconciliationReady,
      detail: !reconciliationRequired
        ? 'Scheduled reconciliation is intentionally disabled for this deployment.'
        : inStartupGrace && !reconciliationFresh
          ? 'Reconciliation is within its startup grace period.'
          : reconciliationFresh
            ? `Reconciliation last succeeded ${reconciliationAgeMs}ms ago.`
            : `Reconciliation is stale or unhealthy; last success age is ${reconciliationAgeMs ?? 'unknown'}ms.`
    }
  ];
  return {
    status: checks.every(check => check.passed) ? 'ready' : 'not_ready',
    ready: checks.every(check => check.passed),
    asOf: now.toISOString(),
    checks
  };
}

function buildRuntimeReadiness({ mongoState, scheduler, env = process.env, now = new Date(), processUptimeMs } = {}) {
  return evaluateRuntimeReadiness({
    mongoReady: mongoState.isMongoRequestReady(),
    mongo: mongoState.getMongoServiceState(),
    scheduler,
    now,
    processUptimeMs: processUptimeMs ?? process.uptime() * 1000,
    schedulerStaleMs: positiveInteger(env.ROBOTRADER_SCHEDULER_STALE_MS, DEFAULT_SCHEDULER_STALE_MS),
    reconciliationStaleMs: positiveInteger(
      env.ROBOTRADER_RECONCILIATION_STALE_MS,
      DEFAULT_RECONCILIATION_STALE_MS
    ),
    startupGraceMs: positiveInteger(env.RUNTIME_READINESS_STARTUP_GRACE_MS, DEFAULT_STARTUP_GRACE_MS)
  });
}

module.exports = {
  DEFAULT_SCHEDULER_STALE_MS,
  DEFAULT_RECONCILIATION_STALE_MS,
  DEFAULT_STARTUP_GRACE_MS,
  buildRuntimeReadiness,
  evaluateRuntimeReadiness
};
