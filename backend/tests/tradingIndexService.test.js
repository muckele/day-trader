const test = require('node:test');
const assert = require('node:assert/strict');
const {
  backfillRecommendationSnapshots,
  backfillStrategyParameterAccountIds,
  backfillStrategyRunAccountIds,
  ensureStrategyTelemetryIndexes,
  ensureTradingIndexes
} = require('../services/tradingIndexService');

function createFindChain(result) {
  return {
    select() {
      return this;
    },
    lean: async () => result
  };
}

test('ensureTradingIndexes attempts every configured trading model', async () => {
  const calls = [];
  const models = [
    { modelName: 'One', createIndexes: async () => calls.push('One') },
    { modelName: 'Two', createIndexes: async () => calls.push('Two') }
  ];

  const results = await ensureTradingIndexes({ logger: { error: () => {} }, models });

  assert.deepEqual(calls, ['One', 'Two']);
  assert.deepEqual(results, [
    { model: 'One', ok: true },
    { model: 'Two', ok: true }
  ]);
});

test('backfillStrategyRunAccountIds derives account scope from known users and fallback ids', async () => {
  const operations = [];
  const StrategyRunModel = {
    find: () => createFindChain([
      { _id: 'run-1', context: { userId: '507f1f77bcf86cd799439011' } },
      { _id: 'run-2', context: { userId: 'not-an-object-id' } },
      { _id: 'run-3', context: {} }
    ]),
    bulkWrite: async ops => {
      operations.push(...ops);
    }
  };
  const UserModel = {
    find: () => createFindChain([
      { _id: '507f1f77bcf86cd799439011', username: 'alice' }
    ])
  };

  const count = await backfillStrategyRunAccountIds({ StrategyRunModel, UserModel });

  assert.equal(count, 3);
  assert.deepEqual(operations.map(op => op.updateOne.update.$set.accountId), [
    'user:alice',
    'user:not-an-object-id',
    'default'
  ]);
});

test('backfillStrategyParameterAccountIds uses the referencing run account when unambiguous', async () => {
  const operations = [];
  const StrategyParameterVersionModel = {
    find: () => createFindChain([
      { _id: 'version-1' },
      { _id: 'version-2' }
    ]),
    bulkWrite: async ops => {
      operations.push(...ops);
    }
  };
  const StrategyRunModel = {
    find: () => createFindChain([
      { parameterVersionId: 'version-1', accountId: 'user:alice' },
      { parameterVersionId: 'version-2', accountId: 'user:alice' },
      { parameterVersionId: 'version-2', accountId: 'user:bob' }
    ])
  };

  const count = await backfillStrategyParameterAccountIds({
    StrategyParameterVersionModel,
    StrategyRunModel
  });

  assert.equal(count, 2);
  assert.deepEqual(operations.map(op => op.updateOne.update.$set.accountId), [
    'user:alice',
    'default'
  ]);
});

test('ensureStrategyTelemetryIndexes drops legacy global indexes and creates scoped indexes', async () => {
  const dropped = [];
  const created = [];
  const StrategyRunModel = {
    modelName: 'StrategyRun',
    find: () => createFindChain([]),
    bulkWrite: async () => {},
    createIndexes: async () => created.push('StrategyRun'),
    collection: {
      dropIndex: async name => {
        dropped.push(name);
      }
    }
  };
  const StrategyParameterVersionModel = {
    modelName: 'StrategyParameterVersion',
    find: () => createFindChain([]),
    bulkWrite: async () => {},
    createIndexes: async () => created.push('StrategyParameterVersion'),
    collection: {
      dropIndex: async name => {
        dropped.push(name);
      }
    }
  };

  const results = await ensureStrategyTelemetryIndexes({
    logger: { error: () => {} },
    StrategyParameterVersionModel,
    StrategyRunModel,
    UserModel: { find: () => createFindChain([]) }
  });

  assert.equal(results[0].ok, true);
  assert.deepEqual(created.sort(), ['StrategyParameterVersion', 'StrategyRun']);
  assert.deepEqual(dropped.sort(), [
    'strategyId_1_parameterHash_1',
    'strategyId_1_startedAt_-1',
    'strategyId_1_version_1'
  ]);
});

test('backfillRecommendationSnapshots adds unique legacy keys and TTL dates', async () => {
  const operations = [];
  const RecommendationSnapshotModel = {
    find: () => createFindChain([
      {
        _id: 'snapshot-1',
        asOf: new Date('2026-01-01T00:00:00.000Z')
      }
    ]),
    bulkWrite: async ops => {
      operations.push(...ops);
    }
  };

  const count = await backfillRecommendationSnapshots({ RecommendationSnapshotModel });

  assert.equal(count, 1);
  assert.equal(operations[0].updateOne.update.$set.snapshotKey, 'legacy:snapshot-1');
  assert.equal(operations[0].updateOne.update.$set.expiresAt.toISOString(), '2026-01-15T00:00:00.000Z');
});
