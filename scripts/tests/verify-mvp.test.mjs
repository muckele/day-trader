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
