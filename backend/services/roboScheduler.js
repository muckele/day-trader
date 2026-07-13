const roboEngine = require('./roboTraderEngine');
const roboTraderWorker = require('../robotrader/worker');
const roboReconciliation = require('../robotrader/reconciliation');
const RoboSettings = require('../models/RoboSettings');
const { getAlpacaConfigForMode } = require('../robotrader/alpacaBroker');
const { isPaperTradingEndpoint } = require('./alpacaTradingClient');
const { enforceControlledLiveWatchdog } = require('./controlledLiveActivationService');
const { enforceStrategyEvidenceDemotion, expireLivePromotions } = require('./livePromotionService');
const mongoState = require('../utils/mongoState');

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
  lastCleanupAt: null,
  lastLegacySchedulerAt: null,
  lastPhase1WorkerAt: null,
  lastReconciliationAt: null,
  legacySchedulerEnabled: null,
  phase1WorkerEnabled: null
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
  return mongoState.isMongoRequestReady();
}

function isEnvTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function hasValue(value) {
  return String(value || '').trim() !== '';
}

function hasLiveAlpacaConfig(env = process.env) {
  const hasExplicitLiveKey = hasValue(env.APCA_LIVE_API_KEY_ID) || hasValue(env.ALPACA_LIVE_API_KEY);
  const hasExplicitLiveSecret = hasValue(env.APCA_LIVE_API_SECRET_KEY) || hasValue(env.ALPACA_LIVE_API_SECRET);
  if (!hasExplicitLiveKey || !hasExplicitLiveSecret) return false;

  const config = getAlpacaConfigForMode('live', env);
  return Boolean(config.apiKey && config.apiSecret && !isPaperTradingEndpoint(config.baseUrl));
}

function isPhase1WorkerEnabled() {
  return !isEnvTrue(process.env.ROBOTRADER_WORKER_DISABLED);
}

function isLegacySchedulerEnabled() {
  if (isEnvTrue(process.env.ROBO_LEGACY_SCHEDULER_DISABLED)) return false;

  const phase1Enabled = isPhase1WorkerEnabled();
  const legacyExplicitlyEnabled = isEnvTrue(process.env.ROBO_LEGACY_SCHEDULER_ENABLED);
  const dualAutomationAllowed = isEnvTrue(process.env.ROBO_ALLOW_DUAL_AUTOMATION);

  return legacyExplicitlyEnabled && (!phase1Enabled || dualAutomationAllowed);
}

async function isLiveReconciliationEnabled({
  env = process.env,
  RoboSettingsModel = RoboSettings
} = {}) {
  if (isEnvTrue(env.ROBOTRADER_LIVE_RECONCILIATION_DISABLED)) return false;
  if (!hasLiveAlpacaConfig(env)) return false;
  if (isEnvTrue(env.ROBOTRADER_LIVE_RECONCILIATION_ENABLED)) return true;

  const query = RoboSettingsModel.exists({
    mode: 'live',
    liveTradingExplicitlyEnabled: true
  });
  const result = typeof query?.lean === 'function'
    ? await query.lean()
    : await query;
  return Boolean(result);
}

async function getScheduledReconciliationModes(options = {}) {
  const modes = ['paper'];
  if (await isLiveReconciliationEnabled(options)) modes.push('live');
  return modes;
}

