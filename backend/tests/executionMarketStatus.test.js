const test=require('node:test');
const assert=require('node:assert/strict');
const service=()=>require('../services/executionMarketStatus');
const instant=new Date('2026-09-13T12:00:00Z');
test('fresh broker clock overrides closed local Sunday calendar for paper execution',async()=>{
 const status=await service().getExecutionMarketStatus({alpacaMode:true,now:()=>instant,broker:{getClock:async()=>({is_open:true,timestamp:instant.toISOString(),next_open:'next-open',next_close:'next-close'})}});
 assert.equal(status.status,'OPEN');assert.equal(status.source,'alpaca-clock');assert.equal(status.executionSource,'alpaca-paper');
});
test('local simulation uses calendar without reading broker',async()=>{
 const status=await service().getExecutionMarketStatus({alpacaMode:false,now:()=>instant,broker:{getClock:async()=>{throw new Error('must not read broker');}}});
 assert.equal(status.status,'CLOSED');assert.equal(status.source,'local-calendar');
});
test('stale malformed and unavailable broker clocks fail closed without calendar fallback',async()=>{
 for(const getClock of [async()=>({is_open:true,timestamp:'2000-01-01'}),async()=>({is_open:'true',timestamp:instant.toISOString()}),async()=>{throw new Error('upstream down');}]){
  const result=await service().getExecutionMarketStatus({alpacaMode:true,now:()=>instant,broker:{getClock}});assert.equal(result.status,'UNAVAILABLE');assert.match(result.error,/unavailable/i);assert.equal(result.nextOpen,null);
 }
});
test('stored trade plan remains readable on outage and generation reports 503 unavailable',async t=>{
 t.mock.method(require('../services/alpacaTradingClient'),'shouldSyncPaperTradesToAlpaca',()=>true);
 t.mock.method(require('../robotrader/alpacaBroker'),'createAlpacaBroker',()=>({getClock:async()=>{throw new Error('provider down');}}));
 const plan={_id:'persisted',tradeIdeas:[]};t.mock.method(require('../models/TradePlan'),'findOne',()=>({lean:async()=>plan}));
 const logs=[];t.mock.method(require('../models/TradePlanLog'),'create',async value=>logs.push(value));
 const router=require('../routes/tradePlan');const invoke=async(path,method)=>{const handler=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack.at(-1).handle;const result={code:200};const res={status:code=>(result.code=code,res),json:body=>(result.body=body,result)};await handler({user:{userId:'owner'},query:{}},res,error=>{throw error;});return result;};
 const today=await invoke('/today','get');assert.equal(today.code,200);assert.deepEqual(today.body.plan,plan);assert.equal(today.body.marketStatus,'UNAVAILABLE');
 const generated=await invoke('/generate','post');assert.equal(generated.code,503);assert.match(generated.body.error,/unavailable/i);assert.equal(logs.at(-1).marketStatus,'UNAVAILABLE');
});
