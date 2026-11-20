'use strict';

const { inspectReceipt } = require('./receipts.cjs');
const { assertContinuity } = require('./session.cjs');
// T13 I-8: only a BrowserSession that browser.cjs opened is observed, never a look-alike.
const { isBrowserSession } = require('./browser.cjs');

const REQUIRED_CHECKS = Object.freeze([
  'ownerConfiguration', 'authenticationConfiguration', 'databaseConnected', 'ownerIdentity',
  'ownerSettings', 'persistence', 'paperMode', 'automationDisabled', 'schedulerSuppressed',
  'paperDestination', 'paperBindingConfiguration', 'paperCredentialConfiguration',
]);
const AUTOMATION = Object.freeze({
  enabled: false,
  isEnabled: false,
  liveEnabled: false,
  schedulerSuppressed: true,
  activationAuthorized: false,
});
const VIEWS = Object.freeze({ ROBO: 7, PORTFOLIO: 2, ACTIVITY: 3 });
const PHASE_INTERVAL = Object.freeze({ OBSERVE_BEFORE_RESTART: 'BEFORE', OBSERVE_AFTER_RESTART: 'AFTER' });
const readinessProofs = new WeakMap();
const maintenanceProofs = new WeakMap();
const usedReadiness = new WeakSet();
const usedMaintenance = new WeakSet();
const mintedReadinessBodies = new WeakSet();
const mintedMaintenanceReceipts = new WeakSet();
const mintedDatabaseReceipts = new WeakSet();

