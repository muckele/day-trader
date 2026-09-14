const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mongoose=require('mongoose');
const axios=require('axios');
const {createProvider}=require('../../scripts/acceptance/provider.cjs');
const {run}=require('../scripts/external-paper-acceptance');
const Intent=require('../models/OrderIntent'),Fill=require('../models/Fill'),Capacity=require('../models/AccountCapacity'),Settings=require('../models/RoboSettings');
const {getOrderLifecycle}=require('../services/orderLifecycleService');
const {createAlpacaBroker}=require('../robotrader/alpacaBroker');
const owner='507f1f77bcf86cd799439011';
const baseOptions={'authorize-external-paper-test':true,'paper-origin':'https://paper-api.alpaca.markets',candidate:'a'.repeat(40),'symbol-allowlist':'AAPL,MSFT,NVDA','max-notional':'100','fill-limit-price':'100',quantity:'1'};
const baseline=[{symbol:'AAPL',qty:'2',avg_entry_price:'100',market_value:'200'},{symbol:'GOOG',qty:'3',avg_entry_price:'100',market_value:'300'}];
const models=[Intent,Fill,Capacity,Settings,require('../models/BrokerOrder'),require('../models/SpendingBucket'),require('../models/OrderProtection'),require('../models/OrderProtectionLock'),require('../models/RoboAuditLog'),require('../models/NotificationOutbox'),require('../models/PositionClose')];
test('canonical external paper harness controlled acceptance',{timeout:120000},async t=>{
 const p=createProvider(),port=await p.listen(),target=`http://127.0.0.1:${port}`;
 const db='mvp_test_external_'+randomUUID().replaceAll('-','');
 await mongoose.connect(`mongodb://127.0.0.1:27189/${db}?replicaSet=mvp&directConnection=true`,{serverSelectionTimeoutMS:5000});
 const dns=require('node:dns'),lookup=dns.lookup;
 dns.lookup=function(host,...args){assert.ok(['127.0.0.1','localhost','::1'].includes(host),'External DNS forbidden in controlled acceptance');return lookup.call(this,host,...args);};
 const nativeFetch=global.fetch;
 global.fetch=(url,...args)=>{assert.equal(new URL(url).origin,target,'Only loopback controlled-provider fetch is permitted');return nativeFetch(url,...args);};
 const actualAdapter=axios.defaults.adapter,adapter=axios.getAdapter('http');
 let env,fault,report,reads,seen,postBodies;
 const control=async data=>{const r=await fetch(target+'/control',{method:'POST',body:JSON.stringify(data)});assert.equal(r.status,200);return r.json();};
 axios.defaults.adapter=async config=>{
  const url=new URL(config.url);
  assert.equal(url.origin,'https://paper-api.alpaca.markets','no live or unrelated target may enter transport');
  assert.equal(config.headers['APCA-API-KEY-ID'],'acceptance-dummy');
  seen.push({method:config.method,original:url.origin,actual:target});
  if(fault==='lookup'&&url.pathname.includes('orders:by_client'))throw Object.assign(new Error('controlled lookup failure'),{code:'LOOKUP_FAILED',config});
  if(fault==='malformed'&&url.pathname.includes('orders:by_client'))return {status:200,headers:{},config,data:{id:'wrong',client_order_id:'foreign',symbol:'MSFT',side:'buy',qty:'1',type:'limit'}};
  const response=await adapter({...config,url:target+url.pathname+url.search,baseURL:undefined,proxy:false,headers:{...config.headers,'x-provider-host':url.hostname}});
  response.config=config;
  if(fault==='changed-broker-id'&&url.pathname.includes('orders:by_client')){const raw=JSON.parse(response.data);raw.id='different-broker-id';response.data=JSON.stringify(raw);}
  if(fault!=='no-request-id')response.headers['x-request-id']='controlled-'+seen.length;
  if(url.pathname==='/v2/account'){
   reads++;
   if(reads===1&&fault==='drift')env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID='changed';
   if(reads===2&&fault==='generation')await Settings.updateOne({userId:owner},{$inc:{controlGeneration:1}});
  }
  if(url.pathname==='/v2/clock'&&fault==='closing-clock'&&reads>=2)await control({patch:{marketOpen:false}});
  if(config.method==='post'){
   const body=JSON.parse(config.data);postBodies.push(body);
   if(fault!=='no-fill'&&!(fault==='close-timeout'&&body.side==='sell')){
    await control({fill:{id:JSON.parse(response.data).id,qty:1,price:100}});
   }
  }
  return response;
 };
 const execute=async(options={})=>run({...baseOptions,'run-id':randomUUID(),...options},{env,pollAttempts:2,pollDelayMs:0,onEvidence:r=>{report=r;}});
 try{
  await Promise.all(models.map(m=>m.init()));
  t.beforeEach(async()=>{
   await Promise.all(models.map(m=>m.deleteMany({})));await control({reset:true,patch:{positions:structuredClone(baseline),account:{id:'acceptance-paper',status:'ACTIVE',currency:'USD',cash:'10000',equity:'10000',last_equity:'10000',trading_blocked:false,account_blocked:false}}});
   env={APCA_BASE_URL:'https://paper-api.alpaca.markets',APCA_API_KEY_ID:'acceptance-dummy',APCA_API_SECRET_KEY:'acceptance-dummy-secret',ALPACA_EXPECTED_PAPER_ACCOUNT_ID:'acceptance-paper',OWNER_USER_ID:owner};fault=null;reads=0;seen=[];postBodies=[];report=null;
   await Settings.create({userId:owner,mode:'paper',isEnabled:false,enabled:false,dailyLimit:1000,weeklyLimit:2000,monthlyLimit:3000,maxTradeAmount:100,maxPositionSize:1000,maxDailyLoss:500,maxOpenPositions:10,maxTradesPerDay:20});
  });
  t.afterEach(()=>{assert.ok(seen.every(r=>r.original==='https://paper-api.alpaca.markets'&&r.actual===target));assert.equal(JSON.stringify(report).includes('acceptance-dummy'),false);assert.equal(JSON.stringify(report).includes('acceptance-paper'),false);});
  await t.test('closed market reads baseline, skips occupied fixture and returns PARTIAL without intent or write',async()=>{
   await control({patch:{marketOpen:false}});const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL');assert.equal(r.reason,'WRITE LIFECYCLE REQUIRES OPEN REGULAR MARKET');assert.equal(r.fixture,'MSFT');assert.equal(r.baseline.positions.length,2);assert.equal(await Intent.countDocuments(),0);assert.equal(p.state.posts.length,0);assert.ok(p.state.requests.every(x=>x.method==='GET'));
  });
  await t.test('production closed-market admission is still rejected',async()=>{
   await control({patch:{marketOpen:false}});const service=getOrderLifecycle({broker:createAlpacaBroker({env}),ownerId:owner,expectedAccountId:'acceptance-paper',beforeAdmission:async()=>{}});
   await assert.rejects(service.submit({userId:owner,idempotencyKey:'closed',orderInput:{symbol:'MSFT',side:'buy',qty:1,orderType:'limit',limitPrice:100}}),/open market/);assert.equal(p.state.posts.length,0);
  });
  await t.test('unattributed active order is blocked by actual canonical exposure guard',async()=>{
   const foreign={id:'foreign-order',client_order_id:'foreign-client',symbol:'GOOG',side:'buy',qty:'1',filled_qty:'0',type:'limit',limit_price:'10',status:'new'};
   await control({patch:{orders:[foreign]}});const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(r.reason,'UNATTRIBUTED ACTIVE BROKER ORDER');assert.equal(p.state.posts.length,0);assert.deepEqual(p.state.orders,[foreign]);const i=await Intent.findOne();assert.equal(i.status,'rejected');assert.match(i.rejectionReason,/unattributed active broker order/);
  });
  await t.test('open market uses canonical buy and reducing fill, restores nonempty baseline and reloads identity',async()=>{
   const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',JSON.stringify(r));assert.equal(r.fixture,'MSFT');assert.equal(r.reloadedExecutionContext,true);assert.equal(r.opening.fillCount,1);assert.equal(r.opening.spentDeltaCents,10000);assert.equal(r.cleanup.confirmed,true);assert.equal(r.cleanup.reservedCents,0);assert.equal(p.state.posts.length,2);assert.deepEqual(p.state.posts.map(x=>x.side),['buy','sell']);assert.equal(await Fill.countDocuments({side:'buy'}),1);assert.equal(await Fill.countDocuments({side:'sell'}),1);assert.deepEqual(p.state.positions,baseline);assert.ok(r.orders.every(x=>x.clientOrderId.length<=48));assert.ok(r.orders.some(x=>x.brokerOrderId));assert.ok(r.requests.every(x=>x.xRequestId));assert.ok(r.requests.some(x=>x.path.includes('by_client_order_id')));
  });
  for(const [name,patch]of[['missing binding',{ALPACA_EXPECTED_PAPER_ACCOUNT_ID:''}],['live origin',{APCA_BASE_URL:'https://api.alpaca.markets'}],['missing explicit origin',{APCA_BASE_URL:''}],['live-style key',{APCA_API_KEY_ID:'AK-not-a-real-key'}]])await t.test(name+' fails before HTTP',async()=>{Object.assign(env,patch);const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(seen.length,0);});
  await t.test('mismatch prevents any mutation',async()=>{env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID='different';assert.equal((await execute()).decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('ineligible account blocks',async()=>{await control({patch:{account:{...p.state.account,trading_blocked:true}}});assert.equal((await execute()).decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('no clean fixture blocks without changing baseline',async()=>{const r=await execute({'symbol-allowlist':'AAPL'});assert.equal(r.reason,'NO_CLEAN_FIXTURE');assert.equal(p.state.posts.length,0);assert.deepEqual(p.state.positions,baseline);});
  await t.test('configuration drift blocks next request',async()=>{fault='drift';const r=await execute();assert.equal(r.reason,'ACCOUNT_CONFIGURATION_DRIFT');assert.equal(p.state.posts.length,0);assert.equal(seen.length,1);});
  await t.test('enabled automation prevents acceptance writes',async()=>{await Settings.updateOne({userId:owner},{$set:{isEnabled:true,enabled:true}});const r=await execute();assert.equal(r.reason,'DISABLE_AUTOMATION_BEFORE_ACCEPTANCE');assert.equal(p.state.posts.length,0);});
  await t.test('control generation changes before dispatch block the acceptance order',async()=>{fault='generation';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);assert.equal((await Intent.findOne()).status,'rejected');});
  await t.test('market closure between admission and final check still blocks dispatch',async()=>{fault='closing-clock';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('optional request ID absence does not fabricate IDs',async()=>{fault='no-request-id';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED');assert.ok(r.requests.every(x=>x.xRequestId===null));});
  await t.test('unfilled opening is canonically canceled with reservation released',async()=>{fault='no-fill';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'OPENING_FILL_TIMEOUT');assert.equal(r.cancellationConfirmed,true);assert.equal(p.state.posts.length,1);assert.equal((await Intent.findOne()).status,'canceled');assert.equal((await Capacity.findOne()).reservedCents,0);assert.deepEqual(p.state.positions,baseline);});
  await t.test('cancellation uncertainty never retries or reports clean',async()=>{fault='no-fill';await control({patch:{cancelUncertain:true}});const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.cleanup?.confirmed,undefined);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.equal(p.state.posts.length,1);});
  await t.test('lookup failure stops writes and retains durable identity',async()=>{fault='lookup';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'LOOKUP_FAILED');assert.equal(p.state.posts.length,1);assert.equal(await Intent.countDocuments(),1);assert.ok(r.orders.some(x=>x.clientOrderId));});
  await t.test('malformed lookup never authorizes cleanup',async()=>{fault='malformed';const r=await execute();assert.equal(r.reason,'BROKER_OWNERSHIP_MISMATCH');assert.equal(p.state.posts.length,1);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);});
  await t.test('lookup cannot replace the acknowledged broker identity',async()=>{fault='changed-broker-id';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'BROKER_OWNERSHIP_MISMATCH');assert.equal(p.state.posts.length,1);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);});
  await t.test('reducing timeout is bounded and residual holding is not declared restored',async()=>{fault='close-timeout';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'REDUCING_FILL_TIMEOUT');assert.equal(p.state.posts.length,2);assert.ok(p.state.positions.some(x=>x.symbol==='MSFT'));assert.equal(r.cleanup?.confirmed,undefined);});
  await t.test('accepted-response uncertainty recovers stable identity without duplicate buy',async()=>{
   // Socket loss is injected by the existing provider after accepting the opening.
   await control({patch:{mode:'timeout'}});
   const original=axios.defaults.adapter;
   axios.defaults.adapter=async config=>{
    try{return await original(config);}catch(e){if(config.method==='post'&&p.state.orders.length===1){const o=p.state.orders[0];await control({patch:{mode:'acknowledge'},fill:{id:o.id,qty:1,price:100}});}throw e;}
   };
   try{const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(p.state.posts.filter(x=>x.side==='buy').length,1);assert.ok(r.orders.some(x=>x.status==='submission_uncertain'));assert.equal(await Fill.countDocuments({side:'buy'}),1);}finally{axios.defaults.adapter=original;}
  });
 }finally{axios.defaults.adapter=actualAdapter;dns.lookup=lookup;global.fetch=nativeFetch;await mongoose.connection.dropDatabase();await mongoose.disconnect();p.server.closeAllConnections();await new Promise(r=>p.server.close(r));}
});
