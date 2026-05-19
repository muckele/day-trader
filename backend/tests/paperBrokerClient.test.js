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

test('normalizeOrderInput accepts crypto settings with higher precision', () => {
  const normalized = normalizeOrderInput({
    symbol: 'btc/usd',
    side: 'buy',
    qty: '0.12345678',
    assetClass: 'crypto',
    orderType: 'trailing_stop',
    trailingStopPct: '1.5',
    timeInForce: 'gtc'
  });

  assert.equal(normalized.normalizedSymbol, 'BTCUSD');
  assert.equal(normalized.normalizedAssetClass, 'crypto');
  assert.equal(normalized.numericQty, 0.12345678);
  assert.equal(normalized.normalizedOrderType, 'trailing_stop');
  assert.equal(normalized.parsedTrailingStopPct, 1.5);
  assert.equal(normalized.normalizedTimeInForce, 'gtc');
});

test('normalizeOrderInput maps default crypto day TIF to Alpaca-compatible gtc', () => {
  const normalized = normalizeOrderInput({
    symbol: 'ETHUSD',
    side: 'buy',
    qty: '0.05',
    assetClass: 'crypto'
  });

  assert.equal(normalized.normalizedAssetClass, 'crypto');
  assert.equal(normalized.normalizedTimeInForce, 'gtc');
});

test('normalizeOrderInput rejects crypto GTD orders', () => {
  assert.throws(
    () => normalizeOrderInput({
      symbol: 'BTCUSD',
      side: 'buy',
      qty: '0.01',
      assetClass: 'crypto',
      timeInForce: 'gtd',
      goodTilDate: '2099-01-01T00:00:00.000Z'
    }),
    /Crypto timeInForce must be gtc or ioc/
  );
});

test('normalizeOrderInput rejects quantities with too many decimals', () => {
  assert.throws(
    () => normalizeOrderInput({ symbol: 'AAPL', side: 'buy', qty: 0.1234567 }),
    /supports up to 6 decimal places/
  );
});

test('normalizeOrderInput validates stop-limit requirements', () => {
  assert.throws(
    () => normalizeOrderInput({
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      orderType: 'stop_limit',
      limitPrice: 100
    }),
    /stopPrice must be a positive number for stop-limit orders/
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

test('enforceMarketHours treats crypto as always open', () => {
  const result = enforceMarketHours({
    allowExtendedHours: false,
    assetClass: 'crypto',
    marketStatusProvider: () => ({ status: 'CLOSED' })
  });

  assert.equal(result.marketStatus, 'OPEN');
  assert.equal(result.marketSession, 'crypto');
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
