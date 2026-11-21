'use strict';

const { timingSafeEqual } = require('node:crypto');
const { inspectSessionReceipts, inspectWorkerGate } = require('./receipts.cjs');

// X19 / P20: browser-worker.cjs requires this module for readinessPredicate only. The controller
// modules (session.cjs, and browser.cjs for the BrowserSession brand) load on first controller use,
// so the worker process never loads controller code.
let controllerModules = null;
function controller() {
  if (controllerModules === null) controllerModules = Object.freeze({
    assertContinuity: require('./session.cjs').assertContinuity,
    // T13 I-8: only a BrowserSession that browser.cjs opened is observed, never a look-alike.
    isBrowserSession: require('./browser.cjs').isBrowserSession,
  });
  return controllerModules;
}

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
const VIEW_KEYS = Object.freeze(['kind', 'view', 'phase', 'sequence', 'schemaValidation', 'renderedData', 'validEmptyState', 'noError',
  'source', 'brokerError', 'routeCount', 'renderedCount', 'runId', 'configIdentity', 'fingerprint']);
const READINESS_KEYS = Object.freeze(['kind', 'phase', 'sequence', 'fingerprint', 'readinessDigest', 'ownerDigest', 'checkedAtMonotonicMs',
  'runId', 'configIdentity', 'readiness', 'owner']);
// Worker readiness failures keep their own classification; anything else is READINESS_FAILED.
const READINESS_CODES = Object.freeze(['READINESS_FAILED', 'IDENTITY_MISMATCH', 'SESSION_MISMATCH']);
const maintenanceProofs = new WeakMap();
const usedMaintenance = new WeakSet();
const mintedMaintenanceReceipts = new WeakSet();
const mintedDatabaseReceipts = new WeakSet();
// T13 m-4: the owner digest of each private session's BEFORE readiness, for post-restart continuity.
const ownerDigests = new WeakMap();

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
function hex64(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
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

// T13 I-4: the single copy of the readiness checks. browser-worker.cjs applies it to the exact
// /api/readiness body inside the worker; the body never reaches the controller. It is a pure
// boolean, never a proof: the controller's only readiness evidence is a WorkerGateHandle.
function readinessPredicate(body) {
  try {
    if (!object(body) || body.contractVersion !== 2 || body.profile !== 'owner-paper-maintenance' ||
        body.runtimeReady !== true || body.maintenanceReady !== true ||
        !sameKeys(body.checks, REQUIRED_CHECKS) || !sameKeys(body.automation, Object.keys(AUTOMATION))) return false;
    for (const name of REQUIRED_CHECKS) {
      const check = body.checks[name];
      if (!object(check) || check.status !== 'pass') return false;
    }
    for (const [name, expected] of Object.entries(AUTOMATION)) if (body.automation[name] !== expected) return false;
    return true;
  } catch { return false; }
}

// T13 m-9 / P72: the maintenance and DB receipts are read only under the BrowserSession's own private
// release trust context (receipts.cjs, by identity), never under a caller-supplied or sibling trust; the
// AFTER interval exists only after that same context's restart transition. The proof is bound to the session.
function sessionReceipts(session, maintenanceReceipt, databaseReceipt) {
  return inspectSessionReceipts(session, [[maintenanceReceipt, 'MAINTENANCE_RECEIPT'], [databaseReceipt, 'DB_RECEIPT']]) || [];
}
function validateMaintenance(session, evidence) {
  try {
    if (!controller().isBrowserSession(session)) fail('READINESS_FAILED');
    exact(evidence, ['maintenanceReceipt', 'databaseReceipt', 'phase']);
    if (mintedMaintenanceReceipts.has(evidence.maintenanceReceipt) || mintedDatabaseReceipts.has(evidence.databaseReceipt)) fail('REPLAY');
    const expectedInterval = PHASE_INTERVAL[evidence.phase];
    if (!expectedInterval) fail('READINESS_FAILED');
    const [maintenance, database] = sessionReceipts(session, evidence.maintenanceReceipt, evidence.databaseReceipt);
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
      session, phase: evidence.phase, runId: maintenance.runId, configIdentity: maintenance.configIdentity,
      maintenanceReceipt: evidence.maintenanceReceipt, databaseReceipt: evidence.databaseReceipt,
    });
  } catch (cause) {
    if (['READINESS_FAILED', 'REPLAY'].includes(cause?.code)) throw cause;
    fail('READINESS_FAILED', cause);
  }
}

