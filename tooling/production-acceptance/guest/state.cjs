'use strict';

const schema = require('../contracts/schema.json');

const PHASES = Object.freeze([...schema.definitions.Phase.values]);
const FAILURE_CODES = new Set(schema.definitions.Failure.values);
const CONTROL_EVENTS = new Set(Object.values(schema.phaseEvents).flat());
const INTERNAL_EVENTS = new Set(['budget', 'outage', 'safeSignOutRoute', 'safeSignOutResult', 'tick']);
const REVOCATIONS = Object.freeze(['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'UNCONFIRMED']);
const AUTHENTICATED_PHASES = new Set([
  'OBSERVE_BEFORE_RESTART', 'HOLD_FOR_RESTART', 'OBSERVE_AFTER_RESTART', 'LOGOUT',
]);

const LIMITS = Object.freeze({
  RUN_MS: 20 * 60 * 1000,
  HOLD_MS: 10 * 60 * 1000,
  INTAKE_MS: 120 * 1000,
  CLEANUP_MS: 60 * 1000,
});

const EFFECTS = Object.freeze({
  REQUEST_CREDENTIAL: 'REQUEST_CREDENTIAL',
  LOGIN: 'LOGIN',
  OBSERVE_BEFORE: 'OBSERVE_BEFORE',
  ENTER_HOLD: 'ENTER_HOLD',
  OBSERVE_AFTER: 'OBSERVE_AFTER',
  SIGN_OUT: 'SIGN_OUT',
  VERIFY_REVOCATION: 'VERIFY_REVOCATION',
  FINALIZE: 'FINALIZE',
  PUBLISH_RESULT: 'PUBLISH_RESULT',
  READ_RESULT: 'READ_RESULT',
  READ_FAILURE: 'READ_FAILURE',
  SAFE_SIGN_OUT: 'SAFE_SIGN_OUT',
  CLEANUP: 'CLEANUP',
  FORWARD_ROUTE: 'FORWARD_ROUTE',
});

const STATE_KEYS = Object.freeze([
  'version', 'runId', 'sequence', 'phase', 'runStartedAtMs', 'phaseStartedAtMs',
  'lastEventAtMs', 'sessionExpiresAtMs', 'credentialConsumed', 'loginAttempted',
  'authenticated', 'restartReceiptConsumed', 'logoutAttempted',
  'cleanupStartedAtMs', 'cleanupComplete', 'failure',
  'sessionMaybeIssued', 'safeSignOutRouted', 'revocation', 'postTerminalAnomaly',
  'cleanupFailed',
]);
const COMMON_EVENT_KEYS = Object.freeze(['type', 'runId', 'sequence']);

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

// Per-phase invariants (Task 13, T12-I4; P19). A state is valid only if it is
// the shape this reducer can itself produce in that phase.
//   c credentialConsumed, l loginAttempted, a authenticated, i sessionMaybeIssued,
//   r restartReceiptConsumed, o logoutAttempted, e sessionExpiresAtMs non-null,
//   s cleanupStartedAtMs non-null, k cleanupComplete, v revocation.
// P19: VERIFY_REVOCATION, FINALIZE and DONE have already logged out, so
// authenticated is false there; the authenticated phases before logout require true.
const PHASE_SHAPE = Object.freeze({
  PREFLIGHT: { c: false, l: false, a: false, i: false, r: false, o: false, e: false, s: false, k: false, v: 'NOT_REQUIRED' },
  AWAIT_CREDENTIAL: { c: false, l: false, a: false, i: false, r: false, o: false, e: false, s: false, k: false, v: 'NOT_REQUIRED' },
  AUTHENTICATING: { c: true, l: false, a: false, i: true, r: false, o: false, e: false, s: false, k: false, v: 'PENDING' },
  OBSERVE_BEFORE_RESTART: { c: true, l: true, a: true, i: true, r: false, o: false, e: true, s: false, k: false, v: 'PENDING' },
  HOLD_FOR_RESTART: { c: true, l: true, a: true, i: true, r: false, o: false, e: true, s: false, k: false, v: 'PENDING' },
  OBSERVE_AFTER_RESTART: { c: true, l: true, a: true, i: true, r: true, o: false, e: true, s: false, k: false, v: 'PENDING' },
  LOGOUT: { c: true, l: true, a: true, i: true, r: true, o: true, e: true, s: false, k: false, v: 'PENDING' },
  VERIFY_REVOCATION: { c: true, l: true, a: false, i: true, r: true, o: true, e: true, s: false, k: false, v: 'PENDING' },
  FINALIZE: { c: true, l: true, a: false, i: true, r: true, o: true, e: true, s: true, k: false, v: 'CONFIRMED' },
  DONE: { c: true, l: true, a: false, i: true, r: true, o: true, e: true, s: true, k: true, v: 'CONFIRMED' },
});

function phaseShapeMatches(state, shape) {
  return state.credentialConsumed === shape.c && state.loginAttempted === shape.l
    && state.authenticated === shape.a && state.sessionMaybeIssued === shape.i
    && state.restartReceiptConsumed === shape.r && state.logoutAttempted === shape.o
    && (state.sessionExpiresAtMs !== null) === shape.e
    && (state.cleanupStartedAtMs !== null) === shape.s
    && state.cleanupComplete === shape.k && state.revocation === shape.v;
}

function validState(state) {
  if (!exactKeys(state, STATE_KEYS)) return false;
  if (state.version !== 1 || typeof state.runId !== 'string' || !/^[0-9a-f]{32}$/.test(state.runId)) return false;
  if (!safeInteger(state.sequence) || !PHASES.includes(state.phase)) return false;
  if (![state.runStartedAtMs, state.phaseStartedAtMs, state.lastEventAtMs].every(safeInteger)) return false;
  if (state.phaseStartedAtMs < state.runStartedAtMs || state.lastEventAtMs < state.phaseStartedAtMs) return false;
  if (state.sessionExpiresAtMs !== null && !safeInteger(state.sessionExpiresAtMs)) return false;
  if (state.cleanupStartedAtMs !== null && !safeInteger(state.cleanupStartedAtMs)) return false;
  for (const key of ['credentialConsumed', 'loginAttempted', 'authenticated', 'restartReceiptConsumed', 'logoutAttempted', 'cleanupComplete', 'sessionMaybeIssued', 'safeSignOutRouted', 'postTerminalAnomaly', 'cleanupFailed']) {
    if (typeof state[key] !== 'boolean') return false;
  }
  if (!REVOCATIONS.includes(state.revocation)) return false;
  if (state.failure !== null && !FAILURE_CODES.has(state.failure)) return false;
  if ((state.phase === 'FAILED') !== (state.failure !== null)) return false;
  if (state.phase === 'FAILED') {
    if (state.cleanupStartedAtMs === null) return false;
    if (state.cleanupComplete && state.cleanupFailed) return false;
    if ((state.revocation !== 'NOT_REQUIRED') !== state.sessionMaybeIssued) return false;
    if (state.revocation === 'PENDING' && !state.logoutAttempted) return false;
    if (state.safeSignOutRouted && !state.logoutAttempted) return false;
    if (state.authenticated && !state.loginAttempted) return false;
    if (state.postTerminalAnomaly) return false;
    return true;
  }
  if (state.safeSignOutRouted || state.cleanupFailed) return false;
  if (state.postTerminalAnomaly && state.phase !== 'DONE') return false;
  return phaseShapeMatches(state, PHASE_SHAPE[state.phase]);
}

// The only constructor for a fresh ControllerState (T12-I4). Hand-built states
// are accepted by reduce() only if validState() holds.
// sessionExpiresAtMs is on the guest monotonic clock; Task 22 converts the
// server's expiry into that domain before it reaches this reducer.
// Restart non-resumption is NOT enforced here: Tasks 21-22 and the durable
// full-run reservation own it (a restarted process never reuses a state).
function initialState(runId, nowMs) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{32}$/.test(runId) || !safeInteger(nowMs)) {
    throw new TypeError('invalid initialState arguments');
  }
  return Object.freeze({
    version: 1,
    runId,
    sequence: 0,
    phase: 'PREFLIGHT',
    runStartedAtMs: nowMs,
    phaseStartedAtMs: nowMs,
    lastEventAtMs: nowMs,
    sessionExpiresAtMs: null,
    credentialConsumed: false,
    loginAttempted: false,
    authenticated: false,
    restartReceiptConsumed: false,
    logoutAttempted: false,
    cleanupStartedAtMs: null,
    cleanupComplete: false,
    failure: null,
    sessionMaybeIssued: false,
    safeSignOutRouted: false,
    revocation: 'NOT_REQUIRED',
    postTerminalAnomaly: false,
    cleanupFailed: false,
  });
}

