const test = require('node:test');
const assert = require('node:assert/strict');
require('../utils/nodeCompat').ensureSlowBufferCompat();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const auth = require('../middleware/auth');
const ownerId = '507f1f77bcf86cd799439011';
const otherId = '507f1f77bcf86cd799439012';

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function fixture(t, { connected = true, userId = ownerId, sessionVersion = 0 } = {}) {
  const env = { ...process.env };
  process.env.JWT_SECRET = 'owner-access-test-secret-only';
  process.env.OWNER_USER_ID = ownerId;
  const state = mongoose.connection.readyState;
  mongoose.connection.readyState = connected ? 1 : 0;
  t.mock.method(User, 'findOne', query => ({ lean: async () => query._id === userId ? { _id: userId, username: 'owner', sessionVersion } : null }));
  t.after(() => { process.env = env; mongoose.connection.readyState = state; });
}
async function invoke(claims = {}) {
  const req = { headers: { authorization: `Bearer ${jwt.sign({ sub: ownerId, sessionVersion: 0, ...claims }, process.env.JWT_SECRET, { expiresIn: '1h' })}` } };
  const res = response();
  let nextCalled = false;
  await auth(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('owner is rejected when authentication database is disconnected', async t => {
  fixture(t, { connected: false });
  const result = await invoke();
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalled, false);
});
test('pre-existing non-owner signed token cannot access protected routes', async t => {
  fixture(t, { userId: otherId });
  const result = await invoke({ sub: otherId });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.nextCalled, false);
});
test('missing operator owner binding fails closed', async t => {
  fixture(t);
  delete process.env.OWNER_USER_ID;
  const result = await invoke();
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalled, false);
});
test('revoked session version cannot access owner data', async t => {
  fixture(t, { sessionVersion: 1 });
  const result = await invoke();
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.nextCalled, false);
});
test('legacy session lacking revocation version must sign in again', async t => {
  fixture(t);
  const result = await invoke({ sessionVersion: undefined });
  assert.equal(result.res.statusCode, 401);
});
test('current owner session with connected database is accepted', async t => {
  fixture(t);
  const result = await invoke();
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.currentUser._id, ownerId);
});
test('database query failure fails closed without exposing driver errors', async t => {
  fixture(t);
  t.mock.method(User, 'findOne', () => ({ lean: async () => { throw new Error('mongodb://private-host/secret'); } }));
  const result = await invoke();
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.nextCalled, false);
  assert.doesNotMatch(JSON.stringify(result.res.body), /private-host/);
});
test('unconfigured JWT secret fails closed in development too', async t => {
  fixture(t);
  const token = jwt.sign({ sub: ownerId, sessionVersion: 0 }, 'daytrader-dev-secret');
  delete process.env.JWT_SECRET;
  const res = response();
  await auth({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('must not authenticate'));
  assert.equal(res.statusCode, 503);
});
