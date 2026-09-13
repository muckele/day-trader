const test = require('node:test');
const assert = require('node:assert/strict');
const brokerModule = require('../robotrader/alpacaBroker');
const trading = require('../services/alpacaTradingClient');
const router = require('../routes/market');
const handler = router.stack.find(layer => layer.route?.path === '/status').route.stack[0].handle;
async function call() { const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; await handler({}, res); return res; }
test('Alpaca mode market status uses provider clock even when local calendar differs', async t => {
  t.mock.method(trading, 'shouldSyncPaperTradesToAlpaca', () => true);
  t.mock.method(brokerModule, 'createAlpacaBroker', () => ({ getClock: async () => ({ is_open: true, timestamp: new Date().toISOString(), next_open: '2026-09-14T13:30:00Z', next_close: '2026-09-14T20:00:00Z' }) }));
  const res = await call();
  assert.equal(res.body.status, 'OPEN');
  assert.equal(res.body.executionSource, 'alpaca-paper');
  assert.equal(res.body.source, 'alpaca-clock');
});
test('unavailable or stale Alpaca clock never falls back to a closed local calendar', async t => {
  t.mock.method(trading, 'shouldSyncPaperTradesToAlpaca', () => true);
  const stub = t.mock.method(brokerModule, 'createAlpacaBroker', () => ({ getClock: async () => { throw new Error('provider outage'); } }));
  let res = await call();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'UNAVAILABLE');
  stub.mock.mockImplementation(() => ({ getClock: async () => ({ is_open: false, timestamp: '2000-01-01T00:00:00Z' }) }));
  res = await call();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'UNAVAILABLE');
});
