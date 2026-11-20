'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const contracts = require('../../guest/contracts.cjs');
const receiptApi = require('../../guest/receipts.cjs');
const sessionApi = require('../../guest/session.cjs');
const vectors = require('../../contracts/vectors.json');
// Task 16 (T13 I-8): observeViews and loginOnce accept only branded BrowserSessions.
const { scriptedSession } = require('./browser.test.cjs');

const RECEIPT_KINDS = Object.freeze(['RELEASE_RECEIPT', 'RESTART_RECEIPT', 'LEDGER_RECEIPT', 'MAINTENANCE_RECEIPT', 'DB_RECEIPT']);
const CHECKS = Object.freeze([
  'ownerConfiguration', 'authenticationConfiguration', 'databaseConnected', 'ownerIdentity',
  'ownerSettings', 'persistence', 'paperMode', 'automationDisabled', 'schedulerSuppressed',
  'paperDestination', 'paperBindingConfiguration', 'paperCredentialConfiguration',
]);
const RUN = '1'.repeat(32);
const CONFIG = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

function api() { return require('../../guest/observation.cjs'); }
function clone(value) { return structuredClone(value); }
function accepted(kind) { return JSON.parse(vectors.accepted.find(row => row.kind === kind).json); }
function bindings(frame) {
  const value = clone(frame);
  for (const key of ['issuedAt', 'expiresAt', 'keyId', 'signature']) delete value.payload[key];
  return value;
}

function receiptFixture(options = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = crypto.createHash('sha256').update(raw).digest('hex');
  const frames = Object.fromEntries(RECEIPT_KINDS.map(kind => [kind, accepted(kind)]));
  if (options.interval) frames.DB_RECEIPT.payload.interval = options.interval;
  let now = 160;
  function sign(kind) {
    const frame = clone(frames[kind]);
    frame.payload.keyId = keyId;
    frame.payload.signature = '0'.repeat(128);
    const decoded = contracts.decodeFrame(Buffer.from(JSON.stringify(frame)), kind);
    frame.payload.signature = crypto.sign(null, contracts.receiptSigningBytes(decoded), pair.privateKey).toString('hex');
    return Buffer.from(JSON.stringify(frame));
  }
  const trust = receiptApi.createTrustContext({
    publicKeys: Object.fromEntries(RECEIPT_KINDS.map(kind => [kind, raw.toString('hex')])),
    expected: Object.fromEntries(RECEIPT_KINDS.map(kind => [kind, bindings(frames[kind])])),
    now: () => now,
    maxAgeMs: 100,
    deadline: 200,
  });
  return {
    trust,
    maintenanceReceipt: receiptApi.verifyReceipt(sign('MAINTENANCE_RECEIPT'), 'MAINTENANCE_RECEIPT', trust),
    databaseReceipt: receiptApi.verifyReceipt(sign('DB_RECEIPT'), 'DB_RECEIPT', trust),
    setNow(value) { now = value; },
  };
}

function readiness(overrides = {}) {
  return {
    contractVersion: 2,
    profile: 'owner-paper-maintenance',
    runtimeReady: true,
    maintenanceReady: true,
    checks: Object.fromEntries(CHECKS.map(name => [name, { status: 'pass' }])),
    automation: { enabled: false, isEnabled: false, liveEnabled: false, schedulerSuppressed: true, activationAuthorized: false },
    ...overrides,
  };
}

// A real BrowserSession (real controller, adopted role port and application pipe) whose
// worker side is scripted. The scripted worker echoes each view action's view and phase and
// reports a clean view; `viewOverrides[view]` replaces fields of that worker RESULT. The
// controller itself adds runId and configIdentity from its run binding, `hooks.binding`.
async function browser(viewOverrides = {}, hooks = {}) {
  const binding = hooks.binding || { runId: RUN, configIdentity: CONFIG };
  const scripted = await scriptedSession({ runId: binding.runId, configIdentity: binding.configIdentity, hooks: {
    fingerprint: (action, payload) => typeof hooks.fingerprint === 'function' ? hooks.fingerprint(action, payload) : FINGERPRINT,
    view: view => viewOverrides[view] || {},
    onView: view => hooks.onView?.(view),
  } });
  return { handle: scripted.session, get calls() { return scripted.actions(); } };
}

async function privateSession(browserSession) {
  const bytes = Buffer.from('synthetic-password');
  return sessionApi.loginOnce(browserSession, Object.freeze({ async consumeOnce() { return bytes; }, destroy() {} }), {
    id: 'owner-id', username: 'synthetic-owner',
  });
}

