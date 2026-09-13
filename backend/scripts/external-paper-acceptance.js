#!/usr/bin/env node
'use strict';

// Deliberately standalone: never loads .env and never runs on import.
const { randomUUID } = require('node:crypto');
const PAPER_ORIGIN = 'https://paper-api.alpaca.markets';
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected']);
function requireSafe(condition, message) { if (!condition) throw new Error(message); }
function cents(value) {
  requireSafe(/^\d+(\.\d{1,2})?$/.test(String(value)), 'Amounts must be positive decimal dollars with at most two fractional digits');
  const [dollars, fraction = ''] = String(value).split('.');
  const result = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  requireSafe(Number.isSafeInteger(result) && result > 0, 'Invalid dollar amount');
  return result;
}
function parseArgs(argv) {
  const options = {};
  const flags = new Set(['dry-run', 'authorize-external-paper-test']);
  const values = new Set(['expected-account-id', 'paper-origin', 'symbol-allowlist', 'symbol', 'max-notional', 'limit-price', 'quantity', 'test-prefix']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    requireSafe(argv[i].startsWith('--') && (flags.has(key) || values.has(key)) && !(key in options), 'Unknown or duplicate command option');
    options[key] = flags.has(key) ? true : argv[++i];
    requireSafe(options[key] !== undefined, 'Missing option value');
  }
  return options;
}
function plan(options) {
  requireSafe(options['dry-run'] || options['authorize-external-paper-test'], 'Explicit --authorize-external-paper-test required for network execution');
  requireSafe(options['paper-origin'] === PAPER_ORIGIN, 'Exact trusted paper origin required');
  requireSafe(/^[A-Za-z0-9-]{8,64}$/.test(options['expected-account-id'] || ''), 'Expected dedicated paper account ID required');
  const allowlist = String(options['symbol-allowlist'] || '').split(',');
  requireSafe(allowlist.every(s => /^[A-Z]{1,5}$/.test(s)) && allowlist.includes(options.symbol), 'Explicit symbol allowlist required');
  requireSafe(/^[a-z][a-z0-9-]{2,9}$/.test(options['test-prefix'] || ''), 'Test prefix must be 3–10 lowercase letters/digits/hyphens');
  const quantity = Number(options.quantity);
  requireSafe(/^\d+$/.test(String(options.quantity)) && Number.isSafeInteger(quantity) && quantity > 0, 'Positive whole-share quantity required');
  const limit = cents(options['limit-price']);
  const maximum = cents(options['max-notional']);
  requireSafe(Number.isSafeInteger(quantity * limit) && quantity * limit <= maximum, 'Order exceeds maximum test notional');
  return { origin: PAPER_ORIGIN, expectedAccountId: options['expected-account-id'], maxNotional: maximum / 100,
    order: { symbol: options.symbol, qty: String(quantity), side: 'buy', type: 'limit', limit_price: (limit / 100).toFixed(2), time_in_force: 'day', client_order_id: `${options['test-prefix']}-${randomUUID()}` } };
}
async function run(options, { request = networkRequest, env = process.env, onIntent = () => {} } = {}) {
  const intent = plan(options);
  if (options['dry-run']) return { dryRun: true, networkRequests: 0, ...intent };
  requireSafe(options['authorize-external-paper-test'] === true, 'External authorization required');
  requireSafe(env.APCA_API_KEY_ID && env.APCA_API_SECRET_KEY, 'Explicit APCA credentials required');
  onIntent({ clientOrderId: intent.order.client_order_id, symbol: intent.order.symbol, maximumNotional: intent.maxNotional });
  const call = (method, path, body) => request({ origin: intent.origin, method, path, body, env });
  const account = await call('GET', '/v2/account');
  requireSafe(account.id === intent.expectedAccountId, 'Paper account identity mismatch');
  requireSafe(account.status === 'ACTIVE' && account.currency === 'USD' && account.trading_blocked === false && account.account_blocked === false && account.trade_suspended_by_user !== true, 'Account is not ready');
  requireSafe(Number.isFinite(Number(account.cash)) && Number(account.cash) >= intent.maxNotional, 'Insufficient confirmed cash');
  const clock = await call('GET', '/v2/clock');
  requireSafe(clock.is_open === true, 'Market must be open');
  const asset = await call('GET', `/v2/assets/${intent.order.symbol}`);
  requireSafe(asset.symbol === intent.order.symbol && asset.status === 'active' && asset.tradable === true && asset.class === 'us_equity', 'Asset is not an active tradable US equity');
  const positions = await call('GET', '/v2/positions');
  const openOrders = await call('GET', '/v2/orders?status=open');
  requireSafe(Array.isArray(positions) && positions.length === 0 && Array.isArray(openOrders) && openOrders.length === 0, 'Dedicated account must have no positions or open orders');
  const lookupPath = `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(intent.order.client_order_id)}`;
  const owned = order => {
    requireSafe(order && /^[A-Za-z0-9-]+$/.test(order.id || '') && order.client_order_id === intent.order.client_order_id && order.symbol === intent.order.symbol && order.side === 'buy' && Number(order.qty) === Number(intent.order.qty) && order.type === 'limit' && Number(order.limit_price) === Number(intent.order.limit_price), 'Refusing cleanup: broker order ownership/economics mismatch');
    return order;
  };
  let acknowledgement = false;
  let submissionUncertain = false;
  try { owned(await call('POST', '/v2/orders', intent.order)); acknowledgement = true; }
  catch { submissionUncertain = true; } // Never repeat POST, including ambiguous timeout.
  let latest = owned(await call('GET', lookupPath));
  if (!TERMINAL.has(latest.status)) {
    await call('DELETE', `/v2/orders/${latest.id}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      latest = owned(await call('GET', lookupPath));
      if (TERMINAL.has(latest.status)) break;
    }
  }
  const filledQuantity = Number(latest.filled_qty);
  requireSafe(latest.filled_qty !== null && latest.filled_qty !== undefined && String(latest.filled_qty).trim() !== '' && Number.isFinite(filledQuantity) && filledQuantity >= 0 && filledQuantity <= Number(intent.order.qty) && (latest.status !== 'filled' || filledQuantity === Number(intent.order.qty)), 'Invalid broker filled quantity; operator reconciliation required');
  return { clientOrderId: intent.order.client_order_id, brokerOrderId: latest.id, acknowledgement, submissionUncertain,
    status: latest.status, cleanupConfirmed: TERMINAL.has(latest.status), filledQuantity,
    operatorActionRequired: !TERMINAL.has(latest.status) || filledQuantity > 0,
    note: 'Filled shares are retained. No position liquidation is performed. Inspect dedicated paper account before further testing.' };
}
async function networkRequest({ origin, method, path, body, env }) {
  requireSafe(origin === PAPER_ORIGIN && path.startsWith('/v2/'), 'Untrusted request destination');
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  requireSafe(response.ok, `Paper broker request failed (HTTP ${response.status}); reconcile test client ID before retrying`);
  return response.status === 204 ? null : response.json();
}
if (require.main === module) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options) {
    run(options, { onIntent: intent => console.log(JSON.stringify({ plannedTest: intent })) }).then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.operatorActionRequired) process.exitCode = 2;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { run, plan, parseArgs, networkRequest };
