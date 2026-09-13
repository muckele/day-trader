const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness.cjs');
const Settings = require('../../backend/models/RoboSettings');
const Decision = require('../../backend/models/RoboTradeDecision');
const Intent = require('../../backend/models/OrderIntent');
const BrokerOrder = require('../../backend/models/BrokerOrder');
const Audit = require('../../backend/models/RoboAuditLog');
const Outbox = require('../../backend/models/NotificationOutbox');
const Lock = require('../../backend/models/RoboLock');
function result(output) { const match = output.match(/ACCEPTANCE_RESULT (.*)/); assert.ok(match, output); return JSON.parse(match[1]); }
async function until(predicate, label) { for (let i = 0; i < 160; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timeout: ${label}`); }
async function fixture(t, fn) {
  const h = await startHarness();
  try { await Settings.updateOne({ userId: h.ownerId }, { $set: { isEnabled: true, enabled: true, riskLevel: 'balanced' } }); await fn(h); }
  finally { await h.control({ releaseHold: true }).catch(() => {}); await h.close(); }
}
test('real worker process abstains on flat provider research without fabricating execution', { timeout: 45000 }, async t => fixture(t, async h => {
  const run = result(await h.run('worker'));
  assert.equal(run.ok, true); assert.equal(h.provider.state.posts.length, 0);
  assert.equal(await Intent.countDocuments(), 0); assert.equal(await BrokerOrder.countDocuments(), 0);
  const decisions = await Decision.find().lean(); assert.ok(decisions.length > 0); assert.ok(decisions.every(d => d.action === 'hold'));
  assert.ok(await Audit.countDocuments({ eventType: 'robotrader_worker_run' }));
}));
test('two real worker processes contend for one account and create one durable entry', { timeout: 45000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true, holdPath: '/bars', holdOccurrence: 1 } });
  const first = h.run('worker'); const settled = first.catch(error => error);
  await until(() => h.provider.state.held, 'first worker research barrier');
  const second = result(await h.run('worker')); assert.equal(second.reason, 'ROBOTRADER_LOCKED');
  await h.control({ releaseHold: true }); const output = await settled; if (output instanceof Error) throw output; assert.equal(result(output).ok, true);
  assert.equal(h.provider.state.posts.length, 1);
  const intent = await Intent.findOne().lean(); assert.equal(intent.origin, 'robotrader'); assert.equal(intent.status, 'acknowledged');
  assert.equal(await BrokerOrder.countDocuments(), 1); assert.equal(await Decision.countDocuments({ status: 'submitted' }), 1);
  assert.ok(intent.reservedCents > 0); assert.ok(await Outbox.countDocuments({ state: 'pending' }) >= 1);
  assert.ok(await Audit.countDocuments({ eventType: 'robotrader_worker_locked' }));
}));
for (const phase of [{ name: 'while research is running', path: '/bars', occurrence: 1 }, { name: 'immediately before broker submission', path: '/v2/assets/AAPL', occurrence: 3 }]) {
  test(`disable ${phase.name} prevents any broker POST in a separate worker process`, { timeout: 45000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true, holdPath: phase.path, holdOccurrence: phase.occurrence } });
    const running = h.run('worker').catch(error => error);
    await until(() => h.provider.state.held, phase.name);
    if (phase.occurrence === 3) { assert.ok(await Decision.countDocuments({ status: 'approved' })); assert.ok(await Intent.countDocuments()); }
    await Settings.updateOne({ userId: h.ownerId }, { $set: { isEnabled: false, enabled: false } });
    await h.control({ releaseHold: true }); const outcome = await running;
    assert.ok(outcome instanceof Error, 'Worker must report the changed control state'); assert.match(outcome.message, /disabled|controls changed/i);
    assert.equal(h.provider.state.posts.length, 0);
    assert.ok(await Decision.countDocuments());
    await h.run('reconcile'); assert.equal(h.provider.state.posts.length, 0);
  }));
}
for (const phase of [{ name: 'after decision persistence', occurrence: 2 }, { name: 'immediately before broker submission', occurrence: 3 }]) {
  test(`worker lease loss ${phase.name} prevents a broker POST across process boundary`, { timeout: 45000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true, holdPath: '/v2/assets/AAPL', holdOccurrence: phase.occurrence } });
    const running = h.run('worker').catch(error => error);
    await until(() => h.provider.state.held, phase.name);
    assert.ok(await Decision.countDocuments({ status: 'approved' }));
    const changed = await Lock.updateOne({ userId: h.ownerId }, { $set: { owner: 'replacement-worker', lockedUntil: new Date(Date.now() + 60000) } }); assert.equal(changed.modifiedCount, 1);
    await h.control({ releaseHold: true }); const outcome = await running;
    assert.ok(outcome instanceof Error); assert.match(outcome.message, /lease lost|expired/i); assert.equal(h.provider.state.posts.length, 0);
    assert.equal((await Lock.findOne({ userId: h.ownerId }).lean()).owner, 'replacement-worker');
    await h.run('reconcile'); assert.equal(h.provider.state.posts.length, 0);
  }));
}
for (const mode of ['acknowledge', 'accepted500']) {
  test(`emergency stop cancels only the owned ${mode === 'acknowledge' ? 'acknowledged' : 'uncertain'} entry and reconciliation continues disabled`, { timeout: 45000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true, mode } });
    await h.run('worker'); assert.equal(h.provider.state.posts.length, 1);
    const entry = h.provider.state.orders[0];
    const foreign = { id: 'unrelated-order', client_order_id: 'outside-application', symbol: 'MSFT', side: 'buy', qty: '1', filled_qty: '0', status: 'new' };
    await h.control({ patch: { orders: [...h.provider.state.orders, foreign] } });
    const stop = result(await h.run('emergency-stop')); assert.ok(stop.canceledOrderIds.includes(entry.id));
    assert.equal(h.provider.state.orders.find(o => o.id === foreign.id).status, 'new');
    assert.equal((await Settings.findOne({ userId: h.ownerId }).lean()).isEnabled, false);
    await h.run('reconcile'); assert.equal((await Intent.findOne({ clientOrderId: entry.client_order_id }).lean()).status, 'canceled');
    assert.equal(result(await h.run('worker')).reason, 'ROBOTRADER_DISABLED'); assert.equal(h.provider.state.posts.length, 1);
    assert.ok(await Audit.countDocuments({ eventType: 'robotrader_emergency_stop' }));
  }));
}
test('owner browser enables then logs out and closes; independent worker persists entry visible after new login', { timeout: 60000 }, async t => fixture(t, async h => {
  const { chromium } = require('../../frontend/node_modules/@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  async function login(page) {
    await page.goto(h.baseURL + '/login');
    await page.getByPlaceholder('Username').fill('acceptance-owner'); await page.getByPlaceholder('Password').fill('local-test-password');
    await page.getByRole('button', { name: 'Log In', exact: true }).click(); await page.waitForURL(h.baseURL + '/');
  }
  try {
    await Settings.updateOne({ userId: h.ownerId }, { $set: { isEnabled: false, enabled: false } });
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } }); const page = await context.newPage();
    await login(page); await page.goto(h.baseURL + '/robo');
    await page.getByLabel('Max Trade Amount', { exact: false }).fill('500');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await until(async () => (await Settings.findOne({ userId: h.ownerId }).lean()).maxTradeAmount === 500, 'browser saved settings');
    await page.getByRole('button', { name: 'Enable RoboTrader', exact: true }).click();
    await page.getByRole('button', { name: 'Disable RoboTrader', exact: true }).waitFor();
    assert.equal((await Settings.findOne({ userId: h.ownerId }).lean()).isEnabled, true);
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await page.waitForURL(/\/login$/);
    await context.close(); assert.equal(browser.contexts().length, 0);
    await h.control({ patch: { trend: true } }); await h.run('worker');
    assert.equal(h.provider.state.posts.length, 1); assert.equal(await Decision.countDocuments({ status: 'submitted' }), 1);
    const intent = await Intent.findOne().lean(); assert.equal(intent.origin, 'robotrader'); assert.equal(intent.status, 'acknowledged'); assert.ok(intent.reservedCents > 0);
    assert.equal(await BrokerOrder.countDocuments(), 1); assert.ok(await Outbox.countDocuments()); assert.ok(await Audit.countDocuments({ eventType: 'robotrader_worker_run' }));
    const reopened = await browser.newContext({ viewport: { width: 1360, height: 1000 } }); const newPage = await reopened.newPage();
    await login(newPage); await newPage.goto(h.baseURL + '/robo');
    await newPage.getByText('AAPL', { exact: true }).first().waitFor();
    await newPage.getByRole('button', { name: 'Disable RoboTrader', exact: true }).waitFor();
    assert.ok((await newPage.locator('body').innerText()).includes('Alpaca'));
    await reopened.close();
  } finally { await browser.close(); }
}));