function freezeTransition(nextState, effects) {
  const frozenState = Object.freeze(nextState);
  const frozenEffects = Object.freeze([...effects]);
  return Object.freeze({
    nextState: frozenState,
    effects: frozenEffects,
    failureCode: frozenState.failure,
  });
}

function advance(state, event, nowMs, patch, effects = []) {
  return freezeTransition({
    ...state,
    ...patch,
    sequence: event.sequence,
    lastEventAtMs: nowMs,
  }, effects);
}

function fail(state, event, nowMs, code, allowSafeSignOut = false) {
  if (state.phase === 'DONE') {
    // DONE is terminal: stray events only record an anomaly (T12-M1).
    return advance(state, event, nowMs, { postTerminalAnomaly: true }, []);
  }
  const failure = state.failure ?? (FAILURE_CODES.has(code) ? code : 'INTERNAL_FAILURE');
  if (state.phase === 'FAILED') {
    return advance(state, event, nowMs, { failure }, []);
  }
  const effects = [];
  let logoutAttempted = state.logoutAttempted;
  let revocation = state.revocation;
  if (allowSafeSignOut && state.sessionMaybeIssued && !logoutAttempted) {
    logoutAttempted = true;
    effects.push(EFFECTS.SAFE_SIGN_OUT);
  } else if (revocation === 'PENDING') {
    revocation = 'UNCONFIRMED';
  }
  effects.push(EFFECTS.CLEANUP);
  return advance(state, event, nowMs, {
    phase: 'FAILED',
    phaseStartedAtMs: nowMs,
    cleanupStartedAtMs: state.cleanupStartedAtMs ?? nowMs,
    cleanupComplete: false,
    logoutAttempted,
    revocation,
    failure,
  }, effects);
}

