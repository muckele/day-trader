const mongoose = require('mongoose');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const OrderIntent = require('../models/OrderIntent');
const PaperOrder = require('../models/PaperOrder');
const PaperTrade = require('../models/PaperTrade');
const PaperAccountLock = require('../models/PaperAccountLock');
const RecommendationSnapshot = require('../models/RecommendationSnapshot');
const RoboAuditLog = require('../models/RoboAuditLog');
const RoboCanaryDossier = require('../models/RoboCanaryDossier');
const RoboExposureSnapshot = require('../models/RoboExposureSnapshot');
const RoboLiveActivation = require('../models/RoboLiveActivation');
const RoboLivePromotion = require('../models/RoboLivePromotion');
const RoboLock = require('../models/RoboLock');
const RoboOperationalAlert = require('../models/RoboOperationalAlert');
const RoboReadinessEvidence = require('../models/RoboReadinessEvidence');
const RoboSettings = require('../models/RoboSettings');
const RoboSignalExecution = require('../models/RoboSignalExecution');
const RoboTradeDecision = require('../models/RoboTradeDecision');
const RoboTradeOrder = require('../models/RoboTradeOrder');
const StrategyParameterVersion = require('../models/StrategyParameterVersion');
const StrategyRun = require('../models/StrategyRun');
const TradeAuthorization = require('../models/TradeAuthorization');
const User = require('../models/User');
const { getAccountIdForUser } = require('../utils/accountScope');
const {
  getSnapshotExpiry
} = require('./recommendationEngine');

const TRADING_INDEX_MODELS = [
  BrokerOrder,
  Fill,
  OrderIntent,
  PaperAccountLock,
  PaperOrder,
  PaperTrade,
  RoboAuditLog,
  RoboCanaryDossier,
  RoboExposureSnapshot,
  RoboLiveActivation,
  RoboLivePromotion,
  RoboLock,
  RoboOperationalAlert,
  RoboReadinessEvidence,
  RoboSettings,
  RoboSignalExecution,
  RoboTradeDecision,
  RoboTradeOrder,
  TradeAuthorization
];

const STRATEGY_TELEMETRY_INDEX_MODELS = [
  StrategyParameterVersion,
  StrategyRun
];

const LEGACY_INDEXES = [
  { model: StrategyParameterVersion, name: 'strategyId_1_version_1' },
  { model: StrategyParameterVersion, name: 'strategyId_1_parameterHash_1' },
  { model: StrategyRun, name: 'strategyId_1_startedAt_-1' }
];

function isSingleCreatedAtIndex(index = {}) {
  return Boolean(
    index.key
    && index.key.createdAt === 1
    && Object.keys(index.key).length === 1
  );
}

function missingAccountQuery() {
  return {
    $or: [
      { accountId: { $exists: false } },
      { accountId: null },
      { accountId: '' }
    ]
  };
}

function normalizeId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function selectLean(model, query, projection) {
  const request = model.find(query);
  if (typeof request.select === 'function') {
    return request.select(projection).lean();
  }
  return request.lean();
}

async function loadUserAccountMap(userIds, UserModel = User) {
  const validIds = Array.from(new Set(userIds.map(normalizeId).filter(Boolean)))
    .filter(id => mongoose.Types.ObjectId.isValid(id));
  if (!validIds.length || !UserModel.find) return new Map();

  const users = await selectLean(UserModel, { _id: { $in: validIds } }, '_id username');
  return users.reduce((acc, user) => {
    acc.set(String(user._id), getAccountIdForUser(user));
    return acc;
  }, new Map());
}

function resolveRunAccountId(run = {}, userAccountMap = new Map()) {
  const accountId = normalizeId(run.accountId || run.context?.accountId);
  if (accountId) return accountId;

  const userId = normalizeId(run.context?.userId);
  if (userId && userAccountMap.has(userId)) return userAccountMap.get(userId);
  if (userId) return getAccountIdForUser({ userId });

  return 'default';
}

async function backfillStrategyRunAccountIds({ StrategyRunModel = StrategyRun, UserModel = User } = {}) {
  const runs = await selectLean(StrategyRunModel, missingAccountQuery(), '_id accountId context');
  if (!runs.length) return 0;

  const userAccountMap = await loadUserAccountMap(
    runs.map(run => run.context?.userId),
    UserModel
  );
  const operations = runs.map(run => ({
    updateOne: {
      filter: { _id: run._id },
      update: { $set: { accountId: resolveRunAccountId(run, userAccountMap) } }
    }
  }));
  if (!operations.length) return 0;
  await StrategyRunModel.bulkWrite(operations, { ordered: false });
  return operations.length;
}

