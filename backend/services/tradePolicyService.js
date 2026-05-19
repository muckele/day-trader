const { classifyInstrumentPolicy, getTradingConfig } = require('../config/tradingConfig');
const { getFeatureFlagsSnapshot } = require('./featureFlagService');
const { getRiskLimitsSnapshot } = require('./riskConfigService');
const { getStrategyDefinition } = require('./strategyRegistry');

function looksLikePaperEndpoint(baseUrl) {
  return String(baseUrl || '').toLowerCase().includes('paper-api.alpaca.markets');
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildRegimeKey(regime = {}) {
  if (regime?.risk === 'RISK_OFF' && regime?.vol === 'EXPANSION') return 'HIGH_VOL_RISK_OFF';
  if (regime?.risk === 'RISK_OFF') return 'DEFENSIVE';
  if (regime?.trendChop === 'TREND' && regime?.risk === 'RISK_ON') return 'TREND_RISK_ON';
  if (regime?.vol === 'CONTRACTION' && regime?.risk === 'RISK_ON') return 'LOW_VOL_GRIND';
  return 'CHOP';
}

async function evaluateTradePolicy({
  symbol,
  side,
  assetClass = 'equity',
  strategyId = null,
  executionBackend = 'paper',
  alpacaBaseUrl = '',
  orderNotional = 0,
  regime = null,
  riskLimits = null,
  featureFlags = null,
  config = null
} = {}) {
  const resolvedConfig = config || getTradingConfig();
  const flags = featureFlags || await getFeatureFlagsSnapshot();
  const limits = riskLimits || await getRiskLimitsSnapshot({ strategyId });
  const instrument = classifyInstrumentPolicy(symbol, assetClass, resolvedConfig);
  const reasons = [];
  const normalizedSide = String(side || 'buy').trim().toLowerCase();
  const isShortIntent = normalizedSide === 'sell';
  const regimeKey = buildRegimeKey(regime);
  const strategy = strategyId ? await getStrategyDefinition(strategyId) : null;

  if (executionBackend === 'alpaca' && !looksLikePaperEndpoint(alpacaBaseUrl) && !flags.liveTradingEnabled) {
    reasons.push('Live Alpaca execution is disabled by feature flag.');
  }
  if (!resolvedConfig.environment.paperTradingEnabled && executionBackend !== 'alpaca') {
    reasons.push('Paper trading is disabled in configuration.');
  }
  if (instrument.isCrypto && !flags.cryptoEnabled) {
    reasons.push('Crypto trading is disabled by feature flag.');
  }
  if (instrument.assetClass === 'options' && !flags.optionsEnabled) {
    reasons.push('Options trading is disabled by feature flag.');
  }
  if (isShortIntent && !flags.shortSellingEnabled) {
    reasons.push('Short-selling is disabled by feature flag.');
  }
  if (instrument.isLeveragedEtf && !flags.leveragedEtfEnabled) {
    reasons.push('Leveraged ETF trading is disabled by feature flag.');
  }
  if (instrument.isInverseEtf && !flags.inverseEtfEnabled) {
    reasons.push('Inverse ETF trading is disabled by feature flag.');
  }
  if (strategy && strategy.enabled === false) {
    reasons.push(`Strategy ${strategy.strategyId} is disabled.`);
  }
  if (strategy && Array.isArray(strategy.compatibleRegimes) && strategy.compatibleRegimes.length) {
    if (!strategy.compatibleRegimes.includes(regimeKey)) {
      reasons.push(`Strategy ${strategy.strategyId} is not enabled for regime ${regimeKey}.`);
    }
  }
  if (instrument.isLeveragedEtf && toFiniteNumber(orderNotional, 0) > 0 && limits.maxLeveragedEtfExposurePct <= 0) {
    reasons.push('Leveraged ETF exposure cap is zero.');
  }
  if (instrument.isInverseEtf && toFiniteNumber(orderNotional, 0) > 0 && limits.maxInverseEtfExposurePct <= 0) {
    reasons.push('Inverse ETF exposure cap is zero.');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    instrument,
    regimeKey,
    strategy,
    flags,
    riskLimits: limits,
    mode: executionBackend === 'alpaca' && !looksLikePaperEndpoint(alpacaBaseUrl) ? 'live' : 'paper'
  };
}

module.exports = {
  buildRegimeKey,
  evaluateTradePolicy,
  looksLikePaperEndpoint
};
