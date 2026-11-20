'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ACCEPT_VALUES, createPolicy, admitRequest, claimEligibility, revalidateEligibility } = require('../../guest/route-policy.cjs');
const P = 'PREFLIGHT', W = 'AWAIT_CREDENTIAL', A = 'AUTHENTICATING', B = 'OBSERVE_BEFORE_RESTART', H = 'HOLD_FOR_RESTART', C = 'OBSERVE_AFTER_RESTART', L = 'LOGOUT', V = 'VERIFY_REVOCATION';
const F = 'https://frontend.example.test', BACK = 'https://backend.example.test', RUN = 'a'.repeat(32);
// Independent transcription of every design row, including document-specific counters.
const rows = [
  ['frontend-document', 'FRONTEND', 'GET', '/login', [], { P: 1 }, 0],
  ['frontend-document', 'FRONTEND', 'GET', '/', [], { A: 1 }, 0],
  ['frontend-document', 'FRONTEND', 'GET', '/robo', [], { B: 1, C: 1 }, 0],
  ['frontend-document', 'FRONTEND', 'GET', '/portfolio', [], { B: 1 }, 0],
  ['frontend-document', 'FRONTEND', 'GET', '/activity', [], { B: 1 }, 0],
  ['health', 'BACKEND', 'GET', '/health', [], { P: 1, C: 1 }, 0],
  ['me', 'BACKEND', 'GET', '/api/me', [], { P: 2, A: 2, B: 1, C: 1, V: 2 }, 0],
  ['login', 'BACKEND', 'POST', '/api/login', [], { A: 1 }, 0],
  ['readiness', 'BACKEND', 'GET', '/api/readiness', [], { B: 2, C: 2 }, 0],
  ['market-status', 'BACKEND', 'GET', '/api/market/status', [], { P: 1, B: 1, C: 1 }, { P: 0, B: 1, C: 1 }],
  ['settings', 'BACKEND', 'GET', '/api/robotrader/settings', [], { B: 1, C: 1 }, 0],
  ['decisions', 'BACKEND', 'GET', '/api/robotrader/decisions', [['environment', 'paper'], ['limit', '25']], { B: 1, C: 1 }, 0],
  ['robo-orders', 'BACKEND', 'GET', '/api/robotrader/orders', [['environment', 'paper'], ['limit', '25']], { B: 1, C: 1 }, 0],
  ['performance', 'BACKEND', 'GET', '/api/robotrader/performance', [['environment', 'paper']], { B: 1, C: 1 }, 2],
  ['audit', 'BACKEND', 'GET', '/api/robotrader/audit', [['limit', '25']], { B: 1, C: 1 }, 0],
  ['robo-health', 'BACKEND', 'GET', '/api/robotrader/health', [], { B: 1, C: 1 }, 1],
  ['reconciliation', 'BACKEND', 'GET', '/api/robotrader/reconciliation-status', [['environment', 'paper']], { B: 1, C: 1 }, 0],
  ['portfolio-account', 'BACKEND', 'GET', '/api/paper-trades/account', [], { B: 1 }, 2],
  ['portfolio-equity', 'BACKEND', 'GET', '/api/paper-trades/equity', [], { B: 1 }, 2],
  ['activity-orders', 'BACKEND', 'GET', '/api/paper-trades/orders', [], { B: 1 }, 1],
  ['activity-trades', 'BACKEND', 'GET', '/api/paper-trades/trades', [], { B: 1 }, 1],
  ['notifications', 'BACKEND', 'GET', '/api/robotrader/notifications', [], { B: 1 }, 0],
  ['logout', 'BACKEND', 'POST', '/api/logout', [], { L: 1 }, 0],
  ['preflight-login', 'BACKEND', 'OPTIONS', '/api/login', [], { A: 1 }, 0],
  ['preflight-logout', 'BACKEND', 'OPTIONS', '/api/logout', [], { L: 1 }, 0],
];
const phase = { P, A, B, C, L, V };
function fixture(initialPhase = B) {
  let bodyValidator, browserValidator, next = 0, initialMarketRequest = null;
  const brands = new WeakMap();
  const browserEvidence = new WeakMap();
  const brand = (kind, metadata = {}) => { const handle = Object.freeze({}); brands.set(handle, { kind, ...metadata }); return handle; };
  const release = brand('release'), assets = brand('assets');
  const state = { runId: RUN, phase: initialPhase, redirectObserved: false, policyEpoch: 1, gateEpoch: 1, sessionEpoch: 1,
    sessionIssued: ![P, W, A].includes(initialPhase), sessionHandle: null, documentPath: '/login',
    homeTransition: null, homeArmedAt: null, holdStartedAt: null, expiresAt: 2000000,
    preauth: brand('preauth'), maintenance: brand('maintenance'), owner: brand('owner'),
    readiness: brand('readiness'), restart: brand('restart'), preauthResponse: null, marketResponse: null };
  if (state.sessionIssued) state.sessionHandle = brand('session');
  const time = { monotonicMs: 100000, wallMs: 1000000 };
  const context = {
    clock: () => ({ ...time }),
    snapshot: request => ({ ...state, sequence: request?.sequence ?? 1 }),
    verifyRelease: r => r === release ? { runId: RUN, origins: { FRONTEND: F, BACKEND: BACK }, expiresAt: 2000000, configIdentity: 'c'.repeat(64), assetManifestDigest: 'd'.repeat(64) } : null,
    verifyAssets: (a, r) => a === assets && r === release ? { runId: RUN, digest: 'd'.repeat(64), entries: [{ path: '/static/js/main.js', hash: 'e'.repeat(64), size: 12, mime: 'application/javascript' }] } : null,
    verifyGate: (kind, handle, binding) => brands.get(handle)?.kind === kind && binding.runId === RUN,
    responseFacts: handle => brands.get(handle),
    bindBodyValidator: fn => { bodyValidator = fn; },
    inspectBrowserEvidence: handle => browserEvidence.get(handle) ?? null,
    bindBrowserEvidenceValidator: fn => { browserValidator = fn; },
  };
  const policy = createPolicy(release, assets, context);
  function request(path = '/api/robotrader/settings', options = {}) {
    const id = ++next;
    const queryPairs = options.queryPairs ?? [];
    const suffix = queryPairs.length ? '?' + queryPairs.map(pair => pair.join('=')).join('&') : '';
    const req = { requestId: 'request-' + id, sequence: id, rawTarget: path + suffix, origin: BACK,
      method: 'GET', path, queryPairs, headers: [], phase: state.phase, bodyProof: null, ...options };
    delete req.bytes;
    delete req.redirectStatus;
    req.bodyProof = bodyValidator(req, options.bytes ?? Buffer.alloc(0));
    if (Object.hasOwn(options, 'redirectStatus')) req.redirectStatus = options.redirectStatus;
    if (path === '/api/market/status' && !initialMarketRequest) initialMarketRequest = req;
    return req;
  }
  function response(kind, metadata = {}) {
    return brand(kind, { requestId: initialMarketRequest?.requestId, sequence: initialMarketRequest?.sequence, runId: RUN, phase: state.phase, sessionHandle: state.sessionHandle, sessionEpoch: state.sessionEpoch,
      policyEpoch: state.policyEpoch, gateEpoch: state.gateEpoch, receivedAt: time.monotonicMs,
      asOf: time.wallMs, status: kind === 'preauthResponse' ? 401 : 200,
      source: 'PAPER', marketState: 'OPEN', schemaValid: true, ...metadata });
  }
  function browserRequest(path = '/api/robotrader/settings', options = {}) {
    const id = ++next, query = options.query ?? '';
    const evidence = Object.freeze({});
    browserEvidence.set(evidence, Object.freeze({ runId: RUN, requestId: 'browser-' + id, sequence: id,
      method: options.method ?? 'GET', url: (options.origin ?? BACK) + path + query,
      headers: options.headers ?? [], byteLength: options.byteLength ?? 0,
      schema: options.schema ?? 'ABSENT' }));
    return { evidence, request: browserValidator(evidence) };
  }
  return { policy, state, time, context, request, browserRequest,
    body: (r, bytes) => bodyValidator(r, bytes), response, brand };
}
function eligible(f, path, options) { const r = f.request(path, options); const d = admitRequest(r, f.policy); assert.equal(d.kind, 'ELIGIBLE'); return { r, d }; }
function denied(f, path, options) { assert.equal(admitRequest(f.request(path, options), f.policy).kind, 'FAIL'); }
function market(f) { return f.request('/api/market/status'); }
function home(f) { f.state.sessionIssued = true; f.state.sessionHandle = f.brand('session'); f.state.homeTransition = f.brand('transition'); f.state.homeArmedAt = f.time.monotonicMs; f.state.documentPath = '/'; }

