const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),mongoose=require('mongoose');
const {createOrderLifecycle}=require('../services/orderLifecycleService');
const Intent=require('../models/OrderIntent'),Fill=require('../models/Fill'),BrokerOrder=require('../models/BrokerOrder'),Capacity=require('../models/AccountCapacity'),Bucket=require('../models/SpendingBucket');
const ownerId='507f1f77bcf86cd799439011',accountId='fractional-controlled';
const models=[Intent,Fill,BrokerOrder,Capacity,Bucket,require('../models/PositionClose'),require('../models/OrderProtection'),require('../models/OrderProtectionLock'),require('../models/RoboAuditLog'),require('../models/NotificationOutbox')];
function fixture(){
 let positions=[],posts=0;const orders=[];
 const broker={mode:'paper',getAccount:async()=>({id:accountId,status:'ACTIVE',cash:'10000',equity:'10000',last_equity:'10000'}),getClock:async()=>({is_open:true,timestamp:new Date().toISOString()}),getAsset:async()=>({symbol:'AAPL',class:'us_equity',status:'active',tradable:true,fractionable:true}),getPositions:async()=>structuredClone(positions),listOrders:async({status}={})=>orders.filter(o=>status!=='open'||!['filled','canceled'].includes(o.status)),submitOrder:async x=>{posts++;const o={id:randomUUID(),client_order_id:x.clientOrderId,symbol:x.symbol,side:x.side,type:x.orderType,qty:String(x.qty),filled_qty:'0',status:'new'};orders.push(o);return o;},getOrder:async id=>orders.find(o=>o.id===id),getOrderByClientOrderId:async id=>orders.find(o=>o.client_order_id===id),cancelOrder:async id=>{orders.find(o=>o.id===id).status='canceled';}};
 const settings={mode:'paper',dailyLimit:1000,weeklyLimit:2000,monthlyLimit:3000,maxTradeAmount:250,maxPositionSize:250,maxDailyLoss:500,maxOpenPositions:5,maxTradesPerDay:20};
 return {broker,orders,get posts(){return posts;},set positions(p){positions=p;},service:()=>createOrderLifecycle({broker,ownerId,expectedAccountId:accountId,loadSettings:async()=>settings,strictRisk:true}),observe(o,q,status='partially_filled'){Object.assign(o,{filled_qty:q,filled_avg_price:'10.00',status});positions=q==='0'?[]:[{symbol:'AAPL',qty:q,qty_available:q,market_value:String(Number(q)*10)}];}};
}
const request=key=>({userId:ownerId,idempotencyKey:key,origin:'manual',orderInput:{symbol:'AAPL',side:'buy',qty:1,orderType:'limit',limitPrice:10}});
test('fractional canonical execution safety',{timeout:60000},async t=>{
 const base=process.env.FRACTIONAL_TEST_MONGO_BASE||'mongodb://127.0.0.1:27189';const repl=process.env.FRACTIONAL_TEST_REPLICA||'mvp';assert.match(base,/^mongodb:\/\/127\.0\.0\.1:\d+$/);assert.ok(['mvp','local-apps'].includes(repl));
 const db='mvp_test_fractional_'+randomUUID().replaceAll('-','');await mongoose.connect(`${base}/${db}?replicaSet=${repl}&directConnection=true`,{serverSelectionTimeoutMS:3000});
 try{await Promise.all(models.map(m=>m.init()));t.beforeEach(async()=>{await Promise.all(models.map(m=>m.deleteMany({})));});
 await t.test('fractional broker fill accepted',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('fraction'));f.observe(f.orders[0],'0.5');const out=await s.reconcile({intentId:r.intent._id});assert.equal(out.intent.filledQty,'0.5');assert.equal((await Fill.findOne()).qty,'0.5');assert.equal((await Capacity.findOne()).spentCents,500);});
 await t.test('cumulative fractional fill idempotency',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('sequence'));for(const q of ['0.1','0.100000000','0.3','0.2','1.00']){f.observe(f.orders[0],q,q==='1.00'?'filled':'partially_filled');await s.reconcile({intentId:r.intent._id});}assert.equal(await Fill.countDocuments(),3);assert.deepEqual((await Fill.find().sort({createdAt:1})).map(x=>x.qty),['0.1','0.2','0.7']);assert.equal((await Capacity.findOne()).spentCents,1000);});
 await t.test('partial-fill remainder cancellation',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('cancel'));f.observe(f.orders[0],'0.4');await s.reconcile({intentId:r.intent._id});await s.cancel({intentId:r.intent._id});assert.equal((await Intent.findOne()).filledQty,'0.4');assert.equal((await Intent.findOne()).status,'canceled');assert.equal((await Capacity.findOne()).spentCents,400);assert.equal((await Capacity.findOne()).reservedCents,0);assert.equal(await Fill.countDocuments(),1);});
 await t.test('fractional exposure delayed-position coverage',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('hidden'));f.observe(f.orders[0],'0.5');f.positions=[];const out=await s.reconcile({intentId:r.intent._id});assert.equal(out.exposure.state,'reconciliation_required');await assert.rejects(s.submit(request('blocked')),e=>e.code==='EXPOSURE_UNRESOLVED');assert.equal(f.posts,1);assert.equal((await Capacity.findOne()).spentCents,500);});
 await t.test('fractional position coverage no double count',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('coverage'));f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});f.positions=[{symbol:'AAPL',qty:'0.500000000',qty_available:'0.500000000',market_value:'5'}];const out=await s.reconcile({intentId:r.intent._id});assert.equal(out.exposure.state,'coherent',JSON.stringify(out.exposure));assert.equal(out.exposure.quantities.AAPL,'0.5');assert.equal(await Fill.countDocuments(),1);});
 await t.test('fractional exact reduce-only cleanup',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('close'));f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});await s.cancel({intentId:r.intent._id});const closed=await s.closePosition({userId:ownerId,idempotencyKey:'exact-close',symbol:'AAPL',qty:'0.5'});assert.ok(closed.intent,JSON.stringify(closed));assert.equal(closed.intent.qty,'0.5');assert.equal(f.posts,2);assert.equal(f.orders[1].qty,'0.5');Object.assign(f.orders[1],{filled_qty:'0.5',filled_avg_price:'10',status:'filled'});f.positions=[];const final=await s.reconcile({intentId:closed.intent._id});assert.equal(final.exposure.state,'coherent',JSON.stringify(final.exposure));assert.deepEqual(final.exposure.quantities,{});assert.equal(await Fill.countDocuments(),2);});
 await t.test('fractional over-close rejection',async()=>{const f=fixture();f.positions=[{symbol:'AAPL',qty:'0.4',qty_available:'0.4',market_value:'4'}];const r=await f.service().closePosition({userId:ownerId,idempotencyKey:'over',symbol:'AAPL',qty:'0.5'}).catch(e=>e);assert.equal(f.posts,0);assert.ok(r.close?.error||r.code);});

 await t.test('fractional protection remains explicitly unprotected without a GTC fractional stop',async()=>{const f=fixture(),s=f.service(),r=await s.submit({...request('protected'),orderInput:{...request('protected').orderInput,stopLossPrice:9}});f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});const protection=require('../services/orderProtectionService').createOrderProtection({broker:f.broker,ownerId,expectedAccountId:accountId});const out=await protection.reconcile({intentId:r.intent._id});assert.equal(out.state,'unprotected');assert.match(out.error,/fractional/i);assert.equal(f.posts,1);});
 await t.test('fractional cleanup rejects non-fractionable assets without rounding',async()=>{const f=fixture();f.positions=[{symbol:'AAPL',qty:'0.5',qty_available:'0.5',market_value:'5'}];f.broker.getAsset=async()=>({symbol:'AAPL',class:'us_equity',status:'active',tradable:true,fractionable:false});const r=await f.service().closePosition({userId:ownerId,idempotencyKey:'asset',symbol:'AAPL',qty:'0.5'});assert.match(r.close.error,/fractionable/);assert.equal(f.posts,0);});
 for(const q of ['-0.1','1.000000001','0.0000000001','bad'])await t.test('invalid broker cumulative quantity '+q,async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('invalid'));f.observe(f.orders[0],q);await assert.rejects(s.reconcile({intentId:r.intent._id}));assert.equal(await Fill.countDocuments(),0);assert.equal((await Capacity.findOne()).reservedCents,1000);});
 await t.test('fractional canonical Fill index collapses equivalent cumulative formatting',async()=>{const f=fixture(),s=f.service(),r=await s.submit(request('key'));f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});const original=(await Fill.findOne()).toObject();delete original._id;await assert.rejects(Fill.create({...original,cumulativeQty:'0.500000000'}),e=>e.code===11000);assert.equal(await Fill.countDocuments(),1);});
 await t.test('no duplicate POST during fractional recovery',async()=>{const f=fixture(),original=f.broker.submitOrder;f.broker.submitOrder=async x=>{const o=await original(x);f.observe(o,'0.5');throw Error('controlled accepted response lost');};const first=await f.service().submit(request('recovery'));assert.equal(first.intent.status,'submission_uncertain');await f.service().reconcile({intentId:first.intent._id});await f.service().submit(request('recovery'));assert.equal(f.posts,1);assert.equal(await Fill.countDocuments(),1);assert.equal((await Capacity.findOne()).spentCents,500);});

 await t.test('fractional cumulative spending is independent of intermediate observations',async()=>{
  const totals=[];
  for(const sequence of [['0.1','0.3','1'],['1']]){
   await Promise.all(models.map(m=>m.deleteMany({})));const f=fixture(),s=f.service(),r=await s.submit(request('rounding'));
   for(const q of sequence){f.observe(f.orders[0],q,q==='1'?'filled':'partially_filled');f.orders[0].filled_avg_price='0.01';await s.reconcile({intentId:r.intent._id});}
   totals.push((await Capacity.findOne()).spentCents);assert.equal((await Fill.find()).reduce((n,f)=>n+f.notionalCents,0),1);assert.equal((await Intent.findOne()).filledNotionalCents,1);
  }assert.deepEqual(totals,[1,1]);
 });
 await t.test('manual and Robo fractional opening authority cannot be spoofed',async()=>{
  const f=fixture(),s=f.service();for(const origin of ['manual','robotrader','manual-close'])for(const side of ['buy','sell'])await assert.rejects(s.submit({...request(origin+side),origin,reduceOnly:true,orderInput:{...request('x').orderInput,side,qty:'0.5',reduceOnly:true}}),/whole share/);
  assert.equal(f.posts,0);assert.equal(await Intent.countDocuments(),0);
 });

 await t.test('manual API rejects fractional opening through the canonical lifecycle',async()=>{
  const f=fixture(),module=require('../services/orderLifecycleService'),original=module.getOrderLifecycle,prior=process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;
  module.getOrderLifecycle=()=>f.service();process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA='true';
  try{
   const route=require('../routes/trade').stack.find(x=>x.route?.path==='/execute').route.stack.at(-1).handle;
   for(const qty of ['0.5','1.000000001']){let status,body;const res={status(n){status=n;return this;},json(value){body=value;return this;}};
    await route({body:{symbol:'AAPL',side:'buy',qty,orderType:'limit',limitPrice:10},user:{userId:ownerId},get:()=> 'api-fraction-'+qty},res,()=>assert.fail('unexpected middleware continuation'));
    assert.equal(status,400);assert.match(body.error,/whole share/);
   }assert.equal(f.posts,0);assert.equal(await Intent.countDocuments(),0);
  }finally{module.getOrderLifecycle=original;if(prior===undefined)delete process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA;else process.env.APP_PAPER_TRADES_SYNC_TO_ALPACA=prior;}
 });
 await t.test('fractional partial reduction preserves the exact remaining owned position',async()=>{
  const f=fixture(),s=f.service();f.positions=[{symbol:'AAPL',qty:'1.5',qty_available:'1.5',market_value:'15'}];const baseline=await s.submit(request('baseline'));await s.cancel({intentId:baseline.intent._id});
  const closed=await s.closePosition({userId:ownerId,idempotencyKey:'reduce-half',symbol:'AAPL',qty:'0.5'});assert.ok(closed.intent,JSON.stringify(closed));assert.equal(f.orders[1].qty,'0.5');
  Object.assign(f.orders[1],{filled_qty:'0.5',filled_avg_price:'10',status:'filled'});f.positions=[{symbol:'AAPL',qty:'1',qty_available:'1',market_value:'10'}];const out=await s.reconcile({intentId:closed.intent._id});assert.equal(out.exposure.state,'coherent');assert.deepEqual(out.exposure.quantities,{AAPL:1});
 });
 await t.test('external fractional baseline retains 17.582774 without fabricating fills',async()=>{
  const f=fixture();f.positions=[{symbol:'AAPL',qty:'17.582774',qty_available:'17.582774000',market_value:'175.82774'}];await f.service().submit(request('external-baseline'));
  assert.equal((await Capacity.findOne()).portfolioBaseline.quantities.AAPL,'17.582774');assert.equal(await Fill.countDocuments(),0);
 });
 await t.test('concurrent equivalent fractional cumulative reconciliation persists one fill',async()=>{
  const f=fixture(),s=f.service(),r=await s.submit(request('concurrent'));f.observe(f.orders[0],'0.500000000');await Promise.all([s.reconcile({intentId:r.intent._id}),f.service().reconcile({intentId:r.intent._id})]);
  f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});assert.equal(await Fill.countDocuments(),1);assert.equal((await Fill.findOne()).cumulativeQty,'0.5');assert.equal((await Capacity.findOne()).spentCents,500);
 });
 await t.test('conflicting fractional position coverage blocks opening risk',async()=>{
  const f=fixture(),s=f.service(),r=await s.submit(request('conflict'));f.observe(f.orders[0],'0.5');await s.reconcile({intentId:r.intent._id});f.positions=[{symbol:'AAPL',qty:'0.6',qty_available:'0.6',market_value:'6'}];
  const out=await s.reconcile({intentId:r.intent._id});assert.equal(out.exposure.state,'reconciliation_required');await assert.rejects(s.submit(request('conflict-block')),e=>e.code==='EXPOSURE_UNRESOLVED');assert.equal(f.posts,1);assert.equal(await Fill.countDocuments(),1);
 });
 await t.test('fractional position flip and invalid reducing quantities are rejected',async()=>{
  const f=fixture(),s=f.service();f.positions=[{symbol:'AAPL',qty:'0.4',qty_available:'0.4',market_value:'4'}];
  for(const qty of ['0','-0.1','0.0000000001'])await assert.rejects(s.closePosition({userId:ownerId,idempotencyKey:'invalid-'+qty,symbol:'AAPL',qty}));
  const out=await s.closePosition({userId:ownerId,idempotencyKey:'flip',symbol:'AAPL',qty:'0.8'});assert.match(out.close.error,/exceeds exact owned/);assert.equal(f.posts,0);assert.equal(await Intent.countDocuments(),0);
 });
 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
