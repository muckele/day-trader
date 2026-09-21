const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const Outbox = require('../models/NotificationOutbox');
const LegacyOrder = require('../models/RoboTradeOrder');
const service = require('../services/roboNotificationService');

const recipient = 'test-owner@example.invalid';
const content = n => ({ eventKey: `smtp-acceptance:${n}`, accountId: 'synthetic-paper-account', environment: 'paper', subject: `SMTP acceptance ${n}`, text: 'PAPER MVP test. No live trade. No action required.' });
test('targeted SMTP notification acceptance with disposable Mongo', { timeout: 60000 }, async t => {
  const db = `mvp_test_targeted_smtp_${randomUUID().replaceAll('-', '')}`;
  const keys = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'ROBO_NOTIFICATION_RECIPIENT', 'OWNER_USER_ID'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let calls = [], outcome;
  const send = async mail => { calls.push(mail); if (outcome) return outcome(mail); return { provider: 'smtp', messageId: 'synthetic-provider-id', accepted: [recipient] }; };
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: send }));
  const deps = { Outbox, send };
  const reset = async () => { await Outbox.deleteMany({}); calls = []; outcome = null; process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_FROM = 'test-sender@example.invalid'; process.env.ROBO_NOTIFICATION_RECIPIENT = recipient; delete process.env.SMTP_USER; delete process.env.SMTP_PASS; process.env.OWNER_USER_ID = '507f1f77bcf86cd799439011'; };
  const seed = async n => Outbox.create(content(n));
  const check = async (name, fn) => t.test(name, async () => { await reset(); await fn(); });
  try {
    await mongoose.connect(`mongodb://127.0.0.1:27189/${db}?replicaSet=mvp&directConnection=true`, { serverSelectionTimeoutMS: 5000 });
    await Outbox.init(); await LegacyOrder.init();
    await check('SMTP custom notification event-key idempotency', async () => {
      const records = await Promise.all(Array.from({ length: 8 }, () => service.enqueueNotification(content('test-run-123'))));
      assert.equal(await Outbox.countDocuments(), 1); assert.equal(new Set(records.map(r => String(r._id))).size, 1);
      assert.equal(records[0].state, 'pending'); assert.equal(records[0].attempts, 0); assert.equal(calls.length, 0);
      const again = await service.enqueueNotification({ ...content('test-run-123'), subject: 'do not overwrite' });
      assert.equal(again.subject, content('test-run-123').subject);
    });
    await check('SMTP custom content rejects empty oversized and transport fields', async () => {
      for (const patch of [{ eventKey: '' }, { subject: ' ' }, { text: '' }, { subject: 'x'.repeat(201) }, { text: 'x'.repeat(20001) }, ...['to','cc','bcc','recipient','email','from','host','html','envelope'].map(k => ({ [k]: 'arbitrary@example.invalid' }))]) {
        await assert.rejects(() => service.enqueueNotification({ ...content('invalid'), ...patch }), { code: 'NOTIFICATION_CONTENT_INVALID' });
      }
      assert.equal(await Outbox.countDocuments(), 0); assert.equal(calls.length, 0);
    });
    await check('SMTP targeted delivery sends only requested outbox record', async () => {
      for (let i = 0; i < 4; i++) await seed(`historical-${i}`);
      const target = await seed('target');
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'provider_accepted');
      assert.deepEqual(calls, [{ to: recipient, subject: target.subject, text: target.text }]);
    });
    await check('SMTP historical pending records untouched', async () => {
      for (let i = 0; i < 4; i++) await seed(`historical-${i}`);
      const before = await Outbox.find().sort({ _id: 1 }).lean(); const target = await seed('target');
      await service.deliverById(String(target._id), {}, deps);
      assert.deepEqual(await Outbox.find({ _id: { $ne: target._id } }).sort({ _id: 1 }).lean(), before);
    });
    await check('SMTP missing recipient zero transport', async () => {
      const target = await seed('missing-recipient'); delete process.env.ROBO_NOTIFICATION_RECIPIENT;
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'unconfigured');
      assert.equal(calls.length, 0); const row = await Outbox.findById(target._id); assert.equal(row.state, 'pending'); assert.equal(row.attempts, 0);
    });
    await check('SMTP missing config zero transport', async () => {
      const target = await seed('missing-config');
      for (const key of ['SMTP_HOST', 'SMTP_FROM']) { const value = process.env[key]; delete process.env[key]; assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'unconfigured'); process.env[key] = value; }
      assert.equal(calls.length, 0); assert.equal((await Outbox.findById(target._id)).attempts, 0);
    });
    await check('SMTP configured recipient only no caller overrides', async () => {
      const target = await seed('recipient');
      for (const key of ['recipient','to','cc','bcc','from','host','email']) await assert.rejects(() => service.deliverById(String(target._id), { [key]: 'intruder@example.invalid' }, deps), { code: 'NOTIFICATION_OPTIONS_INVALID' });
      process.env.ROBO_NOTIFICATION_RECIPIENT = 'one@example.invalid,two@example.invalid';
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'unconfigured'); assert.equal(calls.length, 0);
    });
    await check('SMTP target not found zero unrelated claim', async () => {
      await seed('history'); const before = await Outbox.find().lean();
      assert.equal((await service.deliverById(String(new mongoose.Types.ObjectId()), {}, deps)).state, 'not_found');
      assert.equal(calls.length, 0); assert.deepEqual(await Outbox.find().lean(), before);
    });
    await check('SMTP already sent target zero resend', async () => {
      const target = await seed('sent'); await service.deliverById(String(target._id), {}, deps); const before = await Outbox.findById(target._id).lean();
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'terminal');
      assert.equal(calls.length, 1); assert.deepEqual(await Outbox.findById(target._id).lean(), before);
    });
    await check('SMTP active lease blocks targeted duplicate', async () => {
      const target = await seed('leased');
      await Outbox.updateOne({ _id: target._id }, { $set: { state: 'sending', leaseOwner: 'other-worker', leaseUntil: new Date(Date.now() + 120000) } });
      const before = await Outbox.findById(target._id).lean();
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'leased'); assert.equal(calls.length, 0);
      assert.deepEqual(await Outbox.findById(target._id).lean(), before);
      await Outbox.updateOne({ _id: target._id }, { $set: { leaseUntil: new Date(0) } });
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'provider_accepted');
    });
    await check('SMTP concurrent target claim sends once', async () => {
      const target = await seed('concurrent');
      const results = await Promise.all([service.deliverById(String(target._id), {}, deps), service.deliverById(String(target._id), {}, deps)]);
      assert.equal(results.filter(r => r.state === 'provider_accepted').length, 1); assert.equal(calls.length, 1); assert.equal((await Outbox.findById(target._id)).attempts, 1);
    });
    await check('SMTP provider accepted persists provider identity', async () => {
      const target = await seed('success'); const now = new Date(); await service.deliverById(String(target._id), { now }, deps);
      const row = await Outbox.findById(target._id); assert.equal(row.providerMessageId, 'synthetic-provider-id'); assert.equal(+row.providerAcceptedAt, +now); assert.equal(row.state, 'provider_accepted'); assert.equal(row.attempts, 1); assert.equal(row.leaseOwner, undefined); assert.equal(row.leaseUntil, undefined);
    });
    await check('SMTP uncertain post-transport state is not auto-retried', async () => {
      const target = await seed('uncertain'); outcome = async () => { const armed = await Outbox.findById(target._id); assert.equal(armed.state, 'delivery_uncertain'); throw Object.assign(new Error('synthetic DATA socket loss'), { code: 'ECONNECTION', command: 'DATA' }); };
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'delivery_uncertain');
      const row = await Outbox.findById(target._id); assert.equal(row.attempts, 1); assert.equal(row.lastError, 'EMAIL_DELIVERY_UNCERTAIN'); assert.equal(row.leaseOwner, undefined);
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'terminal'); assert.equal(calls.length, 1);
    });
    await check('SMTP batch dispatcher skips uncertain record', async () => {
      const target = await seed('uncertain-batch'); outcome = async () => { throw new Error('unknown outcome'); };
      await service.deliverById(String(target._id), {}, deps); outcome = null;
      assert.equal((await service.deliverNext({}, deps)).state, 'idle'); await service.runNotificationTick(); assert.equal(calls.length, 1);
      await seed('unrelated'); assert.equal((await service.deliverNext({}, deps)).state, 'provider_accepted'); assert.equal(calls.length, 2); assert.equal((await Outbox.findById(target._id)).attempts, 1);
    });
    await check('SMTP crash after transport boundary stays fenced after lease expiry', async () => {
      const target = await seed('crash');
      outcome = async () => { await Outbox.updateOne({ _id: target._id }, { $set: { leaseUntil: new Date(0) } }); assert.equal((await service.deliverNext({}, deps)).state, 'idle'); assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'terminal'); throw new Error('lost response'); };
      await service.deliverById(String(target._id), {}, deps); assert.equal(calls.length, 1);
    });
    await check('SMTP generic CONN timeout after DATA is uncertain', async () => {
      for (const code of ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET']) {
        const target = await seed('late-' + code);
        outcome = async () => { throw Object.assign(new Error('synthetic late connection loss'), { code, command: 'CONN' }); };
        assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'delivery_uncertain');
        assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'terminal');
      }
      assert.equal(calls.length, 3);
    });
    await check('SMTP definitive pre-acceptance failure remains retryable', async () => {
      const target = await seed('connect-failure'); outcome = async () => { throw Object.assign(new Error('synthetic connect failure'), { code: 'EDNS', command: 'CONN' }); };
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'retryable');
      const row = await Outbox.findById(target._id); assert.equal(row.attempts, 1); assert.equal(row.lastError, 'EMAIL_DELIVERY_FAILED');
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'not_eligible');
      outcome = null; assert.equal((await service.deliverById(String(target._id), { now: new Date(+row.nextAttemptAt + 1) }, deps)).state, 'provider_accepted'); assert.equal(calls.length, 2);
    });
    await check('SMTP ambiguous provider result is uncertain', async () => {
      const target = await seed('ambiguous'); outcome = async () => ({ provider: 'smtp', accepted: [recipient, 'extra@example.invalid'] });
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'delivery_uncertain'); assert.equal(calls.length, 1);
    });
    await check('SMTP accepted response persistence failure cannot resend', async () => {
      const target = await seed('persistence');
      const wrapped = { findOneAndUpdate: (...a) => Outbox.findOneAndUpdate(...a), findById: (...a) => Outbox.findById(...a), updateOne: (filter, update) => {
        if (update.$set.state === 'provider_accepted') throw new Error('synthetic database failure');
        return Outbox.updateOne(filter, update);
      } };
      await assert.rejects(() => service.deliverById(String(target._id), {}, { Outbox: wrapped, send }), /database failure/);
      await Outbox.updateOne({ _id: target._id }, { $set: { leaseUntil: new Date(0) } });
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'terminal');
      assert.equal((await service.deliverNext({}, deps)).state, 'idle'); assert.equal(calls.length, 1);
    });
    await check('SMTP negative DATA response is definitive rejection', async () => {
      const target = await seed('rejected-data'); outcome = async () => { throw Object.assign(new Error('synthetic rejection'), { command: 'DATA', responseCode: 451 }); };
      assert.equal((await service.deliverById(String(target._id), {}, deps)).state, 'retryable'); assert.equal(calls.length, 1);
    });
    await check('SMTP production transport path uses only configured recipient', async () => {
      const target = await seed('production-path');
      assert.equal((await service.deliverById(String(target._id))).state, 'provider_accepted'); assert.equal(calls.length, 1);
      assert.equal(calls[0].to, recipient); assert.equal(calls[0].from, 'test-sender@example.invalid');
    });
    await check('SMTP existing deliverNext behavior preserved', async () => {
      const first = await seed('first'); await Outbox.updateOne({ _id: first._id }, { $set: { nextAttemptAt: new Date(0) } }); await seed('second');
      assert.equal((await service.deliverNext({}, deps)).state, 'provider_accepted'); assert.equal(calls[0].subject, first.subject); assert.equal(await Outbox.countDocuments({ state: 'pending' }), 1);
    });
    await check('SMTP existing notification tick behavior preserved', async () => {
      for (let i = 0; i < 12; i++) await seed(`batch-${i}`);
      await service.runNotificationTick(); assert.equal(calls.length, 10); assert.equal(await Outbox.countDocuments({ state: 'provider_accepted' }), 10); assert.equal(await Outbox.countDocuments({ state: 'pending' }), 2);
    });
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]; }
});
