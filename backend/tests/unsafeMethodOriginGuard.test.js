const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createUnsafeMethodOriginGuard,
  parseHeaderOrigin
} = require('../middleware/unsafeMethodOriginGuard');
const { SESSION_COOKIE_NAME } = require('../utils/sessionCookie');

function createRes() {
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

async function runGuard(req, guard) {
  const res = createRes();
  let nextCalled = false;
  await guard(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('parseHeaderOrigin normalizes referer URLs to origins', () => {
  assert.equal(parseHeaderOrigin('https://app.example.com/path?q=1'), 'https://app.example.com');
  assert.equal(parseHeaderOrigin('not a url'), '');
});

test('unsafe method origin guard allows bearer-token API calls without browser origin', async () => {
  const guard = createUnsafeMethodOriginGuard({ allowedOrigins: ['https://app.example.com'] });
  const { res, nextCalled } = await runGuard({
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session-token`,
      authorization: 'Bearer api-token'
    }
  }, guard);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('unsafe method origin guard rejects cookie-authenticated posts without a trusted origin', async () => {
  const guard = createUnsafeMethodOriginGuard({ allowedOrigins: ['https://app.example.com'] });
  const { res, nextCalled } = await runGuard({
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session-token`,
      host: 'api.example.com'
    }
  }, guard);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('unsafe method origin guard allows cookie-authenticated posts from configured frontend origin', async () => {
  const guard = createUnsafeMethodOriginGuard({ allowedOrigins: ['https://app.example.com'] });
  const { res, nextCalled } = await runGuard({
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=session-token`,
      origin: 'https://app.example.com'
    }
  }, guard);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});
