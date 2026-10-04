'use strict';

const schema = require('../contracts/schema.json');

const PHASES = Object.freeze([...schema.definitions.Phase.values]);
const FAILURE_CODES = new Set(schema.definitions.Failure.values);
const CONTROL_EVENTS = new Set(Object.values(schema.phaseEvents).flat());
const INTERNAL_EVENTS = new Set(['budget', 'outage']);
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

function validState(state) {
  if (!exactKeys(state, STATE_KEYS)) return false;
  if (state.version !== 1 || typeof state.runId !== 'string' || !/^[0-9a-f]{32}$/.test(state.runId)) return false;
  if (!safeInteger(state.sequence) || !PHASES.includes(state.phase)) return false;
  if (![state.runStartedAtMs, state.phaseStartedAtMs, state.lastEventAtMs].every(safeInteger)) return false;
  if (state.phaseStartedAtMs < state.runStartedAtMs || state.lastEventAtMs < state.phaseStartedAtMs) return false;
  if (state.sessionExpiresAtMs !== null && !safeInteger(state.sessionExpiresAtMs)) return false;
  if (state.cleanupStartedAtMs !== null && !safeInteger(state.cleanupStartedAtMs)) return false;
  for (const key of ['credentialConsumed', 'loginAttempted', 'authenticated', 'restartReceiptConsumed', 'logoutAttempted', 'cleanupComplete']) {
    if (typeof state[key] !== 'boolean') return false;
  }
  if (state.failure !== null && !FAILURE_CODES.has(state.failure)) return false;
  if ((state.phase === 'FAILED') !== (state.failure !== null)) return false;
  if (state.phase === 'DONE' && !state.cleanupComplete) return false;
  return true;
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
  const failure = state.failure ?? (FAILURE_CODES.has(code) ? code : 'INTERNAL_FAILURE');
  if (state.phase === 'FAILED') {
    return advance(state, event, nowMs, { failure }, []);
  }
  const effects = [];
  let logoutAttempted = state.logoutAttempted;
  if (allowSafeSignOut && state.authenticated && !logoutAttempted) {
    logoutAttempted = true;
    effects.push(EFFECTS.SAFE_SIGN_OUT);
  }
  effects.push(EFFECTS.CLEANUP);
  return advance(state, event, nowMs, {
    phase: 'FAILED',
    phaseStartedAtMs: nowMs,
    cleanupStartedAtMs: state.cleanupStartedAtMs ?? nowMs,
    cleanupComplete: false,
    logoutAttempted,
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
    case 'outage': return exactKeys(event, [...COMMON_EVENT_KEYS, 'source']) && ['BROKER', 'PROXY', 'TERMINAL', 'VM'].includes(event.source);
    default: return false;
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

  if (state.phase === 'FAILED') {
    if (event.type === 'readResult') return advance(state, event, nowMs, {}, [EFFECTS.READ_FAILURE]);
    if (event.type !== 'cleanup') return advance(state, event, nowMs, {}, []);
    if (state.cleanupComplete) return advance(state, event, nowMs, {}, []);
    if (state.cleanupStartedAtMs === null || nowMs - state.cleanupStartedAtMs >= LIMITS.CLEANUP_MS) {
      return advance(state, event, nowMs, {}, []);
    }
    return advance(state, event, nowMs, {
      cleanupComplete: event.outcome === 'PASS',
    }, []);
  }

  if (state.phase === 'DONE') {
    if (event.type === 'readResult') return advance(state, event, nowMs, {}, [EFFECTS.READ_RESULT]);
    return fail(state, event, nowMs, invalidCode(event.type));
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
    if (!['AUTHENTICATING', 'OBSERVE_BEFORE_RESTART', 'OBSERVE_AFTER_RESTART', 'LOGOUT', 'VERIFY_REVOCATION'].includes(state.phase)) {
      return fail(state, event, nowMs, 'ROUTE_DENIED');
    }
    return event.outcome === 'ELIGIBLE'
      ? advance(state, event, nowMs, {}, [EFFECTS.FORWARD_ROUTE])
      : fail(state, event, nowMs, 'BUDGET_EXCEEDED');
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
        phase: 'FINALIZE', phaseStartedAtMs: nowMs, cleanupStartedAtMs: nowMs,
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

module.exports = Object.freeze({ PHASES, EFFECTS, LIMITS, reduce });
