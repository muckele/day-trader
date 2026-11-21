'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
let fixtureNumber = 0;
const receipts = require('../../guest/receipts.cjs');
const contracts = require('../../guest/contracts.cjs');
const policyAPI = require('../../guest/route-policy.cjs');
const { createBudget, createBrowserAdmissionPort, admitBrowserRequest } = require('../../guest/budget.cjs');
const kinds = ['RELEASE_RECEIPT', 'RESTART_RECEIPT', 'LEDGER_RECEIPT', 'MAINTENANCE_RECEIPT', 'DB_RECEIPT'];
const vectors = JSON.parse(fs.readFileSync(require.resolve('../../contracts/vectors.json')));
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const B = 'OBSERVE_BEFORE_RESTART', C = 'OBSERVE_AFTER_RESTART', A = 'AUTHENTICATING';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// All receipt bindings are prepared by this synthetic authority before candidates exist.
// Only journal/ledger durability and observed browser facts are private fake boundaries.
function fixture({ phase = B, journal, ledgerMutation, expiries = {}, configIdentity,
  runId = crypto.randomBytes(16).toString('hex'), assetPath = '/static/app.js',
  assetBody: suppliedAssetBody, extraAssets = [], inspectBrowserEvidence } = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const frames = Object.fromEntries(kinds.map(kind => [kind, JSON.parse(vectors.accepted.find(v => v.kind === kind).json)]));
  for (const frame of Object.values(frames)) frame.runId = runId;
  if (configIdentity) for (const frame of Object.values(frames)) if (Object.hasOwn(frame.payload, 'configIdentity')) frame.payload.configIdentity = configIdentity;
  const time = { monotonicMs: 1000, wallMs: 160 };
  const assetBody = suppliedAssetBody ? Buffer.from(suppliedAssetBody) : Buffer.from('offline synthetic asset');
  const assetFrame = JSON.parse(vectors.accepted.find(v => v.name === 'asset_manifest').json); assetFrame.runId = runId;
  assetFrame.payload.entries = [{ path: assetPath, hash: hash(assetBody), size: assetBody.length, mime: 'application/javascript' },
    // Optional further signed entries (e.g. the browser harness's /index.html document entry).
    ...extraAssets.map(({ path: entryPath, body, mime }) => ({ path: entryPath, hash: hash(body), size: body.length, mime }))];
  const assetBytes = contracts.canonicalBytes(contracts.decodeFrame(Buffer.from(JSON.stringify(assetFrame)), 'ASSET_MANIFEST'));
  frames.RELEASE_RECEIPT.payload.assetManifestDigest = hash(assetBytes);
  // Independent historical values are intentionally different from imported hosted 6/19.
  Object.assign(frames.LEDGER_RECEIPT.payload.PAPER, { historicalCharged: 5, unresolved: 3, ceiling: 24, fullRunReserved: 14, remaining: 2 });
  Object.assign(frames.LEDGER_RECEIPT.payload.stock, { historicalCharged: 7, unresolved: 2, ceiling: 12, fullRunReserved: 0, remaining: 3 });
  if (ledgerMutation) ledgerMutation(frames.LEDGER_RECEIPT.payload);
  for (const frame of Object.values(frames)) {
    frame.payload.keyId = hash(raw);
    if (expiries[frame.kind]) frame.payload.expiresAt = expiries[frame.kind];
  }
  const expected = clone(frames);
  for (const frame of Object.values(expected)) for (const field of ['issuedAt', 'expiresAt', 'keyId', 'signature']) delete frame.payload[field];
  const replay = { consumedReceipts: new Set(), consumedNonces: new Set() };
  const options = { publicKeys: Object.fromEntries(kinds.map(kind => [kind, raw.toString('hex')])), expected, now: () => time.wallMs, maxAgeMs: 100, deadline: 200, ...replay };
  const evidenceDirectory = process.env.TASK4_FIXTURE_EVIDENCE ? path.join(process.env.TASK4_FIXTURE_EVIDENCE, process.pid + '-' + (++fixtureNumber) + '-' + runId) : null;
  let signedNumber = 0;
  if (evidenceDirectory) {
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, 'independent-options.json'), JSON.stringify({ publicKeys: options.publicKeys, expected, maxAgeMs: options.maxAgeMs, deadline: options.deadline, clock: { ...time }, asset: assetBytes.toString() }));
  }
  const trust = receipts.createTrustContext(options);
  function sign(frame) {
    const candidate = clone(frame);
    const validated = contracts.decodeFrame(Buffer.from(JSON.stringify(candidate)), candidate.kind);
    candidate.payload.signature = crypto.sign(null, contracts.receiptSigningBytes(validated), pair.privateKey).toString('hex');
    const bytes = Buffer.from(JSON.stringify(candidate));
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, (++signedNumber) + '-' + candidate.kind + '.json'), bytes);
    return bytes;
  }
  const handle = kind => receipts.verifyReceipt(sign(frames[kind]), kind, trust);
  const releaseBytes=sign(frames.RELEASE_RECEIPT);
  const release = receipts.verifyReceipt(releaseBytes,'RELEASE_RECEIPT',trust), assets = receipts.verifyAssets(assetBytes, release), ledger = handle('LEDGER_RECEIPT');
  const maintenance = handle('MAINTENANCE_RECEIPT'), restart = handle('RESTART_RECEIPT');
  const adapters = receipts.createReceiptAdapters(trust);
  const observed = new WeakMap();
  const brand = (kind, facts = {}) => { const object = Object.freeze({}); observed.set(object, { kind, ...facts }); return object; };
  const state = { runId: frames.RELEASE_RECEIPT.runId, phase, redirectObserved: false, policyEpoch: 1, gateEpoch: 1, sessionEpoch: 1,
    sessionIssued: !['PREFLIGHT', 'AWAIT_CREDENTIAL', A].includes(phase), sessionHandle: null, documentPath: '/robo',
    homeTransition: null, homeArmedAt: null, holdStartedAt: null, expiresAt: 200,
    preauth: brand('preauth'), maintenance, owner: brand('owner'), readiness: brand('readiness'), restart,
    preauthResponse: null, marketResponse: null };
  if (state.sessionIssued) state.sessionHandle = brand('session');
  let postAdapters, bodyValidator, browserValidator, next = 0;
  const browserEvidence = new WeakMap();
  const context = { clock: () => ({ ...time }), snapshot: request => ({ ...state, sequence: request?.sequence ?? 1 }),
    verifyRelease: adapters.verifyRelease, verifyAssets: adapters.verifyAssets,
    verifyGate: (kind, object, binding) => {
      if (kind === 'maintenance') return (postAdapters ?? adapters).verifyGate(kind, object, binding);
      if (kind === 'restart') return adapters.verifyGate(kind, object, binding);
      // Observed evidence is request-independent private state from the trusted caller;
      // these WeakMap identities explicitly stand in for actual worker observations.
      return observed.get(object)?.kind === kind && binding.runId === state.runId;
    },
    responseFacts: object => observed.get(object), bindBodyValidator: fn => { bodyValidator = fn; },
    inspectBrowserEvidence: object => inspectBrowserEvidence ? inspectBrowserEvidence(object) : browserEvidence.get(object) ?? null,
    bindBrowserEvidenceValidator: fn => { browserValidator = fn; } };
  const policy = policyAPI.createPolicy(release, assets, context);
  const intents = [], durable = { PAPER: 14, stock: 0, unavailable: true }, acknowledgements = new WeakMap();
  const ports = { trust,
    journal: { append: intent => { intents.push(intent); return journal ? journal(intent) : Promise.resolve(); } },
    ledger: { confirmEnvelope: async runId => {
      assert.equal(runId, state.runId);
      const ack = Object.freeze({ kind: 'ENVELOPE_ACK', runId, configIdentity: frames.LEDGER_RECEIPT.payload.configIdentity,
        authority: frames.LEDGER_RECEIPT.payload.authority, PAPER: durable.PAPER, stock: durable.stock, durable: true, unavailable: durable.unavailable });
      acknowledgements.set(ack, { kind: 'ENVELOPE', runId, durable: { ...durable } }); return ack;
    } },
    verifyAccountingAck: (ack, record) => acknowledgements.get(ack)?.kind === 'ACCOUNTING' && acknowledgements.get(ack).digest === hash(JSON.stringify(record)),
    verifyEnvelopeAck: (ack, binding) => {
      const saved = acknowledgements.get(ack);
      return saved?.kind === 'ENVELOPE' && saved.runId === binding.runId && saved.durable.unavailable === true && saved.durable.PAPER === binding.PAPER && saved.durable.stock === binding.stock && ack.configIdentity === binding.configIdentity && ack.authority === binding.authority;
    },
    verifyOutcomeEvidence: (evidence, binding) => observed.get(evidence)?.kind === 'providerEvidence' && observed.get(evidence).reservationId === binding.reservationId };
  function request(path = '/api/robotrader/performance', extra = {}) {
    const id = ++next;
    const queryPairs = extra.queryPairs ?? (path === '/api/robotrader/performance' ? [['environment', 'paper']] : []);
    const suffix = queryPairs.length ? '?' + queryPairs.map(pair => pair.join('=')).join('&') : '';
    const bytes = extra.bytes ?? Buffer.alloc(0);
    const req = { requestId: 'request-' + id, sequence: id, rawTarget: path + suffix, origin: frames.RELEASE_RECEIPT.payload.origins.BACKEND,
      method: 'GET', path, queryPairs, headers: [], phase: state.phase, bodyProof: null, ...extra };
    delete req.bytes;
    req.bodyProof = bodyValidator(req, bytes);
    return req;
  }
  function browserRequest(path = '/api/robotrader/performance', extra = {}) {
    const id = ++next, query = extra.query ?? (path === '/api/robotrader/performance' ? '?environment=paper' : '');
    const evidence = Object.freeze({});
    browserEvidence.set(evidence, Object.freeze({ runId: state.runId, requestId: 'browser-' + id, sequence: id,
      method: extra.method ?? 'GET', url: frames.RELEASE_RECEIPT.payload.origins.BACKEND + path + query,
      headers: extra.headers ?? [], byteLength: extra.byteLength ?? 0, schema: extra.schema ?? 'ABSENT',
    }));
    return { evidence, request: () => browserValidator(evidence) };
  }
  function postRestart() {
    const postExpected = clone(expected); postExpected.MAINTENANCE_RECEIPT.sequence = 2;
    const notBefore = Object.fromEntries(kinds.map(kind => [kind, kind === 'MAINTENANCE_RECEIPT' ? 150 : 0]));
    const postTrust = receipts.createTrustContext({ ...options, expected: postExpected, notBefore });
    const fresh = clone(frames.MAINTENANCE_RECEIPT); fresh.sequence = 2; fresh.payload.issuedAt = 151;
    postAdapters = receipts.createReceiptAdapters(postTrust);
    state.maintenance = receipts.verifyReceipt(sign(fresh), 'MAINTENANCE_RECEIPT', postTrust);
    state.phase = C; state.gateEpoch++;
  }
  function accountingAck(summary) {
    const ack = Object.freeze({ kind: 'ACCOUNTING_ACK', runId, configIdentity: frames.LEDGER_RECEIPT.payload.configIdentity,
      recordDigest: hash(JSON.stringify(summary.accountingRecord)), durable: true });
    acknowledgements.set(ack, { kind: 'ACCOUNTING', digest: ack.recordDigest }); return ack;
  }
  return { trust, ledger, release, assets, maintenance, restart, adapters, state, time, context, policy, ports, intents, durable,
    request, browserRequest, browserRequestFromEvidence: evidence => browserValidator(evidence),
    brand, postRestart, accountingAck, body: (req, bytes) => bodyValidator(req, bytes), frames, options, sign,
    releaseBytes, assetBytes, assetBody,
    budget: () => createBudget(ledger, ports) };
}
module.exports = { fixture, deferred, B, C, A, createBudget, policyAPI };