async function backfillStrategyParameterAccountIds({
  StrategyParameterVersionModel = StrategyParameterVersion,
  StrategyRunModel = StrategyRun
} = {}) {
  const versions = await selectLean(StrategyParameterVersionModel, missingAccountQuery(), '_id accountId');
  if (!versions.length) return 0;

  const versionIds = versions.map(version => version._id);
  const runs = await selectLean(
    StrategyRunModel,
    {
      accountId: { $exists: true, $nin: [null, ''] },
      parameterVersionId: { $in: versionIds }
    },
    'accountId parameterVersionId'
  );
  const accountIdsByVersion = runs.reduce((acc, run) => {
    const key = String(run.parameterVersionId || '');
    if (!key) return acc;
    if (!acc.has(key)) acc.set(key, new Set());
    acc.get(key).add(run.accountId);
    return acc;
  }, new Map());

  const operations = versions.map(version => {
    const accountIds = Array.from(accountIdsByVersion.get(String(version._id)) || []);
    return {
      updateOne: {
        filter: { _id: version._id },
        update: { $set: { accountId: accountIds.length === 1 ? accountIds[0] : 'default' } }
      }
    };
  });
  await StrategyParameterVersionModel.bulkWrite(operations, { ordered: false });
  return operations.length;
}

async function dropIndexIfExists(model, name, logger = console) {
  if (!model?.collection?.dropIndex) return false;
  try {
    await model.collection.dropIndex(name);
    return true;
  } catch (err) {
    const message = String(err?.message || '');
    if (err?.code === 27 || /index not found|index does not exist/i.test(message)) {
      return false;
    }
    logger.error(`[indexes] ${model.modelName || 'model'} legacy index drop failed:`, message || err);
    throw err;
  }
}

async function ensureStrategyTelemetryIndexes({
  logger = console,
  StrategyParameterVersionModel = StrategyParameterVersion,
  StrategyRunModel = StrategyRun,
  UserModel = User
} = {}) {
  try {
    const runsBackfilled = await backfillStrategyRunAccountIds({ StrategyRunModel, UserModel });
    const parameterVersionsBackfilled = await backfillStrategyParameterAccountIds({
      StrategyParameterVersionModel,
      StrategyRunModel
    });
    const droppedIndexes = [];
    for (const item of LEGACY_INDEXES) {
      const model = item.model === StrategyParameterVersion
        ? StrategyParameterVersionModel
        : StrategyRunModel;
      if (await dropIndexIfExists(model, item.name, logger)) {
        droppedIndexes.push(item.name);
      }
    }
    await Promise.all([
      StrategyParameterVersionModel.createIndexes(),
      StrategyRunModel.createIndexes()
    ]);
    return [{
      model: 'StrategyTelemetry',
      ok: true,
      migrated: {
        runsBackfilled,
        parameterVersionsBackfilled,
        droppedIndexes
      }
    }];
  } catch (err) {
    logger.error('[indexes] StrategyTelemetry index bootstrap failed:', err?.message || err);
    return [{
      model: 'StrategyTelemetry',
      ok: false,
      error: err?.message || 'Strategy telemetry index bootstrap failed.'
    }];
  }
}

async function backfillRecommendationSnapshots({ RecommendationSnapshotModel = RecommendationSnapshot } = {}) {
  const snapshots = await selectLean(
    RecommendationSnapshotModel,
    {
      $or: [
        { snapshotKey: { $exists: false } },
        { snapshotKey: null },
        { snapshotKey: '' },
        { expiresAt: { $exists: false } },
        { expiresAt: null }
      ]
    },
    '_id snapshotKey expiresAt asOf createdAt'
  );
  if (!snapshots.length) return 0;

  const operations = snapshots.map(snapshot => {
    const asOf = snapshot.asOf || snapshot.createdAt || new Date();
    return {
      updateOne: {
        filter: { _id: snapshot._id },
        update: {
          $set: {
            snapshotKey: snapshot.snapshotKey || `legacy:${snapshot._id}`,
            expiresAt: snapshot.expiresAt || getSnapshotExpiry(asOf)
          }
        }
      }
    };
  });
  await RecommendationSnapshotModel.bulkWrite(operations, { ordered: false });
  return operations.length;
}

