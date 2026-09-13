const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('../routes/analytics');
const journal = require('../routes/journal');
const PaperTrade = require('../models/PaperTrade');
const PaperOrder = require('../models/PaperOrder');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const PaperJournalEntry = require('../models/PaperJournalEntry');
const chain = rows => ({ sort: () => ({ lean: async () => rows }), lean: async () => rows });
async function invoke(router, path) {
  let body;
  const handler = router.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
  await handler({ user: { id: 'owner' }, query: { range: 'all' } }, { json: value => { body = value; } }, err => { throw err; });
  return body;
}
test('simulator execution quality never substitutes Alpaca telemetry', async t => {
  const mixed = [{ broker: 'paper', status: 'filled', realizedPnl: 3 }, { broker: 'alpaca', status: 'rejected', realizedPnl: 900 }];
  t.mock.method(PaperOrder, 'find', q => chain(mixed.filter(row => row.broker === q.broker)));
  t.mock.method(PaperTrade, 'find', q => chain(mixed.filter(row => row.broker === q.broker)));
  t.mock.method(BrokerOrder, 'find', () => { throw new Error('Alpaca telemetry must not feed simulator analytics'); });
  t.mock.method(Fill, 'find', () => { throw new Error('Alpaca fills must not feed simulator analytics'); });
  const result = await invoke(analytics, '/execution-quality');
  assert.equal(result.executionSource, 'local-simulation');
  assert.equal(result.counts.filledOrders, 1);
  assert.equal(result.counts.rejectedOrders, 0);
  assert.equal(result.pnlBySetup[0].totalPnl, 3);
});
test('simulator strategy performance excludes Alpaca realized P&L', async t => {
  t.mock.method(PaperTrade, 'find', query => {
    assert.equal(query.broker, 'paper');
    return chain([]);
  });
  const result = await invoke(analytics, '/strategies');
  assert.equal(result.executionSource, 'local-simulation');
});
test('journal listing selects only simulator trades and labels results', async t => {
  t.mock.method(PaperTrade, 'find', query => {
    assert.equal(query.broker, 'paper');
    return chain([{ _id: 'simulator', symbol: 'AAPL' }]);
  });
  t.mock.method(PaperJournalEntry, 'find', query => {
    assert.deepEqual(query.tradeId.$in, ['simulator']);
    return chain([{ tradeId: 'simulator' }]);
  });
  const result = await invoke(journal, '/');
  assert.equal(result[0].executionSource, 'local-simulation');
});
test('simulator snapshots exclude legacy equity with unknown execution source', async t => {
  const PaperEquity = require('../models/PaperEquity');
  const PaperGuardrailEvent = require('../models/PaperGuardrailEvent');
  t.mock.method(PaperTrade, 'find', query => { assert.equal(query.broker, 'paper'); return chain([]); });
  t.mock.method(PaperEquity, 'find', query => { assert.equal(query.executionSource, 'local-simulation'); return chain([]); });
  t.mock.method(PaperGuardrailEvent, 'countDocuments', async () => 0);
  const result = await invoke(analytics, '/snapshot');
  assert.equal(result.executionSource, 'local-simulation');
});
test('journal cannot read or write an Alpaca trade through a simulator ID route', async t => {
  t.mock.method(PaperTrade, 'findOne', query => {
    assert.equal(query.broker, 'paper');
    assert.equal(query._id, 'broker-trade');
    return chain(null);
  });
  t.mock.method(PaperJournalEntry, 'findOneAndUpdate', () => { throw new Error('must not write'); });
  t.mock.method(PaperJournalEntry, 'findOne', () => { throw new Error('must not read'); });
  for (const method of ['get', 'put']) {
    let status;
    const handler = journal.stack.find(layer => layer.route?.path === '/:tradeId' && layer.route.methods[method]).route.stack[0].handle;
    await handler({ user: { id: 'owner' }, params: { tradeId: 'broker-trade' } }, { status: code => { status = code; return { json() {} }; } }, err => { throw err; });
    assert.equal(status, 404);
  }
});
