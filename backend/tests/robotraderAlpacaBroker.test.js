const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeReplacementPayload } = require('../robotrader/alpacaBroker');

test('robotrader alpaca broker sanitizes order replacement payloads', () => {
  assert.deepEqual(
    sanitizeReplacementPayload({
      qty: 2,
      limitPrice: 201.25,
      timeInForce: 'GTC',
      symbol: 'MSFT',
      side: 'sell'
    }),
    {
      qty: '2',
      limit_price: '201.25',
      time_in_force: 'gtc'
    }
  );
});

test('robotrader alpaca broker rejects unsafe replacement payloads', () => {
  assert.throws(
    () => sanitizeReplacementPayload({ symbol: 'MSFT', side: 'sell' }),
    /at least one supported field/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ qty: -1 }),
    /qty must be a positive number/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ trailPrice: 1, trailPercent: 2 }),
    /either trail_price or trail_percent/
  );
});
