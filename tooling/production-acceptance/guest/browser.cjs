'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const runtime = require('../package.json').acceptanceRuntime;
const { inspectBrowserControllerConfig } = require('./receipts.cjs');
const { admitBrowserRequest } = require('./budget.cjs');
const { claimBrowserRequestEvidence } = require('./role-ports.cjs');

const RUNTIME_PINS = deepFreeze(JSON.parse(JSON.stringify(runtime)));
const ALLOWED_ACTIONS = new Set(['LOGIN_SESSION', 'SESSION_OBSERVATION']);
const FIXED_PATHS = Object.freeze({
  profile: '/run/acceptance/browser/profile', support: '/run/acceptance/browser/support',
  cache: '/run/acceptance/browser/cache', shm: '/dev/shm',
});
const sessions = new WeakMap(), browserResults = new WeakMap();

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
  fail('ACTION_DENIED');
}
async function openBrowser(config, ports) {
  try { config = inspectBrowserControllerConfig(config); } catch (cause) { fail('CONFIG_INVALID', cause); }
  validateConfig(config);
  if (!ports || !ports.rolePort || !ports.grant || typeof ports.rolePort.activateOnce !== 'function' || !ports.admissionPort) fail('BOOTSTRAP_REQUIRED');
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
  let nextId = 0, terminal = false, closeSignal, closeOperation;
  async function decideRoute(received) {
    const frame=received.frame;let evidence;
    try { evidence = claimBrowserRequestEvidence(role.privatePipe, received.bytes, frame.payload); }
    catch { await wire.write('DECISION', { requestId: frame.payload?.requestId ?? '', decision: 'ABORT' }); return; }
    let decision;
    try { decision = await bounded(admitBrowserRequest(ports.admissionPort, evidence), 10000, 'DEADLINE'); }
    catch { decision = { requestId: frame.payload.requestId, decision: 'ABORT' }; }
    const allowed = decision && decision.requestId === frame.payload.requestId && ['CONTINUE', 'ABORT'].includes(decision.decision) ? decision.decision : 'ABORT';
    await wire.write('DECISION', { requestId: frame.payload.requestId, decision: allowed });
  }
  try {
    let assets=false,ready=false;
    while(!ready){const received=await wire.read(),frame=received.frame;
      if(frame.type==='ROUTE'){await decideRoute(received);continue;}
      if(frame.type==='ERROR')fail(frameError(frame.payload));
      if(frame.type==='ASSETS'&&!assets){validateAssetProofs(frame.payload,config.assetEntries);assets=true;continue;}
      if(frame.type==='READY'&&assets){exact(frame.payload,['status']);if(frame.payload.status!=='READY')fail('FRAME_DENIED');ready=true;continue;}
      fail('FRAME_DENIED');
    }
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
          exact(frame.payload, ['actionId', 'status', 'fingerprint']);
          if (!safe(frame.payload.actionId) || !['SESSION_BOUND','SESSION_OBSERVED'].includes(frame.payload.status) || !/^[0-9a-f]{64}$/.test(frame.payload.fingerprint)) fail('FRAME_DENIED');
          const slot = pending.get(frame.payload.actionId); if (!slot) fail('FRAME_DENIED');
          if (slot.action === 'LOGIN_SESSION' && (!slot.filled || frame.payload.status !== 'SESSION_BOUND') ||
              slot.action === 'SESSION_OBSERVATION' && frame.payload.status !== 'SESSION_OBSERVED') fail('FRAME_DENIED');
          const result=privateHandle({});browserResults.set(result,{sessionToken,kind:frame.payload.status,fingerprint:frame.payload.fingerprint});
          pending.delete(frame.payload.actionId); slot.resolve(result);
        } else if (frame.type === 'ERROR') {
          const keys = exactObject(frame.payload) ? Object.keys(frame.payload).sort().join(',') : '';
          if (!['code', 'actionId,code'].includes(keys) || typeof frame.payload.code !== 'string' || frame.payload.code.length < 1 || frame.payload.code.length > 128 ||
              keys === 'actionId,code' && !safe(frame.payload.actionId)) fail('FRAME_DENIED');
          const slot = pending.get(frame.payload.actionId); if (slot) { pending.delete(frame.payload.actionId); slot.reject(Object.assign(new Error(frame.payload.code), { code: frame.payload.code })); }
          else fail(frame.payload.code || 'BROWSER_FAILED');
        } else if (frame.type === 'EXIT') { exact(frame.payload, ['status', 'runId']); if (frame.payload.runId !== facts.runId || !['STOPPED', 'EXITED'].includes(frame.payload.status)) fail('FRAME_DENIED'); terminal = true; if (closeSignal) closeSignal.resolve(frame.payload); }
        else fail('FRAME_DENIED');
      }
    } catch (cause) {
      terminal = true;
      for (const slot of pending.values()) slot.reject(cause);
      pending.clear(); if (closeSignal) closeSignal.reject(cause);
      try { await stopRole(); } catch {}
    }
  }
  pump();
  const session = privateHandle({
    async perform(action, payload, onFilled) {
      if (terminal || closeOperation || pending.size !== 0 || !ALLOWED_ACTIONS.has(action)) fail('ACTION_DENIED');
      actionPayload(action, payload);
      if (action === 'LOGIN_SESSION' ? arguments.length !== 3 || typeof onFilled !== 'function' : arguments.length !== 2) fail('ACTION_DENIED');
      const actionId = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(actionId, { action, filled:false, onFilled, payload, resolve, reject }));
      try { await wire.write('ACTION', { actionId, action, payload }); } catch (cause) { pending.delete(actionId); throw cause; }
      return result;
    },
    inspectResult(result) {
      const saved=browserResults.get(result);
      if(!saved||saved.sessionToken!==sessionToken)fail('SESSION_INVALID');
      return Object.freeze({kind:saved.kind,fingerprint:saved.fingerprint});
    },
    async close() {
      if (closeOperation) return closeOperation;
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); closeSignal = { promise, resolve, reject };
      closeOperation=(async()=>{try { await wire.write('CLOSE', {}); } catch (cause) { reject(cause); }
        try { return Object.freeze(await bounded(promise, role.cleanupRemaining(), 'CLEANUP_UNCERTAIN')); }
        finally { await stopRole(); }})();
      return closeOperation;
    },
  });
  sessions.set(session, { role, wire }); return session;
}

module.exports = Object.freeze({ RUNTIME_PINS, openBrowser });
