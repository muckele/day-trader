const { SESSION_COOKIE_NAME } = require('../utils/sessionCookie');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseHeaderOrigin(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    return parsed.origin;
  } catch (_err) {
    return '';
  }
}

function getExpectedRequestOrigin(req = {}) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || (req.secure ? 'https' : 'http');
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function hasSessionCookie(req = {}) {
  return String(req.headers?.cookie || '')
    .split(';')
    .map(part => part.trim())
    .some(part => part.startsWith(`${SESSION_COOKIE_NAME}=`));
}

function hasBearerAuth(req = {}) {
  return /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ''));
}

function createUnsafeMethodOriginGuard({ allowedOrigins = [] } = {}) {
  const allowed = new Set(
    allowedOrigins
      .map(origin => String(origin || '').trim())
      .filter(Boolean)
  );

  return function unsafeMethodOriginGuard(req, res, next) {
    if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();
    if (!hasSessionCookie(req) || hasBearerAuth(req)) return next();

    const origin = parseHeaderOrigin(req.headers?.origin)
      || parseHeaderOrigin(req.headers?.referer);
    const expectedOrigin = getExpectedRequestOrigin(req);

    if (origin && (allowed.has(origin) || origin === expectedOrigin)) {
      return next();
    }

    return res.status(403).json({
      message: 'Invalid request origin for cookie-authenticated request.'
    });
  };
}

module.exports = {
  createUnsafeMethodOriginGuard,
  getExpectedRequestOrigin,
  parseHeaderOrigin
};
