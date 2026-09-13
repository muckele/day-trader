const Close = require('../models/PositionClose');
const Protection = require('../models/OrderProtection');
const Intent = require('../models/OrderIntent');
const Audit = require('../models/RoboAuditLog');
const Outbox = require('../models/NotificationOutbox');
const { withProtectionAccountLock } = require('./orderProtectionService');
const terminal = new Set(['filled','canceled','cancelled','expired','rejected']);
const flatten = orders => orders.flatMap(o=>[o,...flatten(o.legs||[])]);
const fail = message => Object.assign(new Error(message), {status:409,code:'CLOSE_INVALID'});
function createPositionCloseService({broker,ownerId,expectedAccountId,submit,reconcile,cancel,beforeAdmission,now=()=>new Date()}) {
 async function mark(c,state,error=null,active=true) {
  if(c.active&&!active)c.needsProtectionRecovery=true;
  Object.assign(c,{state,error,active});await c.save();
  await Audit.create({userId:ownerId,eventType:'position_close_state',payload:{closeId:String(c._id),symbol:c.symbol,state,error}});
  if(error || ['cancel_pending','cancel_uncertain','reconciliation_required'].includes(state))await Outbox.updateOne({eventKey:`close:${c._id}:${state}`},{$setOnInsert:{accountId:expectedAccountId,environment:'paper',subject:`Paper position close ${state}`,text:`${c.symbol}: ${state}. ${error||'Cancellation confirmation pending; no close submitted.'}`}},{upsert:true});
  return {close:c,executionSource:'alpaca-paper'};
 }
 async function closePosition({userId,idempotencyKey,symbol,qty}={}) {
  symbol=String(symbol||'').toUpperCase();
  if(String(userId)!==String(ownerId)||!/^\w[\w.]{0,14}$/.test(symbol)||typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>100)throw fail('Owner, symbol and stable close idempotency key required.');
  if(qty!=null&&(!Number.isSafeInteger(Number(qty))||Number(qty)<=0))throw fail('Close quantity must be a positive whole share count.');
  if(beforeAdmission)await beforeAdmission();
  return withProtectionAccountLock({accountId:expectedAccountId,symbol,coordinatedClose:true},async assertLease=>{
   const account=await broker.getAccount();if(broker.mode!=='paper'||String(account.id)!==String(expectedAccountId))throw fail('Expected paper account required.');
   let c=await Close.findOne({accountId:expectedAccountId,idempotencyKey});
   if(c&&(c.symbol!==symbol||Number(c.requestedQty||0)!==Number(qty||0)))throw fail('Close idempotency payload conflict.');
   if(!c){
    if(await Close.exists({accountId:expectedAccountId,symbol,active:true}))throw fail('A coordinated close already reserves this position.');
    c=await Close.create({accountId:expectedAccountId,userId:ownerId,symbol,idempotencyKey,requestedQty:qty,deadlineAt:new Date(now().getTime()+120000)});
   }
   const existing=await Intent.findOne({accountId:expectedAccountId,executionSource:'alpaca-paper',idempotencyKey:`close:${c._id}`});
   if(existing){
    let result;
    try {
     result=await reconcile({intentId:existing._id});c.intentId=existing._id;
     if(now()>c.deadlineAt&&!terminal.has(result.intent.status)){
      if(!c.exitCancelRequested){c.exitCancelRequested=true;await mark(c,'reconciliation_required','Close deadline exceeded; canceling only this close order before restoring protection.');await assertLease();result=await cancel({intentId:existing._id,dispatchLease:assertLease.dispatchLease,assertExecutor:assertLease.assertExecutor});}
      if(!terminal.has(result.intent.status)){await mark(c,'reconciliation_required','Close cancellation remains unconfirmed; protection cannot safely overlap this exit.');return {...result,close:c};}
     }
     await mark(c,result.intent.status,result.intent.rejectionReason||null,!terminal.has(result.intent.status));return {...result,close:c};
    }catch(error){return mark(c,'reconciliation_required',String(error.message).slice(0,500));}
   }
   if(!c.active)return {close:c,executionSource:'alpaca-paper'};
   if(now()>c.deadlineAt)return mark(c,'reconciliation_required','Close deadline exceeded. No new close will be submitted; protection reconciliation resumed; operator review required.',false);
   try {
    const records=await Protection.find({accountId:expectedAccountId,userId:ownerId,symbol});
    const ownedIds=new Set(records.map(r=>r.brokerOrderId).filter(Boolean));
    const open=flatten(await broker.listOrders({status:'open',nested:true,limit:500}));
    const ownedClients=new Set(records.map(r=>r.clientOrderId).filter(Boolean));
    for(const o of open)if(ownedClients.has(o.client_order_id)&&o.symbol===symbol&&o.side==='sell'&&o.type==='stop')ownedIds.add(o.id);
    if(open.length>=500)return mark(c,'blocked','Open order discovery reached its limit; complete reconciliation required.');
    if(open.some(o=>o.symbol===symbol&&o.side==='sell'&&!ownedIds.has(o.id)))return mark(c,'blocked','An unrelated broker exit reserves this position; it was not canceled.');
    if(await Intent.exists({accountId:expectedAccountId,executionSource:'alpaca-paper',symbol,side:'sell',status:{$nin:[...terminal]}}))return mark(c,'blocked','An unresolved reducing order already reserves this position.');
    for(const record of records){
     if(!record.clientOrderId){if(['submitting','uncertain','cancel_pending'].includes(record.state))return mark(c,'cancel_uncertain','Protective order identity is unresolved.');continue;}
     const o=record.brokerOrderId?await broker.getOrder(record.brokerOrderId):await broker.getOrderByClientOrderId(record.clientOrderId);
     if(!o?.id||o.client_order_id!==record.clientOrderId||o.symbol!==symbol||o.side!=='sell'||o.type!=='stop')return mark(c,'cancel_uncertain','Protective broker order identity is unresolved.');
     if(!terminal.has(o.status)){
      let step=c.stops.find(s=>s.brokerOrderId===o.id);
      if(!step){c.stops.push({brokerOrderId:o.id,clientOrderId:record.clientOrderId,cancelRequested:true});await mark(c,'cancel_pending');await assertLease();await broker.cancelOrder(o.id,{assertExecutor:assertLease.assertExecutor,authorize:({payload}={})=>require('./dispatchAuthorization').claimDispatch({Model:Protection,id:record._id,accountId:expectedAccountId,userId:ownerId,operation:`cancel:${o.id}`,payload:payload||{orderId:o.id},lease:assertLease.dispatchLease,assertExecutor:assertLease.assertExecutor})});}
      // DELETE acknowledgement never establishes cancellation. Poll the authoritative ID.
      const checked=await broker.getOrder(o.id);
      if(!checked||checked.id!==o.id||checked.client_order_id!==record.clientOrderId||!terminal.has(checked.status))return mark(c,'cancel_pending');
     }
     record.confirmedQty=0;record.state='close_pending';await record.save();
    }
    const positions=await broker.getPositions();const position=positions.find(p=>p.symbol===symbol);const remaining=Number(position?.qty||0),available=Number(position?.qty_available??remaining);
    if(!Number.isSafeInteger(remaining)||remaining<0||!Number.isFinite(available)||available<remaining)return mark(c,'blocked','Fresh whole-share unreserved position required.');
    if(!remaining)return mark(c,'flat',null,false);
    c.qty=Math.min(c.requestedQty||remaining,remaining);await mark(c,'submitting');
    const result=await submit({userId:ownerId,idempotencyKey:`close:${c._id}`,origin:'manual-close',orderInput:{symbol,side:'sell',qty:c.qty,orderType:'market',timeInForce:'day'},beforeSubmit:assertLease,beforeBrokerWrite:assertLease});
    c.intentId=result.intent._id;await mark(c,result.intent.status,result.intent.rejectionReason||null,!terminal.has(result.intent.status));return {...result,close:c};
   }catch(error){return mark(c,'cancel_uncertain',String(error.message).slice(0,500));}
  });
 }
 async function resumeCloses(){const records=await Close.find({accountId:expectedAccountId,userId:ownerId,active:true}).limit(100);const results=[];for(const c of records){try{results.push(await closePosition({userId:ownerId,idempotencyKey:c.idempotencyKey,symbol:c.symbol,qty:c.requestedQty}));}catch(error){results.push({closeId:c._id,error:error.message});}}return results;}
 return {closePosition,resumeCloses};
}
module.exports={createPositionCloseService};
