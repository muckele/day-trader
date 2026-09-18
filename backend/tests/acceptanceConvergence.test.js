const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../scripts/acceptanceConvergence');
const intent={_id:'synthetic-intent',clientOrderId:'synthetic-client',symbol:'MSFT',side:'buy',qty:1,orderType:'limit',limitPrice:100,filledQty:0,status:'acknowledged'};
const raw={id:'synthetic-broker',client_order_id:'synthetic-client',symbol:'MSFT',side:'buy',qty:'1',type:'limit',limit_price:'100',status:'new',filled_qty:'0',filled_avg_price:null};
const reason='Portfolio exposure requires reconciliation: broker execution is ahead of canonical fill ingestion';
function observation(patch={}){return {intent,expected:intent,brokerId:raw.id,raw,exposure:{state:'reconciliation_required',reason},baselineQty:'2.5',ownedQty:'0',currentQty:'3.5',...patch};}
test('convergence allows only an explainable same-order visibility gap',()=>{
 assert.equal(C.classify(observation()).kind,'temporary');
 assert.equal(C.classify(observation({exposure:{state:'reconciliation_required',reason:'Portfolio exposure requires reconciliation: broker and canonical holdings disagree for MSFT'}})).kind,'temporary');
 assert.throws(()=>C.classify(observation({exposure:{state:'reconciliation_required',reason:'Portfolio exposure requires reconciliation: canonical intent and fill quantities disagree'}})),e=>e.code==='ACCEPTANCE_EXPOSURE_HARD_FAILURE');
});
for(const [field,value]of [['id','different'],['client_order_id','different'],['symbol','NVDA'],['side','sell'],['qty','2']])test('convergence rejects identity '+field,()=>{
 assert.throws(()=>C.classify(observation({raw:{...raw,[field]:value}})),e=>e.code==='BROKER_OWNERSHIP_MISMATCH');
});
for(const qty of ['1.1','bad','-1','0.0000000001'])test('convergence rejects invalid cumulative fill '+qty,()=>{
 assert.throws(()=>C.classify(observation({raw:{...raw,filled_qty:qty}})),e=>e.code==='ACCEPTANCE_BROKER_EXECUTION_INVALID');
});
for(const status of ['mystery',null,'filled','partially_filled'])test('convergence rejects malformed status '+status,()=>{
 assert.throws(()=>C.classify(observation({raw:{...raw,status}})),e=>e.code==='ACCEPTANCE_BROKER_EXECUTION_INVALID');
});
for(const qty of ['2','0','3.6'])test('convergence rejects unexplained baseline quantity '+qty,()=>{
 assert.throws(()=>C.classify(observation({currentQty:qty})),e=>e.code==='ACCEPTANCE_BASELINE_DRIFT');
});
test('convergence never treats position delta as canonical ownership',()=>{
 const result=C.classify(observation());assert.equal(result.kind,'temporary');assert.equal(result.ownedQty,'0');
});
test('convergence requires coherent exact execution and baseline',()=>{
 assert.equal(C.classify(observation({exposure:{state:'coherent'},currentQty:'2.5'})).kind,'coherent');
 assert.equal(C.classify(observation({exposure:{state:'coherent'}})).kind,'temporary');
 assert.equal(C.classify(observation({intent:{...intent,filledQty:1,status:'filled'},raw:{...raw,filled_qty:'1',filled_avg_price:'100',status:'filled'},ownedQty:'1',exposure:{state:'coherent'}})).kind,'coherent');
});
test('convergence deadline uses monotonic aggregate time and attempt budget',()=>{
 let clock=10;const wait=C.createWait({attempts:2,monotonicNow:()=>clock});
 wait.next();clock+=30000;wait.next();assert.throws(()=>wait.next(),e=>e.code==='ACCEPTANCE_CONVERGENCE_ATTEMPTS');
 const next=C.createWait({attempts:10,monotonicNow:()=>clock});next.next();clock+=59999;assert.equal(next.remaining(),1);clock+=1;assert.throws(()=>next.check(),e=>e.code==='ACCEPTANCE_CONVERGENCE_DEADLINE');
});
test('convergence rejects canonical identity drift',()=>{
 assert.throws(()=>C.classify(observation({intent:{...intent,_id:'other'}})),e=>e.code==='ACCEPTANCE_IDENTITY_MISMATCH');
});
test('convergence diagnostics never echo unknown exposure secrets',()=>{
 const secret='synthetic-private-account';assert.equal(C.exposureReason({state:'reconciliation_required',reason:secret},'MSFT').reason,'Unrecognized exposure invariant');
});

for(const [field,value]of [['_id','other'],['clientOrderId','other'],['symbol','NVDA'],['side','sell'],['qty',2],['accountId','other'],['userId','other']])test('persisted convergence identity is checked before reconciliation: '+field,()=>{
 assert.throws(()=>C.validateIntent({...intent,[field]:value},intent),e=>e.code==='ACCEPTANCE_IDENTITY_MISMATCH');
});
for(const patch of [{filled_qty:'1',filled_avg_price:'0',status:'filled'},{filled_qty:'0.5',filled_avg_price:'100',status:'new'},{filled_qty:'0.5',filled_avg_price:'bad',status:'partially_filled'}])test('convergence rejects contradictory execution '+JSON.stringify(patch),()=>{
 assert.throws(()=>C.validateBroker({...raw,...patch},intent,raw.id),e=>e.code==='ACCEPTANCE_BROKER_EXECUTION_INVALID');
});

test('convergence watchdog bounds a stalled observation and tracks its drain',async()=>{
 let fire,clock=0,release,fenced=false;
 const wait=C.createWait({attempts:2,monotonicNow:()=>clock,schedule:callback=>{fire=callback;return 1;},clear:()=>{}});
 const held=new Promise(resolve=>{release=resolve;});
 const result=wait.observe(()=>held,()=>{fenced=true;});
 clock=60000;fire();await assert.rejects(result,e=>e.code==='ACCEPTANCE_CONVERGENCE_DEADLINE');
 assert.equal(fenced,true);assert.equal(wait.inFlight,true);release();await wait.pending;assert.equal(wait.inFlight,false);
 assert.throws(()=>wait.check(),e=>e.code==='ACCEPTANCE_CONVERGENCE_DEADLINE');
});
