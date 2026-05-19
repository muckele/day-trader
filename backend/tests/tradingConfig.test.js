const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTradingConfig, classifyInstrumentPolicy } = require('../config/tradingConfig');

test('buildTradingConfig applies conservative default feature flags', () => {
  const config = buildTradingConfig({});

  assert.equal(config.environment.paperTradingEnabled, true);
  assert.equal(config.environment.liveTradingEnabled, false);
  assert.equal(config.features.shortSellingEnabled, false);
  assert.equal(config.features.optionsEnabled, false);
  assert.equal(config.features.leveragedEtfEnabled, false);
  assert.equal(config.features.inverseEtfEnabled, false);
  assert.ok(Array.isArray(config.recommendation.universe));
  assert.ok(config.recommendation.universe.length > 5);
});

test('classifyInstrumentPolicy identifies ETFs and leveraged/inverse ETFs', () => {
  const config = buildTradingConfig({});

  const spy = classifyInstrumentPolicy('SPY', 'equity', config);
  const tqqq = classifyInstrumentPolicy('TQQQ', 'equity', config);
  const sqqq = classifyInstrumentPolicy('SQQQ', 'equity', config);
  const btc = classifyInstrumentPolicy('BTCUSD', 'crypto', config);

  assert.equal(spy.isEtf, true);
  assert.equal(tqqq.isLeveragedEtf, true);
  assert.equal(sqqq.isInverseEtf, true);
  assert.equal(btc.isCrypto, true);
});