function startRoboScheduler({
  intervalMs = 60 * 1000,
  cleanupIntervalMs = Number(process.env.ROBO_SIGNAL_CLEANUP_INTERVAL_MS) || (6 * 60 * 60 * 1000),
  reconciliationIntervalMs = Number(process.env.ROBOTRADER_RECONCILIATION_INTERVAL_MS) || (5 * 60 * 1000),
  retentionDays = process.env.ROBO_SIGNAL_RETENTION_DAYS,
  decisionRetentionDays = process.env.ROBOTRADER_DECISION_RETENTION_DAYS,
  auditLogRetentionDays = process.env.ROBOTRADER_AUDIT_LOG_RETENTION_DAYS,
  startupDelayMs = 5000,
  isDbReady = defaultIsDbReady,
  controlledLiveWatchdog = enforceControlledLiveWatchdog,
  livePromotionExpiry = expireLivePromotions,
  strategyEvidenceDemotion = enforceStrategyEvidenceDemotion
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
  let lastReconciliationAt = 0;
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
      const shouldRunLegacyScheduler = isLegacySchedulerEnabled();
      const shouldRunPhase1Worker = isPhase1WorkerEnabled();
      schedulerState.legacySchedulerEnabled = shouldRunLegacyScheduler;
      schedulerState.phase1WorkerEnabled = shouldRunPhase1Worker;

      if (isDbReady()) {
        await controlledLiveWatchdog({ now: new Date() });
        await livePromotionExpiry({ now: new Date() });
        await strategyEvidenceDemotion({ now: new Date() });
      }

      if (shouldRunLegacyScheduler) {
        await roboEngine.runSchedulerTick();
        schedulerState.lastLegacySchedulerAt = new Date();
      }
      if (shouldRunPhase1Worker && isDbReady()) {
        await roboTraderWorker.runWorkerTick();
        schedulerState.lastPhase1WorkerAt = new Date();
      }
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
          const decisionResult = await roboTraderWorker.cleanupRoboTradeDecisions({
            olderThanDays: decisionRetentionDays
          });
          if (decisionResult.deletedCount > 0) {
            console.log(
              `[robo-scheduler] cleaned ${decisionResult.deletedCount} RoboTrader decisions older than ${decisionResult.retentionDays} days`
            );
          }
          const auditLogResult = await roboTraderWorker.cleanupRoboAuditLogs({
            olderThanDays: auditLogRetentionDays
          });
          if (auditLogResult.deletedCount > 0) {
            console.log(
              `[robo-scheduler] cleaned ${auditLogResult.deletedCount} RoboTrader audit logs older than ${auditLogResult.retentionDays} days`
            );
          }
        } catch (err) {
          console.error('Robo scheduler cleanup failed:', err.message);
        }
      }
      const reconciliationEveryMs = toFinitePositiveInt(reconciliationIntervalMs, 5 * 60 * 1000);
      if (
        process.env.ROBOTRADER_RECONCILIATION_DISABLED !== 'true'
        && isDbReady()
        && (nowMs - lastReconciliationAt) >= reconciliationEveryMs
      ) {
        lastReconciliationAt = nowMs;
        schedulerState.lastReconciliationAt = new Date(nowMs);
        try {
          let reconciliationModes = ['paper'];
          try {
            reconciliationModes = await getScheduledReconciliationModes();
          } catch (err) {
            console.error('RoboTrader live reconciliation gate failed:', err.message);
          }

          for (const mode of reconciliationModes) {
            try {
              await roboReconciliation.reconcileRoboOrders({ mode });
            } catch (err) {
              console.error(`RoboTrader ${mode} reconciliation failed:`, err.message);
            }
          }
        } catch (err) {
          console.error('RoboTrader reconciliation failed:', err.message);
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
    lastCleanupAt: schedulerState.lastCleanupAt,
    lastLegacySchedulerAt: schedulerState.lastLegacySchedulerAt,
    lastPhase1WorkerAt: schedulerState.lastPhase1WorkerAt,
    lastReconciliationAt: schedulerState.lastReconciliationAt,
    legacySchedulerEnabled: schedulerState.legacySchedulerEnabled,
    phase1WorkerEnabled: schedulerState.phase1WorkerEnabled
  };
}

module.exports = {
  startRoboScheduler,
  getSchedulerStatus,
  hasLiveAlpacaConfig,
  isLegacySchedulerEnabled,
  isPhase1WorkerEnabled,
  isLiveReconciliationEnabled,
  getScheduledReconciliationModes
};
