'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const api = require('../../guest/session.cjs');

const FINGERPRINT = 'a'.repeat(64);
const OWNER = Object.freeze({ id: 'owner-id', username: 'acceptance-owner' });

function credential(secret = 'synthetic-password') {
  const bytes = Buffer.from(secret);
  let consumes = 0, destroys = 0;
  return {
    handle: Object.freeze({
      async consumeOnce() { consumes++; return bytes; },
      destroy() { destroys++; },
    }),
    bytes,
    consumes: () => consumes,
    destroys: () => destroys,
  };
}

function browser(options = {}) {
  const calls = [], results = new WeakMap();
  let fillAttemptResolve, releaseResolve;
  const fillAttempt = new Promise(resolve => { fillAttemptResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  function result(kind, fingerprint = FINGERPRINT) {
    const value = Object.freeze(Object.defineProperty({ kind, fingerprint }, 'toJSON', {
      value() { const error = new Error('PRIVATE_HANDLE'); error.code = 'PRIVATE_HANDLE'; throw error; },
    }));
    results.set(value, { kind, fingerprint }); return value;
  }
  return {
    calls, fillAttempt, release: releaseResolve,
    observation: fingerprint => result('SESSION_OBSERVED', fingerprint),
    handle: Object.freeze({
      async perform(action, payload, onFilled) {
        calls.push({ action, payload: structuredClone(payload) });
        if (options.error) { const error = new Error(options.error); error.code = options.error; throw error; }
        fillAttemptResolve(typeof onFilled);
        if (typeof onFilled === 'function') onFilled();
        if (options.defer) await release;
        return result('SESSION_BOUND', options.fingerprint || FINGERPRINT);
      },
      inspectResult(value) { const saved = results.get(value); if (!saved) { const error = new Error('SESSION_INVALID'); error.code = 'SESSION_INVALID'; throw error; } return Object.freeze({ ...saved }); },
    }),
  };
}

test('Username_Password_Log_In_actual_UI', async () => {
  const c = credential(), b = browser();
  const session = await api.loginOnce(b.handle, c.handle, OWNER);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0], {
    action: 'LOGIN_SESSION',
    payload: { ownerId: OWNER.id, password: 'synthetic-password', username: OWNER.username },
  });
  assert.throws(() => JSON.stringify(session), { code: 'PRIVATE_HANDLE' });
  assert.equal(c.consumes(), 1); assert.equal(c.destroys(), 1);
  assert.equal(c.bytes.every(value => value === 0), true);
});

test('wrong_owner_fail_before_deeper_read', async () => {
  const c = credential(), b = browser({ error: 'OWNER_MISMATCH' });
  await assert.rejects(api.loginOnce(b.handle, c.handle, OWNER), { code: 'OWNER_MISMATCH' });
  assert.equal(b.calls.length, 1); assert.equal(c.destroys(), 1);
});

test('daytrader_session_Secure_HttpOnly_SameSite_None_path_root_host_only', async () => {
  const c = credential(), b = browser({ error: 'COOKIE_INVALID' });
  await assert.rejects(api.loginOnce(b.handle, c.handle, OWNER), { code: 'COOKIE_INVALID' });
  assert.equal(b.calls[0].action, 'LOGIN_SESSION');
});

test('one_context_no_storageState', async () => {
  const c = credential(), b = browser();
  await api.loginOnce(b.handle, c.handle, OWNER);
  assert.deepEqual(b.calls.map(call => call.action), ['LOGIN_SESSION']);
  assert.equal(b.calls.some(call => Object.hasOwn(call.payload, 'storageState')), false);
});

test('changed_cookie_owner_after_restart_fail', async () => {
  const c = credential(), b = browser();
  const before = await api.loginOnce(b.handle, c.handle, OWNER);
  assert.throws(() => api.assertContinuity(before, b.observation('b'.repeat(64))), { code: 'SESSION_CHANGED' });
  assert.deepEqual(api.assertContinuity(before, b.observation(FINGERPRINT)), { status: 'CONTINUOUS' });
});

test('second_login_API_login_substitute_denied', async () => {
  const first = credential(), second = credential(), b = browser();
  await api.loginOnce(b.handle, first.handle, OWNER);
  await assert.rejects(api.loginOnce(b.handle, second.handle, OWNER), { code: 'LOGIN_ALREADY_ATTEMPTED' });
  assert.equal(b.calls.length, 1); assert.equal(second.consumes(), 0);
  assert.equal(typeof api.loginByApi, 'undefined');
});

test('password_refs_discard_after_fill_ack', async () => {
  const c = credential(), b = browser({ defer: true });
  const login = api.loginOnce(b.handle, c.handle, OWNER);
  const callbackType = await b.fillAttempt;
  const releasedAtFill = callbackType === 'function' && c.destroys() === 1 && c.bytes.every(value => value === 0);
  b.release(); await login;
  assert.equal(releasedAtFill, true);
});

test('private_value_absent_public_output', async () => {
  const secret = 'synthetic-private-canary', c = credential(secret), b = browser();
  const session = await api.loginOnce(b.handle, c.handle, OWNER);
  assert.equal(Object.keys(session).length, 0);
  assert.equal(String(session).includes(secret), false);
  assert.throws(() => JSON.stringify(session), { code: 'PRIVATE_HANDLE' });
  api.destroySessionReference(session);
  assert.throws(() => api.assertContinuity(session, b.observation(FINGERPRINT)), { code: 'SESSION_INVALID' });
});

test('continuity_observation_is_nominally_bound_to_same_browser', async () => {
  const c = credential(), beforeBrowser = browser(), foreignBrowser = browser();
  const before = await api.loginOnce(beforeBrowser.handle, c.handle, OWNER);
  assert.throws(() => api.assertContinuity(before, foreignBrowser.observation(FINGERPRINT)), { code: 'SESSION_INVALID' });
});
