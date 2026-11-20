'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const api = require('../../guest/session.cjs');
// Task 16 (T13 I-8): loginOnce accepts only a branded BrowserSession, so every test here
// uses a real one. Session-layer cases use a real controller with a scripted worker; the
// T13 m-5 tests (and the UI and context tests) drive the real worker harness.
const { startHarness, closeHarness, scriptedSession, settled, decodedFrames } = require('./browser.test.cjs');

const FINGERPRINT = 'a'.repeat(64);
const OWNER = Object.freeze({ id: 'owner-id', username: 'acceptance-owner' });
// The real worker harness's /api/me answers this owner.
const HARNESS_OWNER = Object.freeze({ id: 'owner-id', username: 'synthetic-owner' });

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

// A real BrowserSession with a scripted worker. `observation(fingerprint)` performs a real
// SESSION_OBSERVATION whose worker-reported fingerprint is the given one.
async function browser(options = {}) {
  let fingerprint = FINGERPRINT;
  const scripted = await scriptedSession({ hooks: { fingerprint: () => fingerprint, beforeBound: options.beforeBound } });
  return {
    handle: scripted.session,
    calls: () => scripted.actions().map(({ action, payload }) => ({ action, payload })),
    async observation(value) { fingerprint = value; return scripted.session.perform('SESSION_OBSERVATION', {}); },
  };
}

test('Username_Password_Log_In_actual_UI', async () => {
  const c = credential(), h = await startHarness();
  const session = await api.loginOnce(h.session, c.handle, HARNESS_OWNER);
  const actions = decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION');
  assert.deepEqual(actions.map(frame => frame.payload), [{
    actionId: 1, action: 'LOGIN_SESSION',
    payload: { ownerId: HARNESS_OWNER.id, password: 'synthetic-password', username: HARNESS_OWNER.username },
  }]);
  // The real worker filled the Username and Password placeholders and clicked "Log In".
  assert.deepEqual(JSON.parse(JSON.stringify(h.fake.calls.selectors.slice(-3))), [
    ['placeholder', 'Username', HARNESS_OWNER.username], ['placeholder', 'Password', 'synthetic-password'],
    ['role', 'button', { name: 'Log In', exact: true }],
  ]);
  assert.throws(() => JSON.stringify(session), { code: 'PRIVATE_HANDLE' });
  assert.equal(c.consumes(), 1); assert.equal(c.destroys(), 1);
  assert.equal(c.bytes.every(value => value === 0), true);
  await closeHarness(h);
});

