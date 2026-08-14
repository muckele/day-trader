const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LOCAL_MONGO_URI,
  buildMongoConnectionTargets
} = require('../utils/mongoConnectionConfig');

test('buildMongoConnectionTargets ignores remote Mongo targets in development by default', () => {
  const config = buildMongoConnectionTargets({
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb+srv://user:pass@atlas.example/daytrader',
    MONGO_URI_DIRECT: 'mongodb://user:pass@atlas-00.example:27017/daytrader',
    MONGO_LOCAL_URI: 'mongodb://127.0.0.1:27017/daytrader'
  });

  assert.equal(config.isProduction, false);
  assert.equal(config.preferLocal, true);
  assert.equal(config.allowRemoteDevelopment, false);
  assert.deepEqual(
    config.targets.map(target => target.label),
    ['MONGO_LOCAL_URI']
  );
});

test('buildMongoConnectionTargets excludes local Mongo in production by default', () => {
  const config = buildMongoConnectionTargets({
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb+srv://user:pass@atlas.example/daytrader',
    MONGO_URI_DIRECT: 'mongodb://user:pass@atlas-00.example:27017/daytrader'
  });

  assert.equal(config.isProduction, true);
  assert.equal(config.preferLocal, false);
  assert.deepEqual(
    config.targets.map(target => target.label),
    ['MONGO_URI', 'MONGO_URI_DIRECT']
  );
});

test('buildMongoConnectionTargets permits remote development only with explicit opt-in', () => {
  const config = buildMongoConnectionTargets({
    NODE_ENV: 'development',
    MONGO_PREFER_LOCAL: 'false',
    MONGO_ALLOW_REMOTE_DEV: 'true',
    MONGO_URI: 'mongodb+srv://user:pass@atlas.example/daytrader'
  });

  assert.equal(config.preferLocal, false);
  assert.equal(config.allowRemoteDevelopment, true);
  assert.deepEqual(
    config.targets.map(target => target.label),
    ['MONGO_URI', 'MONGO_LOCAL_URI']
  );
  assert.equal(config.targets[1].uri, DEFAULT_LOCAL_MONGO_URI);
});
