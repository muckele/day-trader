const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureTradingIndexes } = require('../services/tradingIndexService');

test('ensureTradingIndexes attempts every configured trading model', async () => {
  const calls = [];
  const models = [
    { modelName: 'One', createIndexes: async () => calls.push('One') },
    { modelName: 'Two', createIndexes: async () => calls.push('Two') }
  ];

  const results = await ensureTradingIndexes({ logger: { error: () => {} }, models });

  assert.deepEqual(calls, ['One', 'Two']);
  assert.deepEqual(results, [
    { model: 'One', ok: true },
    { model: 'Two', ok: true }
  ]);
});
