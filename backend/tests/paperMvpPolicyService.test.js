const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAPER_MVP_LIMITS,
  PAPER_MVP_STRATEGY_ID,
  PAPER_MVP_SYMBOL,
  assertPaperMvpConfiguration,
  buildPaperMvpSettings,
  evaluatePaperMvpConfiguration
} = require('../services/paperMvpPolicyService');

test('Paper MVP settings freeze AAPL, strategy, capabilities, and hard limits', () => {
  const settings = buildPaperMvpSettings({
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    activeParameterVersionId: '507f1f77bcf86cd799439011',
    allowedSymbols: ['MSFT'],
    maxTradeAmount: 1000,
    maxPositionSize: 5000,
    maxDailyLoss: 500,
    maxOpenPositions: 10,
    maxTradesPerDay: 10,
    allowShortSelling: true,
    allowExtendedHours: true,
    allowOptionsTrading: true,
    allowCryptoTrading: true
  });

  assert.equal(settings.mode, 'paper');
  assert.equal(settings.liveTradingExplicitlyEnabled, false);
  assert.deepEqual(settings.allowedSymbols, [PAPER_MVP_SYMBOL]);
  assert.equal(settings.activeStrategyId, PAPER_MVP_STRATEGY_ID);
  assert.equal(settings.activeParameterVersionId, '507f1f77bcf86cd799439011');
  assert.equal(settings.maxTradeAmount, PAPER_MVP_LIMITS.maxTradeAmount);
  assert.equal(settings.maxPositionSize, PAPER_MVP_LIMITS.maxPositionSize);
  assert.equal(settings.maxDailyLoss, PAPER_MVP_LIMITS.maxDailyLoss);
  assert.equal(settings.maxOpenPositions, PAPER_MVP_LIMITS.maxOpenPositions);
  assert.equal(settings.maxTradesPerDay, PAPER_MVP_LIMITS.maxTradesPerDay);
  assert.equal(settings.allowShortSelling, false);
  assert.equal(settings.allowExtendedHours, false);
  assert.equal(settings.allowOptionsTrading, false);
  assert.equal(settings.allowCryptoTrading, false);
});

test('Paper MVP policy preserves stricter limits and requires one frozen parameter version', () => {
  const settings = buildPaperMvpSettings({
    activeParameterVersionId: '507f1f77bcf86cd799439011',
    maxTradeAmount: 25,
    maxPositionSize: 100,
    maxDailyLoss: 10,
    maxOpenPositions: 0,
    maxTradesPerDay: 0
  });
  const env = {
    LIVE_TRADING_ENABLED: 'false',
    PAPER_MVP_PARAMETER_VERSION_ID: '507f1f77bcf86cd799439011'
  };

  assert.equal(settings.maxTradeAmount, 25);
  assert.equal(settings.maxPositionSize, 100);
  assert.equal(settings.maxDailyLoss, 10);
  assert.equal(settings.maxOpenPositions, 0);
  assert.equal(settings.maxTradesPerDay, 0);
  assert.equal(evaluatePaperMvpConfiguration(settings, env).passed, true);
  assert.doesNotThrow(() => assertPaperMvpConfiguration(settings, env));

  assert.throws(
    () => assertPaperMvpConfiguration(settings, {
      ...env,
      PAPER_MVP_PARAMETER_VERSION_ID: '507f191e810c19729de860ea'
    }),
    err => err.code === 'PAPER_MVP_CONFIGURATION_INVALID'
  );
  assert.throws(
    () => assertPaperMvpConfiguration(settings, {
      ...env,
      LIVE_TRADING_ENABLED: 'true'
    }),
    err => err.code === 'PAPER_MVP_CONFIGURATION_INVALID'
  );
});
