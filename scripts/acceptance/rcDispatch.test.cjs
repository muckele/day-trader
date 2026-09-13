const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./harness.cjs');
const Settings = require('../../backend/models/RoboSettings');
const Intent = require('../../backend/models/OrderIntent');
const Lock = require('../../backend/models/RoboLock');

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
    await body(h);
  } finally {
    await h.control({ releaseHold: true }).catch(() => {});
    await h.close();
  }
}

// Break caught: the adapter awaits final account verification after the worker's
// last control/lease check, allowing a stopped executor to issue a fresh POST.
for (const action of ['emergency-stop', 'disable', 'lease-takeover', 'lease-expiry']) {
  test(`RC001-final-account-${action}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true, holdPath: '/v2/account', holdOccurrence: 7 } });
    const running = h.run('worker').then(output => ({ output }), error => ({ error: error.message }));
    await until(() => h.provider.state.held, 'final account preflight');
    const before = await Intent.find().lean();
    assert.equal(before.length, 1, 'one canonical intent exists at final preflight');
    assert.equal(before[0].status, 'submitting', 'barrier is after local admission and before final dispatch authorization');
    assert.equal(h.provider.state.posts.length, 0, 'transport has not happened');
    if (action === 'emergency-stop') await h.run('emergency-stop');
    else if (action === 'disable') {
      const login = await fetch(h.baseURL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: h.baseURL }, body: JSON.stringify({ username: 'acceptance-owner', password: 'local-test-password' }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const response = await fetch(h.baseURL + '/api/robotrader/disable', { method: 'POST', headers: { cookie, origin: h.baseURL, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 200, await response.text());
    } else {
      const update = action === 'lease-takeover'
        ? { owner: 'replacement-worker', lockedUntil: new Date(Date.now() + 60000) }
        : { lockedUntil: new Date(0) };
      assert.equal((await Lock.updateOne({ userId: h.ownerId }, { $set: update })).modifiedCount, 1);
    }
    assert.equal(h.provider.state.posts.length, 0);
    await h.control({ releaseHold: true });
    const outcome = await running;
    const after = await Intent.find().lean();
    t.diagnostic(JSON.stringify({ source: process.env.RC_REVIEWED_SOURCE || 'working-tree', runtime: process.version, executable: process.execPath, action, outcome, posts: h.provider.state.posts, intents: after.map(i => ({ id: String(i._id), status: i.status, clientOrderId: i.clientOrderId, reservedCents: i.reservedCents })) }));
    assert.equal(h.provider.state.posts.length, 0, `${action} before dispatch authorization must prohibit a new opening POST`);
    assert.equal(after.length, 1);
    assert.equal(String(after[0]._id), String(before[0]._id));
    assert.equal(after[0].clientOrderId, before[0].clientOrderId);
    assert.equal(after[0].status, 'rejected');
    assert.equal(after[0].reservedCents, 0, 'proven pre-claim refusal releases only the rejected reservation');
    if (action === 'emergency-stop' || action === 'disable') assert.equal((await readStop(h)).state, 'stopped', 'healthy stop-before-claim reaches completion');
    await h.run('reconcile');
    assert.equal(h.provider.state.posts.length, 0, 'reconciliation cannot invent another dispatch');
  }));
}

async function ownerRequest(h, method, route, body) {
  if (!h.rcCookie) {
    const login = await fetch(h.baseURL + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: h.baseURL }, body: JSON.stringify({ username: 'acceptance-owner', password: 'local-test-password' }) });
    assert.equal(login.status, 200);
    h.rcCookie = login.headers.get('set-cookie').split(';')[0];
  }
  const response = await fetch(h.baseURL + '/api/robotrader' + route, { method, headers: { cookie: h.rcCookie, origin: h.baseURL, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}
async function readStop(h) {
  const payload = await ownerRequest(h, 'GET', '/settings');
  return payload.settings.stopStatus;
}
function parseResult(output) {
  const match = output.match(/ACCEPTANCE_RESULT (.*)/);
  assert.ok(match, output);
  return JSON.parse(match[1]);
}
async function assertRetryIdentity(child, intent, expectedStatus) {
  const outcome = await child.completed;
  assert.equal(outcome.code, 0, `retry process must succeed, not merely issue no POST: ${outcome.output}`);
  const result = parseResult(outcome.output);
  assert.equal(String(result.intent._id), String(intent._id));
  assert.equal(result.intent.clientOrderId, intent.clientOrderId);
  assert.equal(result.intent.status, expectedStatus);
  assert.equal(result.executionSource, 'alpaca-paper');
  assert.equal(result.order, null, 'an untransmitted identity has no invented broker order');
  return result;
}

for (const ending of ['resume', 'process-death', 'lease-takeover']) {
  test(`RC001-claim-before-stop-${ending}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true } });
    const worker = h.spawn('worker', { RC_HOLD_TRANSPORT: 'true' });
    await until(() => worker.messages.some(m => m.name === 'transport'), 'claimed but not transmitted');
    const intent = await Intent.findOne().lean();
    assert.ok(intent);
    assert.equal(Object.keys(intent.dispatchClaims || {}).length, 1, 'final durable dispatch claim exists before transport');
    const claim = Object.values(intent.dispatchClaims)[0];
    const heldTransport = worker.messages.find(m => m.name === 'transport');
    const wirePayload = typeof heldTransport.payload === 'string' ? JSON.parse(heldTransport.payload) : heldTransport.payload;
    assert.equal(claim.payloadHash, require('node:crypto').createHash('sha256').update(JSON.stringify(wirePayload)).digest('hex'));
    assert.equal(claim.accountId, intent.accountId);
    assert.equal(claim.environment, 'paper');
    assert.equal(claim.operation, 'submit');
    assert.equal(claim.generation, (await Settings.findOne({ userId: h.ownerId }).lean()).controlGeneration);
    assert.equal(claim.executor, (await Lock.findOne({ userId: h.ownerId }).lean()).owner);
    assert.equal(wirePayload.client_order_id, intent.clientOrderId);
    assert.equal(h.provider.state.posts.length, 0);
    await h.run('emergency-stop');
    assert.equal((await Intent.findById(intent._id).lean()).stopCancelRequested, true, 'the first stop durably requests cancellation of its not-yet-visible dispatch');
    let status = await readStop(h);
    assert.equal(status.admissionsDisabled, true);
    assert.equal(status.state, 'draining');
    assert.ok(status.unresolved.some(i => i.clientOrderId === intent.clientOrderId && i.intentId === String(intent._id)));
    await h.run('reconcile'); // Repeated 404s cannot prove a paused claimant unable to send.
    await h.run('reconcile');
    assert.equal((await readStop(h)).state, 'draining');
    const retry = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
    await assertRetryIdentity(retry, intent, 'submitting');
    assert.equal(h.provider.state.posts.length, 0, 'restart/retry cannot issue a second claim or POST');
    if (ending === 'process-death') {
      worker.child.kill('SIGKILL');
      assert.equal((await worker.completed).signal, 'SIGKILL');
      await Lock.updateOne({ userId: h.ownerId }, { $set: { owner: 'replacement-worker', lockedUntil: new Date(0) } });
      await h.run('reconcile');
      const restarted = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
      await assertRetryIdentity(restarted, intent, 'submitting');
      assert.equal(h.provider.state.posts.length, 0);
      assert.equal((await readStop(h)).state, 'draining', 'death alone plus 404 is not durable drain proof');
    } else {
      if (ending === 'lease-takeover') await Lock.updateOne({ userId: h.ownerId }, { $set: { owner: 'replacement-worker', lockedUntil: new Date(Date.now() + 60000) } });
      worker.send({ type: 'rc-release', name: 'transport' });
      const completed = await worker.completed;
      assert.equal(completed.code, 0, completed.output);
      assert.equal(parseResult(completed.output).submittedOrder.intentId, String(intent._id));
      assert.equal(h.provider.state.posts.length, 1);
      assert.equal(h.provider.state.posts[0].client_order_id, intent.clientOrderId);
      assert.equal((await readStop(h)).state, 'draining');
      await h.run('reconcile');
      assert.equal((await Intent.findById(intent._id).lean()).status, 'canceled', 'reconciliation executes the first durable stop request without a second stop');
      assert.equal(h.provider.state.orders.find(order => order.client_order_id === intent.clientOrderId).status, 'canceled');
      assert.equal((await readStop(h)).state, 'stopped', 'the first stop reaches healthy drain completion through reconciliation alone');
    }
    const after = await Intent.find().lean();
    assert.equal(after.length, 1);
    assert.equal(String(after[0]._id), String(intent._id));
    assert.equal(after[0].clientOrderId, intent.clientOrderId);
    const submissionClaims = Object.values(after[0].dispatchClaims).filter(item => item.operation === 'submit');
    assert.equal(submissionClaims.length, 1, 'a legitimate cancellation claim must not be confused with a duplicate submission');
    assert.equal(submissionClaims[0].token, claim.token);
    t.diagnostic(JSON.stringify({ ending, intentId: String(intent._id), clientOrderId: intent.clientOrderId, posts: h.provider.state.posts.length, stopStatus: await readStop(h) }));
  }));
}

