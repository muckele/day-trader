'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PHASES, EFFECTS, LIMITS, STATE_KEYS, initialState, reduce } = require('../../guest/state.cjs');

const RUN_ID = 'a'.repeat(32);
const START = 1_000;

function state(overrides = {}) {
  return Object.freeze({ ...initialState(RUN_ID, START), ...overrides });
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

// ---- Task 13: outcome gates, safe sign-out, invariants -------------------

const FAR = START + 3_600_000;

function toVerify(current = state()) {
  current = toLogout(current);
  return step(current, 'signOut', START + 7, { outcome: 'REVOKED' }).nextState;
}
function toFinalize(current = state()) {
  return step(toVerify(current), 'verifyRevocation', START + 8, { outcome: 'PASS' }).nextState;
}
function toDone(current = state()) {
  return step(toFinalize(current), 'finalize', START + 9, { outcome: 'PASS' }).nextState;
}

function toHoldShort(expiresAtMs = START + 100_000) {
  let current = toAuthenticating();
  current = step(current, 'login', START + 3, { outcome: 'SUCCEEDED', sessionExpiresAtMs: expiresAtMs }).nextState;
  return step(current, 'observeBefore', START + 4, { outcome: 'PASS' }).nextState;
}
function toLogoutShort() {
  let current = step(toHoldShort(), 'acceptRestartReceipt', START + 5, { status: 'VERIFIED' }).nextState;
  return step(current, 'observeAfter', START + 6, { outcome: 'PASS' }).nextState;
}

function toAfter() {
  return step(toHold(), 'acceptRestartReceipt', START + 4, { status: 'VERIFIED' }).nextState;
}

function assertFailsWith(result, code) {
  assert.equal(result.nextState.phase, 'FAILED');
  assert.equal(result.failureCode, code);
  assert.equal(result.nextState.failure, code);
  assert.equal(result.effects.includes(EFFECTS.FORWARD_ROUTE), false);
}

const GATES = [
  ['validate_without_verified_admission_fails', () => state(), 'validate', { admission: 'UNVERIFIED' }, 'INVALID_FRAME'],
  ['restart_receipt_rejected_fails', () => toHold(), 'acceptRestartReceipt', { status: 'REJECTED' }, 'SIGNATURE_INVALID'],
  ['finalize_fail_fails', () => toFinalize(), 'finalize', { outcome: 'FAIL' }, 'CLEANUP_INCOMPLETE'],
  ['verify_revocation_fail_fails', () => toVerify(), 'verifyRevocation', { outcome: 'FAIL' }, 'SESSION_MISMATCH'],
  ['sign_out_failed_fails', () => toLogout(), 'signOut', { outcome: 'FAILED' }, 'SESSION_MISMATCH'],
  ['observe_before_fail_fails', () => toBefore(), 'observeBefore', { outcome: 'FAIL' }, 'OBSERVATION_FAILED'],
  ['consume_rejected_fails', () => toAwait(), 'consumeCredential', { outcome: 'REJECTED' }, 'CREDENTIAL_INVALID'],
  ['login_failed_fails', () => toAuthenticating(), 'login', { outcome: 'FAILED', sessionExpiresAtMs: FAR }, 'SESSION_MISMATCH'],
  ['budget_denied_fails', () => toBefore(), 'budget', { outcome: 'DENIED' }, 'BUDGET_EXCEEDED'],
  ['observe_after_fail_fails', () => toAfter(), 'observeAfter', { outcome: 'FAIL' }, 'OBSERVATION_FAILED'],
];
for (const [name, make, type, fields, code] of GATES) {
  test(name, () => {
    const current = make();
    assertFailsWith(step(current, type, current.lastEventAtMs + 1, fields), code);
  });
}

test('all_failing_run_never_reaches_done', () => {
  // Every phase, driven with each failing outcome that phase accepts, never
  // reaches DONE and never forwards a route.
  const phases = [
    [() => state(), [['validate', { admission: 'UNVERIFIED' }]]],
    [() => toAwait(), [['consumeCredential', { outcome: 'REJECTED' }]]],
    [() => toAuthenticating(), [['login', { outcome: 'FAILED', sessionExpiresAtMs: FAR }]]],
    [() => toBefore(), [['observeBefore', { outcome: 'FAIL' }], ['budget', { outcome: 'DENIED' }]]],
    [() => toHold(), [['acceptRestartReceipt', { status: 'REJECTED' }]]],
    [() => toAfter(), [['observeAfter', { outcome: 'FAIL' }]]],
    [() => toLogout(), [['signOut', { outcome: 'FAILED' }]]],
    [() => toVerify(), [['verifyRevocation', { outcome: 'FAIL' }]]],
    [() => toFinalize(), [['finalize', { outcome: 'FAIL' }]]],
  ];
  for (const [make, failing] of phases) {
    for (const [type, fields] of failing) {
      const first = make();
      let result = step(first, type, first.lastEventAtMs + 1, fields);
      assert.equal(result.nextState.phase, 'FAILED', `${first.phase}/${type}`);
      assert.equal(result.effects.includes(EFFECTS.FORWARD_ROUTE), false);
      // Feed every failing event of every phase afterwards: still FAILED, same code.
      const code = result.failureCode;
      for (const [, others] of phases) {
        for (const [t2, f2] of others) {
          result = step(result.nextState, t2, result.nextState.lastEventAtMs + 1, f2);
          assert.equal(result.nextState.phase, 'FAILED');
          assert.equal(result.failureCode, code);
          assert.equal(result.effects.includes(EFFECTS.FORWARD_ROUTE), false);
        }
      }
    }
  }
});

test('finalize_cleanup_deadline', () => {
  const current = toFinalize();
  assertFailsWith(step(current, 'finalize', current.cleanupStartedAtMs + LIMITS.CLEANUP_MS, { outcome: 'PASS' }), 'CLEANUP_INCOMPLETE');
  const ok = step(current, 'finalize', current.cleanupStartedAtMs + LIMITS.CLEANUP_MS - 1, { outcome: 'PASS' });
  assert.equal(ok.nextState.phase, 'DONE');
});

test('invalid_event_in_failed_keeps_first_code', () => {
  let result = step(toBefore(), 'abort', START + 5, { code: 'PRIVACY_FAILED', boundaryTrusted: false });
  for (const [type, fields] of [['validate', { admission: 'NOPE' }], ['bogus', {}], ['login', { outcome: 'FAILED', sessionExpiresAtMs: FAR }]]) {
    result = step(result.nextState, type, START + 6, fields);
    assert.equal(result.nextState.failure, 'PRIVACY_FAILED');
    assert.equal(result.failureCode, 'PRIVACY_FAILED');
    assert.deepEqual(result.effects, []);
  }
  const bad = reduce(result.nextState, { type: 'tick', runId: 'b'.repeat(32), sequence: 99 }, START + 7);
  assert.equal(bad.nextState.failure, 'PRIVACY_FAILED');
});

test('hold_and_logout_session_expiry', () => {
  const hold = toHoldShort();
  assert.ok(hold.sessionExpiresAtMs < START + LIMITS.RUN_MS);
  assertFailsWith(step(hold, 'acceptRestartReceipt', hold.sessionExpiresAtMs, { status: 'VERIFIED' }), 'EXPIRED');
  const logout = toLogoutShort();
  assert.equal(logout.phase, 'LOGOUT');
  assertFailsWith(step(logout, 'signOut', logout.sessionExpiresAtMs, { outcome: 'REVOKED' }), 'EXPIRED');
  const after = step(hold, 'acceptRestartReceipt', START + 5, { status: 'VERIFIED' }).nextState;
  assertFailsWith(step(after, 'observeAfter', after.sessionExpiresAtMs, { outcome: 'PASS' }), 'EXPIRED');
  // Logged out: session expiry no longer applies in VERIFY_REVOCATION.
  const verify = step(logout, 'signOut', START + 7, { outcome: 'REVOKED' }).nextState;
  assert.equal(step(verify, 'verifyRevocation', verify.sessionExpiresAtMs + 1, { outcome: 'PASS' }).nextState.phase, 'FINALIZE');
});

test('outage_in_every_live_phase', () => {
  const live = [state(), toAwait(), toAuthenticating(), toBefore(), toHold(),
    step(toHold(), 'acceptRestartReceipt', START + 4, { status: 'VERIFIED' }).nextState,
    toLogout(), toVerify(), toFinalize()];
  assert.equal(live.length, PHASES.length - 2);
  for (const current of live) {
    const result = step(current, 'outage', current.lastEventAtMs + 1, { source: 'VM' });
    assertFailsWith(result, 'TRANSPORT_LOST');
    const resumed = step(result.nextState, 'validate', result.nextState.lastEventAtMs + 1, { admission: 'VERIFIED' });
    assert.equal(resumed.nextState.phase, 'FAILED');
    assert.equal(resumed.failureCode, 'TRANSPORT_LOST');
    assert.deepEqual(resumed.effects, []);
  }
});

test('done_absorbs_stray_events_with_anomaly_flag', () => {
  const done = toDone();
  assert.equal(done.phase, 'DONE');
  assert.equal(done.postTerminalAnomaly, false);
  const events = [
    ['validate', { admission: 'VERIFIED' }], ['abort', { code: 'INTERNAL_FAILURE', boundaryTrusted: true }],
    ['outage', { source: 'VM' }], ['budget', { outcome: 'ELIGIBLE' }], ['cleanup', { outcome: 'FAIL' }],
    ['bogus', {}],
  ];
  for (const [type, fields] of events) {
    const result = step(done, type, done.lastEventAtMs + 1, fields);
    assert.equal(result.nextState.phase, 'DONE');
    assert.equal(result.nextState.failure, null);
    assert.equal(result.nextState.cleanupComplete, true);
    assert.equal(result.nextState.postTerminalAnomaly, true);
    assert.deepEqual(result.effects, []);
    const { postTerminalAnomaly, sequence, lastEventAtMs, ...rest } = result.nextState;
    const { postTerminalAnomaly: _p, sequence: _s, lastEventAtMs: _l, ...base } = done;
    assert.deepEqual(rest, base);
  }
  const wrongRun = reduce(done, { type: 'readResult', runId: 'c'.repeat(32), sequence: 99 }, done.lastEventAtMs + 1);
  assert.equal(wrongRun.nextState.phase, 'DONE');
  assert.equal(wrongRun.nextState.postTerminalAnomaly, true);
  const read = step(done, 'readResult', done.lastEventAtMs + 1);
  assert.deepEqual(read.effects, [EFFECTS.READ_RESULT]);
  assert.equal(read.nextState.postTerminalAnomaly, false);
});

test('p_phase_budget_forwards_in_preflight_and_await_credential', () => {
  for (const current of [state(), toAwait()]) {
    let result = step(current, 'budget', current.lastEventAtMs + 1, { outcome: 'ELIGIBLE' });
    assert.equal(result.nextState.phase, current.phase);
    assert.deepEqual(result.effects, [EFFECTS.FORWARD_ROUTE]);
    assert.equal(result.nextState.sequence, current.sequence + 1);
    result = step(current, 'budget', current.lastEventAtMs + 1, { outcome: 'DENIED' });
    assertFailsWith(result, 'BUDGET_EXCEEDED');
  }
});

test('hold_budget_still_denied', () => {
  const result = step(toHold(), 'budget', START + 6, { outcome: 'ELIGIBLE' });
  assertFailsWith(result, 'ROUTE_DENIED');
  const fin = step(toFinalize(), 'budget', START + 10, { outcome: 'ELIGIBLE' });
  assertFailsWith(fin, 'ROUTE_DENIED');
});

function trustedAbortInBefore() {
  return step(toBefore(), 'abort', START + 5, { code: 'OBSERVATION_FAILED', boundaryTrusted: true });
}

test('safe_sign_out_route_admitted_once_in_failed', () => {
  let result = trustedAbortInBefore();
  assert.deepEqual(result.effects, [EFFECTS.SAFE_SIGN_OUT, EFFECTS.CLEANUP]);
  assert.equal(result.nextState.revocation, 'PENDING');
  assert.equal(result.nextState.safeSignOutRouted, false);
  result = step(result.nextState, 'safeSignOutRoute', START + 6, { outcome: 'ELIGIBLE' });
  assert.deepEqual(result.effects, [EFFECTS.FORWARD_ROUTE]);
  assert.equal(result.nextState.safeSignOutRouted, true);
  assert.equal(result.nextState.revocation, 'PENDING');
  const again = step(result.nextState, 'safeSignOutRoute', START + 7, { outcome: 'ELIGIBLE' });
  assert.deepEqual(again.effects, []);
  assert.equal(again.nextState.revocation, 'PENDING');
  // Plain budget events in FAILED never forward (the route has its own event).
  assert.deepEqual(step(again.nextState, 'budget', START + 8, { outcome: 'ELIGIBLE' }).effects, []);
  // Without a SAFE_SIGN_OUT request the route event is ignored.
  const none = step(step(toBefore(), 'abort', START + 5, { code: 'OBSERVATION_FAILED', boundaryTrusted: false }).nextState,
    'safeSignOutRoute', START + 6, { outcome: 'ELIGIBLE' });
  assert.deepEqual(none.effects, []);
  assert.equal(none.nextState.safeSignOutRouted, false);
  // Denied route: revocation unconfirmed, once.
  const denied = step(trustedAbortInBefore().nextState, 'safeSignOutRoute', START + 6, { outcome: 'DENIED' });
  assert.deepEqual(denied.effects, []);
  assert.equal(denied.nextState.revocation, 'UNCONFIRMED');
  // Route events outside FAILED are invalid frames.
  assertFailsWith(step(toBefore(), 'safeSignOutRoute', START + 5, { outcome: 'ELIGIBLE' }), 'INVALID_FRAME');
});

test('safe_sign_out_result_recorded', () => {
  let routed = step(trustedAbortInBefore().nextState, 'safeSignOutRoute', START + 6, { outcome: 'ELIGIBLE' }).nextState;
  let result = step(routed, 'safeSignOutResult', START + 7, { outcome: 'REVOKED' });
  assert.equal(result.nextState.revocation, 'CONFIRMED');
  assert.equal(result.nextState.failure, 'OBSERVATION_FAILED');
  assert.deepEqual(result.effects, []);
  result = step(routed, 'safeSignOutResult', START + 7, { outcome: 'FAILED' });
  assert.equal(result.nextState.revocation, 'UNCONFIRMED');
  // A result before any admitted route is ignored.
  result = step(trustedAbortInBefore().nextState, 'safeSignOutResult', START + 6, { outcome: 'REVOKED' });
  assert.equal(result.nextState.revocation, 'PENDING');
});

test('revocation_unconfirmed_when_session_maybe_issued_without_confirmation', () => {
  assert.equal(toAuthenticating().sessionMaybeIssued, true);
  assert.equal(state().sessionMaybeIssued, false);
  // Untrusted abort, outage, login failure and logout failure.
  const cases = [
    step(toBefore(), 'abort', START + 5, { code: 'PRIVACY_FAILED', boundaryTrusted: false }),
    step(toBefore(), 'outage', START + 5, { source: 'PROXY' }),
    step(toAuthenticating(), 'login', START + 5, { outcome: 'FAILED', sessionExpiresAtMs: FAR }),
    step(toLogout(), 'signOut', START + 8, { outcome: 'FAILED' }),
    step(toLogout(), 'abort', START + 8, { code: 'SESSION_MISMATCH', boundaryTrusted: true }),
    step(toVerify(), 'verifyRevocation', START + 9, { outcome: 'FAIL' }),
  ];
  for (const result of cases) {
    assert.equal(result.nextState.revocation, 'UNCONFIRMED');
    assert.equal(result.effects.includes(EFFECTS.SAFE_SIGN_OUT), false);
  }
  // No session ever possible: not required.
  assert.equal(step(state(), 'abort', START + 1, { code: 'INTERNAL_FAILURE', boundaryTrusted: true }).nextState.revocation, 'NOT_REQUIRED');
  assert.equal(step(toAwait(), 'consumeCredential', START + 3, { outcome: 'REJECTED' }).nextState.revocation, 'NOT_REQUIRED');
  // Confirmed revocation stays confirmed when FINALIZE then fails.
  assert.equal(step(toFinalize(), 'finalize', START + 10, { outcome: 'FAIL' }).nextState.revocation, 'CONFIRMED');
});

test('trusted_abort_in_authenticating_requests_safe_sign_out', () => {
  const current = toAuthenticating();
  assert.equal(current.authenticated, false);
  const result = step(current, 'abort', START + 4, { code: 'SESSION_MISMATCH', boundaryTrusted: true });
  assert.deepEqual(result.effects, [EFFECTS.SAFE_SIGN_OUT, EFFECTS.CLEANUP]);
  assert.equal(result.nextState.logoutAttempted, true);
  assert.equal(result.nextState.revocation, 'PENDING');
  const untrusted = step(current, 'abort', START + 4, { code: 'SESSION_MISMATCH', boundaryTrusted: false });
  assert.deepEqual(untrusted.effects, [EFFECTS.CLEANUP]);
  assert.equal(untrusted.nextState.revocation, 'UNCONFIRMED');
  // No session issued yet: no safe sign-out even when trusted.
  assert.deepEqual(step(toAwait(), 'abort', START + 3, { code: 'SESSION_MISMATCH', boundaryTrusted: true }).effects, [EFFECTS.CLEANUP]);
});

test('initial_state_is_the_only_constructor_and_hand_built_inconsistent_states_rejected', () => {
  const init = initialState(RUN_ID, START);
  assert.deepEqual(Object.keys(init).sort(), [...STATE_KEYS].sort());
  assert.ok(Object.isFrozen(init));
  assert.equal(init.phase, 'PREFLIGHT');
  assert.throws(() => initialState('short', START), TypeError);
  assert.throws(() => initialState(RUN_ID, -1), TypeError);
  assert.throws(() => initialState(RUN_ID, 1.5), TypeError);
  const bad = (overrides) => {
    const current = state(overrides);
    assert.throws(() => reduce(current, event(current, 'tick'), START + 1), TypeError, JSON.stringify(overrides));
  };
  // P12-C: unauthenticated LOGOUT reaching DONE.
  bad({ phase: 'LOGOUT' });
  bad({ phase: 'OBSERVE_AFTER_RESTART' });
  const authed = {
    credentialConsumed: true, loginAttempted: true, authenticated: true, sessionMaybeIssued: true,
    sessionExpiresAtMs: FAR, revocation: 'PENDING',
  };
  bad({ ...authed, phase: 'LOGOUT' });                                   // missing restart + logout
  bad({ ...authed, phase: 'OBSERVE_BEFORE_RESTART', sessionExpiresAtMs: null });
  bad({ ...authed, phase: 'OBSERVE_BEFORE_RESTART', sessionMaybeIssued: false });
  bad({ ...authed, phase: 'OBSERVE_BEFORE_RESTART', authenticated: false });
  bad({ ...authed, phase: 'OBSERVE_BEFORE_RESTART', loginAttempted: false });
  bad({ ...authed, phase: 'OBSERVE_BEFORE_RESTART', credentialConsumed: false });
  bad({ ...authed, phase: 'HOLD_FOR_RESTART', revocation: 'NOT_REQUIRED' });
  const loggedOut = { ...authed, authenticated: false, restartReceiptConsumed: true, logoutAttempted: true };
  bad({ ...loggedOut, phase: 'VERIFY_REVOCATION', authenticated: true });   // P19
  bad({ ...loggedOut, phase: 'VERIFY_REVOCATION', logoutAttempted: false });
  bad({ ...loggedOut, phase: 'VERIFY_REVOCATION', restartReceiptConsumed: false });
  bad({ ...loggedOut, phase: 'FINALIZE', revocation: 'CONFIRMED' });         // no cleanupStartedAtMs
  bad({ ...loggedOut, phase: 'DONE', revocation: 'CONFIRMED', cleanupStartedAtMs: START, cleanupComplete: false });
  bad({ ...loggedOut, phase: 'DONE', revocation: 'PENDING', cleanupStartedAtMs: START, cleanupComplete: true });
  bad({ ...loggedOut, phase: 'DONE', revocation: 'UNCONFIRMED', cleanupStartedAtMs: START, cleanupComplete: true });
  bad({ credentialConsumed: true });                                        // PREFLIGHT progress flags
  bad({ phase: 'AWAIT_CREDENTIAL', loginAttempted: true });
  bad({ phase: 'AWAIT_CREDENTIAL', sessionMaybeIssued: true, revocation: 'PENDING' });
  bad({ safeSignOutRouted: true });
  bad({ postTerminalAnomaly: true });
  bad({ phase: 'FAILED', failure: 'INTERNAL_FAILURE' });                    // no cleanup start
  // The reachable successful states are all valid.
  for (const make of [toAuthenticating, toBefore, toHold, toLogout, toVerify, toFinalize, toDone]) {
    const current = make();
    assert.doesNotThrow(() => reduce(current, event(current, 'tick'), current.lastEventAtMs + 1));
  }
  const done = toDone();
  assert.equal(done.authenticated, false);
  assert.equal(done.revocation, 'CONFIRMED');
  assert.equal(done.logoutAttempted && done.restartReceiptConsumed && done.cleanupComplete, true);
});

test('cleanup_fail_is_sticky', () => {
  let result = step(toBefore(), 'abort', START + 5, { code: 'PRIVACY_FAILED', boundaryTrusted: false });
  result = step(result.nextState, 'cleanup', START + 6, { outcome: 'FAIL' });
  assert.equal(result.nextState.cleanupComplete, false);
  assert.equal(result.nextState.cleanupFailed, true);
  result = step(result.nextState, 'cleanup', START + 7, { outcome: 'PASS' });
  assert.equal(result.nextState.cleanupComplete, false);
  assert.equal(result.nextState.cleanupFailed, true);
  assert.equal(result.failureCode, 'PRIVACY_FAILED');
  // After FINALIZE FAIL -> CLEANUP_INCOMPLETE the same holds.
  let fin = step(toFinalize(), 'finalize', START + 10, { outcome: 'FAIL' });
  fin = step(fin.nextState, 'cleanup', START + 11, { outcome: 'FAIL' });
  fin = step(fin.nextState, 'cleanup', START + 12, { outcome: 'PASS' });
  assert.equal(fin.nextState.cleanupComplete, false);
  assert.equal(fin.failureCode, 'CLEANUP_INCOMPLETE');
  // A PASS first is also final: a later FAIL does not undo it.
  let ok = step(step(toBefore(), 'abort', START + 5, { code: 'PRIVACY_FAILED', boundaryTrusted: false }).nextState, 'cleanup', START + 6, { outcome: 'PASS' });
  ok = step(ok.nextState, 'cleanup', START + 7, { outcome: 'FAIL' });
  assert.equal(ok.nextState.cleanupComplete, true);
  assert.equal(ok.nextState.cleanupFailed, false);
});

test('tick_enforces_deadlines', () => {
  const run = (current, at, code) => assertFailsWith(step(current, 'tick', at, {}), code);
  run(state(), START + LIMITS.RUN_MS, 'DEADLINE');
  const awaiting = toAwait();
  run(awaiting, awaiting.phaseStartedAtMs + LIMITS.INTAKE_MS, 'DEADLINE');
  const hold = toHold();
  run(hold, hold.phaseStartedAtMs + LIMITS.HOLD_MS, 'DEADLINE');
  const shortHold = toHoldShort();
  run(shortHold, shortHold.sessionExpiresAtMs, 'EXPIRED');
  const fin = toFinalize();
  run(fin, fin.cleanupStartedAtMs + LIMITS.CLEANUP_MS, 'CLEANUP_INCOMPLETE');
  // Before any deadline a tick changes nothing but the sequence and clock.
  const quiet = step(hold, 'tick', hold.lastEventAtMs + 1, {});
  assert.equal(quiet.nextState.phase, 'HOLD_FOR_RESTART');
  assert.deepEqual(quiet.effects, []);
  // In FAILED a tick past the cleanup window latches cleanup failure and revocation.
  const failed = trustedAbortInBefore().nextState;
  const late = step(failed, 'tick', failed.cleanupStartedAtMs + LIMITS.CLEANUP_MS, {});
  assert.equal(late.nextState.cleanupFailed, true);
  assert.equal(late.nextState.revocation, 'UNCONFIRMED');
  assert.equal(late.failureCode, 'OBSERVATION_FAILED');
  const early = step(failed, 'tick', failed.cleanupStartedAtMs + LIMITS.CLEANUP_MS - 1, {});
  assert.equal(early.nextState.cleanupFailed, false);
  assert.equal(early.nextState.revocation, 'PENDING');
});

test('late_safe_sign_out_route_and_result_after_cleanup_window', () => {
  const failed = trustedAbortInBefore().nextState;
  const late = failed.cleanupStartedAtMs + LIMITS.CLEANUP_MS;
  // Route after the window: not forwarded, revocation lapses to UNCONFIRMED.
  let result = step(failed, 'safeSignOutRoute', late, { outcome: 'ELIGIBLE' });
  assert.deepEqual(result.effects, []);
  assert.equal(result.nextState.safeSignOutRouted, false);
  assert.equal(result.nextState.revocation, 'UNCONFIRMED');
  // Just inside the window it is still forwarded.
  result = step(failed, 'safeSignOutRoute', late - 1, { outcome: 'ELIGIBLE' });
  assert.deepEqual(result.effects, [EFFECTS.FORWARD_ROUTE]);
  // Result after the window cannot record CONFIRMED.
  const routed = result.nextState;
  result = step(routed, 'safeSignOutResult', late, { outcome: 'REVOKED' });
  assert.equal(result.nextState.revocation, 'UNCONFIRMED');
  assert.equal(result.nextState.failure, 'OBSERVATION_FAILED');
  result = step(routed, 'safeSignOutResult', late - 1, { outcome: 'REVOKED' });
  assert.equal(result.nextState.revocation, 'CONFIRMED');
});

test('tick_in_done_is_a_no_op_other_events_still_flag', () => {
  const done = toDone();
  const result = step(done, 'tick', done.lastEventAtMs + 1, {});
  assert.equal(result.nextState.phase, 'DONE');
  assert.equal(result.nextState.postTerminalAnomaly, false);
  assert.deepEqual(result.effects, []);
  assert.equal(step(done, 'outage', done.lastEventAtMs + 1, { source: 'VM' }).nextState.postTerminalAnomaly, true);
});
