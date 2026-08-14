const packageMetadata = require('../package.json');

function sanitizeIdentifier(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  return normalized.replace(/[^A-Za-z0-9._:@/-]/g, '').slice(0, 128) || fallback;
}

function getReleaseMetadata(env = process.env) {
  return {
    service: 'day-trader-backend',
    version: sanitizeIdentifier(packageMetadata.version, '0.0.0'),
    sourceCommit: sanitizeIdentifier(env.RELEASE_COMMIT || env.SOURCE_COMMIT, 'unknown'),
    buildId: sanitizeIdentifier(env.BUILD_ID || env.FLY_IMAGE_REF, 'local'),
    environment: sanitizeIdentifier(
      env.ROBOTRADER_DEPLOYMENT_ENV || env.DEPLOYMENT_ENV || env.NODE_ENV,
      'development'
    )
  };
}

module.exports = { getReleaseMetadata };