async function ensureRecommendationSnapshotIndexes({
  logger = console,
  RecommendationSnapshotModel = RecommendationSnapshot
} = {}) {
  try {
    const snapshotsBackfilled = await backfillRecommendationSnapshots({ RecommendationSnapshotModel });
    await RecommendationSnapshotModel.createIndexes();
    return [{
      model: 'RecommendationSnapshot',
      ok: true,
      migrated: { snapshotsBackfilled }
    }];
  } catch (err) {
    logger.error('[indexes] RecommendationSnapshot index bootstrap failed:', err?.message || err);
    return [{
      model: 'RecommendationSnapshot',
      ok: false,
      error: err?.message || 'Recommendation snapshot index bootstrap failed.'
    }];
  }
}

async function ensureRoboAuditLogIndexes({
  logger = console,
  RoboAuditLogModel = RoboAuditLog,
  env = process.env
} = {}) {
  const desiredTtlSeconds = typeof RoboAuditLogModel.getRoboAuditLogTtlSeconds === 'function'
    ? RoboAuditLogModel.getRoboAuditLogTtlSeconds(env)
    : 7 * 24 * 60 * 60;
  try {
    const collection = RoboAuditLogModel.collection;
    const indexes = typeof collection?.indexes === 'function'
      ? await collection.indexes()
      : [];
    const ttlIndex = indexes.find(index => (
      index.name === 'roboAuditLogCreatedAtTtl'
      || isSingleCreatedAtIndex(index)
    ));
    let ttlStatus = ttlIndex ? 'ok' : 'missing';

    if (ttlIndex && ttlIndex.expireAfterSeconds !== desiredTtlSeconds) {
      const collectionName = collection.name || collection.collectionName || 'roboauditlogs';
      try {
        await collection.db.command({
          collMod: collectionName,
          index: {
            name: ttlIndex.name,
            expireAfterSeconds: desiredTtlSeconds
          }
        });
        ttlStatus = 'converted_ttl_index';
      } catch (err) {
        logger.warn?.(
          `[indexes] RoboAuditLog TTL collMod failed; recreating ${ttlIndex.name}:`,
          err?.message || err
        );
        await collection.dropIndex(ttlIndex.name);
        await collection.createIndex(
          { createdAt: 1 },
          { expireAfterSeconds: desiredTtlSeconds, name: 'roboAuditLogCreatedAtTtl' }
        );
        ttlStatus = 'recreated_ttl_index';
      }
    }

    await RoboAuditLogModel.createIndexes();
    return [{
      model: 'RoboAuditLog',
      ok: true,
      migrated: {
        ttlSeconds: desiredTtlSeconds,
        ttlStatus
      }
    }];
  } catch (err) {
    logger.error('[indexes] RoboAuditLog index bootstrap failed:', err?.message || err);
    return [{
      model: 'RoboAuditLog',
      ok: false,
      error: err?.message || 'RoboAuditLog index bootstrap failed.'
    }];
  }
}

async function ensureTradingIndexes({ logger = console, models = TRADING_INDEX_MODELS } = {}) {
  const results = [];
  if (models === TRADING_INDEX_MODELS) {
    results.push(...await ensureStrategyTelemetryIndexes({ logger }));
    results.push(...await ensureRecommendationSnapshotIndexes({ logger }));
    results.push(...await ensureRoboAuditLogIndexes({ logger }));
  }
  for (const model of models) {
    try {
      await model.createIndexes();
      results.push({ model: model.modelName, ok: true });
    } catch (err) {
      results.push({
        model: model.modelName,
        ok: false,
        error: err?.message || 'Index creation failed.'
      });
      logger.error(`[indexes] ${model.modelName} index creation failed:`, err?.message || err);
    }
  }
  return results;
}

module.exports = {
  backfillRecommendationSnapshots,
  backfillStrategyParameterAccountIds,
  backfillStrategyRunAccountIds,
  ensureRecommendationSnapshotIndexes,
  ensureRoboAuditLogIndexes,
  ensureStrategyTelemetryIndexes,
  ensureTradingIndexes,
  isSingleCreatedAtIndex,
  STRATEGY_TELEMETRY_INDEX_MODELS,
  TRADING_INDEX_MODELS
};
