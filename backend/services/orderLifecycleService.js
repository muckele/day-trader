const crypto=require('node:crypto');
const mongoose=require('mongoose');
const OrderIntent=require('../models/OrderIntent');
const BrokerOrder=require('../models/BrokerOrder');
const Fill=require('../models/Fill');
const Exposure=require('./portfolioExposureService');
const SpendingBucket=require('../models/SpendingBucket');
const AccountCapacity=require('../models/AccountCapacity');
const {fillNotionalCents,cents,periodKeys,normalizeOrder,fail}=require('./orderLifecycleFinancial');
const Audit=require('../models/RoboAuditLog');
const Outbox=require('../models/NotificationOutbox');
const {DEFAULT_RECOMMENDATION_UNIVERSE}=require('../config/tradingConfig');
const SOURCE='alpaca-paper';
const terminal=new Set(['filled','canceled','cancelled','expired','rejected']);
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function createOrderLifecycle({broker,ownerId,expectedAccountId,loadSettings=async()=>null,now=()=>new Date(),afterBrokerSubmit,afterReconcile,beforeEntry,beforeAdmission,strictRisk=false,uncertaintyMs=300000}={}) {
 if(!broker||!ownerId||!expectedAccountId)throw fail('Owner and expected paper account are required.');
 const scope={accountId:expectedAccountId,executionSource:SOURCE};
 async function transaction(fn){const s=await mongoose.startSession();try{let result;await s.withTransaction(async()=>{result=await fn(s);});return result;}finally{await s.endSession();}}
 async function freshCashAccount(){
  const started=Date.now();const a=await account();
  if(Date.now()-started>15000 || a.stale===true || a.timestamp && (!Number.isFinite(Date.parse(a.timestamp)) || Math.abs(Date.now()-Date.parse(a.timestamp))>60000))throw fail('Fresh broker cash snapshot required.','CASH_STALE');
  cents(a.cash,true);return a;
 }
 async function synchronizeCash(){return transaction(async s=>{
  const cap=await lock(s);
  if(cap.reservedCents!==0 || await OrderIntent.exists({...scope,side:'buy',status:{$nin:[...terminal]}}).session(s))throw fail('Cash synchronization requires no unresolved entries.','CASH_UNRESOLVED');
  // The account read is inside the same transaction that serializes all reservations/fills.
  // Replacement of the cash baseline is absolute, never a local sale-proceeds increment.
  if(!broker.listOrders)throw fail('Complete broker entry discovery required.');
  const open=await broker.listOrders({status:'open',nested:true,limit:500});
  const flatten=orders=>orders.flatMap(o=>[o,...flatten(o.legs||[])]);
  if(!Array.isArray(open)||open.length>=500||flatten(open).some(o=>o.side==='buy'))throw fail('Unresolved broker entries prevent cash synchronization.','CASH_UNRESOLVED');
  const a=await freshCashAccount(),cash=cents(a.cash,true),cashSyncedAt=new Date();
  if(!Number.isSafeInteger(cash+cap.spentCents))throw fail('Cash exceeds safe monetary precision.');
  await AccountCapacity.updateOne({_id:cap._id},{$set:{cashFloorCents:cash+cap.spentCents,brokerCashCents:cash,cashSyncedAt}},{session:s});
  await Audit.create([{userId:ownerId,eventType:'account_cash_synchronized',payload:{accountId:expectedAccountId,brokerCashCents:cash,historicalSpentCents:cap.spentCents,cashSyncedAt}}],{session:s});
  return {executionSource:SOURCE,brokerCashCents:cash,reservedCents:cap.reservedCents,historicalSpentCents:cap.spentCents,cashSyncedAt};
 });}
 async function owned(id,session){const q=OrderIntent.findOne({...scope,_id:id,userId:String(ownerId)});if(session)q.session(session);const i=await q;if(!i)throw fail('Order intent not found.','ORDER_NOT_FOUND');return i;}
 async function result(i){const order=await BrokerOrder.findOne({...scope,intentId:i._id}).sort({createdAt:-1});return {intent:i,order,brokerOrder:order,executionSource:SOURCE};}
 async function account(){if(broker.mode && broker.mode!=='paper')throw fail('Paper mode required.');const a=await broker.getAccount();if(String(a.id)!==String(expectedAccountId)||a.trading_blocked||a.account_blocked)throw fail('Expected paper account is unavailable.');return a;}
 async function lock(s){return AccountCapacity.findOneAndUpdate({accountId:expectedAccountId},{$inc:{version:1},$setOnInsert:{reservedCents:0}},{upsert:true,new:true,session:s});}
 async function event(intent,s,kind=intent.status){
  await Audit.create([{userId:ownerId,eventType:'order_lifecycle',payload:{intentId:String(intent._id),status:kind,filledQty:intent.filledQty,executionSource:SOURCE,reason:intent.rejectionReason||null}}],{session:s});
  await Outbox.updateOne({eventKey:`lifecycle:${intent._id}:${kind}:${intent.filledQty}`},{$setOnInsert:{accountId:expectedAccountId,environment:'paper',subject:`Paper order ${kind}`,text:`${intent.symbol}: ${kind}; broker-confirmed cumulative shares ${intent.filledQty}.`}},{upsert:true,session:s});
 }
 async function localTransition(id,status,reason,allowed){return transaction(async s=>{await lock(s);const i=await owned(id,s);if(allowed&&!allowed.includes(i.status))return i;i.status=status;if(reason)i.rejectionReason=String(reason).slice(0,500);await i.save({session:s});await event(i,s);return i;});}
 async function adjust(i,deltaReserve,deltaSpent,s){
  await AccountCapacity.updateOne({accountId:expectedAccountId},{$inc:{reservedCents:deltaReserve,spentCents:deltaSpent}},{session:s});
  for(const [period,key]of Object.entries(i.periodKeys||{}))await SpendingBucket.updateOne({accountId:expectedAccountId,period,key},{$inc:{reservedCents:deltaReserve,spentCents:deltaSpent}},{upsert:true,session:s});
 }
 async function reserve(i,amount,settings,a,s){
  const cap=await lock(s);const cash=cents((await freshCashAccount()).cash,true);const floor=Math.min(cap.cashFloorCents??cash,cash+cap.spentCents);
  if(amount+cap.reservedCents+cap.spentCents>floor)throw fail('Insufficient unreserved cash.','CASH_LIMIT');
  await AccountCapacity.updateOne({_id:cap._id},{$set:{cashFloorCents:floor}},{session:s});
  for(const [period,key]of Object.entries(i.periodKeys)){
   const limit=cents(settings?.[`${period==='day'?'daily':period==='week'?'weekly':'monthly'}Limit`]);
   const b=await SpendingBucket.findOne({accountId:expectedAccountId,period,key}).session(s);
   if((b?.spentCents||0)+cap.reservedCents+amount>limit)throw fail(`${period} spending limit exceeded.`,'SPENDING_LIMIT');
  }
  await adjust(i,amount,0,s);i.reservedCents+=amount;return cap;
 }
 async function submitUnlocked({userId,idempotencyKey,origin='manual',orderInput,beforeSubmit,beforeBrokerWrite,dispatchContext}={}){
  if(String(userId)!==String(ownerId))throw fail('Owner authorization required.','OWNER_REQUIRED');
  if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>128)throw fail('Stable idempotency key required.');
  const normalized=normalizeOrder(orderInput),fingerprint=hash(normalized);const key={...scope,environment:'paper',idempotencyKey};
  let previous=await OrderIntent.findOne(key);if(previous){if(previous.payloadFingerprint!==fingerprint)throw fail('Idempotency key payload conflict.','IDEMPOTENCY_CONFLICT');return result(previous);}
  if(beforeAdmission)await beforeAdmission();
  const a=await account(),settings=await loadSettings(userId);
  if(normalized.side==='buy'&&broker.getClock){const clock=await broker.getClock();if(!clock.is_open||!clock.timestamp||Math.abs(now()-new Date(clock.timestamp))>60000)throw fail('Fresh open market clock required.');}
  if(settings?.mode && settings.mode!=='paper')throw fail('Persisted settings must select paper mode.');
  if(normalized.side==='buy'){
   if(!settings)throw fail('Persisted spending settings are required.');
   if(strictRisk){for(const key of ['maxTradeAmount','maxPositionSize','maxDailyLoss'])cents(settings[key]);for(const key of ['maxOpenPositions','maxTradesPerDay'])if(!Number.isSafeInteger(settings[key])||settings[key]<=0)throw fail('Positive risk limits required.');if(!['ACTIVE','active'].includes(a.status)||![a.equity,a.last_equity].every(x=>x!==undefined&&x!==null&&Number.isFinite(Number(x))&&Number(x)>0))throw fail('Fresh complete account risk context required.');}
   if(/^robo/i.test(origin)&&(!settings.isEnabled||settings.pausedUntil&&new Date(settings.pausedUntil)>now()))throw fail('Automated entries disabled or paused.');
   if(!DEFAULT_RECOMMENDATION_UNIVERSE.includes(normalized.symbol))throw fail('Instrument outside the supported paper MVP universe.');
   if(settings.maxDailyLoss && Number(a.equity)<=Number(a.last_equity)-Number(settings.maxDailyLoss))throw fail('Daily loss threshold reached.');
   if(/^robo/i.test(origin)&&beforeEntry)await beforeEntry();
   if(settings.blockedSymbols?.includes(normalized.symbol)||(settings.allowedSymbols?.length&&!settings.allowedSymbols.includes(normalized.symbol)))throw fail('Symbol prohibited by settings.');
   if(settings.maxTradeAmount && normalized.ceilingCents>cents(settings.maxTradeAmount))throw fail('Maximum trade amount exceeded.');
   if(broker.getAsset){const asset=await broker.getAsset(normalized.symbol);if(!asset?.tradable||!['us_equity','equity'].includes(asset.class||asset.asset_class)||asset.status!=='active')throw fail('Instrument unavailable or unsupported.');}
  }
  let positions,exposureSnapshot,i;
  for(let exposureAttempt=0;exposureAttempt<4;exposureAttempt++){
  try{exposureSnapshot=strictRisk&&normalized.side==='buy'?await Exposure.capture({broker,accountId:expectedAccountId}):null;positions=exposureSnapshot?exposureSnapshot.positions:broker.getPositions?await broker.getPositions():[];i=await transaction(async s=>{
   const existing=await OrderIntent.findOne(key).session(s);if(existing){if(existing.payloadFingerprint!==fingerprint)throw fail('Idempotency key payload conflict.','IDEMPOTENCY_CONFLICT');return existing;}
   const [created]=await OrderIntent.create([{...key,userId:String(ownerId),origin,broker:'alpaca',...normalized,controlGeneration:dispatchContext?.generation??settings?.controlGeneration??0,orderInput:normalized,payloadFingerprint:fingerprint,clientOrderId:`mvp-${hash([expectedAccountId,idempotencyKey]).slice(0,40)}`,status:'intent_created',periodKeys:periodKeys(now()),protectionState:normalized.stopLossPrice?{status:'required'}:{status:'not_required'}}],{session:s});
   if(normalized.side==='buy'){const capacity=await reserve(created,normalized.ceilingCents,settings,a,s);if(exposureSnapshot)positions=await Exposure.certify({accountId:expectedAccountId,snapshot:exposureSnapshot,cap:capacity,session:s});if(settings.maxPositionSize){const pending=await OrderIntent.find({...scope,symbol:normalized.symbol,side:'buy',status:{$nin:[...terminal]}}).session(s);const position=positions.find(p=>p.symbol===normalized.symbol);const held=Number(position?.qty||0);const marketValue=position?Number(position.market_value):0;if(strictRisk&&position&&(position.market_value===undefined||position.market_value===null||!Number.isFinite(marketValue)||marketValue<0))throw fail('Complete fresh position market value required.');const heldCents=Number.isFinite(marketValue)?Math.ceil(marketValue*100):held*normalized.limitPrice*100;const outstanding=pending.filter(p=>String(p._id)!==String(created._id)).reduce((n,p)=>n+p.reservedCents,0);if(heldCents+outstanding+normalized.ceilingCents>cents(settings.maxPositionSize))throw fail('Maximum position size exceeded.');}if(strictRisk){const active=await OrderIntent.find({...scope,side:'buy',status:{$nin:[...terminal]}}).session(s);const symbols=new Set([...positions.filter(p=>Number(p.qty)>0).map(p=>p.symbol),...active.map(p=>p.symbol)]);if(symbols.size>settings.maxOpenPositions)throw fail('Maximum open positions exceeded.');const dayCount=await OrderIntent.countDocuments({...scope,side:'buy','periodKeys.day':created.periodKeys.day,status:{$nin:['rejected','intent_created']}}).session(s);if(dayCount>=settings.maxTradesPerDay)throw fail('Maximum daily trades exceeded.');}}
   else {const capacity=await lock(s);if(strictRisk)positions=await Exposure.reducingPositions({accountId:expectedAccountId,positions,cap:capacity,session:s});const available=Number(positions.find(p=>p.symbol===normalized.symbol)?.qty_available??positions.find(p=>p.symbol===normalized.symbol)?.qty??0);const pending=await OrderIntent.find({...scope,symbol:normalized.symbol,side:'sell',status:{$nin:[...terminal]}}).session(s);const outstanding=pending.filter(p=>String(p._id)!==String(created._id)).reduce((n,p)=>n+p.qty-p.filledQty,0);if(normalized.qty+outstanding>available)throw fail('Exit exceeds available position.');}
   created.status='reserved';await created.save({session:s});await event(created,s);return created;
  });break;}catch(e){if(e.code==='EXPOSURE_SNAPSHOT_RETRY'&&exposureAttempt<3)continue;if(e.code===11000){previous=await OrderIntent.findOne(key);if(previous&&previous.payloadFingerprint===fingerprint)return result(previous);}throw e;}
  }
  // Preparing is durable; the final adapter claim after provider preflight grants dispatch.
  try{if(beforeSubmit)await beforeSubmit();await account();if(normalized.side==='buy'){const currentSettings=await loadSettings(userId);if(!currentSettings||currentSettings.mode!=='paper')throw fail('Paper settings unavailable.');for(const field of ['dailyLimit','weeklyLimit','monthlyLimit'])cents(currentSettings[field]);if(strictRisk&&normalized.ceilingCents>cents(currentSettings.maxTradeAmount))throw fail('Maximum trade amount changed.');if(/^robo/i.test(origin)&&(!currentSettings.isEnabled||currentSettings.pausedUntil&&new Date(currentSettings.pausedUntil)>now()))throw fail('Automated entries disabled or paused.');if(broker.getClock){const c=await broker.getClock();if(!c.is_open||!c.timestamp||Math.abs(now()-new Date(c.timestamp))>60000)throw fail('Fresh open market clock required.');}}if(/^robo/i.test(origin)&&beforeEntry)await beforeEntry();}catch(error){await transaction(async s=>{await lock(s);const blocked=await owned(i._id,s);if(blocked.status==='reserved'){await adjust(blocked,-blocked.reservedCents,0,s);blocked.reservedCents=0;blocked.status='rejected';blocked.rejectionReason=error.message;await blocked.save({session:s});await event(blocked,s);}});throw error;}
  const claimed=await transaction(async s=>{await lock(s);const current=await owned(i._id,s);if(current.status!=='reserved')return null;current.status='submitting';current.uncertainSince=now();await current.save({session:s});await event(current,s);return current;});
  if(!claimed)return result(await owned(i._id));
  try{if(beforeSubmit)await beforeSubmit();if(beforeBrokerWrite)await beforeBrokerWrite();}catch(error){await transaction(async s=>{await lock(s);const blocked=await owned(i._id,s);if(blocked.status==='submitting'){await adjust(blocked,-blocked.reservedCents,0,s);blocked.reservedCents=0;blocked.status='rejected';blocked.rejectionReason=String(error.message).slice(0,500);await blocked.save({session:s});await event(blocked,s);}});throw error;}
  let brokerResponded=false;
  try {const assertExecutor=dispatchContext?.assertExecutor||beforeBrokerWrite?.assertExecutor||beforeSubmit?.assertExecutor;const authorize=({payload}={})=>require('./dispatchAuthorization').claimDispatch({id:i._id,accountId:expectedAccountId,userId:ownerId,operation:'submit',payload:payload||normalized,automated:/^robo/i.test(origin)&&normalized.side==='buy',generation:i.controlGeneration||0,lease:dispatchContext?.lease||beforeBrokerWrite?.dispatchLease||beforeSubmit?.dispatchLease,allowedStatuses:['submitting'],assertExecutor});const raw=await broker.submitOrder({...normalized,clientOrderId:i.clientOrderId},{authorize,assertExecutor});brokerResponded=true;if(afterBrokerSubmit)await afterBrokerSubmit(raw);await ingest(i._id,raw.order||raw);}
  catch(e){if(!brokerResponded&&(e.beforeTransport||[400,403,422].includes(e.response?.status))){await transaction(async s=>{await lock(s);const rejected=await owned(i._id,s);await adjust(rejected,-rejected.reservedCents,0,s);rejected.reservedCents=0;rejected.status='rejected';rejected.rejectionReason=String(e.message).slice(0,500);await rejected.save({session:s});await event(rejected,s);});}else await localTransition(i._id,'submission_uncertain',e.message,['submitting']);}
  return result(await owned(i._id));
 }
 async function ingest(id,raw){
  if(!raw?.id)throw fail('Broker acknowledgement lacks order identity.');
  const i=await transaction(async s=>{
   await lock(s);const intent=await owned(id,s);const priorStatus=intent.status;
   if(raw.symbol!==intent.symbol||raw.side!==intent.side)throw fail('Broker order identity mismatch.');
   if(raw.client_order_id!==intent.clientOrderId&&raw.client_order_id!==intent.replacement?.clientOrderId)throw fail('Broker client identity mismatch.');
   let b=await BrokerOrder.findOne({...scope,externalOrderId:String(raw.id)}).session(s);
   if(!b)b=new BrokerOrder({...scope,intentId:intent._id,externalOrderId:String(raw.id),clientOrderId:raw.client_order_id,broker:'alpaca',origin:intent.origin,symbol:intent.symbol,side:intent.side,qty:Number(raw.qty||intent.qty),orderType:intent.orderType});
   const q=Number(raw.filled_qty||0);if(!Number.isFinite(q)||q<0)throw fail('Invalid cumulative quantity.');
   const total=q?fillNotionalCents(q,raw.filled_avg_price):0;
   // Alpaca replacement orders carry cumulative fills; logical totals use the maximum across the chain.
   if(q>b.filledQty){b.filledQty=q;b.filledNotionalCents=total;}
   const deltaQ=Math.max(0,q-intent.filledQty),deltaSpent=deltaQ?Math.max(0,total-intent.filledNotionalCents):0;
   if(deltaQ){await Fill.create([{...scope,broker:'alpaca',intentId:intent._id,brokerOrderId:b._id,externalOrderId:String(raw.id),cumulativeQty:q,symbol:intent.symbol,side:intent.side,qty:deltaQ,price:deltaSpent/deltaQ/100,notional:deltaSpent/100,notionalCents:deltaSpent}],{session:s});intent.filledQty=q;intent.filledNotionalCents=total;await Exposure.invalidate(expectedAccountId,s);}
   const isSuccessor=raw.client_order_id===intent.replacement?.clientOrderId;
   const oldWhileReplacing=intent.replacement && intent.replacement.status!=='rejected' && !isSuccessor;
   if(!terminal.has(b.status))b.status=raw.status||'acknowledged';
   b.replacedBy=raw.replaced_by||b.replacedBy;b.replaces=raw.replaces||b.replaces;await b.save({session:s});
   let release=intent.side==='buy'?Math.min(intent.reservedCents,deltaSpent):0;
   if(terminal.has(b.status)&&!oldWhileReplacing)release=intent.reservedCents;
   if(release||deltaSpent&&intent.side==='buy')await adjust(intent,-release,intent.side==='buy'?deltaSpent:0,s);
   intent.reservedCents-=release;
   if(!oldWhileReplacing && !terminal.has(intent.status))intent.status=terminal.has(b.status)?(b.status==='cancelled'?'canceled':b.status):q>0?'partially_filled':'acknowledged';
   if(isSuccessor){intent.orderInput=intent.replacement.orderInput;intent.qty=intent.orderInput.qty;intent.limitPrice=intent.orderInput.limitPrice;intent.replacement={...intent.replacement,status:'acknowledged',brokerOrderId:String(raw.id)};}
   await intent.save({session:s});
   if(deltaQ||priorStatus!==intent.status){await Audit.create([{userId:ownerId,eventType:'order_lifecycle',payload:{intentId:String(intent._id),brokerOrderId:String(raw.id),status:intent.status,filledQty:intent.filledQty,executionSource:SOURCE}}],{session:s});await Outbox.updateOne({eventKey:`lifecycle:${intent._id}:${intent.status}:${intent.filledQty}`},{$setOnInsert:{accountId:expectedAccountId,environment:'paper',subject:`Paper order ${intent.status}`,text:`${intent.symbol}: ${intent.status}; broker-confirmed cumulative shares ${intent.filledQty}.`}},{upsert:true,session:s});}
   return intent;
  });
  if(afterReconcile)await afterReconcile({intent:i});return i;
 }
 async function reconcile({intentId}){
  let i=await owned(intentId);await account();
  const records=await BrokerOrder.find({...scope,intentId});
  for(const record of records){try{await ingest(intentId,await broker.getOrder(record.externalOrderId));}catch(e){if(e.response?.status!==404)throw e;}}
  for(const clientId of [i.clientOrderId,i.replacement?.clientOrderId].filter(Boolean)){
   try{await ingest(intentId,await broker.getOrderByClientOrderId(clientId));}catch(e){if(e.response?.status!==404&&e.status!==404)throw e;}
  }
  i=await owned(intentId);if(i.stopCancelRequested&&!i.stopCancelAttempted&&!terminal.has(i.status)&&await BrokerOrder.exists({...scope,intentId}))return cancel({intentId,stopRequested:true});if(['submitting','submission_uncertain','replace_pending'].includes(i.status)&&now()-i.uncertainSince>=uncertaintyMs){i=await localTransition(i._id,'reconciliation_required',null,['submitting','submission_uncertain','replace_pending']);}
  const exposure=strictRisk?await Exposure.refresh({broker,accountId:expectedAccountId}):null;return {...await result(i),...(exposure?{exposure}: {})};
 }
 async function cancel({intentId,stopRequested=false,dispatchLease,assertExecutor}={}){
  let i=await owned(intentId);await account();if(terminal.has(i.status))return result(i);
  if(i.replacement && !['acknowledged','rejected'].includes(i.replacement.status))throw fail('Uncertain replacement requires reconciliation before cancellation.');
  const b=await BrokerOrder.findOne({...scope,intentId,externalOrderId:i.replacement?.brokerOrderId}).sort({createdAt:-1});
  const order=b||await BrokerOrder.findOne({...scope,intentId}).sort({createdAt:-1});if(!order)throw fail('No confirmed broker order to cancel.');
  await localTransition(i._id,'cancel_pending');if(stopRequested)await OrderIntent.updateOne({_id:i._id},{$set:{stopCancelAttempted:true}});await broker.cancelOrder(order.externalOrderId,{assertExecutor,authorize:({payload}={})=>require('./dispatchAuthorization').claimDispatch({id:i._id,accountId:expectedAccountId,userId:ownerId,operation:`cancel:${order.externalOrderId}`,payload:payload||{orderId:order.externalOrderId},lease:dispatchLease,assertExecutor})});return reconcile({intentId});
 }
 async function replace({intentId,changes,idempotencyKey}){
  const i=await owned(intentId);if(!idempotencyKey)throw fail('Replacement idempotency key required.');
  if(i.side!=='buy')throw fail('Exit replacements are unsupported; reconcile and cancel before creating a new reducing exit.');
  const normalized=normalizeOrder({...i.orderInput,...changes});const fingerprint=hash(normalized);
  if(normalized.qty>i.qty||normalized.limitPrice>i.limitPrice||normalized.orderType!==i.orderInput.orderType||normalized.timeInForce!==i.orderInput.timeInForce||normalized.stopLossPrice!==i.orderInput.stopLossPrice)throw fail('Replacement must only reduce quantity or limit price; protective terms and order type are immutable.');
  if(i.replacement){if(i.replacement.idempotencyKey===idempotencyKey&&i.replacement.fingerprint===fingerprint)return result(i);throw fail('Only one replacement per logical intent is supported.');}
  if(!['acknowledged','partially_filled'].includes(i.status)||normalized.qty<i.filledQty||normalized.side!==i.side||normalized.symbol!==i.symbol)throw fail('Order cannot be replaced in this state.');
  const a=await account(),settings=await loadSettings(ownerId);if(!settings||settings.mode!=='paper')throw fail('Paper settings required.');if(broker.getClock){const clock=await broker.getClock();if(!clock.is_open||!clock.timestamp||Math.abs(now()-new Date(clock.timestamp))>60000)throw fail('Fresh open market clock required.');}const b=await BrokerOrder.findOne({...scope,intentId}).sort({createdAt:-1});if(!b)throw fail('Confirmed broker order required.');
  const clientOrderId=`mvp-r-${hash([i.clientOrderId,idempotencyKey]).slice(0,38)}`;
  await transaction(async s=>{const current=await owned(intentId,s);if(current.replacement||!['acknowledged','partially_filled'].includes(current.status)||normalized.qty<current.filledQty)throw fail('Replacement state changed; reconcile first.');if(settings?.maxTradeAmount&&normalized.ceilingCents>cents(settings.maxTradeAmount))throw fail('Maximum trade amount exceeded.');const additional=Math.max(0,normalized.ceilingCents-current.filledNotionalCents-current.reservedCents);if(additional)await reserve(current,additional,settings,a,s);else await lock(s);current.replacement={idempotencyKey,fingerprint,clientOrderId,status:'pending',previousBrokerOrderId:b.externalOrderId,previousStatus:current.status,additionalCents:additional,orderInput:normalized};current.status='replace_pending';current.uncertainSince=now();await current.save({session:s});await event(current,s);});
  let brokerResponded=false;
  try{const raw=await broker.replaceOrder(b.externalOrderId,{qty:normalized.qty,limit_price:normalized.limitPrice,client_order_id:clientOrderId},{authorize:({payload}={})=>require('./dispatchAuthorization').claimDispatch({id:i._id,accountId:expectedAccountId,userId:ownerId,operation:`replace:${clientOrderId}`,payload:payload||normalized,automated:false,generation:settings.controlGeneration||0,allowedStatuses:['replace_pending']})});brokerResponded=true;await ingest(intentId,raw.order||raw);}catch(e){if(!brokerResponded&&[400,403,422].includes(e.response?.status)){await transaction(async s=>{await lock(s);const current=await owned(intentId,s);const release=Math.min(current.reservedCents,current.replacement.additionalCents);await adjust(current,-release,0,s);current.reservedCents-=release;current.status=current.filledQty?'partially_filled':'acknowledged';current.replacement={...current.replacement,status:'rejected'};current.rejectionReason=String(e.message).slice(0,500);await current.save({session:s});await event(current,s,'replacement_rejected');});}else await transaction(async s=>{await lock(s);const current=await owned(intentId,s);current.rejectionReason=String(e.message).slice(0,500);await current.save({session:s});await event(current,s,'replacement_uncertain');});}
  return result(await owned(intentId));
 }
 // Persist a negative admission decision under the same unique identity and account
 // transaction as successful admission. A concurrent retry cannot later submit this key.
 async function recordAdmissionRejection(request,error){
  if(!['ORDER_INVALID','CASH_LIMIT','SPENDING_LIMIT','EXPOSURE_UNRESOLVED','EXPOSURE_SNAPSHOT_RETRY'].includes(error.code)||String(request.userId)!==String(ownerId)||typeof request.idempotencyKey!=='string'||!request.idempotencyKey.trim()||request.idempotencyKey.length>128)return;
  let normalized;try{normalized=normalizeOrder(request.orderInput);}catch{return;}
  const key={...scope,environment:'paper',idempotencyKey:request.idempotencyKey},fingerprint=hash(normalized);
  const rejected=await transaction(async s=>{
   await lock(s);
   let current=await OrderIntent.findOne(key).session(s);
   if(!current){
    [current]=await OrderIntent.create([{...key,userId:String(ownerId),origin:request.origin||'manual',broker:'alpaca',...normalized,orderInput:normalized,payloadFingerprint:fingerprint,clientOrderId:`mvp-${hash([expectedAccountId,request.idempotencyKey]).slice(0,40)}`,status:'rejected',rejectionReason:String(error.message).slice(0,500),periodKeys:periodKeys(now())}],{session:s});
    await event(current,s,'admission_rejected');
   }
   if(current.payloadFingerprint!==fingerprint||current.status!=='rejected'||current.filledQty!==0||current.reservedCents!==0||await BrokerOrder.exists({...scope,intentId:current._id}).session(s))return null;
   return current;
  });
  if(rejected){error.admissionOutcome={state:'rejected_without_submission',idempotencyKey:request.idempotencyKey,intentId:String(rejected._id)};error.paperOrder=rejected;}
 }
 async function submit(request={}){
  try{
   if(request.orderInput?.side!=='sell')return await submitUnlocked(request);
   const {withProtectionAccountLock}=require('./orderProtectionService');
   return await withProtectionAccountLock({accountId:expectedAccountId,symbol:String(request.orderInput.symbol||'').toUpperCase()},assertLease=>submitUnlocked({...request,beforeBrokerWrite:assertLease,beforeSubmit:async()=>{if(request.beforeSubmit)await request.beforeSubmit();await assertLease();}}));
  }catch(error){
   // Failure to durably confirm rejection leaves the caller uncertain; never infer it from HTTP status.
   await recordAdmissionRejection(request,error).catch(()=>{});
   throw error;
  }
 }
 const closeService=require('./positionCloseService').createPositionCloseService({broker,ownerId,expectedAccountId,submit:submitUnlocked,reconcile,cancel,beforeAdmission,now});
 return {submit,reconcile,cancel,replace,synchronizeCash,closePosition:closeService.closePosition,resumeCloses:closeService.resumeCloses};
}
function getOrderLifecycle(deps={}) {
 const {createAlpacaBroker}=require('../robotrader/alpacaBroker');const RoboSettings=require('../models/RoboSettings');
 const broker=deps.broker||createAlpacaBroker({mode:'paper'}),ownerId=deps.ownerId||process.env.OWNER_USER_ID,expectedAccountId=deps.expectedAccountId||process.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID;
 const protection=require('./orderProtectionService').createOrderProtection({broker,ownerId,expectedAccountId});
 return createOrderLifecycle({broker,ownerId,expectedAccountId,loadSettings:userId=>RoboSettings.findOne({userId}).lean(),afterReconcile:({intent})=>protection.reconcile({intentId:intent._id}),beforeEntry:()=>protection.assertProtected(),beforeAdmission:()=>require('./executionReadiness').executionReadiness.assertReady(),strictRisk:true,...deps});
}
module.exports={createOrderLifecycle,getOrderLifecycle};