test('every_spec_route_row', () => {
  const catalogue = JSON.parse(readFileSync(require.resolve('../../contracts/routes.json'), 'utf8'));
  assert.deepEqual(catalogue.routes.map(r => [r.id, r.destination, r.method, r.path, r.query, r.ceilings, r.paperCost]), rows);
  assert.equal(catalogue.runMaxMs, 1200000);
  assert.deepEqual(catalogue.assets, { destination: 'FRONTEND', method: 'GET', phases: ['P', 'A', 'B', 'C', 'L'], runCeiling: 5, paperCost: 0, stockCost: 0 });
  assert.deepEqual(catalogue.home, { phase: 'A', windowMs: 10000, paths: ['/api/recommendations', '/api/watchlist/default'], ceilingEach: 1 });
  assert.deepEqual(catalogue.timer, { path: '/api/market/status', preauthReplayCeiling: 32, phaseReplayCeiling: 32, freshnessMs: 60000, holdDeadlineMs: 600000, abortCeilings: { A: 2, B: 4, C: 4, H: 24, L: 2, V: 2 } });
  assert.deepEqual(catalogue.body, { loginMaxBytes: 16384, loginKeys: ['username', 'password'], logoutBytes: 0, getOptionsBytes: 0 });
  let clock = 0, account = 0, positions = 0, history = 0;
  for (const row of rows) for (const [letter, limit] of Object.entries(row[5])) {
    const f = fixture(phase[letter]);
    if (row[3] === '/') home(f);
    for (let i = 0; i < limit; i++) {
      const options = { method: row[2], queryPairs: row[4], origin: row[1] === 'FRONTEND' ? F : BACK };
      if (row[0] === 'login') { options.bytes = Buffer.from('{"username":"offline-user","password":"offline-value"}'); options.headers = [['content-type', 'application/json']]; }
      if (row[2] === 'OPTIONS') options.headers = [['origin', F], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'content-type']];
      const d = eligible(f, row[3], options).d;
      const cost = typeof row[6] === 'number' ? row[6] : row[6][letter];
      assert.deepEqual(d.cost, { PAPER: cost, stock: 0 }); assert.equal(d.routeId, row[0]);
    }
    if (row[0] !== 'market-status') denied(f, row[3], { method: row[2], queryPairs: row[4], origin: row[1] === 'FRONTEND' ? F : BACK,
      ...(row[0] === 'login' ? { bytes: Buffer.from('{"username":"u","password":"p"}'), headers: [['content-type', 'application/json']] } : {}),
      ...(row[2] === 'OPTIONS' ? { headers: [['origin', F], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'content-type']] } : {}) });
    if (['B', 'C'].includes(letter)) {
      if (row[0] === 'market-status') clock++;
      if (row[0] === 'performance') { account++; positions++; }
      if (row[0] === 'robo-health') account++;
      if (row[0] === 'portfolio-account') { account++; positions++; }
      if (row[0] === 'portfolio-equity') { account++; history++; }
      if (['activity-orders', 'activity-trades'].includes(row[0])) account++;
    }
  }
  assert.deepEqual({ clock, account, positions, history }, { clock: 2, account: 8, positions: 3, history: 1 });
  const f = fixture(W); eligible(f, '/login', { origin: F }); denied(f, '/login', { origin: F });
  for (const letter of [P, A, B, C, L]) { const f = fixture(letter); for (let i = 0; i < 5; i++) eligible(f, '/static/js/main.js', { origin: F }); denied(f, '/static/js/main.js', { origin: F }); }
  const f2 = fixture(P); for (let i = 0; i < 3; i++) eligible(f2, '/static/js/main.js', { origin: F }); f2.state.phase = B; f2.state.sessionIssued = true; f2.state.sessionHandle = f2.brand('session'); for (let i = 0; i < 2; i++) eligible(f2, '/static/js/main.js', { origin: F }); denied(f2, '/static/js/main.js', { origin: F });
});
test('encoded_path_duplicate_query_method_override_denied', () => {
  const f = fixture(); eligible(f, '/api/robotrader/settings');
  for (const rawTarget of ['/api/%72obotrad er/settings', '/api/robotrader/../robotrader/settings', '/api//robotrader/settings', '/api/robotrader/settings?', '/api/robotrader/settings#x', BACK + '/api/robotrader/settings', '/api/robotrader/settings%3f']) denied(fixture(), '/api/robotrader/settings', { rawTarget });
  for (const queryPairs of [[['environment', 'paper'], ['environment', 'paper'], ['limit', '25']], [['environment', '%70aper'], ['limit', '25']], [['environment', 'paper'], ['limit', '26']], [['environment', 'paper'], ['limit', '25'], ['x', '1']]]) denied(fixture(), '/api/robotrader/decisions', { queryPairs });
  eligible(f, '/api/robotrader/decisions', { queryPairs: [['limit', '25'], ['environment', 'paper']] });
  denied(fixture(), '/api/robotrader/decisions', { rawTarget: '/api/robotrader/decisions?environment=paper&limit=25', queryPairs: [] });
  for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'get']) denied(fixture(), '/api/me', { method });
  for (const headers of [[['x-http-method-override', 'GET']], [['x-method-override', 'GET']], [['content-length', '0']], [['origin', 'https://other.test']], [['origin', F], ['Origin', F]]]) denied(fixture(), '/api/me', { headers });
});
test('same_host_economic_post_denied', () => {
  const f = fixture(); eligible(f, '/api/me');
  for (const path of ['/api/paper-trades/orders', '/api/robotrader/settings', '/api/robotrader/activate', '/api/robotrader/close', '/api/notifications/test', '/api/queue/drain']) denied(fixture(), path, { method: 'POST' });
});
test('login_extra_key_duplicate_key_nonstring_oversize_rejected', () => {
  for (const body of ['{"username":"u","password":"p","x":"y"}', '{"username":"u","username":"v","password":"p"}', '{"user\\u006eame":"u","username":"v","password":"p"}', '{"username":1,"password":"p"}', '{"username":"u","password":null}', '{"username":"u","password":"' + 'x'.repeat(16384) + '"}', '{"username":"u"}', '[]']) {
    const f = fixture(A); eligible(f, '/api/me'); denied(f, '/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes: Buffer.from(body) });
  }
  const f = fixture(A); eligible(f, '/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes: Buffer.from('{ "password": "p", "username": "u" }') });
});
test('logout_nonempty_body_rejected', () => {
  for (const bytes of [Buffer.from('{}'), Buffer.from('null'), Buffer.from(' ')]) { const f = fixture(L); eligible(fixture(L), '/api/logout', { method: 'POST' }); denied(f, '/api/logout', { method: 'POST', bytes }); }
});
test('GET_OPTIONS_body_rejected', () => {
  const f = fixture(A); eligible(f, '/api/me');
  denied(f, '/api/me', { bytes: Buffer.from('{}') });
  denied(fixture(A), '/api/login', { method: 'OPTIONS', headers: [['origin', F], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'content-type']], bytes: Buffer.from(' ') });
});
test('body_proof_wrong_request_or_mutated_bytes_rejected', () => {
  const f = fixture(A); const { r, d } = eligible(f, '/api/me');
  const other = f.request('/api/me'); other.bodyProof = r.bodyProof; assert.equal(admitRequest(other, f.policy).kind, 'FAIL');
  const copied = fixture(A); const original = eligible(copied, '/api/me');
  assert.equal(claimEligibility(original.d, { ...original.r }, copied.policy).kind, 'FAIL');
  const forged = fixture(A); const fake = forged.request('/api/me'); fake.bodyProof = { runId: RUN, requestId: fake.requestId, byteLength: 0, schema: 'ABSENT', validated: true }; assert.equal(admitRequest(fake, forged.policy).kind, 'FAIL');
  const f2 = fixture(A); const bytes = Buffer.from('{"username":"u","password":"p"}'); const req = f2.request('/api/login', { method: 'POST', headers: [['content-type', 'application/json']], bytes }); bytes[bytes.indexOf('p"}')] = 113; assert.equal(admitRequest(req, f2.policy).kind, 'FAIL');
  const f3 = fixture(); const x = f3.request(); x.path = '/api/me'; x.rawTarget = '/api/me'; assert.equal(admitRequest(x, f3.policy).kind, 'FAIL');
  assert.throws(() => JSON.stringify(r.bodyProof));
});
test('alternate_origin_and_redirect_denied', () => {
  const f = fixture(); eligible(f, '/api/me');
  for (const origin of ['http://backend.example.test', BACK + ':443', 'https://other.test', BACK + '/', 'https://backend.example.test.evil.test']) denied(fixture(), '/api/robotrader/settings', { origin });
  denied(f, '/api/robotrader/settings', { redirectStatus: 302 });
  const f2 = fixture(); f2.state.marketResponse = f2.response('marketResponse', { status: 302 }); eligible(f2, '/api/market/status'); assert.equal(admitRequest(market(f2), f2.policy).kind, 'FAIL');
});
test('arbitrary_asset_denied', () => {
  const f = fixture(P); eligible(f, '/static/js/main.js', { origin: F });
  for (const path of ['/static/js/other.js', '/static/js/main.js.map', '/static/js/acceptance-missing.js', '/fonts/external.woff']) denied(fixture(P), path, { origin: F });
  denied(fixture(P), '/static/js/main.js', { origin: BACK });
  denied(fixture(H), '/static/js/main.js', { origin: F });
});
test('home_window_exactly_two_zero_forward_denials', () => {
  const f = fixture(A); home(f); eligible(f, '/', { origin: F });
  for (const path of ['/api/recommendations', '/api/watchlist/default']) { const d = admitRequest(f.request(path), f.policy); assert.equal(d.kind, 'ABORT_EXPECTED'); assert.equal(d.code, 'HOME_TRANSITION'); assert.equal(d.cost, undefined); }
  for (const path of ['/api/recommendations', '/api/watchlist/default']) { const repeated = fixture(A); home(repeated); assert.equal(admitRequest(repeated.request(path), repeated.policy).kind, 'ABORT_EXPECTED'); denied(repeated, path); }
  const g = fixture(A); home(g); g.time.monotonicMs += 10000; denied(g, '/api/recommendations');
  const h = fixture(A); home(h); h.time.monotonicMs += 9999; assert.equal(admitRequest(h.request('/api/watchlist/default'), h.policy).kind, 'ABORT_EXPECTED');
  const k = fixture(B); home(k); denied(k, '/api/recommendations');
  const m = fixture(A); home(m); denied(m, '/api/recommendations', { queryPairs: [['x', '1']] }); const n = fixture(A); home(n); denied(n, '/api/watchlist/default', { method: 'POST' });
});
test('quote_sparkline_denied', () => {
  const f = fixture(A); home(f); eligible(f, '/', { origin: F });
  for (const path of ['/api/quotes', '/api/sparkline', '/api/stocks/quotes', '/api/market/sparklines']) denied(fixture(), path, { method: 'POST' });
});
test('preauth_401_requires_login_document_and_no_session', () => {
  const f = fixture(P); eligible(f, '/api/market/status'); f.state.preauthResponse = f.response('preauthResponse');
  for (let i = 0; i < 32; i++) { if (i === 16) f.state.phase = A; const d = admitRequest(market(f), f.policy); assert.equal(d.kind, 'REPLAY_PRIVATE'); assert.equal(d.responseHandle, f.state.preauthResponse); }
  assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
  const g = fixture(P); eligible(g, '/api/market/status'); g.state.preauthResponse = g.response('preauthResponse'); g.state.documentPath = '/'; assert.equal(admitRequest(market(g), g.policy).kind, 'FAIL');
  const h = fixture(A); home(h); h.state.preauthResponse = h.response('preauthResponse'); assert.equal(admitRequest(market(h), h.policy).kind, 'ABORT_EXPECTED');
  const k = fixture(P); k.state.preauthResponse = k.response('preauthResponse'); eligible(k, '/api/market/status');
  const m = fixture(P); eligible(m, '/api/market/status'); m.state.preauthResponse = m.response('preauthResponse', { status: 200 }); assert.equal(admitRequest(market(m), m.policy).kind, 'FAIL');
});
test('authenticated_timer_never_replays_401', () => {
  for (const p of [B, C]) {
    const f = fixture(p); f.state.preauthResponse = f.response('preauthResponse'); f.state.readiness = null;
    for (let i = 0; i < 4; i++) assert.equal(admitRequest(market(f), f.policy).kind, 'ABORT_EXPECTED'); assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
    const g = fixture(p); eligible(g, '/api/market/status'); g.state.marketResponse = g.response('marketResponse');
    for (let i = 0; i < 32; i++) { const d = admitRequest(market(g), g.policy); assert.equal(d.kind, 'REPLAY_PRIVATE'); assert.equal(d.responseHandle, g.state.marketResponse); }
    assert.equal(admitRequest(market(g), g.policy).kind, 'FAIL');
  }
  for (const [p, n] of [[A, 2], [H, 24], [L, 2], [V, 2]]) {
    const f = fixture(p); if (p === A) home(f); if (p === H) f.state.holdStartedAt = f.time.monotonicMs;
    for (let i = 0; i < n; i++) assert.equal(admitRequest(market(f), f.policy).kind, 'ABORT_EXPECTED'); assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
  }
  const h = fixture(H); h.state.holdStartedAt = h.time.monotonicMs - 600000; assert.equal(admitRequest(market(h), h.policy).kind, 'FAIL');
});
test('freshness_and_phase_invalidation', () => {
  const f = fixture(); eligible(f, '/api/market/status'); f.state.marketResponse = f.response('marketResponse'); f.time.monotonicMs += 60000; f.time.wallMs += 60000;
  assert.equal(admitRequest(market(f), f.policy).kind, 'REPLAY_PRIVATE');
  f.time.monotonicMs++; f.time.wallMs++; for (let i = 0; i < 4; i++) assert.equal(admitRequest(market(f), f.policy).kind, 'ABORT_EXPECTED'); assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
  const staleView = fixture(); eligible(staleView, '/api/market/status'); staleView.state.marketResponse = staleView.response('marketResponse'); staleView.time.monotonicMs += 60001; staleView.time.wallMs += 60001; denied(staleView, '/api/robotrader/settings');
  for (const metadata of [{ schemaValid: false }, { source: 'SIMULATOR' }, { marketState: 'UNKNOWN' }, { asOf: 1000001 }, { receivedAt: 100001 }, { sessionEpoch: 2 }]) {
    const g = fixture(); eligible(g, '/api/market/status'); g.state.marketResponse = g.response('marketResponse', metadata); assert.equal(admitRequest(market(g), g.policy).kind, 'FAIL');
  }
  const g = fixture(); eligible(g, '/api/market/status'); const old = g.response('marketResponse'); g.state.marketResponse = old;
  assert.equal(admitRequest(market(g), g.policy).kind, 'REPLAY_PRIVATE'); g.state.phase = H; g.state.holdStartedAt = g.time.monotonicMs; assert.equal(admitRequest(market(g), g.policy).kind, 'ABORT_EXPECTED');
  g.state.phase = C; g.state.marketResponse = old; eligible(g, '/api/market/status'); assert.equal(admitRequest(market(g), g.policy).kind, 'FAIL');
  const k = fixture(); const { r, d } = eligible(k); const claim = claimEligibility(d, r, k.policy); assert.equal(claim.kind, 'CLAIMED'); k.time.wallMs = k.state.expiresAt; assert.equal(revalidateEligibility(claim, r, k.policy).kind, 'FAIL');
});
test('atomic_ceiling_no_double_admission', async () => {
  const f = fixture(); const results = await Promise.all(Array.from({ length: 8 }, async () => admitRequest(f.request('/api/robotrader/performance', { queryPairs: [['environment', 'paper']] }), f.policy)));
  assert.equal(results.filter(d => d.kind === 'ELIGIBLE').length, 1); assert.equal(results.filter(d => d.kind === 'FAIL').length, 7);
  const g = fixture(); const { r, d } = eligible(g); const forged = fixture(); const original = eligible(forged); assert.equal(claimEligibility({ ...original.d }, original.r, forged.policy).kind, 'FAIL'); const claim = claimEligibility(d, r, g.policy); assert.equal(claim.kind, 'CLAIMED'); assert.equal(revalidateEligibility(claim, r, g.policy).kind, 'ELIGIBLE'); assert.equal(revalidateEligibility(claim, r, g.policy).kind, 'ELIGIBLE'); assert.equal(claimEligibility(d, r, g.policy).kind, 'FAIL');
  const copied = fixture(); const original2 = eligible(copied); const realClaim = claimEligibility(original2.d, original2.r, copied.policy); assert.equal(revalidateEligibility({ ...realClaim }, original2.r, copied.policy).kind, 'FAIL'); denied(g, '/api/robotrader/settings');
});
test('complete_request_gate_and_epoch_binding', () => {
  for (const change of [f => { f.state.phase = C; }, f => { f.state.policyEpoch++; }, f => { f.state.gateEpoch++; }, f => { f.state.sessionEpoch++; }, f => { f.state.sessionHandle = f.brand('session'); }, f => { f.state.maintenance = null; }, f => { f.state.readiness = null; }, f => { f.state.owner = null; }, f => { f.state.documentPath = '/portfolio'; }]) {
    const f = fixture(); const { r, d } = eligible(f); const claim = claimEligibility(d, r, f.policy); assert.equal(claim.kind, 'CLAIMED'); change(f); assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'FAIL');
  }
  for (const change of [r => { r.requestId = 'other'; }, r => { r.sequence++; }, r => { r.method = 'POST'; }, r => { r.path = '/api/me'; }, r => { r.rawTarget += '?'; }, r => { r.origin = F; }, r => { r.queryPairs.push(['x', '1']); }, r => { r.headers.push(['origin', F]); }, r => { r.phase = C; }, r => { r.bodyProof = {}; }]) {
    const f = fixture(); const { r, d } = eligible(f); const claim = claimEligibility(d, r, f.policy); change(r); assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'FAIL');
  }
  const f = fixture(); f.state.readiness = {}; denied(f, '/api/robotrader/performance', { queryPairs: [['environment', 'paper']] });
  const p = fixture(P); p.state.preauth = {}; denied(p, '/health');
  const c = fixture(C); c.state.restart = {}; denied(c, '/health');
  const a = fixture(A); a.state.sessionIssued = true; a.state.sessionHandle = a.brand('session'); denied(a, '/api/login', { method: 'POST', bytes: Buffer.from('{"username":"u","password":"p"}'), headers: [['content-type', 'application/json']] });
  for (const p of ['FINALIZE', 'DONE', 'FAILED', H]) { const f = fixture(p); denied(f, '/api/me'); }
  const bad = fixture(); bad.context.verifyGate = () => { throw new Error('private-error'); }; assert.deepEqual(admitRequest(bad.request(), bad.policy), { kind: 'FAIL', code: 'INTERNAL_FAILURE' });
});
test('fatal_failure_invalidates_policy_and_outstanding_claims', () => {
  const f = fixture(); const { r, d } = eligible(f); const claim = claimEligibility(d, r, f.policy); assert.equal(claim.kind, 'CLAIMED');
  denied(f, '/api/paper-trades/orders', { method: 'POST' });
  denied(f, '/api/me'); assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'FAIL');
  const g = fixture(); eligible(g, '/api/market/status'); g.state.marketResponse = g.response('marketResponse'); assert.equal(admitRequest(market(g), g.policy).kind, 'REPLAY_PRIVATE');
  denied(g, '/api/economic-mutation', { method: 'POST' }); assert.equal(admitRequest(market(g), g.policy).kind, 'FAIL');
});
test('atomic_snapshot_and_body_changes_during_gate_validation_denied', () => {
  const f = fixture(); const original = f.context.verifyGate;
  f.context.verifyGate = (...args) => { const result = original(...args); f.state.gateEpoch++; return result; };
  assert.equal(admitRequest(f.request(), f.policy).kind, 'FAIL');
  const g = fixture(A); const bytes = Buffer.from('{"username":"u","password":"p"}'); const req = g.request('/api/login', { method: 'POST', bytes, headers: [['content-type', 'application/json']] });
  const verify = g.context.verifyGate; g.context.verifyGate = (...args) => { const result = verify(...args); bytes[bytes.indexOf('p"}')] = 113; return result; };
  assert.equal(admitRequest(req, g.policy).kind, 'FAIL');
});
test('market_replay_bound_to_original_request_and_same_private_response', () => {
  for (const metadata of [{ requestId: 'other' }, { sequence: 999 }]) {
    const f = fixture(); eligible(f, '/api/market/status'); f.state.marketResponse = f.response('marketResponse', metadata);
    assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
  }
  const f = fixture(); eligible(f, '/api/market/status'); f.state.marketResponse = f.response('marketResponse');
  assert.equal(admitRequest(market(f), f.policy).kind, 'REPLAY_PRIVATE'); f.state.marketResponse = f.response('marketResponse'); assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
});
test('qualified_expiry_and_monotonic_run_deadline_are_rechecked', () => {
  const f = fixture(); const { r, d } = eligible(f); const claim = claimEligibility(d, r, f.policy);
  f.time.monotonicMs += 1200000; assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'FAIL');
  const g = fixture(); eligible(g); g.time.monotonicMs--; denied(g, '/api/me');
  const beforeFirstRequest = fixture(); beforeFirstRequest.time.monotonicMs--; denied(beforeFirstRequest, '/api/me');
});
test('boundary_exceptions_never_emit_private_error_codes', () => {
  const f = fixture(); f.context.verifyGate = () => { const error = new Error('private-boundary-detail'); error.code = 'PRIVATE_DETAIL'; throw error; };
  assert.deepEqual(admitRequest(f.request(), f.policy), { kind: 'FAIL', code: 'INTERNAL_FAILURE' });
});
test('cors_exact_headers_and_zero_body_auth_claims', () => {
  for (const p of [A, L]) for (const headers of [
    [['origin', F], ['access-control-request-method', 'POST']],
    [['origin', F], ['access-control-request-method', 'GET'], ['access-control-request-headers', 'content-type']],
    [['origin', F], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'content-type,x-custom']],
    [['origin', F], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'Content-Type']],
    [['origin', BACK], ['access-control-request-method', 'POST'], ['access-control-request-headers', 'content-type']],
  ]) denied(fixture(p), p === A ? '/api/login' : '/api/logout', { method: 'OPTIONS', headers });
  const f = fixture(L); const { r, d } = eligible(f, '/api/logout', { method: 'POST' }); const claim = claimEligibility(d, r, f.policy);
  assert.equal(claim.kind, 'CLAIMED'); assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'ELIGIBLE'); r.bodyProof = f.body(r, Buffer.from('{}')); assert.equal(revalidateEligibility(claim, r, f.policy).kind, 'FAIL');
  const g = fixture(A); const bytes = Buffer.from('{"username":"u","password":"p"}'); const initial = eligible(g, '/api/login', { method: 'POST', bytes, headers: [['content-type', 'application/json']] }); const loginClaim = claimEligibility(initial.d, initial.r, g.policy);
  assert.equal(loginClaim.kind, 'CLAIMED'); bytes[bytes.indexOf('p"}')] = 113; assert.equal(revalidateEligibility(loginClaim, initial.r, g.policy).kind, 'FAIL');
});
test('cached_market_response_cannot_be_withdrawn_to_bypass_freshness', () => {
  const f = fixture(); eligible(f, '/api/market/status'); f.state.marketResponse = f.response('marketResponse'); assert.equal(admitRequest(market(f), f.policy).kind, 'REPLAY_PRIVATE');
  f.time.monotonicMs += 60001; f.time.wallMs += 60001; f.state.marketResponse = null; denied(f, '/api/robotrader/settings');
});
test('trusted_redirect_provenance_denies_permitted_same_host_routes_and_claims', () => {
  const f = fixture(); f.state.redirectObserved = true;
  denied(f, '/api/me'); denied(f, '/api/robotrader/settings');
  const g = fixture(); const { r, d } = eligible(g); const claim = claimEligibility(d, r, g.policy);
  assert.equal(claim.kind, 'CLAIMED'); g.state.redirectObserved = true; assert.equal(revalidateEligibility(claim, r, g.policy).kind, 'FAIL');
  const h = fixture(); eligible(h, '/api/market/status'); h.state.marketResponse = h.response('marketResponse'); h.state.redirectObserved = true;
  assert.equal(admitRequest(market(h), h.policy).kind, 'FAIL');
});
// Exactly two deterministic samples: initial predicate boundary, then its expiry.
function crossingClock(f, first, final) {
  let reads = 0;
  f.context.clock = () => ({ ...(reads++ === 0 ? first : final) });
  return () => assert.equal(reads, 2, 'one initial and one final sample, no resampling loop');
}
function marketEvidence(f) { eligible(f, '/api/market/status'); f.state.marketResponse = f.response('marketResponse'); }
test('final_clock_market_expiry_uses_one_bounded_abort_slot', () => {
  for (const phase of [B, C]) {
    const f = fixture(phase); marketEvidence(f);
    const checkReads = crossingClock(f, { monotonicMs: 160000, wallMs: 1060000 }, { monotonicMs: 160001, wallMs: 1060001 });
    assert.deepEqual(admitRequest(market(f), f.policy), { kind: 'ABORT_EXPECTED', code: 'MARKET_TIMER' }); checkReads();
    for (let i = 0; i < 3; i++) assert.equal(admitRequest(market(f), f.policy).kind, 'ABORT_EXPECTED');
    assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
  }
});
test('final_clock_wall_expiry_does_not_consume_a_replay_slot', () => {
  const f = fixture(); marketEvidence(f);
  const checkReads = crossingClock(f, { monotonicMs: 100000, wallMs: 1060000 }, { monotonicMs: 100001, wallMs: 1060001 });
  assert.equal(admitRequest(market(f), f.policy).kind, 'ABORT_EXPECTED'); checkReads();
  // Qualified wall correction by 1ms cannot refund monotonic counters.
  f.context.clock = () => ({ monotonicMs: 100001, wallMs: 1060000 });
  for (let i = 0; i < 32; i++) assert.equal(admitRequest(market(f), f.policy).kind, 'REPLAY_PRIVATE');
  assert.equal(admitRequest(market(f), f.policy).kind, 'FAIL');
});
test('final_clock_home_denial_window_expiry_fails', () => {
  for (const path of ['/api/recommendations', '/api/watchlist/default']) {
    const f = fixture(A); home(f);
    const checkReads = crossingClock(f, { monotonicMs: 109999, wallMs: 1000000 }, { monotonicMs: 110000, wallMs: 1000001 });
    assert.equal(admitRequest(f.request(path), f.policy).kind, 'FAIL'); checkReads();
  }
});
test('final_clock_home_document_window_expiry_fails', () => {
  const f = fixture(A); home(f);
  const checkReads = crossingClock(f, { monotonicMs: 109999, wallMs: 1000000 }, { monotonicMs: 110000, wallMs: 1000001 });
  assert.equal(admitRequest(f.request('/', { origin: F }), f.policy).kind, 'FAIL'); checkReads();
});
test('final_clock_hold_timer_deadline_expiry_fails', () => {
  const f = fixture(H); f.state.holdStartedAt = f.time.monotonicMs;
  const checkReads = crossingClock(f, { monotonicMs: 699999, wallMs: 1000000 }, { monotonicMs: 700000, wallMs: 1000001 });
  assert.deepEqual(admitRequest(market(f), f.policy), { kind: 'FAIL', code: 'DEADLINE' }); checkReads();
});
test('final_clock_view_freshness_expiry_fails_before_reservation', () => {
  for (const phase of [B, C]) for (const [path, options] of [['/api/robotrader/settings', {}], ['/api/robotrader/performance', { queryPairs: [['environment', 'paper']] }]]) {
    const f = fixture(phase); marketEvidence(f);
    const checkReads = crossingClock(f, { monotonicMs: 160000, wallMs: 1060000 }, { monotonicMs: 160001, wallMs: 1060001 });
    assert.deepEqual(admitRequest(f.request(path, options), f.policy), { kind: 'FAIL', code: 'OBSERVATION_FAILED' }); checkReads();
  }
});
test('final_clock_claim_view_freshness_expiry_fails', () => {
  const f = fixture(); marketEvidence(f); const { r, d } = eligible(f);
  const checkReads = crossingClock(f, { monotonicMs: 160000, wallMs: 1060000 }, { monotonicMs: 160001, wallMs: 1060001 });
  assert.deepEqual(claimEligibility(d, r, f.policy), { kind: 'FAIL', code: 'OBSERVATION_FAILED' }); checkReads();
});
test('final_clock_revalidate_view_freshness_expiry_fails', () => {
  const f = fixture(); marketEvidence(f); const { r, d } = eligible(f); const claim = claimEligibility(d, r, f.policy); assert.equal(claim.kind, 'CLAIMED');
  const checkReads = crossingClock(f, { monotonicMs: 160000, wallMs: 1060000 }, { monotonicMs: 160001, wallMs: 1060001 });
  assert.deepEqual(revalidateEligibility(claim, r, f.policy), { kind: 'FAIL', code: 'OBSERVATION_FAILED' }); checkReads();
});
test('final_clock_claim_home_document_expiry_fails', () => {
  const f = fixture(A); home(f); const { r, d } = eligible(f, '/', { origin: F });
  const checkReads = crossingClock(f, { monotonicMs: 109999, wallMs: 1000000 }, { monotonicMs: 110000, wallMs: 1000001 });
  assert.deepEqual(claimEligibility(d, r, f.policy), { kind: 'FAIL', code: 'DEADLINE' }); checkReads();
});
test('final_clock_revalidate_home_document_expiry_fails', () => {
  const f = fixture(A); home(f); const { r, d } = eligible(f, '/', { origin: F }); const claim = claimEligibility(d, r, f.policy); assert.equal(claim.kind, 'CLAIMED');
  const checkReads = crossingClock(f, { monotonicMs: 109999, wallMs: 1000000 }, { monotonicMs: 110000, wallMs: 1000001 });
  assert.deepEqual(revalidateEligibility(claim, r, f.policy), { kind: 'FAIL', code: 'DEADLINE' }); checkReads();
});
test('final_clock_future_market_timestamp_is_invalid_evidence', () => {
  for (const timer of [true, false]) {
    const f = fixture(); marketEvidence(f);
    const checkReads = crossingClock(f, { monotonicMs: 100000, wallMs: 1000000 }, { monotonicMs: 100001, wallMs: 999999 });
    assert.deepEqual(admitRequest(timer ? market(f) : f.request(), f.policy), { kind: 'FAIL', code: 'OBSERVATION_FAILED' }); checkReads();
  }
});

