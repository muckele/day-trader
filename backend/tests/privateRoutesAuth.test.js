const test = require('node:test');
const assert = require('node:assert/strict');

const analyticsRouter = require('../routes/analytics');
const backtestRouter = require('../routes/backtest');
const debugRouter = require('../routes/debug');
const executionRouter = require('../routes/execution');
const journalRouter = require('../routes/journal');
const recommendRouter = require('../routes/recommend');
const researchRouter = require('../routes/research');
const tradePlanRouter = require('../routes/tradePlan');
const tradingSystemRouter = require('../routes/tradingSystem');

function hasAuthMiddleware(router) {
  return router.stack.some(layer => layer.handle?.name === 'auth');
}

test('private trading routes require authentication middleware', () => {
  [
    analyticsRouter,
    backtestRouter,
    debugRouter,
    executionRouter,
    journalRouter,
    recommendRouter,
    researchRouter,
    tradePlanRouter,
    tradingSystemRouter
  ].forEach(router => {
    assert.equal(hasAuthMiddleware(router), true);
  });
});