for (const mode of ['acknowledge', 'accepted500']) {
  test(`RC001-transmitted-${mode}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true, mode } });
    await h.run('worker');
    assert.equal(h.provider.state.posts.length, 1);
    const intent = await Intent.findOne().lean();
    assert.ok(intent.reservedCents > 0);
    assert.equal(intent.clientOrderId, h.provider.state.posts[0].client_order_id);
    const foreign = { id: 'foreign-order', client_order_id: 'foreign', symbol: 'MSFT', side: 'buy', qty: '1', filled_qty: '0', status: 'new' };
    await h.control({ patch: { orders: [...h.provider.state.orders, foreign] } });
    await h.run('emergency-stop');
    await h.run('reconcile');
    const after = await Intent.findOne().lean();
    assert.equal(after.status, 'canceled');
    assert.equal(after.reservedCents, 0);
    assert.equal(after.clientOrderId, intent.clientOrderId);
    assert.equal(h.provider.state.orders.find(o => o.id === 'foreign-order').status, 'new');
    assert.equal(h.provider.state.posts.length, 1);
    assert.equal((await readStop(h)).state, 'stopped');
  }));
}

test('RC001-disable-preserves-manual-protection-reduction', { timeout: 60000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true } });
  await h.run('worker');
  const entry = h.provider.state.orders.find(o => o.side === 'buy');
  await ownerRequest(h, 'POST', '/disable', {});
  await h.control({ fill: { id: entry.id, qty: Number(entry.qty), price: 100 } });
  await h.run('reconcile');
  const protection = h.provider.state.orders.find(o => o.side === 'sell' && o.type === 'stop');
  assert.ok(protection, 'confirmed exposure receives protection while entries disabled');
  assert.equal(Number(protection.qty), Number(entry.qty));
  await ownerRequest(h, 'POST', '/positions/AAPL/close', { idempotencyKey: 'rc-authorized-close' });
  const closes = h.provider.state.orders.filter(o => o.side === 'sell' && o.type === 'market');
  assert.equal(closes.length, 1, 'authorized coordinated reduction remains possible while disabled');
  assert.equal(h.provider.state.orders.find(o => o.id === protection.id).status, 'canceled');
  await h.control({ fill: { id: closes[0].id, qty: Number(closes[0].qty), price: 100 } });
  await h.run('reconcile');
  const manual = h.spawn('manual-entry', { RC_MANUAL_KEY: 'deliberate-owner-entry' });
  const outcome = await manual.completed;
  assert.equal(outcome.code, 0, outcome.output);
  assert.ok(h.provider.state.posts.some(o => o.side === 'buy' && o.qty === '1'), 'ordinary Robo disable does not revoke deliberate manual policy');
}));

test('RC001-final-account-heartbeat-loss', { timeout: 60000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true, holdPath: '/v2/account', holdOccurrence: 7 } });
  const worker = h.spawn('worker', { RC_CONTROL_HEARTBEAT: 'true' });
  await until(() => h.provider.state.held, 'final account before heartbeat failure');
  assert.equal(h.provider.state.posts.length, 0);
  worker.send({ type: 'rc-heartbeat-failure' });
  await until(() => worker.messages.some(m => m.type === 'rc-heartbeat-failed'), 'actual heartbeat failure processed');
  await h.control({ releaseHold: true });
  const outcome = await worker.completed;
  assert.equal(h.provider.state.posts.length, 0, `heartbeat loss must prohibit final claim: ${outcome.output}`);
}));

for (const reenable of [false, true]) {
  test(`RC001-awaited-renewal-${reenable ? 'reenable-generation' : 'stop'}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true } });
    const worker = h.spawn('worker', { RC_HOLD_RENEWAL: '2' });
    await until(() => worker.messages.some(m => m.name === 'renewal'), 'second awaited renewal after settings read');
    assert.equal(h.provider.state.posts.length, 0);
    const before = await Settings.findOne({ userId: h.ownerId }).lean();
    await ownerRequest(h, 'POST', '/disable', {});
    if (reenable) await ownerRequest(h, 'POST', '/enable', {});
    const after = await Settings.findOne({ userId: h.ownerId }).lean();
    assert.ok(after.controlGeneration > before.controlGeneration);
    worker.send({ type: 'rc-release', name: 'renewal' });
    await worker.completed;
    assert.equal(h.provider.state.posts.length, 0, 'obsolete control generation cannot become a dispatch claim');
  }));
}

