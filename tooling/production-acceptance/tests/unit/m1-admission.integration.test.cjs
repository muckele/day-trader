'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, B, C, A, createBudget, policyAPI } = require('./budget.test.cjs');
const receipts = require('../../guest/receipts.cjs');

test('composition_valid_receipt_eligible_acknowledged_reserve_one_consume', async () => {
  const f = fixture(), b = f.budget(), req = f.request();
  assert.ok(receipts.inspectReceipt(f.ledger, 'LEDGER_RECEIPT', f.trust));
  const permit = await b.authorize(req, f.policy);
  const admission = b.consumePermit(permit, req, f.policy);
  assert.deepEqual(admission, { kind: 'ADMITTED', runId: f.state.runId, requestId: req.requestId,
    sequence: req.sequence, phase: B, routeId: 'performance', cost: { PAPER: 2, stock: 0 }, reservationId: f.state.runId + ':1' });
  assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
  assert.throws(() => JSON.stringify(permit), { code: 'PRIVACY_FAILED' });
});
test('composition_eligibility_alone_or_failed_journal_cannot_permit', async () => {
  const f = fixture(), b = f.budget(), req = f.request(), decision = policyAPI.admitRequest(req, f.policy);
  assert.equal(decision.kind, 'ELIGIBLE'); assert.equal(b.consumePermit(decision, req, f.policy).kind, 'FAIL');
  const g = fixture({ journal: () => Promise.reject(new Error('private details')) }), c = g.budget();
  await assert.rejects(c.authorize(g.request(), g.policy), { code: 'STORAGE_INVALID' });
  assert.equal(c.consumePermit({}, g.request('/api/robotrader/health'), g.policy).kind, 'FAIL');
});
test('composition_invalidation_during_await_all_trusted_bindings', async () => {
  const mutations = [f => { f.state.gateEpoch++; }, f => { f.state.policyEpoch++; }, f => { f.state.sessionEpoch++; },
    f => { f.state.sessionHandle = f.brand('session'); }, f => { f.state.readiness = f.brand('readiness'); },
    f => { f.state.maintenance = { ...f.maintenance }; }, f => { f.state.owner = null; },
    f => { f.state.redirectObserved = true; }, f => { f.state.phase = C; }];
  for (const mutate of mutations) {
    const entered = deferred(), ack = deferred(), f = fixture({ journal: () => { entered.resolve(); return ack.promise; } }), b = f.budget();
    const pending = b.authorize(f.request(), f.policy); const rejected = assert.rejects(pending, Error);
    await entered.promise; mutate(f); ack.resolve(); await rejected;
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  }
});
test('composition_invalidation_before_consume_burns_once', async () => {
  for (const field of ['gateEpoch', 'policyEpoch', 'sessionEpoch']) {
    const f = fixture(), b = f.budget(), req = f.request(), permit = await b.authorize(req, f.policy);
    f.state[field]++; assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
    f.state[field]--; assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  }
});
test('composition_request_body_phase_changes_and_reuse_denied', async () => {
  const mutations = [(f, r) => { r.rawTarget = '/api/paper-trades/account'; }, (f, r) => { r.sequence++; },
    (f, r) => { r.requestId += '-changed'; }, (f, r) => { r.bodyProof = { ...r.bodyProof }; },
    (f, r) => { r.phase = C; }, (f, r) => { r.headers.push(['x-method-override', 'POST']); }];
  for (const mutate of mutations) {
    const f = fixture(), b = f.budget(), req = f.request(), permit = await b.authorize(req, f.policy);
    mutate(f, req); assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
  }
  for (const copyKind of ['permit', 'request', 'policy']) {
    const f = fixture(), b = f.budget(), req = f.request(), permit = await b.authorize(req, f.policy);
    assert.equal(b.consumePermit(copyKind === 'permit' ? { ...permit } : permit,
      copyKind === 'request' ? { ...req } : req, copyKind === 'policy' ? { ...f.policy } : f.policy).kind, 'FAIL');
    assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
  }
});
test('composition_concurrency_enforces_route_and_envelope_atomically', async () => {
  const entered = deferred(), ack = deferred(); let first = true;
  const f = fixture({ journal: () => { if (first) { first = false; entered.resolve(); return ack.promise; } return Promise.resolve(); } }), b = f.budget();
  const one = b.authorize(f.request(), f.policy); await entered.promise;
  const two = b.authorize(f.request(), f.policy);
  const results = Promise.allSettled([one, two]); ack.resolve();
  const settled = await results;
  assert.equal(settled.filter(r => r.status === 'fulfilled').length, 0, 'fatal route over-ceiling invalidates the first pending claim');
  assert.ok(settled.every(r => r.status === 'rejected'));
  assert.ok(b.finalize(null).PAPER.allocated <= 2);
  const g = fixture(), c = g.budget();
  const attempts = Array.from({ length: 12 }, (_, i) => c.reserve(i % 2 ? 'portfolio-account' : 'portfolio-equity', i + 1, B));
  const reservations = await Promise.allSettled(attempts);
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(c.finalize(null).PAPER.allocated, 4);
});
test('composition_uncertain_consumed_attempt_retains_full_charge', async () => {
  const f = fixture(), b = f.budget(), req = f.request(), permit = await b.authorize(req, f.policy);
  const admission = b.consumePermit(permit, req, f.policy);
  b.settle(admission.reservationId, { kind: 'UNKNOWN_SEND' });
  const s = b.finalize(null); assert.equal(s.attempted, 2); assert.equal(s.uncertain, 2); assert.equal(s.PAPER.allocated, 2);
});
test('composition_local_loss_cannot_free_external_envelope', async () => {
  const f = fixture(), b = f.budget(); await b.authorize(f.request(), f.policy); f.intents.length = 0;
  assert.throws(() => createBudget(f.ledger, f.ports), { code: 'REPLAY' });
  assert.equal(f.durable.PAPER, 14); assert.equal(f.durable.unavailable, true);
  assert.throws(() => fixture({ ledgerMutation: p => { p.PAPER.unresolved += 14; p.PAPER.remaining -= 14; } }), Error,
    'a new envelope must include the unavailable earlier envelope as unresolved external charge');
});
test('composition_untrusted_receipt_initialization_denied', () => {
  const f = fixture(), copied = { ...f.ledger }, metadata = f.adapters.verifyLedger(f.ledger);
  assert.throws(() => createBudget(copied, { ...f.ports, verifyLedger: () => metadata }), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => createBudget(metadata, f.ports), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => createBudget(f.ledger, { ...f.ports, trust: {} }), { code: 'BUDGET_EXCEEDED' });
});
test('composition_economic_routes_fail_closed_without_allowance_or_permit', async () => {
  for (const path of ['/api/orders', '/api/robotrader/activate', '/api/paper-trades/orders']) {
    const f = fixture(), b = f.budget();
    await assert.rejects(b.authorize(f.request(path, { method: 'POST' }), f.policy), { code: 'ROUTE_DENIED' });
    await assert.rejects(b.authorize(f.request(), f.policy), { code: 'ROUTE_DENIED' });
    assert.equal(f.intents.length, 0); assert.equal(b.finalize(null).PAPER.allocated, 0);
  }
});
test('composition_Home_expected_denials_consume_no_allowance_or_permit', async () => {
  const f = fixture({ phase: A }), b = f.budget();
  f.state.sessionIssued = true; f.state.sessionHandle = f.brand('session');
  f.state.homeTransition = f.brand('transition'); f.state.homeArmedAt = f.time.monotonicMs; f.state.documentPath = '/';
  for (const path of ['/api/recommendations', '/api/watchlist/default']) {
    const decision = await b.authorize(f.request(path), f.policy);
    assert.equal(decision.kind, 'ABORT_EXPECTED');
  }
  assert.equal(b.consumePermit({}, f.request(), f.policy).kind, 'FAIL');
  assert.equal(f.intents.length, 0); assert.equal(b.finalize(null).PAPER.allocated, 0);
});
test('composition_zero_cost_auth_is_acknowledged_exact_body_bound', async () => {
  for (const timing of ['await', 'consume']) {
    const entered = deferred(), ack = deferred(), bytes = Buffer.from('{"username":"synthetic","password":"offline"}');
    const f = fixture({ phase: A, journal: () => { entered.resolve(); return ack.promise; } }), b = f.budget();
    const req = f.request('/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes });
    const pending = b.authorize(req, f.policy); const result = timing === 'await' ? assert.rejects(pending, Error) : pending;
    await entered.promise;
    assert.deepEqual(f.intents[0].cost, { PAPER: 0, stock: 0 });
    if (timing === 'await') bytes[0] = 32;
    ack.resolve(); const permit = await result;
    if (timing === 'consume') { bytes[0] = 32; assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL'); }
    assert.equal(b.finalize(null).PAPER.allocated, 0);
  }
  const f = fixture({ phase: A }), b = f.budget(), req = f.request('/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes: Buffer.from('{"username":"synthetic","password":"offline"}') });
  const permit = await b.authorize(req, f.policy); assert.equal(b.consumePermit(permit, req, f.policy).kind, 'ADMITTED');
});
test('composition_receipt_expiry_rechecked_after_ack_and_at_consumption', async () => {
  // Separate earliest expiry for each real signed handle isolates ledger and policy checks.
  for (const kind of ['LEDGER_RECEIPT', 'RELEASE_RECEIPT', 'MAINTENANCE_RECEIPT']) for (const timing of ['await', 'consume']) {
    const entered = deferred(), ack = deferred(), f = fixture({ expiries: { [kind]: 170 }, journal: () => { entered.resolve(); return ack.promise; } }), b = f.budget();
    const req = f.request(), pending = b.authorize(req, f.policy); const result = timing === 'await' ? assert.rejects(pending, Error) : pending;
    await entered.promise;
    if (timing === 'await') f.time.wallMs = 170;
    ack.resolve(); const permit = await result;
    if (timing === 'consume') { f.time.wallMs = 170; assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL'); }
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  }
});
test('composition_full_schedule_real_postrestart_maintenance_totals_14_stock_0', async () => {
  const f = fixture(), b = f.budget();
  const schedule = [
    ['/api/market/status', [], 1, 'clock'], ['/api/robotrader/performance', [['environment', 'paper']], 2, 'accountPositions'],
    ['/api/robotrader/health', [], 1, 'account'], ['/api/paper-trades/account', [], 2, 'accountPositions'],
    ['/api/paper-trades/equity', [], 2, 'accountHistory'], ['/api/paper-trades/orders', [], 1, 'account'], ['/api/paper-trades/trades', [], 1, 'account'] ];
  const counts = { clock: 0, account: 0, positions: 0, history: 0 };
  for (const phase of [B, C]) {
    if (phase === C) f.postRestart();
    for (const [path, queryPairs, cost, category] of (phase === B ? schedule : schedule.slice(0, 3))) {
      const req = f.request(path, { queryPairs }), permit = await b.authorize(req, f.policy), admission = b.consumePermit(permit, req, f.policy);
      assert.equal(admission.kind, 'ADMITTED'); assert.equal(admission.cost.PAPER, cost);
      b.settle(admission.reservationId, { kind: 'CONFIRMED', evidence: f.brand('providerEvidence', { reservationId: admission.reservationId }) });
      if (category === 'clock') counts.clock++;
      else { counts.account++; if (category === 'accountPositions') counts.positions++; if (category === 'accountHistory') counts.history++; }
    }
  }
  assert.deepEqual(counts, { clock: 2, account: 8, positions: 3, history: 1 });
  const s = b.finalize(null); assert.equal(s.PAPER.allocated, 14); assert.equal(s.stock.allocated, 0);
  assert.equal(s.PAPER.externalCharged, 22); assert.equal(s.PAPER.remaining, 2); assert.equal(s.confirmed, 14);
});

test('composition_same_run_different_verified_release_configuration_denied', async () => {
  const f = fixture(), g = fixture({ configIdentity: 'c'.repeat(64), runId: f.state.runId }), b = f.budget();
  assert.equal(f.state.runId, g.state.runId);
  assert.ok(g.adapters.verifyRelease(g.release));
  await assert.rejects(b.authorize(g.request(), g.policy), { code: 'IDENTITY_MISMATCH' });
  assert.equal(f.intents.length, 0);
});

// Real independent receipt trusts reproduce a later ledger clock sample. The clocks
// are monotonic; all synthetic signatures and gate/body handles remain genuine.
for (const boundary of ['issue', 'consume']) {
  test('composition_late_ledger_sample_cannot_expire_release_at_' + boundary, async () => {
    let armed = false, checks = 0;
    const f = fixture({ expiries: { RELEASE_RECEIPT: 170 }, journal: () => {
      if (boundary === 'issue') { f.time.wallMs = 169; armed = true; }
      return Promise.resolve();
    } });
    const trust = receipts.createTrustContext({ ...f.options, consumedReceipts: new Set(), consumedNonces: new Set(), now: () => {
      if (armed && ++checks === (boundary === 'issue' ? 3 : 2)) f.time.wallMs = 170;
      return f.time.wallMs;
    } });
    const ledger = receipts.verifyReceipt(f.sign(f.frames.LEDGER_RECEIPT), 'LEDGER_RECEIPT', trust);
    const b = createBudget(ledger, { ...f.ports, trust }), req = f.request();
    if (boundary === 'issue') await assert.rejects(b.authorize(req, f.policy), { code: 'EXPIRED' });
    else {
      const permit = await b.authorize(req, f.policy); f.time.wallMs = 169; armed = true;
      assert.deepEqual(b.consumePermit(permit, req, f.policy), { kind: 'FAIL', code: 'EXPIRED' });
      assert.equal(b.consumePermit(permit, req, f.policy).code, 'REPLAY');
    }
    assert.equal(f.time.wallMs, 170); assert.equal(f.adapters.verifyRelease(f.release), null);
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  });
  test('composition_late_policy_sample_cannot_expire_ledger_at_' + boundary, async () => {
    let armed = false, checks = 0;
    const f = fixture({ expiries: { LEDGER_RECEIPT: 170 }, journal: () => {
      if (boundary === 'issue') { f.time.wallMs = 169; armed = true; }
      return Promise.resolve();
    } });
    const originalClock = f.context.clock;
    f.context.clock = () => { if (armed && ++checks === 2) f.time.wallMs = 170; return originalClock(); };
    const b = f.budget(), req = f.request();
    if (boundary === 'issue') await assert.rejects(b.authorize(req, f.policy), Error);
    else {
      const permit = await b.authorize(req, f.policy); f.time.wallMs = 169; armed = true;
      assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
    }
    assert.equal(f.time.wallMs, 170); assert.equal(b.finalize(null).PAPER.allocated, 2);
  });
}

for (const target of ['request', 'body', 'gateEpoch', 'session', 'phase', 'policyEpoch', 'readiness']) {
  test('composition_late_ledger_callback_mutation_' + target + '_denied', async () => {
    let armed = false, checks = 0, req;
    const login = target === 'body', bytes = Buffer.from('{"username":"synthetic","password":"offline"}');
    const f = fixture(login ? { phase: A } : {});
    const trust = receipts.createTrustContext({ ...f.options, consumedReceipts: new Set(), consumedNonces: new Set(), now: () => {
      if (armed && ++checks === 2) {
        if (target === 'request') req.rawTarget = '/api/orders';
        if (target === 'body') bytes[0] = 32;
        if (target === 'gateEpoch') f.state.gateEpoch++;
        if (target === 'policyEpoch') f.state.policyEpoch++;
        if (target === 'session') f.state.sessionHandle = f.brand('session');
        if (target === 'phase') f.state.phase = C;
        if (target === 'readiness') f.state.readiness = f.brand('readiness');
      }
      return f.time.wallMs;
    } });
    const ledger = receipts.verifyReceipt(f.sign(f.frames.LEDGER_RECEIPT), 'LEDGER_RECEIPT', trust);
    const b = createBudget(ledger, { ...f.ports, trust });
    req = login ? f.request('/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes }) : f.request();
    const permit = await b.authorize(req, f.policy); armed = true;
    assert.equal(b.consumePermit(permit, req, f.policy).kind, 'FAIL');
    assert.equal(b.finalize(null).PAPER.allocated, login ? 0 : 2);
  });
}

test('composition_nominal_freshness_guard_rejects_copies_replay_and_failed_sample', () => {
  const f = fixture();
  const make = () => receipts.createAdmissionReceiptGuard(f.ledger, f.trust, f.release, f.assets, f.maintenance);
  for (const args of [[{ ...f.ledger }, f.trust, f.release, f.assets, f.maintenance],
    [f.ledger, {}, f.release, f.assets, f.maintenance], [f.ledger, f.trust, { ...f.release }, f.assets, f.maintenance],
    [f.ledger, f.trust, f.release, { ...f.assets }, f.maintenance], [f.ledger, f.trust, f.release, f.assets, { ...f.maintenance }]]) {
    assert.throws(() => receipts.createAdmissionReceiptGuard(...args), { code: 'IDENTITY_MISMATCH' });
  }
  const guard = make();
  assert.throws(() => receipts.sampleAdmissionReceiptGuard({ ...guard }), { code: 'REPLAY' });
  assert.throws(() => receipts.validateAdmissionReceiptGuard(guard, 160), { code: 'REPLAY' });
  assert.equal(receipts.sampleAdmissionReceiptGuard(guard), 160);
  assert.throws(() => receipts.sampleAdmissionReceiptGuard(guard), { code: 'REPLAY' });
  receipts.validateAdmissionReceiptGuard(guard, 160);
  assert.throws(() => receipts.validateAdmissionReceiptGuard(guard, 160), { code: 'REPLAY' });
  assert.throws(() => JSON.stringify(guard), { code: 'PRIVACY_FAILED' });
  const failed = make(); f.time.wallMs = NaN;
  assert.throws(() => receipts.sampleAdmissionReceiptGuard(failed), { code: 'EXPIRED' });
  f.time.wallMs = 160;
  assert.throws(() => receipts.validateAdmissionReceiptGuard(failed, 160), { code: 'REPLAY' });
});

for (const target of ['release', 'maintenance', 'ledger', 'restart', 'maxAge', 'snapshotExpiry', 'run', 'Home', 'rollback', 'invalid', 'throws']) {
  test('composition_final_policy_sample_' + target + '_boundary_denied', async () => {
    let armed = false, checks = 0;
    const receiptKind = { release: 'RELEASE_RECEIPT', maintenance: 'MAINTENANCE_RECEIPT', ledger: 'LEDGER_RECEIPT', restart: 'RESTART_RECEIPT' }[target];
    const f = fixture({ phase: target === 'Home' ? A : B, expiries: receiptKind ? { [receiptKind]: 170 } : {} });
    if (target === 'restart') f.postRestart();
    if (target === 'Home') {
      f.state.sessionIssued = true; f.state.sessionHandle = f.brand('session');
      f.state.homeTransition = f.brand('transition'); f.state.homeArmedAt = 1000;
    }
    if (target === 'snapshotExpiry') f.state.expiresAt = 170;
    const originalClock = f.context.clock;
    f.context.clock = () => {
      if (armed && ++checks === 3) {
        if (receiptKind || target === 'snapshotExpiry') f.time.wallMs = 170;
        if (target === 'maxAge') f.time.wallMs = 161;
        if (target === 'run') f.time.monotonicMs = 1201000;
        if (target === 'Home') f.time.monotonicMs = 11000;
        if (target === 'rollback') f.time.wallMs = 159;
        if (target === 'invalid') f.time.wallMs = NaN;
        if (target === 'throws') throw new Error('private clock error');
      }
      return originalClock();
    };
    let b;
    if (target === 'maxAge') {
      const trust = receipts.createTrustContext({ ...f.options, maxAgeMs: 60, consumedReceipts: new Set(), consumedNonces: new Set() });
      const ledger = receipts.verifyReceipt(f.sign(f.frames.LEDGER_RECEIPT), 'LEDGER_RECEIPT', trust);
      b = createBudget(ledger, { ...f.ports, trust });
    } else b = f.budget();
    const req = target === 'Home' ? f.request('/', { origin: f.frames.RELEASE_RECEIPT.payload.origins.FRONTEND }) : f.request();
    const permit = await b.authorize(req, f.policy); armed = true;
    const denied = b.consumePermit(permit, req, f.policy);
    assert.equal(denied.kind, 'FAIL');
    assert.equal(b.consumePermit(permit, req, f.policy).code, 'REPLAY');
    assert.equal(b.finalize(null).PAPER.allocated, target === 'Home' ? 0 : 2);
  });
}

for (const expiresAt of [170, 200]) {
  test('composition_shared_final_wall_independent_clocks_release_' + expiresAt, async () => {
    let armed = false, checks = 0;
    const f = fixture({ expiries: { RELEASE_RECEIPT: expiresAt } });
    const trust = receipts.createTrustContext({ ...f.options, consumedReceipts: new Set(), consumedNonces: new Set(), now: () => {
      // The independent ledger clock reports 170 while the policy stays at 169.
      return armed && ++checks >= 2 ? 170 : f.time.wallMs;
    } });
    const ledger = receipts.verifyReceipt(f.sign(f.frames.LEDGER_RECEIPT), 'LEDGER_RECEIPT', trust);
    const b = createBudget(ledger, { ...f.ports, trust }), req = f.request(), permit = await b.authorize(req, f.policy);
    f.time.wallMs = 169; armed = true;
    const admission = b.consumePermit(permit, req, f.policy);
    assert.equal(admission.kind, expiresAt === 170 ? 'FAIL' : 'ADMITTED');
    assert.equal(f.time.wallMs, 169);
    assert.equal(b.finalize(null).PAPER.allocated, 2);
  });
}