test('wrong_owner_fail_before_deeper_read', async () => {
  // T13 m-5: through the real worker. /api/me names a different owner id, or a different username.
  for (const fake of [{ ownerId: 'different-owner' }, { ownerUsername: 'different-username' }]) {
    const c = credential(), h = await startHarness({ fake });
    await assert.rejects(api.loginOnce(h.session, c.handle, HARNESS_OWNER), { code: 'IDENTITY_MISMATCH', workerCode: 'OWNER_MISMATCH' }, JSON.stringify(fake));
    assert.equal(c.consumes(), 1); assert.equal(c.destroys(), 1);
    assert.equal(c.bytes.every(value => value === 0), true);
    // Nothing deeper was read: no fixed GET, no view navigation, and the session is latched.
    assert.equal(h.fake.calls.events.some(event => event.startsWith('evaluate:')), false);
    assert.equal(h.fake.calls.selectors.some(row => row[0] === 'role' && row[1] === 'link'), false);
    assert.equal(await settled(() => h.session.failureCode() !== null), true);
    await assert.rejects(h.session.perform('OBSERVE_VIEW', { phase: 'OBSERVE_BEFORE_RESTART', view: 'ROBO' }), { code: 'IDENTITY_MISMATCH' });
    assert.equal(decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').length, 1);
  }
});

test('daytrader_session_Secure_HttpOnly_SameSite_None_path_root_host_only', async () => {
  // T13 m-5: through the real worker. Only a Secure, HttpOnly, SameSite=None, path=/, host-only
  // daytrader_session cookie for the backend host binds the session.
  const good = await startHarness(), accepted = credential();
  await api.loginOnce(good.session, accepted.handle, HARNESS_OWNER);
  await closeHarness(good);
  for (const cookie of [
    { secure: false }, { httpOnly: false }, { sameSite: 'Lax' }, { sameSite: 'Strict' }, { path: '/api' },
    { domain: '.backend.example.test' }, { domain: 'frontend.example.test' }, { name: 'other_session' },
  ]) {
    const c = credential(), h = await startHarness({ fake: { cookie } });
    await assert.rejects(api.loginOnce(h.session, c.handle, HARNESS_OWNER), { code: 'SESSION_MISMATCH', workerCode: 'COOKIE_INVALID' }, JSON.stringify(cookie));
    assert.equal(c.destroys(), 1, JSON.stringify(cookie));
  }
});

test('one_context_no_storageState', async () => {
  const c = credential(), h = await startHarness();
  await api.loginOnce(h.session, c.handle, HARNESS_OWNER);
  assert.equal(h.fake.calls.contexts.length, 1);
  assert.equal(Object.hasOwn(h.fake.calls.contexts[0], 'storageState'), false);
  assert.equal(h.fake.calls.persistent.length, 0);
  const actions = decodedFrames(h.links.logs, 'controller').filter(frame => frame.type === 'ACTION').map(frame => frame.payload);
  assert.deepEqual(actions.map(action => action.action), ['LOGIN_SESSION']);
  assert.equal(actions.some(action => Object.hasOwn(action.payload, 'storageState')), false);
  await closeHarness(h);
});

test('changed_cookie_owner_after_restart_fail', async () => {
  const c = credential(), b = await browser();
  const before = await api.loginOnce(b.handle, c.handle, OWNER);
  const changed = await b.observation('b'.repeat(64));
  assert.throws(() => api.assertContinuity(before, changed), { code: 'SESSION_CHANGED' });
  const same = await b.observation(FINGERPRINT);
  assert.deepEqual(api.assertContinuity(before, same), { status: 'CONTINUOUS' });
});

test('second_login_API_login_substitute_denied', async () => {
  const first = credential(), second = credential(), b = await browser();
  await api.loginOnce(b.handle, first.handle, OWNER);
  await assert.rejects(api.loginOnce(b.handle, second.handle, OWNER), { code: 'LOGIN_ALREADY_ATTEMPTED' });
  assert.equal(b.calls().length, 1); assert.equal(second.consumes(), 0);
  assert.equal(typeof api.loginByApi, 'undefined');
});

test('password_refs_discard_after_fill_ack', async () => {
  // The worker's FILLED acknowledgement alone releases the credential, while its result is still held.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const c = credential(), b = await browser({ beforeBound: () => held });
  let done = false;
  const login = api.loginOnce(b.handle, c.handle, OWNER).then(value => { done = true; return value; });
  assert.equal(await settled(() => c.destroys() === 1), true);
  assert.equal(c.bytes.every(value => value === 0), true);
  assert.equal(done, false);
  release(); await login;
  assert.equal(c.destroys(), 1);
});

test('private_value_absent_public_output', async () => {
  const secret = 'synthetic-private-canary', c = credential(secret), b = await browser();
  const session = await api.loginOnce(b.handle, c.handle, OWNER);
  assert.equal(Object.keys(session).length, 0);
  assert.equal(String(session).includes(secret), false);
  assert.throws(() => JSON.stringify(session), { code: 'PRIVATE_HANDLE' });
  api.destroySessionReference(session);
  const observed = await b.observation(FINGERPRINT);
  assert.throws(() => api.assertContinuity(session, observed), { code: 'SESSION_INVALID' });
});

test('continuity_observation_is_nominally_bound_to_same_browser', async () => {
  const c = credential(), beforeBrowser = await browser(), foreignBrowser = await browser();
  const before = await api.loginOnce(beforeBrowser.handle, c.handle, OWNER);
  const foreign = await foreignBrowser.observation(FINGERPRINT);
  assert.throws(() => api.assertContinuity(before, foreign), { code: 'SESSION_INVALID' });
  const own = await beforeBrowser.observation(FINGERPRINT);
  assert.deepEqual(api.assertContinuity(before, own), { status: 'CONTINUOUS' });
});
