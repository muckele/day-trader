const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const mongoose = require('mongoose');
const { createOrderLifecycle } = require('../services/orderLifecycleService');
const Intent = require('../models/OrderIntent');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const Capacity = require('../models/AccountCapacity');
const Bucket = require('../models/SpendingBucket');
const models = [Intent, BrokerOrder, Fill, Capacity, Bucket,
  require('../models/RoboAuditLog'), require('../models/NotificationOutbox'),
  require('../models/OrderProtection'), require('../models/OrderProtectionLock'), require('../models/PositionClose')];
const ownerId = '507f1f77bcf86cd799439011';
const accountId = 'rc002-fixture-paper';
const dbName = `mvp_test_rc002_${randomUUID().replaceAll('-', '')}`;
const uri = `mongodb://127.0.0.1:27189/${dbName}?replicaSet=mvp&directConnection=true`;
function barrier() {
  let arrive, release;
  return { arrived: new Promise(r => { arrive = r; }), opened: new Promise(r => { release = r; }), arrive, release };
}
function fixture() {
  const orders = new Map(), holdings = new Map();
  let posts = 0, patches = 0, reads = 0, positionBarrier, fillQuantity = null, visible = null;
  const settings = { mode: 'paper', isEnabled: true, dailyLimit: 1000, weeklyLimit: 2000,
    monthlyLimit: 3000, maxTradeAmount: 100, maxPositionSize: 100,
    maxDailyLoss: 100, maxOpenPositions: 5, maxTradesPerDay: 20 };
  const positions = () => [...holdings].filter(([, qty]) => qty > 0)
    .map(([symbol, qty]) => ({ symbol, qty: String(qty), qty_available: String(qty), market_value: String(qty * 10), current_price: '10' }));
  const broker = {
    mode: 'paper',
    getAccount: async () => ({ id: accountId, status: 'ACTIVE', cash: '1000', equity: '1000', last_equity: '1000' }),
    getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
    getPositions: async () => {
      const snapshot = structuredClone(visible === null ? positions() : visible); reads += 1;
      if (positionBarrier && reads === 1) { positionBarrier.arrive(); await positionBarrier.opened; }
      return snapshot;
    },
    listOrders: async ({ status } = {}) => [...orders.values()].filter(o => status !== 'open' || !['filled', 'canceled', 'expired', 'rejected'].includes(o.status)),
    submitOrder: async input => {
      const filled = Math.min(fillQuantity ?? input.qty, input.qty);
      posts += 1; holdings.set(input.symbol, (holdings.get(input.symbol) || 0) + (input.side === 'buy' ? filled : -filled));
      const raw = { id: randomUUID(), client_order_id: input.clientOrderId, symbol: input.symbol, side: input.side,
        qty: String(input.qty), filled_qty: String(filled), filled_avg_price: filled ? '10' : null, limit_price: String(input.limitPrice || 0), type: input.orderType, status: filled === input.qty ? 'filled' : filled ? 'partially_filled' : 'new' };
      orders.set(raw.id, raw); return raw;
    },
    getOrder: async id => orders.get(id),
    getOrderByClientOrderId: async clientId => [...orders.values()].find(o => o.client_order_id === clientId),
    cancelOrder: async id => { orders.get(id).status = 'canceled'; },
    replaceOrder: async (id, input, { authorize } = {}) => {
      if (authorize) await authorize({ payload: input });
      patches += 1;
      const old = orders.get(id); old.status = 'replaced';
      const next = { ...old, id: randomUUID(), client_order_id: input.client_order_id, qty: String(input.qty), limit_price: String(input.limit_price), status: 'partially_filled', replaces: id };
      old.replaced_by = next.id; orders.set(next.id, next); return next;
    }
  };
  return { broker, settings, orders, holdings, positions, get posts() { return posts; }, get patches() { return patches; }, get reads() { return reads; },
    set fillQuantity(value) { fillQuantity = value; }, set visible(value) { visible = value; },
    fill(raw, qty, status = 'filled') {
      holdings.set(raw.symbol, (holdings.get(raw.symbol) || 0) + (qty - Number(raw.filled_qty)) * (raw.side === 'buy' ? 1 : -1));
      Object.assign(raw, { filled_qty: String(qty), filled_avg_price: qty ? '10' : null, status });
    },
    holdFirstPosition() { positionBarrier = barrier(); return positionBarrier; },
    service: () => createOrderLifecycle({ broker, ownerId, expectedAccountId: accountId, strictRisk: true, loadSettings: async () => settings }) };
}
const request = (key, { origin = 'manual', symbol = 'AAPL', qty = 6, side = 'buy' } = {}) => ({
  userId: ownerId, idempotencyKey: key, origin, orderInput: { symbol, side, qty, orderType: side === 'buy' ? 'limit' : 'market', ...(side === 'buy' ? { limitPrice: 10 } : {}) }
});
async function state(f) {
  return { brokerPosts: f.posts, holdings: f.positions(), intents: await Intent.find().select('idempotencyKey status filledQty reservedCents').lean(),
    fills: await Fill.find().select('side qty notionalCents').lean(), capacity: await Capacity.findOne().lean(), buckets: await Bucket.find().lean() };
}