// T13 m-4: each result is claimed once, for this phase and the sequence of its readiness.
function claim(session, result, phase, sequence) {
  try { return session.claimResult(result, phase, sequence); } catch (cause) { fail('OBSERVATION_FAILED', cause); }
}
function inspectView(session, result, phase, sequence, view, maintenance) {
  const value = claim(session, result, phase, sequence);
  // T13 I-9: no freshness is claimed; source and brokerError are the worker's PAPER-health facts and
  // noError is its measured alert/status check.
  if (!sameKeys(value, VIEW_KEYS) || value.kind !== 'VIEW_OBSERVED' || value.view !== view || value.phase !== phase ||
      value.sequence !== sequence || value.schemaValidation !== true || value.noError !== true ||
      value.source !== 'alpaca-paper' || value.brokerError !== false || value.routeCount !== VIEWS[view] ||
      !Number.isSafeInteger(value.renderedCount) || value.renderedCount < 0 ||
      typeof value.renderedData !== 'boolean' || typeof value.validEmptyState !== 'boolean' ||
      value.renderedData === value.validEmptyState ||
      value.renderedData && value.renderedCount < 1 || value.validEmptyState && value.renderedCount !== 0 || !hex64(value.fingerprint)) fail('OBSERVATION_FAILED');
  if (value.runId !== maintenance.runId || value.configIdentity !== maintenance.configIdentity) fail('IDENTITY_MISMATCH');
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
  const [currentMaintenance, currentDatabase] = sessionReceipts(maintenance.session, maintenance.maintenanceReceipt, maintenance.databaseReceipt);
  if (!currentMaintenance || !currentDatabase || currentMaintenance.runId !== maintenance.runId || currentDatabase.runId !== maintenance.runId ||
      currentMaintenance.configIdentity !== maintenance.configIdentity || currentDatabase.configIdentity !== maintenance.configIdentity) fail('READINESS_FAILED');
}
function assertPrivateContinuity(privateSession, result) {
  try { controller().assertContinuity(privateSession, result); }
  catch (cause) { fail(cause?.code === 'SESSION_CHANGED' ? 'SESSION_MISMATCH' : 'OBSERVATION_FAILED', cause); }
}
// T13 I-4 / I-5 (C9 SESSION_READINESS): the worker GETs /api/readiness and /api/me itself, applies
// readinessPredicate and the owner check, and reports digests only. browser.cjs mints the readiness
// and owner WorkerGateHandles from that result; here both are verified for this session, phase and
// sequence before any view.
async function workerReadiness(session, phase, sequence, maintenance) {
  let result;
  try { result = await session.perform('SESSION_READINESS', { phase, sequence }); }
  catch (cause) { fail(READINESS_CODES.includes(cause?.code) ? cause.code : 'READINESS_FAILED', cause); }
  let value;
  try { value = session.claimResult(result, phase, sequence); } catch (cause) { fail('READINESS_FAILED', cause); }
  if (!sameKeys(value, READINESS_KEYS) || value.kind !== 'READINESS_OBSERVED' || value.phase !== phase || value.sequence !== sequence ||
      value.runId !== maintenance.runId || value.configIdentity !== maintenance.configIdentity ||
      ![value.fingerprint, value.readinessDigest, value.ownerDigest].every(hex64)) fail('READINESS_FAILED');
  for (const kind of ['readiness', 'owner']) {
    const gate = inspectWorkerGate(value[kind], session);
    if (!gate || gate.kind !== kind || gate.phase !== phase || gate.sequence !== sequence || gate.current !== true ||
        gate.runId !== maintenance.runId || gate.configIdentity !== maintenance.configIdentity || gate.digest !== value[kind + 'Digest']) fail('READINESS_FAILED');
  }
  return value;
}
// T13 m-4 / design section 14: post-restart continuity includes the owner. The AFTER readiness's
// owner digest must equal this private session's BEFORE one.
function assertOwnerContinuity(privateSession, phase, ownerDigest) {
  const owner = Buffer.from(ownerDigest, 'hex');
  if (phase === 'OBSERVE_BEFORE_RESTART') {
    if (ownerDigests.has(privateSession)) fail('REPLAY');
    ownerDigests.set(privateSession, owner);
    return;
  }
  const before = ownerDigests.get(privateSession);
  if (!before || !timingSafeEqual(before, owner)) fail('IDENTITY_MISMATCH');
}

