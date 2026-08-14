const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mongoose = require('mongoose');
const PaperAccountLock = require('../models/PaperAccountLock');
const PaperOrder = require('../models/PaperOrder');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const OrderIntent = require('../models/OrderIntent');
const {
  ALPACA_PAPER_SUBMISSION_LOCK_MS,
  acquireAlpacaPaperSubmissionLock,
  findUnresolvedAlpacaPaperSubmission,
  releaseAlpacaPaperSubmissionLock,
  renewAlpacaPaperSubmissionLock
} = require('../services/alpacaPaperSubmissionGuardService');
const { SUBMISSION_STATES } = require('../services/submissionOutcomeService');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function retry(label, operation, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      await delay(100);
    }
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function startReplicaSet() {
  const binary = process.env.MONGOD_BINARY || '/usr/local/bin/mongod';
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-mvp-mongo-'));
  const port = await reservePort();
  const child = spawn(binary, [
    '--dbpath', dbPath,
    '--bind_ip', '127.0.0.1',
    '--port', String(port),
    '--replSet', 'paperMvpRs',
    '--nounixsocket',
    '--quiet'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const directUri = `mongodb://127.0.0.1:${port}/admin?directConnection=true`;
  const direct = await retry('mongod', () => mongoose.createConnection(directUri, {
    serverSelectionTimeoutMS: 250,
    autoIndex: false
  }).asPromise());
  try {
    await direct.db.admin().command({
      replSetInitiate: {
        _id: 'paperMvpRs',
        members: [{ _id: 0, host: `127.0.0.1:${port}` }]
      }
    });
  } catch (err) {
    if (err?.codeName !== 'AlreadyInitialized') throw err;
  }
  await retry('replica-set primary', async () => {
    const status = await direct.db.admin().command({ hello: 1 });
    if (!status.isWritablePrimary) throw new Error('node is not primary');
    return status;
  });
  await direct.close();
  return {
    child,
    dbPath,
    stderr: () => stderr,
    uri: `mongodb://127.0.0.1:${port}/paper_mvp_durability?replicaSet=paperMvpRs`
  };
}

async function stopReplicaSet(runtime) {
  if (!runtime) return;
  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => runtime.child.once('exit', resolve)),
      delay(5000).then(() => {
        if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
      })
    ]);
  }
  await fs.rm(runtime.dbPath, { recursive: true, force: true });
}

async function run() {
  let runtime = null;
  try {
    runtime = await startReplicaSet();
    await mongoose.connect(runtime.uri, {
      serverSelectionTimeoutMS: 2000,
      autoIndex: false
    });

    // Compatible legacy records deliberately omit all newly introduced
    // idempotency/submission/provenance fields before production indexes exist.
    await mongoose.connection.db.collection('paperorders').insertOne({
      accountId: 'legacy:paper', broker: 'paper', symbol: 'AAPL', side: 'buy', qty: 1,
      status: 'filled', createdAt: new Date(), updatedAt: new Date()
    });
    await mongoose.connection.db.collection('robotradeorders').insertOne({
      accountId: 'legacy:robo', broker: 'alpaca', environment: 'paper', symbol: 'AAPL', side: 'buy',
      status: 'filled', createdAt: new Date(), updatedAt: new Date()
    });
    for (const model of [PaperAccountLock, PaperOrder, RoboTradeOrder, OrderIntent]) {
      await model.syncIndexes();
    }

    let brokerPosts = 0;
    const raceAccount = 'operator:cross-path-race';
    const contenders = ['manual-path', 'robotrader-path'];
    const results = await Promise.all(contenders.map(async owner => {
      const lock = await acquireAlpacaPaperSubmissionLock(raceAccount, owner, new Date());
      if (!lock) return { owner, posted: false };
      brokerPosts += 1;
      await delay(25);
      await releaseAlpacaPaperSubmissionLock(raceAccount, owner);
      return { owner, posted: true };
    }));
    assert.equal(results.filter(result => result.posted).length, 1);
    assert.equal(brokerPosts, 1);

    const originalClientOrderId = 'dt-robotrader-AAPL-restart-proof';
    const unknown = await RoboTradeOrder.create({
      accountId: 'operator:restart',
      broker: 'alpaca',
      environment: 'paper',
      symbol: 'AAPL',
      side: 'buy',
      qty: 1,
      status: 'pending_submit',
      submissionState: SUBMISSION_STATES.UNKNOWN,
      clientOrderId: originalClientOrderId
    });
    await mongoose.disconnect();
    await mongoose.connect(runtime.uri, { serverSelectionTimeoutMS: 2000, autoIndex: false });
    const afterRestart = await findUnresolvedAlpacaPaperSubmission({ accountId: 'operator:restart' });
    assert.equal(String(afterRestart.order._id), String(unknown._id));
    assert.equal(afterRestart.order.clientOrderId, originalClientOrderId);
    assert.equal(afterRestart.order.submissionState, SUBMISSION_STATES.UNKNOWN);

    const orphanIntent = await OrderIntent.create({
      accountId: 'operator:intent-restart',
      broker: 'alpaca',
      environment: 'paper',
      symbol: 'AAPL',
      side: 'buy',
      status: 'submitting',
      submissionIdempotencyKey: 'submit-before-process-loss',
      orderFingerprint: 'frozen-intent-fingerprint'
    });
    await mongoose.disconnect();
    await mongoose.connect(runtime.uri, { serverSelectionTimeoutMS: 2000, autoIndex: false });
    const orphanAfterRestart = await findUnresolvedAlpacaPaperSubmission({
      accountId: 'operator:intent-restart'
    });
    assert.equal(orphanAfterRestart.source, 'intent');
    assert.equal(String(orphanAfterRestart.order._id), String(orphanIntent._id));
    assert.equal(orphanAfterRestart.order.status, 'submitting');

    const leaseAccount = 'operator:lease-proof';
    const leaseStart = new Date('2026-08-14T16:00:00.000Z');
    const firstLease = await acquireAlpacaPaperSubmissionLock(leaseAccount, 'owner-a', leaseStart);
    assert.ok(firstLease);
    assert.equal(await renewAlpacaPaperSubmissionLock(
      leaseAccount,
      'owner-a',
      new Date(leaseStart.getTime() + 1000)
    ), true);
    const expiredAt = new Date(
      leaseStart.getTime() + 1000 + ALPACA_PAPER_SUBMISSION_LOCK_MS + 1
    );
    assert.equal(await renewAlpacaPaperSubmissionLock(leaseAccount, 'owner-a', expiredAt), false);
    const secondLease = await acquireAlpacaPaperSubmissionLock(leaseAccount, 'owner-b', expiredAt);
    assert.equal(secondLease.owner, 'owner-b');

    const orderIntentIndexes = await OrderIntent.collection.indexes();
    assert.equal(
      orderIntentIndexes.some(index => index.unique && index.key.submissionIdempotencyKey === 1),
      true
    );
    await mongoose.connection.db.dropDatabase();
    console.log(JSON.stringify({
      ok: true,
      realMongoPrimary: true,
      crossPathBrokerPosts: brokerPosts,
      restartClientOrderId: originalClientOrderId,
      orphanIntentRestartFreeze: true,
      leaseRenewedThenExpired: true,
      legacyIndexCreation: 'compatible'
    }, null, 2));
  } catch (err) {
    if (runtime?.stderr()) console.error(runtime.stderr());
    throw err;
  } finally {
    await mongoose.disconnect().catch(() => {});
    await stopReplicaSet(runtime);
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
