const dns = require('dns').promises;

function extractSrvHost(uri = '') {
  const match = String(uri).match(/^mongodb\+srv:\/\/[^@/]+@([^/?]+)/i);
  return match ? match[1] : null;
}

async function checkMongoSrvRecord(uri) {
  const host = extractSrvHost(uri);
  if (!host) {
    return { ok: true, host: null, record: null, records: [] };
  }

  const record = `_mongodb._tcp.${host}`;
  try {
    const records = await dns.resolveSrv(record);
    return { ok: true, host, record, records };
  } catch (err) {
    return {
      ok: false,
      host,
      record,
      records: [],
      error: err
    };
  }
}

function normalizeMongoIpFamily(value, fallback = 0) {
  const numeric = Number(value);
  if (numeric === 4 || numeric === 6) return numeric;
  return fallback;
}

function buildMongoConnectOptions({
  serverSelectionTimeoutMS,
  ipFamily = 0
} = {}) {
  const options = {
    serverSelectionTimeoutMS
  };
  if (ipFamily === 4 || ipFamily === 6) {
    options.family = ipFamily;
  }
  return options;
}

module.exports = {
  buildMongoConnectOptions,
  checkMongoSrvRecord,
  extractSrvHost,
  normalizeMongoIpFamily
};