test('authenticated_browser_evidence_mints_module_local_body_proof_bound_to_exact_request', () => {
  const f = fixture(A);
  const login = f.browserRequest('/api/login', { method: 'POST',
    headers: [['content-type', 'application/json']], byteLength: 45,
    schema: 'LOGIN_JSON' });
  assert.equal(admitRequest(login.request, f.policy).kind, 'ELIGIBLE');
  assert.throws(() => JSON.stringify(login.request.bodyProof), { code: 'PRIVACY_FAILED' });

  const copied = { ...login.request, requestId: 'browser-copy' };
  assert.equal(admitRequest(copied, f.policy).kind, 'FAIL');
  const plain = f.request('/api/me');
  plain.bodyProof = { schema: 'ABSENT', bodyDigest: '0'.repeat(64) };
  assert.equal(admitRequest(plain, f.policy).kind, 'FAIL');
});

test('accept_admitted_only_by_exact_chromium_table', () => {
  // P69: an exact-match table of the pinned Chromium's default accept values plus the existing API values.
  const navigation = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  assert.deepEqual(ACCEPT_VALUES.map(row => row.value), [
    'application/json', 'application/json, text/plain, */*', '*/*', 'text/html',
    navigation + ',application/signed-exchange;v=b3;q=0.7', navigation, 'text/css,*/*;q=0.1',
    'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  ]);
  assert.equal(Object.isFrozen(ACCEPT_VALUES), true);
  for (const row of ACCEPT_VALUES) {
    assert.deepEqual(Object.keys(row).sort(), ['kind', 'stage2', 'value']);
    assert.equal(row.stage2, 'Stage 2 confirm on the pinned Chromium');
    assert.equal(Object.isFrozen(row), true);
  }
  // Every listed value admits the /login document in phase P; nothing else does.
  for (const { value } of ACCEPT_VALUES) eligible(fixture(P), '/login', { origin: F, headers: [['accept', value]] });
  for (const value of ['text/html, application/xhtml+xml', navigation + ',', navigation.toUpperCase(), 'text/css,*/*;q=0.10', 'text/css',
    'image/*', 'application/json;q=1', 'application/json,text/plain,*/*', ' */*', '*/*;q=0.8', '']) {
    denied(fixture(P), '/login', { origin: F, headers: [['accept', value]] });
  }
});
