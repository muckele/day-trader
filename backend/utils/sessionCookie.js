const SESSION_COOKIE_NAME = 'daytrader_session';

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function getSessionCookieOptions(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 60 * 60 * 1000
  };
}

function readSessionToken(req = {}) {
  const header = req.headers?.authorization || '';
  const bearerToken = header.replace(/^Bearer\s+/i, '').trim();
  if (bearerToken) return bearerToken;
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies[SESSION_COOKIE_NAME] || '';
}

function setSessionCookie(res, token, env = process.env) {
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(env));
}

function clearSessionCookie(res, env = process.env) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    ...getSessionCookieOptions(env),
    maxAge: undefined
  });
}

module.exports = {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  getSessionCookieOptions,
  parseCookies,
  readSessionToken,
  setSessionCookie
};
