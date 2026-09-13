const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const Audit = require('../models/RoboAuditLog');
const settingsService = require('../robotrader/settingsService');
const dispatch = require('../services/dispatchAuthorization');
const worker = require('../robotrader/worker');

const draining = { state: 'draining', admissionsDisabled: true, unresolved: [{ intentId: 'intent-1', clientOrderId: 'mvp-original', status: 'submission_uncertain', dispatchClaimed: true }] };

for (const [method, path] of [['get', '/settings'], ['put', '/settings'], ['post', '/disable'], ['post', '/enable'], ['post', '/emergency-stop']]) {
  test(`${method.toUpperCase()} ${path} preserves durable stop status in settings`, async t => {
    const enabled = path === '/enable';
    const settings = { userId: 'owner-status', isEnabled: enabled, enabled, mode: 'paper' };
    const status = enabled ? { state: 'running', admissionsDisabled: false, unresolved: [] } : draining;
    t.mock.method(User, 'findOne', async () => ({ _id: 'owner-status' }));
    t.mock.method(Audit, 'create', async value => value);
    t.mock.method(settingsService, 'getOrCreateRoboTraderSettings', async () => settings);
    t.mock.method(settingsService, 'updateRoboTraderSettings', async () => settings);
    t.mock.method(worker, 'emergencyStop', async () => ({ settings, stopStatus: status, canceledOrderIds: [] }));
    t.mock.method(dispatch, 'stopStatus', async (owner, current) => {
      assert.equal(owner, 'owner-status');
      assert.equal(current.isEnabled, enabled);
      return status;
    });
    delete require.cache[require.resolve('../routes/robotrader')];
    const router = require('../routes/robotrader');
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    const handler = layer.route.stack.at(-1).handle;
    let body;
    await handler({ user: { username: 'owner' }, body: {} }, { json: value => { body = value; } }, error => { throw error; });
    assert.deepEqual(body.settings.stopStatus, status);
    if (path === '/emergency-stop') assert.deepEqual(body.stopStatus, status);
  });
}

test('settings refresh reports completed drain only from a new durable status observation', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'owner-status' }));
  t.mock.method(settingsService, 'getOrCreateRoboTraderSettings', async () => ({ isEnabled: false }));
  let status = draining;
  t.mock.method(dispatch, 'stopStatus', async () => status);
  delete require.cache[require.resolve('../routes/robotrader')];
  const router = require('../routes/robotrader');
  const handler = router.stack.find(item => item.route?.path === '/settings' && item.route.methods.get).route.stack.at(-1).handle;
  const request = async () => {
    let body;
    await handler({ user: { username: 'owner' } }, { json: value => { body = value; } }, error => { throw error; });
    return body.settings.stopStatus;
  };
  assert.deepEqual(await request(), draining);
  status = { state: 'stopped', admissionsDisabled: true, unresolved: [] };
  assert.deepEqual(await request(), status);
});
