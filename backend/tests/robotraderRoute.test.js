const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const RoboSettings = require('../models/RoboSettings');
const robotraderRouter = require('../routes/robotrader');

function getRouteHandler(path, method) {
  const layer = robotraderRouter.stack.find(
    item => item.route && item.route.path === path && item.route.methods[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('GET /robotrader/settings returns extended settings payload', async t => {
  t.mock.method(User, 'findOne', async () => ({ _id: 'user-route-1' }));
  t.mock.method(RoboSettings, 'findOne', async () => ({
    isEnabled: false,
    mode: 'paper',
    allowedAssetClasses: ['stocks']
  }));

  const handler = getRouteHandler('/settings', 'get');
  const req = { user: { username: 'matt' } };
  const res = createMockRes();
  let nextErr = null;
  await handler(req, res, err => { nextErr = err; });

  assert.equal(nextErr, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settings.mode, 'paper');
  assert.ok(res.body.capabilities.stocks);
});
