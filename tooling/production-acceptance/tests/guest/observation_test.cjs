'use strict';

// This suite is intentionally guest-only. The final appliance wires this
// source to the owned compiled frontend fixture after the native effect fence
// and synthetic credential gates are separately approved.
//
// Task 17 (T13 m-3): the suite drives the real modules. browser.cjs opens the
// BrowserSession over the native role port, session.cjs logs in once, and
// observation.cjs observes (its readiness and owner gates come from the real
// worker's SESSION_READINESS). The port supplies fixture identity and fixture
// inputs only: how to open the real browser, the synthetic owner and credential,
// the fixture's maintenance/DB receipt handles, and the fixture's backend
// restart (which yields the run's RESTART_RECEIPT handle, verified under the
// session's own release trust). It never supplies a body, a proof, an outcome
// or a verdict. P72: the post-restart interval comes only from receipts.cjs's
// session-owned transition of that same trust context.
const assert = require('node:assert/strict');
const test = require('node:test');

const observation = require('../../guest/observation.cjs');
const session = require('../../guest/session.cjs');
const { isBrowserSession } = require('../../guest/browser.cjs');
const { advanceSessionTrust } = require('../../guest/receipts.cjs');

const B = 'OBSERVE_BEFORE_RESTART', C = 'OBSERVE_AFTER_RESTART';
const PORT_METHODS = Object.freeze(['openBrowser', 'owner', 'credential', 'maintenanceReceipts', 'restartBackend', 'publicOutput']);
let nativePort = null;
function configureNative(port) {
  assert.equal(nativePort, null, 'NATIVE_OBSERVATION_ALREADY_CONFIGURED');
  for (const name of PORT_METHODS) assert.equal(typeof port?.[name], 'function', name);
  nativePort = port;
}
function port() {
  assert.equal(process.env.ACCEPTANCE_TASK15_GUEST, 'B1_QUALIFIED');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.getuid(), 10002);
  assert.ok(nativePort, 'NATIVE_OBSERVATION_PORT_UNAVAILABLE');
  return nativePort;
}
function assertView(value, routes) {
  assert.deepEqual(Object.keys(value).sort(), ['noError','renderedCount','renderedData','routeCount','schemaValidation','validEmptyState']);
  assert.equal(value.routeCount, routes);assert.equal(value.schemaValidation, true); assert.equal(value.noError, true);
  assert.equal(Number.isSafeInteger(value.renderedCount) && value.renderedCount >= 0, true);
  assert.notEqual(value.renderedData, value.validEmptyState);
  assert.equal(value.renderedData ? value.renderedCount > 0 : value.renderedCount === 0, true);
}
// One real BrowserSession and one real login per scenario; the fixture names the scenario only.
async function loggedIn(scenario) {
  const fixture = port();
  const browserSession = await fixture.openBrowser(scenario);
  assert.equal(isBrowserSession(browserSession), true, 'a BrowserSession opened by browser.cjs');
  const privateSession = await session.loginOnce(browserSession, fixture.credential(), fixture.owner());
  return { fixture, browserSession, privateSession };
}
// P72: the session's own trust context advances once, with the fixture's restart receipt.
async function restart(run) { advanceSessionTrust(run.browserSession, await run.fixture.restartBackend(run.browserSession)); }
async function observe(run, phase, sequence) {
  const maintenance = observation.validateMaintenance(run.browserSession, { ...run.fixture.maintenanceReceipts(run.browserSession, phase), phase });
  return observation.observeViews(run.browserSession, phase, { privateSession: run.privateSession, maintenance, sequence });
}

test('guest_task15_exports_only_fixed_observation_contract', () => {
  assert.deepEqual(Object.keys(observation).sort(), ['observeViews', 'readinessPredicate', 'validateMaintenance']);
});

test('compiled_frontend_before_restart_has_readiness_maintenance_and_three_meaningful_views', async () => {
  const result = await observe(await loggedIn('POPULATED'), B, 1);
  assert.equal(result.readiness,true);assert.equal(result.maintenance,true);
  assert.deepEqual(Object.keys(result.views).sort(), ['ACTIVITY','PORTFOLIO','ROBO']);
  assertView(result.views.ROBO,7); assertView(result.views.PORTFOLIO,2);assertView(result.views.ACTIVITY,3);
  for(const view of Object.values(result.views)){assert.equal(view.renderedData,true);assert.equal(view.validEmptyState,false);}
});

test('compiled_frontend_legitimate_empty_fixture_has_zero_visible_rows', async () => {
  const result=await observe(await loggedIn('VALID_EMPTY'), B, 1);
  for(const view of Object.values(result.views)){
    assertView(view,view===result.views.ROBO?7:view===result.views.PORTFOLIO?2:3);
    assert.equal(view.validEmptyState,true);assert.equal(view.renderedData,false);assert.equal(view.renderedCount,0);
  }
});

test('compiled_frontend_after_restart_rechecks_readiness_owner_and_robo_on_the_same_private_session', async () => {
  const run = await loggedIn('POPULATED');
  await observe(run, B, 1);
  await restart(run);
  const result = await observe(run, C, 2);
  assert.deepEqual(Object.keys(result.views), ['ROBO']);
  assertView(result.views.ROBO,7);
});

test('compiled_frontend_empty_error_schema_readiness_owner_and_session_negative_fixtures_are_enforced', async () => {
  for(const [scenario,code] of [['ERROR_FALLBACK','OBSERVATION_FAILED'],['SCHEMA_MALFORMED','OBSERVATION_FAILED'],
    ['READINESS_NOT_PASSING','READINESS_FAILED'],['READINESS_HTTP_503','READINESS_FAILED'],
    ['PRIVATE_SESSION_CHANGED','SESSION_MISMATCH'],['EXPIRED_MAINTENANCE','READINESS_FAILED']]){
    await assert.rejects(async () => observe(await loggedIn(scenario), B, 1),{code},scenario);
  }
  // Post-restart owner continuity: the fixture's backend answers /api/me for another owner after its restart.
  const run = await loggedIn('OWNER_CHANGED_AFTER_RESTART');
  await observe(run, B, 1);
  await restart(run);
  await assert.rejects(observe(run, C, 2), { code: 'IDENTITY_MISMATCH' });
});

test('guest_task15_public_output_excludes_private_bodies_financial_values_and_identity', () => {
  const output = port().publicOutput();assert.equal(typeof output, 'string');
  for (const forbidden of ['daytrader_session','cookie','password','owner-id','username','symbol','balance','equity','cash','position','owner-paper-maintenance']) {
    assert.equal(output.toLowerCase().includes(forbidden), false, forbidden);
  }
});

module.exports = Object.freeze({ configureNative });
