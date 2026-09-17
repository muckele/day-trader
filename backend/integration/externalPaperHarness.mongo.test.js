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
const User=require('../models/User');
const owner='507f1f77bcf86cd799439011';
const baseOptions={'authorize-external-paper-test':true,'paper-origin':'https://paper-api.alpaca.markets',candidate:'a'.repeat(40),'symbol-allowlist':'AAPL,MSFT,NVDA','max-notional':'100','fill-limit-price':'100',quantity:'1'};
const baseline=[{symbol:'AAPL',qty:'2',avg_entry_price:'100',market_value:'200'},{symbol:'GOOG',qty:'3',avg_entry_price:'100',market_value:'300'}];
const models=[User,Intent,Fill,Capacity,Settings,require('../models/BrokerOrder'),require('../models/SpendingBucket'),require('../models/OrderProtection'),require('../models/OrderProtectionLock'),require('../models/RoboAuditLog'),require('../models/NotificationOutbox'),require('../models/PositionClose')];
test('canonical external paper harness controlled acceptance',{timeout:120000},async t=>{
 const p=createProvider(),port=await p.listen(),target=`http://127.0.0.1:${port}`;
 const db='mvp_test_external_'+randomUUID().replaceAll('-','');
 await mongoose.connect(`mongodb://127.0.0.1:27189/${db}?replicaSet=mvp&directConnection=true`,{serverSelectionTimeoutMS:5000});
 const dns=require('node:dns'),lookup=dns.lookup;
 dns.lookup=function(host,...args){assert.ok(['127.0.0.1','localhost','::1'].includes(host),'External DNS forbidden in controlled acceptance');return lookup.call(this,host,...args);};
 const nativeFetch=global.fetch;
 global.fetch=(url,...args)=>{assert.equal(new URL(url).origin,target,'Only loopback controlled-provider fetch is permitted');return nativeFetch(url,...args);};
 const actualAdapter=axios.defaults.adapter,adapter=axios.getAdapter('http');
 let env,fault,report,reads,seen,postBodies,quoteReads,clockRemaining,now,partialQty;
 const control=async data=>{const r=await fetch(target+'/control',{method:'POST',body:JSON.stringify(data)});assert.equal(r.status,200);return r.json();};
 axios.defaults.adapter=async config=>{
  const url=new URL(config.url);
  assert.ok(['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(url.origin),'no live or unrelated target may enter transport');
  assert.equal(config.headers['APCA-API-KEY-ID'],'acceptance-dummy');
  seen.push({method:config.method,original:url.origin,actual:target});
  if(fault==='lookup'&&url.pathname.includes('orders:by_client'))throw Object.assign(new Error('controlled lookup failure'),{code:'LOOKUP_FAILED',config});
  if(fault==='malformed'&&url.pathname.includes('orders:by_client'))return {status:200,headers:{},config,data:{id:'wrong',client_order_id:'foreign',symbol:'MSFT',side:'buy',qty:'1',type:'limit'}};
  const response=await adapter({...config,url:target+url.pathname+url.search,baseURL:undefined,proxy:false,headers:{...config.headers,'x-provider-host':url.hostname}});
  response.config=config;
  if(fault==='changed-broker-id'&&url.pathname.includes('orders:by_client')){const raw=JSON.parse(response.data);raw.id='different-broker-id';response.data=JSON.stringify(raw);}
  if(fault!=='no-request-id')response.headers['x-request-id']='controlled-'+seen.length;
  if(url.pathname==='/v2/clock'){const raw=JSON.parse(response.data);Object.assign(raw,{timestamp:new Date(now).toISOString(),next_close:new Date(now+clockRemaining).toISOString()});if(fault==='stale-clock')raw.timestamp=new Date(now-60001).toISOString();if(fault==='future-clock')raw.timestamp=new Date(Date.now()+5000).toISOString();if(['final-skew-31','final-skew-5000'].includes(fault)&&await Intent.exists({status:'submitting'}))raw.timestamp=new Date(Date.now()+Number(fault.split('-').at(-1))).toISOString();if(fault==='malformed-clock')raw.next_close='bad';response.data=JSON.stringify(raw);}
  if(url.pathname.includes('/quotes/latest')){quoteReads++;const raw=JSON.parse(response.data);for(const q of Object.values(raw.quotes||{})){q.t=new Date(now).toISOString();if(fault==='stale-quote')q.t=new Date(now-60001).toISOString();if(fault==='expensive')q.ap=251;if(fault==='invalid-quote')q.bp=101;if(fault==='missing-quote'){delete q.ap;}if(fault==='ceiling'){q.ap=250;q.bp=249.99;}if(fault==='moving-quote'&&quoteReads>1||fault==='dispatch-moving-quote'&&quoteReads>=3){q.ap=98;q.bp=97.99;}}response.data=JSON.stringify(raw);}
  if(url.pathname.endsWith('/bars')){const raw=JSON.parse(response.data);raw.bars=Array.from({length:5},(_,i)=>({h:100.1,l:99.9,t:new Date(now-(5-i)*60000).toISOString()}));response.data=JSON.stringify(raw);}
  if(url.pathname.startsWith('/v2/assets/')){const raw=JSON.parse(response.data);raw.fractionable=true;if(fault==='invalid-asset')raw.class='crypto';response.data=JSON.stringify(raw);}
  if(url.pathname==='/v2/account'){
   reads++;
   if(reads===1&&fault==='drift')env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID='changed';
   if(reads===2&&fault==='generation')await Settings.updateOne({userId:owner},{$inc:{controlGeneration:1}});
  }
  if(url.pathname==='/v2/clock'&&fault==='closing-clock'&&reads>=2)await control({patch:{marketOpen:false}});
  if(config.method==='post'){
   const body=JSON.parse(config.data);postBodies.push(body);
   if((p.state.posts.length>1&&!['no-fill','cancel-response-lost'].includes(fault)&&!(['close-timeout','partial-close-timeout'].includes(fault)&&body.side==='sell'))||(['partial-cancel','full-cancel','partial-close-timeout'].includes(fault)&&p.state.posts.length===1)){
    await control({fill:{id:JSON.parse(response.data).id,qty:p.state.posts.length===1?(['partial-cancel','partial-close-timeout'].includes(fault)?partialQty:'1'):body.qty,price:p.state.posts.length===1?body.limit_price:100}});
   }
  }
  if(config.method==='delete'&&['cancel-response-lost','accepted-cancel-loss'].includes(fault))throw Object.assign(new Error('controlled cancellation response lost'),{code:'ECONNRESET',config});
  if(config.method==='delete'&&fault==='cancel-timeout')await control({patch:{orders:p.state.orders.map(o=>o.id===url.pathname.split('/').pop()?{...o,status:'new'}:o)}});
  return response;
 };
 const execute=async(options={})=>run({...baseOptions,'run-id':randomUUID(),...options},{env,now:()=>now,pollAttempts:2,pollDelayMs:0,onEvidence:r=>{report=r;}});
 try{
  await Promise.all(models.map(m=>m.init()));
  t.beforeEach(async()=>{
   await Promise.all(models.map(m=>m.deleteMany({})));await control({reset:true,patch:{positions:structuredClone(baseline),account:{id:'acceptance-paper',status:'ACTIVE',currency:'USD',cash:'10000',equity:'10000',last_equity:'10000',trading_blocked:false,account_blocked:false}}});
   env={APCA_BASE_URL:'https://paper-api.alpaca.markets',APCA_API_KEY_ID:'acceptance-dummy',APCA_API_SECRET_KEY:'acceptance-dummy-secret',ALPACA_EXPECTED_PAPER_ACCOUNT_ID:'acceptance-paper',OWNER_USER_ID:owner};fault=null;reads=0;seen=[];postBodies=[];report=null;quoteReads=0;clockRemaining=3600000;now=Date.now();partialQty='0.5';
   await User.create({_id:owner,username:'acceptance-owner',email:'owner@example.test',hash:'controlled-placeholder'});
   await Settings.create({userId:owner,mode:'paper',isEnabled:false,enabled:false,pausedReason:'Preserved operator pause',dailyLimit:1000,weeklyLimit:2000,monthlyLimit:3000,maxTradeAmount:100,maxPositionSize:1000,maxDailyLoss:500,maxOpenPositions:10,maxTradesPerDay:20});
  });
  t.afterEach(()=>{assert.ok(seen.every(r=>['https://paper-api.alpaca.markets','https://data.alpaca.markets'].includes(r.original)&&r.actual===target));assert.equal(JSON.stringify(report).includes('acceptance-dummy'),false);assert.equal(JSON.stringify(report).includes('acceptance-paper'),false);});
  await t.test('closed market reads baseline, skips occupied fixture and returns PARTIAL without intent or write',async()=>{
   await control({patch:{marketOpen:false}});const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL');assert.equal(r.reason,'WRITE LIFECYCLE REQUIRES OPEN REGULAR MARKET');assert.equal(r.fixture,'MSFT');assert.equal(r.baseline.positions.length,2);assert.equal(await Intent.countDocuments(),0);assert.equal(p.state.posts.length,0);assert.ok(p.state.requests.every(x=>x.method==='GET'));
  });
  await t.test('excessive future skew rejected before transport',async()=>{
   fault='future-clock';const r=await execute();assert.equal(r.reason,'FRESH_CLOCK_REQUIRED');assert.equal(p.state.posts.length,0);assert.equal(await Intent.countDocuments(),0);
  });
  await t.test('final-dispatch skew tolerance',async()=>{
   fault='final-skew-31';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(p.state.posts.length,3);assert.equal(r.cleanup.confirmed,true);
   assert.ok(r.clockChecks.some(c=>c.stage==='cancel'&&c.clockFreshness.rawAgeMs<0&&c.clockFreshness.valid));
  });
  await t.test('final-dispatch excessive future skew zero POST',async()=>{
   fault='final-skew-5000';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(p.state.posts.length,0);assert.equal((await Intent.findOne()).status,'rejected');assert.equal((await Capacity.findOne()).reservedCents,0);
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
   const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',JSON.stringify(r));assert.equal(r.fixture,'MSFT');assert.equal(r.reloadedExecutionContext,true);assert.equal(r.opening.fillCount,1);assert.equal(r.opening.spentDeltaCents,10000);assert.equal(r.cleanup.confirmed,true);assert.equal(r.cleanup.reservedCents,0);assert.equal(p.state.posts.length,3);assert.deepEqual(p.state.posts.map(x=>x.side),['buy','buy','sell']);assert.equal(r.standaloneCancellation.confirmed,true);assert.equal(r.budget.submissions,3);assert.equal(await Fill.countDocuments({side:'buy'}),1);assert.equal(await Fill.countDocuments({side:'sell'}),1);assert.deepEqual(p.state.positions,baseline);assert.ok(r.orders.every(x=>x.clientOrderId.length<=48));assert.ok(r.orders.some(x=>x.brokerOrderId));assert.ok(r.requests.every(x=>x.xRequestId));assert.ok(r.requests.some(x=>x.path.includes('by_client_order_id')));
  });
  const heldSetup=async()=>{
   const positions=[{symbol:'AAPL',qty:'2',side:'long',market_value:'200'},{symbol:'GOOG',qty:'3',side:'long',market_value:'300'},{symbol:'AMZN',qty:'1',side:'long',market_value:'100'},{symbol:'META',qty:'1',side:'long',market_value:'100'},{symbol:'NVDA',qty:'17.582774',side:'long',market_value:'1758.2774',avg_entry_price:'100'}];
   await control({patch:{positions}});await Settings.updateOne({userId:owner},{$set:{maxOpenPositions:5,maxPositionSize:5000}});return structuredClone(positions);
  };
  await t.test('clean fixture preferred over held fallback',async()=>{
   await heldSetup();await Settings.updateOne({userId:owner},{$set:{maxOpenPositions:6}});const r=await execute({'symbol-allowlist':'NVDA,MSFT'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(r.fixture,'MSFT');assert.equal(r.fixtureBaseline.qty,'0');
  });
  await t.test('position cap full blocks canonical new symbol without changing policy',async()=>{
   await heldSetup();const service=getOrderLifecycle({broker:createAlpacaBroker({env}),ownerId:owner,expectedAccountId:'acceptance-paper',beforeAdmission:async()=>{}});
   await assert.rejects(service.submit({userId:owner,idempotencyKey:'sixth-position',orderInput:{symbol:'MSFT',side:'buy',qty:1,orderType:'limit',limitPrice:100}}),/Maximum open positions/);assert.equal(p.state.posts.length,0);assert.equal((await Settings.findOne()).maxOpenPositions,5);
  });
  await t.test('position-cap-neutral held fixture',async()=>{
   await heldSetup();const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',JSON.stringify(r));assert.equal(r.fixture,'NVDA');assert.equal(r.fixtureBaseline.qty,'17.582774');assert.equal((await Settings.findOne()).maxOpenPositions,5);assert.equal(p.state.posts.length,3);assert.equal(p.state.posts[2].qty,'1');
  });
  await t.test('held fixture exact baseline restoration',async()=>{
   const before=await heldSetup();const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(r.cleanup.qty,1);assert.equal(p.state.positions.find(x=>x.symbol==='NVDA').qty,'17.582774');assert.deepEqual(p.state.positions.filter(x=>x.symbol!=='NVDA'),before.filter(x=>x.symbol!=='NVDA'));assert.equal(await Fill.countDocuments(),2);
  });
  for(const qty of ['0.5','0.333333333'])await t.test('fractional held-fixture cleanup '+qty,async()=>{
   await heldSetup();fault='partial-cancel';partialQty=qty;const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',JSON.stringify(r));assert.equal(r.cleanup.qty,qty);assert.equal(p.state.posts.length,2);assert.equal(p.state.posts[1].qty,qty);assert.equal(p.state.positions.find(x=>x.symbol==='NVDA').qty,'17.582774');assert.equal(r.budget.cancellations,1);assert.equal(r.opening,undefined);
  });
  await t.test('held fixture still obeys maxPositionSize',async()=>{
   await heldSetup();await Settings.updateOne({userId:owner},{$set:{maxPositionSize:1800}});const r=await execute({'symbol-allowlist':'NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);assert.equal((await Settings.findOne()).maxPositionSize,1800);
  });
  await t.test('canonical held add obeys total maxPositionSize without changing policy',async()=>{
   await heldSetup();await Settings.updateOne({userId:owner},{$set:{maxPositionSize:1800}});
   const service=getOrderLifecycle({broker:createAlpacaBroker({env}),ownerId:owner,expectedAccountId:'acceptance-paper',beforeAdmission:async()=>{}});
   await assert.rejects(service.submit({userId:owner,idempotencyKey:'held-too-large',orderInput:{symbol:'NVDA',side:'buy',qty:1,orderType:'limit',limitPrice:100}}),/Maximum position size/);assert.equal(p.state.posts.length,0);
  });
  await t.test('held unexpected full fill restores baseline without cancellation',async()=>{
   await heldSetup();fault='full-cancel';const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',r.reason);assert.equal(r.cleanup.qty,1);assert.equal(r.opening,undefined);assert.equal(r.budget.submissions,2);assert.equal(r.budget.cancellations,0);assert.equal(p.state.posts[1].qty,'1');assert.equal(p.state.positions.find(x=>x.symbol==='NVDA').qty,'17.582774');
  });
  await t.test('held fallback refuses ask over ceiling and conflicting baseline order',async()=>{
   await heldSetup();fault='expensive';let r=await execute({'symbol-allowlist':'NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);
   fault=null;await control({patch:{orders:[{id:'baseline-order',client_order_id:'baseline-client',symbol:'NVDA',side:'buy',qty:'1',filled_qty:'0',type:'limit',limit_price:'90',status:'new'}]}});r=await execute({'symbol-allowlist':'NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);
  });
  await t.test('held baseline drift at final account authorization blocks first POST',async()=>{
   await heldSetup();const before=axios.defaults.adapter;let changed=false;
   axios.defaults.adapter=async config=>{if(!changed&&new URL(config.url).pathname==='/v2/account'&&await Intent.exists({status:'submitting'})){changed=true;await control({patch:{positions:p.state.positions.map(x=>x.symbol==='NVDA'?{...x,qty:'18.582774'}:x)}});}return before(config);};
   try{const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(r.reason,'ACCEPTANCE_BASELINE_DRIFT');assert.equal(p.state.posts.length,0);}finally{axios.defaults.adapter=before;}
  });
  for(const [name,patch]of [['blockedSymbols',{blockedSymbols:['AAPL']}],['allowedSymbols',{allowedSymbols:['NVDA']}]] )await t.test('held fallback skips first symbol prohibited by '+name,async()=>{
   await heldSetup();await Settings.updateOne({userId:owner},{$set:patch});const r=await execute({'symbol-allowlist':'AAPL,NVDA'});
   assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(r.fixture,'NVDA');assert.ok(p.state.posts.every(x=>x.symbol==='NVDA'));assert.equal(await Intent.countDocuments({symbol:'AAPL'}),0);
  });
  for(const kind of ['market_value','maxPositionSize','maxTradeAmount'])await t.test('held fresh '+kind+' at final account authorization blocks first POST',async()=>{
   await heldSetup();const before=axios.defaults.adapter;let changed=false;
   axios.defaults.adapter=async config=>{if(!changed&&new URL(config.url).pathname==='/v2/account'&&await Intent.exists({status:'submitting'})){changed=true;if(kind==='market_value')await control({patch:{positions:p.state.positions.map(x=>x.symbol==='NVDA'?{...x,market_value:'4950'}:x)}});else await Settings.updateOne({userId:owner},{$set:{[kind]:kind==='maxPositionSize'?1800:99}});}return before(config);};
   try{const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(changed,true);assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(p.state.posts.length,0);assert.equal((await Intent.findOne()).status,'rejected');assert.equal((await Capacity.findOne()).reservedCents,0);}finally{axios.defaults.adapter=before;}
  });
  const malformedHeldValues=[['null',null],['empty string',''],['false',false],['whitespace',' '],['exponent string','1e3'],['excess precision','1758.2774000001'],['missing',undefined]];
  for(const [name,market_value]of malformedHeldValues)await t.test('held selection rejects malformed market_value: '+name,async()=>{
   await heldSetup();await control({patch:{positions:p.state.positions.map(x=>x.symbol==='NVDA'?{...x,market_value}:x)}});
   const r=await execute({'symbol-allowlist':'NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(r.fixtureEvaluations[0].rejection,'HELD_POSITION_VALUE_REQUIRED');assert.equal(p.state.posts.length,0);assert.equal(await Intent.countDocuments(),0);
  });
  for(const [name,market_value]of malformedHeldValues)await t.test('held final authorization rejects malformed market_value: '+name,async()=>{
   await heldSetup();const before=axios.defaults.adapter;let changed=false;
   axios.defaults.adapter=async config=>{if(!changed&&new URL(config.url).pathname==='/v2/account'&&await Intent.exists({status:'submitting'})){changed=true;await control({patch:{positions:p.state.positions.map(x=>x.symbol==='NVDA'?{...x,market_value}:x)}});}return before(config);};
   try{const r=await execute({'symbol-allowlist':'NVDA'});assert.equal(changed,true);assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(r.reason,'HELD_POSITION_VALUE_REQUIRED');assert.equal(p.state.posts.length,0);assert.equal((await Intent.findOne()).status,'rejected');assert.equal((await Capacity.findOne()).reservedCents,0);}finally{axios.defaults.adapter=before;}
  });
  for(const kind of ['baseline floor','owned fill quantity'])await t.test('held final SELL authorization rejects changed '+kind,async()=>{
   await heldSetup();const before=axios.defaults.adapter;let changed=false;
   axios.defaults.adapter=async config=>{if(!changed&&new URL(config.url).pathname==='/v2/account'&&await Intent.exists({side:'sell',status:'submitting'})){changed=true;if(kind==='baseline floor')await control({patch:{positions:p.state.positions.map(x=>x.symbol==='NVDA'?{...x,qty:'17.582774'}:x)}});else await Fill.updateOne({side:'buy'},{$set:{qty:'0.5'}});}return before(config);};
   try{const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(changed,true);assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED',r.reason);assert.equal(r.reason,'ACCEPTANCE_BASELINE_DRIFT');assert.equal(p.state.posts.filter(x=>x.side==='sell').length,0);assert.equal((await Intent.findOne({side:'sell'})).status,'rejected');assert.equal(r.cleanup?.confirmed,undefined);}finally{axios.defaults.adapter=before;}
  });
  for(const [name,qty]of [['unrelated extra buy','19.082774'],['unrelated sell','17.082774'],['position disappears',null],['wrong cumulative quantity','18.582774']])await t.test('ambiguous baseline drift blocks cleanup: '+name,async()=>{
   await heldSetup();fault='partial-cancel';const adapterBefore=axios.defaults.adapter;let changed=false;
   axios.defaults.adapter=async config=>{if(!changed&&new URL(config.url).pathname==='/v2/positions'&&p.state.posts.length===1){changed=true;await control({patch:{positions:qty===null?p.state.positions.filter(x=>x.symbol!=='NVDA'):p.state.positions.map(x=>x.symbol==='NVDA'?{...x,qty}:x)}});}return adapterBefore(config);};
   try{const r=await execute({'symbol-allowlist':'MSFT,NVDA'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED',r.reason);assert.equal(p.state.posts.filter(x=>x.side==='sell').length,0);assert.equal(r.cleanup?.confirmed,undefined);}finally{axios.defaults.adapter=adapterBefore;}
  });
  for(const [name,patch]of[['missing binding',{ALPACA_EXPECTED_PAPER_ACCOUNT_ID:''}],['live origin',{APCA_BASE_URL:'https://api.alpaca.markets'}],['missing explicit origin',{APCA_BASE_URL:''}],['live-style key',{APCA_API_KEY_ID:'AK-not-a-real-key'}]])await t.test(name+' fails before HTTP',async()=>{Object.assign(env,patch);const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(seen.length,0);});
  await t.test('mismatch prevents any mutation',async()=>{env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID='different';assert.equal((await execute()).decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('ineligible account blocks',async()=>{await control({patch:{account:{...p.state.account,trading_blocked:true}}});assert.equal((await execute()).decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('no clean fixture blocks without changing baseline',async()=>{const r=await execute({'symbol-allowlist':'AAPL'});assert.equal(r.reason,'NO ELIGIBLE ACCEPTANCE FIXTURE UNDER $250');assert.equal(p.state.posts.length,0);assert.deepEqual(p.state.positions,baseline);});
  await t.test('configuration drift blocks next request',async()=>{fault='drift';const r=await execute();assert.equal(r.reason,'ACCOUNT_CONFIGURATION_DRIFT');assert.equal(p.state.posts.length,0);assert.equal(seen.length,1);});
  await t.test('enabled automation prevents acceptance writes',async()=>{await Settings.updateOne({userId:owner},{$set:{isEnabled:true,enabled:true}});const r=await execute();assert.equal(r.reason,'DISABLE_AUTOMATION_BEFORE_ACCEPTANCE');assert.equal(p.state.posts.length,0);});
  await t.test('control generation changes before dispatch block the acceptance order',async()=>{fault='generation';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);assert.equal((await Intent.findOne()).status,'rejected');});
  await t.test('market closure between admission and final check still blocks dispatch',async()=>{fault='closing-clock';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('optional request ID absence does not fabricate IDs',async()=>{fault='no-request-id';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED');assert.ok(r.requests.every(x=>x.xRequestId===null));});
  // Preserve the mandatory historical identity; the stricter run budget now protects the residual opening.
  await t.test('unfilled opening is canonically canceled with reservation released',async()=>{fault='no-fill';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');assert.equal(r.cancellationConfirmed,true);assert.equal(p.state.posts.length,2);assert.equal((await Intent.find({status:'canceled'})).length,1);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.equal(r.remaining.acceptanceOpenOrders.length,1);assert.equal((await Capacity.findOne()).reservedCents,10000);assert.deepEqual(p.state.positions,baseline);});
  await t.test('cancellation uncertainty never retries or reports clean',async()=>{fault='no-fill';await control({patch:{cancelUncertain:true}});const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.cleanup?.confirmed,undefined);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.equal(p.state.posts.length,1);assert.equal(r.budget.cancellations,1);assert.equal(r.cancellationRecovery.confirmed,false);const deletion=p.state.requests.findIndex(x=>x.method==='DELETE');assert.ok(p.state.requests.slice(deletion+1).some(x=>x.path.includes('orders:by_client')));});
  await t.test('lookup failure stops writes and retains durable identity',async()=>{fault='lookup';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'LOOKUP_FAILED');assert.equal(p.state.posts.length,1);assert.equal(await Intent.countDocuments(),1);assert.ok(r.orders.some(x=>x.clientOrderId));});
  await t.test('malformed lookup never authorizes cleanup',async()=>{fault='malformed';const r=await execute();assert.equal(r.reason,'BROKER_OWNERSHIP_MISMATCH');assert.equal(p.state.posts.length,1);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);});
  await t.test('lookup cannot replace the acknowledged broker identity',async()=>{fault='changed-broker-id';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'BROKER_OWNERSHIP_MISMATCH');assert.equal(p.state.posts.length,1);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);});
  await t.test('reducing timeout is bounded and residual holding is not declared restored',async()=>{fault='close-timeout';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');assert.equal(p.state.posts.length,3);assert.ok(p.state.positions.some(x=>x.symbol==='MSFT'));assert.equal(r.cleanup?.confirmed,undefined);});
  await t.test('accepted-response uncertainty recovers stable identity without duplicate buy',async()=>{
   // Socket loss is injected by the existing provider after accepting the opening.
   await control({patch:{mode:'timeout'}});
   const original=axios.defaults.adapter;
   axios.defaults.adapter=async config=>{
    try{return await original(config);}catch(e){if(config.method==='post'&&p.state.orders.length===1){const o=p.state.orders[0];await control({patch:{mode:'acknowledge'}});}throw e;}
   };
   try{const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(p.state.posts.filter(x=>x.side==='buy').length,2);assert.ok(r.orders.some(x=>x.status==='submission_uncertain'));assert.equal(await Fill.countDocuments({side:'buy'}),1);}finally{axios.defaults.adapter=original;}
  });


  await t.test('acceptance exactly $250 executable fixture remains eligible',async()=>{
   fault='ceiling';await Settings.updateOne({userId:owner},{$set:{maxTradeAmount:250}});const r=await execute({'max-notional':'250','fill-limit-price':'250'});assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(r.fixtureMarket.askCents,25000);assert.equal(p.state.posts.length,3);
  });
  await t.test('cancellation fixture becoming marketable at final dispatch makes zero POST',async()=>{
   fault='dispatch-moving-quote';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED',r.reason);assert.equal(p.state.posts.length,0);assert.ok(quoteReads>=3);assert.equal((await Intent.findOne()).status,'rejected');assert.equal((await Capacity.findOne()).reservedCents,0);
  });
  await t.test('controlled acceptance performs zero live-host or external network transport',async()=>{
   const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.ok(seen.length>0);assert.ok(seen.every(x=>x.actual===target));const prior=seen.length;
   await assert.rejects(axios.get('https://api.alpaca.markets/v2/account'),/no live or unrelated target/);assert.equal(seen.length,prior);
  });
  await t.test('acceptance 30-minute boundary',async()=>{clockRemaining=1800000;const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);assert.equal(p.state.posts.length,3);});
  await t.test('acceptance below 30 minutes makes zero mutation',async()=>{clockRemaining=1799999;const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL');assert.equal(r.reason,'INSUFFICIENT REGULAR SESSION TIME');assert.equal(p.state.posts.length,0);assert.equal(await Intent.countDocuments(),0);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);});
  for(const kind of ['stale-clock','malformed-clock'])await t.test('acceptance rejects '+kind,async()=>{fault=kind;await execute();assert.equal(p.state.posts.length,0);});
  await t.test('acceptance fixture price ceiling',async()=>{fault='expensive';const r=await execute();assert.equal(r.reason,'NO ELIGIBLE ACCEPTANCE FIXTURE UNDER $250');assert.equal(p.state.posts.length,0);});
  await t.test('acceptance stale quote rejection',async()=>{fault='stale-quote';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('acceptance final quote revalidation',async()=>{fault='moving-quote';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('canonical standalone cancel and cancellation identity match',async()=>{const r=await execute();assert.equal(r.standaloneCancellation.confirmed,true);assert.equal(r.standaloneCancellation.fillCount,0);const first=p.state.posts[0];assert.equal(first.qty,'1');assert.equal(first.limit_price,'98.99');const order=p.state.orders.find(o=>o.client_order_id===first.client_order_id);assert.equal(order.status,'canceled');assert.equal(p.state.requests.filter(x=>x.method==='DELETE'&&x.path.endsWith(order.id)).length,1);assert.equal(await Fill.countDocuments({externalOrderId:order.id}),0);});
  for(const [kind,name,qty]of [['partial-cancel','unexpected partial-fill acceptance cleanup','0.5'],['full-cancel','unexpected full-fill acceptance cleanup',1]])await t.test(name,async()=>{fault=kind;const before=(await Settings.findOne()).toObject();const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',JSON.stringify(r));assert.equal(r.cleanup.confirmed,true);assert.equal(p.state.posts.length,2);assert.equal(p.state.posts[1].side,'sell');assert.equal(p.state.posts[1].qty,String(qty));assert.equal(await Fill.countDocuments(),2);assert.deepEqual(p.state.positions,baseline);assert.deepEqual((await Settings.findOne()).toObject(),before);assert.equal(r.opening,undefined);});
  await t.test('global one-cancellation budget',async()=>{
   const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);
   assert.equal(r.budget.submissions,3);assert.equal(r.budget.cancellations,1);
   assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.deepEqual(p.state.positions,baseline);
  });
  await t.test('second cancellation rejected before transport',async()=>{
   fault='no-fill';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');
   assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');assert.equal(r.budget.submissions,2);assert.equal(r.budget.cancellations,1);
   assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.equal(r.remaining.acceptanceOpenOrders.length,1);
   assert.equal(r.remaining.acceptanceOpenOrders[0].side,'buy');assert.equal(r.operatorReconciliationRequired,true);assert.ok(r.operatorFollowUp);
  });
  await t.test('uncertain cancellation consumes budget',async()=>{
   fault='cancel-response-lost';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');
   assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');assert.equal(r.budget.cancellations,1);assert.equal(r.budget.submissions,2);
   const deletion=p.state.requests.findIndex(x=>x.method==='DELETE');assert.ok(deletion>=0);
   assert.ok(p.state.requests.slice(deletion+1).some(x=>x.path.includes('orders:by_client')));
   assert.equal(r.cancellationRecovery.confirmed,true);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);
  });
  await t.test('unexpected partial fill uses at most one cancellation',async()=>{
   fault='partial-cancel';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',r.reason);
   assert.equal(r.budget.submissions,2);assert.equal(r.budget.cancellations,1);assert.equal(r.cleanup.qty,'0.5');
   assert.equal(r.opening,undefined);assert.deepEqual(p.state.posts.map(x=>x.side),['buy','sell']);assert.deepEqual(p.state.positions,baseline);
  });
  await t.test('full fill uses zero cancellation',async()=>{
   fault='full-cancel';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',r.reason);
   assert.equal(r.budget.submissions,2);assert.equal(r.budget.cancellations,0);assert.equal(r.opening,undefined);
   assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,0);assert.deepEqual(p.state.positions,baseline);
  });
  await t.test('no per-order cancellation reset',async()=>{
   fault='partial-close-timeout';const r=await execute();assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');
   assert.equal(r.budget.cancellations,1);assert.equal(r.budget.submissions,2);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);
   assert.equal(r.remaining.acceptanceOpenOrders[0].side,'sell');assert.equal(r.remaining.positions.find(x=>x.symbol==='MSFT').qty,'0.5');
  });
  await t.test('accepted cancellation response loss recovers without another cancellation',async()=>{
   fault='accepted-cancel-loss';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_VERIFIED',r.reason);
   assert.equal(r.cancellationRecovery.confirmed,true);assert.equal(r.budget.cancellations,1);assert.equal(r.budget.submissions,3);
   assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.deepEqual(p.state.positions,baseline);
  });
  await t.test('cancellation timeout consumes authority without retry transport',async()=>{
   fault='cancel-timeout';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');
   assert.equal(r.reason,'CANCELLATION_UNCONFIRMED');assert.equal(r.budget.cancellations,1);assert.equal(r.budget.submissions,1);
   assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);assert.equal(r.remaining.acceptanceOpenOrders.length,1);
  });
  await t.test('acceptance mutation-budget enforcement',async()=>{const r=await execute();assert.equal(r.budget.submissions,3);assert.equal(new Set(p.state.posts.map(x=>x.client_order_id)).size,3);assert.equal(p.state.requests.filter(x=>x.method==='DELETE').length,1);});

  for(const qty of ['0.1','0.333333333','0.500000000'])await t.test('unexpected fractional cleanup '+qty,async()=>{fault='partial-cancel';partialQty=qty;const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_PARTIAL',JSON.stringify(r));assert.equal(r.cleanup.confirmed,true);assert.equal(p.state.posts.length,2);assert.equal(p.state.posts[1].qty,require('../services/shareQuantity').normalize(qty));assert.deepEqual(p.state.positions,baseline);});
  await t.test('partial-fill reducing timeout preserves residual exposure',async()=>{fault='partial-close-timeout';const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_FAILED');assert.equal(r.reason,'CANCELLATION_BUDGET_EXHAUSTED');assert.equal(r.cleanup?.confirmed,undefined);assert.equal(p.state.posts.length,2);assert.equal(p.state.positions.find(x=>x.symbol==='MSFT').qty,'0.5');});
  await t.test('acceptance above 30 minutes by one millisecond',async()=>{clockRemaining=1800001;assert.equal((await execute()).decision,'EXTERNAL_ALPACA_PAPER_VERIFIED');});
  for(const kind of ['invalid-quote','missing-quote','invalid-asset'])await t.test('acceptance rejects '+kind,async()=>{fault=kind;const r=await execute();assert.equal(r.decision,'EXTERNAL_ALPACA_PAPER_BLOCKED');assert.equal(p.state.posts.length,0);});
  await t.test('acceptance missing owner blocks before provider',async()=>{delete env.OWNER_USER_ID;await execute();assert.equal(seen.length,0);});
  await t.test('acceptance wrong owner blocks before provider',async()=>{env.OWNER_USER_ID='507f1f77bcf86cd799439012';await execute();assert.equal(seen.length,0);});
  await t.test('acceptance active worker lease blocks before provider',async()=>{await mongoose.connection.collection('robolocks').insertOne({userId:new mongoose.Types.ObjectId(owner),owner:'controlled',lockedUntil:new Date(now+60000)});try{await execute();assert.equal(seen.length,0);}finally{await mongoose.connection.collection('robolocks').deleteMany({});}});
  await t.test('acceptance readiness failure blocks before provider',async()=>{const readiness=require('../services/executionReadiness').executionReadiness,original=readiness.bootstrap;readiness.bootstrap=async()=>{readiness.invalidate();return false;};try{await execute();assert.equal(seen.length,0);}finally{readiness.bootstrap=original;}});
 }finally{axios.defaults.adapter=actualAdapter;dns.lookup=lookup;global.fetch=nativeFetch;await mongoose.connection.dropDatabase();await mongoose.disconnect();p.server.closeAllConnections();await new Promise(r=>p.server.close(r));}
});
