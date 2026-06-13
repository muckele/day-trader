const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _getRateLimitBucketCount,
  clearRateLimitBuckets,
  createRateLimit
} = require('../middleware/rateLimit');

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

function runLimiter(limiter, ip) {
  const res = createMockRes();
  let nextCalled = false;
  limiter({ ip }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('rate limiter prunes expired buckets on subsequent traffic', async () => {
  clearRateLimitBuckets();
  const limiter = createRateLimit({
    keyPrefix: 'prune-test',
    windowMs: 1,
    max: 10
  });

  runLimiter(limiter, '203.0.113.1');
  assert.equal(_getRateLimitBucketCount(), 1);

  await new Promise(resolve => setTimeout(resolve, 5));
  runLimiter(limiter, '203.0.113.2');

  assert.equal(_getRateLimitBucketCount(), 1);
  clearRateLimitBuckets();
});

test('rate limiter keeps bucket storage bounded', () => {
  clearRateLimitBuckets();
  const limiter = createRateLimit({
    keyPrefix: 'bounded-test',
    windowMs: 60 * 1000,
    max: 10,
    maxBuckets: 2
  });

  runLimiter(limiter, '203.0.113.1');
  runLimiter(limiter, '203.0.113.2');
  runLimiter(limiter, '203.0.113.3');

  assert.equal(_getRateLimitBucketCount(), 2);
  clearRateLimitBuckets();
});
