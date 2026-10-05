'use strict';

// This suite is intentionally guest-only. The final appliance wires this
// source to the owned compiled frontend fixture after the native effect fence
// and synthetic credential gates are separately approved.
const assert = require('node:assert/strict');
const test = require('node:test');

const observation = require('../../guest/observation.cjs');

let nativePort = null;
function configureNative(port) {
  assert.equal(nativePort, null, 'NATIVE_OBSERVATION_ALREADY_CONFIGURED');
  for (const name of ['inputs', 'negativeInputs', 'publicOutput']) assert.equal(typeof port?.[name], 'function');
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
async function runObservation(phase, input, scenario='POPULATED') {
  const selected=input||await port().inputs(phase,scenario);
  assert.deepEqual(Object.keys(selected).sort(), ['browserSession','maintenanceEvidence','privateSession','readinessBody']);
  return observation.observeViews(selected.browserSession,phase,{
    privateSession:selected.privateSession,
    readiness:observation.validateReadiness(selected.readinessBody),
    maintenance:observation.validateMaintenance(selected.maintenanceEvidence),
  });
}

test('guest_task15_exports_only_fixed_observation_contract', () => {
  assert.deepEqual(Object.keys(observation).sort(), ['observeViews', 'validateMaintenance', 'validateReadiness']);
});

test('compiled_frontend_before_restart_has_readiness_maintenance_and_three_meaningful_views', async () => {
  const result = await runObservation('OBSERVE_BEFORE_RESTART',undefined,'POPULATED');
  assert.equal(result.readiness,true);assert.equal(result.maintenance,true);
  assert.deepEqual(Object.keys(result.views).sort(), ['ACTIVITY','PORTFOLIO','ROBO']);
  assertView(result.views.ROBO,7); assertView(result.views.PORTFOLIO,2);assertView(result.views.ACTIVITY,3);
  for(const view of Object.values(result.views)){assert.equal(view.renderedData,true);assert.equal(view.validEmptyState,false);}
});

test('compiled_frontend_legitimate_empty_fixture_has_zero_visible_rows', async () => {
  const result=await runObservation('OBSERVE_BEFORE_RESTART',undefined,'VALID_EMPTY');
  for(const view of Object.values(result.views)){
    assertView(view,view===result.views.ROBO?7:view===result.views.PORTFOLIO?2:3);
    assert.equal(view.validEmptyState,true);assert.equal(view.renderedData,false);assert.equal(view.renderedCount,0);
  }
});

test('compiled_frontend_after_restart_rechecks_robo_and_same_private_session_only', async () => {
  const result = await runObservation('OBSERVE_AFTER_RESTART',undefined,'POPULATED');
  assert.deepEqual(Object.keys(result.views), ['ROBO']);
  assertView(result.views.ROBO,7);
});

test('compiled_frontend_empty_error_schema_and_session_negative_fixtures_are_enforced', async () => {
  for(const [name,code] of [['ERROR_FALLBACK','OBSERVATION_FAILED'],['SCHEMA_MALFORMED','OBSERVATION_FAILED'],
    ['PRIVATE_SESSION_CHANGED','SESSION_MISMATCH'],['EXPIRED_MAINTENANCE','READINESS_FAILED']]){
    await assert.rejects(runObservation('OBSERVE_BEFORE_RESTART',await port().negativeInputs(name)),{code},name);
  }
});

test('guest_task15_public_output_excludes_private_bodies_financial_values_and_identity', () => {
  const output = port().publicOutput();assert.equal(typeof output, 'string');
  for (const forbidden of ['daytrader_session','cookie','password','owner-id','username','symbol','balance','equity','cash','position']) {
    assert.equal(output.toLowerCase().includes(forbidden), false, forbidden);
  }
});

module.exports = Object.freeze({ configureNative });
