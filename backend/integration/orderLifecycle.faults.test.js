const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { createOrderLifecycle } = require('../services/orderLifecycleService');
const Intent = require('../models/OrderIntent');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const Bucket = require('../models/SpendingBucket');
const Capacity = require('../models/AccountCapacity');
const models = [Intent, BrokerOrder, Fill, Bucket, Capacity];
const ownerId = '507f1f77bcf86cd799439011';
const uri = `mongodb://127.0.0.1:27189/mvp_test_faults_${randomUUID().replaceAll('-', '')}?directConnection=true&replicaSet=mvp`;
function fixture({ failure, missing = false } = {}) {
  let posts = 0;
  let instant = new Date('2026-09-14T15:00:00Z');
  const orders = new Map();
  const absent = () => { throw Object.assign(new Error('not found'), { response: { status: 404 } }); };
  const broker = {
    mode: 'paper', getAccount: async () => ({ id: 'fixture-paper', cash: '1000.00' }),
    getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
    getPositions: async () => [],
    submitOrder: async input => {
      posts += 1;
      const order = { id: randomUUID(), client_order_id: input.clientOrderId, symbol: input.symbol, side: input.side, qty: String(input.qty), filled_qty: '0', status: 'new' };
      orders.set(order.id, order);
      if (failure) throw failure;
      return order;
    },
    getOrder: async id => orders.get(id) || absent(),
    getOrderByClientOrderId: async clientId => missing ? absent() : [...orders.values()].find(order => order.client_order_id === clientId) || absent()
  };
  return { broker, orders, get posts() { return posts; }, setTime(value) { instant = new Date(value); }, service: (overrides = {}) => createOrderLifecycle({ broker, ownerId, expectedAccountId: 'fixture-paper', now: () => instant, loadSettings: async () => ({ mode: 'paper', dailyLimit: 100, weeklyLimit: 200, monthlyLimit: 300 }), ...overrides }) };
}
const request = () => ({ userId: ownerId, idempotencyKey: 'stable-user-request', orderInput: { symbol: 'AAPL', side: 'buy', qty: 6, orderType: 'limit', limitPrice: 10 } });
test('real Mongo lifecycle fault boundaries', async t => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await Promise.all(models.map(model => model.init()));
    const reset = () => Promise.all(models.map(model => model.deleteMany({})));
    await t.test('HTTP 500 after acceptance recovers same broker order across restart', async () => {
      await reset();
      const f = fixture({ failure: Object.assign(new Error('upstream 500'), { response: { status: 500 } }) });
      const uncertain = await f.service().submit(request());
      assert.equal(uncertain.intent.status, 'submission_uncertain');
      const recovered = await f.service().reconcile({ intentId: uncertain.intent._id });
      assert.equal(recovered.intent.status, 'acknowledged');
      await f.service().submit(request());
      assert.equal(f.posts, 1);
      assert.equal(await BrokerOrder.countDocuments(), 1);
      assert.equal((await Capacity.findOne()).reservedCents, 6000);
    });
    await t.test('uncertainty window expiry requires reconciliation without releasing or reposting', async () => {
      await reset();
      const f = fixture({ failure: new Error('timeout after acceptance'), missing: true });
      const out = await f.service().submit(request());
      f.setTime('2026-09-14T15:06:00Z');
      const expired = await f.service().reconcile({ intentId: out.intent._id });
      assert.equal(expired.intent.status, 'reconciliation_required');
      await f.service().submit(request());
      assert.equal(f.posts, 1);
      assert.equal((await Capacity.findOne()).reservedCents, 6000);
    });
    await t.test('database intent failure prevents any broker submission', async t => {
      await reset();
      const f = fixture();
      t.mock.method(Intent, 'create', async () => { throw new Error('fixture database persistence failure'); });
      await assert.rejects(f.service().submit(request()), /database persistence failure/);
      assert.equal(f.posts, 0);
      assert.equal(await Capacity.countDocuments(), 0);
    });
    await t.test('replacement cannot increase exposure or mutate protective terms', async () => {
      for (const changes of [{ qty: 7 }, { limitPrice: 11 }, { stopLossPrice: 1 }, { timeInForce: 'gtc' }]) {
        await reset();
        const f = fixture();
        let patches = 0;
        f.broker.replaceOrder = async () => { patches += 1; throw new Error('unexpected broker PATCH'); };
        const out = await f.service().submit(request());
        await assert.rejects(f.service().replace({ intentId: out.intent._id, idempotencyKey: 'unsafe-replacement', changes }));
        assert.equal(patches, 0);
        assert.equal((await Capacity.findOne()).reservedCents, 6000);
      }
    });
    await t.test('accepted replacement retains reservation after downstream broker-context 403', async () => {
      await reset();
      const f = fixture();
      const out = await f.service().submit(request());
      f.broker.replaceOrder = async (id, terms) => {
        const old = f.orders.get(id);
        const successor = { ...old, id: randomUUID(), qty: String(terms.qty), client_order_id: terms.client_order_id, status: 'new' };
        old.status = 'canceled';
        f.orders.set(successor.id, successor);
        return successor;
      };
      const downstreamFailure = async () => { throw Object.assign(new Error('protection account context forbidden'), { response: { status: 403 } }); };
      const replaced = await f.service({ afterReconcile: downstreamFailure }).replace({ intentId: out.intent._id, idempotencyKey: 'reduce', changes: { qty: 5 } });
      assert.notEqual(replaced.intent.replacement.status, 'rejected');
      await f.service().reconcile({ intentId: out.intent._id });
      assert.equal((await Capacity.findOne()).reservedCents, 6000);
    });
    await t.test('low limit price cannot undervalue existing position for size limits', async () => {
      await reset();
      const f = fixture();
      f.broker.getPositions = async () => [{ symbol: 'AAPL', qty: '1', market_value: '200.00', current_price: '200.00' }];
      const service = f.service({ loadSettings: async () => ({ mode: 'paper', dailyLimit: 100, weeklyLimit: 200, monthlyLimit: 300, maxPositionSize: 100 }) });
      await assert.rejects(service.submit(request()), /position/i);
      assert.equal(f.posts, 0);
    });
    await t.test('manual entries block exactly at daily loss threshold', async () => {
      await reset();
      const f = fixture();
      f.broker.getAccount = async () => ({ id: 'fixture-paper', cash: '1000.00', equity: '950.00', last_equity: '1000.00' });
      const service = f.service({ loadSettings: async () => ({ mode: 'paper', dailyLimit: 100, weeklyLimit: 200, monthlyLimit: 300, maxDailyLoss: 50 }) });
      await assert.rejects(service.submit(request()), /Daily loss threshold/);
      assert.equal(f.posts, 0);
    });
    await t.test('fractional-cent broker average fills persist without duplicate spend', async () => {
      await reset();
      const f = fixture();
      const out = await f.service().submit(request());
      Object.assign([...f.orders.values()][0], { status: 'filled', filled_qty: '6', filled_avg_price: '9.876543' });
      await f.service().reconcile({ intentId: out.intent._id });
      await f.service().reconcile({ intentId: out.intent._id });
      assert.equal(await Fill.countDocuments(), 1);
      assert.equal((await Bucket.findOne({ period: 'day' })).spentCents, 5926);
      assert.equal((await Capacity.findOne()).reservedCents, 0);
    });
  } finally {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
