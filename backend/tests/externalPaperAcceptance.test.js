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
