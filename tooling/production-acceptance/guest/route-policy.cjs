'use strict';
const { createHash } = require('node:crypto');
const catalogue = require('../contracts/routes.json');
const failureCodes = new Set(require('../contracts/schema.json').definitions.Failure.values);
function errorCode(error) { try { return failureCodes.has(error?.code) ? error.code : 'INTERNAL_FAILURE'; } catch { return 'INTERNAL_FAILURE'; } }
const policies = new WeakMap(), proofs = new WeakMap(), decisions = new WeakMap(), claims = new WeakMap();
const phases = { PREFLIGHT: 'P', AWAIT_CREDENTIAL: 'P', AUTHENTICATING: 'A', OBSERVE_BEFORE_RESTART: 'B', HOLD_FOR_RESTART: 'H', OBSERVE_AFTER_RESTART: 'C', LOGOUT: 'L', VERIFY_REVOCATION: 'V', FINALIZE: 'F', DONE: 'D', FAILED: 'X' };
const factsKeys = ['requestId', 'sequence', 'rawTarget', 'origin', 'method', 'path', 'queryPairs', 'headers', 'phase', 'bodyProof'];
const snapshotKeys = ['runId', 'sequence', 'phase', 'redirectObserved', 'policyEpoch', 'gateEpoch', 'sessionEpoch', 'sessionIssued', 'sessionHandle', 'documentPath', 'homeTransition', 'homeArmedAt', 'holdStartedAt', 'expiresAt', 'preauth', 'maintenance', 'owner', 'readiness', 'restart', 'preauthResponse', 'marketResponse'];
const bindingKeys = snapshotKeys;
const safe = x => Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0);
const handle = x => x !== null && typeof x === 'object';
const fail = (code = 'ROUTE_DENIED') => Object.freeze({ kind: 'FAIL', code: failureCodes.has(code) ? code : 'INTERNAL_FAILURE' });
function fatal(state, code) {
  if (state) { state.failed = true; for (const record of state.marketScopes.values()) if (record.responseHandle) state.invalidResponses.add(record.responseHandle); state.marketScopes.clear(); }
  return fail(code);
}
function invalid(code = 'ROUTE_DENIED') { const e = new Error(code); e.code = code; throw e; }
function freeze(value) { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
freeze(catalogue);
function opaque(fields = {}) {
  const object = { ...fields };
  Object.defineProperty(object, 'toJSON', { value() { invalid('PRIVACY_FAILED'); }, enumerable: false });
  return Object.freeze(object);
}
function exactKeys(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Reflect.ownKeys(object).length !== keys.length) invalid();
  for (const k of keys) if (!Object.hasOwn(object, k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(object, k), 'value')) invalid();
}
function pairs(value) {
  if (!Array.isArray(value) || value.length > 64) invalid();
  return value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(x => typeof x !== 'string' || x.length > 4096)) invalid();
    return [pair[0], pair[1]];
  });
}
function facts(request) {
  exactKeys(request, factsKeys);
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.requestId) || !safe(request.sequence) || request.sequence === 0) invalid();
  for (const k of ['rawTarget', 'origin', 'method', 'path', 'phase']) if (typeof request[k] !== 'string' || request[k].length > 4096) invalid();
  return { ...request, queryPairs: pairs(request.queryPairs), headers: pairs(request.headers) };
}
function sameFacts(a, b) {
  return factsKeys.every(k => k === 'queryPairs' || k === 'headers' ? JSON.stringify(a[k]) === JSON.stringify(b[k]) : a[k] === b[k]);
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function loginJSON(bytes) {
  if (bytes.length > catalogue.body.loginMaxBytes) return false;
  // Exactly two string-to-string entries; parse decoded names before accepting them.
  const token = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const pattern = new RegExp('^[ \\t\\r\\n]*\\{[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*,[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*\\}[ \\t\\r\\n]*$');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), match = pattern.exec(text);
    if (!match) return false;
    const keys = [JSON.parse(match[1]), JSON.parse(match[3])].sort();
    return keys[0] === 'password' && keys[1] === 'username';
  } catch { return false; }
}
function bodyProof(request, bytes, state) {
  const captured = facts(request), proof = opaque();
  let schema = 'INVALID';
  if (Buffer.isBuffer(bytes)) {
    if (captured.method === 'POST' && captured.path === '/api/login' && loginJSON(bytes)) schema = 'LOGIN_JSON';
    else if (bytes.length === 0) schema = 'ABSENT';
  }
  proofs.set(proof, { state, request, captured, bytes, schema, digest: Buffer.isBuffer(bytes) ? digest(bytes) : null });
  return proof;
}
function checkBody(request, captured, state) {
  const p = proofs.get(request.bodyProof);
  if (!p || p.state !== state || p.request !== request || p.schema === 'INVALID' || !sameFacts({ ...p.captured, bodyProof: request.bodyProof }, captured) || digest(p.bytes) !== p.digest) invalid();
  const required = captured.method === 'POST' && captured.path === '/api/login' ? 'LOGIN_JSON' : 'ABSENT';
  if (p.schema !== required) invalid();
}
function createPolicy(release, assets, context) {
  try {
    for (const k of ['snapshot', 'clock', 'verifyRelease', 'verifyAssets', 'verifyGate', 'responseFacts', 'bindBodyValidator']) if (typeof context?.[k] !== 'function') invalid('IDENTITY_MISMATCH');
    const r = context.verifyRelease(release), a = context.verifyAssets(assets, release);
    if (!r || !a || !/^[0-9a-f]{32}$/.test(r.runId) || a.runId !== r.runId || !safe(r.expiresAt) || !/^[0-9a-f]{64}$/.test(r.configIdentity) || a.digest !== r.assetManifestDigest) invalid('IDENTITY_MISMATCH');
    // Receipt verification must precede this boundary; additionally forbid URL normalization.
    exactKeys(r.origins, ['FRONTEND', 'BACKEND']);
    for (const origin of Object.values(r.origins)) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password) invalid('IDENTITY_MISMATCH');
    }
    if (r.origins.FRONTEND === r.origins.BACKEND || !Array.isArray(a.entries) || a.entries.length < 1 || a.entries.length > 128) invalid('IDENTITY_MISMATCH');
    const assetMap = new Map();
    for (const entry of a.entries) {
      if (typeof entry.path !== 'string' || !canonicalPath(entry.path) || entry.path.endsWith('.map') || entry.path === '/static/js/acceptance-missing.js' || catalogue.routes.some(row => row.destination === 'FRONTEND' && row.path === entry.path) || !/^[0-9a-f]{64}$/.test(entry.hash) || !safe(entry.size) || typeof entry.mime !== 'string' || assetMap.has(entry.path)) invalid('IDENTITY_MISMATCH');
      assetMap.set(entry.path, Object.freeze({ ...entry }));
    }
    const started = context.clock(); exactKeys(started, ['monotonicMs', 'wallMs']);
    if (!safe(started.monotonicMs) || !safe(started.wallMs) || !safe(started.monotonicMs + catalogue.runMaxMs) || started.wallMs >= r.expiresAt) invalid('EXPIRED');
    const state = { runDeadline: started.monotonicMs + catalogue.runMaxMs, context, release, assets, releaseFacts: freeze({ ...r, origins: { ...r.origins } }), assetMap,
      counts: new Map(), seenRequests: new WeakSet(), requestIds: new Set(), sequenceIds: new Set(),
      failed: false, preauthAttempt: null, preauthHandle: null, preauthReplays: 0, replays: new Map(), aborts: new Map(), homeSeen: new Set(), homeTransition: null,
      homeClosed: false, marketScopes: new Map(), invalidResponses: new WeakSet(), lastScope: null, lastMonotonic: started.monotonicMs };
    const policy = opaque(); policies.set(policy, state);
    context.bindBodyValidator((request, bytes) => bodyProof(request, bytes, state));
    return policy;
  } catch (e) { invalid(errorCode(e)); }
}
function canonicalPath(path) { return /^\/[A-Za-z0-9_./-]*$/.test(path) && !path.includes('//') && !path.split('/').some(segment => segment === '.' || segment === '..'); }
function current(state, request) {
  if (state.failed) invalid('ROUTE_DENIED');
  const time = state.context.clock(), supplied = state.context.snapshot(request);
  exactKeys(time, ['monotonicMs', 'wallMs']); exactKeys(supplied, snapshotKeys);
  const s = { ...supplied };
  if (s.redirectObserved !== false) invalid('ROUTE_DENIED');
  if (!safe(time.monotonicMs) || !safe(time.wallMs) || (state.lastMonotonic !== null && time.monotonicMs < state.lastMonotonic) || time.monotonicMs >= state.runDeadline) invalid('DEADLINE');
  state.lastMonotonic = time.monotonicMs;
  if (s.runId !== state.releaseFacts.runId || !Object.hasOwn(phases, s.phase) || !safe(s.sequence) || !s.sequence || !['policyEpoch', 'gateEpoch', 'sessionEpoch', 'expiresAt'].every(k => safe(s[k])) || typeof s.sessionIssued !== 'boolean' || typeof s.documentPath !== 'string') invalid('IDENTITY_MISMATCH');
  if ((s.sessionIssued && !handle(s.sessionHandle)) || (!s.sessionIssued && s.sessionHandle !== null)) invalid('SESSION_MISMATCH');
  for (const k of ['homeArmedAt', 'holdStartedAt']) if (s[k] !== null && !safe(s[k])) invalid();
  for (const k of ['homeTransition', 'preauth', 'maintenance', 'owner', 'readiness', 'restart', 'preauthResponse', 'marketResponse']) if (s[k] !== null && !handle(s[k])) invalid();
  if (time.wallMs >= Math.min(state.releaseFacts.expiresAt, s.expiresAt)) invalid('EXPIRED');
  const scope = [s.phase, s.policyEpoch, s.gateEpoch, s.sessionEpoch, s.sessionHandle];
  if (state.lastScope && scope.some((v, i) => v !== state.lastScope[i])) {
    for (const record of state.marketScopes.values()) if (record.responseHandle) state.invalidResponses.add(record.responseHandle);
    state.marketScopes.clear();
  }
  state.lastScope = scope;
  return { s, time, letter: phases[s.phase] };
}
function gate(state, kind, s, time) {
  const binding = Object.freeze({ runId: s.runId, sequence: s.sequence, phase: s.phase, configIdentity: state.releaseFacts.configIdentity, wallMs: time.wallMs, monotonicMs: time.monotonicMs, runDeadline: state.runDeadline, policyEpoch: s.policyEpoch, gateEpoch: s.gateEpoch, sessionEpoch: s.sessionEpoch, sessionHandle: s.sessionHandle, expiresAt: Math.min(state.releaseFacts.expiresAt, s.expiresAt) });
  return handle(s[kind]) && state.context.verifyGate(kind, s[kind], binding) === true;
}
function baseGates(state, s, letter, time) {
  if (!gate(state, 'maintenance', s, time)) invalid('READINESS_FAILED');
  if (['P', 'A'].includes(letter)) { if (!gate(state, 'preauth', s, time)) invalid('READINESS_FAILED'); }
  else if (!s.sessionIssued) invalid('SESSION_MISMATCH');
  if (letter === 'C' && !gate(state, 'restart', s, time)) invalid('READINESS_FAILED');
}
function deeper(state, s, time) { return gate(state, 'owner', s, time) && gate(state, 'readiness', s, time); }
function parseRequest(request, state, s) {
  const f = facts(request); checkBody(request, f, state);
  if (f.phase !== s.phase || f.sequence !== s.sequence || !canonicalPath(f.path)) invalid();
  const destination = Object.keys(state.releaseFacts.origins).find(k => state.releaseFacts.origins[k] === f.origin);
  if (!destination || !['GET', 'POST', 'OPTIONS'].includes(f.method)) invalid();
  const seen = new Set();
  for (const [k, v] of f.queryPairs) { if (!/^[A-Za-z0-9_-]+$/.test(k) || !/^[A-Za-z0-9_-]+$/.test(v) || seen.has(k)) invalid(); seen.add(k); }
  const query = f.queryPairs.length ? '?' + f.queryPairs.map(p => p.join('=')).join('&') : '';
  if (f.rawTarget !== f.path + query) invalid();
  const headers = new Map();
  for (const [key, value] of f.headers) {
    const name = key.toLowerCase();
    if (headers.has(name) || !['origin', 'content-type', 'accept', 'access-control-request-method', 'access-control-request-headers'].includes(name)) invalid();
    headers.set(name, value);
  }
  if (headers.has('origin') && headers.get('origin') !== state.releaseFacts.origins.FRONTEND) invalid();
  if (headers.has('accept') && !['application/json', 'application/json, text/plain, */*', '*/*', 'text/html'].includes(headers.get('accept'))) invalid();
  if (f.method === 'OPTIONS') {
    if (headers.get('origin') !== state.releaseFacts.origins.FRONTEND || headers.get('access-control-request-method') !== 'POST' || headers.get('access-control-request-headers') !== 'content-type' || headers.has('content-type')) invalid();
  } else {
    if (headers.has('access-control-request-method') || headers.has('access-control-request-headers')) invalid();
    if (f.method === 'POST' && f.path === '/api/login') { if (headers.get('content-type') !== 'application/json') invalid(); }
    else if (headers.has('content-type')) invalid();
  }
  return { f, destination };
}
function abortTimer(state, letter) {
  const limit = catalogue.timer.abortCeilings[letter], count = state.aborts.get(letter) ?? 0;
  if (!limit || count >= limit) invalid();
  state.aborts.set(letter, count + 1); return Object.freeze({ kind: 'ABORT_EXPECTED', code: 'MARKET_TIMER' });
}
function response(state, s, time, kind, responseHandle) {
  if (!handle(responseHandle) || state.invalidResponses.has(responseHandle) || !gate(state, kind, { ...s, [kind]: responseHandle }, time)) invalid('OBSERVATION_FAILED');
  const r = state.context.responseFacts(responseHandle);
  if (!r || r.kind !== kind || r.runId !== s.runId || !safe(r.receivedAt) || r.receivedAt > time.monotonicMs) invalid('OBSERVATION_FAILED');
  const attempt = kind === 'preauthResponse' ? state.preauthAttempt : state.marketScopes.get(phases[s.phase]);
  if (!attempt || r.requestId !== attempt.requestId || r.sequence !== attempt.sequence) invalid('OBSERVATION_FAILED');
  if (kind === 'preauthResponse') { if (r.status !== 401 || r.sessionHandle !== null || !['P', 'A'].includes(phases[r.phase])) invalid('OBSERVATION_FAILED'); return Object.freeze({ ...r }); }
  if (r.status !== 200 || r.schemaValid !== true || r.source !== 'PAPER' || !['OPEN', 'CLOSED'].includes(r.marketState) || !safe(r.asOf) || r.asOf > time.wallMs || r.phase !== s.phase || ['sessionHandle', 'sessionEpoch', 'policyEpoch', 'gateEpoch'].some(k => r[k] !== s[k])) invalid('OBSERVATION_FAILED');
  return Object.freeze({ ...r });
}
function viewMarket(state, s, time, letter) {
  const record = state.marketScopes.get(letter);
  if (record?.responseHandle && record.responseHandle !== s.marketResponse) invalid('OBSERVATION_FAILED');
  if (s.marketResponse) {
    const r = response(state, s, time, 'marketResponse', s.marketResponse);
    if (!fresh(r, time)) invalid('OBSERVATION_FAILED');
    if (record) record.responseHandle = s.marketResponse;
    return r;
  }
  return null;
}
function fresh(r, time) { return time.monotonicMs - r.receivedAt <= catalogue.timer.freshnessMs && time.wallMs - r.asOf <= catalogue.timer.freshnessMs; }
function holdWindow(s, time) {
  if (s.holdStartedAt === null || time.monotonicMs < s.holdStartedAt || time.monotonicMs - s.holdStartedAt >= catalogue.timer.holdDeadlineMs) invalid('DEADLINE');
}
function marketDecision(state, s, time, letter) {
  if (['H', 'L', 'V'].includes(letter) || (letter === 'A' && s.sessionIssued)) {
    if (letter === 'H') holdWindow(s, time);
    return { exception: 'TIMER_ABORT' };
  }
  if (['P', 'A'].includes(letter)) {
    if (s.sessionIssued || s.documentPath !== '/login') invalid();
    if (!(state.counts.get('market-status:/api/market/status:P') ?? 0) && letter === 'P') return null;
    response(state, s, time, 'preauthResponse', s.preauthResponse);
    if (state.preauthHandle && state.preauthHandle !== s.preauthResponse) invalid('OBSERVATION_FAILED');
    state.preauthHandle = s.preauthResponse;
    return { exception: 'PREAUTH_REPLAY' };
  }
  if (!['B', 'C'].includes(letter)) invalid();
  if (!deeper(state, s, time)) return { exception: 'TIMER_ABORT' };
  const key = 'market-status:/api/market/status:' + letter;
  if (!(state.counts.get(key) ?? 0)) return null;
  const r = response(state, s, time, 'marketResponse', s.marketResponse);
  const record = state.marketScopes.get(letter);
  if (record?.responseHandle && record.responseHandle !== s.marketResponse) invalid('OBSERVATION_FAILED');
  state.marketScopes.set(letter, { ...record, responseHandle: s.marketResponse });
  return { exception: 'MARKET_RESPONSE', response: r };
}
function finalTimeChecks(selected, s, time, letter) {
  const r = selected.viewResponse ?? selected.response;
  if (r && (r.receivedAt > time.monotonicMs || r.asOf > time.wallMs)) invalid('OBSERVATION_FAILED');
  if (selected.exception === 'HOME' || (selected.row?.id === 'frontend-document' && selected.row.path === '/')) {
    if (s.homeArmedAt === null || time.monotonicMs < s.homeArmedAt || time.monotonicMs - s.homeArmedAt >= catalogue.home.windowMs) invalid('DEADLINE');
  }
  if (selected.exception === 'TIMER_ABORT' && letter === 'H') holdWindow(s, time);
  if (selected.viewResponse && !fresh(selected.viewResponse, time)) invalid('OBSERVATION_FAILED');
}
function finishException(state, selected, s, time, letter) {
  // Only the final classification consumes an exception slot; no route slot is used.
  if (selected.exception === 'HOME') {
    if ((state.homeTransition !== null && state.homeTransition !== s.homeTransition) || state.homeClosed || state.homeSeen.has(selected.path)) invalid();
    state.homeTransition = s.homeTransition; state.homeSeen.add(selected.path);
    if (state.homeSeen.size === catalogue.home.paths.length) state.homeClosed = true;
    return Object.freeze({ kind: 'ABORT_EXPECTED', code: 'HOME_TRANSITION' });
  }
  if (selected.exception === 'PREAUTH_REPLAY') {
    if (state.preauthReplays >= catalogue.timer.preauthReplayCeiling) invalid();
    state.preauthReplays++; return opaque({ kind: 'REPLAY_PRIVATE', responseHandle: s.preauthResponse });
  }
  if (selected.exception === 'TIMER_ABORT' || !fresh(selected.response, time)) return abortTimer(state, letter);
  const count = state.replays.get(letter) ?? 0;
  if (count >= catalogue.timer.phaseReplayCeiling) invalid();
  state.replays.set(letter, count + 1); return opaque({ kind: 'REPLAY_PRIVATE', responseHandle: s.marketResponse });
}
function route(state, parsed, s, time, letter) {
  const { f, destination } = parsed;
  baseGates(state, s, letter, time);
  if (destination === 'BACKEND' && f.method === 'GET' && !f.queryPairs.length && catalogue.home.paths.includes(f.path)) {
    if (letter !== 'A' || !s.sessionIssued || !s.homeTransition || s.homeArmedAt === null || time.monotonicMs < s.homeArmedAt || time.monotonicMs - s.homeArmedAt >= catalogue.home.windowMs) invalid();
    if ((state.homeTransition !== null && state.homeTransition !== s.homeTransition) || state.homeClosed || state.homeSeen.has(f.path)) invalid();
    return { exception: 'HOME', path: f.path };
  }
  if (destination === 'BACKEND' && f.method === 'GET' && f.path === catalogue.timer.path && !f.queryPairs.length) {
    const selected = marketDecision(state, s, time, letter); if (selected) return selected;
  }
  let row = catalogue.routes.find(r => r.destination === destination && r.method === f.method && r.path === f.path && r.query.length === f.queryPairs.length && r.query.every(([k, v]) => f.queryPairs.some(pair => pair[0] === k && pair[1] === v)));
  let key, limit, viewResponse = null;
  if (!row && destination === 'FRONTEND' && f.method === 'GET' && !f.queryPairs.length && state.assetMap.has(f.path) && catalogue.assets.phases.includes(letter)) {
    row = { id: 'frontend-asset:' + f.path, paperCost: 0 }; key = row.id; limit = catalogue.assets.runCeiling;
  } else if (row && row.ceilings[letter]) { key = row.id + ':' + f.path + ':' + letter; limit = row.ceilings[letter]; }
  else invalid();
  if (row.id === 'login' && s.sessionIssued) invalid('SESSION_MISMATCH');
  if (row.id === 'frontend-document' && f.path === '/' && (!s.sessionIssued || !s.homeTransition || s.homeArmedAt === null || time.monotonicMs - s.homeArmedAt < 0 || time.monotonicMs - s.homeArmedAt >= catalogue.home.windowMs)) invalid();
  if (['B', 'C'].includes(letter) && !['health', 'me', 'readiness'].includes(row.id)) {
    if (!deeper(state, s, time)) invalid('READINESS_FAILED');
    if (row.id !== 'market-status') viewResponse = viewMarket(state, s, time, letter);
  }
  const cost = Object.freeze({ PAPER: typeof row.paperCost === 'number' ? row.paperCost : row.paperCost[letter], stock: 0 });
  return { row, key, limit, cost, viewResponse };
}
function admitRequest(request, policy) {
  const state = policies.get(policy); if (!state) return fail('IDENTITY_MISMATCH');
  try {
    const { s, time, letter } = current(state, request), parsed = parseRequest(request, state, s);
    if (state.seenRequests.has(request) || state.requestIds.has(parsed.f.requestId) || state.sequenceIds.has(parsed.f.sequence)) invalid('REPLAY');
    state.seenRequests.add(request); state.requestIds.add(parsed.f.requestId); state.sequenceIds.add(parsed.f.sequence);
    const selected = route(state, parsed, s, time, letter);
    const final = consistent(state, request, parsed.f, s);
    finalTimeChecks(selected, s, final.time, letter);
    if (selected.exception) return finishException(state, selected, s, final.time, letter);
    const count = state.counts.get(selected.key) ?? 0;
    if (count >= selected.limit) invalid();
    // No await or external call between testing and consuming the private route ceiling.
    state.counts.set(selected.key, count + 1);
    if (selected.row.id === 'market-status') {
      const attempt = { requestId: parsed.f.requestId, sequence: s.sequence, responseHandle: null };
      if (letter === 'P') state.preauthAttempt = attempt; else state.marketScopes.set(letter, attempt);
    }
    const decision = opaque({ kind: 'ELIGIBLE', routeId: selected.row.id, cost: selected.cost, runId: s.runId, requestId: parsed.f.requestId, sequence: s.sequence, phase: s.phase });
    decisions.set(decision, { state, request, facts: parsed.f, snapshot: s, selected, decision, claimed: false, invalid: false });
    return decision;
  } catch (e) { return fatal(state, errorCode(e)); }
}
function consistent(state, request, captured, snapshot) {
  const final = current(state, request), now = facts(request);
  const { s } = final;
  checkBody(request, now, state);
  if (!sameFacts(captured, now) || snapshotKeys.some(k => s[k] !== snapshot[k])) invalid('IDENTITY_MISMATCH');
  return final;
}
function validate(record, request, policy) {
  const state = policies.get(policy);
  if (!record || record.invalid || state !== record.state || request !== record.request) invalid('IDENTITY_MISMATCH');
  const { s, time, letter } = current(state, request), parsed = parseRequest(request, state, s);
  if (!sameFacts(parsed.f, record.facts) || bindingKeys.some(k => s[k] !== record.snapshot[k])) invalid('IDENTITY_MISMATCH');
  // Recheck gates and freshness, without reserving another ceiling or replay/abort slot.
  let viewResponse = null;
  baseGates(state, s, letter, time);
  if (['B', 'C'].includes(letter) && !['health', 'me', 'readiness'].includes(record.selected.row.id)) {
    if (!deeper(state, s, time)) invalid('READINESS_FAILED');
    if (record.selected.row.id !== 'market-status') viewResponse = viewMarket(state, s, time, letter);
  }
  if (record.selected.row.id === 'login' && s.sessionIssued) invalid('SESSION_MISMATCH');
  if (record.selected.row.id === 'frontend-document' && record.facts.path === '/' && time.monotonicMs - s.homeArmedAt >= catalogue.home.windowMs) invalid('DEADLINE');
  const final = consistent(state, request, parsed.f, s);
  finalTimeChecks({ ...record.selected, viewResponse }, s, final.time, letter);
  return record.decision;
}
function claimEligibility(decision, request, policy) {
  const record = decisions.get(decision);
  if (!record || record.claimed) return fatal(policies.get(policy), 'REPLAY');
  record.claimed = true;
  try { validate(record, request, policy); const claim = opaque({ ...decision, kind: 'CLAIMED' }); claims.set(claim, record); return claim; }
  catch (e) { record.invalid = true; fatal(record.state, errorCode(e)); return fatal(policies.get(policy), errorCode(e)); }
}
function revalidateEligibility(claim, request, policy) {
  const record = claims.get(claim);
  try { return validate(record, request, policy); }
  catch (e) { if (record) { record.invalid = true; fatal(record.state, errorCode(e)); } return fatal(policies.get(policy), errorCode(e)); }
}
module.exports = { createPolicy, admitRequest, claimEligibility, revalidateEligibility };