// The composition suite imports only the fixture. Direct --test execution runs every
// unit test here once, without duplicate test registration in the importing process.
if (require.main === module) {
  test('browser_admission_port_requires_real_budget_policy_proof_and_consumes_once', async () => {
    const f = fixture(), b = f.budget(), incoming = f.browserRequest();
    const port = createBrowserAdmissionPort(b, f.policy, incoming.request);
    const decision = await admitBrowserRequest(port, incoming.evidence);
    assert.equal(decision.decision, 'CONTINUE');
    assert.equal(decision.requestId, 'browser-1');
    assert.equal(decision.admission.kind, 'ADMITTED');
    await assert.rejects(admitBrowserRequest(port, incoming.evidence), { code: 'REPLAY' });
    await assert.rejects(admitBrowserRequest({ admit: async () => ({ decision: 'CONTINUE' }) }, incoming.evidence),
      { code: 'IDENTITY_MISMATCH' });
  });
  test('reservation_before_forward', async () => {
    const started = deferred(), ack = deferred(), f = fixture({ journal: intent => { started.resolve(intent); return ack.promise; } }), budget = f.budget();
    const req = f.request(); let issued = false;
    const pending = budget.authorize(req, f.policy).then(p => { issued = true; return p; });
    const intent = await started.promise;
    assert.equal(issued, false); assert.equal(intent.outcome, 'RESERVED');
    assert.deepEqual(intent.cost, { PAPER: 2, stock: 0 });
    assert.deepEqual(Object.keys(intent).sort(), ['routeId', 'sequence', 'phase', 'cost', 'outcome'].sort());
    ack.resolve(); const permit = await pending;
    assert.equal(budget.consumePermit(permit, req, f.policy).kind, 'ADMITTED');
  });
  test('concurrent_reservation_serialized', async () => {
    const entered = deferred(), ack = deferred(); let first = true;
    const f = fixture({ journal: () => { if (first) { first = false; entered.resolve(); return ack.promise; } return Promise.resolve(); } }), b = f.budget();
    const one = b.reserve('performance', 1, B); await entered.promise;
    const two = b.reserve('robo-health', 2, B);
    assert.equal(f.intents.length, 1); ack.resolve(); await Promise.all([one, two]);
    assert.deepEqual(f.intents.map(v => v.cost.PAPER), [2, 1]);
    assert.equal(b.finalize(null).PAPER.allocated, 3);
  });
  test('timeout_unknown_send_keep_full_charge', async () => {
    for (const outcome of ['TIMEOUT', 'CONNECTION_RESET', 'UNKNOWN_SEND', 'CRASH']) {
      const f = fixture(), b = f.budget(), r = await b.reserve('performance', 1, B);
      b.settle(r.reservationId, { kind: outcome }); const s = b.finalize(null);
      assert.equal(s.PAPER.allocated, 2); assert.equal(s.uncertain, 2); assert.equal(s.PAPER.externalCharged, 22);
    }
  });
  test('crash_after_reserve_keeps_external_envelope', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    assert.deepEqual(f.durable, { PAPER: 14, stock: 0, unavailable: true });
    const s = b.finalize(null); assert.equal(s.PAPER.externalCharged, 22); assert.equal(s.journalDeleteAllowed, false);
  });
  test('journal_loss_cannot_reset_budget', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B); f.intents.length = 0;
    assert.throws(() => f.budget(), { code: 'REPLAY' });
    await assert.rejects(b.reserve('performance', 2, B), { code: 'BUDGET_EXCEEDED' });
    assert.equal(b.finalize(null).PAPER.allocated, 2); assert.equal(f.durable.unavailable, true);
  });
  test('over_ceiling_stale_receipt_wrong_adapter_denied', () => {
    for (const ledgerMutation of [p => { p.PAPER.ceiling = 21; }, p => { p.canonicalAdapter = 'local-simulator'; }, p => { p.stock.remaining = -1; }]) {
      assert.throws(() => fixture({ ledgerMutation }), Error);
    }
    const f = fixture(); f.time.wallMs = 200; assert.throws(() => f.budget(), { code: 'BUDGET_EXCEEDED' });
  });
  test('sanitized_ack_or_durable_full_charge_before_delete', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    const pending = b.finalize(null); assert.equal(pending.journalDeleteAllowed, false);
    assert.equal(b.finalize({ kind: 'ACCOUNTING', durable: true }).journalDeleteAllowed, false);
    const summary = b.finalize(f.accountingAck(pending));
    assert.equal(summary.journalDeleteAllowed, true); assert.equal(summary.durableHandoff, true);
    assert.equal(contracts.decodeFrame(Buffer.from(JSON.stringify(summary.accountingRecord)), 'PUBLIC_RECORD').payload.recordKind, 'ACCOUNTING');
    const g = fixture(), c = g.budget(); await c.reserve('performance', 1, B);
    const fallback = c.finalize(await g.ports.ledger.confirmEnvelope(g.state.runId));
    assert.equal(fallback.journalDeleteAllowed, true); assert.equal(fallback.durableHandoff, false);
    assert.equal(fallback.PAPER.externalCharged, 22); assert.equal(fallback.reconciliationComplete, false);
  });
  test('no_refund_without_evidence', async () => {
    const f = fixture(), b = f.budget(), r = await b.reserve('performance', 1, B);
    assert.throws(() => b.settle(r.reservationId, { kind: 'CONFIRMED', evidence: {} }), { code: 'ACCOUNTING_UNCERTAIN' });
    b.settle(r.reservationId, { kind: 'ABORTED' });
    assert.throws(() => b.settle(r.reservationId, { kind: 'CONFIRMED', evidence: f.brand('providerEvidence', { reservationId: r.reservationId }) }), { code: 'REPLAY' });
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  });
  test('no_double_count_envelope_and_routes', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    const s = b.finalize(null); assert.equal(s.PAPER.externalCharged, 5 + 3 + 14);
    assert.equal(s.PAPER.unallocated, 12); assert.equal(s.PAPER.remaining, 2);
  });
  test('separate_paper_stock_totals', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    const s = b.finalize(null); assert.equal(s.stock.externalCharged, 9); assert.equal(s.stock.allocated, 0); assert.equal(s.stock.remaining, 3);
    assert.equal(s.PAPER.historicalCharged, 5); assert.equal(s.PAPER.unresolved, 3);
  });
  test('untrusted_ledger_callback_and_copied_metadata_are_not_provenance', () => {
    const f = fixture(), metadata = f.adapters.verifyLedger(f.ledger);
    for (const handle of [{ ...f.ledger }, metadata, { kind: 'LEDGER_RECEIPT' }]) {
      assert.throws(() => createBudget(handle, { ...f.ports, verifyLedger: () => metadata }), { code: 'BUDGET_EXCEEDED' });
    }
    assert.throws(() => createBudget(f.ledger, { ...f.ports, trust: {} }), { code: 'BUDGET_EXCEEDED' });
  });
  test('finite_reserve_cost_phase_sequence_and_duplicate_validation', async () => {
    for (const args of [['economic', 1, B], ['performance', 0, B], ['performance', 1, A], ['performance', 1, undefined], ['performance', 1, 'B']]) {
      const f = fixture(), b = f.budget(); await assert.rejects(b.reserve(...args), { code: 'ROUTE_DENIED' }); assert.equal(f.intents.length, 0);
    }
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    await assert.rejects(b.reserve('robo-health', 1, B), { code: 'REPLAY' });
  });
  test('reserve_rejects_nonprimitive_phase_before_coercion_allocation_or_journal', async () => {
    for (const make of [increment => ({ label: 'not-a-phase-enum', toString() { increment(); return B; } }), () => new String(B)]) {
      let coercions = 0;
      // A separate object captures the counter without evaluating any phase coercion.
      const phase = make(() => { coercions++; });
      const f = fixture(), b = f.budget();
      await assert.rejects(b.reserve('performance', 1, phase), { code: 'ROUTE_DENIED' });
      assert.equal(coercions, 0); assert.equal(f.intents.length, 0);
      assert.equal(b.finalize(null).PAPER.allocated, 0);
    }
  });
  test('primitive_P_and_AWAIT_CREDENTIAL_keep_the_shared_route_ceiling', async () => {
    for (const phases of [['PREFLIGHT', 'AWAIT_CREDENTIAL'], ['AWAIT_CREDENTIAL', 'PREFLIGHT']]) {
      const f = fixture(), b = f.budget();
      const reservation = await b.reserve('health', 1, phases[0]);
      assert.equal(reservation.phase, phases[0]); assert.equal(f.intents[0].phase, phases[0]);
      await assert.rejects(b.reserve('health', 2, phases[1]), { code: 'BUDGET_EXCEEDED' });
      assert.equal(f.intents.length, 1); assert.equal(b.finalize(null).PAPER.allocated, 0);
    }
  });
  test('journal_rejection_and_invalid_ack_shapes_never_issue_permit', async () => {
    for (const journal of [() => Promise.reject(new Error('private provider value')), () => Promise.resolve(true), () => undefined]) {
      const f = fixture({ journal }), b = f.budget();
      await assert.rejects(b.authorize(f.request(), f.policy), { code: 'STORAGE_INVALID', message: 'STORAGE_INVALID' });
      assert.equal(b.finalize(null).PAPER.allocated, 2);
    }
  });
  test('finalization_during_pending_ack_cannot_delete_or_create_authority', async () => {
    const entered = deferred(), ack = deferred(), f = fixture({ journal: () => { entered.resolve(); return ack.promise; } }), b = f.budget();
    const p = b.authorize(f.request(), f.policy); const rejected = assert.rejects(p, { code: 'ACCOUNTING_UNCERTAIN' }); await entered.promise;
    const envelope = await f.ports.ledger.confirmEnvelope(f.state.runId);
    assert.equal(b.finalize(envelope).journalDeleteAllowed, false);
    ack.resolve(); await rejected;
    assert.equal(b.finalize(envelope).journalDeleteAllowed, true);
  });
  test('confirmed_evidence_is_bound_and_never_refunds', async () => {
    const f = fixture(), b = f.budget(), r = await b.reserve('performance', 1, B);
    b.settle(r.reservationId, { kind: 'CONFIRMED', evidence: f.brand('providerEvidence', { reservationId: r.reservationId }) });
    const s = b.finalize(null); assert.equal(s.confirmed, 2); assert.equal(s.uncertain, 0); assert.equal(s.PAPER.allocated, 2);
  });
  test('same_run_new_nominal_receipt_cannot_reset_local_allocations', async () => {
    const f = fixture(), b = f.budget(); await b.reserve('performance', 1, B);
    const g = fixture({ runId: f.state.runId });
    assert.ok(receipts.inspectReceipt(g.ledger, 'LEDGER_RECEIPT', g.trust));
    assert.throws(() => g.budget(), { code: 'REPLAY' });
  });
  test('ack_boolean_or_malformed_bound_fields_do_not_allow_deletion', async () => {
    for (const kind of ['ACCOUNTING', 'ENVELOPE']) {
      for (const alter of [ack => ({ ...ack, runId: 'f'.repeat(32) }), ack => ({ ...ack, durable: false }),
        ack => ({ ...ack, configIdentity: 'f'.repeat(64) }), ack => ({ ...ack, unknown: true })]) {
        const f = fixture(); f.ports.verifyAccountingAck = () => true; f.ports.verifyEnvelopeAck = () => true;
        const b = f.budget(); await b.reserve('performance', 1, B); const summary = b.finalize(null);
        const ack = kind === 'ACCOUNTING' ? f.accountingAck(summary) : await f.ports.ledger.confirmEnvelope(f.state.runId);
        assert.equal(b.finalize(alter(ack)).journalDeleteAllowed, false, 'trusted verifier callback cannot supply missing binding validation');
      }
    }
    for (const ack of [true, { durable: true }, { kind: 'ENVELOPE_ACK', unavailable: true }, { kind: 'ACCOUNTING_ACK', durable: true }]) {
      const f = fixture(); f.ports.verifyAccountingAck = () => true; f.ports.verifyEnvelopeAck = () => true;
      const b = f.budget(); assert.equal(b.finalize(ack).journalDeleteAllowed, false);
    }
  });

  test('failed_consumption_latches_budget', async () => {
    const f = fixture(), b = f.budget(), req = f.request(), permit = await b.authorize(req, f.policy);
    assert.equal(b.consumePermit(permit, { ...req }, f.policy).kind, 'FAIL');
    await assert.rejects(b.authorize(f.request('/api/robotrader/health'), f.policy), { code: 'IDENTITY_MISMATCH' });
  });
  test('evidence_cannot_settle_after_finalization', async () => {
    const g = fixture(); let c;
    g.ports.verifyOutcomeEvidence = () => { c.finalize(null); return true; };
    c = g.budget(); const r = await c.reserve('performance', 1, B);
    assert.throws(() => c.settle(r.reservationId, { kind: 'CONFIRMED', evidence: {} }), { code: 'ACCOUNTING_UNCERTAIN' });
    assert.equal(c.finalize(null).confirmed, 0);
  });

}