function maintenanceProof(phase = 'OBSERVE_BEFORE_RESTART') {
  const interval = phase === 'OBSERVE_AFTER_RESTART' ? 'AFTER' : 'BEFORE';
  const { trust, maintenanceReceipt, databaseReceipt } = receiptFixture({ interval });
  return api().validateMaintenance({ trust, maintenanceReceipt, databaseReceipt, phase });
}

async function observationFixture(viewOverrides = {}, phase = 'OBSERVE_BEFORE_RESTART') {
  const b = await browser(viewOverrides);
  return {
    b,
    evidence: {
      privateSession: await privateSession(b.handle),
      readiness: api().validateReadiness(readiness()),
      maintenance: maintenanceProof(phase),
    },
    phase,
  };
}

test('exact12_checks_pass_only', () => {
  const proof = api().validateReadiness(readiness());
  assert.throws(() => JSON.stringify(proof), { code: 'PRIVATE_HANDLE' });
  for (const name of CHECKS) {
    const body = readiness(); body.checks[name].status = 'fail';
    assert.throws(() => api().validateReadiness(body), { code: 'READINESS_FAILED' }, name);
  }
});

test('contract2_profile_owner_paper_maintenance_runtime_and_maintenance_true', () => {
  for (const body of [readiness({ contractVersion: 1 }), readiness({ profile: 'owner-paper' }), readiness({ runtimeReady: false }), readiness({ maintenanceReady: false })]) {
    assert.throws(() => api().validateReadiness(body), { code: 'READINESS_FAILED' });
  }
});

test('automation_flags_exact', () => {
  for (const key of Object.keys(readiness().automation)) {
    const body = readiness(); body.automation[key] = !body.automation[key];
    assert.throws(() => api().validateReadiness(body), { code: 'READINESS_FAILED' }, key);
  }
});

test('missing_unknown_check_fail', () => {
  const missing = readiness(); delete missing.checks.ownerIdentity;
  const unknown = readiness(); unknown.checks.releaseReady = { status: 'pass' };
  assert.throws(() => api().validateReadiness(missing), { code: 'READINESS_FAILED' });
  assert.throws(() => api().validateReadiness(unknown), { code: 'READINESS_FAILED' });
});

test('readiness_not_lease', async () => {
  const b = await browser(), privateHandle = await privateSession(b.handle);
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', {
    privateSession: privateHandle, readiness: api().validateReadiness(readiness()), maintenance: api().validateReadiness(readiness()),
  }), { code: 'READINESS_FAILED' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('absent_duplicate_settings_abort_before_GET', async () => {
  const b = await browser(), privateHandle = await privateSession(b.handle), fixture = receiptFixture();
  assert.throws(() => api().validateMaintenance({ ...fixture, databaseReceipt: { ...fixture.databaseReceipt }, phase: 'OBSERVE_BEFORE_RESTART' }), { code: 'READINESS_FAILED' });
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', {
    privateSession: privateHandle, readiness: api().validateReadiness(readiness()), maintenance: {},
  }), { code: 'READINESS_FAILED' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('wrong_adapter_brokerError_source_fail', async () => {
  for (const overrides of [{ PORTFOLIO: { source: 'local-simulation' } }, { ROBO: { brokerError: true } }, { ACTIVITY: { source: 'unknown' } }]) {
    const fixture = await observationFixture(overrides);
    await assert.rejects(api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence), { code: 'OBSERVATION_FAILED' });
  }
});

test('DB_difference_or_incomplete_scope_fail', () => {
  const fixture = receiptFixture();
  assert.throws(() => api().validateMaintenance({ ...fixture, databaseReceipt: Object.freeze({ kind: 'DB_RECEIPT' }), phase: 'OBSERVE_BEFORE_RESTART' }), { code: 'READINESS_FAILED' });
  const other = receiptFixture();
  assert.throws(() => api().validateMaintenance({ trust: fixture.trust, maintenanceReceipt: fixture.maintenanceReceipt, databaseReceipt: other.databaseReceipt, phase: 'OBSERVE_BEFORE_RESTART' }), { code: 'READINESS_FAILED' });
});

test('Robo7_Portfolio2_Activity3_valid_render', async () => {
  const fixture = await observationFixture();
  const result = await api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence);
  assert.deepEqual(Object.fromEntries(Object.entries(result.views).map(([name, value]) => [name, value.routeCount])), { ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 });
  assert.equal(result.views.ROBO.renderedData, true);
  assert.equal(result.views.ACTIVITY.noError, true);
  assert.deepEqual(fixture.b.calls.filter(call => call.action === 'OBSERVE_VIEW').map(call => call.payload.view), ['ROBO', 'PORTFOLIO', 'ACTIVITY']);
  assert.equal(fixture.b.calls.filter(call => call.action === 'SESSION_OBSERVATION').length, 1);
});

