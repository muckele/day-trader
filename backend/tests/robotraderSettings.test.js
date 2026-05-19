const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
