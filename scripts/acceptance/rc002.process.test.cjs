const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness.cjs');
const Settings = require('../../backend/models/RoboSettings');
const Intent = require('../../backend/models/OrderIntent');
const Fill = require('../../backend/models/Fill');
const Capacity = require('../../backend/models/AccountCapacity');
const Lock = require('../../backend/models/RoboLock');
const result = output => JSON.parse(output.match(/ACCEPTANCE_RESULT (.*)/)[1]);
function message(child, name) {
  return new Promise((resolve, reject) => {
    const receive = value => { if (value.type === 'rc-barrier' && value.name === name) { child.off('exit', exited); child.off('message', receive); resolve(value); } };
    const exited = () => { child.off('message', receive); reject(new Error('Worker exited before controlled barrier')); };
    child.on('message', receive); child.once('exit', exited);
  });
}
test('RC002-real-worker-lock-and-coverage', { timeout: 45000 }, async () => {
  console.log('RC002_PROCESS_RUNTIME', JSON.stringify({ node: process.version, executable: process.execPath }));
  const h = await startHarness();
  try {
    await Settings.updateOne({ userId: h.ownerId }, { $set: { isEnabled: true, enabled: true, riskLevel: 'balanced' } });
    await h.control({ patch: { trend: true } });
    const first = h.spawn('worker', { RC_HOLD_TRANSPORT: 'true' });
    await message(first.child, 'transport');
    assert.equal(result(await h.run('worker')).reason, 'ROBOTRADER_LOCKED');
    assert.equal(h.provider.state.posts.length, 0);
    first.send({ type: 'rc-release', name: 'transport' });
    const finished = await first.completed; assert.equal(finished.code, 0, finished.output);
    assert.equal(h.provider.state.posts.filter(order => order.side === 'buy').length, 1);
    const entry = h.provider.state.orders.find(order => order.side === 'buy');
    const qty = Number(entry.qty);
    await h.control({ patch: { orders: [{ ...entry, status: 'filled', filled_qty: entry.qty, filled_avg_price: '100' }], positions: [] } });
    await h.run('reconcile');
    assert.equal((await Intent.findOne({ clientOrderId: entry.client_order_id })).filledQty, qty);
    assert.equal((await Capacity.findOne()).portfolioObservation.state, 'reconciliation_required');
    assert.equal(await Fill.countDocuments(), 1);
    // A new real worker keeps locking/risk/protection intact; no hidden second buy.
    await h.run('worker');
    assert.equal(h.provider.state.posts.filter(order => order.side === 'buy').length, 1);
    assert.ok((await Lock.findOne({ userId: h.ownerId })).lockedUntil <= new Date());
    await h.control({ patch: { positions: [{ symbol: 'AAPL', qty: entry.qty, market_value: String(qty * 100), current_price: '100' }] } });
    await h.run('reconcile');
    assert.equal((await Capacity.findOne()).portfolioObservation.state, 'coherent');
    const manual = result(await h.run('manual-entry'));
    assert.equal(manual.intent.status, 'acknowledged');
    assert.equal(h.provider.state.posts.filter(order => order.side === 'buy').length, 2);
    const cap = await Capacity.findOne();
    assert.equal(cap.spentCents, qty * 10000); assert.equal(cap.reservedCents, 10000);
  } finally { await h.close(); }
});
