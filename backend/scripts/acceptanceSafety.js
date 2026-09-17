'use strict';
const {cents}=require('../services/orderLifecycleFinancial');
const fail=code=>Object.assign(new Error(code),{code,beforeTransport:true});
const check=(value,code)=>{if(!value)throw fail(code);};
// Matches the existing harness/canonical 60-second clock convention and the
// stock quote cache lifetime. Acceptance reads uncached data, never a bid fallback.
const FRESH_MS=60000,SESSION_MS=30*60000;
// Observation-only fixed point: positive plain decimals, at most nine whole
// and nine fractional digits. Numbers use their JSON-decoded decimal spelling;
// strings retain all supplied digits. Exponents/whitespace fail closed. This
// parser never enters production currency accounting or executable-price input.
const OBS_SCALE=1000000000n,CENT_UNITS=10000000n;
function observation(value,code){
 check(typeof value==='string'||typeof value==='number'&&Number.isFinite(value),code);
 const match=/^(0|[1-9]\d{0,8})(?:\.(\d{1,9}))?$/.exec(String(value));check(match,code);
 const units=BigInt(match[1])*OBS_SCALE+BigInt((match[2]||'').padEnd(9,'0'));check(units>0n,code);return units;
}
const ceilCents=units=>Number((units+CENT_UNITS-1n)/CENT_UNITS);
const floorCents=units=>Number(units/CENT_UNITS);
function barQuery(now=Date.now()){
 check(Number.isFinite(now),'FRESH_RANGE_REQUIRED');
 // Ten bounded minutes cover missing IEX minutes without weakening selection
 // freshness. Eleven results cover both endpoints of a closed minute interval.
 return {timeframe:'1Min',start:new Date(now-10*60000).toISOString(),end:new Date(now).toISOString(),limit:11,feed:'iex',sort:'asc'};
}
function sessionCheck(clock,now=Date.now()){
 const timestamp=Date.parse(clock?.timestamp),close=Date.parse(clock?.next_close);
 if(typeof clock?.is_open!=='boolean'||!Number.isFinite(timestamp)||now-timestamp<0||now-timestamp>FRESH_MS||!Number.isFinite(close)||close<=timestamp)return {eligible:false,reason:'FRESH_CLOCK_REQUIRED'};
 if(!clock.is_open)return {eligible:false,reason:'WRITE LIFECYCLE REQUIRES OPEN REGULAR MARKET'};
 if(close-now<SESSION_MS)return {eligible:false,reason:'INSUFFICIENT REGULAR SESSION TIME'};
 return {eligible:true,remainingMs:close-now,timestamp,close};
}
function validateMarket(market,now=Date.now()){
 const q=market?.quote,t=Date.parse(q?.t);check(Number.isFinite(t)&&t<=now&&now-t<=FRESH_MS,'FRESH_QUOTE_REQUIRED');
 const ask=observation(q.ap,'INVALID_ACCEPTANCE_QUOTE'),bid=observation(q.bp,'INVALID_ACCEPTANCE_QUOTE');
 check(bid<=ask&&ask<=250n*OBS_SCALE,'INVALID_ACCEPTANCE_QUOTE');
 const bars=market.bars;check(Array.isArray(bars)&&bars.length>=5,'FRESH_RANGE_REQUIRED');let previous=-Infinity;
 const valid=bars.map(bar=>{
  const time=Date.parse(bar?.t);check(Number.isFinite(time)&&time>previous&&time<=now,'FRESH_RANGE_REQUIRED');previous=time;
  const high=observation(bar.h,'INVALID_ACCEPTANCE_RANGE'),low=observation(bar.l,'INVALID_ACCEPTANCE_RANGE');check(high>=low,'INVALID_ACCEPTANCE_RANGE');
  return {time,range:high-low};
 });
 const last=valid.slice(-5);check(last.every(bar=>now-bar.time<=6*60000)&&now-previous<=120000,'FRESH_RANGE_REQUIRED');
 // Five times the mean range of the five latest minute bars (sum of ranges),
 // or twenty current spreads, whichever is larger. No fixed dollar offset.
 const rangeSum=last.reduce((sum,bar)=>sum+bar.range,0n),spread=ask-bid;
 const spreadMargin=20n*(spread>CENT_UNITS?spread:CENT_UNITS),margin=rangeSum>spreadMargin?rangeSum:spreadMargin;
 return {askCents:ceilCents(ask),bidCents:floorCents(bid),marginCents:ceilCents(margin),quoteAt:t,validatedAt:now,
  exactMarket:{scale:String(OBS_SCALE),askUnits:String(ask),bidUnits:String(bid),spreadUnits:String(spread),rangeSumUnits:String(rangeSum),marginUnits:String(margin)},
  selectedBarTimes:last.map(bar=>new Date(bar.time).toISOString())};
}
function exactMarket(market,code){
 const exact=market?.exactMarket;check(exact?.scale===String(OBS_SCALE),code);
 const read=key=>{check(typeof exact[key]==='string'&&/^\d{1,20}$/.test(exact[key]),code);return BigInt(exact[key]);};
 const ask=read('askUnits'),bid=read('bidUnits'),margin=read('marginUnits');
 check(ask>0n&&bid>0n&&bid<=ask&&ask<=250n*OBS_SCALE&&margin>0n,code);
 check(market.askCents===ceilCents(ask)&&market.bidCents===floorCents(bid)&&market.marginCents===ceilCents(margin),code);
 return {ask,bid,margin};
}
function cancelPrice(market){
 const {bid,margin}=exactMarket(market,'NO_SAFE_CANCELLATION_PRICE'),value=bid-margin;
 check(value>=OBS_SCALE&&margin*5n<=bid,'NO_SAFE_CANCELLATION_PRICE');
 return floorCents(value)/100;
}
function validateCancel(price,market){
 const limit=BigInt(cents(price))*CENT_UNITS,{ask,bid,margin}=exactMarket(market,'CANCEL_LIMIT_MARGIN_LOST');
 check(limit<=bid-margin&&limit<ask,'CANCEL_LIMIT_MARGIN_LOST');return true;
}
function mutationBudget(){const submissions=new Set(),cancellations=new Set();return {
 assertSubmit(id){check(!submissions.has(id),'DUPLICATE_POST_BLOCKED');check(submissions.size<3,'SUBMISSION_BUDGET_EXHAUSTED');},
 submit(id){this.assertSubmit(id);submissions.add(id);},
 assertCancel(id){check(!cancellations.has(id),'DUPLICATE_CANCEL_BLOCKED');check(cancellations.size<1,'CANCELLATION_BUDGET_EXHAUSTED');},
 cancel(id){this.assertCancel(id);cancellations.add(id);},
 snapshot:()=>({submissions:submissions.size,cancellations:cancellations.size,maxSubmissions:3,maxCancellations:1})
};}
module.exports={sessionCheck,validateMarket,cancelPrice,validateCancel,mutationBudget,barQuery,FRESH_MS};
