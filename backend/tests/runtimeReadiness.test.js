const test = require('node:test');
const assert = require('node:assert/strict');
const { getRuntimeReadiness } = require('../services/runtimeReadiness');
const { createExecutionReadiness } = require('../services/executionReadiness');
const ownerId = '000000000000000000000001';
function fixture() {
  const env = { NODE_ENV: 'production', OWNER_USER_ID: ownerId, JWT_SECRET: 'synthetic',
    ALPACA_EXPECTED_PAPER_ACCOUNT_ID: 'synthetic-account', APCA_API_KEY_ID: 'synthetic', APCA_API_SECRET_KEY: 'synthetic',
    APCA_BASE_URL: 'https://paper-api.alpaca.markets', ROBO_SCHEDULER_DISABLED: 'true' };
  const state = { owner: { _id: ownerId, username: 'owner', sessionVersion: 0 },
    settings: [{ userId: new (require('mongoose').Types.ObjectId)(ownerId), mode: 'paper', enabled: false, isEnabled: false, liveTradingExplicitlyEnabled: false }] };
  const connection = { readyState: 1, db: { collection(name) { return {
    async findOne(filter, options) { assert.equal(name, 'users'); assert.equal(String(filter._id), ownerId); assert.equal(options.projection.hash, undefined); return state.owner; },
    find() { assert.equal(name, 'robosettings'); return { limit(n) { assert.equal(n, 2); return { async toArray() { return state.settings; } }; } }; }
  }; } } };
  return { env, state, connection };
}
async function ready() { const persistence = createExecutionReadiness(); await persistence.bootstrap(async () => [{ ok: true }], async () => {}); return persistence; }
test('READINESS maintenance is distinct from unverified external acceptance', async () => {
  const d = await getRuntimeReadiness({ ...fixture(), persistence: await ready() });
  assert.equal(d.runtimeReady, true); assert.equal(d.maintenanceReady, true); assert.equal(d.releaseReady, false);
  assert.deepEqual(Object.values(d.acceptance), ['not_evaluated', 'not_evaluated', 'not_evaluated']);
  assert.ok(d.warnings.includes('USER_UNIQUENESS_DEFERRED'));
  assert.equal(d.deprecated.releaseReady, 'External release approval is not evaluated by this endpoint.');
});
for (const [name, change, runtime] of [
  ['missing owner configuration', f => delete f.env.OWNER_USER_ID, false],
  ['malformed owner configuration', f => f.env.OWNER_USER_ID = 'bad', false],
  ['missing auth secret', f => delete f.env.JWT_SECRET, false],
  ['missing owner', f => f.state.owner = null, false],
  ['invalid owner session', f => f.state.owner.sessionVersion = -1, false],
  ['missing settings', f => f.state.settings = [], false],
  ['ambiguous settings', f => f.state.settings.push({ ...f.state.settings[0] }), false],
  ['wrong settings identity type', f => f.state.settings[0].userId = ownerId, false],
  ['enabled flag', f => f.state.settings[0].enabled = true, true],
  ['isEnabled flag', f => f.state.settings[0].isEnabled = true, true],
  ['missing enable flag', f => delete f.state.settings[0].enabled, true],
  ['live mode', f => f.state.settings[0].mode = 'live', true],
  ['live enablement', f => f.state.settings[0].liveTradingExplicitlyEnabled = true, true],
  ['unsuppressed scheduler', f => f.env.ROBO_SCHEDULER_DISABLED = 'false', true],
  ['live destination', f => f.env.APCA_BASE_URL = 'https://api.alpaca.markets', true],
  ['credential bearing destination', f => f.env.APCA_BASE_URL = 'https://key@paper-api.alpaca.markets', true],
  ['missing account binding', f => delete f.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID, true],
  ['malformed account binding', f => f.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID = 'bad value\n', true],
  ['missing broker credentials', f => delete f.env.APCA_API_KEY_ID, true]
]) test('READINESS rejects ' + name, async () => {
  const f = fixture(); change(f); const d = await getRuntimeReadiness({ ...f, persistence: await ready() });
  assert.equal(d.runtimeReady, runtime); assert.equal(d.maintenanceReady, false); assert.ok(d.blockers.length);
  assert.equal(d.acceptance.paperBroker, 'not_evaluated');
  assert.ok(!JSON.stringify(d).includes('synthetic-account'));
});
test('READINESS pending failed indexes and failed majority write block execution', async () => {
  const p = createExecutionReadiness(); const f = fixture();
  for (const bootstrap of [null, [async () => [{ ok: false }], async () => {}], [async () => { throw Error('index'); }, async () => {}], [async () => [{ ok: true }], async () => { throw Error('write'); }]]) {
    if (bootstrap) await p.bootstrap(...bootstrap);
    const d = await getRuntimeReadiness({ ...f, persistence: p }); assert.equal(d.runtimeReady, false); assert.equal(d.maintenanceReady, false);
    assert.throws(() => p.assertReady(), { code: 'EXECUTION_NOT_READY' });
  }
});
test('READINESS late bootstrap cannot override invalidation', async () => {
  const p = createExecutionReadiness(); let release;
  const pending = p.bootstrap(() => new Promise(r => release = r), async () => {});
  p.invalidate(); release([{ ok: true }]); await pending;
  assert.equal((await getRuntimeReadiness({ ...fixture(), persistence: p })).runtimeReady, false);
});
test('READINESS disconnect and changes during bounded reads fail closed', async () => {
  const f = fixture(); const p = await ready(); f.connection.readyState = 0;
  assert.equal((await getRuntimeReadiness({ ...f, persistence: p })).runtimeReady, false);
  f.connection.readyState = 1;
  const original = f.connection.db.collection;
  f.connection.db.collection = name => { const c = original(name); if (name === 'users') c.findOne = async () => { p.invalidate(); return f.state.owner; }; return c; };
  assert.equal((await getRuntimeReadiness({ ...f, persistence: p })).runtimeReady, false);
});
test('READINESS read failure is sanitized and cannot yield readiness', async () => {
  const f = fixture(); f.connection.db.collection = () => { throw Error('mongodb://secret'); };
  const d = await getRuntimeReadiness({ ...f, persistence: await ready() });
  assert.equal(d.runtimeReady, false); assert.ok(!JSON.stringify(d).includes('mongodb'));
});
