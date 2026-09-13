const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mongoose = require('mongoose');
const Outbox = require('../models/NotificationOutbox');
const { enqueueOrderNotification } = require('../services/roboNotificationService');
const { startSmtpCapture } = require('../../scripts/acceptance/smtp-capture.cjs');
const root = path.resolve(__dirname, '../..');
test('Phase 3 real Mongo outbox and local STARTTLS SMTP acceptance', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'day-trader-smtp-'));
  const db = `mvp_test_smtp_${randomUUID().replaceAll('-', '')}`;
  const uri = `mongodb://127.0.0.1:27189/${db}?replicaSet=mvp&directConnection=true`;
  let smtp;
  const children = new Set();
  try {
    const certPath = path.join(directory, 'cert.pem'), keyPath = path.join(directory, 'key.pem');
    const configPath = path.join(directory, 'openssl.cnf');
    await fs.writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-config', configPath], { stdio: 'ignore' });
    smtp = await startSmtpCapture({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) });
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }); await Outbox.init();
    const env = { PATH: process.env.PATH, NODE_ENV: 'test', SMTP_TEST_MONGO_URI: uri, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'fixture@example.test', NODE_EXTRA_CA_CERTS: certPath };
    function worker(argument = String(Date.now())) {
      const child = spawn(process.execPath, ['scripts/acceptance/smtp-worker.cjs', argument], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child); let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { children.delete(child); if (code === 0) resolve(JSON.parse(output)); else reject(new Error(`SMTP worker exit ${code}: ${errors}`)); }); });
      return { child, done };
    }
    const base = { accountId: 'smtp-account', environment: 'paper', symbol: 'AAPL', side: 'buy', qty: 2, filledQty: 0, clientOrderId: 'smtp-logical-order', submittedAt: new Date(), status: 'new' };
    await t.test('acknowledgement partial final rejection uncertainty and protection events preserve queued/accepted distinction and deduplicate', async () => {
      const events = [base, { ...base, status: 'partially_filled', filledQty: 1 }, { ...base, status: 'filled', filledQty: 2, filledAvgPrice: 100 }, { ...base, clientOrderId: 'rejected-order', status: 'rejected' }, { ...base, clientOrderId: 'uncertain-order', status: 'pending_submit', reconciliationStatus: 'submit_error_pending_reconciliation' }, { ...base, clientOrderId: 'protection-order', status: 'filled', reconciliationStatus: 'protection_failed' }];
      for (const event of events) { await enqueueOrderNotification(event); await enqueueOrderNotification(event); }
      assert.equal(await Outbox.countDocuments(), 6); assert.equal(await Outbox.countDocuments({ state: 'pending' }), 6); assert.equal(smtp.messages.length, 0);
      for (let i = 0; i < 6; i++) assert.equal((await worker().done).state, 'provider_accepted');
      assert.equal(smtp.messages.length, 6); assert.equal(await Outbox.countDocuments({ state: 'provider_accepted', providerAcceptedAt: { $exists: true } }), 6);
      for (const event of events) await enqueueOrderNotification(event);
      assert.equal((await worker().done).state, 'idle'); assert.equal(smtp.messages.length, 6);
      // Nodemailer quoted-printable text wraps/escapes; decode enough for semantic evidence.
      const messages = smtp.messages.join('\n').replace(/=\r\n/g, '').replace(/=([A-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      for (const state of ['acknowledged', 'partially_filled', 'filled', 'rejected', 'submit_error_pending_reconciliation', 'protection_failed']) assert.ok(messages.includes(state), state);
      assert.ok(messages.includes('Acknowledgement is not a fill'));
    });
    await t.test('temporary SMTP DATA failure persists retry and new process accepts later without duplicate', async () => {
      await enqueueOrderNotification({ ...base, clientOrderId: 'retry-order' }); smtp.failNext();
      assert.equal((await worker().done).state, 'retryable');
      const failed = await Outbox.findOne({ state: 'retryable' }).lean(); assert.equal(failed.lastError, 'EMAIL_DELIVERY_FAILED'); assert.equal(failed.attempts, 1); assert.equal(smtp.messages.length, 6);
      assert.equal((await worker().done).state, 'idle');
      assert.equal((await worker(String(failed.nextAttemptAt.getTime() + 1)).done).state, 'provider_accepted');
      assert.equal(smtp.messages.length, 7); assert.equal((await worker().done).state, 'idle');
    });
    await t.test('killed process leaves sending lease then fresh worker recovers expired claim', async () => {
      await enqueueOrderNotification({ ...base, clientOrderId: 'restart-order' });
      const crashed = worker('claim-and-wait'); const expectedDeath = crashed.done.catch(error => error);
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('claim timeout')), 10000); crashed.child.stdout.on('data', chunk => { if (String(chunk).includes('CLAIMED')) { clearTimeout(timer); resolve(); } }); });
      assert.equal(await Outbox.countDocuments({ state: 'sending' }), 1); crashed.child.kill('SIGKILL'); await expectedDeath;
      assert.equal((await worker().done).state, 'idle');
      await Outbox.updateOne({ state: 'sending' }, { $set: { leaseUntil: new Date(0) } });
      assert.equal((await worker().done).state, 'provider_accepted'); assert.equal(smtp.messages.length, 8);
      const recovered = await Outbox.findOne({ eventKey: /restart-order/ }).lean(); assert.equal(recovered.attempts, 2); assert.equal(recovered.leaseOwner, undefined);
      assert.equal((await worker().done).state, 'idle'); assert.equal(smtp.messages.length, 8);
    });
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect(); if (smtp) await smtp.close(); await fs.rm(directory, { recursive: true, force: true });
  }
});
