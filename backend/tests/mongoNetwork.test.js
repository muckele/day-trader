const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMongoConnectOptions,
  extractSrvHost,
  normalizeMongoIpFamily
} = require('../utils/mongoNetwork');

test('extractSrvHost reads hostname from SRV uri', () => {
  assert.equal(
    extractSrvHost('mongodb+srv://user:pass@cluster0.example.mongodb.net/daytrader?retryWrites=true'),
    'cluster0.example.mongodb.net'
  );
  assert.equal(extractSrvHost('mongodb://127.0.0.1:27017/daytrader'), null);
});

test('normalizeMongoIpFamily only accepts IPv4 or IPv6', () => {
  assert.equal(normalizeMongoIpFamily('4', 0), 4);
  assert.equal(normalizeMongoIpFamily(6, 0), 6);
  assert.equal(normalizeMongoIpFamily('0', 4), 4);
  assert.equal(normalizeMongoIpFamily('foo', 4), 4);
});

test('buildMongoConnectOptions only sets family when valid', () => {
  assert.deepEqual(
    buildMongoConnectOptions({ serverSelectionTimeoutMS: 5000, ipFamily: 4 }),
    { serverSelectionTimeoutMS: 5000, family: 4 }
  );
  assert.deepEqual(
    buildMongoConnectOptions({ serverSelectionTimeoutMS: 5000, ipFamily: 0 }),
    { serverSelectionTimeoutMS: 5000 }
  );
});
