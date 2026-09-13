import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestEnvironment, runChecks } from '../verify-mvp.mjs';

test('verification drops real credentials and scheduler activation', () => {
  const env = buildTestEnvironment({ PATH: '/bin', HOME: '/tmp', APCA_API_KEY_ID: 'real', SMTP_PASS: 'real', MONGO_URI: 'production', ROBO_SCHEDULER_DISABLED: 'false', NODE_OPTIONS: '--require evil' });
  assert.equal(env.APCA_API_KEY_ID, undefined);
  assert.equal(env.SMTP_PASS, undefined);
  assert.equal(env.MONGO_URI, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ROBO_SCHEDULER_DISABLED, 'true');
  assert.equal(env.NODE_ENV, 'test');
});

test('verification preserves failures and continues independent checks', async () => {
  const seen = [];
  const result = await runChecks([{ name: 'bad' }, { name: 'good' }], async check => {
    seen.push(check.name);
    return { code: check.name === 'bad' ? 3 : 0 };
  });
  assert.deepEqual(seen, ['bad', 'good']);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].code, 3);
  assert.equal(result.checks[1].code, 0);
});

test('integration discovery runs each Mongo fixture in its own sequential check', async () => {
  const { buildMongoChecks } = await import('../verify-mvp.mjs');
  const checks = buildMongoChecks(['phase2Lifecycle.test.js', 'README.md', 'mvpPersistence.test.js', 'phase2Protection.test.js']);
  assert.deepEqual(checks.map(check => check.args), [
    ['--test', 'backend/integration/mvpPersistence.test.js'],
    ['--test', 'backend/integration/phase2Lifecycle.test.js'],
    ['--test', 'backend/integration/phase2Protection.test.js']
  ]);
  assert.equal(new Set(checks.map(check => check.name)).size, 3);
});

test('financial acceptance fails closed on missing or failing Mongo suites and preserves E2E blocker', async () => {
  const { buildRequiredAcceptance } = await import('../verify-mvp.mjs');
  assert.equal(buildRequiredAcceptance([])[0].status, 'BLOCKED');
  const passing = ['mongo-orderLifecycle.mongo', 'mongo-orderLifecycle.faults', 'mongo-orderProtection'].map(name => ({ name, code: 0 }));
  const accepted = buildRequiredAcceptance(passing);
  assert.equal(accepted[0].status, 'VERIFIED');
  assert.ok(accepted.some(item => item.status === 'BLOCKED' && /frontend/.test(item.name)));
  assert.equal(buildRequiredAcceptance([...passing.slice(0, 2), { name: 'mongo-orderProtection', code: 1 }])[0].status, 'BLOCKED');
});
