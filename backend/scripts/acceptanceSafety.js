'use strict';
const {cents}=require('../services/orderLifecycleFinancial');
const fail=code=>Object.assign(new Error(code),{code,beforeTransport:true});
const check=(value,code)=>{if(!value)throw fail(code);};
// Matches the existing harness/canonical 60-second clock convention and the
// stock quote cache lifetime. Acceptance reads uncached data, never a bid fallback.
const FRESH_MS=60000,SESSION_MS=30*60000;
function sessionCheck(clock,now=Date.now()){
 const timestamp=Date.parse(clock?.timestamp),close=Date.parse(clock?.next_close);
 if(typeof clock?.is_open!=='boolean'||!Number.isFinite(timestamp)||now-timestamp<0||now-timestamp>FRESH_MS||!Number.isFinite(close)||close<=timestamp)return {eligible:false,reason:'FRESH_CLOCK_REQUIRED'};
 if(!clock.is_open)return {eligible:false,reason:'WRITE LIFECYCLE REQUIRES OPEN REGULAR MARKET'};
 if(close-now<SESSION_MS)return {eligible:false,reason:'INSUFFICIENT REGULAR SESSION TIME'};
 return {eligible:true,remainingMs:close-now,timestamp,close};
}
function validateMarket(market,now=Date.now()){
 const q=market?.quote,t=Date.parse(q?.t);check(Number.isFinite(t)&&t<=now&&now-t<=FRESH_MS,'FRESH_QUOTE_REQUIRED');
 let askCents,bidCents;try{askCents=cents(q.ap);bidCents=cents(q.bp);}catch{throw fail('INVALID_ACCEPTANCE_QUOTE');}
 check(bidCents<=askCents&&askCents<=25000,'INVALID_ACCEPTANCE_QUOTE');
 const bars=market.bars;check(Array.isArray(bars)&&bars.length>=5,'FRESH_RANGE_REQUIRED');const last=bars.slice(-5);let previous=0;
 const ranges=last.map(bar=>{const time=Date.parse(bar.t);check(Number.isFinite(time)&&time>previous&&time<=now&&now-time<=6*60000,'FRESH_RANGE_REQUIRED');previous=time;const high=cents(bar.h),low=cents(bar.l);check(high>=low,'INVALID_ACCEPTANCE_RANGE');return high-low;});
 check(now-previous<=120000,'FRESH_RANGE_REQUIRED');
 // Five times the mean range of the five latest minute bars (sum of ranges),
 // or twenty current spreads, whichever is larger. No fixed dollar offset.
 const marginCents=Math.max(ranges.reduce((a,b)=>a+b,0),20*Math.max(1,askCents-bidCents));
 return {askCents,bidCents,marginCents,quoteAt:t,validatedAt:now};
}
function cancelPrice(market){const value=market.bidCents-market.marginCents;check(value>=100&&market.marginCents*5<=market.bidCents,'NO_SAFE_CANCELLATION_PRICE');return value/100;}
function validateCancel(price,market){const limit=cents(price);check(limit<=market.bidCents-market.marginCents&&limit<market.askCents,'CANCEL_LIMIT_MARGIN_LOST');return true;}
function mutationBudget(){const submissions=new Set(),cancellations=new Set();return {
 assertSubmit(id){check(!submissions.has(id),'DUPLICATE_POST_BLOCKED');check(submissions.size<3,'SUBMISSION_BUDGET_EXHAUSTED');},
 submit(id){this.assertSubmit(id);submissions.add(id);},
 assertCancel(id){check(!cancellations.has(id),'DUPLICATE_CANCEL_BLOCKED');check(cancellations.size<1,'CANCELLATION_BUDGET_EXHAUSTED');},
 cancel(id){this.assertCancel(id);cancellations.add(id);},
 snapshot:()=>({submissions:submissions.size,cancellations:cancellations.size,maxSubmissions:3,maxCancellations:1})
};}
module.exports={sessionCheck,validateMarket,cancelPrice,validateCancel,mutationBudget,FRESH_MS};