test('empty_arrays_only_with_valid_schema_and_empty_UI', async () => {
  const empty = Object.fromEntries(['ROBO', 'PORTFOLIO', 'ACTIVITY'].map(view => [view, { renderedData: false, validEmptyState: true, renderedCount: 0 }]));
  const fixture = await observationFixture(empty);
  const result = await api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence);
  assert.equal(Object.values(result.views).every(value => value.validEmptyState && value.renderedCount === 0), true);
  const invalid = await observationFixture({ ROBO: { renderedData: false, validEmptyState: false, renderedCount: 0 } });
  await assert.rejects(api().observeViews(invalid.b.handle, 'OBSERVE_BEFORE_RESTART', invalid.evidence), { code: 'OBSERVATION_FAILED' });
});

test('loading_error_disconnect_not_empty', async () => {
  for (const change of [{ noError: false }, { fresh: false }, { schemaValidation: false }]) {
    const fixture = await observationFixture({ ACTIVITY: change });
    await assert.rejects(api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence), { code: 'OBSERVATION_FAILED' });
  }
});

test('balances_symbols_never_public', async () => {
  const fixture = await observationFixture();
  const result = await api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence);
  const serialized = JSON.stringify(result);
  for (const secret of ['owner-id', 'synthetic-owner', 'synthetic-password', 'AAPL', '100000.00']) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(Object.keys(result).sort(), ['maintenance', 'phase', 'readiness', 'views']);
});

test('readiness_and_maintenance_proofs_are_phase_bound_one_use', async () => {
  const fixture = await observationFixture();
  await api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence);
  await assert.rejects(api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence), { code: 'REPLAY' });
});

test('postrestart_schedule_observes_only_robo_without_reload', async () => {
  const fixture = await observationFixture({
    ROBO: { phase: 'OBSERVE_AFTER_RESTART' },
  }, 'OBSERVE_AFTER_RESTART');
  const result = await api().observeViews(fixture.b.handle, fixture.phase, fixture.evidence);
  assert.deepEqual(Object.keys(result.views), ['ROBO']);
  assert.deepEqual(fixture.b.calls.filter(call => call.action === 'OBSERVE_VIEW').map(call => call.payload.view), ['ROBO']);
  assert.equal(fixture.b.calls.filter(call => call.action === 'SESSION_OBSERVATION').length, 1);
});

test('expired_receipts_are_revalidated_at_observation_and_cannot_be_reminted', async () => {
  const b = await browser(), fixture = receiptFixture();
  const evidence = {
    privateSession: await privateSession(b.handle),
    readiness: api().validateReadiness(readiness()),
    maintenance: api().validateMaintenance({ trust: fixture.trust, maintenanceReceipt: fixture.maintenanceReceipt,
      databaseReceipt: fixture.databaseReceipt, phase: 'OBSERVE_BEFORE_RESTART' }),
  };
  fixture.setNow(201);
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'READINESS_FAILED' });
  assert.throws(() => api().validateMaintenance({ trust: fixture.trust, maintenanceReceipt: fixture.maintenanceReceipt,
    databaseReceipt: fixture.databaseReceipt, phase: 'OBSERVE_BEFORE_RESTART' }), { code: 'REPLAY' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('view_result_must_match_receipt_run_and_config', async () => {
  // Task 16: view results now come only from branded BrowserSessions, and the controller stamps
  // each with its own run binding. A session of another run or config is therefore refused
  // by the binding check, before any view is read.
  for (const binding of [{ runId: '2'.repeat(32), configIdentity: CONFIG }, { runId: RUN, configIdentity: 'b'.repeat(64) }]) {
    const b = await browser({}, { binding });
    const evidence = { privateSession: await privateSession(b.handle), readiness: api().validateReadiness(readiness()), maintenance: maintenanceProof() };
    await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'IDENTITY_MISMATCH' }, JSON.stringify(binding));
    assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
  }
});

