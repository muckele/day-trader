const test=require('node:test');
const assert=require('node:assert/strict');
const {run,plan,parseArgs}=require('../scripts/external-paper-acceptance');
const options={'dry-run':true,'paper-origin':'https://paper-api.alpaca.markets',candidate:'a'.repeat(40),'max-notional':'100','fill-limit-price':'100',quantity:'1'};
test('dry run makes zero network requests without loading credentials',async()=>{const r=await run(options,{env:{}});assert.equal(r.networkRequests,0);assert.equal(r.dryRun,true);});
for(const [name,patch]of [
 ['explicit authorization',{'dry-run':false}],['live endpoint',{'paper-origin':'https://api.alpaca.markets'}],['decorated paper origin',{'paper-origin':'https://paper-api.alpaca.markets/'}],['invalid candidate',{candidate:'HEAD'}],['fractional shares',{quantity:'0.5'}],['multiple shares',{quantity:'2'}],['excessive test notional',{'max-notional':'1001'}],['order exceeding cap',{'max-notional':'99'}],['nonfinite price',{'fill-limit-price':'NaN'}],['unsafe fixture',{'symbol-allowlist':'TQQQ'}],['unknown fixture',{'symbol-allowlist':'BTCUSD'}],['unsafe run id',{'run-id':'../bad'}]
])test('plan rejects '+name,()=>assert.throws(()=>plan({...options,...patch})));
test('run identifiers are unique and cannot reuse a symbolic revision',()=>{const ids=Array.from({length:100},()=>plan(options).runId);assert.equal(new Set(ids).size,100);assert.ok(ids.every(x=>x.length<=40));});
test('unknown duplicate or missing CLI options fail',()=>{for(const args of [['--unknown'],['--quantity'],['--dry-run','--dry-run'],['--candidate','--dry-run']])assert.throws(()=>parseArgs(args));});
test('acceptance 30-minute boundary includes equality and rejects ambiguity',()=>{
 const {sessionCheck}=require('../scripts/acceptanceSafety');const now=Date.parse('2026-09-14T15:00:00Z');
 for(const [remaining,ok]of [[1800001,true],[1800000,true],[1799999,false]])assert.equal(sessionCheck({is_open:true,timestamp:new Date(now).toISOString(),next_close:new Date(now+remaining).toISOString()},now).eligible,ok);
 for(const clock of [{is_open:false,timestamp:new Date(now).toISOString(),next_close:new Date(now+3600000).toISOString()},{is_open:true,timestamp:'bad',next_close:'bad'},{is_open:true,timestamp:new Date(now-60001).toISOString(),next_close:new Date(now+3600000).toISOString()}])assert.equal(sessionCheck(clock,now).eligible,false);
});
test('acceptance fixture price ceiling and stale quote rejection',()=>{
 const {validateMarket}=require('../scripts/acceptanceSafety');const now=Date.parse('2026-09-14T15:00:00Z');const market={quote:{ap:250,bp:249.99,t:new Date(now).toISOString()},bars:Array.from({length:5},(_,i)=>({h:250,l:249.8,t:new Date(now-(5-i)*60000).toISOString()}))};
 assert.equal(validateMarket(market,now).askCents,25000);
 for(const quote of [{...market.quote,ap:250.01},{...market.quote,ap:0},{...market.quote,ap:249},{...market.quote,t:new Date(now-60001).toISOString()},{...market.quote,ap:250.004}])assert.throws(()=>validateMarket({...market,quote},now));
 assert.equal(validateMarket({...market,quote:{...market.quote,ap:249.999}},now).askCents,25000);
});
test('acceptance final quote revalidation rejects lost non-marketable margin',()=>{
 const {validateMarket,cancelPrice,validateCancel}=require('../scripts/acceptanceSafety');const now=Date.now(),market={quote:{ap:100,bp:99.99,t:new Date(now).toISOString()},bars:Array.from({length:5},(_,i)=>({h:100.1,l:99.9,t:new Date(now-(5-i)*60000).toISOString()}))};const m=validateMarket(market,now);
 assert.equal(cancelPrice(m),98.99);assert.doesNotThrow(()=>validateCancel(98.99,m));assert.throws(()=>validateCancel(98.99,{...m,bidCents:9899,askCents:9900}));assert.throws(()=>validateCancel(98.991,m));
});
test('acceptance mutation-budget enforcement prohibits fourth submit and duplicate cancellation',()=>{
 const {mutationBudget}=require('../scripts/acceptanceSafety'),b=mutationBudget();for(const id of ['cancel','open','close'])b.submit(id);assert.throws(()=>b.submit('fourth'));assert.throws(()=>b.submit('open'));b.cancel('cancel');assert.throws(()=>b.cancel('cancel'));assert.deepEqual(b.snapshot().submissions,3);
});

test('global cancellation authority cannot reset for another order',()=>{
 const b=require('../scripts/acceptanceSafety').mutationBudget();
 b.submit('fixture');b.cancel('fixture');b.submit('opening');
 assert.throws(()=>b.assertCancel('opening'),{code:'CANCELLATION_BUDGET_EXHAUSTED'});
 assert.throws(()=>b.cancel('opening'),{code:'CANCELLATION_BUDGET_EXHAUSTED'});
 assert.equal(b.snapshot().cancellations,1);b.submit('cleanup');
 assert.throws(()=>b.submit('fourth'),{code:'SUBMISSION_BUDGET_EXHAUSTED'});
 assert.equal(b.snapshot().submissions,3);
});
