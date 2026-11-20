'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const contracts = require('../../guest/contracts.cjs');
const receiptApi = require('../../guest/receipts.cjs');
const sessionApi = require('../../guest/session.cjs');
const vectors = require('../../contracts/vectors.json');
// Task 16 (T13 I-8): observeViews and loginOnce accept only branded BrowserSessions.
// Task 17: readiness comes from the worker (SESSION_READINESS), so the harness also supplies the
// real-worker session and the readiness body the synthetic backend serves.
const { scriptedSession, startHarness, closeHarness, login, readinessBody } = require('./browser.test.cjs');

const RECEIPT_KINDS = Object.freeze(['RELEASE_RECEIPT', 'RESTART_RECEIPT', 'LEDGER_RECEIPT', 'MAINTENANCE_RECEIPT', 'DB_RECEIPT']);
const CHECKS = Object.freeze([
  'ownerConfiguration', 'authenticationConfiguration', 'databaseConnected', 'ownerIdentity',
  'ownerSettings', 'persistence', 'paperMode', 'automationDisabled', 'schedulerSuppressed',
  'paperDestination', 'paperBindingConfiguration', 'paperCredentialConfiguration',
]);
const RUN = '1'.repeat(32);
const CONFIG = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const B = 'OBSERVE_BEFORE_RESTART', C = 'OBSERVE_AFTER_RESTART';
const ROOT = path.resolve(__dirname, '../..');

function api() { return require('../../guest/observation.cjs'); }
function clone(value) { return structuredClone(value); }
function accepted(kind) { return JSON.parse(vectors.accepted.find(row => row.kind === kind).json); }
function bindings(frame) {
  const value = clone(frame);
  for (const key of ['issuedAt', 'expiresAt', 'keyId', 'signature']) delete value.payload[key];
  return value;
}

// An unrelated receipt authority (its own key and run): never bound to any BrowserSession's release.
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
    error: hooks.error, ownerDigest: hooks.ownerDigest, readiness: hooks.readiness,
  } });
  return { handle: scripted.session, routeFixture: scripted.routeFixture, get calls() { return scripted.actions(); } };
}

async function privateSession(browserSession) {
  const bytes = Buffer.from('synthetic-password');
  return sessionApi.loginOnce(browserSession, Object.freeze({ async consumeOnce() { return bytes; }, destroy() {} }), {
    id: 'owner-id', username: 'synthetic-owner',
  });
}

// T13 m-9: maintenance and DB receipts verified under the BrowserSession's own release trust (B),
// or under a post-restart trust context for the same release and pinned keys (C).
function sessionReceipts(b, phase = B) {
  const f = b.routeFixture;
  if (phase === B) return { maintenanceReceipt: f.maintenance,
    databaseReceipt: receiptApi.verifyReceipt(f.sign(f.frames.DB_RECEIPT), 'DB_RECEIPT', f.trust) };
  const expected = clone(f.options.expected);
  expected.MAINTENANCE_RECEIPT.sequence = 2; expected.DB_RECEIPT.payload.interval = 'AFTER';
  const post = receiptApi.createTrustContext({ ...f.options, expected });
  const maintenance = clone(f.frames.MAINTENANCE_RECEIPT); maintenance.sequence = 2;
  const database = clone(f.frames.DB_RECEIPT); database.payload.interval = 'AFTER';
  return { maintenanceReceipt: receiptApi.verifyReceipt(f.sign(maintenance), 'MAINTENANCE_RECEIPT', post),
    databaseReceipt: receiptApi.verifyReceipt(f.sign(database), 'DB_RECEIPT', post) };
}
// Steps that must succeed; at RED each fails as a named assertion rather than a thrown setup error.
function attempt(step, message) { let value; assert.doesNotThrow(() => { value = step(); }, message); return value; }
async function settles(promise, message) { let value; await assert.doesNotReject(async () => { value = await promise; }, message); return value; }
function maintenanceProof(b, phase = B) {
  const receipts = sessionReceipts(b, phase);
  return attempt(() => api().validateMaintenance(b.handle, { ...receipts, phase }), 'validateMaintenance(session, evidence) under the session release trust (T13 m-9)');
}

