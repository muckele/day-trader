const test = require('node:test');
const assert = require('node:assert/strict');
const { startStartupFixture } = require('../../scripts/acceptance/startup-fixture.cjs');
let h;
test.before(async () => { h = await startStartupFixture(); });
test.after(async () => { await h?.close(); });
const userBuilds = ledger => ledger.commands.filter(c => c.name === 'createIndexes' && c.collection === 'users');
const read = async () => { const r = await h.request('/api/readiness', { cookie: h.cookie }); return { status: r.status, body: await r.json() }; };

test('STARTUP production legacy duplicates make zero User index attempts', async () => {
  assert.deepEqual(userBuilds(await h.control('snapshot')), []);
});
test('STARTUP original Users and indexes are preserved', async () => {
  assert.deepEqual(await h.db.collection('users').find().sort({ _id: 1 }).toArray(), h.before.users);
  assert.deepEqual(await h.db.collection('users').listIndexes().toArray(), h.before.indexes);
  assert.ok((await h.db.collection('orderintents').listIndexes().toArray()).some(i => i.unique));
  assert.equal(await h.db.collection('operationalreadiness').countDocuments(), 1);
  assert.deepEqual(await h.db.collection('orderintents').findOne({ _id: h.intent._id }), h.intent);
});
test('STARTUP exact owner auth rejects duplicate password nonowner and registration', async () => {
  assert.equal((await h.login('other-password')).status, 401);
  assert.equal((await h.login('wrong')).status, 401);
  assert.equal((await h.login('owner-password')).status, 200);
  assert.equal((await h.request('/api/register', { method: 'POST', body: { username: 'new', password: 'new' } })).status, 403);
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ sub: String(h.other), userId: String(h.other), sessionVersion: 0 }, h.env.JWT_SECRET);
  assert.equal((await h.request('/api/readiness', { cookie: 'daytrader_session=' + token })).status, 403);
  assert.deepEqual(await h.db.collection('users').find().sort({ _id: 1 }).toArray(), h.before.users);
});
test('STARTUP repeated readiness has zero writes external requests or worker starts', async () => {
  const before = await h.control('snapshot');
  for (let i = 0; i < 8; i++) assert.equal((await read()).body.maintenanceReady, true);
  const after = await h.control('snapshot');
  const commands = after.commands.slice(before.commands.length);
  assert.ok(commands.length > 0);
  assert.ok(commands.every(c => ['find', 'getMore', 'killCursors', 'endSessions'].includes(c.name)), JSON.stringify(commands));
  assert.deepEqual(after.externalAttempts, []); assert.equal(after.workerTimers, 0);
});
test('STARTUP changed controls are current without normalizing settings', async () => {
  const c = h.db.collection('robosettings');
  for (const patch of [{ enabled: true }, { isEnabled: true }, { mode: 'live' }, { liveTradingExplicitlyEnabled: true }]) {
    await c.updateOne({ userId: h.owner }, { $set: patch }); const before = await c.findOne({ userId: h.owner });
    const r = await read(); assert.equal(r.status, 200); assert.equal(r.body.runtimeReady, true); assert.equal(r.body.maintenanceReady, false);
    assert.deepEqual(await c.findOne({ userId: h.owner }), before);
    await c.updateOne({ userId: h.owner }, { $set: { mode: 'paper', enabled: false, isEnabled: false, liveTradingExplicitlyEnabled: false } });
  }
});
test('STARTUP missing settings fail without creation', async () => {
  const c = h.db.collection('robosettings'); const saved = await c.findOne({ userId: h.owner });
  await c.deleteOne({ _id: saved._id });
  try { const r = await read(); assert.equal(r.status, 503); assert.ok(r.body.blockers.includes('OWNER_SETTINGS_MISSING')); assert.equal(await c.countDocuments(), 0); }
  finally { await c.insertOne(saved); }
});
test('STARTUP ambiguous settings fail without normalization', async () => {
  const c = h.db.collection('robosettings'); await c.dropIndex('userId_1');
  const extra = await c.insertOne({ ...h.settings, _id: undefined });
  try { const r = await read(); assert.equal(r.status, 503); assert.ok(r.body.blockers.includes('OWNER_SETTINGS_AMBIGUOUS')); assert.equal(await c.countDocuments(), 2); }
  finally { await c.deleteOne({ _id: extra.insertedId }); await c.createIndex({ userId: 1 }, { unique: true }); }
});
test('STARTUP wrong owner configuration and missing owner remain rejected', async () => {
  await h.control('env', { OWNER_USER_ID: '000000000000000000000099' });
  try { assert.equal((await h.login('owner-password')).status, 401); assert.equal((await read()).status, 403); }
  finally { await h.control('env', { OWNER_USER_ID: String(h.owner) }); }
  const owner = await h.db.collection('users').findOne({ _id: h.owner }); await h.db.collection('users').deleteOne({ _id: h.owner });
  try { assert.equal((await h.login('owner-password')).status, 401); assert.equal((await read()).status, 401); }
  finally { await h.db.collection('users').insertOne(owner); }
});
test('STARTUP reconnect and model reimport never build User indexes', async () => {
  await h.control('reconnect');
  for (let i = 0; i < 80; i++) { if ((await read()).body.maintenanceReady) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal((await read()).body.maintenanceReady, true);
  assert.deepEqual(userBuilds(await h.control('snapshot')), []);
  assert.deepEqual(await h.db.collection('users').find().sort({ _id: 1 }).toArray(), h.before.users);
  assert.deepEqual(await h.db.collection('users').listIndexes().toArray(), h.before.indexes);
});
test('STARTUP existing unique User indexes remain untouched', async () => {
  const f = await startStartupFixture({ unique: true });
  try { assert.deepEqual(await f.db.collection('users').listIndexes().toArray(), f.before.indexes); assert.deepEqual(userBuilds(await f.control('snapshot')), []); }
  finally { await f.close(); }
});
for (const fault of ['index', 'write']) test('STARTUP actual failed ' + fault + ' bootstrap blocks readiness', async () => {
  const f = await startStartupFixture({ fault });
  try {
    let ledger;
    for (let i = 0; i < 100; i++) { ledger = await f.control('snapshot'); if (ledger.injectedFaults) break; await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ledger.injectedFaults > 0);
    const r = await f.request('/api/readiness', { cookie: f.cookie }); const d = await r.json();
    assert.equal(r.status, 503); assert.equal(d.runtimeReady, false); assert.equal(d.maintenanceReady, false);
    assert.equal(d.persistence.ready, false); assert.equal(await f.db.collection('operationalreadiness').countDocuments(), 0);
    assert.deepEqual(ledger.externalAttempts, []); assert.equal(ledger.workerTimers, 0);
  } finally { await f.close(); }
});
test('STARTUP nonempty protective preflight uses expiresAt and state', async () => {
  const { readProtectiveWork } = require('../scripts/read-only-release-preflight');
  const now = new Date(); const locks = h.db.collection('orderprotectionlocks'); const closes = h.db.collection('positioncloses');
  await locks.insertMany([{ accountId: 'synthetic-a', expiresAt: new Date(+now + 60000) }, { accountId: 'synthetic-b', expiresAt: new Date(+now - 60000), lockedUntil: new Date(+now + 60000) }]);
  await closes.insertMany([{ accountId: 'synthetic-a', symbol: 'AAA', idempotencyKey: 'one', active: true, state: 'discovering', status: 'filled' }, { accountId: 'synthetic-a', symbol: 'BBB', idempotencyKey: 'two', active: false, state: 'completed', status: 'bogus' }]);
  const r = await readProtectiveWork(h.db, now); assert.equal(r.activeProtectionLeases, 1); assert.equal(r.activePositionCloses, 1);
  assert.deepEqual(r.positionCloseStates.sort((a, b) => a._id.localeCompare(b._id)), [{ _id: 'completed', count: 1 }, { _id: 'discovering', count: 1 }]);
  assert.equal(await locks.countDocuments(), 2); assert.equal(await closes.countDocuments(), 2);
});
test('STARTUP maintenance readiness is affirmative without external acceptance', async () => {
  const r = await h.request('/api/readiness', { cookie: h.cookie }); const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.contractVersion, 2);
  assert.equal(d.runtimeReady, true); assert.equal(d.maintenanceReady, true);
  assert.equal(d.acceptance.paperBroker, 'not_evaluated');
  assert.equal(d.acceptance.smtpReceipt, 'not_evaluated');
  assert.equal(d.acceptance.deployed, 'not_evaluated');
  assert.equal(d.releaseReady, false);
});
