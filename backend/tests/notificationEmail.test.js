const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');

test('notification SMTP transport preserves configured sender TLS and single recipient', async t => {
  const keys = ['SMTP_HOST','SMTP_PORT','SMTP_FROM','SMTP_USER','SMTP_PASS'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let options, message;
  t.mock.method(nodemailer, 'createTransport', value => { options = value; return { sendMail: async mail => { message = mail; return { messageId: 'synthetic-message', accepted: ['owner@example.invalid'] }; } }; });
  try {
    process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '2525'; process.env.SMTP_FROM = 'sender@example.invalid'; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    const { sendNotificationEmail } = require('../services/roboEmail');
    const result = await sendNotificationEmail({ to: 'owner@example.invalid', subject: 'Controlled acceptance', text: 'No external send.' });
    assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 2525); assert.equal(options.requireTLS, true); assert.equal(options.secure, false); assert.equal(options.auth, undefined);
    assert.deepEqual(message, { from: 'sender@example.invalid', to: 'owner@example.invalid', subject: 'Controlled acceptance', text: 'No external send.' });
    assert.deepEqual(result, { provider: 'smtp', messageId: 'synthetic-message', accepted: ['owner@example.invalid'] });
    delete process.env.SMTP_HOST;
    await assert.rejects(() => sendNotificationEmail({ to: 'owner@example.invalid' }), /configuration is missing/);
    process.env.SMTP_HOST = '127.0.0.1'; delete process.env.SMTP_FROM;
    await assert.rejects(() => sendNotificationEmail({ to: 'owner@example.invalid' }), /sender is missing/);
  } finally { for (const k of keys) before[k] === undefined ? delete process.env[k] : process.env[k] = before[k]; }
});
