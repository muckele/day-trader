'use strict';
const mongoose = require('../../backend/node_modules/mongoose');
const Outbox = require('../../backend/models/NotificationOutbox');
const { deliverNext } = require('../../backend/services/roboNotificationService');
async function main() {
  const uri = process.env.SMTP_TEST_MONGO_URI;
  if (!/^mongodb:\/\/127\.0\.0\.1:27189\/mvp_test_smtp_[a-f0-9]+\?replicaSet=mvp&directConnection=true$/.test(uri || '')) throw new Error('Only isolated local SMTP test databases allowed');
  if (process.env.SMTP_HOST !== '127.0.0.1') throw new Error('Only local SMTP allowed');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  if (process.argv[2] === 'claim-and-wait') {
    await Outbox.findOneAndUpdate({ state: 'pending' }, { $set: { state: 'sending', leaseOwner: 'crashed-test-process', leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } });
    process.stdout.write('CLAIMED\n');
    await new Promise(() => {});
  } else {
    const result = await deliverNext({ now: new Date(Number(process.argv[2]) || Date.now()), recipient: 'owner@example.test' });
    console.log(JSON.stringify(result)); await mongoose.disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; mongoose.disconnect(); });
