const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAlpacaOrderRequest } = require('../robotrader/alpacaCapabilities');
const { buildRoboAlpacaOrderPayload } = require('../robotrader/alpacaOrderBuilder');

test('alpaca capability matrix rejects unsupported crypto combinations', () => {
  const trailingStop = validateAlpacaOrderRequest({
    symbol: 'BTCUSD',
    assetClass: 'crypto',
    side: 'buy',
    qty: 0.01,
    orderType: 'trailing_stop',
    timeInForce: 'gtc'
  });
  assert.equal(trailingStop.ok, false);
  assert.match(trailingStop.errors.join(' '), /trailing_stop/);

  const bracket = validateAlpacaOrderRequest({
    symbol: 'BTCUSD',
    assetClass: 'crypto',
    side: 'buy',
    qty: 0.01,
    orderType: 'market',
    orderClass: 'bracket',
    timeInForce: 'gtc'
  });
  assert.equal(bracket.ok, false);
  assert.match(bracket.errors.join(' '), /bracket/);
});

test('alpaca capability matrix rejects invalid options fields', () => {
  const result = validateAlpacaOrderRequest({
    symbol: 'AAPL260116C00200000',
    assetClass: 'options',
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    timeInForce: 'day',
    limitPrice: 2.5,
    stopPrice: 2
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Options orders cannot include/);
});

test('robotrader alpaca order builder emits valid bracket equity payload', () => {
  const built = buildRoboAlpacaOrderPayload({
    symbol: 'aapl',
    assetClass: 'stocks',
    side: 'buy',
    qty: 1,
    orderType: 'market',
    orderClass: 'bracket',
    timeInForce: 'day',
    takeProfit: { limit_price: '205' },
    stopLoss: { stop_price: '190' },
    clientOrderId: 'robotrader-test-1'
  });

  assert.equal(built.payload.symbol, 'AAPL');
  assert.equal(built.payload.qty, '1');
  assert.equal(built.payload.order_class, 'bracket');
  assert.equal(built.payload.client_order_id, 'robotrader-test-1');
});

test('alpaca capability matrix rejects notional bracket orders', () => {
  const result = validateAlpacaOrderRequest({
    symbol: 'AAPL',
    assetClass: 'stocks',
    side: 'buy',
    notional: 100,
    orderType: 'market',
    orderClass: 'bracket',
    timeInForce: 'day'
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Notional orders require simple order_class/);
});
