const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness.cjs');
const Settings = require('../../backend/models/RoboSettings');
const Intent = require('../../backend/models/OrderIntent');
const Protection = require('../../backend/models/OrderProtection');
const ExitLock = require('../../backend/models/OrderProtectionLock');
const Close = require('../../backend/models/PositionClose');
const Projection = require('../../backend/models/RoboTradeOrder');

async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Controlled barrier not reached: ${label}`);
}
async function fixture(t, body) {
  const h = await startHarness();
  try {
    await Settings.updateOne({ userId: h.ownerId }, { $set: { isEnabled: true, enabled: true, riskLevel: 'balanced' } });
    await ownerRequest(h, 'GET', '/settings');
    await body(h);
  } finally {
    t.diagnostic(JSON.stringify({ runtime: process.version, executable: process.execPath, source: process.env.RC_REVIEWED_SOURCE || 'working-tree', requests: h.provider.state.requests, posts: h.provider.state.posts }));
    await h.control({ releaseHold: true }).catch(() => {});
    await h.close();
  }
}
async function ownerRequest(h, method, route, body) {
  if (!h.rcCookie) {
    const response = await fetch(h.baseURL + '/api/login', { method: 'POST', headers: { origin: h.baseURL, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'acceptance-owner', password: 'local-test-password' }) });
    assert.equal(response.status, 200);
    h.rcCookie = response.headers.get('set-cookie').split(';')[0];
  }
  const response = await fetch(h.baseURL + '/api/robotrader' + route, { method, headers: { cookie: h.rcCookie, origin: h.baseURL, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}
const writes = (h, method) => h.provider.state.requests.filter(r => r.method === method && r.path.startsWith('/v2/orders'));
const claims = record => Object.values(record.dispatchClaims || {});
async function holdAccount(h, occurrence) {
  await h.control({ patch: { holdPath: '/v2/account', holdOccurrence: occurrence, holdSeen: 0 } });
}
async function assertBoundary(h, occurrence) {
  await until(() => h.provider.state.held, 'final account preflight');
  assert.deepEqual(h.provider.state.held, { path: '/v2/account', occurrence });
  const lock = await ExitLock.findOne({ accountId: 'acceptance-paper' }).lean();
  assert.ok(lock?.owner);
  assert.ok(lock.expiresAt > new Date(), 'the actual operation owns a healthy exit lease before the controlled loss');
  return lock;
}
async function loseLease(h, loss, lock) {
  const mutation = loss === 'takeover' ? { owner: 'replacement-exit', expiresAt: new Date(Date.now() + 60000) } : { expiresAt: new Date(0) };
  assert.equal((await ExitLock.updateOne({ _id: lock._id, owner: lock.owner }, { $set: mutation })).modifiedCount, 1);
  await h.control({ releaseHold: true });
}
async function assertTakeoverPreserved(loss) {
  if (loss === 'takeover') assert.equal((await ExitLock.findOne().lean()).owner, 'replacement-exit', 'old executor cleanup cannot release the replacement owner');
}
async function fillEntry(h, { robo = false, partial = false } = {}) {
  if (robo) await h.control({ patch: { trend: true } });
  await h.run(robo ? 'worker' : 'manual-entry');
  const entry = h.provider.state.orders.find(o => o.side === 'buy');
  assert.ok(entry, 'healthy canonical entry reached provider');
  if (partial) assert.ok(Number(entry.qty) > 2);
  await h.control({ fill: { id: entry.id, qty: partial ? 2 : Number(entry.qty), price: 100 } });
  await h.run('reconcile');
  const intent = await Intent.findOne({ side: 'buy' }).lean();
  assert.equal(intent.filledQty, partial ? 2 : Number(entry.qty));
  return entry;
}

// Cancellation is a broker write too: resizing a stop cannot cancel the old
// protection after its executor loses the shared exit lease at adapter preflight.
for (const loss of ['takeover', 'expiry']) {
  test(`RC001-protection-cancel-final-account-${loss}`, { timeout: 60000 }, async t => fixture(t, async h => {
    const entry = await fillEntry(h, { robo: true, partial: true });
    const before = await Protection.findOne().lean();
    const stop = h.provider.state.orders.find(o => o.id === before.brokerOrderId);
    assert.equal(stop.type, 'stop');
    assert.equal(Number(stop.qty), 2);
    await ownerRequest(h, 'POST', '/disable', {});
    await h.control({ fill: { id: entry.id, qty: Number(entry.qty), price: 100 } });
    const deleteCount = writes(h, 'DELETE').length;
    const postCount = h.provider.state.posts.length;
    await holdAccount(h, 4);
    const running = h.run('reconcile');
    const lock = await assertBoundary(h, 4);
    const prepared = await Protection.findById(before._id).lean();
    assert.equal(prepared.state, 'cancel_pending');
    assert.equal(prepared.brokerOrderId, stop.id);
    assert.equal(claims(prepared).filter(c => c.operation === `cancel:${stop.id}`).length, 0);
    assert.equal(writes(h, 'DELETE').length, deleteCount);
    await loseLease(h, loss, lock);
    await running;
    assert.equal(writes(h, 'DELETE').length, deleteCount, 'lost executor sends no stop cancellation');
    assert.equal(h.provider.state.posts.length, postCount, 'lost executor cannot overlap a new stop');
    assert.equal(stop.status, 'new');
    assert.equal(Number(h.provider.state.positions[0].qty), Number(entry.qty));
    const after = await Protection.findById(before._id).lean();
    assert.equal(after.state, 'cancel_pending');
    assert.match(after.error, /Dispatch lease lost or expired/, 'the expected final authorization denial caused the no-write outcome');
    assert.equal(after.clientOrderId, before.clientOrderId);
    assert.equal(claims(after).filter(c => c.operation === `cancel:${stop.id}`).length, 0);
    assert.equal((await Intent.findOne({ side: 'buy' }).lean()).filledQty, Number(entry.qty));
    await assertTakeoverPreserved(loss);
  }));
}

for (const operation of ['post', 'protection-cancel', 'exit-cancel']) {
  for (const loss of ['takeover', 'expiry']) {
    test(`RC001-close-${operation}-final-account-${loss}`, { timeout: 60000 }, async t => fixture(t, async h => {
      const entry = await fillEntry(h, { robo: operation === 'protection-cancel' });
      await ownerRequest(h, 'POST', '/disable', {});
      const body = { idempotencyKey: 'rc-exit-close' };
      let originalClose, originalSell, protective;
      if (operation === 'exit-cancel') {
        const healthy = await ownerRequest(h, 'POST', '/positions/AAPL/close', body);
        assert.equal(healthy.intent.status, 'acknowledged');
        originalClose = await Close.findOne().lean();
        originalSell = await Intent.findOne({ side: 'sell' }).lean();
        assert.ok(originalClose.active);
        assert.equal(originalSell.qty, Number(entry.qty));
        assert.equal((await Close.updateOne({ _id: originalClose._id }, { $set: { deadlineAt: new Date(0) } })).modifiedCount, 1);
      }
      if (operation === 'protection-cancel') {
        protective = await Protection.findOne().lean();
        assert.equal(h.provider.state.orders.find(o => o.id === protective.brokerOrderId).status, 'new');
      }
      const occurrence = operation === 'protection-cancel' ? 2 : 4;
      const postCount = h.provider.state.posts.length;
      const deleteCount = writes(h, 'DELETE').length;
      await holdAccount(h, occurrence);
      const running = ownerRequest(h, 'POST', '/positions/AAPL/close', body);
      const lock = await assertBoundary(h, occurrence);
      const prepared = await Close.findOne().lean();
      const sell = await Intent.findOne({ side: 'sell' }).lean();
      assert.equal(prepared.active, true, 'unconfirmed close retains exclusive recovery ownership');
      if (operation === 'post') {
        assert.equal(prepared.state, 'submitting');
        assert.equal(sell.status, 'submitting');
        assert.equal(claims(sell).length, 0, 'no durable dispatch authorization exists at the held account GET');
      } else if (operation === 'protection-cancel') {
        assert.equal(prepared.state, 'cancel_pending');
        assert.deepEqual(prepared.stops.map(s => s.brokerOrderId), [protective.brokerOrderId]);
        assert.equal(sell, null, 'close cannot be submitted until its stop is authoritatively canceled');
      } else {
        assert.equal(prepared.state, 'reconciliation_required');
        assert.equal(prepared.exitCancelRequested, true);
        assert.equal(sell.status, 'cancel_pending');
        assert.equal(String(sell._id), String(originalSell._id));
      }
      assert.equal(h.provider.state.posts.length, postCount);
      assert.equal(writes(h, 'DELETE').length, deleteCount);
      await loseLease(h, loss, lock);
      const result = await running;
      assert.equal(h.provider.state.posts.length, postCount, 'lost close executor sends no new POST');
      assert.equal(writes(h, 'DELETE').length, deleteCount, 'lost close executor sends no cancellation');
      assert.equal(Number(h.provider.state.positions[0].qty), Number(entry.qty));
      const after = await Close.findOne().lean();
      assert.equal(String(after._id), String(prepared._id));
      assert.equal(await Close.countDocuments(), 1);
      if (operation === 'post') {
        assert.equal(result.intent.status, 'rejected', 'definite pre-dispatch refusal is persisted');
        assert.match(result.intent.rejectionReason, /Dispatch lease lost or expired/);
        assert.equal(claims(await Intent.findById(sell._id).lean()).length, 0);
      } else {
        assert.equal(after.active, true, 'unresolved stop/exit keeps its exclusive close reservation');
        assert.match(after.error, /Dispatch lease lost or expired/, 'unrelated failures cannot satisfy the lease regression');
        assert.equal(after.state, operation === 'exit-cancel' ? 'reconciliation_required' : 'cancel_uncertain');
        const retainedOrder = operation === 'exit-cancel' ? originalSell.clientOrderId : protective.clientOrderId;
        assert.equal(h.provider.state.orders.find(o => o.client_order_id === retainedOrder).status, 'new');
        if (operation === 'exit-cancel') {
          const retained = await Intent.findById(originalSell._id).lean();
          assert.equal(retained.qty - retained.filledQty, originalSell.qty, 'unconfirmed cancellation retains the entire outstanding reducing quantity');
          assert.equal(retained.status, 'cancel_pending');
          assert.equal(claims(retained).filter(c => c.operation.startsWith('cancel:')).length, 0);
        }
      }
      await assertTakeoverPreserved(loss);
    }));
  }
}

for (const action of ['disable', 'emergency-stop']) {
  test(`RC001-reducing-replacement-final-account-${action}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true } });
    await h.run('worker');
    const intent = await Intent.findOne().lean();
    const projection = await Projection.findOne({ intentId: intent._id }).lean();
    assert.ok(projection);
    const nextQty = intent.qty - 1;
    const nextLimit = intent.limitPrice - 0.1;
    assert.ok(nextQty > 0);
    await holdAccount(h, 2);
    const running = ownerRequest(h, 'POST', `/orders/${projection._id}/replace`, { qty: nextQty, limitPrice: nextLimit, idempotencyKey: 'rc-reducing-replacement' });
    await until(() => h.provider.state.held, 'replacement final account');
    assert.deepEqual(h.provider.state.held, { path: '/v2/account', occurrence: 2 });
    const prepared = await Intent.findById(intent._id).lean();
    assert.equal(prepared.status, 'replace_pending');
    assert.equal(prepared.replacement.status, 'pending');
    assert.equal(writes(h, 'PATCH').length, 0);
    assert.equal(claims(prepared).filter(c => c.operation.startsWith('replace:')).length, 0);
    if (action === 'disable') await ownerRequest(h, 'POST', '/disable', {});
    else {
      await h.run('emergency-stop');
      assert.equal((await Intent.findById(intent._id).lean()).stopCancelRequested, true);
    }
    assert.equal((await Settings.findOne({ userId: h.ownerId }).lean()).isEnabled, false);
    await h.control({ releaseHold: true });
    const result = await running;
    const after = await Intent.findById(intent._id).lean();
    assert.equal(String(result.intent._id), String(intent._id));
    assert.equal(after.clientOrderId, intent.clientOrderId);
    assert.equal(await Intent.countDocuments(), 1);
    assert.equal(h.provider.state.posts.length, 1, 'replacement cannot create a second logical opening');
    if (action === 'disable') {
      assert.equal(writes(h, 'PATCH').length, 1, 'ordinary disable preserves the owner-authorized reduction');
      assert.equal(after.qty, nextQty);
      assert.equal(after.limitPrice, nextLimit);
      assert.equal(after.replacement.status, 'acknowledged');
      const successor = h.provider.state.orders.find(o => o.client_order_id === prepared.replacement.clientOrderId);
      assert.ok(successor);
      assert.equal(Number(successor.qty), nextQty);
      assert.equal(Number(successor.limit_price), nextLimit);
      assert.equal(claims(after).filter(c => c.operation.startsWith('replace:')).length, 1);
    } else {
      assert.equal(writes(h, 'PATCH').length, 0, 'emergency cancellation supersedes the pending replacement');
      assert.equal(after.qty, intent.qty);
      assert.equal(after.reservedCents, intent.reservedCents, 'unresolved original entry retains its reservation');
      assert.equal(claims(after).filter(c => c.operation.startsWith('replace:')).length, 0);
      assert.equal(after.replacement.clientOrderId, prepared.replacement.clientOrderId);
      assert.equal(after.stopCancelRequested, true);
      assert.match(after.rejectionReason, /Emergency cancellation supersedes replacement/);
    }
  }));
}
