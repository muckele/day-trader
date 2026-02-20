const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTradeToPosition } = require('../paper/paperMath');

test('applyTradeToPosition handles long lifecycle', () => {
  let position = { qty: 0, avgCost: 0 };

  let result = applyTradeToPosition(position, { side: 'buy', qty: 10, price: 100 });
  position = result.position;
  assert.equal(position.qty, 10);
  assert.equal(position.avgCost, 100);
  assert.equal(result.realizedPnl, 0);

  result = applyTradeToPosition(position, { side: 'buy', qty: 10, price: 110 });
  position = result.position;
  assert.equal(position.qty, 20);
  assert.equal(Number(position.avgCost.toFixed(2)), 105);

  result = applyTradeToPosition(position, { side: 'sell', qty: 5, price: 120 });
  position = result.position;
  assert.equal(position.qty, 15);
  assert.equal(Number(result.realizedPnl.toFixed(2)), 75);

  result = applyTradeToPosition(position, { side: 'sell', qty: 15, price: 90 });
  position = result.position;
  assert.equal(position.qty, 0);
  assert.equal(position.avgCost, 0);
  assert.equal(Number(result.realizedPnl.toFixed(2)), -225);
});

test('applyTradeToPosition handles short lifecycle', () => {
  let position = { qty: 0, avgCost: 0 };

  let result = applyTradeToPosition(position, { side: 'sell', qty: 10, price: 50 });
  position = result.position;
  assert.equal(position.qty, -10);
  assert.equal(position.avgCost, 50);

  result = applyTradeToPosition(position, { side: 'buy', qty: 5, price: 40 });
  position = result.position;
  assert.equal(position.qty, -5);
  assert.equal(Number(result.realizedPnl.toFixed(2)), 50);
});
