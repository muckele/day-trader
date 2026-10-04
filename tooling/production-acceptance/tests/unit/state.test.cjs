'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PHASES, EFFECTS, LIMITS, reduce } = require('../../guest/state.cjs');

const RUN_ID = 'a'.repeat(32);
const START = 1_000;

function state(overrides = {}) {
  return Object.freeze({
    version: 1,
    runId: RUN_ID,
    sequence: 0,
    phase: 'PREFLIGHT',
    runStartedAtMs: START,
    phaseStartedAtMs: START,
    lastEventAtMs: START,
    sessionExpiresAtMs: null,
    credentialConsumed: false,
    loginAttempted: false,
    authenticated: false,
    restartReceiptConsumed: false,
    logoutAttempted: false,
    cleanupStartedAtMs: null,
    cleanupComplete: false,
    failure: null,
    ...overrides,
  });
}

function event(current, type, fields = {}) {
  return Object.freeze({
    type,
    runId: current.runId,
    sequence: current.sequence + 1,
    ...fields,
  });
}

function step(current, type, nowMs, fields = {}) {
  return reduce(current, event(current, type, fields), nowMs);
}

function toAwait(current = state(), nowMs = START + 1) {
  return step(current, 'validate', nowMs, { admission: 'VERIFIED' }).nextState;
}

function toAuthenticating(current = state(), nowMs = START + 1) {
  current = toAwait(current, nowMs);
  return step(current, 'consumeCredential', nowMs + 1, { outcome: 'CONSUMED' }).nextState;
}

function toBefore(current = state(), nowMs = START + 1) {
  current = toAuthenticating(current, nowMs);
  return step(current, 'login', nowMs + 2, {
    outcome: 'SUCCEEDED',
    sessionExpiresAtMs: START + 3_600_000,
  }).nextState;
}

function toHold(current = state(), nowMs = START + 1) {
  current = toBefore(current, nowMs);
  return step(current, 'observeBefore', nowMs + 3, { outcome: 'PASS' }).nextState;
}

function toLogout(current = state(), nowMs = START + 1) {
  current = toHold(current, nowMs);
  current = step(current, 'acceptRestartReceipt', nowMs + 4, { status: 'VERIFIED' }).nextState;
  return step(current, 'observeAfter', nowMs + 5, { outcome: 'PASS' }).nextState;
}

