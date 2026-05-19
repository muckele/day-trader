const RiskLimitConfig = require('../models/RiskLimitConfig');
const mongoState = require('../utils/mongoState');
const { getTradingConfig } = require('../config/tradingConfig');

function buildDefaultRiskLimits() {
  return { ...getTradingConfig().risk };
}

async function getRiskLimitsSnapshot({ strategyId = null } = {}) {
  const defaults = buildDefaultRiskLimits();
  if (!mongoState.isMongoReady()) {
    return defaults;
  }

  try {
    const query = strategyId
      ? { active: true, $or: [{ scope: 'global' }, { scope: 'strategy', strategyId }] }
      : { active: true, scope: 'global' };
    const docs = await RiskLimitConfig.find(query).sort({ updatedAt: 1 }).lean();
    const merged = { ...defaults };
    docs.forEach(doc => {
      const limits = doc?.limits || {};
      Object.entries(limits).forEach(([key, value]) => {
        if (value !== null && value !== undefined) merged[key] = value;
      });
    });
    return merged;
  } catch (_err) {
    return defaults;
  }
}

module.exports = {
  buildDefaultRiskLimits,
  getRiskLimitsSnapshot
};
