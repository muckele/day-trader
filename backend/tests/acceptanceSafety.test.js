'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Safety=require('../scripts/acceptanceSafety');
const {cents}=require('../services/orderLifecycleFinancial');
const now=Date.parse('2026-09-14T15:00:00Z');
const stamp=minutes=>new Date(now-minutes*60000).toISOString();
// Synthetic observations; these fixtures contain no account or provider data.
const bar=(minutes,h='100.105',l='99.904')=>({t:stamp(minutes),h,l});
const market=(bars=[5,4,3,2,1].map(i=>bar(i)),ap='100.005',bp='99.994')=>({quote:{ap,bp,t:stamp(0)},bars});

test('sub-cent bar observations supported',()=>{
 const values=[['56.445','56.444'],['168.335','168.334'],['523.345','523.344'],['676.475','676.474'],['100.000000001','100']];
 const m=Safety.validateMarket(market(values.map(([h,l],i)=>bar(5-i,i%2?Number(h):h,i%2?Number(l):l))),now);
 assert.equal(m.exactMarket.rangeSumUnits,'4000001');
 for(const [h]of values)assert.throws(()=>cents(h));
});
test('exact market-data range calculation',()=>{
 const m=Safety.validateMarket(market(),now);
 assert.equal(m.exactMarket.rangeSumUnits,'1005000000');
 assert.equal(m.exactMarket.marginUnits,'1005000000');
 assert.equal(m.marginCents,101);
 assert.equal(Safety.cancelPrice(m),98.98);
 assert.equal(Safety.validateCancel('98.98',m),true);
 assert.throws(()=>Safety.validateCancel('98.99',m),{code:'CANCEL_LIMIT_MARGIN_LOST'});
});
test('exact quote spread retains one-cent minimum and twenty-spread multiplier',()=>{
 const bars=[5,4,3,2,1].map(i=>bar(i,'100.001','100'));
 const spread=Safety.validateMarket(market(bars,'100.005','99.994'),now);
 assert.equal(spread.exactMarket.spreadUnits,'11000000');
 assert.equal(spread.exactMarket.marginUnits,'220000000');
 assert.equal(spread.askCents,10001);assert.equal(spread.bidCents,9999);
 assert.equal(Safety.cancelPrice(spread),99.77);
 const minimum=Safety.validateMarket(market(bars,'100.005','100.004'),now);
 assert.equal(minimum.exactMarket.marginUnits,'200000000');
 assert.equal(Safety.cancelPrice(minimum),99.8);
 assert.throws(()=>Safety.validateCancel('99.801',minimum));
});
test('exact quote ceiling rejects 250.004 without downward rounding',()=>{
 assert.throws(()=>Safety.validateMarket(market(undefined,'250.004','249.999'),now),{code:'INVALID_ACCEPTANCE_QUOTE'});
 assert.equal(Safety.validateMarket(market(undefined,'249.999','249.998'),now).askCents,25000);
 assert.throws(()=>Safety.validateMarket(market(undefined,'100.001','100.002'),now),{code:'INVALID_ACCEPTANCE_QUOTE'});
});
test('malformed and excessive observation precision fails closed',()=>{
 for(const value of ['1.0000000001','NaN','Infinity','',' 100','100 ','1e2','-1','0','1000000000',null,true,{},NaN,Infinity]){
  assert.throws(()=>Safety.validateMarket(market(undefined,value),now),{code:'INVALID_ACCEPTANCE_QUOTE'});
  assert.throws(()=>Safety.validateMarket(market([bar(5,value),...[4,3,2,1].map(i=>bar(i))]),now),{code:'INVALID_ACCEPTANCE_RANGE'});
 }
 assert.throws(()=>Safety.validateMarket(market([bar(5,'99','100'),...[4,3,2,1].map(i=>bar(i))]),now),{code:'INVALID_ACCEPTANCE_RANGE'});
});
test('widened bounded bar lookback',()=>{
 const query=Safety.barQuery(now);
 assert.equal(query.start,'2026-09-14T14:50:00.000Z');assert.equal(query.end,'2026-09-14T15:00:00.000Z');
 assert.equal(query.timeframe,'1Min');assert.equal(query.feed,'iex');assert.equal(query.sort,'asc');
 const supplied=[9,8,6,5,3,2,1].map(i=>bar(i));
 const returned=supplied.filter(b=>b.t>=query.start&&b.t<=query.end).slice(0,query.limit);
 assert.equal(Safety.validateMarket(market(returned),now).selectedBarTimes.length,5);
 assert.ok(query.limit>=11&&query.limit<=20);
});
test('five most recent valid bars selected',()=>{
 const m=Safety.validateMarket(market([bar(9,'200','100'),bar(8,'200','100'),...[6,5,3,2,1].map(i=>bar(i))]),now);
 assert.deepEqual(m.selectedBarTimes,[6,5,3,2,1].map(stamp));
 assert.equal(m.exactMarket.rangeSumUnits,'1005000000');
});
test('five-bar requirement preserved',()=>{
 for(const times of [[],[4,3,2,1]])assert.throws(()=>Safety.validateMarket(market(times.map(i=>bar(i))),now),{code:'FRESH_RANGE_REQUIRED'});
 assert.equal(Safety.validateMarket(market(),now).selectedBarTimes.length,5);
});
test('wider history never relaxes selected or latest bar freshness',()=>{
 for(const times of [[7,5,3,2,1],[6,5,4,3,2.01],[5,4,3,2,-1],[8,9,5,4,3,2,1],[5,4,3,3,1]])
  assert.throws(()=>Safety.validateMarket(market(times.map(i=>bar(i))),now),{code:'FRESH_RANGE_REQUIRED'});
 assert.equal(Safety.validateMarket(market([6,5,4,3,2].map(i=>bar(i))),now).selectedBarTimes.length,5);
});
test('exact cancellation floor and twenty-percent bound remain enforced',()=>{
 assert.throws(()=>Safety.cancelPrice(Safety.validateMarket(market([5,4,3,2,1].map(i=>bar(i,'1.03','1')),'1.19','1.18'),now)),{code:'NO_SAFE_CANCELLATION_PRICE'});
 assert.throws(()=>Safety.cancelPrice(Safety.validateMarket(market([5,4,3,2,1].map(i=>bar(i,'100.401','100')),'10.01','10'),now)),{code:'NO_SAFE_CANCELLATION_PRICE'});
 const m=Safety.validateMarket(market(),now);
 assert.throws(()=>Safety.validateCancel('98.98',{...m,bidCents:9800}),{code:'CANCEL_LIMIT_MARGIN_LOST'});
});
