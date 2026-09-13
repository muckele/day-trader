const test = require('node:test');
const assert = require('node:assert/strict');
const Intent = require('../models/OrderIntent');
const { stopStatus } = require('../services/dispatchAuthorization');

for (const pause of [{ pausedReason: 'Risk review required.' }, { pausedUntil: new Date('2100-01-01T00:00:00Z') }]) {
  test(`enabled automation with ${Object.keys(pause)[0]} blocks admissions while retaining unresolved identities`, async t => {
    t.mock.method(Intent, 'find', query => {
      assert.equal(query.userId, 'owner-paused');
      return { select: () => ({ lean: async () => [{ _id: 'intent-paused', clientOrderId: 'mvp-paused', status: 'submission_uncertain', dispatchClaims: { submit: { state: 'delivery_unknown' } } }] }) };
    });
    const status = await stopStatus('owner-paused', { isEnabled: true, enabled: true, mode: 'paper', ...pause });
    assert.equal(status.admissionsDisabled, true);
    assert.equal(status.paused, true);
    assert.equal(status.state, 'draining');
    assert.equal(status.unresolved[0].clientOrderId, 'mvp-paused');
  });
}

test('paused automation can confirm an empty dispatch drain without claiming it was disabled', async t => {
  t.mock.method(Intent, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  const status = await stopStatus('owner-paused', { isEnabled: true, mode: 'paper', pausedReason: 'Risk review required.' });
  assert.equal(status.state, 'stopped');
  assert.equal(status.admissionsDisabled, true);
  assert.equal(status.paused, true);
  assert.deepEqual(status.unresolved, []);
});

test('expired timestamp without a persistent reason allows current admissions', async () => {
  assert.deepEqual(await stopStatus('owner-paused', { isEnabled: true, mode: 'paper', pausedUntil: new Date('2000-01-01T00:00:00Z') }), { state: 'running', admissionsDisabled: false, unresolved: [] });
});

test('explicit disable remains a stop rather than a temporary pause', async t => {
  t.mock.method(Intent, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  assert.deepEqual(await stopStatus('owner-paused', { isEnabled: false, enabled: false, mode: 'paper', pausedReason: 'Emergency stop triggered.' }), { state: 'stopped', admissionsDisabled: true, unresolved: [] });
});