function invalidCode(type) {
  if (type === 'consumeCredential') return 'CREDENTIAL_INVALID';
  if (type === 'login') return 'SESSION_MISMATCH';
  if (type === 'acceptRestartReceipt') return 'IDENTITY_MISMATCH';
  return 'INVALID_FRAME';
}

function expectedEvent(state, event) {
  return schema.phaseEvents[state.phase].includes(event.type);
}

function eventShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  switch (event.type) {
    case 'validate': return exactKeys(event, [...COMMON_EVENT_KEYS, 'admission']) && event.admission === 'VERIFIED';
    case 'consumeCredential': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['CONSUMED', 'REJECTED'].includes(event.outcome);
    case 'login': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome', 'sessionExpiresAtMs']) && ['SUCCEEDED', 'FAILED'].includes(event.outcome) && safeInteger(event.sessionExpiresAtMs);
    case 'observeBefore':
    case 'observeAfter': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['PASS', 'FAIL'].includes(event.outcome);
    case 'signOut': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['REVOKED', 'FAILED'].includes(event.outcome);
    case 'verifyRevocation':
    case 'finalize': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['PASS', 'FAIL'].includes(event.outcome);
    case 'acceptRestartReceipt': return exactKeys(event, [...COMMON_EVENT_KEYS, 'status']) && ['VERIFIED', 'REJECTED'].includes(event.status);
    case 'abort': return exactKeys(event, [...COMMON_EVENT_KEYS, 'code', 'boundaryTrusted']) && FAILURE_CODES.has(event.code) && typeof event.boundaryTrusted === 'boolean';
    case 'readResult': return exactKeys(event, COMMON_EVENT_KEYS);
    case 'cleanup': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['PASS', 'FAIL'].includes(event.outcome);
    case 'budget': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['ELIGIBLE', 'DENIED'].includes(event.outcome);
    case 'safeSignOutRoute': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['ELIGIBLE', 'DENIED'].includes(event.outcome);
    case 'safeSignOutResult': return exactKeys(event, [...COMMON_EVENT_KEYS, 'outcome']) && ['REVOKED', 'FAILED'].includes(event.outcome);
    case 'tick': return exactKeys(event, COMMON_EVENT_KEYS);
    case 'outage': return exactKeys(event, [...COMMON_EVENT_KEYS, 'source']) && ['BROKER', 'PROXY', 'TERMINAL', 'VM'].includes(event.source);
    default: return false;
  }
}

