const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Intent = require('../models/OrderIntent');
const Protection = require('../models/OrderProtection');
const Outbox = require('../models/NotificationOutbox');
const Lock = require('../models/OrderProtectionLock');
const { createOrderProtection, withProtectionAccountLock } = require('../services/orderProtectionService');
const { randomUUID } = require('node:crypto');
test('durable partial-fill protection against real Mongo', async t => {
  await mongoose.connect(`mongodb://127.0.0.1:27189/mvp_test_protection_${randomUUID().replaceAll('-', '')}?replicaSet=mvp&directConnection=true`, { serverSelectionTimeoutMS: 3000 });
  await Promise.all([Intent.init(), Protection.init(), Lock.init(), Outbox.init()]);
  const ownerId = new mongoose.Types.ObjectId().toString();
  let n = 0;
  async function fixture() {
    const accountId = `protection-fixture-${process.pid}-${++n}`;
    const intent = await Intent.create({ userId: ownerId, accountId, environment: 'paper',
      executionSource: 'alpaca-paper', idempotencyKey: `entry-${n}`, broker: 'alpaca', origin: 'robotrader',
      symbol: 'AAPL', side: 'buy', qty: 10, status: 'partially_filled', filledQty: 4,
      orderInput: { riskStopPrice: 90 } });
    const orders = new Map(), writes = [], audits = [];
    let positionQty = 4, fail = false, hidden = false;
    const broker = { mode: 'paper', getAccount: async () => ({ id: accountId }),
      getPositions: async () => [{ symbol: 'AAPL', qty: positionQty }],
      listOrders: async () => [...orders.values()].filter(o => !['canceled','filled','rejected'].includes(o.status)),
      getOrder: async id => orders.get(id),
      getOrderByClientOrderId: async id => hidden ? null : [...orders.values()].find(o => o.client_order_id === id),
      cancelOrder: async id => { writes.push(['cancel', id]); orders.get(id).status = 'canceled'; },
      submitOrder: async input => {
        const order = { id: `stop-${orders.size+1}`, client_order_id: input.clientOrderId,
          symbol: 'AAPL', side: 'sell', type: 'stop', stop_price: input.stopPrice, qty: input.qty, filled_qty: 0, status: 'new' };
        writes.push(['submit', input.qty]); orders.set(order.id, order);
        if (fail) throw new Error('accepted then timeout');
        return { order };
      } };
    const service = () => createOrderProtection({ broker, ownerId, expectedAccountId: accountId, Audit: { create: async a => audits.push(a) } });
    return { intent, broker, orders, writes, audits, service, setPosition: q => { positionQty=q; }, setFail: v => { fail=v; }, setHidden: v => { hidden=v; } };
  }
  try {
    await t.test('4 + 6 fills cancel-confirm-expand one stop; duplicate/concurrent reconcile does not duplicate', async () => {
      const f = await fixture();
      await Promise.all([f.service().reconcile({ intentId:f.intent._id }),f.service().reconcile({ intentId:f.intent._id })]);
      assert.deepEqual(f.writes, [['submit',4]]);
      f.intent.filledQty=10; await f.intent.save(); f.setPosition(10);
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).state, 'cancel_pending');
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).confirmedQty, 10);
      await f.service().reconcile({intentId:f.intent._id});
      assert.deepEqual(f.writes.map(x=>x[0]), ['submit','cancel','submit']);
      assert.equal([...f.orders.values()].filter(o=>o.status==='new').length,1);
    });
    await t.test('4 + canceled remainder preserves four-share protection', async () => {
      const f=await fixture(); await f.service().reconcile({intentId:f.intent._id});
      f.intent.status='canceled'; await f.intent.save();
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).confirmedQty,4);
      assert.equal(f.writes.length,1);
    });
    await t.test('accepted timeout, lookup miss and restart never duplicate; blocks new risk until confirmation', async () => {
      const f=await fixture(); f.setFail(true); f.setHidden(true);
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).state,'uncertain');
      await assert.rejects(f.service().assertProtected(), /protection is unresolved/);
      await f.service().reconcile({intentId:f.intent._id}); assert.equal(f.writes.length,1);
      f.setHidden(false); await f.service().assertProtected(); assert.equal(f.writes.length,1);
      assert.ok(f.audits.some(a=>a.payload.state==='uncertain'));
      assert.ok(await Outbox.exists({ accountId:f.intent.accountId, subject:/uncertain/ }));
    });
    await t.test('manual requested stop is maintained; held stop never counts as protected', async () => {
      const f=await fixture(); f.intent.origin='manual'; f.intent.orderInput={stopLossPrice:90}; await f.intent.save();
      await f.service().reconcile({intentId:f.intent._id});
      [...f.orders.values()][0].status='held';
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).state,'cancel_pending');
      assert.equal((await Intent.findById(f.intent._id)).protectionState.confirmedQty,0);
    });
    await t.test('manual exits share account lease and confirmed protective reservations', async () => {
      const f=await fixture();
      await withProtectionAccountLock({accountId:f.intent.accountId,symbol:'AAPL'}, async assertLease => {
        await assertLease();
        assert.equal((await f.service().reconcile({intentId:f.intent._id})).state,'busy');
        assert.equal(f.writes.length,0);
      });
      await f.service().reconcile({intentId:f.intent._id});
      await assert.rejects(withProtectionAccountLock({accountId:f.intent.accountId,symbol:'AAPL'},async()=>{}),/reserve this position/);
    });
    await t.test('nested exits and pending manual sells cannot be oversubscribed by stops', async () => {
      const f=await fixture();
      f.broker.listOrders=async()=>[{id:'parent',symbol:'AAPL',side:'buy',legs:[{id:'leg',symbol:'AAPL',side:'sell',qty:'3',filled_qty:'0'}]}];
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).confirmedQty,1);
      const g=await fixture();
      await Intent.create({userId:ownerId,accountId:g.intent.accountId,executionSource:'alpaca-paper',environment:'paper',
        broker:'alpaca',origin:'manual',idempotencyKey:'pending-exit',symbol:'AAPL',side:'sell',qty:4,status:'submission_uncertain'});
      assert.equal((await g.service().reconcile({intentId:g.intent._id})).state,'unprotected');
      assert.equal(g.writes.length,0);
    });
    await t.test('reduced broker position caps the new exit and resizes existing exit', async () => {
      const f=await fixture(); f.setPosition(2);
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).confirmedQty,2);
      f.setPosition(1); await f.service().reconcile({intentId:f.intent._id});
      assert.equal((await f.service().reconcile({intentId:f.intent._id})).confirmedQty,1);
      assert.deepEqual(f.writes.filter(x=>x[0]==='submit'),[['submit',2],['submit',1]]);
    });
  } finally {
    const filter={userId:ownerId};
    const docs=await Protection.find(filter); await Outbox.deleteMany({ accountId:{$in:docs.map(d=>d.accountId)} }); await Lock.deleteMany({ accountId:{$in:docs.map(d=>d.accountId)} });
    await Protection.deleteMany(filter); await Intent.deleteMany(filter); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
