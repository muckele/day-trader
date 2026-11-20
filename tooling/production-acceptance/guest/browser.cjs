'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const runtime = require('../package.json').acceptanceRuntime;
const { inspectBrowserControllerConfig } = require('./receipts.cjs');
const { admitBrowserRequest } = require('./budget.cjs');
const { claimBrowserRequestEvidence } = require('./role-ports.cjs');

const RUNTIME_PINS = deepFreeze(JSON.parse(JSON.stringify(runtime)));
const ALLOWED_ACTIONS = new Set(['LOGIN_SESSION', 'SESSION_OBSERVATION', 'OBSERVE_VIEW']);
const FIXED_PATHS = Object.freeze({
  profile: '/run/acceptance/browser/profile', support: '/run/acceptance/browser/support',
  cache: '/run/acceptance/browser/cache', shm: '/dev/shm',
});
const sessions = new WeakMap(), browserResults = new WeakMap();
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
}));
function closedCode(code) { return typeof code === 'string' && Object.hasOwn(WORKER_CODE_MAP, code) ? WORKER_CODE_MAP[code] : 'INTERNAL_FAILURE'; }
function workerError(workerCode) {
  const code = closedCode(workerCode);
  return Object.assign(new Error(code), { code, workerCode });
}

function fail(code, cause) { const error = new Error(code, cause ? { cause } : undefined); error.code = code; throw error; }
function deepFreeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
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
function auditPipe(pipe) {
  if (!pipe || typeof pipe.audit !== 'function' || typeof pipe.read !== 'function' || typeof pipe.write !== 'function') fail('ROLE_INVALID');
  const facts = pipe.audit();
  if (facts?.version===1&&facts.kind==='TASK13_BROWSER_APPLICATION'&&/^[0-9a-f]{32}$/.test(facts.runId)&&facts.maxFrameBytes===16384) return facts;
  if (!facts || facts.version !== 1 || !/^[0-9a-f]{32}$/.test(facts.runId) || !/^[0-9a-f]{64}$/.test(facts.channelKeyHex) ||
      facts.uid !== 10002 || facts.noNewPrivs !== true || facts.capabilities !== 'EMPTY' || facts.filterInherited !== true ||
      facts.procScope !== 'BROWSER_FAMILY_ONLY' || facts.consoleFds !== 0 || facts.vsockFds !== 0 ||
      facts.unexpectedFds !== 0 || facts.networkDeviceCount !== 0 || facts.maxFrameBytes !== 16384 ||
      !Array.isArray(facts.tmpfsPaths) || !equal([...facts.tmpfsPaths].sort(), Object.values(FIXED_PATHS).sort())) fail('ROLE_INVALID');
  return facts;
}
function rpc(pipe, facts) {
  let outgoing = 0, incoming = 0, sending=Promise.resolve();
  const outer = facts.kind === 'TASK13_BROWSER_APPLICATION';
  const key = outer ? null : Buffer.from(facts.channelKeyHex, 'hex');
  function mac(frame, direction) { return createHmac('sha256', key).update('acceptance:browser:v1\0' + direction + '\0' + canonical(frame)).digest('hex'); }
  return Object.freeze({
    write(type, payload) {
      const operation=sending.then(async()=>{
        const bare = { version: 1, runId: facts.runId, sequence: ++outgoing, type, payload };
        const body = Buffer.from(canonical(outer ? bare : { ...bare, mac: mac(bare, 'CONTROLLER_TO_WORKER') }), 'ascii');
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
      exact(frame, outer ? ['version', 'runId', 'sequence', 'type', 'payload'] : ['version', 'runId', 'sequence', 'type', 'payload', 'mac']);
      if (frame.version !== 1 || frame.runId !== facts.runId || frame.sequence !== incoming + 1 || !safe(frame.sequence) || typeof frame.type !== 'string') fail('FRAME_DENIED');
      if (!outer) { if(typeof frame.mac !== 'string')fail('FRAME_DENIED');const bare = { ...frame }; delete bare.mac;
        const expected = mac(bare, 'WORKER_TO_CONTROLLER');
        if (!/^[0-9a-f]{64}$/.test(frame.mac) || !timingSafeEqual(Buffer.from(frame.mac, 'hex'), Buffer.from(expected, 'hex'))) fail('FRAME_DENIED'); }
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
  try { config = inspectBrowserControllerConfig(config); } catch (cause) { fail('CONFIG_INVALID', cause); }
  validateConfig(config);
  if (!ports || !ports.rolePort || !ports.grant || typeof ports.rolePort.activateOnce !== 'function' || !ports.admissionPort ||
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
    if(typeof role.cleanupRemaining!=='function')fail('ROLE_INVALID');
    facts = auditPipe(role.privatePipe);
    if (facts.runId !== config.runBinding.runId) fail('ROLE_INVALID');
    wire = rpc(role.privatePipe, facts);
  } catch (cause) {
    try { await stopRole(); } catch {}
    throw cause;
  }
  const pending = new Map(), sessionToken = Object.freeze({});
  let nextId = 0, terminal = false, closeSignal, closeOperation, failure = null;
  // The first terminal failure latches the session: its closed-enum code is kept,
  // pending actions and an in-flight close reject with it, and the role is stopped.
  function latch(code, cause) {
    if (failure === null) failure = closedCode(code);
    terminal = true;
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
          const sessionResult = ['SESSION_BOUND', 'SESSION_OBSERVED'].includes(frame.payload?.status);
          exact(frame.payload, sessionResult ? ['actionId', 'status', 'fingerprint'] :
            ['actionId', 'status', 'view', 'phase', 'schemaValidation', 'renderedData', 'validEmptyState', 'noError', 'fresh', 'source', 'brokerError', 'routeCount', 'renderedCount', 'fingerprint', 'readinessValidation']);
          if (!safe(frame.payload.actionId) || sessionResult && !/^[0-9a-f]{64}$/.test(frame.payload.fingerprint)) fail('FRAME_DENIED');
          const slot = pending.get(frame.payload.actionId); if (!slot) fail('FRAME_DENIED');
          if (slot.action === 'LOGIN_SESSION' && (!slot.filled || frame.payload.status !== 'SESSION_BOUND') ||
              slot.action === 'SESSION_OBSERVATION' && frame.payload.status !== 'SESSION_OBSERVED' ||
              slot.action === 'OBSERVE_VIEW' && (frame.payload.status !== 'VIEW_OBSERVED' || frame.payload.view !== slot.payload.view || frame.payload.phase !== slot.payload.phase)) fail('FRAME_DENIED');
          if (!sessionResult && (typeof frame.payload.schemaValidation !== 'boolean' || typeof frame.payload.renderedData !== 'boolean' ||
              typeof frame.payload.validEmptyState !== 'boolean' || typeof frame.payload.noError !== 'boolean' || typeof frame.payload.fresh !== 'boolean' ||
              typeof frame.payload.source !== 'string' || typeof frame.payload.brokerError !== 'boolean' ||
              !/^[0-9a-f]{64}$/.test(frame.payload.fingerprint) || typeof frame.payload.readinessValidation !== 'boolean' ||
              !Number.isSafeInteger(frame.payload.routeCount) || frame.payload.routeCount < 0 ||
              !Number.isSafeInteger(frame.payload.renderedCount) || frame.payload.renderedCount < 0)) fail('FRAME_DENIED');
          const saved=sessionResult?{sessionToken,kind:frame.payload.status,fingerprint:frame.payload.fingerprint}:
            {sessionToken,kind:frame.payload.status,view:frame.payload.view,phase:frame.payload.phase,
              schemaValidation:frame.payload.schemaValidation,renderedData:frame.payload.renderedData,
              validEmptyState:frame.payload.validEmptyState,noError:frame.payload.noError,fresh:frame.payload.fresh,
              source:frame.payload.source,brokerError:frame.payload.brokerError,routeCount:frame.payload.routeCount,
              renderedCount:frame.payload.renderedCount,fingerprint:frame.payload.fingerprint,
              readinessValidation:frame.payload.readinessValidation,runId:facts.runId,configIdentity:config.runBinding.configIdentity};
          const result=privateHandle({});browserResults.set(result,saved);
          pending.delete(frame.payload.actionId); slot.resolve(result);
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
      // T13 m-6: every action is bounded by the run binding's expiry; expiry is terminal.
      const expiry = runExpiry(clock, expiresAt);
      if (expiry.expired) throw latch('EXPIRED');
      expiry.promise.catch(cause => { latch('EXPIRED', cause); });
      const actionId = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(actionId, { action, filled:false, onFilled, payload, resolve, reject }));
      result.then(() => expiry.clear(), () => expiry.clear());
      try { await wire.write('ACTION', { actionId, action, payload }); } catch (cause) { pending.delete(actionId); expiry.clear(); throw cause; }
      return result;
    },
    inspectResult(result) {
      const saved=browserResults.get(result);
      if(!saved||saved.sessionToken!==sessionToken)fail('SESSION_INVALID');
      const {sessionToken: ignored, ...value}=saved;
      return Object.freeze(value);
    },
    async close() {
      if (closeOperation) return closeOperation;
      // A latched session is stopped, not closed over the wire; close then rejects
      // with the latched code (or CLEANUP_UNCERTAIN if the stop itself fails).
      if (failure !== null) { closeOperation = (async () => { await stopRole(); fail(failure); })(); return closeOperation; }
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); closeSignal = { promise, resolve, reject };
      closeOperation=(async()=>{try { await wire.write('CLOSE', {}); } catch (cause) { reject(cause); }
        try { return Object.freeze(await bounded(promise, role.cleanupRemaining(), 'CLEANUP_UNCERTAIN')); }
        finally { await stopRole(); }})();
      return closeOperation;
    },
  });
  sessions.set(session, { role, wire }); return session;
}

module.exports = Object.freeze({ RUNTIME_PINS, WORKER_CODE_MAP, openBrowser });
