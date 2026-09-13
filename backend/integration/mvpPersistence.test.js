const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Outbox = require('../models/NotificationOutbox');
const RoboLock = require('../models/RoboLock');
const auth = require('../middleware/auth');
const handlers = require('../routes/auth');
const { enqueueOrderNotification, deliverNext } = require('../services/roboNotificationService');

// Only this harness-created random database is removed. No inherited database
// configuration is accepted, even when production credentials are present.
const db = `mvp_test_${randomUUID().replaceAll('-', '')}`;
const uri = `mongodb://127.0.0.1:27189/${db}?directConnection=true&replicaSet=mvp`;
let server;
test.before(async () => {
  process.env.JWT_SECRET = randomUUID();
  process.env.NODE_ENV = 'test';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.createIndexes(), Outbox.createIndexes(), RoboLock.createIndexes()]);
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('real database and HTTP login reject non-owner, protect data and revoke logout token', async () => {
  const owner = await User.create({ username: 'owner-fixture', email: 'owner@example.test', hash: await bcrypt.hash('TestPassword123', 4) });
  const other = await User.create({ username: 'other-fixture', email: 'other@example.test', hash: await bcrypt.hash('TestPassword123', 4) });
  process.env.OWNER_USER_ID = String(owner._id);
  const app = express(); app.use(express.json());
  app.post('/api/login', handlers.login); app.post('/api/register', handlers.register);
  app.use('/api', auth); app.get('/api/private', (req, res) => res.json({ owner: req.user.userId }));
  app.post('/api/logout', handlers.logout);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/register', {})).status, 403);
  assert.equal((await post('/api/login', { username: other.username, password: 'TestPassword123' })).status, 401);
  const nonOwnerToken = jwt.sign({ userId: String(other._id), sub: String(other._id), sessionVersion: 0 }, process.env.JWT_SECRET);
  assert.equal((await fetch(url + '/api/private', { headers: { Authorization: `Bearer ${nonOwnerToken}` } })).status, 403);
  const login = await post('/api/login', { username: owner.username, password: 'TestPassword123' });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(url + '/api/private', { headers })).status, 200);
  assert.equal((await fetch(url + '/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(url + '/api/private', { headers })).status, 401);
});

test('real unique outbox index deduplicates concurrent reconciliation and competing senders', async () => {
  const order = { _id: 'order', accountId: 'bound-paper', environment: 'paper', clientOrderId: randomUUID(), symbol: 'SPY', side: 'buy', qty: 1, status: 'filled', filledQty: 1, filledAvgPrice: 100 };
  await Promise.all(Array.from({ length: 20 }, () => enqueueOrderNotification(order)));
  assert.equal(await Outbox.countDocuments({}), 1);
  let sends = 0;
  const deps = { Outbox, send: async () => { sends += 1; return { provider: 'smtp', messageId: 'fixture', accepted: ['test@example.test'] }; } };
  await Promise.all([deliverNext({ recipient: 'test@example.test' }, deps), deliverNext({ recipient: 'test@example.test' }, deps)]);
  assert.equal(sends, 1);
  assert.equal(await Outbox.countDocuments({ state: 'provider_accepted' }), 1);
});

test('expired sending lease recovers after reconnect with bounded retry', async () => {
  await Outbox.create({ eventKey: randomUUID(), accountId: 'bound-paper', environment: 'paper', subject: 'test', text: 'test', state: 'sending', attempts: 1, leaseOwner: 'dead-process', leaseUntil: new Date(0) });
  await mongoose.disconnect();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const result = await deliverNext({ recipient: 'test@example.test' }, { Outbox, send: async () => { throw new Error('fixture SMTP outage'); } });
  assert.equal(result.state, 'retryable');
  const event = await Outbox.findOne({ state: 'retryable' }).lean();
  assert.equal(event.attempts, 2);
  assert.equal(event.lastError, 'EMAIL_DELIVERY_FAILED');
});

test('real unique lock index elects one worker and rejects lost or expired lease renewal', async () => {
  const { acquireWorkerLock, refreshWorkerLock, releaseWorkerLock } = require('../robotrader/worker');
  const userId = new mongoose.Types.ObjectId();
  const now = new Date();
  const owners = ['worker-a', 'worker-b'];
  const results = await Promise.all(owners.map(owner => acquireWorkerLock(userId, owner, now, { RoboLock })));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = owners[results.findIndex(Boolean)];
  const loser = owners[results.findIndex(value => !value)];
  await assert.rejects(refreshWorkerLock(userId, loser, now, { RoboLock }), /lease/i);
  await releaseWorkerLock(userId, winner, { RoboLock });
  await assert.rejects(refreshWorkerLock(userId, winner, now, { RoboLock }), /lease/i);
  assert.equal(await acquireWorkerLock(userId, loser, new Date(), { RoboLock }), true);
});
