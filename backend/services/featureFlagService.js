const FeatureFlag = require('../models/FeatureFlag');
const mongoState = require('../utils/mongoState');
const { getTradingConfig } = require('../config/tradingConfig');

function buildDefaultFlags() {
  const config = getTradingConfig();
  return {
    roboEnabled: config.features.roboEnabled,
    liveTradingEnabled: config.features.liveTradingEnabled,
    shortSellingEnabled: config.features.shortSellingEnabled,
    marginEnabled: config.features.marginEnabled,
    optionsEnabled: config.features.optionsEnabled,
    cryptoEnabled: config.features.cryptoEnabled,
    leveragedEtfEnabled: config.features.leveragedEtfEnabled,
    inverseEtfEnabled: config.features.inverseEtfEnabled,
    adminApprovalQueueEnabled: config.features.adminApprovalQueueEnabled,
    manualKillSwitchEnabled: config.features.manualKillSwitchEnabled
  };
}

async function getFeatureFlagsSnapshot() {
  const defaults = buildDefaultFlags();
  if (!mongoState.isMongoReady()) {
    return defaults;
  }

  try {
    const docs = await FeatureFlag.find({ scope: 'global' }).lean();
    return docs.reduce((acc, doc) => {
      if (!doc?.key) return acc;
      acc[doc.key] = Boolean(doc.enabled);
      return acc;
    }, { ...defaults });
  } catch (_err) {
    return defaults;
  }
}

module.exports = {
  buildDefaultFlags,
  getFeatureFlagsSnapshot
};
