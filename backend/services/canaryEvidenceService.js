const crypto = require('node:crypto');

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stableObject(value[key]);
    return acc;
  }, {});
}

function hashCanonicalEvidence(value) {
  const canonical = stableObject(value);
  return {
    canonical,
    hash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  };
}

module.exports = {
  hashCanonicalEvidence,
  stableObject
};
