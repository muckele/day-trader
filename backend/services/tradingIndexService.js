const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const OrderIntent = require('../models/OrderIntent');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const RoboLock = require('../models/RoboLock');
const RoboSettings = require('../models/RoboSettings');
const RoboSignalExecution = require('../models/RoboSignalExecution');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');

const TRADING_INDEX_MODELS = [
  BrokerOrder,
  Fill,
  OrderIntent,
  PaperOrder,
  PaperTrade,
  RoboLock,
  RoboSettings,
  RoboSignalExecution,
  RoboTradeDecision,
  RoboTradeOrder
];

async function ensureTradingIndexes({ logger = console, models = TRADING_INDEX_MODELS } = {}) {
  const results = [];
  for (const model of models) {
    try {
      await model.createIndexes();
      results.push({ model: model.modelName, ok: true });
    } catch (err) {
      results.push({
        model: model.modelName,
        ok: false,
        error: err?.message || 'Index creation failed.'
      });
      logger.error(`[indexes] ${model.modelName} index creation failed:`, err?.message || err);
    }
  }
  return results;
}

module.exports = {
  ensureTradingIndexes,
  TRADING_INDEX_MODELS
};
