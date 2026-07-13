const test = require('node:test');
const assert = require('node:assert/strict');
const mongoState = require('../utils/mongoState');
const StrategyParameterVersion = require('../models/StrategyParameterVersion');
const StrategyRun = require('../models/StrategyRun');
const {
  createStrategyRun,
  getOrCreateParameterVersion,
  listRecentParameterVersions,
  listRecentStrategyRuns,
  normalizeAccountId
} = require('../services/strategyRunService');

function createFindChain(result, captureLimit = () => {}) {
  return {
    populate() {
      return this;
    },
    sort() {
      return this;
    },
    limit(value) {
      captureLimit(value);
      return this;
    },
    lean: async () => result
  };
}

test('normalizeAccountId rejects empty scope values', () => {
  assert.equal(normalizeAccountId(' user:alice '), 'user:alice');
  assert.equal(normalizeAccountId('   '), null);
});

test('listRecentStrategyRuns filters by account scope and caps limit', async t => {
  t.mock.method(mongoState, 'isMongoReady', () => true);
  let receivedQuery = null;
  let receivedLimit = null;
  t.mock.method(StrategyRun, 'find', query => {
    receivedQuery = query;
    return createFindChain([], value => {
      receivedLimit = value;
    });
  });

  const runs = await listRecentStrategyRuns({
    accountId: 'user:alice',
    runType: 'robo',
    limit: 500
  });

  assert.deepEqual(runs, []);
  assert.deepEqual(receivedQuery, { accountId: 'user:alice', runType: 'robo' });
  assert.equal(receivedLimit, 100);
});

test('listRecentParameterVersions filters by account scope', async t => {
  t.mock.method(mongoState, 'isMongoReady', () => true);
  let receivedQuery = null;
  t.mock.method(StrategyParameterVersion, 'find', query => {
    receivedQuery = query;
    return createFindChain([]);
  });

  await listRecentParameterVersions({
    accountId: 'user:bob',
    strategyId: 'SMA_CROSS',
    limit: 5
  });

  assert.deepEqual(receivedQuery, {
    accountId: 'user:bob',
    strategyId: 'SMA_CROSS'
  });
});

test('createStrategyRun writes account scope to run and parameter version', async t => {
  t.mock.method(mongoState, 'isMongoReady', () => true);
  const findQueries = [];
  let parameterPayload = null;
  let runPayload = null;

  t.mock.method(StrategyParameterVersion, 'findOne', query => {
    findQueries.push(query);
    if (query.parameterHash) return Promise.resolve(null);
    return {
      sort: () => ({
        lean: async () => ({ version: 2 })
      })
    };
  });
  t.mock.method(StrategyParameterVersion, 'create', async payload => {
    parameterPayload = payload;
    return { _id: 'parameter-version-3' };
  });
  t.mock.method(StrategyRun, 'create', async payload => {
    runPayload = payload;
    return { _id: 'strategy-run-1', ...payload };
  });

  const run = await createStrategyRun({
    accountId: 'user:alice',
    strategyId: 'SMA_CROSS',
    runType: 'backtest',
    parameters: { timeframe: '1D' },
    source: 'backtest'
  });

  assert.equal(run.accountId, 'user:alice');
  assert.equal(parameterPayload.accountId, 'user:alice');
  assert.equal(parameterPayload.version, 3);
  assert.equal(runPayload.accountId, 'user:alice');
  assert.equal(runPayload.parameterVersionId, 'parameter-version-3');
  assert.equal(findQueries[0].accountId, 'user:alice');
  assert.equal(findQueries[1].accountId, 'user:alice');
});

test('parameter version allocation retries a concurrent version collision', async t => {
  t.mock.method(mongoState, 'isMongoReady', () => true);
  let hashLookups = 0;
  let latestVersion = 1;
  let createAttempts = 0;
  t.mock.method(StrategyParameterVersion, 'findOne', query => {
    if (query.parameterHash) {
      hashLookups += 1;
      return Promise.resolve(null);
    }
    return { sort: () => ({ lean: async () => ({ version: latestVersion++ }) }) };
  });
  t.mock.method(StrategyParameterVersion, 'create', async payload => {
    createAttempts += 1;
    if (createAttempts === 1) {
      const error = new Error('duplicate version');
      error.code = 11000;
      throw error;
    }
    return { _id: 'parameter-retried', ...payload };
  });
  const version = await getOrCreateParameterVersion({
    accountId: 'user:alice',
    strategyId: 'ROBO_TREND_FOLLOWING_V1',
    parameters: { timeframe: '1D' }
  });
  assert.equal(version._id, 'parameter-retried');
  assert.equal(createAttempts, 2);
  assert.ok(hashLookups >= 2);
});