async function observationFixture(viewOverrides = {}, phase = B, hooks = {}) {
  const b = await browser(viewOverrides, hooks);
  return {
    b,
    evidence: {
      privateSession: await privateSession(b.handle),
      maintenance: maintenanceProof(b, phase),
      sequence: 1,
    },
    phase,
  };
}
// A completed BEFORE observation, then the AFTER evidence for the same session.
async function beforeThenAfter(viewOverrides = {}, hooks = {}) {
  const fixture = await observationFixture(viewOverrides, B, hooks);
  await api().observeViews(fixture.b.handle, B, fixture.evidence);
  return { ...fixture, after: { privateSession: fixture.evidence.privateSession, maintenance: maintenanceProof(fixture.b, C), sequence: 2 } };
}
const views = calls => calls.filter(call => call.action === 'OBSERVE_VIEW').map(call => call.payload.view);

// ---- readinessPredicate: the single copy of the 12 checks (T13 I-4) ----

test('exact12_checks_pass_only', () => {
  assert.equal(typeof api().readinessPredicate, 'function', 'readinessPredicate export');
  assert.equal(api().readinessPredicate(readinessBody()), true);
  for (const name of CHECKS) {
    const body = readinessBody(); body.checks[name].status = 'fail';
    assert.equal(api().readinessPredicate(body), false, name);
  }
});

test('contract2_profile_owner_paper_maintenance_runtime_and_maintenance_true', () => {
  assert.equal(typeof api().readinessPredicate, 'function', 'readinessPredicate export');
  for (const body of [readinessBody({ contractVersion: 1 }), readinessBody({ profile: 'owner-paper' }), readinessBody({ runtimeReady: false }), readinessBody({ maintenanceReady: false })]) {
    assert.equal(api().readinessPredicate(body), false);
  }
});

test('automation_flags_exact', () => {
  assert.equal(typeof api().readinessPredicate, 'function', 'readinessPredicate export');
  for (const key of Object.keys(readinessBody().automation)) {
    const body = readinessBody(); body.automation[key] = !body.automation[key];
    assert.equal(api().readinessPredicate(body), false, key);
  }
});

test('missing_unknown_check_fail', () => {
  assert.equal(typeof api().readinessPredicate, 'function', 'readinessPredicate export');
  const missing = readinessBody(); delete missing.checks.ownerIdentity;
  const unknown = readinessBody(); unknown.checks.releaseReady = { status: 'pass' };
  for (const body of [missing, unknown, null, [], 'ready', readinessBody({ checks: [] }), readinessBody({ automation: null })])
    assert.equal(api().readinessPredicate(body), false, JSON.stringify(body));
});

test('readiness_predicate_is_the_single_copy_and_worker_loads_no_controller_module', () => {
  // P20 / X19: the worker requires observation.cjs for the predicate only; requiring it loads no
  // controller module (session.cjs, browser.cjs), and the worker keeps no second copy of the checks.
  const worker = fs.readFileSync(path.join(ROOT, 'guest/browser-worker.cjs'), 'utf8');
  assert.match(worker, /require\('\.\/observation\.cjs'\)/);
  for (const copy of ['validReadiness', 'READINESS_CHECKS', 'ownerConfiguration', 'activationAuthorized']) assert.equal(worker.includes(copy), false, copy);
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e',
    'require(process.argv[1]);process.stdout.write(JSON.stringify(Object.keys(require.cache).map(name=>require("path").basename(name))))',
    path.join(ROOT, 'guest/observation.cjs')], { encoding: 'utf8' }));
  assert.equal(loaded.includes('observation.cjs'), true);
  for (const controller of ['session.cjs', 'browser.cjs', 'budget.cjs', 'route-policy.cjs']) assert.equal(loaded.includes(controller), false, controller);
});

// ---- observeViews ----

