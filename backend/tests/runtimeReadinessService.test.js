const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRuntimeReadiness } = require('../services/runtimeReadinessService');

test('runtime readiness requires MongoDB and a fresh scheduler after startup', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const result = evaluateRuntimeReadiness({
    mongoReady: true,
    mongo: { state: 'connected', indexes: { state: 'ready' } },
    scheduler: {
      enabled: true,
      lastSuccessAt: new Date(now.getTime() - 60_000),
      lastError: null,
      reconciliationEnabled: true,
      lastReconciliationSuccessAt: new Date(now.getTime() - 120_000),
      lastReconciliationError: null
    },
    now,
    processUptimeMs: 60_000
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
});

test('runtime readiness fails closed for unavailable MongoDB or a stale scheduler', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const result = evaluateRuntimeReadiness({
    mongoReady: false,
    mongo: { state: 'disconnected', indexes: { state: 'failed' } },
    scheduler: {
      enabled: true,
      lastSuccessAt: new Date(now.getTime() - 10 * 60_000),
      lastError: 'tick failed',
      reconciliationEnabled: true,
      lastReconciliationSuccessAt: new Date(now.getTime() - 20 * 60_000),
      lastReconciliationError: 'lookup failed'
    },
    now,
    processUptimeMs: 60_000
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.every(check => check.passed), false);
});

test('runtime readiness detects stale reconciliation even when scheduler ticks are fresh', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const result = evaluateRuntimeReadiness({
    mongoReady: true,
    mongo: { state: 'connected', indexes: { state: 'ready' } },
    scheduler: {
      enabled: true,
      lastSuccessAt: new Date(now.getTime() - 60_000),
      reconciliationEnabled: true,
      lastReconciliationSuccessAt: new Date(now.getTime() - 20 * 60_000),
      lastReconciliationError: 'broker timeout'
    },
    now,
    processUptimeMs: 60_000
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find(check => check.key === 'scheduler').passed, true);
  assert.equal(result.checks.find(check => check.key === 'reconciliation').passed, false);
});

test('an intentionally disabled scheduler is ready when MongoDB is ready', () => {
  const result = evaluateRuntimeReadiness({
    mongoReady: true,
    mongo: { state: 'connected', indexes: { state: 'ready' } },
    scheduler: { enabled: false },
    processUptimeMs: 60_000
  });
  assert.equal(result.ready, true);
});
