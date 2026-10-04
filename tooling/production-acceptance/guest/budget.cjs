'use strict';
const { inspectReceipt } = require('./receipts.cjs');
const { admitRequest, claimEligibility, revalidateBudgetEligibility } = require('./route-policy.cjs');
const { decodeFrame } = require('./contracts.cjs');
const catalogue = require('../contracts/routes.json');
const permits = new WeakMap(), budgets = new WeakSet(), browserPorts = new WeakMap(), usedLedgers = new WeakSet(), usedRuns = new Set();
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const phaseLetters = Object.freeze({ PREFLIGHT: 'P', AWAIT_CREDENTIAL: 'P', AUTHENTICATING: 'A',
  OBSERVE_BEFORE_RESTART: 'B', HOLD_FOR_RESTART: 'H', OBSERVE_AFTER_RESTART: 'C', LOGOUT: 'L', VERIFY_REVOCATION: 'V' });
const outcomes = new Set(['CONFIRMED', 'TIMEOUT', 'CONNECTION_RESET', 'UNKNOWN_SEND', 'CRASH', 'ABORTED']);
const safe = value => Number.isSafeInteger(value) && value >= 0;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function frozen(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function opaque(kind) {
  return Object.freeze(Object.defineProperty({ kind }, 'toJSON', { value: () => fail('PRIVACY_FAILED') }));
}
function routeSpec(routeId, phase, claim) {
  if (typeof phase !== 'string' || !Object.hasOwn(phaseLetters, phase)) fail('ROUTE_DENIED');
  const letter = phaseLetters[phase];
  if (!letter || typeof routeId !== 'string') fail('ROUTE_DENIED');
  if (claim && routeId.startsWith('frontend-asset:') && catalogue.assets.phases.includes(letter)) {
    return { cost: { PAPER: 0, stock: 0 }, ceiling: catalogue.assets.runCeiling, key: routeId };
  }
  const rows = catalogue.routes.filter(row => row.id === routeId && row.ceilings[letter]);
  if (!rows.length) fail('ROUTE_DENIED');
  const cost = row => typeof row.paperCost === 'number' ? row.paperCost : row.paperCost[letter];
  if (rows.some(row => cost(row) !== cost(rows[0]))) fail('ROUTE_DENIED');
  return { cost: { PAPER: cost(rows[0]), stock: 0 }, ceiling: rows.reduce((sum, row) => sum + row.ceilings[letter], 0), key: routeId + ':' + letter };
}
// The injected durability verifier authenticates provenance; this module itself
// requires the exact bounded acknowledgment shape and every run/charge binding.
function ackFields(ack, keys) {
  if (!ack || typeof ack !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(ack)) || Reflect.ownKeys(ack).length !== keys.length) return false;
  if (!keys.every(key => Object.hasOwn(ack, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(ack, key), 'value'))) return false;
  return Buffer.byteLength(JSON.stringify(ack)) <= 4096;
}
function createBudget(receipt, ports) {
  // Only the original nominal handle and original nominal Task3 trust establish
  // ledger provenance. A caller's verifyLedger callback is never consulted.
  const trust = ports?.trust;
  const ledger = inspectReceipt(receipt, 'LEDGER_RECEIPT', trust);
  if (!ledger) fail('BUDGET_EXCEEDED');
  if (usedLedgers.has(receipt) || usedRuns.has(ledger.runId)) fail('REPLAY');
  if (typeof ports?.journal?.append !== 'function' || typeof ports?.ledger?.confirmEnvelope !== 'function' ||
      typeof ports.verifyAccountingAck !== 'function' || typeof ports.verifyEnvelopeAck !== 'function' ||
      typeof ports.verifyOutcomeEvidence !== 'function') fail('IDENTITY_MISMATCH');
  const append = ports.journal.append.bind(ports.journal);
  const verifyAccountingAck = ports.verifyAccountingAck.bind(ports);
  const verifyEnvelopeAck = ports.verifyEnvelopeAck.bind(ports);
  const verifyOutcomeEvidence = ports.verifyOutcomeEvidence.bind(ports);
  // The signed envelope has already been independently reserved. Local allocations
  // draw down its capacity; adding them to externalCharged would double count.
  const allocated = { PAPER: 0, stock: 0 }, counts = new Map(), sequences = new Set(), reservations = new Map();
  let tail = Promise.resolve(), pending = 0, closed = false, failureCode = null;
  usedLedgers.add(receipt); usedRuns.add(ledger.runId);
  function latch(code) { if (!failureCode) failureCode = code; fail(code); }
  function active() { if (failureCode) fail(failureCode); if (closed) fail('ACCOUNTING_UNCERTAIN'); }
  function currentLedger() {
    const current = inspectReceipt(receipt, 'LEDGER_RECEIPT', trust);
    if (!current || current.runId !== ledger.runId || current.configIdentity !== ledger.configIdentity) latch('BUDGET_EXCEEDED');
    return current;
  }
  function checkClaim(claim, request, policy) {
    currentLedger();
    const decision = revalidateBudgetEligibility(claim, request, policy, receipt, trust);
    if (decision.kind !== 'ELIGIBLE') latch(decision.code ?? 'ROUTE_DENIED');
    if (decision.runId !== ledger.runId || decision.configIdentity !== ledger.configIdentity) latch('IDENTITY_MISMATCH');
    // The budget-only policy guard checks all nominal receipts and final facts at
    // one shared final time. No external callback follows that guard result.
    active();
    return decision;
  }
  function enqueue(operation) {
    pending++;
    const result = tail.then(operation).finally(() => { pending--; });
    tail = result.catch(() => {});
    return result;
  }
  async function allocate(routeId, sequence, phase, claim) {
    active(); currentLedger(); active();
    if (!safe(sequence) || sequence < 1) latch('ROUTE_DENIED');
    let spec;
    try { spec = routeSpec(routeId, phase, claim); } catch (error) { latch(error.code); }
    if (claim && (claim.cost.PAPER !== spec.cost.PAPER || claim.cost.stock !== spec.cost.stock)) latch('BUDGET_EXCEEDED');
    if (sequences.has(sequence)) latch('REPLAY');
    const count = counts.get(spec.key) ?? 0;
    // One synchronous transaction checks and commits both independent envelopes
    // and route ceilings. The journal await occurs only after this full charge.
    if (count >= spec.ceiling || ['PAPER', 'stock'].some(key => allocated[key] + spec.cost[key] > ledger[key].fullRunReserved)) latch('BUDGET_EXCEEDED');
    counts.set(spec.key, count + 1); sequences.add(sequence);
    for (const key of ['PAPER', 'stock']) allocated[key] += spec.cost[key];
    const reservationId = ledger.runId + ':' + sequence;
    const record = { reservationId, routeId, sequence, phase, cost: frozen({ ...spec.cost }), acknowledged: false, consumed: false, settled: false, outcome: 'UNKNOWN_SEND' };
    reservations.set(reservationId, record);
    const intent = frozen({ routeId, sequence, phase, cost: { ...spec.cost }, outcome: 'RESERVED' });
    try {
      const acknowledgement = append(intent);
      if (!(acknowledgement instanceof Promise) || await acknowledgement !== undefined) fail('STORAGE_INVALID');
    } catch { latch('STORAGE_INVALID'); }
    record.acknowledged = true;
    currentLedger(); active();
    return frozen({ reservationId, routeId, sequence, phase, cost: { ...record.cost } });
  }
  function reserve(routeId, sequence, phase) {
    return enqueue(() => allocate(routeId, sequence, phase, null));
  }
  async function authorize(request, policy) {
    active(); currentLedger(); active();
    const decision = admitRequest(request, policy);
    if (decision.kind === 'ABORT_EXPECTED' || decision.kind === 'REPLAY_PRIVATE') return decision;
    if (decision.kind !== 'ELIGIBLE') latch(decision.code ?? 'ROUTE_DENIED');
    const claim = claimEligibility(decision, request, policy);
    if (claim.kind !== 'CLAIMED') latch(claim.code ?? 'ROUTE_DENIED');
    if (claim.runId !== ledger.runId || claim.configIdentity !== ledger.configIdentity) latch('IDENTITY_MISMATCH');
    return enqueue(async () => {
      checkClaim(claim, request, policy);
      const reservation = await allocate(claim.routeId, claim.sequence, claim.phase, claim);
      checkClaim(claim, request, policy);
      const permit = opaque('PERMIT');
      permits.set(permit, { owner: budget, claim, request, policy, reservation, used: false });
      return permit;
    });
  }
  function consumePermit(permit, request, policy) {
    const saved = permits.get(permit);
    if (!saved || saved.used) {
      if (!failureCode) failureCode = 'REPLAY';
      return frozen({ kind: 'FAIL', code: 'REPLAY' });
    }
    // Burn the original permit before identity/gate checks, including an attempt
    // at another budget. An unsuccessful attempt can never be retried.
    saved.used = true;
    try {
      if (saved.owner !== budget || saved.request !== request || saved.policy !== policy) fail('IDENTITY_MISMATCH');
      active(); const decision = checkClaim(saved.claim, request, policy);
      const record = reservations.get(saved.reservation.reservationId);
      if (!record?.acknowledged || record.consumed || record.settled) fail('REPLAY');
      record.consumed = true;
      return frozen({ kind: 'ADMITTED', runId: ledger.runId, requestId: decision.requestId,
        sequence: decision.sequence, phase: decision.phase, routeId: decision.routeId,
        cost: { ...record.cost }, reservationId: record.reservationId });
    } catch (error) {
      // Every thrown module error is fixed; private boundary exception text is
      // normalized below rather than exported as an admission outcome.
      const code = ['REPLAY', 'IDENTITY_MISMATCH', 'BUDGET_EXCEEDED', 'ACCOUNTING_UNCERTAIN', 'ROUTE_DENIED',
        'EXPIRED', 'DEADLINE', 'READINESS_FAILED', 'OBSERVATION_FAILED', 'INTERNAL_FAILURE'].includes(error.code) ? error.code : 'INTERNAL_FAILURE';
      if (!failureCode) failureCode = code;
      return frozen({ kind: 'FAIL', code });
    }
  }
  function settle(reservationId, outcome) {
    if (closed) fail('ACCOUNTING_UNCERTAIN');
    const record = reservations.get(reservationId);
    if (!record?.acknowledged) fail('ACCOUNTING_UNCERTAIN');
    if (record.settled) fail('REPLAY');
    if (!outcome || !outcomes.has(outcome.kind) || Object.keys(outcome).some(key => !['kind', 'evidence'].includes(key))) fail('ACCOUNTING_UNCERTAIN');
    if (outcome.kind === 'CONFIRMED') {
      let verified = false;
      try { verified = verifyOutcomeEvidence(outcome.evidence, frozen({ runId: ledger.runId, reservationId, routeId: record.routeId,
        sequence: record.sequence, phase: record.phase, cost: { ...record.cost } })) === true; } catch {}
      if (!verified) fail('ACCOUNTING_UNCERTAIN');
    }
    if (closed) fail('ACCOUNTING_UNCERTAIN');
    record.outcome = outcome.kind; record.settled = true;
    // No outcome refunds an allocation, including ABORTED and independent proof.
  }
  function finalize(ack) {
    closed = true;
    let attempted = 0, confirmed = 0, uncertain = 0;
    for (const record of reservations.values()) {
      const cost = record.cost.PAPER + record.cost.stock;
      if (record.consumed) attempted += cost;
      if (record.settled && record.outcome === 'CONFIRMED') confirmed += cost;
      else uncertain += cost;
    }
    const accountingRecord = frozen({ version: 1, kind: 'PUBLIC_RECORD', runId: ledger.runId, sequence: 1,
      payload: { recordKind: 'ACCOUNTING', reserved: allocated.PAPER, stockReserved: allocated.stock,
        attempted, confirmed, uncertain, durableHandoff: false } });
    // Reuse Task1's bounded, fixed public accounting schema. This is a sanitized
    // handoff proposal; callers must privately scan/store it before ack creation.
    decodeFrame(Buffer.from(JSON.stringify(accountingRecord)), 'PUBLIC_RECORD');
    let durableHandoff = false, fullChargeDurable = false;
    if (pending === 0 && ack) {
      try {
        if (ackFields(ack, ['kind', 'runId', 'configIdentity', 'recordDigest', 'durable']) && ack.kind === 'ACCOUNTING_ACK' &&
            ack.runId === ledger.runId && ack.configIdentity === ledger.configIdentity && ack.durable === true &&
            ack.recordDigest === hash(JSON.stringify(accountingRecord))) durableHandoff = verifyAccountingAck(ack, accountingRecord) === true;
      } catch {}
      try {
        if (ackFields(ack, ['kind', 'runId', 'configIdentity', 'authority', 'PAPER', 'stock', 'durable', 'unavailable']) &&
            ack.kind === 'ENVELOPE_ACK' && ack.runId === ledger.runId && ack.configIdentity === ledger.configIdentity &&
            ack.authority === ledger.authority && ack.durable === true && ack.unavailable === true &&
            ack.PAPER === ledger.PAPER.fullRunReserved && ack.stock === ledger.stock.fullRunReserved) {
          fullChargeDurable = verifyEnvelopeAck(ack, frozen({ runId: ledger.runId, configIdentity: ledger.configIdentity,
            authority: ledger.authority, PAPER: ledger.PAPER.fullRunReserved, stock: ledger.stock.fullRunReserved, unavailable: true })) === true;
        }
      } catch {}
    }
    const summary = { runId: ledger.runId, attempted, confirmed, uncertain, accountingRecord,
      durableHandoff, fullChargeDurable, journalDeleteAllowed: pending === 0 && (durableHandoff || fullChargeDurable),
      reconciliationComplete: durableHandoff && uncertain === 0 };
    for (const key of ['PAPER', 'stock']) summary[key] = { ...ledger[key], allocated: allocated[key],
      unallocated: ledger[key].fullRunReserved - allocated[key],
      externalCharged: ledger[key].historicalCharged + ledger[key].unresolved + ledger[key].fullRunReserved };
    return frozen(summary);
  }
  const budget = Object.freeze(Object.defineProperty({ reserve, authorize, consumePermit, settle, finalize }, 'toJSON', { value: () => fail('PRIVACY_FAILED') }));
  budgets.add(budget);
  return budget;
}
function createBrowserAdmissionPort(budget, policy, requestFromEvidence) {
  if (!budgets.has(budget) || !policy || typeof policy !== 'object' || typeof requestFromEvidence !== 'function') fail('IDENTITY_MISMATCH');
  const port = opaque('BROWSER_ADMISSION_PORT');
  browserPorts.set(port, { budget, policy, requestFromEvidence, used: new WeakSet(), busy: false, failed: false });
  return port;
}
async function admitBrowserRequest(port, evidence) {
  const state = browserPorts.get(port);
  if (!state || !evidence || typeof evidence !== 'object') fail('IDENTITY_MISMATCH');
  if (state.failed || state.busy || state.used.has(evidence)) fail('REPLAY');
  state.used.add(evidence); state.busy = true;
  try {
    const request = state.requestFromEvidence(evidence);
    const permit = await state.budget.authorize(request, state.policy);
    if (permit?.kind === 'ABORT_EXPECTED' || permit?.kind === 'REPLAY_PRIVATE')
      return frozen({ requestId: request.requestId, decision: 'ABORT', reason: permit.kind });
    const admission = state.budget.consumePermit(permit, request, state.policy);
    if (admission.kind !== 'ADMITTED') fail(admission.code ?? 'ROUTE_DENIED');
    return frozen({ requestId: request.requestId, decision: 'CONTINUE', admission });
  } catch (error) {
    state.failed = true;
    fail(error?.code && typeof error.code === 'string' ? error.code : 'INTERNAL_FAILURE');
  } finally { state.busy = false; }
}
module.exports = { createBudget, createBrowserAdmissionPort, admitBrowserRequest };
