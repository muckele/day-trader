'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const contracts = require('../../guest/contracts.cjs');
const receiptApi = require('../../guest/receipts.cjs');
const sessionApi = require('../../guest/session.cjs');
const vectors = require('../../contracts/vectors.json');

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

function viewSummary(view, overrides = {}) {
  return {
    kind: 'VIEW_OBSERVED', view, phase: 'OBSERVE_BEFORE_RESTART',
    schemaValidation: true, renderedData: true, validEmptyState: false, noError: true,
    fresh: true, source: 'alpaca-paper', brokerError: false,
    routeCount: { ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 }[view], renderedCount: 1,
    runId: RUN, configIdentity: CONFIG, fingerprint: FINGERPRINT,
    readinessValidation: view === 'ROBO',
    ...overrides,
  };
}

function browser(viewOverrides = {}, hooks = {}) {
  const calls = [], results = new WeakMap();
  const fingerprint = () => typeof hooks.fingerprint === 'function' ? hooks.fingerprint() : FINGERPRINT;
  function result(value) {
    const handle = Object.freeze(Object.defineProperty({}, 'toJSON', { value() { throw Object.assign(new Error('PRIVATE_HANDLE'), { code: 'PRIVATE_HANDLE' }); } }));
    results.set(handle, Object.freeze({ ...value }));
    return handle;
  }
  const handle = Object.freeze({
    assertBinding(binding) {
      const expected = hooks.binding || { runId: RUN, configIdentity: CONFIG };
      if (binding.runId !== expected.runId || binding.configIdentity !== expected.configIdentity) {
        throw Object.assign(new Error('IDENTITY_MISMATCH'), { code: 'IDENTITY_MISMATCH' });
      }
      return true;
    },
    async perform(action, payload, onFilled) {
      calls.push({ action, payload: clone(payload) });
      if (action === 'LOGIN_SESSION') { onFilled(); return result({ kind: 'SESSION_BOUND', fingerprint: fingerprint() }); }
      if (action === 'SESSION_OBSERVATION') return result({ kind: 'SESSION_OBSERVED', fingerprint: fingerprint() });
      if (action === 'OBSERVE_VIEW') { hooks.onView?.(payload.view);return result(viewSummary(payload.view,
        { fingerprint:fingerprint(),...viewOverrides[payload.view] })); }
      throw Object.assign(new Error('ACTION_DENIED'), { code: 'ACTION_DENIED' });
    },
    inspectResult(value) {
      const saved = results.get(value);
      if (!saved) throw Object.assign(new Error('SESSION_INVALID'), { code: 'SESSION_INVALID' });
      return saved;
    },
  });
  return { handle, calls };
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
  const b = browser(viewOverrides);
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
  const b = browser(), privateHandle = await privateSession(b.handle);
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', {
    privateSession: privateHandle, readiness: api().validateReadiness(readiness()), maintenance: api().validateReadiness(readiness()),
  }), { code: 'READINESS_FAILED' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('absent_duplicate_settings_abort_before_GET', async () => {
  const b = browser(), privateHandle = await privateSession(b.handle), fixture = receiptFixture();
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
  const b = browser(), fixture = receiptFixture();
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
  for (const override of [{ runId: '2'.repeat(32) }, { configIdentity: 'b'.repeat(64) }]) {
    const fixture = await observationFixture({ ROBO: override });
    await assert.rejects(api().observeViews(fixture.b.handle, fixture.phase, fixture.evidence), { code: 'IDENTITY_MISMATCH' });
  }
});

test('session_binding_mismatch_fails_before_any_view_read', async () => {
  const b = browser({}, { binding: { runId: '2'.repeat(32), configIdentity: CONFIG } });
  const evidence = {
    privateSession: await privateSession(b.handle),
    readiness: api().validateReadiness(readiness()),
    maintenance: maintenanceProof(),
  };
  await assert.rejects(api().observeViews(b.handle, 'OBSERVE_BEFORE_RESTART', evidence), { code: 'IDENTITY_MISMATCH' });
  assert.equal(b.calls.some(call => call.action === 'OBSERVE_VIEW'), false);
});

test('maintenance_expiry_between_views_stops_before_the_next_view', async () => {
  const fixture = receiptFixture(),b = browser({}, { onView(view) { if (view === 'ROBO') fixture.setNow(201); } });
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
  let fingerprint=FINGERPRINT;const b=browser({}, { fingerprint:()=>fingerprint });
  const privateHandle=await privateSession(b.handle);fingerprint='c'.repeat(64);
  const evidence={privateSession:privateHandle,readiness:api().validateReadiness(readiness()),maintenance:maintenanceProof()};
  await assert.rejects(api().observeViews(b.handle,'OBSERVE_BEFORE_RESTART',evidence),{code:'SESSION_MISMATCH'});
  assert.equal(b.calls.some(call=>call.action==='OBSERVE_VIEW'),false);
});
