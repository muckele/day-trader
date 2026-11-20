'use strict';

// Task 14's real browser/UI suite is intentionally unavailable until the
// final appliance, native B1 effect fence, Task 22 wiring, owned compiled
// frontend fixture and synthetic credential gates are separately approved.
//
// Task 17 (T13 m-3): the suite drives the real modules (browser.cjs, session.cjs,
// observation.cjs). The port supplies fixture identity and fixture inputs only:
// how to open the real browser, the synthetic owner and one-shot credential,
// the fixture's maintenance/DB receipt handles and the fixture's backend restart.
// Every status asserted here is produced by the real modules, never by the port.
const assert = require('node:assert/strict');
const test = require('node:test');

const session = require('../../guest/session.cjs');
const observation = require('../../guest/observation.cjs');
const { isBrowserSession } = require('../../guest/browser.cjs');

const B = 'OBSERVE_BEFORE_RESTART', C = 'OBSERVE_AFTER_RESTART';
const PORT_METHODS = Object.freeze(['openBrowser', 'owner', 'credential', 'maintenanceReceipts', 'restartBackend', 'publicOutput']);
let nativePort = null;
function configureNative(port) {
  assert.equal(nativePort, null, 'NATIVE_SESSION_ALREADY_CONFIGURED');
  for (const name of PORT_METHODS) assert.equal(typeof port?.[name], 'function', name);
  nativePort = port;
}
function port() {
  assert.equal(process.env.ACCEPTANCE_TASK14_GUEST, 'B1_QUALIFIED');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.getuid(), 10002);
  assert.ok(nativePort, 'NATIVE_SESSION_PORT_UNAVAILABLE');
  return nativePort;
}
async function opened() {
  const fixture = port(), browserSession = await fixture.openBrowser('POPULATED');
  assert.equal(isBrowserSession(browserSession), true, 'a BrowserSession opened by browser.cjs');
  return { fixture, browserSession };
}

test('actual synthetic UI login binds exact private owner and cookie', async () => {
  const { fixture, browserSession } = await opened();
  const privateSession = await session.loginOnce(browserSession, fixture.credential(), fixture.owner());
  assert.throws(() => JSON.stringify(privateSession), { code: 'PRIVATE_HANDLE' });
  // The bound cookie is still the session's own: a fresh observation is continuous.
  assert.deepEqual(session.assertContinuity(privateSession, await browserSession.perform('SESSION_OBSERVATION', {})), { status: 'CONTINUOUS' });
  // One login per BrowserSession.
  await assert.rejects(session.loginOnce(browserSession, fixture.credential(), fixture.owner()), { code: 'LOGIN_ALREADY_ATTEMPTED' });
});

test('same context and private session survive synthetic backend restart', async () => {
  // T13 m-4: post-restart continuity is phase-bound and includes the owner: the AFTER observation
  // re-reads readiness and /api/me through the worker and compares the owner digest privately.
  const { fixture, browserSession } = await opened();
  const privateSession = await session.loginOnce(browserSession, fixture.credential(), fixture.owner());
  const observe = (phase, sequence) => observation.observeViews(browserSession, phase, { privateSession, sequence,
    maintenance: observation.validateMaintenance(browserSession, { ...fixture.maintenanceReceipts(browserSession, phase), phase }) });
  const stale = await browserSession.perform('SESSION_OBSERVATION', {});
  await observe(B, 1);
  await fixture.restartBackend();
  const after = await observe(C, 2);
  assert.deepEqual(Object.keys(after.views), ['ROBO']);
  // An observation from before the restart cannot stand in for continuity after it.
  assert.throws(() => session.assertContinuity(privateSession, stale), { code: 'SESSION_INVALID' });
});

test('private credential owner and cookie never enter public output', () => {
  const output = port().publicOutput();
  assert.equal(typeof output, 'string');
  for (const forbidden of ['password', 'daytrader_session', 'cookie', 'owner-id']) assert.equal(output.includes(forbidden), false);
});

module.exports = Object.freeze({ configureNative });
