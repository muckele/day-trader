const ResearchSnapshot = require('../models/ResearchSnapshot');

function isSingleExpiresAtIndex(index = {}) {
  return index.key
    && index.key.expiresAt === 1
    && Object.keys(index.key).length === 1;
}

async function ensureResearchSnapshotTtlIndex({
  ResearchSnapshotModel = ResearchSnapshot,
  logger = console
} = {}) {
  const collection = ResearchSnapshotModel.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (err) {
    const message = String(err?.message || '');
    if (!/namespace.*not.*found|ns not found|does not exist/i.test(message)) {
      throw err;
    }
  }
  const expiresIndex = indexes.find(isSingleExpiresAtIndex);
  const result = {
    model: ResearchSnapshotModel.modelName || 'ResearchSnapshot',
    indexName: expiresIndex?.name || 'expiresAt_1',
    action: 'none',
    ok: true
  };

  if (expiresIndex?.expireAfterSeconds === 0) {
    result.action = 'already_ttl';
    await ResearchSnapshotModel.createIndexes();
    return result;
  }

  if (expiresIndex) {
    try {
      await collection.conn.db.command({
        collMod: collection.collectionName,
        index: {
          name: expiresIndex.name,
          expireAfterSeconds: 0
        }
      });
      result.action = 'converted_to_ttl';
    } catch (err) {
      logger.warn?.(
        `[indexes] ${result.model} TTL collMod failed; recreating ${expiresIndex.name}:`,
        err?.message || err
      );
      await collection.dropIndex(expiresIndex.name);
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: expiresIndex.name });
      result.action = 'recreated_as_ttl';
    }
  }

  await ResearchSnapshotModel.createIndexes();
  if (!expiresIndex) result.action = 'created';
  return result;
}

async function ensureResearchIndexes(options = {}) {
  try {
    return [await ensureResearchSnapshotTtlIndex(options)];
  } catch (err) {
    options.logger?.error?.('[indexes] Research index creation failed:', err?.message || err);
    return [{
      model: options.ResearchSnapshotModel?.modelName || 'ResearchSnapshot',
      ok: false,
      error: err?.message || 'Research index creation failed.'
    }];
  }
}

module.exports = {
  ensureResearchIndexes,
  ensureResearchSnapshotTtlIndex,
  isSingleExpiresAtIndex
};
