'use strict';

const { timingSafeEqual } = require('node:crypto');

const attemptedBrowsers = new WeakSet();
const consumedCredentials = new WeakSet();
const privateSessions = new WeakMap();

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}
function object(value) { return value !== null && (typeof value === 'object' || typeof value === 'function'); }
function privateHandle() {
  return Object.freeze(Object.defineProperty({}, 'toJSON', { value: () => fail('PRIVATE_HANDLE') }));
}
function expectedOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'id,username' ||
      typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 256 || /[\0\r\n]/.test(value.id) ||
      typeof value.username !== 'string' || value.username.length < 1 || value.username.length > 512 || /[\0\r\n]/.test(value.username)) fail('OWNER_INVALID');
  return { id: value.id, username: value.username };
}
function sessionResult(browserSession, value, kind) {
  if (typeof browserSession.inspectResult !== 'function') fail('SESSION_INVALID');
  let inspected;
  try { inspected = browserSession.inspectResult(value); } catch (cause) { fail('SESSION_INVALID', cause); }
  if (!inspected || typeof inspected !== 'object' || Array.isArray(inspected) || Object.keys(inspected).sort().join(',') !== 'fingerprint,kind' ||
      inspected.kind !== kind || typeof inspected.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(inspected.fingerprint)) fail('SESSION_INVALID');
  return inspected.fingerprint;
}

async function loginOnce(browserSession, credential, owner) {
  if (!object(browserSession) || typeof browserSession.perform !== 'function' || attemptedBrowsers.has(browserSession)) fail('LOGIN_ALREADY_ATTEMPTED');
  if (!object(credential) || typeof credential.consumeOnce !== 'function' || typeof credential.destroy !== 'function' || consumedCredentials.has(credential)) fail('CREDENTIAL_INVALID');
  const selectedOwner = expectedOwner(owner);
  attemptedBrowsers.add(browserSession);
  consumedCredentials.add(credential);
  let bytes, password, released = false, loginPayload;
  function releaseCredential() {
    if (released) return;
    released = true;
    password = null;
    if (loginPayload) loginPayload.password = '';
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    try { credential.destroy(); } catch (cause) { fail('CREDENTIAL_DESTROY_FAILED', cause); }
  }
  try {
    bytes = await credential.consumeOnce();
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 4096) fail('CREDENTIAL_INVALID');
    password = bytes.toString('utf8');
    if (!Buffer.from(password, 'utf8').equals(bytes) || /[\0\r\n]/.test(password)) fail('CREDENTIAL_INVALID');
    loginPayload = {
      ownerId: selectedOwner.id,
      password,
      username: selectedOwner.username,
    };
    const result = await browserSession.perform('LOGIN_SESSION', loginPayload, releaseCredential);
    const handle = privateHandle();
    privateSessions.set(handle, { browserSession, fingerprint: sessionResult(browserSession, result, 'SESSION_BOUND') });
    return handle;
  } finally {
    releaseCredential();
  }
}

function assertContinuity(before, after) {
  const saved = privateSessions.get(before);
  if (!saved) fail('SESSION_INVALID');
  const fingerprint = sessionResult(saved.browserSession, after, 'SESSION_OBSERVED');
  const left = Buffer.from(saved.fingerprint, 'hex'), right = Buffer.from(fingerprint, 'hex');
  if (!timingSafeEqual(left, right)) fail('SESSION_CHANGED');
  return Object.freeze({ status: 'CONTINUOUS' });
}

function destroySessionReference(handle) {
  if (!object(handle) || !privateSessions.delete(handle)) fail('SESSION_INVALID');
}

module.exports = Object.freeze({ loginOnce, assertContinuity, destroySessionReference });
