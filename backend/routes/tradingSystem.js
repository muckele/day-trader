const router = require('express').Router();
const auth = require('../middleware/auth');
const { getTradingConfig, summarizeConfigWarnings } = require('../config/tradingConfig');
const { getFeatureFlagsSnapshot } = require('../services/featureFlagService');
const { getRiskLimitsSnapshot } = require('../services/riskConfigService');
const { listStrategies } = require('../services/strategyRegistry');
const { listRecentExecution } = require('../services/executionTelemetryService');
const {
  listRecentParameterVersions,
  listRecentStrategyRuns
} = require('../services/strategyRunService');
const { getMongoServiceState, isMongoReady } = require('../utils/mongoState');
const { getRequestAccountId } = require('../utils/accountScope');

router.use(auth);

function getDataWarning() {
  if (isMongoReady()) return null;
  return {
    warning: 'DATA_UNAVAILABLE',
    message: 'MongoDB unavailable. Showing config-backed data only.'
  };
}

function buildExecutionSummary(orders = [], fills = []) {
  const filledOrders = orders.filter(order => order.status === 'filled');
  const rejectedOrders = orders.filter(order => order.status === 'rejected');
  const attemptedOrders = filledOrders.length + rejectedOrders.length;
  const rejectRate = attemptedOrders
    ? Number(((rejectedOrders.length / attemptedOrders) * 100).toFixed(2))
    : 0;

  return {
    attemptedOrders,
    filledOrders: filledOrders.length,
    rejectedOrders: rejectedOrders.length,
    fills: fills.length,
    rejectRate
  };
}

router.get('/status', async (_req, res, next) => {
  try {
    const config = getTradingConfig();
    const [featureFlags, riskLimits, strategies] = await Promise.all([
      getFeatureFlagsSnapshot(),
      getRiskLimitsSnapshot(),
      listStrategies()
    ]);
    res.json({
      environment: config.environment,
      mongo: getMongoServiceState(),
      featureFlags,
      riskLimits,
      strategyCount: strategies.length,
      strategies,
      warnings: summarizeConfigWarnings(config),
      ...(getDataWarning() || {})
    });
  } catch (err) {
    next(err);
  }
});

router.get('/strategy-runs', async (req, res, next) => {
  try {
    const { limit = 25, runType = null } = req.query;
    const runs = await listRecentStrategyRuns({ limit, runType });
    res.json({
      items: runs,
      ...(getDataWarning() || {})
    });
  } catch (err) {
    next(err);
  }
});

router.get('/strategy-parameters', async (req, res, next) => {
  try {
    const { limit = 25, strategyId = null } = req.query;
    const items = await listRecentParameterVersions({ limit, strategyId });
    res.json({
      items,
      ...(getDataWarning() || {})
    });
  } catch (err) {
    next(err);
  }
});

router.get('/execution', async (req, res, next) => {
  try {
    const accountId = getRequestAccountId(req);
    const { limit = 25 } = req.query;
    const { orders, fills } = await listRecentExecution({ limit, accountId });
    res.json({
      orders,
      fills,
      summary: buildExecutionSummary(orders, fills),
      ...(getDataWarning() || {})
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
