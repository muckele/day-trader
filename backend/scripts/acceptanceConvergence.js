'use strict';
// Acceptance observations only. This module cannot admit orders or change accounting.
const Q=require('../services/shareQuantity');
const {fillNotionalCents}=require('../services/orderLifecycleFinancial');
// Ten polls normally take seconds; cap aggregate observation at one freshness
// window (60s), below the existing 120s coordinated-close deadline. No GET or
// subsequent phase can restart an existing order's wait budget.
const DEADLINE_MS=60000;
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const states=new Set(['new','accepted','pending_new','pending_cancel','partially_filled','filled','canceled','cancelled','expired','rejected']);
function validateBroker(raw,expected,brokerId){
 check(raw&&raw.id&&raw.client_order_id===expected.clientOrderId&&(!brokerId||raw.id===brokerId)&&raw.symbol===expected.symbol&&raw.side===expected.side&&Q.compare(raw.qty,expected.qty)===0&&raw.type===expected.orderType&&(expected.orderType!=='limit'||Number(raw.limit_price)===expected.limitPrice),'BROKER_OWNERSHIP_MISMATCH');
 try{
  const qty=Q.units(raw.filled_qty),ordered=Q.units(raw.qty);
  check(states.has(raw.status)&&qty<=ordered,'ACCEPTANCE_BROKER_EXECUTION_INVALID');
  check(raw.status!=='filled'||qty===ordered,'ACCEPTANCE_BROKER_EXECUTION_INVALID');
  check(raw.status!=='partially_filled'||qty>0n&&qty<ordered,'ACCEPTANCE_BROKER_EXECUTION_INVALID');
  check(!['new','accepted','pending_new','rejected'].includes(raw.status)||qty===0n,'ACCEPTANCE_BROKER_EXECUTION_INVALID');
  if(qty){check(/^\d+(\.\d{1,12})?$/.test(String(raw.filled_avg_price))&&Number(raw.filled_avg_price)>0,'ACCEPTANCE_BROKER_EXECUTION_INVALID');fillNotionalCents(raw.filled_qty,raw.filled_avg_price);}
 }catch{check(false,'ACCEPTANCE_BROKER_EXECUTION_INVALID');}
}
function exposureReason(exposure,symbol){
 if(exposure?.state==='coherent')return {code:'COHERENT',reason:null};
 if(exposure?.reason==='Portfolio exposure requires reconciliation: broker execution is ahead of canonical fill ingestion')return {code:'EXECUTION_AHEAD',reason:exposure.reason};
 if(exposure?.reason===`Portfolio exposure requires reconciliation: broker and canonical holdings disagree for ${symbol}`)return {code:'HOLDINGS_LAG',reason:exposure.reason};
 // Never echo an arbitrary upstream message or configured identifier into evidence.
 return {code:'HARD_EXPOSURE_INVARIANT',reason:'Unrecognized exposure invariant'};
}
function validateIntent(intent,expected){
 check(intent&&String(intent._id)===String(expected._id)&&['clientOrderId','symbol','side','orderType','limitPrice','accountId','userId','executionSource','environment','stopLossPrice','timeInForce','allowExtendedHours'].every(k=>intent[k]===expected[k])&&Q.compare(intent.qty,expected.qty)===0,'ACCEPTANCE_IDENTITY_MISMATCH');
 check(!intent.stopCancelRequested,'CONVERGENCE_CONTROL_CHANGED');
}
function classify({intent,expected,brokerId,raw,exposure,baselineQty,ownedQty,currentQty}){
 validateIntent(intent,expected);
 validateBroker(raw,expected,brokerId);
 const base=Q.units(baselineQty),owned=Q.units(ownedQty),current=Q.units(currentQty),filled=Q.units(intent.filledQty),requested=Q.units(expected.qty);
 check(filled<=requested,'ACCEPTANCE_BROKER_EXECUTION_INVALID');
 // Remove this order's already-ingested contribution to bound all possible views.
 // These bounds permit observation, never attribute a Fill or authorize cleanup.
 const before=intent.side==='buy'?base+owned-filled:base+owned+filled;
 const low=intent.side==='buy'?before:before-requested;
 const high=intent.side==='buy'?before+requested:before;
 check(current>=base&&current>=low&&current<=high,'ACCEPTANCE_BASELINE_DRIFT');
 const reason=exposureReason(exposure,intent.symbol);
 check(reason.code!=='HARD_EXPOSURE_INVARIANT','ACCEPTANCE_EXPOSURE_HARD_FAILURE');
 const coherent=reason.code==='COHERENT'&&current===base+owned&&Q.units(raw.filled_qty)===filled;
 return {kind:coherent?'coherent':'temporary',...reason,ownedQty:Q.normalize(ownedQty),baselineQty:Q.normalize(baselineQty),currentQty:Q.normalize(currentQty)};
}
function createWait({attempts,monotonicNow=()=>performance.now(),schedule=setTimeout,clear=clearTimeout}){
 const started=monotonicNow();let used=0,expired=false,inFlight=false,pending=Promise.resolve();
 const elapsed=()=>Math.max(0,monotonicNow()-started);
 const remaining=()=>Math.max(0,DEADLINE_MS-elapsed());
 const checkTime=()=>check(!expired&&remaining()>0,'ACCEPTANCE_CONVERGENCE_DEADLINE');
 return {elapsed,remaining,check:checkTime,get attempts(){return used;},get inFlight(){return inFlight;},get pending(){return pending;},
  next(){checkTime();check(used<attempts,'ACCEPTANCE_CONVERGENCE_ATTEMPTS');used++;},
  observe(task,onExpire){
   checkTime();inFlight=true;let timer,work;
   try{work=Promise.resolve(task());}catch(error){work=Promise.reject(error);}
   pending=work.finally(()=>{inFlight=false;clear(timer);});
   const deadline=new Promise((_,reject)=>{timer=schedule(()=>{
    expired=true;onExpire();reject(Object.assign(new Error('ACCEPTANCE_CONVERGENCE_DEADLINE'),{code:'ACCEPTANCE_CONVERGENCE_DEADLINE'}));
   },Math.max(1,Math.ceil(remaining())));});
   return Promise.race([pending,deadline]);
  }
 };
}
module.exports={classify,validateIntent,validateBroker,exposureReason,createWait,DEADLINE_MS};
