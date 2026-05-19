const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LOCAL_MONGO_URI,
  buildMongoConnectionTargets
} = require('../utils/mongoConnectionConfig');

test('buildMongoConnectionTargets prefers local Mongo first in development', () => {
  const config = buildMongoConnectionTargets({
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb+srv://user:pass@atlas.example/daytrader',
    MONGO_URI_DIRECT: 'mongodb://user:pass@atlas-00.example:27017/daytrader',
    MONGO_LOCAL_URI: 'mongodb://127.0.0.1:27017/daytrader'
  });

  assert.equal(config.isProduction, false);
  assert.equal(config.preferLocal, true);
  assert.deepEqual(
    config.targets.map(target => target.label),
    ['MONGO_LOCAL_URI', 'MONGO_URI', 'MONGO_URI_DIRECT']
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

test('buildMongoConnectionTargets can place local Mongo after Atlas when preferred off in development', () => {
  const config = buildMongoConnectionTargets({
    NODE_ENV: 'development',
    MONGO_PREFER_LOCAL: 'false',
    MONGO_URI: 'mongodb+srv://user:pass@atlas.example/daytrader'
  });

  assert.equal(config.preferLocal, false);
  assert.deepEqual(
    config.targets.map(target => target.label),
    ['MONGO_URI', 'MONGO_LOCAL_URI']
  );
  assert.equal(config.targets[1].uri, DEFAULT_LOCAL_MONGO_URI);
});
