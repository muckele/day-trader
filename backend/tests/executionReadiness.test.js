const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutionReadiness } = require('../services/executionReadiness');
test('execution stays blocked until indexes and write probe succeed and resets on disconnect', async () => {
  const readiness = createExecutionReadiness();
  assert.throws(() => readiness.assertReady(), /not ready/);
  await readiness.bootstrap(async () => [{ ok: false }], async () => {});
  assert.throws(() => readiness.assertReady(), /not ready/);
  await readiness.bootstrap(async () => [{ ok: true }], async () => { throw new Error('storage full'); });
  assert.throws(() => readiness.assertReady(), /not ready/);
  await readiness.bootstrap(async () => [{ ok: true }], async () => {});
  assert.doesNotThrow(() => readiness.assertReady());
  readiness.invalidate();
  assert.throws(() => readiness.assertReady(), /not ready/);
});

test('manual broker write is blocked when readiness is lost during account identity lookup', async () => {
  const axios = require('axios');
  const { executionReadiness } = require('../services/executionReadiness');
  const { submitAlpacaPaperOrder } = require('../services/alpacaTradingClient');
  const previous = { get: axios.get, post: axios.post };
  let writes = 0;
  await executionReadiness.bootstrap(async () => [{ ok: true }], async () => {});
  axios.get = async () => { executionReadiness.invalidate(); return { data: { id: 'fixture' } }; };
  axios.post = async () => { writes += 1; return { data: { id: 'unexpected' } }; };
  try {
    await assert.rejects(submitAlpacaPaperOrder({ symbol: 'SPY', side: 'buy', qty: 1 }, { env: { APCA_API_KEY_ID: 'fixture', APCA_API_SECRET_KEY: 'fixture', ALPACA_EXPECTED_PAPER_ACCOUNT_ID: 'fixture' } }), /not ready/);
    assert.equal(writes, 0);
  } finally { axios.get = previous.get; axios.post = previous.post; executionReadiness.invalidate(); }
});