async function observeViews(session, phase, evidence) {
  // Refused before any evidence is checked or spent and before any action.
  if (!controller().isBrowserSession(session)) fail('OBSERVATION_FAILED');
  if (!object(session) || typeof session.perform !== 'function' || typeof session.claimResult !== 'function' || typeof session.assertBinding !== 'function' ||
      !PHASE_INTERVAL[phase] || !object(evidence) || !sameKeys(evidence, ['privateSession', 'maintenance', 'sequence']) ||
      !Number.isSafeInteger(evidence.sequence) || evidence.sequence < 1) fail('OBSERVATION_FAILED');
  const maintenance = maintenanceProofs.get(evidence.maintenance);
  if (!maintenance || maintenance.phase !== phase || maintenance.session !== session) fail('READINESS_FAILED');
  if (usedMaintenance.has(evidence.maintenance)) fail('REPLAY');
  try { session.assertBinding({ runId: maintenance.runId, configIdentity: maintenance.configIdentity }); }
  catch (cause) { fail(cause?.code === 'IDENTITY_MISMATCH' ? 'IDENTITY_MISMATCH' : 'OBSERVATION_FAILED', cause); }
  assertMaintenanceCurrent(maintenance);
  usedMaintenance.add(evidence.maintenance);
  const sequence = evidence.sequence;
  // T13 I-4 / I-5 (M12): ROBO, and each view after it, runs only after the worker's own readiness
  // and owner observation for this phase and sequence has set the session's two gates.
  const ready = await workerReadiness(session, phase, sequence, maintenance);
  let localSession;
  try { localSession = await session.perform('SESSION_OBSERVATION', {}); }
  catch (cause) { fail('OBSERVATION_FAILED', cause); }
  assertPrivateContinuity(evidence.privateSession, localSession);
  const observed = claim(session, localSession, phase, sequence);
  if (!sameKeys(observed, ['kind', 'fingerprint', 'phase', 'sequence']) || observed.kind !== 'SESSION_OBSERVED' || !hex64(observed.fingerprint) ||
      !timingSafeEqual(Buffer.from(observed.fingerprint, 'hex'), Buffer.from(ready.fingerprint, 'hex'))) fail('SESSION_MISMATCH');
  assertOwnerContinuity(evidence.privateSession, phase, ready.ownerDigest);
  const views = {};
  const schedule = phase === 'OBSERVE_AFTER_RESTART' ? ['ROBO'] : Object.keys(VIEWS);
  for (const view of schedule) {
    assertMaintenanceCurrent(maintenance);
    let result;
    try { result = await session.perform('OBSERVE_VIEW', { phase, view }); }
    catch (cause) { fail('OBSERVATION_FAILED', cause); }
    views[view] = inspectView(session, result, phase, sequence, view, maintenance);
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

module.exports = Object.freeze({ readinessPredicate, observeViews, validateMaintenance });
