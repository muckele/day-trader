const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_COOKIE_NAME,
  getSessionCookieOptions,
  parseCookies,
  readSessionToken
} = require('../utils/sessionCookie');

test('session cookie parser reads encoded cookie values', () => {
  const cookies = parseCookies(`${SESSION_COOKIE_NAME}=abc%20123; theme=dark`);
  assert.equal(cookies[SESSION_COOKIE_NAME], 'abc 123');
  assert.equal(cookies.theme, 'dark');
});

test('session token reader prefers bearer token when present', () => {
  const req = {
    headers: {
      authorization: 'Bearer bearer-token',
      cookie: `${SESSION_COOKIE_NAME}=cookie-token`
    }
  };
  assert.equal(readSessionToken(req), 'bearer-token');
});

test('production session cookies are httpOnly, secure, and cross-site capable', () => {
  const options = getSessionCookieOptions({ NODE_ENV: 'production' });
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, 'none');
});
