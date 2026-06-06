const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureResearchSnapshotTtlIndex,
  isSingleExpiresAtIndex
} = require('../services/researchIndexService');

function makeResearchSnapshotModel({ indexes, commandError = null } = {}) {
  const calls = [];
  return {
    modelName: 'ResearchSnapshot',
    createIndexes: async () => {
      calls.push(['createIndexes']);
    },
    collection: {
      collectionName: 'researchsnapshots',
      indexes: async () => indexes,
      dropIndex: async name => {
        calls.push(['dropIndex', name]);
      },
      createIndex: async (key, options) => {
        calls.push(['createIndex', key, options]);
      },
      conn: {
        db: {
          command: async command => {
            calls.push(['command', command]);
            if (commandError) throw commandError;
          }
        }
      }
    },
    calls
  };
}

function makeMissingCollectionModel() {
  const calls = [];
  return {
    modelName: 'ResearchSnapshot',
    createIndexes: async () => {
      calls.push(['createIndexes']);
    },
    collection: {
      indexes: async () => {
        throw new Error('ns not found');
      },
      conn: { db: { command: async () => {} } }
    },
    calls
  };
}

test('isSingleExpiresAtIndex detects the TTL candidate key only', () => {
  assert.equal(isSingleExpiresAtIndex({ key: { expiresAt: 1 } }), true);
  assert.equal(isSingleExpiresAtIndex({ key: { expiresAt: -1 } }), false);
  assert.equal(isSingleExpiresAtIndex({ key: { scope: 1, expiresAt: 1 } }), false);
});

test('ensureResearchSnapshotTtlIndex converts an existing expiresAt index to TTL', async () => {
  const model = makeResearchSnapshotModel({
    indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 } }]
  });

  const result = await ensureResearchSnapshotTtlIndex({
    ResearchSnapshotModel: model,
    logger: { warn: () => {} }
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'converted_to_ttl');
  assert.deepEqual(model.calls[0], [
    'command',
    {
      collMod: 'researchsnapshots',
      index: {
        name: 'expiresAt_1',
        expireAfterSeconds: 0
      }
    }
  ]);
  assert.deepEqual(model.calls.at(-1), ['createIndexes']);
});

test('ensureResearchSnapshotTtlIndex recreates the TTL index when collMod fails', async () => {
  const model = makeResearchSnapshotModel({
    indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 } }],
    commandError: new Error('collMod unsupported')
  });

  const result = await ensureResearchSnapshotTtlIndex({
    ResearchSnapshotModel: model,
    logger: { warn: () => {} }
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'recreated_as_ttl');
  assert.deepEqual(model.calls[1], ['dropIndex', 'expiresAt_1']);
  assert.deepEqual(model.calls[2], [
    'createIndex',
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'expiresAt_1' }
  ]);
});

test('ensureResearchSnapshotTtlIndex creates indexes when the collection does not exist yet', async () => {
  const model = makeMissingCollectionModel();

  const result = await ensureResearchSnapshotTtlIndex({
    ResearchSnapshotModel: model,
    logger: { warn: () => {} }
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.deepEqual(model.calls, [['createIndexes']]);
});
