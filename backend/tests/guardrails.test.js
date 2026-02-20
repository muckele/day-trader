const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGuardrails, updateCooldownState } = require('../paper/guardrails');

test('evaluateGuardrails blocks oversized positions', () => {
  const settings = { maxPositionPct: 5, maxDailyLossPct: 2, cooldownUntil: null };
  const result = evaluateGuardrails({
    equity: 100000,
    orderNotional: 6000,
    dailyPnl: 0,
    settings,
    now: new Date()
  });
  assert.equal(result.ok, false);
});

test('evaluateGuardrails blocks daily loss limit', () => {
  const settings = { maxPositionPct: 5, maxDailyLossPct: 2, cooldownUntil: null };
  const result = evaluateGuardrails({
    equity: 100000,
    orderNotional: 1000,
    dailyPnl: -2500,
    settings,
    now: new Date()
  });
  assert.equal(result.ok, false);
});

test('evaluateGuardrails blocks cooldown', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const settings = { maxPositionPct: 5, maxDailyLossPct: 2, cooldownUntil: future };
  const result = evaluateGuardrails({
    equity: 100000,
    orderNotional: 1000,
    dailyPnl: 0,
    settings,
    now: new Date()
  });
  assert.equal(result.ok, false);
});

test('updateCooldownState triggers after three losses', () => {
  const now = new Date();
  const settings = { consecutiveLosses: 2, cooldownHours: 4, cooldownUntil: null };
  const updated = updateCooldownState(settings, -10, now);
  assert.equal(updated.consecutiveLosses, 3);
  assert.ok(updated.cooldownUntil);
});
