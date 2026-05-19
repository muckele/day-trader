const RiskEvent = require('../models/RiskEvent');
const mongoState = require('../utils/mongoState');

async function writeRiskEvent({ source, severity = 'warning', eventType, symbol = null, strategyId = null, assetClass = null, message, payload = {} }) {
  if (!mongoState.isMongoReady()) return null;
  try {
    return await RiskEvent.create({
      source,
      severity,
      eventType,
      symbol,
      strategyId,
      assetClass,
      message,
      payload
    });
  } catch (_err) {
    return null;
  }
}

module.exports = {
  writeRiskEvent
};