test('readiness_not_lease', async () => {
  // A readiness gate cannot stand in for the maintenance proof.
  const donor = await browser(); await privateSession(donor.handle);
  await settles(donor.handle.perform('SESSION_READINESS', { phase: B, sequence: 1 }), 'SESSION_READINESS resolves (C9)');
  const b = await browser(), privateHandle = await privateSession(b.handle);
  for (const maintenance of [donor.handle.currentGates().readiness, donor.handle.currentGates().owner]) {
    await assert.rejects(api().observeViews(b.handle, B, { privateSession: privateHandle, maintenance, sequence: 1 }), { code: 'READINESS_FAILED' });
  }
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW' || call.action === 'SESSION_READINESS'), false);
});

test('absent_duplicate_settings_abort_before_GET', async () => {
  const b = await browser(), privateHandle = await privateSession(b.handle), own = sessionReceipts(b);
  assert.throws(() => api().validateMaintenance(b.handle, { ...own, databaseReceipt: { ...own.databaseReceipt }, phase: B }), { code: 'READINESS_FAILED' });
  await assert.rejects(api().observeViews(b.handle, B, { privateSession: privateHandle, maintenance: {}, sequence: 1 }), { code: 'READINESS_FAILED' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW' || call.action === 'SESSION_READINESS'), false);
});

test('wrong_adapter_brokerError_source_fail', async () => {
  for (const overrides of [{ PORTFOLIO: { source: 'local-simulation' } }, { ROBO: { brokerError: true } }, { ACTIVITY: { source: 'unknown' } },
    { PORTFOLIO: { source: null } }, { ACTIVITY: { brokerError: null } }]) {
    const fixture = await observationFixture(overrides);
    await assert.rejects(api().observeViews(fixture.b.handle, B, fixture.evidence), { code: 'OBSERVATION_FAILED' }, JSON.stringify(overrides));
  }
});

test('DB_difference_or_incomplete_scope_fail', async () => {
  const b = await browser(), own = sessionReceipts(b);
  assert.throws(() => api().validateMaintenance(b.handle, { ...own, databaseReceipt: Object.freeze({ kind: 'DB_RECEIPT' }), phase: B }), { code: 'READINESS_FAILED' });
  const other = receiptFixture();
  assert.throws(() => api().validateMaintenance(b.handle, { maintenanceReceipt: own.maintenanceReceipt, databaseReceipt: other.databaseReceipt, phase: B }), { code: 'READINESS_FAILED' });
});

test('Robo7_Portfolio2_Activity3_valid_render', async () => {
  const fixture = await observationFixture();
  const result = await api().observeViews(fixture.b.handle, B, fixture.evidence);
  assert.deepEqual(Object.fromEntries(Object.entries(result.views).map(([name, value]) => [name, value.routeCount])), { ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 });
  assert.equal(result.views.ROBO.renderedData, true);
  assert.equal(result.views.ACTIVITY.noError, true);
  assert.deepEqual(views(fixture.b.calls), ['ROBO', 'PORTFOLIO', 'ACTIVITY']);
  assert.equal(fixture.b.calls.filter(call => call.action === 'SESSION_OBSERVATION').length, 1);
  assert.equal(fixture.b.calls.filter(call => call.action === 'SESSION_READINESS').length, 1);
});

test('empty_arrays_only_with_valid_schema_and_empty_UI', async () => {
  const empty = Object.fromEntries(['ROBO', 'PORTFOLIO', 'ACTIVITY'].map(view => [view, { renderedData: false, validEmptyState: true, renderedCount: 0 }]));
  const fixture = await observationFixture(empty);
  const result = await api().observeViews(fixture.b.handle, B, fixture.evidence);
  assert.equal(Object.values(result.views).every(value => value.validEmptyState && value.renderedCount === 0), true);
  const invalid = await observationFixture({ ROBO: { renderedData: false, validEmptyState: false, renderedCount: 0 } });
  await assert.rejects(api().observeViews(invalid.b.handle, B, invalid.evidence), { code: 'OBSERVATION_FAILED' });
});

test('loading_error_disconnect_not_empty', async () => {
  // Task 17: `fresh` is no longer a result field (T13 I-9); a view without PAPER-health facts
  // (`brokerError: null`) replaces that case.
  for (const change of [{ noError: false }, { brokerError: null }, { schemaValidation: false }]) {
    const fixture = await observationFixture({ ACTIVITY: change });
    await assert.rejects(api().observeViews(fixture.b.handle, B, fixture.evidence), { code: 'OBSERVATION_FAILED' }, JSON.stringify(change));
  }
});

test('balances_symbols_never_public', async () => {
  const fixture = await observationFixture();
  const result = await api().observeViews(fixture.b.handle, B, fixture.evidence);
  const serialized = JSON.stringify(result);
  for (const secret of ['owner-id', 'synthetic-owner', 'synthetic-password', 'AAPL', '100000.00', 'd'.repeat(64), 'e'.repeat(64)]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(Object.keys(result).sort(), ['maintenance', 'phase', 'readiness', 'views']);
});

test('readiness_and_maintenance_proofs_are_phase_bound_one_use', async () => {
  const fixture = await observationFixture();
  await api().observeViews(fixture.b.handle, B, fixture.evidence);
  await assert.rejects(api().observeViews(fixture.b.handle, B, fixture.evidence), { code: 'REPLAY' });
  // A maintenance proof of one phase does not serve the other.
  const other = await observationFixture();
  await assert.rejects(api().observeViews(other.b.handle, C, { ...other.evidence, sequence: 2 }), { code: 'READINESS_FAILED' });
});

test('postrestart_schedule_observes_only_robo_without_reload', async () => {
  // Task 17: the scripted worker echoes each phase, so no ROBO phase override is needed.
  const fixture = await beforeThenAfter();
  const before = fixture.b.calls.length;
  const result = await api().observeViews(fixture.b.handle, C, fixture.after);
  assert.deepEqual(Object.keys(result.views), ['ROBO']);
  assert.deepEqual(fixture.b.calls.slice(before).map(call => call.action === 'OBSERVE_VIEW' ? call.payload.view : call.action),
    ['SESSION_READINESS', 'SESSION_OBSERVATION', 'ROBO']);
  assert.deepEqual(fixture.b.calls[before].payload, { phase: C, sequence: 2 });
});

test('expired_receipts_are_revalidated_at_observation_and_cannot_be_reminted', async () => {
  const b = await browser(), own = sessionReceipts(b);
  const evidence = { privateSession: await privateSession(b.handle), maintenance: attempt(() => api().validateMaintenance(b.handle, { ...own, phase: B }), 'validateMaintenance(session, evidence) (T13 m-9)'), sequence: 1 };
  b.routeFixture.time.wallMs = 201;
  await assert.rejects(api().observeViews(b.handle, B, evidence), { code: 'READINESS_FAILED' });
  assert.throws(() => api().validateMaintenance(b.handle, { ...own, phase: B }), { code: 'REPLAY' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW' || call.action === 'SESSION_READINESS'), false);
});

test('view_result_must_match_receipt_run_and_config', async () => {
  // Task 17 (m-9): maintenance is bound to the session's own release trust, so receipts of another
  // run or config (another release) are refused before any action, at validateMaintenance.
  const foreign = receiptFixture();
  for (const binding of [{ runId: '2'.repeat(32), configIdentity: CONFIG }, { runId: RUN, configIdentity: 'b'.repeat(64) }]) {
    const b = await browser({}, { binding });
    assert.throws(() => api().validateMaintenance(b.handle, { maintenanceReceipt: foreign.maintenanceReceipt, databaseReceipt: foreign.databaseReceipt, phase: B }),
      { code: 'READINESS_FAILED' }, JSON.stringify(binding));
    assert.equal(b.calls.length, 0);
  }
});

test('session_binding_mismatch_fails_before_any_view_read', async () => {
  // A maintenance proof is bound to the session it was validated for; another session cannot use it.
  const owner = await browser(), b = await browser({}, { binding: { runId: '2'.repeat(32), configIdentity: CONFIG } });
  const evidence = { privateSession: await privateSession(b.handle), maintenance: maintenanceProof(owner), sequence: 1 };
  await assert.rejects(api().observeViews(b.handle, B, evidence), { code: 'READINESS_FAILED' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW' || call.action === 'SESSION_READINESS'), false);
});

test('maintenance_expiry_between_views_stops_before_the_next_view', async () => {
  let routeFixture;
  const b = await browser({}, { onView(view) { if (view === 'ROBO') routeFixture.time.wallMs = 201; } });
  routeFixture = b.routeFixture;
  const evidence = { privateSession: await privateSession(b.handle), maintenance: maintenanceProof(b), sequence: 1 };
  await assert.rejects(api().observeViews(b.handle, B, evidence), { code: 'READINESS_FAILED' });
  assert.deepEqual(views(b.calls), ['ROBO']);
});

test('private_session_change_fails_before_any_view_read', async () => {
  let fingerprint=FINGERPRINT;const b=await browser({}, { fingerprint:()=>fingerprint });
  const privateHandle=await privateSession(b.handle);fingerprint='c'.repeat(64);
  const evidence={privateSession:privateHandle,maintenance:maintenanceProof(b),sequence:1};
  await assert.rejects(api().observeViews(b.handle,B,evidence),{code:'SESSION_MISMATCH'});
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
    currentGates() { return null; },
    async perform(action, payload, onFilled) {
      calls.push(action);
      if (action === 'LOGIN_SESSION') { onFilled(); return result({ kind: 'SESSION_BOUND', fingerprint: FINGERPRINT }); }
      if (action === 'SESSION_OBSERVATION') return result({ kind: 'SESSION_OBSERVED', fingerprint: FINGERPRINT });
      return result({ kind: 'VIEW_OBSERVED', view: payload.view, phase: payload.phase, sequence: 1, schemaValidation: true, renderedData: true,
        validEmptyState: false, noError: true, source: 'alpaca-paper', brokerError: false,
        routeCount: { ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 }[payload.view], renderedCount: 1, runId: RUN, configIdentity: CONFIG,
        fingerprint: FINGERPRINT });
    },
    inspectResult(value) { return results.get(value); },
    claimResult(value) { return results.get(value); },
  });
  let consumed = 0, destroyed = 0;
  await assert.rejects(sessionApi.loginOnce(forged, Object.freeze({ async consumeOnce() { consumed++; return Buffer.from('synthetic-password'); },
    destroy() { destroyed++; } }), { id: 'owner-id', username: 'synthetic-owner' }), { code: 'SESSION_INVALID' });
  assert.deepEqual([consumed, destroyed], [0, 0]);
  // observeViews (and validateMaintenance) refuse the forged session before any action and before using the evidence.
  const fixture = await observationFixture(), unspent = sessionReceipts(await browser());
  await assert.rejects(api().observeViews(forged, B, fixture.evidence), { code: 'OBSERVATION_FAILED' });
  assert.throws(() => api().validateMaintenance(forged, { ...unspent, phase: B }), { code: 'READINESS_FAILED' });
  assert.deepEqual(calls, []);
  // Control: the same, unspent evidence with the real session.
  const observed = await api().observeViews(fixture.b.handle, B, fixture.evidence);
  assert.deepEqual(Object.keys(observed.views), ['ROBO', 'PORTFOLIO', 'ACTIVITY']);
});

test('observation_layer_continuity_bound', async () => {
  // I-10 M21: the observation layer checks each view result against the private session itself,
  // independently of the worker's own check. One changed view fingerprint stops the run there.
  const b = await browser({}, { fingerprint: (action, payload) => action === 'OBSERVE_VIEW' && payload.view === 'PORTFOLIO' ? 'c'.repeat(64) : FINGERPRINT });
  const evidence = { privateSession: await privateSession(b.handle), maintenance: maintenanceProof(b), sequence: 1 };
  await assert.rejects(api().observeViews(b.handle, B, evidence), { code: 'SESSION_MISMATCH' });
  assert.deepEqual(views(b.calls), ['ROBO', 'PORTFOLIO']);
});

// ---- Task 17: readiness and owner gates from worker observations ----

test('robo_requires_worker_readiness', async () => {
  // T13 I-4 / I-5 (reviewer M12): ROBO, and every view after it, runs only after the worker's own
  // SESSION_READINESS for this phase and sequence, whose readiness and owner gates are verified.
  const fixture = await observationFixture();
  await api().observeViews(fixture.b.handle, B, fixture.evidence);
  assert.deepEqual(fixture.b.calls.map(call => call.action === 'OBSERVE_VIEW' ? call.payload.view : call.action),
    ['LOGIN_SESSION', 'SESSION_READINESS', 'SESSION_OBSERVATION', 'ROBO', 'PORTFOLIO', 'ACTIVITY']);
  assert.deepEqual(fixture.b.calls[1].payload, { phase: B, sequence: 1 });
  // A worker readiness failure stops the run before any view, with its own classification.
  for (const code of ['READINESS_FAILED', 'OWNER_MISMATCH', 'SESSION_CHANGED']) {
    const failing = await observationFixture({}, B, { error: action => action === 'SESSION_READINESS' ? code : null });
    await assert.rejects(api().observeViews(failing.b.handle, B, failing.evidence),
      { code: { READINESS_FAILED: 'READINESS_FAILED', OWNER_MISMATCH: 'IDENTITY_MISMATCH', SESSION_CHANGED: 'SESSION_MISMATCH' }[code] }, code);
    assert.equal(failing.b.calls.some(call => call.action === 'OBSERVE_VIEW'), false, code);
  }
});

test('measured_no_error_refused_by_observation', async () => {
  // T13 I-9 through the real worker: a visible role=alert error state is the worker's measured
  // noError=false, and the observation layer refuses it before the next view.
  const h = await startHarness({ fake: { alertCount: 1 } });
  const privateHandle = await sessionApi.loginOnce(h.session, Object.freeze({ async consumeOnce() { return Buffer.from(login().password); }, destroy() {} }),
    { id: 'owner-id', username: 'synthetic-owner' });
  const b = { handle: h.session, routeFixture: h.routeFixture };
  await assert.rejects(api().observeViews(h.session, B, { privateSession: privateHandle, maintenance: maintenanceProof(b), sequence: 1 }), { code: 'OBSERVATION_FAILED' });
  assert.equal(h.fake.calls.selectors.filter(row => row[0] === 'role' && row[1] === 'link').length, 1, 'stopped after ROBO');
});

test('real_worker_observation_before_and_after_restart', async () => {
  // m-3: the whole observation through the real controller and real worker harness, both phases.
  const h = await startHarness();
  const privateHandle = await sessionApi.loginOnce(h.session, Object.freeze({ async consumeOnce() { return Buffer.from(login().password); }, destroy() {} }),
    { id: 'owner-id', username: 'synthetic-owner' });
  const b = { handle: h.session, routeFixture: h.routeFixture };
  const before = await api().observeViews(h.session, B, { privateSession: privateHandle, maintenance: maintenanceProof(b), sequence: 1 });
  assert.deepEqual(Object.keys(before.views), ['ROBO', 'PORTFOLIO', 'ACTIVITY']);
  const after = await api().observeViews(h.session, C, { privateSession: privateHandle, maintenance: maintenanceProof(b, C), sequence: 2 });
  assert.deepEqual(Object.keys(after.views), ['ROBO']);
  assert.equal(after.views.ROBO.noError, true);
  await closeHarness(h);
});

test('observation_results_single_use_and_phase_bound', async () => {
  // T13 m-4: results carry the phase and sequence of their readiness and are single-use.
  const b = await browser(), privateHandle = await privateSession(b.handle), s = b.handle;
  const early = await s.perform('SESSION_OBSERVATION', {});
  await settles(s.perform('SESSION_READINESS', { phase: B, sequence: 1 }), 'SESSION_READINESS resolves (C9)');
  // An observation made before this phase's readiness is stale once the gates are set.
  assert.throws(() => sessionApi.assertContinuity(privateHandle, early), { code: 'SESSION_INVALID' });
  const view = await s.perform('OBSERVE_VIEW', { phase: B, view: 'ROBO' });
  assert.throws(() => s.claimResult(view, C, 1), { code: 'SESSION_INVALID' }, 'other phase');
  assert.throws(() => s.claimResult(view, B, 2), { code: 'SESSION_INVALID' }, 'other sequence');
  const claimed = s.claimResult(view, B, 1);
  assert.deepEqual([claimed.kind, claimed.phase, claimed.sequence], ['VIEW_OBSERVED', B, 1]);
  assert.throws(() => s.claimResult(view, B, 1), { code: 'SESSION_INVALID' }, 'claimed once');
  const observed = await s.perform('SESSION_OBSERVATION', {});
  assert.deepEqual(sessionApi.assertContinuity(privateHandle, observed), { status: 'CONTINUOUS' });
  assert.throws(() => sessionApi.assertContinuity(privateHandle, observed), { code: 'SESSION_INVALID' }, 'inspected once');
  const stale = await s.perform('SESSION_OBSERVATION', {});
  await s.perform('SESSION_READINESS', { phase: C, sequence: 2 });
  assert.throws(() => sessionApi.assertContinuity(privateHandle, stale), { code: 'SESSION_INVALID' }, 'earlier phase');
  assert.throws(() => s.claimResult(stale, B, 1), { code: 'SESSION_INVALID' }, 'earlier phase claim');
  // Readiness once per phase, phases only advance, and sequences only increase.
  for (const [phase, sequence] of [[C, 3], [B, 3]]) await assert.rejects(s.perform('SESSION_READINESS', { phase, sequence }), { code: 'REPLAY' });
  const fresh = await browser(); await privateSession(fresh.handle);
  await fresh.handle.perform('SESSION_READINESS', { phase: B, sequence: 5 });
  await assert.rejects(fresh.handle.perform('SESSION_READINESS', { phase: C, sequence: 5 }), { code: 'REPLAY' });
});

test('readiness_result_bound_to_phase_sequence_run_and_session', async () => {
  // The controller mints gates only for a worker result that echoes its own action exactly.
  for (const [name, change, code] of [
    ['other phase', { phase: C }, 'INVALID_FRAME'], ['other sequence', { sequence: 9 }, 'INVALID_FRAME'],
    ['other run', { runId: '9'.repeat(32) }, 'INVALID_FRAME'], ['changed session', { sessionFingerprint: 'c'.repeat(64) }, 'SESSION_MISMATCH'],
    ['checked before the action', { checkedAtMonotonicMs: 999 }, 'INVALID_FRAME'], ['malformed digest', { ownerDigest: 'E'.repeat(64) }, 'INVALID_FRAME'],
  ]) {
    const b = await browser({}, { readiness: () => change });
    await privateSession(b.handle);
    await assert.rejects(b.handle.perform('SESSION_READINESS', { phase: B, sequence: 1 }), { code }, name);
    assert.equal(b.handle.currentGates(), null, name);
  }
});

test('post_restart_continuity_checks_owner', async () => {
  // T13 m-4 / design section 14: post-restart continuity includes the owner. The AFTER readiness's
  // owner digest must equal the BEFORE one, or the run stops before the post-restart ROBO view.
  let owner = 'e'.repeat(64);
  const changed = await beforeThenAfter({}, { ownerDigest: () => owner });
  const before = changed.b.calls.length;
  owner = 'f'.repeat(64);
  await assert.rejects(api().observeViews(changed.b.handle, C, changed.after), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(views(changed.b.calls.slice(before)), []);
  // Control: the same owner digest.
  const same = await beforeThenAfter();
  assert.deepEqual(Object.keys((await api().observeViews(same.b.handle, C, same.after)).views), ['ROBO']);
  // No BEFORE owner basis: an AFTER observation alone is refused.
  const alone = await observationFixture({}, C);
  await assert.rejects(api().observeViews(alone.b.handle, C, { ...alone.evidence, sequence: 2 }), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(views(alone.b.calls), []);
  // Through the real worker: a changed /api/me owner after restart fails the worker readiness.
  let id = 'owner-id';
  const h = await startHarness({ fake: { ownerId: () => id } });
  const privateHandle = await sessionApi.loginOnce(h.session, Object.freeze({ async consumeOnce() { return Buffer.from(login().password); }, destroy() {} }),
    { id: 'owner-id', username: 'synthetic-owner' });
  const real = { handle: h.session, routeFixture: h.routeFixture };
  await api().observeViews(h.session, B, { privateSession: privateHandle, maintenance: maintenanceProof(real), sequence: 1 });
  id = 'different-owner';
  await assert.rejects(api().observeViews(h.session, C, { privateSession: privateHandle, maintenance: maintenanceProof(real, C), sequence: 2 }), { code: 'IDENTITY_MISMATCH' });
});

test('maintenance_trust_bound_to_session_release_trust', async () => {
  // T13 m-9: the maintenance trust is the session's private release trust context (or a
  // post-restart context for the same release and pinned keys), never a caller-supplied one.
  const b = await browser(), privateHandle = await privateSession(b.handle), own = sessionReceipts(b);
  assert.throws(() => api().validateMaintenance(b.handle, { trust: b.routeFixture.trust, ...own, phase: B }), { code: 'READINESS_FAILED' }, 'trust is not an input');
  const foreign = receiptFixture();
  assert.throws(() => api().validateMaintenance(b.handle, { maintenanceReceipt: foreign.maintenanceReceipt, databaseReceipt: foreign.databaseReceipt, phase: B }),
    { code: 'READINESS_FAILED' }, 'unrelated signer and release');
  // Same pinned keys and run, but another release identity.
  const f = b.routeFixture, expected = clone(f.options.expected);
  expected.RELEASE_RECEIPT.payload.appSHA = 'c'.repeat(40);
  const otherRelease = receiptApi.createTrustContext({ ...f.options, expected, consumedReceipts: new Set(), consumedNonces: new Set() });
  assert.throws(() => api().validateMaintenance(b.handle, {
    maintenanceReceipt: receiptApi.verifyReceipt(f.sign(f.frames.MAINTENANCE_RECEIPT), 'MAINTENANCE_RECEIPT', otherRelease),
    databaseReceipt: receiptApi.verifyReceipt(f.sign(f.frames.DB_RECEIPT), 'DB_RECEIPT', otherRelease), phase: B }), { code: 'READINESS_FAILED' }, 'other release');
  // Maintenance and DB receipts must come from one trust context.
  const after = sessionReceipts(b, C);
  assert.throws(() => api().validateMaintenance(b.handle, { maintenanceReceipt: after.maintenanceReceipt, databaseReceipt: own.databaseReceipt, phase: B }),
    { code: 'READINESS_FAILED' }, 'mixed trust contexts');
  // Control: the session's own release trust.
  const proof = attempt(() => api().validateMaintenance(b.handle, { ...own, phase: B }), 'control: the session release trust (T13 m-9)');
  assert.throws(() => JSON.stringify(proof), { code: 'PRIVATE_HANDLE' });
  // The proof belongs to its session: another session cannot use it.
  const other = await browser(), otherPrivate = await privateSession(other.handle);
  await assert.rejects(api().observeViews(other.handle, B, { privateSession: otherPrivate, maintenance: proof, sequence: 1 }), { code: 'READINESS_FAILED' });
  assert.equal(other.calls.some(call => call.action !== 'LOGIN_SESSION'), false);
  const observed = await api().observeViews(b.handle, B, { privateSession: privateHandle, maintenance: proof, sequence: 1 });
  assert.equal(observed.maintenance, true);
});
