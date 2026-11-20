'use strict';

const runtime = require('../package.json').acceptanceRuntime;
const { inspectBrowserControllerConfig, claimWorkerGateAuthority } = require('./receipts.cjs');
const { admitBrowserRequest } = require('./budget.cjs');
const { claimBrowserRequestEvidence, inspectAdoptedRolePort } = require('./role-ports.cjs');

const RUNTIME_PINS = deepFreeze(JSON.parse(JSON.stringify(runtime)));
const ALLOWED_ACTIONS = new Set(['LOGIN_SESSION', 'SESSION_OBSERVATION', 'SESSION_READINESS', 'OBSERVE_VIEW']);
// Task 17 (P20): browser.cjs mints the readiness and owner WorkerGateHandles through receipts.cjs's
// brand registry. It claims the minting authority once, here at load; no other module can mint.
const gateAuthority = claimWorkerGateAuthority();
const OBSERVE_PHASES = Object.freeze(['OBSERVE_BEFORE_RESTART', 'OBSERVE_AFTER_RESTART']);
const HEX64 = /^[0-9a-f]{64}$/;
const SESSION_RESULT_KEYS = Object.freeze(['actionId', 'status', 'fingerprint']);
const READINESS_RESULT_KEYS = Object.freeze(['actionId', 'status', 'runId', 'phase', 'sequence', 'sessionFingerprint', 'readinessDigest',
  'ownerDigest', 'checkedAtMonotonicMs']);
// T13 I-9: no `fresh` or `readinessValidation`; `sequence` is the view's readiness sequence.
const VIEW_RESULT_KEYS = Object.freeze(['actionId', 'status', 'view', 'phase', 'sequence', 'schemaValidation', 'renderedData', 'validEmptyState',
  'noError', 'source', 'brokerError', 'routeCount', 'renderedCount', 'fingerprint']);
const FIXED_PATHS = Object.freeze({
  profile: '/run/acceptance/browser/profile', support: '/run/acceptance/browser/support',
  cache: '/run/acceptance/browser/cache', shm: '/dev/shm',
});
// T13 I-8: `sessions` is the BrowserSession brand. Only openBrowser writes it.
const sessions = new WeakMap(), browserResults = new WeakMap();
function isBrowserSession(value) { return sessions.has(value); }
// T13 m-8: worker codes are free strings (up to 128 characters). browser.cjs
// raises only closed failure-enum codes: each closed code maps to itself, the
// known worker codes below map to their class, and anything else (including
// prototype names) is INTERNAL_FAILURE. The worker's own string stays on the
// error as `workerCode`, never as its code.
const FAILURE_CODES = Object.freeze([...require('../contracts/schema.json').definitions.Failure.values]);
const WORKER_CODE_MAP = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(FAILURE_CODES.map(code => [code, code])), {
  ACTION_DENIED: 'INVALID_FRAME', FRAME_DENIED: 'INVALID_FRAME', CHANNEL_DENIED: 'INVALID_FRAME', CHANNEL_EOF: 'TRANSPORT_LOST',
  AUTHORITY_LOST: 'ROLE_INVALID', BOOTSTRAP_REQUIRED: 'ROLE_INVALID', ACTIVATION_DENIED: 'ROLE_INVALID', HANDOFF_DENIED: 'ROLE_INVALID',
  NATIVE_EFFECT_FENCE_UNAVAILABLE: 'ROLE_INVALID', CONFIG_INVALID: 'IDENTITY_MISMATCH', RUNTIME_IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  OWNER_MISMATCH: 'IDENTITY_MISMATCH', COOKIE_INVALID: 'SESSION_MISMATCH', SESSION_CHANGED: 'SESSION_MISMATCH',
  SESSION_INVALID: 'SESSION_MISMATCH', LOGIN_ALREADY_ATTEMPTED: 'REPLAY', CLEANUP_UNCERTAIN: 'CLEANUP_INCOMPLETE',
  FAMILY_UNREADABLE: 'ROLE_INVALID',
}));
function closedCode(code) { return typeof code === 'string' && Object.hasOwn(WORKER_CODE_MAP, code) ? WORKER_CODE_MAP[code] : 'INTERNAL_FAILURE'; }
function workerError(workerCode) {
  const code = closedCode(workerCode);
  return Object.assign(new Error(code), { code, workerCode });
}