test('RC001-ambiguous-claim-commit', { timeout: 60000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true } });
  const worker = h.spawn('worker', { RC_AMBIGUOUS_DISPATCH_COMMIT: 'true' });
  const outcome = await worker.completed;
  assert.ok(worker.messages.some(m => m.type === 'rc-ambiguous-commit'), outcome.output);
  const intent = await Intent.findOne().lean();
  assert.equal(Object.keys(intent.dispatchClaims || {}).length, 1, 'claim really committed despite lost acknowledgment');
  assert.equal(h.provider.state.posts.length, 0, 'ambiguous claim cannot blindly dispatch');
  assert.ok(intent.reservedCents > 0);
  const retry = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
  await assertRetryIdentity(retry, intent, 'submission_uncertain');
  await h.run('reconcile');
  assert.equal(h.provider.state.posts.length, 0);
  assert.equal(await Intent.countDocuments(), 1);
  assert.equal((await Intent.findOne().lean()).clientOrderId, intent.clientOrderId);
  await h.run('emergency-stop');
  assert.equal((await readStop(h)).state, 'draining');
}));

for (const operation of ['protection', 'reduction']) {
  for (const loss of ['takeover', 'expiry']) {
    test(`RC001-${operation}-final-account-${loss}`, { timeout: 60000 }, async t => fixture(t, async h => {
      const ExitLock = require('../../backend/models/OrderProtectionLock');
      if (operation === 'protection') {
        await h.control({ patch: { trend: true } });
        await h.run('worker');
      } else {
        const manual = h.spawn('manual-entry');
        const outcome = await manual.completed;
        assert.equal(outcome.code, 0, outcome.output);
      }
      const entry = h.provider.state.orders.find(o => o.side === 'buy');
      await h.control({ fill: { id: entry.id, qty: Number(entry.qty), price: 100 } });
      if (operation === 'reduction') await h.run('reconcile');
      await ownerRequest(h, 'POST', '/disable', {});
      await h.control({ patch: { holdPath: '/v2/account', holdOccurrence: operation === 'protection' ? 4 : 3, holdSeen: 0 } });
      const worker = h.spawn(operation === 'protection' ? 'reconcile' : 'manual-reduce');
      await until(() => h.provider.state.held, `${operation} final account preflight`);
      if (operation === 'protection') assert.equal((await require('../../backend/models/OrderProtection').findOne().lean()).state, 'submitting');
      else assert.equal((await Intent.findOne({ side: 'sell' }).lean()).status, 'submitting');
      assert.equal(h.provider.state.posts.filter(o => o.side === 'sell').length, 0);
      const mutation = loss === 'takeover' ? { owner: 'replacement-exit', expiresAt: new Date(Date.now() + 60000) } : { expiresAt: new Date(0) };
      assert.equal((await ExitLock.updateOne({ accountId: 'acceptance-paper' }, { $set: mutation })).modifiedCount, 1);
      await h.control({ releaseHold: true });
      const outcome = await worker.completed;
      assert.equal(h.provider.state.posts.filter(o => o.side === 'sell').length, 0, `${operation} stale executor must not dispatch: ${outcome.output}`);
      assert.equal(Number(h.provider.state.positions.find(p => p.symbol === 'AAPL').qty), Number(entry.qty));
    }));
  }
}

