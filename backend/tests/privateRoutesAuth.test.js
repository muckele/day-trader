const test = require('node:test');
const assert = require('node:assert/strict');

const analyticsRouter = require('../routes/analytics');
const executionRouter = require('../routes/execution');
const journalRouter = require('../routes/journal');
const researchRouter = require('../routes/research');
const tradePlanRouter = require('../routes/tradePlan');
const tradingSystemRouter = require('../routes/tradingSystem');

function hasAuthMiddleware(router) {
  return router.stack.some(layer => layer.handle?.name === 'auth');
}

test('private trading routes require authentication middleware', () => {
  [
    analyticsRouter,
    executionRouter,
    journalRouter,
    researchRouter,
    tradePlanRouter,
    tradingSystemRouter
  ].forEach(router => {
    assert.equal(hasAuthMiddleware(router), true);
  });
});
