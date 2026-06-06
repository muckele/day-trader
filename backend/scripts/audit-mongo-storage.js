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

const mongoConnectionConfig = buildMongoConnectionTargets(process.env);
const CONNECT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000)
);
const SAMPLE_LIMIT = Math.max(
  1,
  Math.min(250, Number(process.env.MONGO_AUDIT_SAMPLE_LIMIT || 25))
);
const OUTPUT_JSON = String(process.env.MONGO_AUDIT_JSON || '').toLowerCase() === 'true';
const MONGO_DNS_SERVERS = String(process.env.MONGO_DNS_SERVERS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MONGO_IP_FAMILY = normalizeMongoIpFamily(
  process.env.MONGO_IP_FAMILY,
  mongoConnectionConfig.isProduction ? 4 : 0
);

const LARGE_FIELD_PATHS = [
  'payload',
  'payload.chart',
  'payload.chart.timeframes',
  'payload.news',
  'payload.events',
  'payload.dataQuality',
  'providerHealth',
  'staleWarnings',
  'rawPayload',
  'images',
  'researchSnapshot',
  'summarySnapshot',
  'tradeIdeas',
  'metadata',
  'result',
  'context',
  'metrics',
  'alpacaResponse',
  'recommendedOrder'
];

function redactMongoUri(uri) {
  return String(uri || '').replace(/(mongodb(?:\+srv)?:\/\/)[^@/]+@/i, '$1***:***@');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function bytes(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function formatBytes(value) {
  const numeric = bytes(value);
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

function summarizeTopFields(doc = {}, limit = 6) {
  return Object.entries(doc)
    .filter(([key]) => key !== '_id' && key !== '__v')
    .map(([key, value]) => ({
      path: key,
      bytes: objectSize({ [key]: value })
    }))
    .filter(item => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

function getPathValue(source, path) {
  return path.split('.').reduce((value, segment) => {
    if (value === null || value === undefined) return undefined;
    return value[segment];
  }, source);
}

function summarizeKnownPaths(doc = {}, limit = 8) {
  return LARGE_FIELD_PATHS
    .map(path => ({
      path,
      bytes: objectSize({ [path]: getPathValue(doc, path) })
    }))
    .filter(item => item.bytes > 8)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

function compactSizeList(items = []) {
  return items
    .map(item => `${item.path} ${formatBytes(item.bytes)}`)
    .join(', ');
}

async function connectToMongoTarget() {
  if (!mongoConnectionConfig.targets.length) {
    fail('No Mongo connection targets configured.');
  }

  if (MONGO_DNS_SERVERS.length) {
    dnsNative.setServers(MONGO_DNS_SERVERS);
    if (!OUTPUT_JSON) {
      console.log(`INFO Using custom DNS servers: ${MONGO_DNS_SERVERS.join(', ')}`);
    }
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
        if (!OUTPUT_JSON) {
          console.error(
            `WARN DNS SRV lookup failed for ${srvCheck.record} (${srvCheck.error?.code || 'ERR'}). Trying fallback target...`
          );
        }
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
      if (!OUTPUT_JSON) {
        console.log(`INFO Connected via ${target.label}: ${redactMongoUri(target.uri)}`);
      }
      return target;
    } catch (err) {
      await mongoose.disconnect().catch(() => {});
      if (!OUTPUT_JSON) {
        console.error(`WARN Mongo connection via ${target.label} failed: ${err.message}`);
      }
    }
  }

  fail('Mongo connectivity check failed for all configured URIs.');
}

async function safeCollectionStats(db, name) {
  try {
    return await db.command({ collStats: name, scale: 1 });
  } catch (err) {
    return { error: err.message };
  }
}

async function sampleRecentDocuments(collection) {
  try {
    return await collection.find({}, { sort: { _id: -1 }, limit: SAMPLE_LIMIT }).toArray();
  } catch (_err) {
    return collection.find({}, { limit: SAMPLE_LIMIT }).toArray();
  }
}

async function auditCollection(db, collectionInfo) {
  const name = collectionInfo.name;
  const collection = db.collection(name);
  const stats = await safeCollectionStats(db, name);
  const sampleDocs = await sampleRecentDocuments(collection);
  const sampleSizes = sampleDocs.map(doc => ({
    id: String(doc._id),
    createdAt: doc.createdAt || doc.generatedAt || doc.filledAt || doc.updatedAt || null,
    bytes: objectSize(doc),
    topFields: summarizeTopFields(doc),
    largePaths: summarizeKnownPaths(doc)
  }));
  const largestSample = sampleSizes.sort((a, b) => b.bytes - a.bytes)[0] || null;
  let count = Number.isFinite(stats.count) ? stats.count : null;
  if (count === null) {
    try {
      count = await collection.estimatedDocumentCount();
    } catch (_err) {
      count = null;
    }
  }

  return {
    name,
    type: collectionInfo.type || 'collection',
    count,
    sizeBytes: bytes(stats.size),
    storageSizeBytes: bytes(stats.storageSize),
    indexSizeBytes: bytes(stats.totalIndexSize),
    avgObjSizeBytes: bytes(stats.avgObjSize),
    statsError: stats.error || null,
    sampleLimit: SAMPLE_LIMIT,
    sampleCount: sampleDocs.length,
    largestSample
  };
}

function summarizeFindings(collections = []) {
  const rows = collections
    .filter(item => item.type === 'collection')
    .sort((a, b) => (
      (b.sizeBytes + b.indexSizeBytes + (b.largestSample?.bytes || 0)) -
      (a.sizeBytes + a.indexSizeBytes + (a.largestSample?.bytes || 0))
    ));

  return {
    largestCollections: rows.slice(0, 12),
    collectionsWithLargeSamples: rows
      .filter(item => (item.largestSample?.bytes || 0) >= 16 * 1024)
      .slice(0, 12)
  };
}

function printReport(report) {
  console.log(`\nMongo storage audit: ${report.database}`);
  console.log(`Connected target: ${report.target.label}`);
  console.log(`Sampled recent docs per collection: ${report.sampleLimit}`);
  if (report.dbStats?.dataSize !== undefined) {
    console.log(
      `DB logical data: ${formatBytes(report.dbStats.dataSize)} | indexes: ${formatBytes(report.dbStats.indexSize)} | storage: ${formatBytes(report.dbStats.storageSize)}`
    );
  }

  console.log('\nLargest collections');
  report.findings.largestCollections.forEach(item => {
    const parts = [
      `${item.name}`,
      `docs=${item.count ?? 'unknown'}`,
      `data=${formatBytes(item.sizeBytes)}`,
      `indexes=${formatBytes(item.indexSizeBytes)}`,
      `storage=${formatBytes(item.storageSizeBytes)}`
    ];
    if (item.statsError) parts.push(`statsError="${item.statsError}"`);
    console.log(`- ${parts.join(' | ')}`);
  });

  console.log('\nLargest sampled documents');
  report.findings.collectionsWithLargeSamples.forEach(item => {
    const sample = item.largestSample;
    console.log(`- ${item.name}: ${formatBytes(sample.bytes)} doc=${sample.id}`);
    const topFields = compactSizeList(sample.topFields);
    const largePaths = compactSizeList(sample.largePaths);
    if (topFields) console.log(`  top fields: ${topFields}`);
    if (largePaths) console.log(`  known large paths: ${largePaths}`);
  });

  if (!report.findings.collectionsWithLargeSamples.length) {
    console.log('- No sampled document was at least 16 KiB.');
  }
}

async function main() {
  const target = await connectToMongoTarget();
  const db = mongoose.connection.db;
  const dbStats = await db.command({ dbStats: 1, scale: 1 }).catch(err => ({ error: err.message }));
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  const auditedCollections = [];

  for (const collectionInfo of collections) {
    auditedCollections.push(await auditCollection(db, collectionInfo));
  }

  const report = {
    database: db.databaseName,
    generatedAt: new Date().toISOString(),
    target: {
      label: target.label,
      type: target.type
    },
    sampleLimit: SAMPLE_LIMIT,
    dbStats,
    collections: auditedCollections,
    findings: summarizeFindings(auditedCollections)
  };

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  await mongoose.disconnect();
}

main().catch(async err => {
  await mongoose.disconnect().catch(() => {});
  fail(err.message);
});