function fail(code, cause) { const error = new Error(code, cause ? { cause } : undefined); error.code = code; throw error; }
function deepFreeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
// Task 18 F1 (RB-I1): the application channel is printable ASCII. A key or leaf is JSON text with every UTF-16 unit
// above 0x7E written as a lowercase \uXXXX escape (a surrogate pair as two escapes), so a UTF-8 credential (C8) is
// carried exactly: JSON.parse restores the original string and the readers' canonical(frame) === text check holds on
// both ends (browser-worker.cjs uses the same encoder). A raw byte above 127 is still refused by both readers.
function jsonText(value) {
  const text = JSON.stringify(value);
  return typeof text === 'string' ? text.replace(/[\u007f-\uffff]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')) : text;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => jsonText(key) + ':' + canonical(value[key])).join(',') + '}';
  return jsonText(value);
}
function privateHandle(value) { return Object.freeze(Object.defineProperty(value, 'toJSON', { value: () => fail('PRIVATE_HANDLE') })); }
function equal(left, right) { return canonical(left) === canonical(right); }
function exactObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!exactObject(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('FRAME_DENIED');
}
function safe(value, minimum = 1) { return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum; }
async function bounded(promise, milliseconds, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), milliseconds); timer.unref?.(); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
// T13 m-6: a wait bounded by the run binding's expiry. The injected clock alone
// decides expiry (wall ms against expiresAt); the timer only schedules the next
// clock check, so a stalled step still ends once the clock passes expiry. A
// failing, malformed or regressing sample counts as expired (fail closed).
function runExpiry(clock, expiresAt) {
  let timer = null, cleared = false, expired = false, last = null, reject;
  const promise = new Promise((_, no) => { reject = no; }); promise.catch(() => {});
  function left() {
    let sample; try { sample = clock.sample(); } catch { return 0; }
    if (!Array.isArray(sample) || sample.length !== 2 || !sample.every(value => safe(value, 0)) || last && (sample[0] < last[0] || sample[1] < last[1])) return 0;
    last = sample; return Math.max(0, expiresAt - sample[0]);
  }
  function expire() { expired = true; if (timer !== null) clearTimeout(timer); timer = null; reject(Object.assign(new Error('EXPIRED'), { code: 'EXPIRED' })); }
  function check() {
    timer = null; if (cleared || expired) return;
    const milliseconds = left();
    if (milliseconds < 1) { expire(); return; }
    timer = setTimeout(check, Math.min(milliseconds, 2147483647)); timer.unref?.();
  }
  check();
  return Object.freeze({
    promise, get expired() { return expired; },
    race: operation => Promise.race([operation, promise]),
    clear() { cleared = true; if (timer !== null) clearTimeout(timer); timer = null; },
  });
}
function frameError(payload) {
  if (!exactObject(payload) || Object.keys(payload).sort().join(',') !== 'code' || typeof payload.code !== 'string' || payload.code.length < 1 || payload.code.length > 128) fail('FRAME_DENIED');
  return payload.code;
}
// T13 I-8 / P28: the pipe must carry role-ports' adoption brand, and its audit must be the
// Task 13 application form. The earlier second form, self-reported confinement facts with a
// per-pipe MAC key, and its MAC'd frame path are removed: the brand replaces them.
function auditPipe(pipe) {
  if (!inspectAdoptedRolePort(pipe) || typeof pipe.audit !== 'function' || typeof pipe.read !== 'function' || typeof pipe.write !== 'function') fail('ROLE_INVALID');
  const facts = pipe.audit();
  if (!facts || facts.version !== 1 || facts.kind !== 'TASK13_BROWSER_APPLICATION' || !/^[0-9a-f]{32}$/.test(facts.runId) || facts.maxFrameBytes !== 16384) fail('ROLE_INVALID');
  return facts;
}
function rpc(pipe, facts) {
  let outgoing = 0, incoming = 0, sending=Promise.resolve();
  return Object.freeze({
    write(type, payload) {
      const operation=sending.then(async()=>{
        const body = Buffer.from(canonical({ version: 1, runId: facts.runId, sequence: ++outgoing, type, payload }), 'ascii');
        if (body.length > facts.maxFrameBytes) fail('FRAME_DENIED');
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); await pipe.write(Buffer.concat([prefix, body]));
      });
      sending=operation.catch(()=>{});return operation;
    },
    async read() {
      const bytes = await pipe.read();
      if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > facts.maxFrameBytes + 4 || bytes.readUInt32BE() !== bytes.length - 4) fail('FRAME_DENIED');
      const body = bytes.subarray(4); if (body.some(value => value > 127)) fail('FRAME_DENIED');
      const text = body.toString('ascii'); let frame; try { frame = JSON.parse(text); } catch { fail('FRAME_DENIED'); }
      if (canonical(frame) !== text) fail('FRAME_DENIED');
      exact(frame, ['version', 'runId', 'sequence', 'type', 'payload']);
      if (frame.version !== 1 || frame.runId !== facts.runId || frame.sequence !== incoming + 1 || !safe(frame.sequence) || typeof frame.type !== 'string') fail('FRAME_DENIED');
      incoming++;
      return { frame, bytes };
    },
  });
}
function validateConfig(config) {
  if (exactObject(config) && Object.keys(config).sort().join(',') !== 'assetBundle,assetEntries,paths,runBinding,runtime') fail('CONFIG_INVALID');
  if (!exactObject(config) || !exactObject(config.runBinding) || !equal(config.runtime, RUNTIME_PINS) ||
      !/^[0-9a-f]{32}$/.test(config.runBinding.runId)) fail('RUNTIME_IDENTITY_MISMATCH');
  if (Object.keys(config.runBinding).sort().join(',') !== 'configIdentity,expiresAt,manifestIdentity,origins,runId' ||
      Object.keys(config.runBinding.origins).sort().join(',') !== 'BACKEND,FRONTEND') fail('CONFIG_INVALID');
  if (!equal(config.paths, FIXED_PATHS) || !/^[0-9a-f]{64}$/.test(config.runBinding.manifestIdentity) ||
      !/^[0-9a-f]{64}$/.test(config.runBinding.configIdentity) || !Number.isSafeInteger(config.runBinding.expiresAt) ||
      !exactObject(config.runBinding.origins) || !Array.isArray(config.assetEntries) || config.assetEntries.length < 1 || config.assetEntries.length > 256) fail('CONFIG_INVALID');
  for (const name of ['FRONTEND', 'BACKEND']) {
    const value = config.runBinding.origins[name]; let parsed;
    try { parsed = new URL(value); } catch { fail('CONFIG_INVALID'); }
    if (typeof value !== 'string' || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) fail('CONFIG_INVALID');
  }
  if (config.runBinding.origins.FRONTEND === config.runBinding.origins.BACKEND) fail('CONFIG_INVALID');
  const paths = new Set();
  for (const entry of config.assetEntries) {
    if (!exactObject(entry) || Object.keys(entry).sort().join(',') !== 'hash,mime,path,size' ||
        typeof entry.path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.includes('//') || entry.path.split('/').some(segment => segment === '.' || segment === '..') ||
        entry.path.endsWith('.map') || entry.path === '/static/js/acceptance-missing.js' ||
        !/^[0-9a-f]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 16777216 ||
        typeof entry.mime !== 'string' || entry.mime.length < 1 || entry.mime.length > 128 || /[\x00-\x20\x7f]/.test(entry.mime) || paths.has(entry.path)) fail('CONFIG_INVALID');
    paths.add(entry.path);
  }
}
function validateAssetProofs(payload, entries) {
  exact(payload, ['proofs']);
  if (!Array.isArray(payload.proofs) || payload.proofs.length !== entries.length) fail('OBSERVATION_FAILED');
  const expected = new Map(entries.map(entry => ['frontend-asset:' + entry.path, entry]));
  const seen = new Set();
  for (const proof of payload.proofs) {
    exact(proof, ['entryId', 'hash', 'sizeMatch', 'hashMatch', 'mimeMatch']);
    const entry = expected.get(proof.entryId);
    if (!entry || seen.has(proof.entryId) || proof.hash !== entry.hash || proof.sizeMatch !== true || proof.hashMatch !== true || proof.mimeMatch !== true) fail('OBSERVATION_FAILED');
    seen.add(proof.entryId);
  }
}
function actionPayload(action, payload) {
  if (!exactObject(payload)) fail('ACTION_DENIED');
  if (action === 'LOGIN_SESSION') {
    if (Object.keys(payload).sort().join(',') !== 'ownerId,password,username' ||
        typeof payload.ownerId !== 'string' || payload.ownerId.length < 1 || payload.ownerId.length > 256 || /[\0\r\n]/.test(payload.ownerId) ||
        typeof payload.username !== 'string' || payload.username.length < 1 || payload.username.length > 512 || /[\0\r\n]/.test(payload.username) ||
        typeof payload.password !== 'string' || payload.password.length < 1 || payload.password.length > 4096 || /[\0\r\n]/.test(payload.password)) fail('ACTION_DENIED');
    return;
  }
  if (action === 'SESSION_OBSERVATION' && Reflect.ownKeys(payload).length === 0) return;
  // C9: the fixed SESSION_READINESS action names only its phase and the caller's sequence.
  if (action === 'SESSION_READINESS') {
    if (Object.keys(payload).sort().join(',') !== 'phase,sequence' || Reflect.ownKeys(payload).length !== 2 ||
        !OBSERVE_PHASES.includes(payload.phase) || !safe(payload.sequence)) fail('ACTION_DENIED');
    return;
  }
  if (action === 'OBSERVE_VIEW') {
    if (Object.keys(payload).sort().join(',') !== 'phase,view' ||
        !['OBSERVE_BEFORE_RESTART', 'OBSERVE_AFTER_RESTART'].includes(payload.phase) ||
        !['ROBO', 'PORTFOLIO', 'ACTIVITY'].includes(payload.view) ||
        payload.phase === 'OBSERVE_AFTER_RESTART' && payload.view !== 'ROBO') fail('ACTION_DENIED');
    return;
  }
  fail('ACTION_DENIED');
}
async function openBrowser(config, ports) {
  const configHandle = config;
  try { config = inspectBrowserControllerConfig(config); } catch (cause) { fail('CONFIG_INVALID', cause); }
  validateConfig(config);
  // T13 I-8: only a BROWSER role port that role-ports adopted can open a session; a look-alike
  // (or another role's port) is refused before any activation.
  if (!ports || !inspectAdoptedRolePort(ports.rolePort) || ports.rolePort.kind !== 'BROWSER' || !ports.grant || typeof ports.rolePort.activateOnce !== 'function' || !ports.admissionPort ||
      !ports.clock || typeof ports.clock.sample !== 'function') fail('BOOTSTRAP_REQUIRED');
  const clock = ports.clock, expiresAt = config.runBinding.expiresAt;
  let role;
  try { role = await ports.rolePort.activateOnce(ports.grant); } catch (cause) { fail(cause && cause.code || 'BOOTSTRAP_REQUIRED', cause); }
  let facts, wire, stopped;
  async function stopRole() {
    if (!stopped) stopped = Promise.resolve().then(async()=>{
      const result=typeof role?.stopOwned === 'function'?await role.stopOwned(typeof role.cleanupRemaining==='function'?role.cleanupRemaining():0):{status:'STOPPED'};
      if(!result||!['STOPPED','EXITED'].includes(result.status))fail('CLEANUP_UNCERTAIN');return result;
    });
    return stopped;
  }
  try {
    // Task 16c (P76): the role handle must carry the bootstrap's family inspection.
    if(typeof role.cleanupRemaining!=='function'||typeof role.inspectFamily!=='function')fail('ROLE_INVALID');
    facts = auditPipe(role.privatePipe);
    if (facts.runId !== config.runBinding.runId) fail('ROLE_INVALID');
    wire = rpc(role.privatePipe, facts);
  } catch (cause) {
    try { await stopRole(); } catch {}
    throw cause;
  }
  const pending = new Map(), sessionToken = Object.freeze({});
  let nextId = 0, terminal = false, closeSignal, closeOperation, failure = null;
  // Task 17 (T13 I-4/I-5, m-4): the login's session fingerprint, the current gate pair (one phase,
  // one sequence), and the readiness phases and sequence already used.
  let sessionRef = null, boundFingerprint = null, gates = null, lastReadinessSequence = 0;
  const readinessPhases = new Set();
  function currentPhase() { return gates === null ? null : gates.phase; }
  function currentSequence() { return gates === null ? null : gates.sequence; }
  function retireGates() {
    if (gates === null) return;
    const old = gates; gates = null;
    try { gateAuthority.retire(old.readiness); gateAuthority.retire(old.owner); } catch {}
  }
  function monotonicNow() {
    let sample; try { sample = clock.sample(); } catch { fail('EXPIRED'); }
    if (!Array.isArray(sample) || sample.length !== 2 || !safe(sample[1], 0)) fail('EXPIRED');
    return sample[1];
  }
  function sameHex(left, right) { return typeof left === 'string' && typeof right === 'string' && HEX64.test(left) && HEX64.test(right) && left === right; }
  // C9 SESSION_READINESS: the worker's result echoes this action's run, phase and sequence, was
  // checked inside this action's monotonic window, and names the login's own session. Only then
  // are the readiness and owner gates minted for this session, phase and sequence; the previous
  // pair is retired (once per phase).
  function readinessRecord(p, slot) {
    if (p.runId !== facts.runId || p.phase !== slot.payload.phase || p.sequence !== slot.payload.sequence ||
        ![p.sessionFingerprint, p.readinessDigest, p.ownerDigest].every(value => typeof value === 'string' && HEX64.test(value)) ||
        !safe(p.checkedAtMonotonicMs, 0) || p.checkedAtMonotonicMs < slot.startedMonotonicMs || p.checkedAtMonotonicMs > monotonicNow()) fail('FRAME_DENIED');
    if (boundFingerprint === null || !sameHex(p.sessionFingerprint, boundFingerprint)) fail('SESSION_MISMATCH');
    const gateFacts = { session: sessionRef, runId: facts.runId, configIdentity: config.runBinding.configIdentity, phase: p.phase,
      sequence: p.sequence, checkedAtMonotonicMs: p.checkedAtMonotonicMs };
    const readiness = gateAuthority.mint('readiness', { ...gateFacts, digest: p.readinessDigest });
    const owner = gateAuthority.mint('owner', { ...gateFacts, digest: p.ownerDigest });
    retireGates();
    gates = Object.freeze({ phase: p.phase, sequence: p.sequence, readiness, owner });
    return { sessionToken, kind: 'READINESS_OBSERVED', phase: p.phase, sequence: p.sequence, fingerprint: p.sessionFingerprint,
      readinessDigest: p.readinessDigest, ownerDigest: p.ownerDigest, checkedAtMonotonicMs: p.checkedAtMonotonicMs,
      runId: facts.runId, configIdentity: config.runBinding.configIdentity, readiness, owner };
  }
  // T13 m-4: what a reader of a result sees. inspectResult keeps the shapes session.cjs checks;
  // claimResult also carries the phase and sequence.
  function resultValue(saved, claimed) {
    if (saved.kind === 'SESSION_BOUND' || saved.kind === 'SESSION_OBSERVED')
      return Object.freeze(claimed ? { kind: saved.kind, fingerprint: saved.fingerprint, phase: saved.phase, sequence: saved.sequence } :
        { kind: saved.kind, fingerprint: saved.fingerprint });
    const { sessionToken: ignored, inspected, claimed: spent, ...value } = saved;
    return Object.freeze(value);
  }
  // The first terminal failure latches the session: its closed-enum code is kept,
  // pending actions and an in-flight close reject with it, and the role is stopped.
  function latch(code, cause) {
    if (failure === null) failure = closedCode(code);
    terminal = true;
    retireGates();
    const error = Object.assign(new Error(failure, cause ? { cause } : undefined), { code: failure });
    for (const slot of pending.values()) slot.reject(error);
    pending.clear(); if (closeSignal) closeSignal.reject(error);
    stopRole().catch(() => {});
    return error;
  }
  // T13 I-7: only the expected timer and replay aborts are ordinary ABORT
  // decisions. Any other admission outcome is answered ABORT and then latches
  // the session as terminal ROUTE_DENIED; nothing is swallowed.
  async function decideRoute(received) {
    const frame = received.frame, requestId = typeof frame.payload?.requestId === 'string' ? frame.payload.requestId : '';
    let decision, denied = null;
    try {
      const evidence = claimBrowserRequestEvidence(role.privatePipe, received.bytes, frame.payload);
      decision = await bounded(admitBrowserRequest(ports.admissionPort, evidence), 10000, 'DEADLINE');
      if (!decision || decision.requestId !== requestId || !(decision.decision === 'CONTINUE' ||
          decision.decision === 'ABORT' && ['ABORT_EXPECTED', 'REPLAY_PRIVATE'].includes(decision.reason))) fail('ROUTE_DENIED');
    } catch (cause) { denied = cause; }
    let written = null;
    try { await wire.write('DECISION', { requestId, decision: denied ? 'ABORT' : decision.decision }); } catch (cause) { written = cause; }
    if (denied) fail('ROUTE_DENIED', denied);
    if (written) throw written;
  }
  try {
    let assets=false,ready=false;
    const startup=runExpiry(clock,expiresAt);
    try {
      while(!ready){const received=await startup.race(wire.read()),frame=received.frame;
        if(frame.type==='ROUTE'){await startup.race(decideRoute(received));continue;}
        if(frame.type==='ERROR')throw workerError(frameError(frame.payload));
        if(frame.type==='ASSETS'&&!assets){validateAssetProofs(frame.payload,config.assetEntries);assets=true;continue;}
        if(frame.type==='READY'&&assets){exact(frame.payload,['status']);if(frame.payload.status!=='READY')fail('FRAME_DENIED');ready=true;continue;}
        fail('FRAME_DENIED');
      }
      // Task 16c (owner decision 2026-11-20, P76): the uid-10002 worker never inspects other processes; the
      // bootstrap does. POST_LOAD: after READY, inside the startup expiry, before the session exists, so before any
      // credential. Worker-authored family facts are never evidence (a worker FAMILY frame is FRAME_DENIED above).
      try { await startup.race(role.inspectFamily('POST_LOAD')); } catch (cause) { fail('ROLE_INVALID', cause); }
    } finally { startup.clear(); }
  } catch (cause) {
    try { await stopRole(); } catch {}
    throw cause;
  }
  async function pump() {
    try {
      while (!terminal) {
        const received = await wire.read(), frame = received.frame;
        if (frame.type === 'ROUTE') {
          await decideRoute(received);
        } else if (frame.type === 'FILLED') {
          exact(frame.payload, ['actionId', 'status']);
          if (!safe(frame.payload.actionId) || frame.payload.status !== 'FILLED') fail('FRAME_DENIED');
          const slot = pending.get(frame.payload.actionId);
          if (!slot || slot.action !== 'LOGIN_SESSION' || slot.filled) fail('FRAME_DENIED');
          slot.filled = true; slot.payload.password = ''; slot.payload = null; slot.onFilled();
        } else if (frame.type === 'RESULT') {
          const status = frame.payload?.status;
          const sessionResult = ['SESSION_BOUND', 'SESSION_OBSERVED'].includes(status), readinessResult = status === 'READINESS_OBSERVED';
          exact(frame.payload, sessionResult ? SESSION_RESULT_KEYS : readinessResult ? READINESS_RESULT_KEYS : VIEW_RESULT_KEYS);
          const p = frame.payload;
          if (!safe(p.actionId) || sessionResult && (typeof p.fingerprint !== 'string' || !HEX64.test(p.fingerprint))) fail('FRAME_DENIED');
          const slot = pending.get(p.actionId); if (!slot) fail('FRAME_DENIED');
          if (slot.action === 'LOGIN_SESSION' && (!slot.filled || status !== 'SESSION_BOUND') ||
              slot.action === 'SESSION_OBSERVATION' && status !== 'SESSION_OBSERVED' ||
              slot.action === 'SESSION_READINESS' && !readinessResult ||
              slot.action === 'OBSERVE_VIEW' && (status !== 'VIEW_OBSERVED' || p.view !== slot.payload.view || p.phase !== slot.payload.phase || p.sequence !== slot.sequence)) fail('FRAME_DENIED');
          // T13 I-9: noError is the worker's measured DOM check; source and brokerError are its
          // PAPER-health facts (null when the phase has none). None is assumed here.
          if (!sessionResult && !readinessResult && (typeof p.schemaValidation !== 'boolean' || typeof p.renderedData !== 'boolean' ||
              typeof p.validEmptyState !== 'boolean' || typeof p.noError !== 'boolean' ||
              p.source !== null && (typeof p.source !== 'string' || !/^[a-z][a-z-]{0,62}$/.test(p.source)) ||
              p.brokerError !== null && typeof p.brokerError !== 'boolean' ||
              typeof p.fingerprint !== 'string' || !HEX64.test(p.fingerprint) ||
              !Number.isSafeInteger(p.routeCount) || p.routeCount < 0 ||
              !Number.isSafeInteger(p.renderedCount) || p.renderedCount < 0)) fail('FRAME_DENIED');
          // T13 m-4: every result carries the phase and sequence it was observed under.
          let saved;
          if (sessionResult) {
            if (status === 'SESSION_BOUND') boundFingerprint = p.fingerprint;
            saved = { sessionToken, kind: status, fingerprint: p.fingerprint, phase: slot.phase, sequence: slot.sequence };
          } else if (readinessResult) saved = readinessRecord(p, slot);
          else saved = { sessionToken, kind: status, view: p.view, phase: slot.phase, sequence: slot.sequence,
            schemaValidation: p.schemaValidation, renderedData: p.renderedData, validEmptyState: p.validEmptyState, noError: p.noError,
            source: p.source, brokerError: p.brokerError, routeCount: p.routeCount, renderedCount: p.renderedCount,
            fingerprint: p.fingerprint, runId: facts.runId, configIdentity: config.runBinding.configIdentity };
          saved.inspected = false; saved.claimed = false;
          const result=privateHandle({});browserResults.set(result,saved);
          pending.delete(p.actionId); slot.resolve(result);
        } else if (frame.type === 'ERROR') {
          const keys = exactObject(frame.payload) ? Object.keys(frame.payload).sort().join(',') : '';
          if (!['code', 'actionId,code'].includes(keys) || typeof frame.payload.code !== 'string' || frame.payload.code.length < 1 || frame.payload.code.length > 128 ||
              keys === 'actionId,code' && !safe(frame.payload.actionId)) fail('FRAME_DENIED');
          const slot = pending.get(frame.payload.actionId); if (slot) { pending.delete(frame.payload.actionId); slot.reject(workerError(frame.payload.code)); }
          else throw workerError(frame.payload.code);
        } else if (frame.type === 'EXIT') { exact(frame.payload, ['status', 'runId']); if (frame.payload.runId !== facts.runId || !['STOPPED', 'EXITED'].includes(frame.payload.status)) fail('FRAME_DENIED'); terminal = true; if (closeSignal) closeSignal.resolve(frame.payload); }
        else fail('FRAME_DENIED');
      }
    } catch (cause) {
      latch(cause?.code, cause);
      try { await stopRole(); } catch {}
    }
  }
  pump();
  const session = privateHandle({
    assertBinding(binding) {
      if (!exactObject(binding) || Object.keys(binding).sort().join(',') !== 'configIdentity,runId' ||
          binding.runId !== facts.runId || binding.configIdentity !== config.runBinding.configIdentity) fail('IDENTITY_MISMATCH');
      return true;
    },
    // Any latched failure (route denial, asset failure, expiry, worker error) fails later actions with its code.
    failureCode() { return failure; },
    async perform(action, payload, onFilled) {
      if (failure !== null) fail(failure);
      if (terminal || closeOperation || pending.size !== 0 || !ALLOWED_ACTIONS.has(action)) fail('ACTION_DENIED');
      actionPayload(action, payload);
      if (action === 'LOGIN_SESSION' ? arguments.length !== 3 || typeof onFilled !== 'function' : arguments.length !== 2) fail('ACTION_DENIED');
      // T13 I-4/I-5 (C9): SESSION_READINESS needs the bound login session; one per phase, phases
      // only advance and sequences only increase. A view runs only once the readiness and owner
      // gates of its own phase are set (the controller sets them, then authorises the navigation).
      let phase = action === 'LOGIN_SESSION' ? null : currentPhase(), sequence = action === 'LOGIN_SESSION' ? null : currentSequence();
      if (action === 'SESSION_READINESS') {
        if (boundFingerprint === null) fail('ACTION_DENIED');
        if (readinessPhases.has(payload.phase) || payload.phase === 'OBSERVE_BEFORE_RESTART' && readinessPhases.has('OBSERVE_AFTER_RESTART') ||
            payload.sequence <= lastReadinessSequence) fail('REPLAY');
        phase = payload.phase; sequence = payload.sequence;
      }
      if (action === 'OBSERVE_VIEW') {
        if (gates === null || gates.phase !== payload.phase) fail('READINESS_FAILED');
        phase = gates.phase; sequence = gates.sequence;
      }
      // T13 m-6: every action is bounded by the run binding's expiry; expiry is terminal.
      const expiry = runExpiry(clock, expiresAt);
      if (expiry.expired) throw latch('EXPIRED');
      expiry.promise.catch(cause => { latch('EXPIRED', cause); });
      let startedMonotonicMs = null;
      if (action === 'SESSION_READINESS') {
        try { startedMonotonicMs = monotonicNow(); } catch (cause) { expiry.clear(); throw latch('EXPIRED', cause); }
        readinessPhases.add(payload.phase); lastReadinessSequence = payload.sequence;
      }
      const actionId = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(actionId, { action, filled:false, onFilled, payload, phase, sequence, startedMonotonicMs, resolve, reject }));
      result.then(() => expiry.clear(), () => expiry.clear());
      try { await wire.write('ACTION', { actionId, action, payload }); } catch (cause) { pending.delete(actionId); expiry.clear(); throw cause; }
      return result;
    },
    // T13 m-4: a result is read at most once by each reader, and only while the session's
    // readiness phase and sequence are the ones it was observed under. A readiness result is
    // only claimable.
    inspectResult(result) {
      const saved=browserResults.get(result);
      if(!saved||saved.sessionToken!==sessionToken||saved.inspected||saved.kind==='READINESS_OBSERVED'||
         saved.phase!==currentPhase()||saved.sequence!==currentSequence())fail('SESSION_INVALID');
      saved.inspected=true;
      return resultValue(saved,false);
    },
    claimResult(result, phase, sequence) {
      const saved=browserResults.get(result);
      if(!saved||saved.sessionToken!==sessionToken||saved.claimed||saved.phase===null||saved.phase!==phase||saved.sequence!==sequence||
         phase!==currentPhase()||sequence!==currentSequence())fail('SESSION_INVALID');
      saved.claimed=true;
      return resultValue(saved,true);
    },
    // The current readiness and owner gates (one phase, one sequence), for the route policy snapshot.
    currentGates() { return gates; },
    async close() {
      if (closeOperation) return closeOperation;
      retireGates();
      // A latched session is stopped, not closed over the wire; close then rejects
      // with the latched code (or CLEANUP_UNCERTAIN if the stop itself fails).
      if (failure !== null) { closeOperation = (async () => { await stopRole(); fail(failure); })(); return closeOperation; }
      closeOperation=(async()=>{
        // Task 16c (P76): FINAL before CLOSE, bounded by the run expiry (never cleanupRemaining, C1). A failure
        // latches ROLE_INVALID, stops the role and writes no CLOSE.
        const expiry = runExpiry(clock, expiresAt);
        try { await expiry.race(Promise.resolve().then(() => role.inspectFamily('FINAL'))); }
        catch (cause) { const error = latch('ROLE_INVALID', cause); try { await stopRole(); } catch {} throw error; }
        finally { expiry.clear(); }
        if (failure !== null) { await stopRole(); fail(failure); }
        let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); closeSignal = { promise, resolve, reject };
        try { await wire.write('CLOSE', {}); } catch (cause) { reject(cause); }
        try { return Object.freeze(await bounded(promise, role.cleanupRemaining(), 'CLEANUP_UNCERTAIN')); }
        finally { await stopRole(); }})();
      return closeOperation;
    },
  });
  // T13 m-9: the session is bound to its config's private release trust (receipts.cjs) before
  // anyone can hold it; maintenance receipts are later read only under that trust.
  try { gateAuthority.bindSession(session, configHandle); }
  catch (cause) { terminal = true; try { await stopRole(); } catch {} fail('CONFIG_INVALID', cause); }
  sessionRef = session;
  sessions.set(session, { role, wire }); return session;
}

module.exports = Object.freeze({ RUNTIME_PINS, WORKER_CODE_MAP, openBrowser, isBrowserSession });
