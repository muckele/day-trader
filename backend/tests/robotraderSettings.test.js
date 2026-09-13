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

test('robotrader settings rejects live even with confirmation', () => {
  assert.throws(() => sanitizeSettingsUpdate({ mode: 'live', liveTradingExplicitlyEnabled: true, confirmLiveTrading: LIVE_CONFIRMATION_TEXT }), /paper-only/);
});

test('robotrader settings normalizes symbols and asset classes', () => {
  const update = sanitizeSettingsUpdate({
    allowedAssetClasses: ['equity'],
    allowedSymbols: 'aapl, msft, btc/usd',
    blockedSymbols: [' gme ', 'tsla!!']
  });

  assert.deepEqual(update.allowedAssetClasses, ['stocks']);
  assert.deepEqual(update.allowedSymbols, ['AAPL', 'MSFT', 'BTC/USD']);
  assert.deepEqual(update.blockedSymbols, ['GME', 'TSLA']);
});

test('robotrader settings sanitizes boolean string values', () => {
  const update = sanitizeSettingsUpdate({
    allowShortSelling: 'false',
    allowOptionsTrading: 'false',
    allowCryptoTrading: 'false',
    allowFractionalShares: 'false',
    allowExtendedHours: 'false'
  });

  assert.equal(update.allowShortSelling, false);
  assert.equal(update.allowOptionsTrading, false);
  assert.equal(update.allowCryptoTrading, false);
  assert.equal(update.allowFractionalShares, false);
  assert.equal(update.allowExtendedHours, false);
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

test('owner explicit enable clears stop pause but preserves circuit pauses', () => {
  assert.equal(sanitizeSettingsUpdate({ isEnabled: true }, { pausedReason: 'Emergency stop triggered.' }).pausedReason, null);
  assert.equal(sanitizeSettingsUpdate({ isEnabled: true }, { pausedReason: 'Disabled by user.' }).pausedReason, null);
  assert.equal(sanitizeSettingsUpdate({ isEnabled: true }, { pausedReason: 'Circuit breaker' }).pausedReason, undefined);
});
for (const input of [{ allowFractionalShares: true }, { allowExtendedHours: true }, { allowCryptoTrading: true }, { allowOptionsTrading: true }, { allowShortSelling: true }, { allowedAssetClasses: ['crypto'] }]) {
  test(`unsupported automated settings rejected: ${JSON.stringify(input)}`, () => {
    assert.throws(() => sanitizeSettingsUpdate(input), /MVP/);
  });
}

test('spending limits persist cents and reject invalid configuration', () => {
  assert.deepEqual(sanitizeSettingsUpdate({ dailyLimit: 100.25, weeklyLimit: '500', monthlyLimit: 0 }), { dailyLimit: 100.25, weeklyLimit: 500, monthlyLimit: 0 });
  for (const value of [null, '', -1, 'invalid', Infinity, 1.001]) {
    assert.throws(() => sanitizeSettingsUpdate({ dailyLimit: value }), /dailyLimit/);
  }
});