test('all_eleven_states', () => {
  assert.deepEqual(PHASES, Object.freeze([
    'PREFLIGHT', 'AWAIT_CREDENTIAL', 'AUTHENTICATING',
    'OBSERVE_BEFORE_RESTART', 'HOLD_FOR_RESTART', 'OBSERVE_AFTER_RESTART',
    'LOGOUT', 'VERIFY_REVOCATION', 'FINALIZE', 'DONE', 'FAILED',
  ]));
  const seen = [state().phase];
  let current = state();
  let result = step(current, 'validate', START + 1, { admission: 'VERIFIED' });
  assert.deepEqual(result.effects, [EFFECTS.REQUEST_CREDENTIAL]);
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'consumeCredential', START + 2, { outcome: 'CONSUMED' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'login', START + 3, { outcome: 'SUCCEEDED', sessionExpiresAtMs: START + 3_600_000 });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'observeBefore', START + 4, { outcome: 'PASS' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'acceptRestartReceipt', START + 5, { status: 'VERIFIED' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'observeAfter', START + 6, { outcome: 'PASS' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'signOut', START + 7, { outcome: 'REVOKED' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'verifyRevocation', START + 8, { outcome: 'PASS' });
  current = result.nextState; seen.push(current.phase);
  result = step(current, 'finalize', START + 9, { outcome: 'PASS' });
  current = result.nextState; seen.push(current.phase);
  const failed = step(state(), 'abort', START + 1, { code: 'INTERNAL_FAILURE', boundaryTrusted: false }).nextState;
  seen.push(failed.phase);
  assert.deepEqual(seen, PHASES);
  assert.equal(current.failure, null);
  assert.equal(current.cleanupComplete, true);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nextState));
  assert.ok(Object.isFrozen(result.effects));
});

test('invalid_transition_fails', () => {
  const result = step(state(), 'observeAfter', START + 1, { outcome: 'PASS' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'INVALID_FRAME');
  assert.deepEqual(result.effects, [EFFECTS.CLEANUP]);
});

test('duplicate_consume_second_login_fail', () => {
  let current = toAuthenticating();
  let result = step(current, 'consumeCredential', START + 4, { outcome: 'CONSUMED' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'CREDENTIAL_INVALID');

  current = toBefore();
  result = step(current, 'login', START + 5, { outcome: 'SUCCEEDED', sessionExpiresAtMs: START + 3_600_000 });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'SESSION_MISMATCH');
});

test('hold_route_denied', () => {
  const current = toHold();
  const result = step(current, 'budget', START + 6, { outcome: 'ELIGIBLE' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'ROUTE_DENIED');
  assert.equal(result.effects.includes(EFFECTS.FORWARD_ROUTE), false);
});

test('receipt_outside_hold_fail', () => {
  const result = step(toBefore(), 'acceptRestartReceipt', START + 5, { status: 'VERIFIED' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'IDENTITY_MISMATCH');
});

test('failed_only_safe_cleanup_logout', () => {
  const current = toBefore();
  let result = step(current, 'abort', START + 5, { code: 'OBSERVATION_FAILED', boundaryTrusted: true });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.deepEqual(result.effects, [EFFECTS.SAFE_SIGN_OUT, EFFECTS.CLEANUP]);
  assert.equal(result.nextState.logoutAttempted, true);

  result = step(result.nextState, 'signOut', START + 6, { outcome: 'REVOKED' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'OBSERVATION_FAILED');
  assert.deepEqual(result.effects, []);

  result = step(result.nextState, 'cleanup', START + 7, { outcome: 'PASS' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.nextState.cleanupComplete, true);
  assert.equal(result.failureCode, 'OBSERVATION_FAILED');

  const logoutPending = toLogout();
  assert.equal(logoutPending.logoutAttempted, true);
  result = step(logoutPending, 'abort', START + 8, { code: 'SESSION_MISMATCH', boundaryTrusted: true });
  assert.deepEqual(result.effects, [EFFECTS.CLEANUP]);
});

test('outage_restart_cannot_resume', () => {
  let result = step(toBefore(), 'outage', START + 5, { source: 'PROXY' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'TRANSPORT_LOST');
  result = step(result.nextState, 'validate', START + 6, { admission: 'VERIFIED' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'TRANSPORT_LOST');
  assert.deepEqual(result.effects, []);
});

test('20min_run_10min_hold_120s_intake_60s_cleanup_deadlines', () => {
  let current = toAwait();
  let result = step(current, 'consumeCredential', current.phaseStartedAtMs + LIMITS.INTAKE_MS, { outcome: 'CONSUMED' });
  assert.equal(result.failureCode, 'DEADLINE');

  current = toHold();
  result = step(current, 'acceptRestartReceipt', current.phaseStartedAtMs + LIMITS.HOLD_MS, { status: 'VERIFIED' });
  assert.equal(result.failureCode, 'DEADLINE');

  result = step(state(), 'validate', START + LIMITS.RUN_MS, { admission: 'VERIFIED' });
  assert.equal(result.failureCode, 'DEADLINE');

  current = step(toBefore(), 'abort', START + 5, { code: 'OBSERVATION_FAILED', boundaryTrusted: false }).nextState;
  result = step(current, 'cleanup', current.cleanupStartedAtMs + LIMITS.CLEANUP_MS, { outcome: 'PASS' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.nextState.cleanupComplete, false);
  assert.equal(result.failureCode, 'OBSERVATION_FAILED');
});

test('session_expiry_no_reauth', () => {
  let current = toAuthenticating();
  current = step(current, 'login', START + 3, {
    outcome: 'SUCCEEDED',
    sessionExpiresAtMs: START + 100,
  }).nextState;
  let result = step(current, 'observeBefore', current.sessionExpiresAtMs, { outcome: 'PASS' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'EXPIRED');
  result = step(result.nextState, 'login', current.sessionExpiresAtMs + 1, {
    outcome: 'SUCCEEDED',
    sessionExpiresAtMs: current.sessionExpiresAtMs + 3_600_000,
  });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, 'EXPIRED');
  assert.deepEqual(result.effects, []);
});

test('cleanup_success_cannot_erase_failure', () => {
  let result = step(toBefore(), 'abort', START + 5, { code: 'PRIVACY_FAILED', boundaryTrusted: false });
  const originalFailure = result.nextState.failure;
  result = step(result.nextState, 'cleanup', START + 6, { outcome: 'PASS' });
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.nextState.failure, originalFailure);
  assert.equal(result.failureCode, 'PRIVACY_FAILED');
  assert.equal(result.nextState.cleanupComplete, true);
});