test('RC001-run-once-final-account-stop', { timeout: 60000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true, holdPath: '/v2/account', holdOccurrence: 7 } });
  const running = ownerRequest(h, 'POST', '/run-once-paper', {}).then(result => ({ result }), error => ({ error: error.message }));
  await until(() => h.provider.state.held, 'actual authenticated Run Once final account');
  assert.equal((await Intent.findOne().lean()).status, 'submitting');
  await h.run('emergency-stop');
  assert.equal(h.provider.state.posts.length, 0);
  await h.control({ releaseHold: true });
  await running;
  assert.equal(h.provider.state.posts.length, 0);
  assert.equal((await Settings.findOne({ userId: h.ownerId }).lean()).isEnabled, false);
  assert.equal(await Intent.countDocuments(), 1);
}));

test('RC001-legacy-control-writer-generation', { timeout: 60000 }, async t => fixture(t, async h => {
  await ownerRequest(h, 'GET', '/settings');
  await h.control({ patch: { trend: true, holdPath: '/v2/account', holdOccurrence: 7 } });
  const worker = h.spawn('worker');
  await until(() => h.provider.state.held, 'final account before legacy control transition');
  const before = await Settings.findOne({ userId: h.ownerId }).lean();
  const legacy = await fetch(h.baseURL + '/api/robo/settings', { method: 'PUT', headers: { cookie: h.rcCookie, origin: h.baseURL, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(legacy.status, 200, await legacy.text());
  const stopped = await Settings.findOne({ userId: h.ownerId }).lean();
  t.diagnostic(JSON.stringify({ beforeGeneration: before.controlGeneration, afterGeneration: stopped.controlGeneration, enabled: stopped.enabled, isEnabled: stopped.isEnabled, posts: h.provider.state.posts.length }));
  assert.ok(stopped.controlGeneration > before.controlGeneration, 'legacy disable must participate in durable control ordering, not bypass the generation transition');
  await ownerRequest(h, 'POST', '/enable', {});
  await h.control({ releaseHold: true });
  await worker.completed;
  assert.equal(h.provider.state.posts.length, 0, 're-enable cannot revive the request predating the legacy stop');
}));

test('RC001-process-death-before-claim', { timeout: 60000 }, async t => fixture(t, async h => {
  await h.control({ patch: { trend: true, holdPath: '/v2/account', holdOccurrence: 7 } });
  const worker = h.spawn('worker');
  await until(() => h.provider.state.held, 'final preflight before D');
  const intent = await Intent.findOne().lean();
  assert.equal(intent.status, 'submitting');
  assert.equal(Object.keys(intent.dispatchClaims || {}).length, 0);
  assert.equal(h.provider.state.posts.length, 0);
  worker.child.kill('SIGKILL');
  assert.equal((await worker.completed).signal, 'SIGKILL');
  await h.control({ releaseHold: true });
  await h.run('emergency-stop');
  await ownerRequest(h, 'POST', '/enable', {});
  const retry = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
  await assertRetryIdentity(retry, intent, 'submitting');
  await h.run('reconcile');
  assert.equal(h.provider.state.posts.length, 0);
  const after = await Intent.findById(intent._id).lean();
  assert.equal(after.clientOrderId, intent.clientOrderId);
  assert.equal(Object.keys(after.dispatchClaims || {}).length, 0);
  assert.ok(after.reservedCents > 0, 'death without a durable no-send acknowledgment cannot clear reservation');
}));

test('RC001-process-death-after-acceptance-before-persistence', { timeout: 60000 }, async t => fixture(t, async h => {
  const BrokerOrder = require('../../backend/models/BrokerOrder');
  await h.control({ patch: { trend: true, holdPostResponse: true } });
  const worker = h.spawn('worker');
  await until(() => h.provider.state.postResponseHeld, 'provider accepted before response persistence');
  assert.equal(h.provider.state.posts.length, 1);
  const accepted = h.provider.state.orders[0];
  const intent = await Intent.findOne().lean();
  assert.equal(intent.clientOrderId, accepted.client_order_id);
  assert.equal(Object.keys(intent.dispatchClaims || {}).length, 1);
  assert.equal(await BrokerOrder.countDocuments(), 0, 'acceptance has not been ingested');
  worker.child.kill('SIGKILL');
  assert.equal((await worker.completed).signal, 'SIGKILL');
  await h.control({ patch: { holdPostResponse: false }, releaseHold: true });
  await h.run('reconcile');
  const retry = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
  const outcome = await retry.completed;
  assert.equal(outcome.code, 0, outcome.output);
  const restored = parseResult(outcome.output);
  assert.equal(String(restored.intent._id), String(intent._id));
  assert.equal(restored.intent.clientOrderId, intent.clientOrderId);
  assert.equal(restored.intent.status, 'acknowledged');
  assert.equal(restored.order.externalOrderId, accepted.id);
  assert.equal(await BrokerOrder.countDocuments(), 1);
  assert.equal(h.provider.state.posts.length, 1);
  await h.run('emergency-stop');
  await h.run('reconcile');
  assert.equal((await Intent.findById(intent._id).lean()).status, 'canceled');
  assert.equal((await readStop(h)).state, 'stopped');
}));

test('RC001-held-post-response-stop-then-fill', { timeout: 60000 }, async t => fixture(t, async h => {
  const Fill = require('../../backend/models/Fill');
  const Capacity = require('../../backend/models/AccountCapacity');
  const Bucket = require('../../backend/models/SpendingBucket');
  await h.control({ patch: { trend: true, holdPostResponse: true, hideHeldOrder: true } });
  const worker = h.spawn('worker');
  await until(() => h.provider.state.postResponseHeld, 'actual POST sent with delayed visibility and response');
  const entry = h.provider.state.orders[0];
  const intent = await Intent.findOne().lean();
  assert.equal(h.provider.state.posts.filter(o => o.side === 'buy').length, 1);
  assert.equal(intent.status, 'submitting');
  await h.run('emergency-stop');
  let state = await Intent.findById(intent._id).lean();
  assert.equal(state.stopCancelRequested, true);
  assert.ok(state.reservedCents > 0);
  assert.equal((await readStop(h)).state, 'draining');
  // The provider reports a genuine two-share partial fill after the stop was
  // issued while its accepted order was not yet visible to queries.
  await h.control({ fill: { id: entry.id, qty: 2, price: 100 }, patch: { holdPostResponse: false }, releaseHold: true });
  const completed = await worker.completed;
  assert.equal(completed.code, 0, completed.output);
  await h.run('reconcile');
  await h.run('reconcile');
  state = await Intent.findById(intent._id).lean();
  assert.equal(state.clientOrderId, entry.client_order_id);
  assert.equal(state.status, 'canceled');
  assert.equal(state.filledQty, 2);
  assert.equal(state.filledNotionalCents, 20000);
  assert.equal(state.reservedCents, 0);
  assert.equal(h.provider.state.posts.filter(o => o.side === 'buy').length, 1);
  assert.equal(h.provider.state.orders.find(o => o.id === entry.id).status, 'canceled');
  const stops = h.provider.state.orders.filter(o => o.side === 'sell' && o.type === 'stop' && o.status === 'new');
  assert.equal(stops.length, 1);
  assert.equal(Number(stops[0].qty), 2, 'filled shares remain protected after the opening remainder drains');
  assert.equal((await Fill.find({ intentId: intent._id }).lean()).reduce((sum, f) => sum + f.qty, 0), 2);
  assert.equal((await Capacity.findOne({ accountId: intent.accountId }).lean()).reservedCents, 0);
  const buckets = await Bucket.find({ accountId: intent.accountId }).lean();
  assert.equal(buckets.length, 3);
  assert.ok(buckets.every(b => b.spentCents === 20000 && b.reservedCents === 0));
  assert.equal((await readStop(h)).state, 'stopped');
}));

for (const action of ['retry', 'abort']) {
  test(`RC001-dispatch-transaction-${action}`, { timeout: 60000 }, async t => fixture(t, async h => {
    await h.control({ patch: { trend: true } });
    const worker = h.spawn('worker', { [action === 'retry' ? 'RC_RETRY_DISPATCH_TRANSACTION' : 'RC_ABORT_DISPATCH_TRANSACTION']: 'true' });
    const outcome = await worker.completed;
    assert.equal(outcome.code, 0, outcome.output);
    assert.ok(worker.messages.some(m => m.type === `rc-transaction-${action}`), 'the actual dispatch transaction reached the controlled database boundary');
    const intent = await Intent.findOne().lean();
    assert.equal(await Intent.countDocuments(), 1);
    if (action === 'retry') {
      assert.equal(h.provider.state.posts.length, 1, 'callback retry may not transmit twice or transmit from inside the transaction');
      assert.equal(Object.keys(intent.dispatchClaims || {}).length, 1);
      assert.equal(intent.status, 'acknowledged');
      assert.equal(intent.clientOrderId, h.provider.state.posts[0].client_order_id);
    } else {
      assert.equal(h.provider.state.posts.length, 0, 'database failure before D prohibits transmission');
      assert.equal(Object.keys(intent.dispatchClaims || {}).length, 0);
      assert.equal(intent.status, 'submission_uncertain');
      assert.ok(intent.reservedCents > 0);
      const retry = h.spawn('retry-intent', { RC_CLIENT_ORDER_ID: intent.clientOrderId });
      await assertRetryIdentity(retry, intent, 'submission_uncertain');
      assert.equal(h.provider.state.posts.length, 0);
    }
  }));
}
