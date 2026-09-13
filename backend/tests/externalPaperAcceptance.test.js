const test = require('node:test');
const assert = require('node:assert/strict');
const { run, plan, parseArgs, networkRequest } = require('../scripts/external-paper-acceptance');
const options = { 'authorize-external-paper-test': true, 'expected-account-id': 'dedicated-paper-account', 'paper-origin': 'https://paper-api.alpaca.markets', 'symbol-allowlist': 'AAPL,MSFT', symbol: 'AAPL', 'max-notional': '10.00', 'limit-price': '1.00', quantity: '1', 'test-prefix': 'phase3' };
function fixture(overrides = {}) {
  const calls = []; let order;
  const request = async request => {
    calls.push(request);
    const { path, method, body } = request;
    if (path === '/v2/account') return { id: options['expected-account-id'], status: 'ACTIVE', currency: 'USD', trading_blocked: false, account_blocked: false, cash: '100', ...overrides.account };
    if (path === '/v2/clock') return { is_open: true, ...overrides.clock };
    if (path.startsWith('/v2/assets/')) return { symbol: 'AAPL', status: 'active', tradable: true, class: 'us_equity' };
    if (path === '/v2/positions') return overrides.positions || [];
    if (path === '/v2/orders?status=open') return [];
    if (method === 'POST') { order = { ...body, id: 'test-order-id', status: 'new', filled_qty: '0' }; if (overrides.timeout) throw new Error('timeout after accept'); return order; }
    if (method === 'DELETE') { if (!overrides.cancelUncertain) order.status = 'canceled'; return null; }
    if (path.startsWith('/v2/orders:by_client_order_id?')) return { ...order, ...overrides.lookup };
    throw new Error('unexpected request');
  };
  return { calls, request, env: { APCA_API_KEY_ID: 'dummy', APCA_API_SECRET_KEY: 'dummy' } };
}
test('dry run makes zero network calls even without credentials or authorization', async () => {
  const f = fixture(); const result = await run({ ...options, 'authorize-external-paper-test': false, 'dry-run': true }, { ...f, env: {} });
  assert.equal(result.networkRequests, 0); assert.equal(f.calls.length, 0);
});
test('all preflight safety failures occur without network access', async () => {
  for (const patch of [{ 'authorize-external-paper-test': false }, { 'paper-origin': 'https://api.alpaca.markets' }, { 'paper-origin': 'https://paper-api.alpaca.markets/' }, { 'expected-account-id': '' }, { 'symbol-allowlist': 'MSFT' }, { 'max-notional': '0.99' }, { quantity: '1.5' }, { 'limit-price': 'NaN' }, { 'test-prefix': '../bad' }]) {
    const f = fixture(); await assert.rejects(run({ ...options, ...patch }, f)); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await assert.rejects(run(options, { ...f, env: {} })); assert.equal(f.calls.length, 0);
});
test('client IDs are unique and broker-length bounded', () => {
  const ids = Array.from({ length: 100 }, () => plan(options).order.client_order_id);
  assert.equal(new Set(ids).size, 100); assert.ok(ids.every(id => id.length <= 48));
});
test('account identity/readiness/market/nonempty account prevent submission', async () => {
  for (const patch of [{ account: { id: 'wrong' } }, { account: { trading_blocked: true } }, { account: { cash: 'bad' } }, { clock: { is_open: false } }, { positions: [{ symbol: 'AAPL' }] }]) {
    const f = fixture(patch); await assert.rejects(run(options, f)); assert.equal(f.calls.some(c => c.method !== 'GET'), false);
  }
});
test('one bounded POST followed by exact test-owned cancel and terminal lookup', async () => {
  const f = fixture(); let printed;
  const result = await run(options, { ...f, onIntent: intent => { printed = intent; assert.equal(f.calls.length, 0); } });
  assert.equal(printed.clientOrderId, result.clientOrderId); assert.equal(result.cleanupConfirmed, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/v2/orders/test-order-id']);
  assert.ok(f.calls.every(c => c.origin === options['paper-origin']));
});
test('ambiguous POST reconciles by same client ID without retry', async () => {
  const f = fixture({ timeout: true }); const result = await run(options, f);
  assert.equal(result.submissionUncertain, true); assert.equal(result.cleanupConfirmed, true); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('foreign or altered broker resource is never canceled', async () => {
  for (const lookup of [{ client_order_id: 'foreign' }, { symbol: 'MSFT' }, { qty: '2' }, { side: 'sell' }, { limit_price: '100' }, { id: '../orders' }]) {
    const f = fixture({ lookup }); await assert.rejects(run(options, f), /ownership/); assert.equal(f.calls.some(c => c.method === 'DELETE'), false);
  }
});
test('uncertain cancellation is bounded and requires operator reconciliation', async () => {
  const f = fixture({ cancelUncertain: true }); const result = await run(options, f);
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.operatorActionRequired, true);
  assert.equal(f.calls.filter(c => c.path.startsWith('/v2/orders:')).length, 4);
});
test('filled position is disclosed and never liquidated', async () => {
  const f = fixture({ lookup: { status: 'filled', filled_qty: '1' } }); const result = await run(options, f);
  assert.equal(result.filledQuantity, 1); assert.equal(result.operatorActionRequired, true); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('unknown duplicate and missing CLI options fail', () => {
  for (const args of [['--unknown'], ['--symbol'], ['--dry-run', '--dry-run']]) assert.throws(() => parseArgs(args));
});
test('transport rejects untrusted origins before fetch', async () => {
  await assert.rejects(networkRequest({ origin: 'https://api.alpaca.markets', path: '/v2/orders', method: 'POST', env: {} }), /destination/);
});
test('missing or contradictory filled quantities never establish zero-fill cleanup', async () => {
  for (const lookup of [{status:'canceled',filled_qty:null},{status:'canceled',filled_qty:''},{status:'filled',filled_qty:'0'}]) {
    const f=fixture({lookup});await assert.rejects(run(options,f),/filled quantity/);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  }
});
