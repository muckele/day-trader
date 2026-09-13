const test = require('node:test');
const assert = require('node:assert/strict');
require('../utils/nodeCompat').ensureSlowBufferCompat();
const mongoose = require('mongoose');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ownerId = '507f1f77bcf86cd799439011';
const otherId = '507f1f77bcf86cd799439012';
const auth = require('../middleware/auth');
const { register, login, logout } = require('../routes/auth');
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, cookie(name, value) { this.token = value; }, clearCookie() { this.cleared = true; } };
}
function fixture(t) {
  const env = { ...process.env };
  process.env.JWT_SECRET = 'test-auth-routes-secret';
  process.env.OWNER_USER_ID = ownerId;
  t.mock.method(require('../models/Log'), 'create', async () => ({}));
  const state = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { process.env = env; mongoose.connection.readyState = state; });
}
test('public registration is unavailable even without DB or owner config', async t => {
  fixture(t);
  mongoose.connection.readyState = 0;
  delete process.env.OWNER_USER_ID;
  const res = response();
  await register({ body: { username: 'first', password: 'Password1234' } }, res);
  assert.equal(res.statusCode, 403);
});
test('non-owner password login never issues a session', async t => {
  fixture(t);
  const hash = await bcrypt.hash('Password1234', 4);
  t.mock.method(User, 'findOne', async () => ({ _id: otherId, username: 'other', hash }));
  const res = response();
  await login({ body: { username: 'other', password: 'Password1234' } }, res, err => { throw err; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.token, undefined);
});
test('owner login issues versioned session and logout invalidates replay', async t => {
  fixture(t);
  const user = { _id: ownerId, username: 'owner', hash: await bcrypt.hash('Password1234', 4), sessionVersion: 0 };
  t.mock.method(User, 'findOne', () => Object.assign(Promise.resolve(user), { lean: async () => ({ ...user }) }));
  t.mock.method(User, 'updateOne', async (filter, update) => {
    assert.equal(filter._id, ownerId);
    assert.equal(update.$inc.sessionVersion, 1);
    user.sessionVersion += 1;
    return { matchedCount: 1 };
  });
  const signedIn = response();
  await login({ body: { username: 'owner', password: 'Password1234' } }, signedIn, err => { throw err; });
  assert.equal(signedIn.statusCode, 200);
  assert.equal(jwt.verify(signedIn.token, process.env.JWT_SECRET).sessionVersion, 0);
  const signedOut = response();
  await logout({ user: { userId: ownerId } }, signedOut, err => { throw err; });
  assert.equal(signedOut.statusCode, 200);
  assert.equal(signedOut.cleared, true);
  const replay = response();
  let accepted = false;
  await auth({ headers: { authorization: `Bearer ${signedIn.token}` } }, replay, () => { accepted = true; });
  assert.equal(replay.statusCode, 401);
  assert.equal(accepted, false);
});
test('logout persistence failure cannot claim successful revocation', async t => {
  fixture(t);
  t.mock.method(User, 'updateOne', async () => { throw new Error('database down'); });
  const res = response();
  await logout({ user: { userId: ownerId } }, res, err => { throw err; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.revoked, false);
});