function fail(code = 'OBSERVATION_FAILED', cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!object(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('OBSERVATION_FAILED');
}
function sameKeys(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function privateHandle(map, value) {
  const handle = Object.freeze(Object.defineProperty({}, 'toJSON', { value: () => fail('PRIVATE_HANDLE') }));
  map.set(handle, Object.freeze(value));
  return handle;
}
function zeroDeltas(value) {
  return sameKeys(value, ['ownerSessionGenerationIncrement', 'readinessBookkeeping', 'startupBookkeeping']) &&
    Object.values(value).every(item => item === 0);
}
function allTrue(value) {
  return object(value) && Object.values(value).length === 14 && Object.values(value).every(item => item === true);
}

function validateReadiness(body) {
  try {
    if (!object(body) || body.contractVersion !== 2 || body.profile !== 'owner-paper-maintenance' ||
        body.runtimeReady !== true || body.maintenanceReady !== true ||
        !sameKeys(body.checks, REQUIRED_CHECKS) || !sameKeys(body.automation, Object.keys(AUTOMATION))) fail('READINESS_FAILED');
    for (const name of REQUIRED_CHECKS) {
      const check = body.checks[name];
      if (!object(check) || check.status !== 'pass') fail('READINESS_FAILED');
    }
    for (const [name, expected] of Object.entries(AUTOMATION)) if (body.automation[name] !== expected) fail('READINESS_FAILED');
    if (mintedReadinessBodies.has(body)) fail('REPLAY');
    mintedReadinessBodies.add(body);
    return privateHandle(readinessProofs, { status: 'READINESS_VERIFIED' });
  } catch (cause) {
    if (['READINESS_FAILED', 'REPLAY'].includes(cause?.code)) throw cause;
    fail('READINESS_FAILED', cause);
  }
}

function validateMaintenance(evidence) {
  try {
    exact(evidence, ['trust', 'maintenanceReceipt', 'databaseReceipt', 'phase']);
    if (mintedMaintenanceReceipts.has(evidence.maintenanceReceipt) || mintedDatabaseReceipts.has(evidence.databaseReceipt)) fail('REPLAY');
    const expectedInterval = PHASE_INTERVAL[evidence.phase];
    if (!expectedInterval) fail('READINESS_FAILED');
    const maintenance = inspectReceipt(evidence.maintenanceReceipt, 'MAINTENANCE_RECEIPT', evidence.trust);
    const database = inspectReceipt(evidence.databaseReceipt, 'DB_RECEIPT', evidence.trust);
    if (!maintenance || !database || maintenance.runId !== database.runId ||
        maintenance.configIdentity !== database.configIdentity || maintenance.authority !== database.authority ||
        database.interval !== expectedInterval || maintenance.ownerExactMatch !== true || database.ownerExactMatch !== true ||
        maintenance.accountExactMatch !== true || database.accountExactMatch !== true ||
        maintenance.uniquePreexistingSettings !== true || database.uniquePreexistingSettings !== true ||
        maintenance.paperOnly !== true || maintenance.automationDisabled !== true ||
        maintenance.schedulerSuppressed !== true || maintenance.notificationWorkersSuppressed !== true ||
        maintenance.exclusiveWindow !== true || maintenance.noAutomationLease !== true ||
        maintenance.noProtectionLease !== true || maintenance.noTradingWork !== true ||
        maintenance.noCloseWork !== true || maintenance.noReconciliationWork !== true ||
        maintenance.noReservations !== true || maintenance.comparisonComplete !== true ||
        database.comparisonComplete !== true || database.concurrentWritesAccounted !== true ||
        database.configurationUnchanged !== true || database.economicUnchanged !== true ||
        database.snapshotConsistent !== true || database.ttlAccounted !== true ||
        !allTrue(maintenance.comparisonScope) || !allTrue(database.comparisonScope) ||
        !zeroDeltas(maintenance.allowedDeltas) || !zeroDeltas(database.allowedDeltas) ||
        !zeroDeltas(database.observedDeltas)) fail('READINESS_FAILED');
    mintedMaintenanceReceipts.add(evidence.maintenanceReceipt);
    mintedDatabaseReceipts.add(evidence.databaseReceipt);
    return privateHandle(maintenanceProofs, {
      phase: evidence.phase, runId: maintenance.runId, configIdentity: maintenance.configIdentity,
      trust: evidence.trust, maintenanceReceipt: evidence.maintenanceReceipt, databaseReceipt: evidence.databaseReceipt,
    });
  } catch (cause) {
    if (['READINESS_FAILED', 'REPLAY'].includes(cause?.code)) throw cause;
    fail('READINESS_FAILED', cause);
  }
}

function inspectView(session, result, phase, view, maintenance) {
  let value;
  try { value = session.inspectResult(result); } catch (cause) { fail('OBSERVATION_FAILED', cause); }
  const keys = ['kind', 'view', 'phase', 'schemaValidation', 'renderedData', 'validEmptyState', 'noError',
    'fresh', 'source', 'brokerError', 'routeCount', 'renderedCount', 'runId', 'configIdentity', 'fingerprint', 'readinessValidation'];
  if (!sameKeys(value, keys) || value.kind !== 'VIEW_OBSERVED' || value.view !== view || value.phase !== phase ||
      value.schemaValidation !== true || value.noError !== true || value.fresh !== true ||
      value.source !== 'alpaca-paper' || value.brokerError !== false || value.routeCount !== VIEWS[view] ||
      !Number.isSafeInteger(value.renderedCount) || value.renderedCount < 0 ||
      typeof value.renderedData !== 'boolean' || typeof value.validEmptyState !== 'boolean' ||
      value.renderedData === value.validEmptyState ||
      value.renderedData && value.renderedCount < 1 || value.validEmptyState && value.renderedCount !== 0) fail('OBSERVATION_FAILED');
  if (value.runId !== maintenance.runId || value.configIdentity !== maintenance.configIdentity) fail('IDENTITY_MISMATCH');
  if (!/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.readinessValidation !== 'boolean' ||
      view === 'ROBO' && value.readinessValidation !== true) fail('READINESS_FAILED');
  return Object.freeze({
    schemaValidation: true,
    renderedData: value.renderedData,
    validEmptyState: value.validEmptyState,
    noError: true,
    routeCount: value.routeCount,
    renderedCount: value.renderedCount,
  });
}
function assertMaintenanceCurrent(maintenance) {
  const currentMaintenance = inspectReceipt(maintenance.maintenanceReceipt, 'MAINTENANCE_RECEIPT', maintenance.trust);
  const currentDatabase = inspectReceipt(maintenance.databaseReceipt, 'DB_RECEIPT', maintenance.trust);
  if (!currentMaintenance || !currentDatabase || currentMaintenance.runId !== maintenance.runId || currentDatabase.runId !== maintenance.runId ||
      currentMaintenance.configIdentity !== maintenance.configIdentity || currentDatabase.configIdentity !== maintenance.configIdentity) fail('READINESS_FAILED');
}
function assertPrivateContinuity(privateSession, result) {
  try { assertContinuity(privateSession, result); }
  catch (cause) { fail(cause?.code === 'SESSION_CHANGED' ? 'SESSION_MISMATCH' : 'OBSERVATION_FAILED', cause); }
}

async function observeViews(session, phase, evidence) {
  // Refused before any evidence is checked or spent and before any action.
  if (!isBrowserSession(session)) fail('OBSERVATION_FAILED');
  if (!object(session) || typeof session.perform !== 'function' || typeof session.inspectResult !== 'function' || typeof session.assertBinding !== 'function' ||
      !PHASE_INTERVAL[phase] || !object(evidence) || !sameKeys(evidence, ['privateSession', 'readiness', 'maintenance'])) fail('OBSERVATION_FAILED');
  if (!readinessProofs.has(evidence.readiness)) fail('READINESS_FAILED');
  const maintenance = maintenanceProofs.get(evidence.maintenance);
  if (!maintenance || maintenance.phase !== phase) fail('READINESS_FAILED');
  if (usedReadiness.has(evidence.readiness) || usedMaintenance.has(evidence.maintenance)) fail('REPLAY');
  try { session.assertBinding({ runId: maintenance.runId, configIdentity: maintenance.configIdentity }); }
  catch (cause) { fail(cause?.code === 'IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH' : 'OBSERVATION_FAILED', cause); }
  assertMaintenanceCurrent(maintenance);
  usedReadiness.add(evidence.readiness);
  usedMaintenance.add(evidence.maintenance);
  let localSession;
  try { localSession = await session.perform('SESSION_OBSERVATION', {}); }
  catch (cause) { fail('OBSERVATION_FAILED', cause); }
  assertPrivateContinuity(evidence.privateSession, localSession);
  const views = {};
  const schedule = phase === 'OBSERVE_AFTER_RESTART' ? ['ROBO'] : Object.keys(VIEWS);
  for (const view of schedule) {
    assertMaintenanceCurrent(maintenance);
    let result;
    try { result = await session.perform('OBSERVE_VIEW', { phase, view }); }
    catch (cause) { fail('OBSERVATION_FAILED', cause); }
    views[view] = inspectView(session, result, phase, view, maintenance);
    assertPrivateContinuity(evidence.privateSession, result);
    assertMaintenanceCurrent(maintenance);
  }
  assertMaintenanceCurrent(maintenance);
  return Object.freeze({
    phase,
    readiness: true,
    maintenance: true,
    views: Object.freeze(views),
  });
}

module.exports = Object.freeze({ validateReadiness, observeViews, validateMaintenance });
