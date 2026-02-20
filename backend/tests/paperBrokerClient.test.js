const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOrderInput,
  enforceMarketHours,
  enforcePriceControls
} = require('../paper/paperBrokerClient');

test('normalizeOrderInput accepts fractional quantity and limit settings', () => {
  const normalized = normalizeOrderInput({
    symbol: 'aapl',
    side: 'buy',
    qty: '0.25',
    orderType: 'limit',
    limitPrice: '190.5',
    maxPricePerShare: '191.2',
    allowExtendedHours: true
  });

  assert.equal(normalized.normalizedSymbol, 'AAPL');
  assert.equal(normalized.normalizedSide, 'buy');
  assert.equal(normalized.numericQty, 0.25);
  assert.equal(normalized.normalizedOrderType, 'limit');
  assert.equal(normalized.parsedLimitPrice, 190.5);
  assert.equal(normalized.parsedMaxPricePerShare, 191.2);
  assert.equal(normalized.allowExtendedHours, true);
});

test('normalizeOrderInput rejects quantities with too many decimals', () => {
  assert.throws(
    () => normalizeOrderInput({ symbol: 'AAPL', side: 'buy', qty: 0.1234567 }),
    /supports up to 6 decimal places/
  );
});

test('enforceMarketHours blocks orders when market closed and extended disabled', () => {
  assert.throws(
    () => enforceMarketHours({
      allowExtendedHours: false,
      marketStatusProvider: () => ({ status: 'CLOSED' })
    }),
    /Market is closed/
  );
});

test('enforceMarketHours allows extended session when market closed', () => {
  const result = enforceMarketHours({
    allowExtendedHours: true,
    marketStatusProvider: () => ({ status: 'CLOSED' })
  });

  assert.equal(result.extendedHours, true);
  assert.equal(result.marketSession, 'extended');
});

test('enforcePriceControls applies limit and max price constraints for buys', () => {
  assert.throws(
    () => enforcePriceControls({
      side: 'buy',
      fillPrice: 101,
      orderType: 'limit',
      limitPrice: 100
    }),
    /Limit price too low/
  );

  assert.throws(
    () => enforcePriceControls({
      side: 'buy',
      fillPrice: 101,
      orderType: 'market',
      maxPricePerShare: 100
    }),
    /exceeds max price per share/
  );
});