test('RC002 required exposure regressions', { timeout: 45000 }, async t => {
  console.log('RC002_PROVENANCE', JSON.stringify({ node: process.version, executable: process.execPath,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim(),
    lifecycleSha256: createHash('sha256').update(fs.readFileSync(require.resolve('../services/orderLifecycleService'))).digest('hex'), database: dbName }));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await Promise.all(models.map(model => model.init()));
    t.beforeEach(async () => { await Promise.all(models.map(model => model.deleteMany({}))); });
    await t.test('RC002-original-race: captured empty snapshot cannot admit a second $60 into a $100 position', async () => {
      const f = fixture(), service = f.service(), held = f.holdFirstPosition();
      const second = service.submit(request('captured-earlier')).then(value => ({ value }), error => ({ error }));
      await held.arrived;
      try { assert.equal((await service.submit(request('fills-first'))).intent.status, 'filled'); }
      finally { held.release(); }
      const outcome = await second;
      console.log('RC002_ORIGINAL_STATE', JSON.stringify(await state(f)));
      assert.equal(f.posts, 1, 'The captured snapshot must not authorize the second broker POST');
      assert.ok(outcome.error || outcome.value.intent.status === 'rejected');
      assert.equal(f.holdings.get('AAPL'), 6);
      assert.equal(await Fill.countDocuments(), 1);
      const cap = await Capacity.findOne();
      assert.equal(cap.reservedCents, 0); assert.equal(cap.spentCents, 6000);
      for (const b of await Bucket.find()) { assert.equal(b.reservedCents, 0); assert.equal(b.spentCents, 6000); }
    });
    for (const [first, secondOrigin] of [['manual', 'manual'], ['manual', 'robo'], ['robo', 'manual'], ['robo', 'robo']]) {
      await t.test(`RC002-origin-${first}-${secondOrigin}`, async () => {
        const f = fixture(), service = f.service(), held = f.holdFirstPosition();
        const second = service.submit(request('captured', { origin: secondOrigin })).then(v => v, e => e);
        await held.arrived;
        try { await service.submit(request('first', { origin: first })); } finally { held.release(); }
        await second;
        assert.equal(f.posts, 1); assert.equal(f.holdings.get('AAPL'), 6);
        assert.equal(await Fill.countDocuments(), 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
      });
    }
    for (const qty of [6, 2]) {
      await t.test(qty === 6 ? 'RC002-lag-full' : 'RC002-lag-partial', async () => {
        const f = fixture(); f.fillQuantity = qty;
        const service = f.service(); await service.submit(request('fill'));
        f.visible = [];
        for (let n = 0; n < 3; n += 1) await assert.rejects(service.submit(request(`lag-${n}`, { qty: 1 })), /exposure.*reconciliation/i);
        assert.equal(f.posts, 1); assert.equal(await Fill.countDocuments(), 1);
        const cap = await Capacity.findOne();
        assert.equal(cap.spentCents, qty * 1000); assert.equal(cap.reservedCents, (6 - qty) * 1000);
        assert.equal(cap.portfolioObservation.state, 'reconciliation_required');
      });
    }
    for (const status of ['canceled', 'expired']) {
      await t.test(status === 'canceled' ? 'RC002-terminal-cancel' : 'RC002-terminal-expiry', async () => {
        const f = fixture(); f.fillQuantity = 2;
        const service = f.service(), entry = await service.submit(request('partial'));
        f.orders.values().next().value.status = status; f.visible = [];
        const observed = await service.reconcile({ intentId: entry.intent._id });
        assert.equal(observed.intent.filledQty, 2); assert.equal(observed.exposure.state, 'reconciliation_required');
        await assert.rejects(service.submit(request('blocked', { qty: 1 })), /exposure.*reconciliation/i);
        assert.equal((await Capacity.findOne()).reservedCents, 0); assert.equal((await Capacity.findOne()).spentCents, 2000);
        f.visible = null; f.fillQuantity = null;
        assert.equal((await service.reconcile({ intentId: entry.intent._id })).exposure.state, 'coherent');
        await service.submit(request('remaining-eight', { qty: 8 }));
        assert.equal(f.holdings.get('AAPL'), 10); assert.equal(f.posts, 2);
        assert.equal((await Capacity.findOne()).spentCents, 10000);
      });
    }
    await t.test('RC002-headroom', async () => {
      const f = fixture(), service = f.service(), first = await service.submit(request('six'));
      f.visible = [];
      assert.equal((await service.reconcile({ intentId: first.intent._id })).exposure.state, 'reconciliation_required');
      f.visible = null;
      assert.equal((await service.reconcile({ intentId: first.intent._id })).exposure.state, 'coherent');
      await assert.rejects(service.submit(request('five-too-many', { qty: 5 })), /position size/);
      await service.submit(request('four-fit', { qty: 4 }));
      await service.reconcile({ intentId: first.intent._id });
      assert.equal(f.posts, 2); assert.equal(f.holdings.get('AAPL'), 10); assert.equal(await Fill.countDocuments(), 2);
      const cap = await Capacity.findOne();
      assert.equal(cap.portfolioObservation.quantities.AAPL, 10); assert.equal(cap.reservedCents, 0); assert.equal(cap.spentCents, 10000);
      for (const b of await Bucket.find()) { assert.equal(b.spentCents, 10000); assert.equal(b.reservedCents, 0); }
    });
    await t.test('RC002-symbol-slot', async () => {
      const f = fixture(); f.settings.maxOpenPositions = 1;
      const service = f.service(), first = await service.submit(request('AAPL'));
      f.visible = [];
      await assert.rejects(service.submit(request('MSFT-stale', { symbol: 'MSFT', qty: 1 })), /exposure.*reconciliation/i);
      f.visible = null; await service.reconcile({ intentId: first.intent._id });
      await assert.rejects(service.submit(request('MSFT-coherent', { symbol: 'MSFT', qty: 1 })), /open positions/);
      assert.equal(f.posts, 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-retry', async t => {
      const f = fixture(), original = Capacity.findOneAndUpdate;
      let injected = false;
      t.mock.method(Capacity, 'findOneAndUpdate', function(filter, update, options) {
        if (!injected && options?.session && update.$inc?.version) {
          injected = true;
          return (async () => {
            await original.call(this, { accountId }, { $inc: { version: 1 } }, { upsert: true, new: true });
            const error = new mongoose.mongo.MongoServerError({ message: 'Injected transaction conflict', code: 112 });
            error.addErrorLabel('TransientTransactionError'); throw error;
          })();
        }
        return original.call(this, filter, update, options);
      });
      await f.service().submit(request('retry'));
      assert.equal(injected, true); assert.ok(f.reads >= 2, 'Changed snapshot must be collected again after retry');
      assert.equal(f.posts, 1); assert.equal(await Intent.countDocuments(), 1); assert.equal(await Fill.countDocuments(), 1);
      assert.equal((await Capacity.findOne()).spentCents, 6000); assert.equal((await Capacity.findOne()).reservedCents, 0);
    });
    await t.test('RC002-replacement', async () => {
      const f = fixture(); f.fillQuantity = 2;
      const service = f.service(), entry = await service.submit(request('entry'));
      await service.replace({ intentId: entry.intent._id, idempotencyKey: 'reduce', changes: { qty: 5 } });
      const [old, successor] = [...f.orders.values()]; f.fill(successor, 5); f.visible = [];
      const recovered = await service.reconcile({ intentId: entry.intent._id });
      assert.equal(recovered.intent.filledQty, 5); assert.equal(recovered.exposure.state, 'reconciliation_required');
      old.filled_qty = '1'; await service.reconcile({ intentId: entry.intent._id });
      await assert.rejects(service.submit(request('lagged', { qty: 1 })), /exposure.*reconciliation/i);
      assert.equal(await Fill.countDocuments(), 2); assert.equal((await Capacity.findOne()).spentCents, 5000); assert.equal((await Capacity.findOne()).reservedCents, 0);
      f.visible = null; f.fillQuantity = null;
      await service.reconcile({ intentId: entry.intent._id });
      await service.submit(request('headroom', { qty: 5 }));
      assert.equal(f.holdings.get('AAPL'), 10); assert.equal(f.posts, 2); assert.equal((await Capacity.findOne()).spentCents, 10000);
    });
    await t.test('RC002-fill-during-cancel', async () => {
      const f = fixture(); f.fillQuantity = 2;
      const service = f.service(), entry = await service.submit(request('partial'));
      f.broker.cancelOrder = async id => { f.fill(f.orders.get(id), 4, 'canceled'); };
      f.visible = [];
      const canceled = await service.cancel({ intentId: entry.intent._id });
      assert.equal(canceled.intent.filledQty, 4); assert.equal(canceled.exposure.state, 'reconciliation_required');
      await assert.rejects(service.submit(request('blocked')), /exposure.*reconciliation/i);
      assert.equal((await Capacity.findOne()).spentCents, 4000); assert.equal((await Capacity.findOne()).reservedCents, 0);
      f.visible = null; f.fillQuantity = null;
      await service.reconcile({ intentId: entry.intent._id }); await service.submit(request('six-fit'));
      assert.equal(f.holdings.get('AAPL'), 10); assert.equal((await Capacity.findOne()).spentCents, 10000);
    });
    await t.test('RC002-external-conflict', async () => {
      const f = fixture(), service = f.service(); await service.submit(request('owned'));
      // External buy plus a lagging app position can have the same aggregate qty.
      // Complete order discovery must still refuse unaccounted external activity.
      f.orders.set('foreign', { id: 'foreign', client_order_id: 'outside-app', symbol: 'AAPL', side: 'buy', qty: '6', filled_qty: '6', status: 'filled' });
      await assert.rejects(service.submit(request('blocked', { qty: 1 })), /unattributed broker activity/);
      assert.equal(f.posts, 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-close-headroom', async () => {
      const f = fixture(), service = f.service(), entry = await service.submit(request('entry'));
      const close = await service.closePosition({ userId: ownerId, symbol: 'AAPL', idempotencyKey: 'close-all' });
      assert.equal(close.intent.status, 'filled'); assert.equal(f.holdings.get('AAPL'), 0);
      assert.equal((await service.reconcile({ intentId: entry.intent._id })).exposure.state, 'coherent');
      await service.submit(request('new-position', { symbol: 'MSFT' }));
      assert.equal(f.posts, 3); assert.equal(await Fill.countDocuments(), 3);
      assert.equal((await Capacity.findOne()).spentCents, 12000); assert.equal((await Capacity.findOne()).reservedCents, 0);
      for (const b of await Bucket.find()) assert.equal(b.spentCents, 12000, 'A reducing fill does not replenish period spending');
    });
    await t.test('RC002-protection-generations', async () => {
      const f = fixture(), service = f.service();
      const input = request('protected'); input.orderInput.stopLossPrice = 9;
      const entry = await service.submit(input);
      f.fillQuantity = 0;
      const protection = require('../services/orderProtectionService').createOrderProtection({ broker: f.broker, ownerId, expectedAccountId: accountId });
      // Provider stop payload mirrors its actual type/price response contract.
      const submit = f.broker.submitOrder;
      f.broker.submitOrder = async input => {
        const order = await submit(input);
        if (input.orderType === 'stop') order.stop_price = String(input.stopPrice);
        return order;
      };
      const firstStop = await protection.reconcile({ intentId: entry.intent._id });
      assert.equal(firstStop.state, 'protected');
      const raw = f.orders.get(firstStop.brokerOrderId);
      f.fill(raw, 2, 'partially_filled');
      await protection.reconcile({ intentId: entry.intent._id });
      await protection.reconcile({ intentId: entry.intent._id });
      assert.equal(await Fill.countDocuments({ side: 'sell' }), 1);
      raw.status = 'canceled';
      const successor = await protection.reconcile({ intentId: entry.intent._id });
      assert.equal(successor.state, 'protected'); assert.notEqual(successor.brokerOrderId, raw.id);
      f.fill(f.orders.get(successor.brokerOrderId), 4);
      assert.equal((await protection.reconcile({ intentId: entry.intent._id })).state, 'flat');
      assert.equal(await Fill.countDocuments({ side: 'sell' }), 2);
      assert.equal((await service.reconcile({ intentId: entry.intent._id })).exposure.state, 'coherent');
      f.fillQuantity = null;
      await service.submit(request('after-stop', { symbol: 'MSFT' }));
      assert.equal(f.holdings.get('AAPL'), 0); assert.equal(f.holdings.get('MSFT'), 6);
      assert.equal((await Capacity.findOne()).spentCents, 12000);
    });
    await t.test('RC002-invalid-observation', async () => {
      const f = fixture(), service = f.service(); await service.submit(request('entry'));
      for (const visible of [null, [{ symbol: 'AAPL', qty: 'NaN', market_value: '60' }], [{ symbol: 'AAPL', qty: '-1', market_value: '10' }]]) {
        const original = f.broker.getPositions; f.broker.getPositions = async () => visible;
        await assert.rejects(service.submit(request(`bad-${JSON.stringify(visible)}`, { qty: 1 })), /reconciliation/);
        f.broker.getPositions = original;
      }
      assert.equal(f.posts, 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-incomplete-discovery', async () => {
      const f = fixture(), service = f.service(); await service.submit(request('entry'));
      f.broker.listOrders = async () => Array.from({ length: 500 }, (_, i) => ({ id: `outside-${i}`, status: 'filled', symbol: 'MSFT', side: 'buy', qty: '1', filled_qty: '1' }));
      await assert.rejects(service.submit(request('incomplete', { qty: 1 })), /complete order discovery/);
      assert.equal(f.posts, 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-bootstrap-uncovered', async () => {
      const f = fixture(), service = f.service(); await service.submit(request('historical-fill'));
      await Capacity.updateOne({ accountId }, { $unset: { portfolioBaseline: '', portfolioObservation: '' } });
      f.holdings.set('AAPL', 12); f.visible = [{ symbol: 'AAPL', qty: '6', qty_available: '6', market_value: '60' }];
      await assert.rejects(service.submit(request('masked-fill', { qty: 4 })), /reconciliation/);
      assert.equal(f.posts, 1); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-uningested-fill', async () => {
      const f = fixture(); f.fillQuantity = 0;
      const service = f.service(), first = await service.submit(request('canceled-before-fill-observation'));
      await service.cancel({ intentId: first.intent._id });
      f.fill(f.orders.values().next().value, 6); f.visible = []; f.fillQuantity = null;
      await assert.rejects(service.submit(request('late-fill-hidden')), /reconciliation/);
      assert.equal(f.posts, 1);
      await service.reconcile({ intentId: first.intent._id });
      assert.equal((await Capacity.findOne()).spentCents, 6000); assert.equal(await Fill.countDocuments(), 1);
    });
    await t.test('RC002-stale-reducing-quantity', async () => {
      const f = fixture(), service = f.service(); await service.submit(request('buy'));
      const oldPositions = f.positions();
      await service.submit(request('sell-all', { side: 'sell' }));
      f.visible = oldPositions;
      await assert.rejects(service.submit(request('sell-stale', { side: 'sell', qty: 1 })), /available position/);
      assert.equal(f.posts, 2); assert.equal(f.holdings.get('AAPL'), 0);
      assert.equal(await Fill.countDocuments(), 2); assert.equal((await Capacity.findOne()).spentCents, 6000);
    });
    await t.test('RC002-reduce-while-disabled', async () => {
      const f = fixture(); f.fillQuantity = 0;
      const service = f.service(), entry = await service.submit(request('robo', { origin: 'robo' }));
      f.settings.isEnabled = false;
      const reduced = await service.replace({ intentId: entry.intent._id, idempotencyKey: 'reduce', changes: { qty: 5, limitPrice: 9 } });
      assert.equal(f.patches, 1); assert.equal(reduced.intent.qty, 5); assert.equal(reduced.intent.limitPrice, 9);
      assert.equal(reduced.intent.replacement.status, 'acknowledged'); assert.equal((await Capacity.findOne()).reservedCents, 6000);
    });
    await t.test('RC002-emergency-supersedes-replacement', async () => {
      const f = fixture(); f.fillQuantity = 0;
      const service = f.service(), entry = await service.submit(request('robo', { origin: 'robo' }));
      await Intent.updateOne({ _id: entry.intent._id }, { $set: { stopCancelRequested: true } });
      f.settings.isEnabled = false;
      const result = await service.replace({ intentId: entry.intent._id, idempotencyKey: 'after-stop', changes: { qty: 5 } });
      assert.equal(f.patches, 0); assert.match(result.intent.rejectionReason, /supersedes replacement/);
      assert.equal((await Capacity.findOne()).reservedCents, 6000); assert.equal(await Fill.countDocuments(), 0);
    });
  } finally {
    if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
