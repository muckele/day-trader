#!/usr/bin/env node

require('dotenv').config();

const dnsNative = require('dns');
const mongoose = require('mongoose');
const { calculateObjectSize } = require('bson');
const { buildMongoConnectionTargets } = require('../utils/mongoConnectionConfig');
const {
  buildMongoConnectOptions,
  checkMongoSrvRecord,
  normalizeMongoIpFamily
} = require('../utils/mongoNetwork');
const { summarizeResearchSnapshot } = require('../robotrader/researchSnapshotSummary');

const mongoConnectionConfig = buildMongoConnectionTargets(process.env);
const APPLY = String(process.env.MONGO_COMPACT_APPLY || '').toLowerCase() === 'true';
const CONNECT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000)
);
const MIN_SNAPSHOT_BYTES = Math.max(
  512,
  Number(process.env.MONGO_COMPACT_MIN_SNAPSHOT_BYTES || 4096)
);
const LIMIT = Math.max(0, Number(process.env.MONGO_COMPACT_LIMIT || 0));
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_DECISION_STATUSES = ['approved', 'rejected', 'error', 'pending_manual_approval'];
const DECISION_RETENTION_DAYS = normalizeRetentionDays(
  process.env.ROBOTRADER_DECISION_RETENTION_DAYS,
  3
);
const AUDIT_LOG_RETENTION_DAYS = normalizeRetentionDays(
  process.env.ROBOTRADER_AUDIT_LOG_RETENTION_DAYS,
  7
);
const MONGO_DNS_SERVERS = String(process.env.MONGO_DNS_SERVERS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MONGO_IP_FAMILY = normalizeMongoIpFamily(
  process.env.MONGO_IP_FAMILY,
  mongoConnectionConfig.isProduction ? 4 : 0
);

function redactMongoUri(uri) {
  return String(uri || '').replace(/(mongodb(?:\+srv)?:\/\/)[^@/]+@/i, '$1***:***@');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function formatBytes(value) {
  const numeric = Number(value) || 0;
  if (numeric >= 1024 * 1024) return `${(numeric / 1024 / 1024).toFixed(2)} MiB`;
  if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} KiB`;
  return `${numeric} B`;
}

function objectSize(value) {
  try {
    return calculateObjectSize(value);
  } catch (_err) {
    return 0;
  }
}

function normalizeRetentionDays(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateSavingsBytes(count, stats = {}) {
  const avgObjSize = Number(stats.avgObjSize);
  return Number.isFinite(avgObjSize) && avgObjSize > 0 ? count * avgObjSize : 0;
}

async function collectionExists(db, name) {
  const result = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return result.length > 0;
}

async function safeCollectionStats(db, name) {
  try {
    return await db.command({ collStats: name, scale: 1 });
  } catch (_err) {
    return {};
  }
}

async function connectToMongoTarget() {
  if (!mongoConnectionConfig.targets.length) {
    fail('No Mongo connection targets configured.');
  }

  if (MONGO_DNS_SERVERS.length) {
    dnsNative.setServers(MONGO_DNS_SERVERS);
    console.log(`INFO Using custom DNS servers: ${MONGO_DNS_SERVERS.join(', ')}`);
  }

  for (let index = 0; index < mongoConnectionConfig.targets.length; index += 1) {
    const target = mongoConnectionConfig.targets[index];
    const hasMoreTargets = index < mongoConnectionConfig.targets.length - 1;

    if (target.label === 'MONGO_URI' && target.uri.startsWith('mongodb+srv://')) {
      const srvCheck = await checkMongoSrvRecord(target.uri);
      if (!srvCheck.ok) {
        if (!hasMoreTargets) {
          fail(`DNS SRV lookup failed for ${srvCheck.record} (${srvCheck.error?.code || 'ERR'}).`);
        }
        console.error(
          `WARN DNS SRV lookup failed for ${srvCheck.record} (${srvCheck.error?.code || 'ERR'}). Trying fallback target...`
        );
        continue;
      }
    }

    try {
      await mongoose.connect(
        target.uri,
        buildMongoConnectOptions({
          serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
          ipFamily: MONGO_IP_FAMILY
        })
      );
      console.log(`INFO Connected via ${target.label}: ${redactMongoUri(target.uri)}`);
      return target;
    } catch (err) {
      await mongoose.disconnect().catch(() => {});
      console.error(`WARN Mongo connection via ${target.label} failed: ${err.message}`);
    }
  }

  fail('Mongo connectivity check failed for all configured URIs.');
}

async function ensureResearchSnapshotTtl(db) {
  if (!await collectionExists(db, 'researchsnapshots')) {
    return {
      collection: 'researchsnapshots',
      status: 'missing',
      expiredDeleted: 0
    };
  }

  const collection = db.collection('researchsnapshots');
  const indexes = await collection.indexes();
  const expiresIndex = indexes.find(index => (
    index.key
    && index.key.expiresAt === 1
    && Object.keys(index.key).length === 1
  ));
  const expiredCount = await collection.countDocuments({ expiresAt: { $lte: new Date() } });
  const result = {
    collection: 'researchsnapshots',
    status: 'pending',
    indexName: expiresIndex?.name || null,
    previousExpireAfterSeconds: expiresIndex?.expireAfterSeconds ?? null,
    expiredCount,
    expiredDeleted: 0
  };

  if (expiresIndex?.expireAfterSeconds === 0) {
    result.status = 'ok';
  } else if (!APPLY) {
    result.status = expiresIndex ? 'would_convert_index_to_ttl' : 'would_create_ttl_index';
  }

  if (APPLY && expiredCount > 0) {
    const deleteResult = await collection.deleteMany({ expiresAt: { $lte: new Date() } });
    result.expiredDeleted = deleteResult.deletedCount || 0;
  }

  if (expiresIndex?.expireAfterSeconds === 0 || !APPLY) {
    return result;
  }

  if (expiresIndex) {
    try {
      await db.command({
        collMod: 'researchsnapshots',
        index: {
          name: expiresIndex.name,
          expireAfterSeconds: 0
        }
      });
      result.status = 'converted_index_to_ttl';
    } catch (err) {
      result.collModError = err.message;
      await collection.dropIndex(expiresIndex.name);
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: expiresIndex.name });
      result.status = 'recreated_ttl_index';
    }
  } else {
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    result.status = 'created_ttl_index';
  }

  return result;
}

function shouldCompactDecision(doc) {
  if (!doc || !doc.researchSnapshot || typeof doc.researchSnapshot !== 'object') return false;
  if (doc.researchSnapshot.summaryVersion === 1) return false;
  return objectSize({ researchSnapshot: doc.researchSnapshot }) >= MIN_SNAPSHOT_BYTES;
}

function buildCompactSnapshot(doc, beforeBytes) {
  return {
    ...summarizeResearchSnapshot(doc.researchSnapshot || {}),
    compactedAt: new Date().toISOString(),
    compactedFromBytes: beforeBytes
  };
}

async function compactRoboTradeDecisions(db) {
  if (!await collectionExists(db, 'robotradedecisions')) {
    return {
      collection: 'robotradedecisions',
      status: 'missing',
      scanned: 0,
      candidates: 0,
      modified: 0,
      beforeBytes: 0,
      afterBytes: 0,
      estimatedSavingsBytes: 0,
      examples: []
    };
  }

  const collection = db.collection('robotradedecisions');
  const query = {
    researchSnapshot: { $type: 'object' },
    'researchSnapshot.summaryVersion': { $ne: 1 }
  };
  const cursor = collection.find(query, {
    projection: {
      _id: 1,
      symbol: 1,
      decidedAt: 1,
      researchSnapshot: 1
    }
  }).batchSize(100);
  if (LIMIT > 0) cursor.limit(LIMIT);

  const result = {
    collection: 'robotradedecisions',
    status: APPLY ? 'applied' : 'dry_run',
    scanned: 0,
    candidates: 0,
    modified: 0,
    beforeBytes: 0,
    afterBytes: 0,
    estimatedSavingsBytes: 0,
    examples: []
  };
  const pendingWrites = [];

  async function flushWrites() {
    if (!APPLY || !pendingWrites.length) return;
    const writeResult = await collection.bulkWrite(pendingWrites, { ordered: false });
    result.modified += writeResult.modifiedCount || 0;
    pendingWrites.length = 0;
  }

  for await (const doc of cursor) {
    result.scanned += 1;
    if (!shouldCompactDecision(doc)) continue;

    const beforeBytes = objectSize({ researchSnapshot: doc.researchSnapshot });
    const compactSnapshot = buildCompactSnapshot(doc, beforeBytes);
    const afterBytes = objectSize({ researchSnapshot: compactSnapshot });
    result.candidates += 1;
    result.beforeBytes += beforeBytes;
    result.afterBytes += afterBytes;
    result.estimatedSavingsBytes += Math.max(0, beforeBytes - afterBytes);

    if (result.examples.length < 5) {
      result.examples.push({
        id: String(doc._id),
        symbol: doc.symbol || compactSnapshot.symbol || null,
        decidedAt: doc.decidedAt || null,
        beforeBytes,
        afterBytes,
        savingsBytes: Math.max(0, beforeBytes - afterBytes)
      });
    }

    if (APPLY) {
      pendingWrites.push({
        updateOne: {
          filter: { _id: doc._id, 'researchSnapshot.summaryVersion': { $ne: 1 } },
          update: { $set: { researchSnapshot: compactSnapshot } }
        }
      });
      if (pendingWrites.length >= 100) {
        await flushWrites();
      }
    }
  }

  await flushWrites();
  if (!APPLY) result.modified = 0;
  return result;
}

async function cleanupOldRoboTradeDecisions(db) {
  if (!await collectionExists(db, 'robotradedecisions')) {
    return {
      collection: 'robotradedecisions',
      status: 'missing',
      retentionDays: DECISION_RETENTION_DAYS,
      candidates: 0,
      deleted: 0,
      preservedLinked: 0,
      estimatedSavingsBytes: 0
    };
  }

  const decisions = db.collection('robotradedecisions');
  const orders = db.collection('robotradeorders');
  const cutoff = new Date(Date.now() - DECISION_RETENTION_DAYS * DAY_MS);
  const linkedIds = await collectionExists(db, 'robotradeorders')
    ? (await orders.distinct('decisionId')).filter(Boolean)
    : [];
  const baseQuery = {
    status: { $in: CLEANUP_DECISION_STATUSES },
    decidedAt: { $lt: cutoff }
  };
  const deleteQuery = linkedIds.length
    ? { ...baseQuery, _id: { $nin: linkedIds } }
    : baseQuery;
  const [candidates, linkedCandidates, stats] = await Promise.all([
    decisions.countDocuments(deleteQuery),
    linkedIds.length ? decisions.countDocuments({ ...baseQuery, _id: { $in: linkedIds } }) : 0,
    safeCollectionStats(db, 'robotradedecisions')
  ]);

  let deleted = 0;
  if (APPLY && candidates > 0) {
    const result = await decisions.deleteMany(deleteQuery);
    deleted = Number(result?.deletedCount || 0);
  }

  return {
    collection: 'robotradedecisions',
    status: APPLY ? 'applied' : 'dry_run',
    retentionDays: DECISION_RETENTION_DAYS,
    cutoff,
    candidates,
    deleted,
    preservedLinked: linkedCandidates,
    estimatedSavingsBytes: estimateSavingsBytes(candidates, stats)
  };
}

async function cleanupOldRoboAuditLogs(db) {
  if (!await collectionExists(db, 'roboauditlogs')) {
    return {
      collection: 'roboauditlogs',
      status: 'missing',
      retentionDays: AUDIT_LOG_RETENTION_DAYS,
      candidates: 0,
      deleted: 0,
      estimatedSavingsBytes: 0
    };
  }

  const audits = db.collection('roboauditlogs');
  const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * DAY_MS);
  const query = { createdAt: { $lt: cutoff } };
  const [candidates, stats] = await Promise.all([
    audits.countDocuments(query),
    safeCollectionStats(db, 'roboauditlogs')
  ]);
  let deleted = 0;
  if (APPLY && candidates > 0) {
    const result = await audits.deleteMany(query);
    deleted = Number(result?.deletedCount || 0);
  }

  return {
    collection: 'roboauditlogs',
    status: APPLY ? 'applied' : 'dry_run',
    retentionDays: AUDIT_LOG_RETENTION_DAYS,
    cutoff,
    candidates,
    deleted,
    estimatedSavingsBytes: estimateSavingsBytes(candidates, stats)
  };
}

function printReport({
  target,
  database,
  ttlResult,
  decisionResult,
  decisionCleanupResult,
  auditCleanupResult
}) {
  console.log(`\nMongo storage compaction ${APPLY ? 'apply' : 'dry-run'}: ${database}`);
  console.log(`Connected target: ${target.label}`);
  console.log(`Minimum snapshot size: ${formatBytes(MIN_SNAPSHOT_BYTES)}`);
  if (LIMIT > 0) console.log(`Decision scan limit: ${LIMIT}`);

  console.log('\nResearch snapshot TTL');
  console.log(
    `- status=${ttlResult.status} index=${ttlResult.indexName || 'none'} expired=${ttlResult.expiredCount || 0} deleted=${ttlResult.expiredDeleted || 0}`
  );
  if (ttlResult.collModError) {
    console.log(`  collMod fallback: ${ttlResult.collModError}`);
  }

  console.log('\nRoboTradeDecision snapshot compaction');
  console.log(
    `- scanned=${decisionResult.scanned} candidates=${decisionResult.candidates} modified=${decisionResult.modified}`
  );
  console.log(
    `- before=${formatBytes(decisionResult.beforeBytes)} after=${formatBytes(decisionResult.afterBytes)} estimatedSavings=${formatBytes(decisionResult.estimatedSavingsBytes)}`
  );
  decisionResult.examples.forEach(example => {
    console.log(
      `  example ${example.id} ${example.symbol || ''}: ${formatBytes(example.beforeBytes)} -> ${formatBytes(example.afterBytes)}`
    );
  });

  console.log('\nRoboTradeDecision retention cleanup');
  console.log(
    `- status=${decisionCleanupResult.status} retentionDays=${decisionCleanupResult.retentionDays} candidates=${decisionCleanupResult.candidates} deleted=${decisionCleanupResult.deleted}`
  );
  console.log(
    `- preservedLinked=${decisionCleanupResult.preservedLinked} estimatedSavings=${formatBytes(decisionCleanupResult.estimatedSavingsBytes)} cutoff=${decisionCleanupResult.cutoff?.toISOString?.() || 'n/a'}`
  );

  console.log('\nRoboAuditLog retention cleanup');
  console.log(
    `- status=${auditCleanupResult.status} retentionDays=${auditCleanupResult.retentionDays} candidates=${auditCleanupResult.candidates} deleted=${auditCleanupResult.deleted}`
  );
  console.log(
    `- estimatedSavings=${formatBytes(auditCleanupResult.estimatedSavingsBytes)} cutoff=${auditCleanupResult.cutoff?.toISOString?.() || 'n/a'}`
  );

  if (!APPLY) {
    console.log('\nRun with MONGO_COMPACT_APPLY=true to apply these changes.');
  }
}

async function main() {
  const target = await connectToMongoTarget();
  const db = mongoose.connection.db;
  const ttlResult = await ensureResearchSnapshotTtl(db);
  const decisionResult = await compactRoboTradeDecisions(db);
  const decisionCleanupResult = await cleanupOldRoboTradeDecisions(db);
  const auditCleanupResult = await cleanupOldRoboAuditLogs(db);

  printReport({
    target,
    database: db.databaseName,
    ttlResult,
    decisionResult,
    decisionCleanupResult,
    auditCleanupResult
  });

  await mongoose.disconnect();
}

main().catch(async err => {
  await mongoose.disconnect().catch(() => {});
  fail(err.message);
});
