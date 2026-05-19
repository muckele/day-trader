const { getTradingConfig } = require('../config/tradingConfig');
const { getFeatureFlagsSnapshot } = require('./featureFlagService');

const BASE_STRATEGIES = [
  {
    strategyId: 'TREND_FOLLOWING_EQUITIES',
    name: 'Trend Following Equities',
    description: 'Momentum and moving-average alignment for liquid equities.',
    assetClasses: ['equity'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['TREND_RISK_ON', 'LOW_VOL_GRIND'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 20,
    holdingPeriod: 'SWING',
    riskProfile: 'core_trend',
    tags: ['trend', 'momentum', 'equity']
  },
  {
    strategyId: 'SWING_BREAKOUT_EQUITIES',
    name: 'Swing Breakout Equities',
    description: 'Breakout entries in high-quality liquid names.',
    assetClasses: ['equity'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['TREND_RISK_ON'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 15,
    holdingPeriod: 'SWING',
    riskProfile: 'breakout',
    tags: ['breakout', 'momentum', 'equity']
  },
  {
    strategyId: 'MEAN_REVERSION_EQUITIES',
    name: 'Mean Reversion Equities',
    description: 'Oversold and overbought reversion setups in liquid names.',
    assetClasses: ['equity'],
    allowedSides: ['LONG', 'SHORT'],
    compatibleRegimes: ['CHOP', 'HIGH_VOL_RISK_OFF'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 12,
    holdingPeriod: 'SHORT_SWING',
    riskProfile: 'mean_reversion',
    tags: ['meanReversion', 'equity']
  },
  {
    strategyId: 'ETF_ROTATION',
    name: 'ETF Rotation',
    description: 'Cross-sectional ranking for liquid benchmark and sector ETFs.',
    assetClasses: ['etf'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['TREND_RISK_ON', 'LOW_VOL_GRIND', 'DEFENSIVE'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 25,
    holdingPeriod: 'SWING',
    riskProfile: 'rotation',
    tags: ['etf', 'rotation', 'macro']
  },
  {
    strategyId: 'LONG_SHORT_LITE',
    name: 'Long/Short Lite',
    description: 'Conservative short-side and relative-strength dispersion ideas.',
    assetClasses: ['equity', 'etf'],
    allowedSides: ['LONG', 'SHORT'],
    compatibleRegimes: ['TREND_RISK_ON', 'HIGH_VOL_RISK_OFF', 'CHOP'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 15,
    holdingPeriod: 'SWING',
    riskProfile: 'relative_value',
    tags: ['short', 'dispersion', 'risk_controlled']
  },
  {
    strategyId: 'OPTIONS_OVERLAY',
    name: 'Options Overlay',
    description: 'Defined-risk overlays on liquid underlyings only.',
    assetClasses: ['options'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['TREND_RISK_ON', 'HIGH_VOL_RISK_OFF'],
    paperEligible: false,
    liveEligible: false,
    maxAllocationPct: 5,
    holdingPeriod: 'TACTICAL',
    riskProfile: 'options_overlay',
    tags: ['options', 'overlay', 'defined_risk']
  },
  {
    strategyId: 'DEFENSIVE_HEDGE',
    name: 'Defensive Hedge',
    description: 'Risk-off ETF hedging and capital-preservation overlays.',
    assetClasses: ['etf'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['HIGH_VOL_RISK_OFF', 'DEFENSIVE'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 12,
    holdingPeriod: 'SWING',
    riskProfile: 'defensive',
    tags: ['hedge', 'defensive', 'etf']
  },
  {
    strategyId: 'CRYPTO_MOMENTUM',
    name: 'Crypto Momentum',
    description: 'Momentum module for crypto, only when crypto is explicitly enabled.',
    assetClasses: ['crypto'],
    allowedSides: ['LONG'],
    compatibleRegimes: ['TREND_RISK_ON'],
    paperEligible: true,
    liveEligible: false,
    maxAllocationPct: 8,
    holdingPeriod: 'TACTICAL',
    riskProfile: 'crypto',
    tags: ['crypto', 'momentum']
  }
];

function computeStrategyEnabled(strategy, flags, config) {
  if (strategy.assetClasses.includes('options') && !flags.optionsEnabled) return false;
  if (strategy.assetClasses.includes('crypto') && !flags.cryptoEnabled) return false;
  if (strategy.allowedSides.includes('SHORT') && !flags.shortSellingEnabled && strategy.strategyId === 'LONG_SHORT_LITE') {
    return false;
  }
  if (!config.features.roboEnabled && strategy.strategyId !== 'OPTIONS_OVERLAY') return false;
  return true;
}

async function listStrategies() {
  const config = getTradingConfig();
  const flags = await getFeatureFlagsSnapshot();
  return BASE_STRATEGIES.map(strategy => ({
    ...strategy,
    enabled: computeStrategyEnabled(strategy, flags, config),
    liveEligible: strategy.liveEligible && flags.liveTradingEnabled,
    paperEligible: strategy.paperEligible && config.environment.paperTradingEnabled
  }));
}

async function getStrategyDefinition(strategyId) {
  const strategies = await listStrategies();
  return strategies.find(strategy => strategy.strategyId === strategyId) || null;
}

module.exports = {
  BASE_STRATEGIES,
  getStrategyDefinition,
  listStrategies
};
