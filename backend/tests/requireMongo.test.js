const test = require('node:test');
const assert = require('node:assert/strict');

const requireMongo = require('../middleware/requireMongo');
const mongoState = require('../utils/mongoState');

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('requireMongo passes through when mongo is ready', t => {
  t.mock.method(mongoState, 'isMongoRequestReady', () => true);

  const res = createMockRes();
  let nextCalled = false;

  requireMongo({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test('requireMongo returns 503 payload when mongo is unavailable', t => {
  t.mock.method(mongoState, 'isMongoRequestReady', () => false);
  t.mock.method(mongoState, 'createMongoUnavailablePayload', () => ({
    message: 'Database temporarily unavailable',
    service: 'mongo',
    state: 'disconnected',
    readyState: 0,
    hint: 'Verify MongoDB connectivity and Atlas network access.'
  }));

  const res = createMockRes();
  let nextCalled = false;

  requireMongo({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    message: 'Database temporarily unavailable',
    service: 'mongo',
    state: 'disconnected',
    readyState: 0,
    hint: 'Verify MongoDB connectivity and Atlas network access.'
  });
});
