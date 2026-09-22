const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const { MongoClient, ObjectId } = require(root + '/backend/node_modules/mongodb');
const bcrypt = require(root + '/backend/node_modules/bcryptjs');

async function startStartupFixture({ unique = false, fault = '' } = {}) {
  const dbName = 'mvp_startup_' + randomUUID().replaceAll('-', '');
  const uri = `mongodb://127.0.0.1:27189/${dbName}?replicaSet=mvp&directConnection=true`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect(); const db = client.db();
  const owner = new ObjectId(); const other = new ObjectId();
  const users = [owner, other, new ObjectId(), new ObjectId()].map((_id, i) => ({ _id,
    username: unique ? 'synthetic-' + i : 'synthetic-duplicate',
    email: unique ? `synthetic-${i}@example.test` : 'duplicate@example.test',
    hash: bcrypt.hashSync(i === 0 ? 'owner-password' : 'other-password', 4), sessionVersion: 0 }));
  await db.collection('users').insertMany(users);
  if (unique) {
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  }
  const settings = { userId: owner, mode: 'paper', enabled: false, isEnabled: false, liveTradingExplicitlyEnabled: false };
  await db.collection('robosettings').insertOne(settings);
  const intent = { _id: new ObjectId(), accountId: 'synthetic-account', userId: String(owner), environment: 'paper',
    executionSource: 'alpaca-paper', idempotencyKey: 'settled-fixture', clientOrderId: 'settled-fixture',
    origin: 'manual', broker: 'alpaca', symbol: 'AAA', side: 'buy', qty: 1, filledQty: 1, reservedCents: 0,
    filledNotionalCents: 100, status: 'filled', requestedAt: new Date() };
  await db.collection('orderintents').insertOne(intent);
  const before = { users: await db.collection('users').find().sort({ _id: 1 }).toArray(), indexes: await db.collection('users').listIndexes().toArray() };
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const baseURL = 'http://127.0.0.1:' + port;
  const env = { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), MONGO_URI: uri,
    MONGO_PREFER_LOCAL: 'false', MONGO_RETRY_MS: '1000', JWT_SECRET: randomUUID() + randomUUID(),
    OWNER_USER_ID: String(owner), FRONTEND_ORIGIN: baseURL, ROBO_SCHEDULER_DISABLED: 'true',
    APCA_BASE_URL: 'https://paper-api.alpaca.markets', ALPACA_EXPECTED_PAPER_ACCOUNT_ID: randomUUID(),
    APCA_API_KEY_ID: 'synthetic-key', APCA_API_SECRET_KEY: 'synthetic-secret', STARTUP_SYNTHETIC: 'true', STARTUP_FAULT: fault, AUTH_RATE_LIMIT_PER_WINDOW: '1000' };
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'startup-observer.cjs'), 'backend/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const request = (route, { method = 'GET', body, cookie } = {}) => fetch(baseURL + route, { method,
    headers: { origin: baseURL, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const login = password => request('/api/login', { method: 'POST', body: { username: users[0].username, password } });
  let cookie;
  const close = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
    await db.dropDatabase(); await client.close();
  };
  try {
    for (let i = 0; i < 150; i++) {
      try {
        const response = await login('owner-password');
        if (response.ok) cookie = response.headers.get('set-cookie').split(';')[0];
        if (cookie) { const r = await request('/api/readiness', { cookie }); const d = await r.json(); if (d.persistence?.ready || (fault && d.persistence)) break; }
      } catch {}
      if (child.exitCode !== null) throw new Error(logs);
      if (i === 149) throw new Error('Synthetic startup failed: ' + logs);
      await new Promise(r => setTimeout(r, 100));
    }
    let sequence = 0;
    const control = (startup, values) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Synthetic control timeout')); }, 10000);
      const listener = message => { if (message.startupReply === id) { clearTimeout(timer); child.off('message', listener); message.error ? reject(new Error(message.error)) : resolve(message.ledger); } };
      child.on('message', listener); child.send({ startup, id, values });
    });
    return { db, owner, other, users, settings, intent, before, env, child, cookie, request, login, control, close, get logs() { return logs; } };
  } catch (error) { await close(); throw error; }
}
module.exports = { startStartupFixture };
