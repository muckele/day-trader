const DEFAULT_RECOMMENDATION_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'TSLA', 'AVGO', 'AMD',
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLI', 'XLV', 'XLP', 'XLY', 'XLU',
  'TLT', 'AGG', 'BND', 'HYG', 'LQD', 'GLD', 'SLV'
];

const DEFAULT_ETF_SYMBOLS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLI', 'XLV', 'XLP', 'XLY', 'XLU',
  'TLT', 'AGG', 'BND', 'HYG', 'LQD', 'GLD', 'SLV', 'ARKK', 'XBI', 'SMH'
];

const DEFAULT_LEVERAGED_ETF_SYMBOLS = [
  'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SOXL', 'SOXS', 'LABU', 'LABD', 'FAS', 'FAZ'
];

const DEFAULT_INVERSE_ETF_SYMBOLS = [
  'SQQQ', 'SPXU', 'SOXS', 'LABD', 'FAZ', 'PSQ', 'SH', 'DOG', 'RWM'
];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseInteger(value, fallback) {
  const numeric = Math.floor(parseNumber(value, fallback));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseCsv(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function buildSymbolSet(primary, fallback = []) {
  return new Set(parseCsv(primary, fallback));
}

function buildTradingConfig(env = process.env) {
  const paperTradingEnabled = parseBoolean(env.PAPER_TRADING_ENABLED, true);
  const liveTradingEnabled = parseBoolean(env.LIVE_TRADING_ENABLED, false);
  const shortSellingEnabled = parseBoolean(env.SHORT_SELLING_ENABLED, false);
  const marginEnabled = parseBoolean(env.MARGIN_TRADING_ENABLED, false);
  const optionsEnabled = parseBoolean(env.OPTIONS_TRADING_ENABLED, false);
  const cryptoEnabled = parseBoolean(env.CRYPTO_TRADING_ENABLED, true);
  const leveragedEtfEnabled = parseBoolean(env.LEVERAGED_ETF_ENABLED, false);
  const inverseEtfEnabled = parseBoolean(env.INVERSE_ETF_ENABLED, false);
  const recommendationUniverse = parseCsv(
    env.RECOMMENDATION_UNIVERSE,
    DEFAULT_RECOMMENDATION_UNIVERSE
  );

  return {
    environment: {
      paperTradingEnabled,
      liveTradingEnabled,
      defaultExecutionMode: liveTradingEnabled ? 'live' : 'paper'
    },
    features: {
      roboEnabled: parseBoolean(env.ROBO_FEATURE_ENABLED, true),
      liveTradingEnabled,
      shortSellingEnabled,
      marginEnabled,
      optionsEnabled,
      cryptoEnabled,
      leveragedEtfEnabled,
      inverseEtfEnabled,
      adminApprovalQueueEnabled: parseBoolean(env.ADMIN_APPROVAL_QUEUE_ENABLED, false),
      manualKillSwitchEnabled: true
    },
    recommendation: {
      engineVersion: env.RECOMMENDATION_ENGINE_VERSION || 'phase1-multifactor-v1',
      benchmarkSymbol: String(env.RECOMMENDATION_BENCHMARK || 'SPY').trim().toUpperCase(),
      universe: recommendationUniverse,
      maxIdeasPerList: Math.max(1, parseInteger(env.RECOMMENDATION_MAX_IDEAS_PER_LIST, 5)),
      topRecommendationCount: Math.max(1, parseInteger(env.RECOMMENDATION_TOP_COUNT, 5)),
      weights: {
        trend: parseNumber(env.RECOMMENDATION_WEIGHT_TREND, 0.24),
        momentum: parseNumber(env.RECOMMENDATION_WEIGHT_MOMENTUM, 0.18),
        relativeStrength: parseNumber(env.RECOMMENDATION_WEIGHT_RS, 0.16),
        liquidity: parseNumber(env.RECOMMENDATION_WEIGHT_LIQUIDITY, 0.16),
        volatility: parseNumber(env.RECOMMENDATION_WEIGHT_VOLATILITY, 0.14),
        riskDiscipline: parseNumber(env.RECOMMENDATION_WEIGHT_RISK, 0.12)
      }
    },
    risk: {
      maxDailyRealizedLossPct: parseNumber(env.RISK_MAX_DAILY_REALIZED_LOSS_PCT, 2),
      maxDailyTotalLossPct: parseNumber(env.RISK_MAX_DAILY_TOTAL_LOSS_PCT, 3),
      maxWeeklyDrawdownPct: parseNumber(env.RISK_MAX_WEEKLY_DRAWDOWN_PCT, 5),
      maxMonthlyDrawdownPct: parseNumber(env.RISK_MAX_MONTHLY_DRAWDOWN_PCT, 8),
      maxConcurrentPositions: Math.max(1, parseInteger(env.RISK_MAX_CONCURRENT_POSITIONS, 12)),
      maxGrossExposurePct: parseNumber(env.RISK_MAX_GROSS_EXPOSURE_PCT, 100),
      maxNetExposurePct: parseNumber(env.RISK_MAX_NET_EXPOSURE_PCT, 70),
      maxLongExposurePct: parseNumber(env.RISK_MAX_LONG_EXPOSURE_PCT, 80),
      maxShortExposurePct: parseNumber(env.RISK_MAX_SHORT_EXPOSURE_PCT, 25),
      maxPerPositionRiskPct: parseNumber(env.RISK_MAX_PER_POSITION_RISK_PCT, 1),
      maxStrategyAllocationPct: parseNumber(env.RISK_MAX_STRATEGY_ALLOCATION_PCT, 20),
      maxLeveragedEtfExposurePct: parseNumber(env.RISK_MAX_LEVERAGED_ETF_EXPOSURE_PCT, 10),
      maxInverseEtfExposurePct: parseNumber(env.RISK_MAX_INVERSE_ETF_EXPOSURE_PCT, 10),
      maxCryptoExposurePct: parseNumber(env.RISK_MAX_CRYPTO_EXPOSURE_PCT, 10),
      maxOptionsPremiumRiskPct: parseNumber(env.RISK_MAX_OPTIONS_PREMIUM_RISK_PCT, 3)
    },
    notifications: {
      recipients: parseCsv(env.ALERT_RECIPIENTS, []),
      dailySummaryEnabled: parseBoolean(env.DAILY_SUMMARY_EMAIL_ENABLED, false),
      weeklyReviewEnabled: parseBoolean(env.WEEKLY_STRATEGY_EMAIL_ENABLED, false)
    },
    symbols: {
      etfs: buildSymbolSet(env.ETF_SYMBOLS, DEFAULT_ETF_SYMBOLS),
      leveragedEtfs: buildSymbolSet(env.LEVERAGED_ETF_SYMBOLS, DEFAULT_LEVERAGED_ETF_SYMBOLS),
      inverseEtfs: buildSymbolSet(env.INVERSE_ETF_SYMBOLS, DEFAULT_INVERSE_ETF_SYMBOLS)
    }
  };
}

function getTradingConfig() {
  return buildTradingConfig(process.env);
}

function getRecommendationUniverse() {
  return getTradingConfig().recommendation.universe;
}

function classifyInstrumentPolicy(symbol, assetClass = 'equity', config = getTradingConfig()) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedAssetClass = String(assetClass || 'equity').trim().toLowerCase();
  const isCrypto = normalizedAssetClass === 'crypto';
  const isEtf = !isCrypto && config.symbols.etfs.has(normalizedSymbol);
  const isLeveragedEtf = !isCrypto && config.symbols.leveragedEtfs.has(normalizedSymbol);
  const isInverseEtf = !isCrypto && config.symbols.inverseEtfs.has(normalizedSymbol);
  return {
    symbol: normalizedSymbol,
    assetClass: normalizedAssetClass,
    isCrypto,
    isEtf,
    isLeveragedEtf,
    isInverseEtf
  };
}

function summarizeConfigWarnings(config = getTradingConfig()) {
  const warnings = [];
  if (!config.environment.paperTradingEnabled) {
    warnings.push('Paper trading is disabled. This is not recommended for local validation.');
  }
  if (config.environment.liveTradingEnabled) {
    warnings.push('Live trading is enabled. Confirm broker endpoint, approvals, and kill switches.');
  }
  if (config.features.optionsEnabled) {
    warnings.push('Options support is flagged on, but only paper-safe overlays should be enabled.');
  }
  if (config.features.leveragedEtfEnabled || config.features.inverseEtfEnabled) {
    warnings.push('Leveraged/inverse ETF flags are enabled. Confirm separate exposure caps and hold rules.');
  }
  return warnings;
}

module.exports = {
  DEFAULT_RECOMMENDATION_UNIVERSE,
  buildTradingConfig,
  classifyInstrumentPolicy,
  getRecommendationUniverse,
  getTradingConfig,
  summarizeConfigWarnings
};
