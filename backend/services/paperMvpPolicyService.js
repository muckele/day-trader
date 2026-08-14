const PAPER_MVP_SYMBOL = 'AAPL';
const PAPER_MVP_STRATEGY_ID = 'ROBO_TREND_FOLLOWING_V1';

const PAPER_MVP_LIMITS = Object.freeze({
  maxTradeAmount: 100,
  maxPositionSize: 250,
  maxDailyLoss: 50,
  maxOpenPositions: 1,
  maxTradesPerDay: 1
});

function toNonnegativeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function toNonnegativeInteger(value, fallback) {
  return Math.floor(toNonnegativeNumber(value, fallback));
}

function stricterPositiveLimit(current, hardLimit) {
  const normalized = toNonnegativeNumber(current, hardLimit);
  if (normalized === 0) return 0;
  return Math.min(normalized, hardLimit);
}

function buildPaperMvpSettings(settings = {}) {
  return {
    ...settings,
    mode: 'paper',
    liveTradingExplicitlyEnabled: false,
    allowedAssetClasses: ['stocks'],
    allowedSymbols: [PAPER_MVP_SYMBOL],
    blockedSymbols: (settings.blockedSymbols || []).filter(symbol => symbol !== PAPER_MVP_SYMBOL),
    activeStrategyId: PAPER_MVP_STRATEGY_ID,
    maxTradeAmount: stricterPositiveLimit(
      settings.maxTradeAmount,
      PAPER_MVP_LIMITS.maxTradeAmount
    ),
    maxPositionSize: stricterPositiveLimit(
      settings.maxPositionSize,
      PAPER_MVP_LIMITS.maxPositionSize
    ),
    maxDailyLoss: stricterPositiveLimit(
      settings.maxDailyLoss,
      PAPER_MVP_LIMITS.maxDailyLoss
    ),
    maxOpenPositions: Math.min(
      toNonnegativeInteger(settings.maxOpenPositions, PAPER_MVP_LIMITS.maxOpenPositions),
      PAPER_MVP_LIMITS.maxOpenPositions
    ),
    maxTradesPerDay: Math.min(
      toNonnegativeInteger(settings.maxTradesPerDay, PAPER_MVP_LIMITS.maxTradesPerDay),
      PAPER_MVP_LIMITS.maxTradesPerDay
    ),
    allowShortSelling: false,
    allowExtendedHours: false,
    allowOptionsTrading: false,
    allowCryptoTrading: false
  };
}

function getExpectedParameterVersionId(settings = {}, env = process.env) {
  return String(
    env.PAPER_MVP_PARAMETER_VERSION_ID
      || settings.activeParameterVersionId
      || ''
  ).trim() || null;
}

function evaluatePaperMvpConfiguration(settings = {}, env = process.env) {
  const expectedParameterVersionId = getExpectedParameterVersionId(settings, env);
  const checks = [
    {
      key: 'paper_environment',
      passed: settings.mode === 'paper' && settings.liveTradingExplicitlyEnabled !== true,
      detail: 'The Paper MVP requires paper mode with live opt-in disabled.'
    },
    {
      key: 'aapl_only',
      passed: Array.isArray(settings.allowedSymbols)
        && settings.allowedSymbols.length === 1
        && settings.allowedSymbols[0] === PAPER_MVP_SYMBOL,
      detail: `The Paper MVP symbol cohort is frozen to ${PAPER_MVP_SYMBOL}.`
    },
    {
      key: 'frozen_strategy',
      passed: settings.activeStrategyId === PAPER_MVP_STRATEGY_ID,
      detail: `The Paper MVP strategy is frozen to ${PAPER_MVP_STRATEGY_ID}.`
    },
    {
      key: 'frozen_parameter_version',
      passed: Boolean(
        expectedParameterVersionId
        && String(settings.activeParameterVersionId || '') === expectedParameterVersionId
      ),
      detail: expectedParameterVersionId
        ? 'The selected parameter version matches the Paper MVP binding.'
        : 'A stored Paper MVP parameter version must be selected.'
    },
    {
      key: 'paper_capabilities',
      passed: Array.isArray(settings.allowedAssetClasses)
        && settings.allowedAssetClasses.length === 1
        && settings.allowedAssetClasses[0] === 'stocks'
        && settings.allowShortSelling !== true
        && settings.allowExtendedHours !== true
        && settings.allowOptionsTrading !== true
        && settings.allowCryptoTrading !== true,
      detail: 'The Paper MVP permits regular-session long stock orders only.'
    },
    {
      key: 'paper_risk_envelope',
      passed: Number(settings.maxTradeAmount) <= PAPER_MVP_LIMITS.maxTradeAmount
        && Number(settings.maxPositionSize) <= PAPER_MVP_LIMITS.maxPositionSize
        && Number(settings.maxDailyLoss) <= PAPER_MVP_LIMITS.maxDailyLoss
        && Number(settings.maxOpenPositions) <= PAPER_MVP_LIMITS.maxOpenPositions
        && Number(settings.maxTradesPerDay) <= PAPER_MVP_LIMITS.maxTradesPerDay,
      detail: 'The Paper MVP risk envelope is no looser than its fixed release limits.'
    },
    {
      key: 'deployment_live_disabled',
      passed: String(env.LIVE_TRADING_ENABLED || 'false').trim().toLowerCase() !== 'true',
      detail: 'LIVE_TRADING_ENABLED must remain false for the Paper MVP.'
    }
  ];

  return {
    passed: checks.every(check => check.passed),
    symbol: PAPER_MVP_SYMBOL,
    strategyId: PAPER_MVP_STRATEGY_ID,
    parameterVersionId: expectedParameterVersionId,
    limits: PAPER_MVP_LIMITS,
    checks
  };
}

function assertPaperMvpConfiguration(settings = {}, env = process.env) {
  const assessment = evaluatePaperMvpConfiguration(settings, env);
  if (assessment.passed) return assessment;
  const err = new Error('The frozen AAPL Paper MVP configuration is incomplete or unsafe.');
  err.code = 'PAPER_MVP_CONFIGURATION_INVALID';
  err.status = 409;
  err.assessment = assessment;
  throw err;
}

module.exports = {
  PAPER_MVP_LIMITS,
  PAPER_MVP_STRATEGY_ID,
  PAPER_MVP_SYMBOL,
  assertPaperMvpConfiguration,
  buildPaperMvpSettings,
  evaluatePaperMvpConfiguration,
  getExpectedParameterVersionId
};
