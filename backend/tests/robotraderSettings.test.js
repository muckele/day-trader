const test = require('node:test');
const assert = require('node:assert/strict');
const RoboSettings = require('../models/RoboSettings');
const {
  getOrCreateRoboTraderSettings,
  LIVE_CONFIRMATION_TEXT,
  mapSettings,
  sanitizeSettingsUpdate
} = require('../robotrader/settingsService');

test('robotrader settings default to paper mode with live trading disabled', () => {
  const settings = mapSettings({});
  assert.equal(settings.mode, 'paper');
  assert.equal(settings.isEnabled, false);
  assert.equal(settings.liveTradingExplicitlyEnabled, false);
  assert.deepEqual(settings.allowedAssetClasses, ['stocks']);
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