function reduceFailed(state, event, nowMs) {
  const expired = nowMs - state.cleanupStartedAtMs >= LIMITS.CLEANUP_MS;
  // After the cleanup window nothing can confirm a pending revocation.
  const lapse = expired && state.revocation === 'PENDING' ? { revocation: 'UNCONFIRMED' } : {};
  switch (event.type) {
    case 'readResult':
      return advance(state, event, nowMs, {}, [EFFECTS.READ_FAILURE]);
    case 'tick':
      return advance(state, event, nowMs, {
        ...lapse,
        ...(expired && !state.cleanupComplete ? { cleanupFailed: true } : {}),
      }, []);
    case 'cleanup':
      if (state.cleanupComplete || state.cleanupFailed) return advance(state, event, nowMs, {}, []);
      if (expired) return advance(state, event, nowMs, { ...lapse, cleanupFailed: true }, []);
      // The first FAIL is sticky: a later PASS cannot erase it (T12-M2).
      return event.outcome === 'PASS'
        ? advance(state, event, nowMs, { cleanupComplete: true }, [])
        : advance(state, event, nowMs, { cleanupFailed: true }, []);
    case 'safeSignOutRoute':
      if (state.revocation !== 'PENDING' || state.safeSignOutRouted) return advance(state, event, nowMs, {}, []);
      if (expired) return advance(state, event, nowMs, lapse, []);
      return event.outcome === 'ELIGIBLE'
        ? advance(state, event, nowMs, { safeSignOutRouted: true }, [EFFECTS.FORWARD_ROUTE])
        : advance(state, event, nowMs, { safeSignOutRouted: true, revocation: 'UNCONFIRMED' }, []);
    case 'safeSignOutResult':
      if (state.revocation !== 'PENDING' || !state.safeSignOutRouted) return advance(state, event, nowMs, {}, []);
      if (expired) return advance(state, event, nowMs, lapse, []);
      return event.outcome === 'REVOKED'
        ? advance(state, event, nowMs, { revocation: 'CONFIRMED', authenticated: false }, [])
        : advance(state, event, nowMs, { revocation: 'UNCONFIRMED' }, []);
    default:
      return advance(state, event, nowMs, {}, []);
  }
}

