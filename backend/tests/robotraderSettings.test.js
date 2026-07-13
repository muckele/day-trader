const test = require('node:test');
const assert = require('node:assert/strict');
const RoboSettings = require('../models/RoboSettings');
const {
  AUTONOMOUS_CONFIRMATION_TEXT,
  getOrCreateRoboTraderSettings,
  LIVE_CONFIRMATION_TEXT,
  mapSettings,
  sanitizeSettingsUpdate,
  updateRoboTraderSettings
} = require('../robotrader/settingsService');

test('robotrader settings default to paper mode with live trading disabled', () => {
  const settings = mapSettings({});
  assert.equal(settings.mode, 'paper');
  assert.equal(settings.isEnabled, false);
  assert.equal(settings.controlGeneration, 0);
  assert.equal(settings.liveTradingExplicitlyEnabled, false);
  assert.deepEqual(settings.allowedAssetClasses, ['stocks']);
  assert.equal(settings.approvalPolicy.mode, 'every_trade');
  assert.equal(settings.approvalPolicy.requireExactOrderMatch, true);
  assert.equal(settings.executionPolicy.maxQuoteAgeSeconds, 15);
  assert.equal(settings.executionPolicy.regularSessionCutoffEt, '15:45');
  assert.equal(settings.portfolioPolicy.maxTotalDrawdownPct, 5);
});

test('robotrader settings support shadow mode without retaining live opt-in', () => {
  const update = sanitizeSettingsUpdate({ mode: 'shadow' }, {
    mode: 'live',
    liveTradingExplicitlyEnabled: true
  });

  assert.equal(update.mode, 'shadow');
  assert.equal(update.liveTradingExplicitlyEnabled, false);
});

test('execution and portfolio policies are bounded and keep the fixed cutoff', () => {
  const update = sanitizeSettingsUpdate({
    executionPolicy: {
      maxQuoteAgeSeconds: 0,
      maxSpreadBps: 9999,
      regularSessionCutoffEt: '23:59'
    },
    portfolioPolicy: {
      maxGrossExposurePct: 120,
      maxDailyDrawdownPct: 3,
      pauseOnBreach: 'false'
    }
  });

  assert.equal(update.executionPolicy.maxQuoteAgeSeconds, 1);
  assert.equal(update.executionPolicy.maxSpreadBps, 500);
  assert.equal(update.executionPolicy.regularSessionCutoffEt, '15:45');
  assert.equal(update.portfolioPolicy.maxGrossExposurePct, 120);
  assert.equal(update.portfolioPolicy.maxDailyDrawdownPct, 3);
  assert.equal(update.portfolioPolicy.pauseOnBreach, false);
});

test('robotrader settings require separate confirmation for autonomous mode', () => {
  assert.throws(
    () => sanitizeSettingsUpdate({ approvalPolicy: { mode: 'autonomous' } }, {}),
    /separate explicit confirmation/i
  );

  const update = sanitizeSettingsUpdate({
    approvalPolicy: { mode: 'autonomous' },
    confirmAutonomousTrading: AUTONOMOUS_CONFIRMATION_TEXT
  }, {});

  assert.equal(update.approvalPolicy.mode, 'autonomous');
  assert.equal(update.requireManualApprovalAboveDollarAmount, 0);
});

test('robotrader settings validation requires explicit live confirmation', () => {
  assert.throws(
    () => sanitizeSettingsUpdate({
      mode: 'live',
      liveTradingExplicitlyEnabled: true
    }),
    /Live trading requires explicit confirmation/
  );

  const update = sanitizeSettingsUpdate({
    mode: 'live',
    liveTradingExplicitlyEnabled: true,
    confirmLiveTrading: LIVE_CONFIRMATION_TEXT
  });

  assert.equal(update.mode, 'live');
  assert.equal(update.liveTradingExplicitlyEnabled, true);
});

