#!/usr/bin/env node
'use strict';
// Standalone operator tool. No dotenv loading, server, scheduler, or notification sender.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { createAlpacaBroker, getAlpacaConfigForMode } = require('../robotrader/alpacaBroker');
const { verifyPaperAccount } = require('../services/alpacaSafety');
const { getOrderLifecycle } = require('../services/orderLifecycleService');
const { executionReadiness } = require('../services/executionReadiness');
const Intent = require('../models/OrderIntent');
const BrokerOrder = require('../models/BrokerOrder');
const Fill = require('../models/Fill');
const Capacity = require('../models/AccountCapacity');
const Bucket = require('../models/SpendingBucket');
const Settings = require('../models/RoboSettings');
const Q=require('../services/shareQuantity');
const Safety=require('./acceptanceSafety');
const User=require('../models/User');
const Close=require('../models/PositionClose');
const DATA_ORIGIN='https://data.alpaca.markets';
const PAPER_ORIGIN = 'https://paper-api.alpaca.markets';
// Small reviewed technical fixture set: common US equities; no derivatives/leveraged funds.
const FIXTURES = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'AMD', 'XLF', 'XLV', 'XLP'];
const terminal = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected']);
let active = false;
const fail = code => Object.assign(new Error(code), { code, beforeTransport: true });
function requireSafe(condition, code) { if (!condition) throw fail(code); }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function amount(value) {
  requireSafe(/^\d+(\.\d{1,2})?$/.test(String(value)), 'INVALID_AMOUNT');
  const [a,b=''] = String(value).split('.');
  const n=Number(a)*100+Number(b.padEnd(2,'0'));
  requireSafe(Number.isSafeInteger(n)&&n>0,'INVALID_AMOUNT');return n;
}
function parseArgs(argv) {
  const flags=new Set(['dry-run','authorize-external-paper-test']);
  const values=new Set(['paper-origin','symbol-allowlist','max-notional','fill-limit-price','quantity','run-id','candidate','evidence-dir']);
  const out={};
  for(let n=0;n<argv.length;n++){
    const key=argv[n].replace(/^--/,'');
    requireSafe(argv[n].startsWith('--')&&(flags.has(key)||values.has(key))&&!Object.hasOwn(out,key),'INVALID_ARGUMENT');
    out[key]=flags.has(key)?true:argv[++n];requireSafe(out[key]!==undefined&&!String(out[key]).startsWith('--'),'MISSING_ARGUMENT');
  }return out;
}
function plan(options) {
  requireSafe(options['dry-run']===true||options['authorize-external-paper-test']===true,'EXPLICIT_AUTHORIZATION_REQUIRED');
  requireSafe(options['paper-origin']===PAPER_ORIGIN,'EXACT_PAPER_ORIGIN_REQUIRED');
  requireSafe(/^[a-f0-9]{40}$/.test(options.candidate||''),'IMMUTABLE_CANDIDATE_REQUIRED');
  const runId=options['run-id']||randomUUID();requireSafe(/^[a-zA-Z0-9-]{8,40}$/.test(runId),'INVALID_RUN_ID');
  const symbols=String(options['symbol-allowlist']||FIXTURES.join(',')).split(',');
  requireSafe(symbols.length>0&&new Set(symbols).size===symbols.length&&symbols.every(s=>FIXTURES.includes(s)),'INVALID_FIXTURE_LIST');
  requireSafe(String(options.quantity||'1')==='1','ONE_WHOLE_SHARE_REQUIRED');
  const max=amount(options['max-notional']),limit=amount(options['fill-limit-price']);
  requireSafe(limit<=max&&max<=25000,'ACCEPTANCE_NOTIONAL_LIMIT');
  return {origin:PAPER_ORIGIN,candidate:options.candidate,runId,symbols,quantity:1,limitPrice:limit/100,maxNotional:max/100};
}
function inventory(positions) {
  requireSafe(Array.isArray(positions),'INVALID_POSITIONS');
  return positions.map(p=>{
    requireSafe(typeof p.symbol==='string'&&Number.isFinite(Number(p.qty)),'INVALID_POSITION');
    return {symbol:p.symbol,qty:Q.normalize(p.qty),side:p.side||null,cost_basis:p.cost_basis||null,avg_entry_price:p.avg_entry_price||null};
  }).sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
function flatten(orders) {
  requireSafe(Array.isArray(orders)&&orders.length<500,'INCOMPLETE_ORDER_DISCOVERY');
  return orders.flatMap(o=>{requireSafe(o&&typeof o.id==='string'&&typeof o.symbol==='string'&&typeof o.status==='string','INVALID_ORDER');return [o,...flatten(o.legs||[])];});
}
function orderSummary(o) { return {id:o.id,clientOrderId:o.client_order_id,symbol:o.symbol,side:o.side,qty:o.qty,status:o.status,filledQty:o.filled_qty}; }
async function run(options,{env=process.env,onEvidence=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),pollAttempts=10,pollDelayMs=1000,now=()=>Date.now()}={}) {
  const p=plan(options);
  if(options['dry-run'])return {...p,dryRun:true,networkRequests:0};
  requireSafe(!active,'ACCEPTANCE_ALREADY_RUNNING');active=true;
  const report={...p,startedAt:new Date().toISOString(),decision:'EXTERNAL_ALPACA_PAPER_BLOCKED',requests:[],orders:[],mode:'paper'};
  const save=()=>onEvidence(JSON.parse(JSON.stringify(report)));
  let requestInterceptor,responseInterceptor,connected=false,mutated=false;
  const ownedClients=new Map(),ownedIds=new Set(),budget=Safety.mutationBudget();
  let latestClock,selectedMarket,cancelLimit,symbol;
  let broker,lifecycle,opening,baseline,baselineOrders,scope;
  try {
    requireSafe(Number.isInteger(pollAttempts)&&pollAttempts>=1&&pollAttempts<=30&&pollDelayMs>=0&&pollDelayMs<=2000,'INVALID_POLL_BOUND');
    const config=getAlpacaConfigForMode('paper',env),configHash=hash(config);
    requireSafe(['APCA_PAPER_BASE_URL','ALPACA_PAPER_BASE_URL','APCA_BASE_URL','ALPACA_BASE_URL'].some(k=>env[k]),'EXPLICIT_BASE_URL_REQUIRED');
    requireSafe(config.baseUrl===PAPER_ORIGIN&&config.mode==='paper','EXACT_PAPER_ORIGIN_REQUIRED');
    requireSafe(config.apiKey&&config.apiSecret,'PAPER_CREDENTIALS_REQUIRED');
    requireSafe(config.expectedAccountId,'PAPER_ACCOUNT_BINDING_REQUIRED');
    requireSafe(!String(config.apiKey).startsWith('AK'),'LIVE_CREDENTIAL_PROHIBITED');
    const assertConfig=()=>requireSafe(hash(getAlpacaConfigForMode('paper',env))===configHash,'ACCOUNT_CONFIGURATION_DRIFT');
    // Synchronous interceptor adds no awaited authorization-to-transport gap.
    requestInterceptor=axios.interceptors.request.use(config=>{
      assertConfig();const url=new URL(config.url),method=String(config.method).toUpperCase();
      requireSafe((url.origin===PAPER_ORIGIN||url.origin===DATA_ORIGIN&&method==='GET'&&['/v2/stocks/quotes/latest',`/v2/stocks/${symbol}/bars`].includes(url.pathname))&&!url.username&&!url.password&&config.maxRedirects===0&&url.pathname.startsWith('/v2/'),'UNTRUSTED_TRANSPORT');
      if(method!=='GET'){
        executionReadiness.assertReady();
        const session=Safety.sessionCheck(latestClock,now());requireSafe(session.eligible,session.reason);
        if(method==='POST'){
          const body=typeof config.data==='string'?JSON.parse(config.data):config.data;
          const expected=ownedClients.get(body?.client_order_id);
          requireSafe(url.pathname==='/v2/orders'&&expected&&body.symbol===expected.symbol&&body.side===expected.side&&Q.compare(body.qty,expected.qty)===0,'UNOWNED_WRITE');
          requireSafe(body.time_in_force==='day'&&!body.extended_hours,'UNSUPPORTED_ACCEPTANCE_TERMS');
          if(body.side==='buy'){requireSafe(selectedMarket&&now()-selectedMarket.quoteAt<=Safety.FRESH_MS,'FRESH_QUOTE_REQUIRED');requireSafe(amount(body.limit_price)<=amount(p.maxNotional),'ACCEPTANCE_NOTIONAL_LIMIT');if(expected.stage==='cancel')Safety.validateCancel(body.limit_price,selectedMarket);}
          budget.submit(body.client_order_id);
        }else {const id=decodeURIComponent(url.pathname.split('/').pop());requireSafe(method==='DELETE'&&ownedIds.has(id)&&/^\/v2\/orders\/[^/]+$/.test(url.pathname),'UNOWNED_CLEANUP');budget.cancel(id);}
        report.budget=budget.snapshot();
        mutated=true;
      }
      const body=typeof config.data==='string'?JSON.parse(config.data):config.data;
      config.acceptanceRow={method,hostname:url.hostname,path:url.pathname,startedAt:new Date().toISOString(),...(method==='POST'?{clientOrderId:body.client_order_id,payload:body}:{})};
      report.requests.push(config.acceptanceRow);save();return config;
    },error=>{throw error;},{synchronous:true});
    const observed=(response,error)=>{
      const row=response?.config?.acceptanceRow||error?.config?.acceptanceRow;
      if(row){row.httpStatus=response?.status||null;row.xRequestId=response?.headers?.['x-request-id']||null;row.endedAt=new Date().toISOString();save();}
    };
    responseInterceptor=axios.interceptors.response.use(r=>{observed(r);return r;},e=>{observed(e.response,e);throw e;});
    requireSafe(mongoose.isValidObjectId(env.OWNER_USER_ID),'OWNER_REQUIRED');
    scope={accountId:config.expectedAccountId,userId:env.OWNER_USER_ID,executionSource:'alpaca-paper'};
    if(mongoose.connection.readyState!==1){
      // Existing local application DB/settings only. Never initialize a parallel paper ledger.
      requireSafe(/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]+(?:\?.*)?$/.test(env.MONGO_LOCAL_URI||env.MONGO_URI||''),'EXPLICIT_LOCAL_DATABASE_REQUIRED');
      await mongoose.connect(env.MONGO_LOCAL_URI||env.MONGO_URI,{serverSelectionTimeoutMS:5000});connected=true;
    }
    requireSafe(await User.exists({_id:env.OWNER_USER_ID}),'OWNER_REQUIRED');
    const settings=await Settings.findOne({userId:env.OWNER_USER_ID}).lean();
    requireSafe(settings&&settings.mode==='paper'&&!settings.isEnabled&&!settings.enabled,'DISABLE_AUTOMATION_BEFORE_ACCEPTANCE');
    requireSafe(settings.enabled===false&&settings.isEnabled===false,'DISABLE_AUTOMATION_BEFORE_ACCEPTANCE');
    requireSafe(await mongoose.connection.collection('robolocks').countDocuments({lockedUntil:{$gt:new Date(now())}})===0,'ACTIVE_WORKER_LEASE');
    requireSafe(await mongoose.connection.collection('orderprotectionlocks').countDocuments({expiresAt:{$gt:new Date(now())}})===0,'ACTIVE_EXIT_LEASE');
    requireSafe(await Intent.countDocuments({...scope,status:{$nin:[...terminal]}})===0,'UNRESOLVED_OWNER_INTENTS');
    const generation=settings.controlGeneration||0;
    const checkControl=async()=>{assertConfig();const current=await Settings.findOne({userId:env.OWNER_USER_ID}).lean();requireSafe(current&&!current.isEnabled&&!current.enabled&&current.mode==='paper'&&(current.controlGeneration||0)===generation,'CONTROL_GENERATION_CHANGED');};
    await executionReadiness.bootstrap(()=>{const indexes=require('../services/tradingIndexService');return indexes.ensureTradingIndexes({models:[...indexes.TRADING_INDEX_MODELS,...indexes.STRATEGY_TELEMETRY_INDEX_MODELS,mongoose.models.RecommendationSnapshot]});},()=>mongoose.connection.collection('operationalreadiness').updateOne({_id:'external-acceptance'},{$set:{checkedAt:new Date()}},{upsert:true,writeConcern:{w:'majority'}}));
    executionReadiness.assertReady();
    const capacityBefore=await Capacity.findOne({accountId:config.expectedAccountId}).lean();
    requireSafe(!(capacityBefore?.reservedCents>0),'UNRESOLVED_LOCAL_RESERVATIONS');
    const spentBefore=capacityBefore?.spentCents||0;
    broker=createAlpacaBroker({mode:'paper',env});
    const account=await broker.getAccount();await verifyPaperAccount(config,async()=>account);
    requireSafe(account.status==='ACTIVE'&&account.currency==='USD'&&account.trading_blocked===false&&account.account_blocked===false&&account.trade_suspended_by_user!==true&&Number(account.cash)>=p.maxNotional,'ACCOUNT_NOT_ELIGIBLE');
    report.account={maskedId:'***'+account.id.slice(-6),status:account.status,currency:account.currency,tradingBlocked:false};
    const clock=await broker.getClock();latestClock=clock;const session=Safety.sessionCheck(clock,now());
    report.clock=clock;
    const positions=await broker.getPositions();baseline=inventory(positions);
    baselineOrders=flatten(await broker.listOrders({status:'open',nested:true,limit:500}));
    report.baseline={positions:baseline,openOrders:baselineOrders.map(orderSummary),positionsHash:hash(baseline),ordersHash:hash(baselineOrders.map(orderSummary))};
    const market=async fixture=>{
      const options={headers:{'APCA-API-KEY-ID':config.apiKey,'APCA-API-SECRET-KEY':config.apiSecret},maxRedirects:0,timeout:10000};symbol=fixture;
      const quote=await axios.get(`${DATA_ORIGIN}/v2/stocks/quotes/latest`,{...options,params:{symbols:fixture,feed:'iex'}});
      const bars=await axios.get(`${DATA_ORIGIN}/v2/stocks/${fixture}/bars`,{...options,params:{timeframe:'1Min',start:new Date(now()-6*60000).toISOString(),end:new Date(now()).toISOString(),limit:6,feed:'iex'}});
      return Safety.validateMarket({quote:quote.data?.quotes?.[fixture],bars:bars.data?.bars},now());
    };
    symbol=null;
    for(const fixture of p.symbols){
      if(positions.some(x=>x.symbol===fixture&&Q.positive(x.qty))||baselineOrders.some(x=>x.symbol===fixture))continue;
      const asset=await broker.getAsset(fixture);
      if(asset.symbol!==fixture||asset.status!=='active'||asset.tradable!==true||asset.class!=='us_equity'||asset.halted===true||asset.leveraged===true||asset.inverse===true)continue;
      try{selectedMarket=await market(fixture);requireSafe(selectedMarket.askCents<=amount(p.maxNotional)&&selectedMarket.askCents<=amount(settings.maxTradeAmount)&&selectedMarket.askCents<=amount(settings.maxPositionSize),'ACCEPTANCE_NOTIONAL_LIMIT');cancelLimit=Safety.cancelPrice(selectedMarket);symbol=fixture;break;}catch(error){if(['ACCOUNT_CONFIGURATION_DRIFT','UNTRUSTED_TRANSPORT'].includes(error.code))throw error;symbol=null;}
    }
    requireSafe(symbol,'NO ELIGIBLE ACCEPTANCE FIXTURE UNDER $250');report.fixture=symbol;report.fixtureMarket=selectedMarket;report.cancelLimitPrice=cancelLimit;
    if(!session.eligible){report.decision='EXTERNAL_ALPACA_PAPER_PARTIAL';report.reason=session.reason;return report;}
    const checkMutation=async(stage)=>{
      await checkControl();latestClock=await broker.getClock();const current=Safety.sessionCheck(latestClock,now());requireSafe(current.eligible,current.reason);
      if(stage!=='close'){selectedMarket=await market(symbol);requireSafe(selectedMarket.askCents<=amount(p.maxNotional),'ACCEPTANCE_NOTIONAL_LIMIT');if(stage==='cancel')Safety.validateCancel(cancelLimit,selectedMarket);}
    };
    const makeLifecycle=()=>getOrderLifecycle({broker,ownerId:env.OWNER_USER_ID,expectedAccountId:config.expectedAccountId});
    lifecycle=makeLifecycle();
    const key=n=>`dtacc-${p.candidate.slice(0,7)}-${p.runId}-${n}`;
    requireSafe(!await Intent.exists({...scope,idempotencyKey:{$in:[key(0),key(1),key(2)]}}),'RUN_ALREADY_EXISTS_RECONCILE_REQUIRED');
    const capture=async intent=>{
      const record=await BrokerOrder.findOne({accountId:scope.accountId,executionSource:scope.executionSource,intentId:intent._id}).sort({createdAt:-1}).lean();
      if(record){ownedIds.add(record.externalOrderId);const client=ownedClients.get(intent.clientOrderId);if(client)client.brokerId=record.externalOrderId;}
      const entry={intentId:String(intent._id),clientOrderId:intent.clientOrderId,brokerOrderId:record?.externalOrderId||null,brokerOrderRecordId:record?String(record._id):null,runId:p.runId,symbol:intent.symbol,side:intent.side,qty:intent.qty,status:intent.status,filledQty:intent.filledQty,filledNotionalCents:intent.filledNotionalCents,reservedCents:intent.reservedCents};
      report.orders.push(entry);save();return entry;
    };
    const submit=async(n,orderInput)=>{budget.assertSubmit(key(n));await checkMutation(n===0?'cancel':'open');return lifecycle.submit({userId:env.OWNER_USER_ID,idempotencyKey:key(n),origin:'manual',orderInput,beforeSubmit:async()=>{
      await checkControl();const i=await Intent.findOne({...scope,idempotencyKey:key(n)});requireSafe(i,'CANONICAL_INTENT_REQUIRED');
      requireSafe(i.clientOrderId.length<=48,'CLIENT_ID_LENGTH');ownedClients.set(i.clientOrderId,{symbol:i.symbol,side:i.side,qty:i.qty,stage:n===0?'cancel':'open',intent:i});await capture(i);
    }});};
    const ownership=(raw,i)=>{requireSafe(raw&&typeof raw.id==='string'&&/^[a-zA-Z0-9-]+$/.test(raw.id)&&raw.client_order_id===i.clientOrderId&&(!ownedClients.get(i.clientOrderId)?.brokerId||ownedClients.get(i.clientOrderId).brokerId===raw.id)&&raw.symbol===i.symbol&&raw.side===i.side&&Q.compare(raw.qty,i.qty)===0&&raw.type===i.orderType&&(i.orderType!=='limit'||Number(raw.limit_price)===i.limitPrice),'BROKER_OWNERSHIP_MISMATCH');ownedIds.add(raw.id);return raw;};
    const originalSubmit=broker.submitOrder,originalCancel=broker.cancelOrder,originalGet=broker.getOrder,originalLookup=broker.getOrderByClientOrderId;
    broker.submitOrder=async(input,options)=>{
      if(input.side==='sell'){
        const close=await Close.findOne({accountId:scope.accountId,idempotencyKey:key(2)});const i=await Intent.findOne({...scope,clientOrderId:input.clientOrderId});
        requireSafe(close&&i&&i.idempotencyKey===`close:${close._id}`&&Q.compare(i.qty,report.acceptancePositionObserved?.qty??0)===0,'UNOWNED_REDUCING_INTENT');
        ownedClients.set(i.clientOrderId,{symbol:i.symbol,side:i.side,qty:i.qty,stage:'close',intent:i});await capture(i);
      }
      const expected=ownedClients.get(input.clientOrderId);requireSafe(expected,'UNOWNED_WRITE');budget.assertSubmit(input.clientOrderId);
      return originalSubmit(input,{...options,authorize:async context=>{await checkMutation(expected.stage);return options.authorize(context);}});
    };
    broker.cancelOrder=(id,options)=>{budget.assertCancel(id);return originalCancel(id,{...options,authorize:async context=>{await checkMutation('close');return options.authorize(context);}});};
    broker.getOrder=async id=>{const raw=await originalGet(id),client=ownedClients.get(raw?.client_order_id);if(client)ownership(raw,client.intent);else requireSafe(!ownedIds.has(id),'BROKER_OWNERSHIP_MISMATCH');return raw;};
    broker.getOrderByClientOrderId=async id=>{const raw=await originalLookup(id),client=ownedClients.get(id);if(client)ownership(raw,client.intent);return raw;};
    const poll=async(i,wanted)=>{
      for(let n=0;n<pollAttempts;n++){
        const raw=ownership(await broker.getOrderByClientOrderId(i.clientOrderId),i);
        const outcome=await lifecycle.reconcile({intentId:i._id});i=outcome.intent;await capture(i);
        requireSafe(!outcome.exposure||outcome.exposure.state==='coherent','EXPOSURE_RECONCILIATION_REQUIRED');
        if(wanted.has(i.status))return i;
        if(terminal.has(i.status))throw fail('UNEXPECTED_TERMINAL_STATUS');
        if(n+1<pollAttempts)await sleep(pollDelayMs);
      }return null;
    };
    const cancel=async i=>{
      ownership(await broker.getOrderByClientOrderId(i.clientOrderId),i);
      await lifecycle.cancel({intentId:i._id});
      const done=await poll(i,new Set(['canceled','cancelled','expired','filled']));
      requireSafe(done&&done.reservedCents===0,'CANCELLATION_UNCONFIRMED');report.cancellationConfirmed=true;return done;
    };
    const cleanup=async filled=>{
      const owned=Q.normalize(filled.filledQty);requireSafe(Q.positive(owned),'EXACT_CLEANUP_QUANTITY_UNPROVEN');
      const current=await broker.getPositions(),holding=current.find(x=>x.symbol===symbol);
      requireSafe(Q.compare(holding?.qty??0,owned)===0&&Q.compare(holding?.qty_available??holding?.qty??0,owned)===0,'EXACT_CLEANUP_QUANTITY_UNPROVEN');
      requireSafe(hash(inventory(current.filter(x=>x.symbol!==symbol)))===hash(baseline),'UNRELATED_POSITIONS_CHANGED');
      report.acceptancePositionObserved={symbol,qty:Q.persist(owned)};
      const cap=await Capacity.findOne({accountId:scope.accountId}).lean();budget.assertSubmit(key(2));await checkMutation('close');
      const exit=await lifecycle.closePosition({userId:env.OWNER_USER_ID,idempotencyKey:key(2),symbol,qty:owned});requireSafe(exit.intent,'REDUCING_ADMISSION_BLOCKED');await capture(exit.intent);
      const closed=await poll(exit.intent,new Set(['filled']));if(!closed){await cancel(exit.intent);throw fail('REDUCING_FILL_TIMEOUT');}
      const closeFills=await Fill.find({accountId:scope.accountId,executionSource:scope.executionSource,intentId:closed._id}).lean();requireSafe(closeFills.length===1&&Q.compare(closeFills[0].qty,owned)===0,'CLOSING_FILL_MISMATCH');
      const postPositions=inventory(await broker.getPositions()),postOrders=flatten(await broker.listOrders({status:'open',nested:true,limit:500}));
      requireSafe(hash(postPositions)===hash(baseline),'BASELINE_POSITION_NOT_RESTORED');requireSafe(hash(postOrders.map(orderSummary))===hash(baselineOrders.map(orderSummary)),'BASELINE_ORDERS_CHANGED');
      const finalCap=await Capacity.findOne({accountId:scope.accountId}).lean();requireSafe(finalCap.reservedCents===0&&finalCap.spentCents===cap.spentCents&&finalCap.portfolioObservation?.state==='coherent','FINAL_ACCOUNTING_MISMATCH');
      const buckets=await Bucket.find({accountId:scope.accountId}).lean();requireSafe(buckets.every(b=>b.reservedCents===0),'RESERVATION_NOT_RELEASED');
      report.cleanup={confirmed:true,qty:Q.persist(owned),closingFillCount:closeFills.length,positionHash:hash(postPositions),openOrdersHash:hash(postOrders.map(orderSummary)),reservedCents:finalCap.reservedCents,spentCents:finalCap.spentCents};
    };
    const canceledOrder=await submit(0,{symbol,side:'buy',qty:1,orderType:'limit',limitPrice:cancelLimit,timeInForce:'day'});await capture(canceledOrder.intent);
    requireSafe(!['rejected','reconciliation_required'].includes(canceledOrder.intent.status),'CANONICAL_ADMISSION_REJECTED');
    lifecycle=makeLifecycle();report.reloadedExecutionContext=true;
    ownership(await broker.getOrderByClientOrderId(canceledOrder.intent.clientOrderId),canceledOrder.intent);
    let cancellation=(await lifecycle.reconcile({intentId:canceledOrder.intent._id})).intent;await capture(cancellation);
    if(!terminal.has(cancellation.status))cancellation=await cancel(cancellation);
    if(Q.positive(cancellation.filledQty)){
      report.unexpectedFill={stage:'standalone-cancel',qty:cancellation.filledQty,classification:'UNEXPECTED_MARKET_MOVEMENT'};
      await cleanup(cancellation);report.decision='EXTERNAL_ALPACA_PAPER_PARTIAL';report.reason='UNEXPECTED CANCELLATION FIXTURE FILL — CLEANUP CONFIRMED';return report;
    }
    requireSafe(['canceled','cancelled','expired'].includes(cancellation.status)&&cancellation.reservedCents===0,'CANCELLATION_UNCONFIRMED');
    const cancelFills=await Fill.countDocuments({intentId:cancellation._id});const canceledCap=await Capacity.findOne({accountId:scope.accountId}).lean();requireSafe(cancelFills===0&&canceledCap.reservedCents===0&&canceledCap.spentCents===spentBefore&&canceledCap.portfolioObservation?.state==='coherent','CANCEL_ACCOUNTING_MISMATCH');
    report.standaloneCancellation={confirmed:true,fillCount:0,intentId:String(cancellation._id),clientOrderId:cancellation.clientOrderId,reservedCents:0};
    const submitted=await submit(1,{symbol,side:'buy',qty:1,orderType:'limit',limitPrice:p.limitPrice,timeInForce:'day'});opening=submitted.intent;await capture(opening);
    requireSafe(!['rejected','reconciliation_required'].includes(opening.status),'CANONICAL_ADMISSION_REJECTED');
    lifecycle=makeLifecycle();let filled=await poll(opening,new Set(['filled']));
    if(!filled){const stopped=await cancel(opening);if(Q.positive(stopped.filledQty))await cleanup(stopped);throw fail('OPENING_FILL_TIMEOUT');}
    const fills=await Fill.find({accountId:scope.accountId,executionSource:scope.executionSource,intentId:filled._id}).lean();requireSafe(fills.length===1&&Q.compare(fills[0].qty,1)===0&&Q.compare(filled.filledQty,1)===0&&filled.reservedCents===0,'FILL_ACCOUNTING_MISMATCH');
    const cap=await Capacity.findOne({accountId:scope.accountId}).lean();requireSafe(cap.reservedCents===0&&cap.spentCents===spentBefore+filled.filledNotionalCents&&cap.portfolioObservation?.state==='coherent','SPENDING_EXPOSURE_MISMATCH');
    report.opening={fillCount:fills.length,qty:filled.filledQty,notionalCents:filled.filledNotionalCents,spentDeltaCents:cap.spentCents-spentBefore,exposureState:cap.portfolioObservation.state};
    await cleanup(filled);
    report.decision='EXTERNAL_ALPACA_PAPER_VERIFIED';return report;
  }catch(error){
    report.decision=mutated?'EXTERNAL_ALPACA_PAPER_FAILED':'EXTERNAL_ALPACA_PAPER_BLOCKED';
    report.reason=error.code==='EXPOSURE_UNRESOLVED'&&/unattributed active broker order/.test(error.message)?'UNATTRIBUTED ACTIVE BROKER ORDER':String(error.code||'ACCEPTANCE_CHECK_FAILED').replace(/[^A-Z0-9_$ ]/g,'').slice(0,100);
    // No speculative retry/compensating write after an unknown failure. Preserve durable IDs.
    report.operatorReconciliationRequired=mutated&&!report.cleanup?.confirmed;
    if(mutated&&broker){
      try{
        const positions=inventory(await broker.getPositions());
        const orders=flatten(await broker.listOrders({status:'open',nested:true,limit:500}));
        report.remaining={positions,acceptanceOpenOrders:orders.filter(o=>ownedClients.has(o.client_order_id)||ownedIds.has(o.id)).map(orderSummary),positionsMatchBaseline:baseline?hash(positions)===hash(baseline):false};
      }catch{report.remaining={observationUnavailable:true};}
    }
    return report;
  }finally{
    if(requestInterceptor!==undefined)axios.interceptors.request.eject(requestInterceptor);
    if(responseInterceptor!==undefined)axios.interceptors.response.eject(responseInterceptor);
    report.budget=budget.snapshot();report.endedAt=new Date().toISOString();save();active=false;
    if(connected)await mongoose.disconnect();
  }
}
if(require.main===module){
  (async()=>{
    const options=parseArgs(process.argv.slice(2));
    const actual=require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'}).trim();
    requireSafe(options.candidate===actual,'CANDIDATE_MISMATCH');
    requireSafe(options['dry-run']||options['evidence-dir'],'EVIDENCE_DIRECTORY_REQUIRED');
    if(options['evidence-dir'])requireSafe(!fs.existsSync(path.join(options['evidence-dir'],'report.json')),'EVIDENCE_ALREADY_EXISTS');
    const onEvidence=options['evidence-dir']?r=>{fs.mkdirSync(options['evidence-dir'],{recursive:true,mode:0o700});fs.writeFileSync(path.join(options['evidence-dir'],'report.json'),JSON.stringify(r,null,2)+'\n',{mode:0o600});}:()=>{};
    const report=await run(options,{onEvidence});console.log(JSON.stringify(report,null,2));
    if(!report.dryRun&&report.decision!=='EXTERNAL_ALPACA_PAPER_VERIFIED')process.exitCode=2;
  })().catch(error=>{console.error(error.code||'ACCEPTANCE_FAILED');process.exitCode=1;});
}
module.exports={run,plan,parseArgs};