function reduce(state, event, nowMs) {
  if (!validState(state)) throw new TypeError('invalid ControllerState');

  const fallbackEvent = Object.freeze({
    type: 'invalid',
    runId: state.runId,
    sequence: state.sequence + 1,
  });
  if (!safeInteger(nowMs) || nowMs < state.lastEventAtMs) {
    return fail(state, fallbackEvent, state.lastEventAtMs, 'DEADLINE');
  }
  if (!event || typeof event !== 'object' || event.runId !== state.runId) {
    return fail(state, fallbackEvent, nowMs, 'IDENTITY_MISMATCH');
  }
  if (!safeInteger(event.sequence) || event.sequence <= state.sequence) {
    return fail(state, fallbackEvent, nowMs, 'REPLAY');
  }
  if (event.sequence !== state.sequence + 1) {
    return fail(state, fallbackEvent, nowMs, 'IDENTITY_MISMATCH');
  }
  if (!eventShape(event) || (!CONTROL_EVENTS.has(event.type) && !INTERNAL_EVENTS.has(event.type))) {
    return fail(state, event, nowMs, 'INVALID_FRAME');
  }

  if (state.phase === 'FAILED') return reduceFailed(state, event, nowMs);

  if (state.phase === 'DONE') {
    if (event.type === 'readResult') return advance(state, event, nowMs, {}, [EFFECTS.READ_RESULT]);
    return advance(state, event, nowMs, { postTerminalAnomaly: true }, []);
  }

  if (nowMs - state.runStartedAtMs >= LIMITS.RUN_MS) return fail(state, event, nowMs, 'DEADLINE');
  if (state.phase === 'AWAIT_CREDENTIAL' && nowMs - state.phaseStartedAtMs >= LIMITS.INTAKE_MS) return fail(state, event, nowMs, 'DEADLINE');
  if (state.phase === 'HOLD_FOR_RESTART' && nowMs - state.phaseStartedAtMs >= LIMITS.HOLD_MS) return fail(state, event, nowMs, 'DEADLINE');
  if (state.cleanupStartedAtMs !== null && nowMs - state.cleanupStartedAtMs >= LIMITS.CLEANUP_MS) return fail(state, event, nowMs, 'CLEANUP_INCOMPLETE');
  if (AUTHENTICATED_PHASES.has(state.phase) && state.sessionExpiresAtMs !== null && nowMs >= state.sessionExpiresAtMs) {
    return fail(state, event, nowMs, 'EXPIRED');
  }

  if (event.type === 'abort') {
    return fail(state, event, nowMs, event.code, event.boundaryTrusted);
  }
  if (event.type === 'outage') return fail(state, event, nowMs, 'TRANSPORT_LOST');
  if (event.type === 'budget') {
    if (state.phase === 'HOLD_FOR_RESTART') return fail(state, event, nowMs, 'ROUTE_DENIED');
    if (!['PREFLIGHT', 'AWAIT_CREDENTIAL', 'AUTHENTICATING', 'OBSERVE_BEFORE_RESTART', 'OBSERVE_AFTER_RESTART', 'LOGOUT', 'VERIFY_REVOCATION'].includes(state.phase)) {
      return fail(state, event, nowMs, 'ROUTE_DENIED');
    }
    return event.outcome === 'ELIGIBLE'
      ? advance(state, event, nowMs, {}, [EFFECTS.FORWARD_ROUTE])
      : fail(state, event, nowMs, 'BUDGET_EXCEEDED');
  }
  if (event.type === 'tick') return advance(state, event, nowMs, {}, []);
  if (event.type === 'safeSignOutRoute' || event.type === 'safeSignOutResult') {
    return fail(state, event, nowMs, 'INVALID_FRAME');
  }
  if (!expectedEvent(state, event)) return fail(state, event, nowMs, invalidCode(event.type));

  switch (state.phase) {
    case 'PREFLIGHT':
      return advance(state, event, nowMs, {
        phase: 'AWAIT_CREDENTIAL', phaseStartedAtMs: nowMs,
      }, [EFFECTS.REQUEST_CREDENTIAL]);
    case 'AWAIT_CREDENTIAL':
      if (event.outcome !== 'CONSUMED' || state.credentialConsumed) return fail(state, event, nowMs, 'CREDENTIAL_INVALID');
      return advance(state, event, nowMs, {
        phase: 'AUTHENTICATING', phaseStartedAtMs: nowMs, credentialConsumed: true,
        sessionMaybeIssued: true, revocation: 'PENDING',
      }, [EFFECTS.LOGIN]);
    case 'AUTHENTICATING':
      if (event.outcome !== 'SUCCEEDED' || state.loginAttempted || event.sessionExpiresAtMs <= nowMs) {
        return fail(state, event, nowMs, event.sessionExpiresAtMs <= nowMs ? 'EXPIRED' : 'SESSION_MISMATCH');
      }
      return advance(state, event, nowMs, {
        phase: 'OBSERVE_BEFORE_RESTART', phaseStartedAtMs: nowMs, loginAttempted: true,
        authenticated: true, sessionExpiresAtMs: event.sessionExpiresAtMs,
      }, [EFFECTS.OBSERVE_BEFORE]);
    case 'OBSERVE_BEFORE_RESTART':
      if (event.outcome !== 'PASS') return fail(state, event, nowMs, 'OBSERVATION_FAILED');
      return advance(state, event, nowMs, {
        phase: 'HOLD_FOR_RESTART', phaseStartedAtMs: nowMs,
      }, [EFFECTS.ENTER_HOLD]);
    case 'HOLD_FOR_RESTART':
      if (event.status !== 'VERIFIED' || state.restartReceiptConsumed) return fail(state, event, nowMs, 'SIGNATURE_INVALID');
      return advance(state, event, nowMs, {
        phase: 'OBSERVE_AFTER_RESTART', phaseStartedAtMs: nowMs, restartReceiptConsumed: true,
      }, [EFFECTS.OBSERVE_AFTER]);
    case 'OBSERVE_AFTER_RESTART':
      if (event.outcome !== 'PASS') return fail(state, event, nowMs, 'OBSERVATION_FAILED');
      return advance(state, event, nowMs, {
        phase: 'LOGOUT', phaseStartedAtMs: nowMs, logoutAttempted: true,
      }, [EFFECTS.SIGN_OUT]);
    case 'LOGOUT':
      if (event.outcome !== 'REVOKED' || !state.logoutAttempted) return fail(state, event, nowMs, 'SESSION_MISMATCH');
      return advance(state, event, nowMs, {
        phase: 'VERIFY_REVOCATION', phaseStartedAtMs: nowMs, authenticated: false, logoutAttempted: true,
      }, [EFFECTS.VERIFY_REVOCATION]);
    case 'VERIFY_REVOCATION':
      if (event.outcome !== 'PASS') return fail(state, event, nowMs, 'SESSION_MISMATCH');
      return advance(state, event, nowMs, {
        phase: 'FINALIZE', phaseStartedAtMs: nowMs, cleanupStartedAtMs: nowMs, revocation: 'CONFIRMED',
      }, [EFFECTS.FINALIZE]);
    case 'FINALIZE':
      if (event.outcome !== 'PASS') return fail(state, event, nowMs, 'CLEANUP_INCOMPLETE');
      return advance(state, event, nowMs, {
        phase: 'DONE', phaseStartedAtMs: nowMs, cleanupComplete: true,
      }, [EFFECTS.PUBLISH_RESULT]);
    default:
      return fail(state, event, nowMs, 'INTERNAL_FAILURE');
  }
}

module.exports = Object.freeze({ PHASES, EFFECTS, LIMITS, STATE_KEYS, initialState, reduce });