test('switching to paper mode clears a stale live opt-in', () => {
  const update = sanitizeSettingsUpdate({ mode: 'paper' }, {
    mode: 'live',
    liveTradingExplicitlyEnabled: true
  });

  assert.equal(update.mode, 'paper');
  assert.equal(update.liveTradingExplicitlyEnabled, false);
});

test('an existing autonomous policy can be saved without repeating confirmation', () => {
  const update = sanitizeSettingsUpdate({
    approvalPolicy: {
      mode: 'autonomous',
      authorizationTtlSeconds: 600
    }
  }, {
    approvalPolicy: { mode: 'autonomous' }
  });

  assert.equal(update.approvalPolicy.mode, 'autonomous');
  assert.equal(update.approvalPolicy.authorizationTtlSeconds, 600);
});

test('legacy manual-approval threshold is not masked by the Mongoose policy default', () => {
  const legacy = new RoboSettings({
    userId: '507f1f77bcf86cd799439011',
    requireManualApprovalAboveDollarAmount: 250
  });
  const settings = mapSettings(legacy);

  assert.equal(settings.approvalPolicy.mode, 'above_threshold');
  assert.equal(settings.approvalPolicy.thresholdUsd, 250);
});

test('robotrader settings normalizes symbols and asset classes', () => {
  const update = sanitizeSettingsUpdate({
    allowedAssetClasses: ['equity', 'crypto', 'option'],
    allowedSymbols: 'aapl, msft, btc/usd',
    blockedSymbols: [' gme ', 'tsla!!']
  });

  assert.deepEqual(update.allowedAssetClasses, ['stocks', 'crypto', 'options']);
  assert.deepEqual(update.allowedSymbols, ['AAPL', 'MSFT', 'BTC/USD']);
  assert.deepEqual(update.blockedSymbols, ['GME', 'TSLA']);
});

test('robotrader settings sanitizes boolean string values', () => {
  const update = sanitizeSettingsUpdate({
    allowShortSelling: 'false',
    allowOptionsTrading: 'false',
    allowCryptoTrading: 'false',
    allowFractionalShares: 'false',
    allowExtendedHours: 'true'
  });

  assert.equal(update.allowShortSelling, false);
  assert.equal(update.allowOptionsTrading, false);
  assert.equal(update.allowCryptoTrading, false);
  assert.equal(update.allowFractionalShares, false);
  assert.equal(update.allowExtendedHours, true);
});

test('robotrader settings recovers from concurrent default create race', async t => {
  let findCount = 0;
  t.mock.method(RoboSettings, 'findOne', () => ({
    sort: async () => {
      findCount += 1;
      return findCount === 1
        ? null
        : { userId: 'race-user', isEnabled: false, mode: 'paper' };
    }
  }));
  t.mock.method(RoboSettings, 'create', async () => {
    const err = new Error('duplicate key');
    err.code = 11000;
    throw err;
  });

  const settings = await getOrCreateRoboTraderSettings('race-user');

  assert.equal(settings.userId, 'race-user');
  assert.equal(findCount, 2);
});

test('every persisted settings mutation atomically advances the control generation', async t => {
  const current = {
    userId: 'generation-user',
    isEnabled: true,
    enabled: true,
    controlGeneration: 7,
    mode: 'paper'
  };
  let updateCall = null;
  t.mock.method(RoboSettings, 'findOne', () => ({ sort: async () => current }));
  t.mock.method(RoboSettings, 'findOneAndUpdate', async (query, update, options) => {
    updateCall = { query, update, options };
    return { ...current, ...update.$set, controlGeneration: current.controlGeneration + 1 };
  });

  const settings = await updateRoboTraderSettings('generation-user', {
    isEnabled: false,
    pausedReason: 'Emergency stop triggered.'
  });

  assert.equal(updateCall.query.userId, 'generation-user');
  assert.deepEqual(updateCall.update.$inc, { controlGeneration: 1 });
  assert.equal(updateCall.update.$set.isEnabled, false);
  assert.equal(updateCall.options.new, true);
  assert.equal(settings.controlGeneration, 8);
});
