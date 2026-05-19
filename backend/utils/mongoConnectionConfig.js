const DEFAULT_LOCAL_MONGO_URI = 'mongodb://127.0.0.1:27017/daytrader';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function buildMongoConnectionTargets(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
  const isProduction = nodeEnv === 'production';
  const preferLocal = parseBoolean(env.MONGO_PREFER_LOCAL, !isProduction);
  const localUri = String(env.MONGO_LOCAL_URI || DEFAULT_LOCAL_MONGO_URI).trim();
  const atlasSrvUri = String(env.MONGO_URI || '').trim();
  const atlasDirectUri = String(env.MONGO_URI_DIRECT || '').trim();
  const targets = [];

  const includeLocal = Boolean(localUri) && (!isProduction || preferLocal);
  if (includeLocal && preferLocal) {
    targets.push({ uri: localUri, label: 'MONGO_LOCAL_URI', type: 'local' });
  }

  if (atlasSrvUri) {
    targets.push({ uri: atlasSrvUri, label: 'MONGO_URI', type: 'atlas-srv' });
  }

  if (atlasDirectUri && atlasDirectUri !== atlasSrvUri) {
    targets.push({ uri: atlasDirectUri, label: 'MONGO_URI_DIRECT', type: 'atlas-direct' });
  }

  if (includeLocal && !preferLocal) {
    targets.push({ uri: localUri, label: 'MONGO_LOCAL_URI', type: 'local' });
  }

  return {
    nodeEnv,
    isProduction,
    preferLocal,
    targets
  };
}

module.exports = {
  DEFAULT_LOCAL_MONGO_URI,
  buildMongoConnectionTargets,
  parseBoolean
};
