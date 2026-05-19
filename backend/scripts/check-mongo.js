#!/usr/bin/env node

require('dotenv').config();

const dnsNative = require('dns');
const mongoose = require('mongoose');
const { buildMongoConnectionTargets } = require('../utils/mongoConnectionConfig');
const {
  buildMongoConnectOptions,
  checkMongoSrvRecord,
  normalizeMongoIpFamily
} = require('../utils/mongoNetwork');

const mongoConnectionConfig = buildMongoConnectionTargets(process.env);
const MONGO_DNS_SERVERS = String(process.env.MONGO_DNS_SERVERS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const CONNECT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000)
);
const MONGO_IP_FAMILY = normalizeMongoIpFamily(
  process.env.MONGO_IP_FAMILY,
  mongoConnectionConfig.isProduction ? 4 : 0
);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function redactMongoUri(uri) {
  return uri.replace(/(mongodb(?:\+srv)?:\/\/)[^@/]+@/i, '$1***:***@');
}

async function checkConnection(uri, label) {
  const redacted = redactMongoUri(uri);
  console.log(`INFO Checking ${label}: ${redacted}`);
  try {
    await mongoose.connect(
      uri,
      buildMongoConnectOptions({
        serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
        ipFamily: MONGO_IP_FAMILY
      })
    );
    console.log(`PASS Mongo connection via ${label}`);
    await mongoose.disconnect();
    return true;
  } catch (err) {
    await mongoose.disconnect().catch(() => {});
    console.error(`FAIL Mongo connection via ${label}: ${err.message}`);
    return false;
  }
}

async function main() {
  if (!mongoConnectionConfig.targets.length) {
    fail('No Mongo connection targets configured.');
  }

  if (MONGO_DNS_SERVERS.length) {
    try {
      dnsNative.setServers(MONGO_DNS_SERVERS);
      console.log(`INFO Using custom DNS servers: ${MONGO_DNS_SERVERS.join(', ')}`);
    } catch (err) {
      fail(`Invalid MONGO_DNS_SERVERS value: ${err.message}`);
    }
  }

  if (!mongoConnectionConfig.isProduction && mongoConnectionConfig.preferLocal) {
    console.log('INFO Development Mongo mode: checking local MongoDB before Atlas targets.');
  }
  if (MONGO_IP_FAMILY === 4 || MONGO_IP_FAMILY === 6) {
    console.log(`INFO MongoDB IP family preference: IPv${MONGO_IP_FAMILY}`);
  }

  for (let index = 0; index < mongoConnectionConfig.targets.length; index += 1) {
    const target = mongoConnectionConfig.targets[index];
    const hasMoreTargets = index < mongoConnectionConfig.targets.length - 1;

    let shouldAttemptConnection = true;
    if (target.label === 'MONGO_URI' && target.uri.startsWith('mongodb+srv://')) {
      const srvCheck = await checkMongoSrvRecord(target.uri);
      if (!srvCheck.ok) {
        if (!hasMoreTargets) {
          fail(
            `DNS SRV lookup failed for ${srvCheck.record} (${srvCheck.error?.code || 'ERR'}). ` +
            'Add MONGO_URI_DIRECT or enable local MongoDB for development.'
          );
        }
        console.error(
          `WARN DNS SRV lookup failed for ${srvCheck.record} (${srvCheck.error?.code || 'ERR'}). ` +
          'Check Atlas hostname/network access. Trying fallback target...'
        );
        shouldAttemptConnection = false;
      } else {
        console.log(`PASS DNS SRV ${srvCheck.record} -> ${srvCheck.records.length} records`);
      }
    }

    if (!shouldAttemptConnection) {
      continue;
    }

    const ok = await checkConnection(target.uri, target.label);
    if (ok) return;
  }

  fail(
    'Mongo connectivity check failed for all configured URIs. ' +
    'Start local MongoDB for development or verify Atlas DB user, password, URI host, and Atlas Network Access IP allowlist.'
  );
}

main().catch(err => fail(err.message));