test('session_binding_mismatch_fails_before_any_view_read', async () => {
  const b = await browser({}, { binding: { runId: '2'.repeat(32), configIdentity: CONFIG } });
  const evidence = {
    privateSession: await privateSession(b.handle),
    readiness: api().validateReadiness(readiness()),
    maintenance: maintenanceProof(),
  };
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'IDENTITY_MISMATCH' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('maintenance_expiry_between_views_stops_before_the_next_view', async () => {
  const fixture = receiptFixture(),b = await browser({}, { onView(view) { if (view === 'ROBO') fixture.setNow(201); } });
  const evidence = {
    privateSession: await privateSession(b.handle),
    readiness: api().validateReadiness(readiness()),
    maintenance: api().validateMaintenance({ trust: fixture.trust, maintenanceReceipt: fixture.maintenanceReceipt,
      databaseReceipt: fixture.databaseReceipt, phase: 'OBSERVE_BEFORE_RESTART' }),
  };
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'READINESS_FAILED' });
  assert.deepEqual(b.calls.filter(call => call.action === 'OBSERVE_VIEW').map(call => call.payload.view), ['ROBO']);
});

test('private_session_change_fails_before_any_view_read', async () => {
  let fingerprint=FINGERPRINT;const b=await browser({}, { fingerprint:()=>fingerprint });
  const privateHandle=await privateSession(b.handle);fingerprint='c'.repeat(64);
  const evidence={privateSession:privateHandle,readiness:api().validateReadiness(readiness()),maintenance:maintenanceProof()};
  await assert.rejects(api().observeViews(b.handle,'OBSERVE_BEFORE_RESTART',evidence),{code:'SESSION_MISMATCH'});
  assert.equal(b.calls.some(call=>call.action==='OBSERVE_VIEW'),false);
});

// ---- Task 16: branded BrowserSessions (T13 I-8) and the observation-layer continuity check (I-10 M21) ----

test('session_and_observation_require_branded_browser_session', async () => {
  // T13 I-8: an object with the BrowserSession methods is not a BrowserSession.
  const calls = [], results = new WeakMap();
  const result = value => { const handle = Object.freeze({}); results.set(handle, Object.freeze(value)); return handle; };
  const forged = Object.freeze({
    assertBinding() { return true; },
    failureCode() { return null; },
    async perform(action, payload, onFilled) {
      calls.push(action);
      if (action === 'LOGIN_SESSION') { onFilled(); return result({ kind: 'SESSION_BOUND', fingerprint: FINGERPRINT }); }
      if (action === 'SESSION_OBSERVATION') return result({ kind: 'SESSION_OBSERVED', fingerprint: FINGERPRINT });
      return result({ kind: 'VIEW_OBSERVED', view: payload.view, phase: payload.phase, schemaValidation: true, renderedData: true,
        validEmptyState: false, noError: true, fresh: true, source: 'alpaca-paper', brokerError: false,
        routeCount: { ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 }[payload.view], renderedCount: 1, runId: RUN, configIdentity: CONFIG,
        fingerprint: FINGERPRINT, readinessValidation: payload.view === 'ROBO' });
    },
    inspectResult(value) { return results.get(value); },
  });
  let consumed = 0, destroyed = 0;
  await assert.rejects(sessionApi.loginOnce(forged, Object.freeze({ async consumeOnce() { consumed++; return Buffer.from('synthetic-password'); },
    destroy() { destroyed++; } }), { id: 'owner-id', username: 'synthetic-owner' }), { code: 'SESSION_INVALID' });
  assert.deepEqual([consumed, destroyed], [0, 0]);
  // observeViews refuses the forged session before any action and before using the evidence.
  const fixture = await observationFixture();
  await assert.rejects(api().observeViews(forged, 'OBSERVE_BEFORE_RESTART', fixture.evidence), { code: 'OBSERVATION_FAILED' });
  assert.deepEqual(calls, []);
  // Control: the same, unspent evidence with the real session.
  const observed = await api().observeViews(fixture.b.handle, 'OBSERVE_BEFORE_RESTART', fixture.evidence);
  assert.deepEqual(Object.keys(observed.views), ['ROBO', 'PORTFOLIO', 'ACTIVITY']);
});

test('observation_layer_continuity_bound', async () => {
  // I-10 M21: the observation layer checks each view result against the private session itself,
  // independently of the worker's own check. One changed view fingerprint stops the run there.
  const b = await browser({}, { fingerprint: (action, payload) => action === 'OBSERVE_VIEW' && payload.view === 'PORTFOLIO' ? 'c'.repeat(64) : FINGERPRINT });
  const evidence = { privateSession: await privateSession(b.handle), readiness: api().validateReadiness(readiness()), maintenance: maintenanceProof() };
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'SESSION_MISMATCH' });
  assert.deepEqual(b.calls.filter(call => call.action === 'OBSERVE_VIEW').map(call => call.payload.view), ['ROBO', 'PORTFOLIO']);
});
