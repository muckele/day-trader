#!/usr/bin/env node

const axios = require('axios');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function assertShape(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.code = 'SHAPE_ASSERTION_FAILED';
    throw err;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value, keys) {
  return keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

async function request(baseUrl, check) {
  const method = String(check.method || 'get').toLowerCase();
  const path = check.path;
  const url = `${baseUrl}${path}`;
  const res = await axios({
    method,
    url,
    timeout: 20_000,
    validateStatus: () => true
  });
  const expectedStatuses = Array.isArray(check.expectedStatuses)
    ? check.expectedStatuses
    : [200];
  if (!expectedStatuses.includes(res.status)) {
    const err = new Error(
      `Expected HTTP ${expectedStatuses.join('/')} for ${method.toUpperCase()} ${path}, got ${res.status}`
    );
    err.status = res.status;
    err.body = res.data;
    throw err;
  }
  return res.data;
}

function validateHealth(payload) {
  assertShape(isObject(payload), '/health should return an object');
  assertShape(typeof payload.status === 'string', '/health.status should be a string');
  assertShape(typeof payload.asOf === 'string', '/health.asOf should be a string');
  assertShape(isObject(payload.services), '/health.services should be an object');
  assertShape(isObject(payload.services.mongo), '/health.services.mongo should be an object');
  assertShape(typeof payload.services.mongo.readyState === 'number',
    '/health.services.mongo.readyState should be a number');
}

function validateIntraday(payload) {
  assertShape(Array.isArray(payload), '/api/market/intraday/AAPL should return an array');
  if (!payload.length) return;
  const first = payload[0];
  assertShape(isObject(first), 'intraday row should be an object');
  assertShape(hasKeys(first, ['time', 'open', 'high', 'low', 'close', 'volume']),
    'intraday row is missing expected keys');
}

function validateHistorical(payload) {
  assertShape(Array.isArray(payload), '/api/market/historical/AAPL should return an array');
  if (!payload.length) return;
  const first = payload[0];
  assertShape(isObject(first), 'historical row should be an object');
  assertShape(hasKeys(first, ['date', 'close']), 'historical row is missing expected keys');
}

function validateCompany(payload) {
  assertShape(isObject(payload), '/api/company/AAPL should return an object');
  if (isObject(payload.company)) {
    assertShape(typeof payload.company.name === 'string' || typeof payload.company.symbol === 'string',
      'company payload should include company.name or company.symbol');
    assertShape(isObject(payload.stats), 'company payload should include stats object');
    return;
  }
  assertShape(typeof payload.name === 'string' || typeof payload.symbol === 'string',
    'company payload should include name or symbol');
}

function validateAnalyze(payload) {
  assertShape(isObject(payload), '/api/analyze/AAPL should return an object');
  assertShape(typeof payload.ok === 'boolean', 'analyze payload should include boolean ok');
  assertShape(Object.prototype.hasOwnProperty.call(payload, 'analysis'),
    'analyze payload should include analysis key');
}

function validateRecommendations(payload) {
  assertShape(isObject(payload), '/api/recommendations/AAPL should return an object');
  assertShape(Array.isArray(payload.recommendations),
    'recommendations payload should include recommendations array');
}

function validateRoboRunOnceUnauthorized(payload) {
  assertShape(isObject(payload), '/api/robo/run-once should return JSON when unauthorized');
  assertShape(typeof payload.message === 'string', '/api/robo/run-once unauthorized payload should include message');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/smoke-api.js [--base-url http://localhost:4000]');
    process.exit(0);
  }

  const baseUrl = String(args['base-url'] || process.env.SMOKE_BASE_URL || 'http://localhost:4000')
    .replace(/\/$/, '');

  const checks = [
    { name: 'health', path: '/health', validate: validateHealth, expectedStatuses: [200] },
    { name: 'market-intraday', path: '/api/market/intraday/AAPL', validate: validateIntraday, expectedStatuses: [200] },
    { name: 'market-historical', path: '/api/market/historical/AAPL', validate: validateHistorical, expectedStatuses: [200] },
    { name: 'company', path: '/api/company/AAPL', validate: validateCompany, expectedStatuses: [200] },
    { name: 'analyze', path: '/api/analyze/AAPL', validate: validateAnalyze, expectedStatuses: [200] },
    { name: 'recommendations', path: '/api/recommendations/AAPL', validate: validateRecommendations, expectedStatuses: [200] },
    {
      name: 'robo-run-once-route',
      method: 'post',
      path: '/api/robo/run-once',
      validate: validateRoboRunOnceUnauthorized,
      expectedStatuses: [401]
    }
  ];

  const results = [];
  let failed = false;

  for (const check of checks) {
    try {
      const payload = await request(baseUrl, check);
      check.validate(payload);
      results.push({ check: check.name, ok: true });
      console.log(`PASS ${check.name}`);
    } catch (err) {
      failed = true;
      results.push({
        check: check.name,
        ok: false,
        error: err.message,
        status: err.status || null
      });
      console.error(`FAIL ${check.name}: ${err.message}`);
      if (err.body !== undefined) {
        console.error(`  response: ${JSON.stringify(err.body).slice(0, 400)}`);
      }
    }
  }

  console.log('\nSummary');
  console.log(JSON.stringify({
    baseUrl,
    total: results.length,
    passed: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length
  }, null, 2));

  process.exit(failed ? 1 : 0);
}

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
