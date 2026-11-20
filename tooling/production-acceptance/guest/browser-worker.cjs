'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { chromium } = require('playwright');
const { validateAssetResponse, importBrowserAssetBundle } = require('./receipts.cjs');
const { bindBrowserWorkerChannel } = require('./role-ports.cjs');
// T13 I-4: the single copy of the readiness checks (observation.cjs loads no controller module).
const { readinessPredicate } = require('./observation.cjs');
const RUNTIME_PINS = require('../package.json').acceptanceRuntime;

function fail(code, cause) { const error = new Error(code, cause ? { cause } : undefined); error.code = code; throw error; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(left, right) { return canonical(left) === canonical(right); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('FRAME_DENIED');
}
function safe(value, minimum = 1) { return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum; }
function sessionAction(action,payload) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('ACTION_DENIED');
  if(action==='LOGIN_SESSION'){
    exact(payload,['ownerId','password','username']);
    if(typeof payload.ownerId!=='string'||payload.ownerId.length<1||payload.ownerId.length>256||/[\0\r\n]/.test(payload.ownerId)||
       typeof payload.username!=='string'||payload.username.length<1||payload.username.length>512||/[\0\r\n]/.test(payload.username)||
       typeof payload.password!=='string'||payload.password.length<1||payload.password.length>4096||/[\0\r\n]/.test(payload.password))fail('ACTION_DENIED');
    return;
  }
  if(action==='SESSION_OBSERVATION'&&Reflect.ownKeys(payload).length===0)return;
  if(action==='SESSION_READINESS'){
    exact(payload,['phase','sequence']);
    if(!['OBSERVE_BEFORE_RESTART','OBSERVE_AFTER_RESTART'].includes(payload.phase)||!safe(payload.sequence))fail('ACTION_DENIED');
    return;
  }
  if(action==='OBSERVE_VIEW'){
    exact(payload,['phase','view']);
    if(!['OBSERVE_BEFORE_RESTART','OBSERVE_AFTER_RESTART'].includes(payload.phase)||
       !['ROBO','PORTFOLIO','ACTIVITY'].includes(payload.view)||
       payload.phase==='OBSERVE_AFTER_RESTART'&&payload.view!=='ROBO')fail('ACTION_DENIED');
    return;
  }
  fail('ACTION_DENIED');
}
function meResponse(response,origin) {
  try {const url=new URL(response.url()),request=typeof response.request==='function'?response.request():null;
    return url.origin===origin&&url.pathname==='/api/me'&&!url.search&&!url.hash&&typeof response.status==='function'&&response.status()===200&&
      (!request||typeof request.method!=='function'||request.method()==='GET');}
  catch{return false;}
}
// The one owner check, for the login's /api/me and for each SESSION_READINESS /api/me.
function ownerMatches(body,expectedOwner) {
  return !!body&&typeof body==='object'&&!Array.isArray(body)&&!!body.user&&typeof body.user==='object'&&!Array.isArray(body.user)&&
    body.user.id===expectedOwner.id&&body.user.username===expectedOwner.username;
}
async function sessionSnapshot(context,response,backend,expectedOwner,key) {
  if(!response||typeof response.status!=='function'||response.status()!==200||typeof response.json!=='function')fail('OWNER_MISMATCH');
  let body;try{body=await response.json();}catch{fail('OWNER_MISMATCH');}
  if(!ownerMatches(body,expectedOwner))fail('OWNER_MISMATCH');
  return sessionFingerprint(context,backend,key);
}
async function sessionFingerprint(context,backend,key) {
  const url=new URL(backend),cookies=await context.cookies([backend]),matches=cookies.filter(cookie=>cookie&&cookie.name==='daytrader_session');
  if(matches.length!==1)fail('COOKIE_INVALID');const cookie=matches[0];
  if(typeof cookie.value!=='string'||cookie.value.length<1||cookie.value.length>4096||cookie.domain!==url.hostname||cookie.domain.startsWith('.')||
      cookie.path!=='/'||cookie.secure!==true||cookie.httpOnly!==true||cookie.sameSite!=='None')fail('COOKIE_INVALID');
  const fingerprint=createHmac('sha256',key).update('acceptance:session-cookie:v1\0','ascii').update(cookie.value,'utf8').digest('hex');
  return Object.freeze({fingerprint});
}
const VIEW_SPECS=Object.freeze({
  ROBO:Object.freeze({path:'/robo',nav:'Robo Trader',heading:'RoboTrader',routes:Object.freeze([
    ['/api/robotrader/settings',[]],['/api/robotrader/decisions',[['environment','paper'],['limit','25']]],
    ['/api/robotrader/orders',[['environment','paper'],['limit','25']]],['/api/robotrader/performance',[['environment','paper']]],
    ['/api/robotrader/audit',[['limit','25']]],['/api/robotrader/health',[]],
    ['/api/robotrader/reconciliation-status',[['environment','paper']]],
  ])}),
  PORTFOLIO:Object.freeze({path:'/portfolio',nav:'Portfolio',heading:'Alpaca Paper',routes:Object.freeze([
    ['/api/paper-trades/account',[]],['/api/paper-trades/equity',[]],
  ])}),
  ACTIVITY:Object.freeze({path:'/activity',nav:'Activity',heading:'Orders & Trades',routes:Object.freeze([
    ['/api/paper-trades/orders',[]],['/api/paper-trades/trades',[]],['/api/robotrader/notifications',[]],
  ])}),
});
// T13 I-2 (C9): the only request headers withheld from the ROUTE facts. Every
// other header reaches the controller, where the route policy's allowlist decides.
const BROWSER_GENERATED_HEADERS=Object.freeze(['user-agent','accept-language','accept-encoding','referer','cookie','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','sec-fetch-user','upgrade-insecure-requests']);
// Credential and method-override headers never leave the worker: local abort, no ROUTE frame.
const LOCAL_ABORT_HEADERS=Object.freeze(['authorization','proxy-authorization','x-http-method-override','x-method-override']);
// T13 I-3: every SPA document (/, /login and the fixed view paths) carries the
// index.html bytes, so its response is validated against the /index.html entry.
const SPA_DOCUMENT_PATHS=Object.freeze(['/','/login',...Object.values(VIEW_SPECS).map(spec=>spec.path)]);
const INDEX_ENTRY_PATH='/index.html';
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function finite(value){return typeof value==='number'&&Number.isFinite(value);}
function textValue(value){return typeof value==='string'&&value.length>0;}
function optionalText(value){return value===null||value===undefined||textValue(value);}
function numeric(value){return finite(value)||typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value));}
function optionalNumeric(value){return value===null||value===undefined||numeric(value);}
function instant(value){return textValue(value)&&Number.isFinite(Date.parse(value));}
function optionalInstant(value){return value===null||value===undefined||instant(value);}
function count(value){return Number.isSafeInteger(value)&&value>=0;}
function queryPairs(url){return [...url.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));}
function viewResponse(response,backend,path,query){
  try{const url=new URL(response.url()),request=typeof response.request==='function'?response.request():null;
    return url.origin===backend&&url.pathname===path&&!url.hash&&equal(queryPairs(url),query)&&
      typeof response.status==='function'&&response.status()===200&&(!request||typeof request.method!=='function'||request.method()==='GET');}
  catch{return false;}
}
function sourceRows(rows,kind){
  if(!Array.isArray(rows))return false;
  return rows.every(row=>{
    if(!plain(row)||row.executionSource!=='alpaca-paper'||row.broker!=='alpaca'||!textValue(row._id)||!textValue(row.symbol)||
       !textValue(row.side)||!numeric(row.qty))return false;
    if(kind==='order')return textValue(row.status)&&textValue(row.orderType)&&numeric(row.filledQty)&&optionalNumeric(row.fillPrice)&&
      [row.filledAt,row.updatedAt,row.createdAt].some(instant);
    return instant(row.filledAt)&&numeric(row.price)&&optionalNumeric(row.realizedPnl);
  });
}
// C9 SESSION_READINESS: a fixed GET's response, matched by origin, path and method only, so that a
// non-200 readiness answer (503) is observed and classified rather than timed out.
function fixedResponse(response,backend,path){
  try{const url=new URL(response.url()),request=typeof response.request==='function'?response.request():null;
    return url.origin===backend&&url.pathname===path&&!url.search&&!url.hash&&typeof response.status==='function'&&
      (!request||typeof request.method!=='function'||request.method()==='GET');}
  catch{return false;}
}
// The exact response bytes (bounded) and their strict UTF-8 JSON value; both from the same bytes.
async function exactBody(response,code){
  let bytes;try{bytes=typeof response.body==='function'?await response.body():null;}catch{fail(code);}
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>65536)fail(code);
  const copy=Buffer.from(bytes);let value;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(copy));}catch{fail(code);}
  return {bytes:copy,value};
}
function digestHex(bytes){return createHash('sha256').update(bytes).digest('hex');}
// T13 I-4/I-5 (C9): GET /api/readiness, then GET /api/me. Readiness passes only as HTTP 200 with a
// body the single readinessPredicate accepts; the owner must be the login's owner and the cookie
// the login's cookie. The result carries SHA-256 digests of the exact response bytes, never content.
async function observeReadiness(page,context,backend,phase,sequence,boundSession,sessionKey,clock,runId){
  const before=await sessionFingerprint(context,backend,sessionKey);
  if(before.fingerprint!==boundSession.fingerprint)fail('SESSION_CHANGED');
  const readinessPending=page.waitForResponse(response=>fixedResponse(response,backend,'/api/readiness'),{timeout:10000});
  await fixedGet(page,backend+'/api/readiness');
  const readinessResponse=await readinessPending;
  if(readinessResponse.status()!==200)fail('READINESS_FAILED');
  const readiness=await exactBody(readinessResponse,'READINESS_FAILED');
  if(readinessPredicate(readiness.value)!==true)fail('READINESS_FAILED');
  const ownerPending=page.waitForResponse(value=>meResponse(value,backend),{timeout:10000});
  await fixedGet(page,backend+'/api/me');
  const owner=await exactBody(await ownerPending,'OWNER_MISMATCH');
  if(!ownerMatches(owner.value,boundSession.expectedOwner))fail('OWNER_MISMATCH');
  const after=await sessionFingerprint(context,backend,sessionKey);
  if(after.fingerprint!==boundSession.fingerprint)fail('SESSION_CHANGED');
  let sample;try{sample=clock.sample();}catch{fail('EXPIRED');}
  if(!Array.isArray(sample)||sample.length!==2||!safe(sample[1],0))fail('EXPIRED');
  return Object.freeze({status:'READINESS_OBSERVED',runId,phase,sequence,sessionFingerprint:after.fingerprint,
    readinessDigest:digestHex(readiness.bytes),ownerDigest:digestHex(owner.bytes),checkedAtMonotonicMs:sample[1]});
}
function rowIdentities(rows,field){
  if(!Array.isArray(rows))fail('OBSERVATION_FAILED');
  const values=[];for(const row of rows){if(!plain(row)||typeof row[field]!=='string'||!row[field])fail('OBSERVATION_FAILED');values.push(row[field]);}return values;
}
function roboOrderLabels(rows){
  if(!Array.isArray(rows))fail('OBSERVATION_FAILED');
  return rows.map(row=>{
    if(!plain(row)||!textValue(row._id)||row.environment!=='paper'||row.executionSource!=='alpaca-paper'||row.broker!=='alpaca'||!textValue(row.symbol)||
       !textValue(row.side)||!textValue(row.status)||!textValue(row.orderType)||!textValue(row.timeInForce)||
       !optionalText(row.clientOrderId)||!optionalText(row.externalOrderId))fail('OBSERVATION_FAILED');
    return row.side.toUpperCase()+' '+row.symbol;
  });
}
function reconciliationSymbols(rows){
  if(!Array.isArray(rows))fail('OBSERVATION_FAILED');
  return rows.map(row=>{
    if(!plain(row)||!textValue(row._id)||row.environment!=='paper'||!textValue(row.symbol)||!textValue(row.side)||!textValue(row.status)||
       !textValue(row.reconciliationStatus)||
       !optionalInstant(row.lastReconciledAt)||!instant(row.updatedAt)||!instant(row.createdAt)||
       row.discrepancy!==null&&row.discrepancy!==undefined&&!textValue(row.discrepancy))fail('OBSERVATION_FAILED');
    return row.symbol;
  });
}
function validateViewBodies(view,bodies){
  if(view==='ROBO'){
    const [settings,decisions,orders,performance,audit,health,reconciliation]=bodies;
    const configured=settings?.settings;
    if(!plain(configured)||configured.mode!=='paper'||configured.liveTradingExplicitlyEnabled!==false||configured.enabled!==false||configured.isEnabled!==false||
       !Array.isArray(decisions?.decisions)||decisions.decisions.some(row=>!plain(row)||!textValue(row._id)||row.environment!=='paper'||!textValue(row.symbol)||
         !textValue(row.status)||!numeric(row.confidenceScore)||!optionalNumeric(row.rewardRiskRatio)||!optionalText(row.reasoningSummary)||!instant(row.decidedAt))||
       !Array.isArray(orders?.orders)||!plain(performance)||!plain(performance.account)||!plain(performance.summary)||
       !textValue(performance.account.id)||!textValue(performance.account.status)||!numeric(performance.account.cash)||
       !numeric(performance.account.equity)||!numeric(performance.account.buying_power)||
       !Array.isArray(performance.positions)||performance.positions.some(row=>!plain(row)||!textValue(row.symbol)||!numeric(row.qty)||
         !numeric(row.market_value)||!textValue(row.side))||performance.brokerError!==null||
       ![performance.summary.decisions,performance.summary.submittedOrders,performance.summary.filledOrders,performance.summary.rejectedDecisions].every(count)||
       !optionalInstant(performance.summary.lastRunAt)||!Array.isArray(audit?.events)||
       audit.events.some(row=>!plain(row)||!textValue(row._id)||!textValue(row.eventType)||!instant(row.createdAt))||
       health?.mongo?.connected!==true||!textValue(health.mongo.status)||health?.alpaca?.paper?.connected!==true||
       health.alpaca.paper.error!==null||health.alpaca.paper.tradingBlocked!==false||!textValue(health.alpaca.paper.accountStatus)||
       !numeric(health.alpaca.paper.buyingPower)||health?.scheduler?.phase1WorkerEnabled!==false||
       !plain(reconciliation)||!plain(reconciliation.summary)||!count(reconciliation.summary.total)||!count(reconciliation.summary.pending)||
       !count(reconciliation.summary.discrepancies)||!optionalInstant(reconciliation.summary.lastReconciledAt)||
       !Array.isArray(reconciliation.orders)||!Array.isArray(reconciliation.latestDiscrepancies)||
       !Array.isArray(reconciliation.historicalDiscrepancies))fail('OBSERVATION_FAILED');
    const orderLabels=roboOrderLabels(orders.orders),reconciliationLabels=reconciliationSymbols(reconciliation.orders);
    const visibleOrderIndexes=orders.orders.map((row,index)=>({row,index})).filter(({row})=>String(row.status).toLowerCase()!=='rejected').slice(0,8);
    const visibleDecisions=decisions.decisions.slice(0,10),visiblePositions=performance.positions.slice(0,8),visibleAudit=audit.events;
    const visibleReconciliation=reconciliation.orders.slice(0,4);
    // T13 I-9: source and brokerError are derived from the validated PAPER-health body. The source
    // is the single connected Alpaca adapter the health body reports (none, or more than one, is
    // no source); brokerError is any broker fault that body or the performance body reports.
    const connected=Object.keys(health.alpaca).filter(name=>plain(health.alpaca[name])&&health.alpaca[name].connected===true);
    const paperHealth=health.alpaca.paper;
    const paper=Object.freeze({source:connected.length===1?'alpaca-'+connected[0]:null,
      brokerError:paperHealth.connected!==true||paperHealth.error!==null||paperHealth.tradingBlocked!==false||performance.brokerError!==null});
    return {paper,sections:[
      {title:'Recent strategy decisions',rows:visibleDecisions,samples:rowIdentities(visibleDecisions,'symbol'),empty:'No decisions saved yet.',selector:'tbody tr'},
      {title:'RoboTrader orders',rows:visibleOrderIndexes,samples:visibleOrderIndexes.map(({index})=>orderLabels[index]),empty:'No RoboTrader orders submitted yet.',selector:'tbody tr'},
      {title:'Current positions',rows:visiblePositions,samples:rowIdentities(visiblePositions,'symbol'),empty:'No positions returned.',selector:'tbody tr'},
      {title:'Recent RoboTrader events',rows:visibleAudit,samples:rowIdentities(visibleAudit,'eventType'),empty:'No RoboTrader audit entries yet.',selector:'.rt-panel'},
      {title:'Broker/local order match',rows:visibleReconciliation,samples:reconciliationLabels.slice(0,4),empty:'No current RoboTrader orders need reconciliation.',selector:'.mt-5.space-y-3 > .rt-panel'},
    ]};
  }
  if(view==='PORTFOLIO'){
    const [account,equity]=bodies;
    if(!plain(account)||account.executionSource!=='alpaca-paper'||account.broker!=='alpaca'||typeof account.accountId!=='string'||!account.accountId||
       !finite(account.cash)||!finite(account.equity)||!finite(account.positionsValue)||!finite(account.dailyPnl)||
       !optionalNumeric(account.totalPnl)||!Array.isArray(account.positions)||account.positions.some(row=>!plain(row)||row.executionSource!=='alpaca-paper'||
         row.broker!=='alpaca'||!textValue(row.symbol)||!numeric(row.qty)||!numeric(row.avgCost)||!numeric(row.marketPrice)||
         !numeric(row.unrealizedPnl)||!optionalNumeric(row.unrealizedPnlPct))||!Array.isArray(equity)||
       equity.some(row=>!plain(row)||row.executionSource!=='alpaca-paper'||row.broker!=='alpaca'||!instant(row.timestamp)||
         !finite(row.equity)||!optionalNumeric(row.dailyPnl)))fail('OBSERVATION_FAILED');
    return {accountValues:[['Equity',account.equity],["Today's P/L",account.dailyPnl],['All-time P/L',account.totalPnl],['Cash',account.cash]],sections:[
      {title:'Positions',rows:account.positions,samples:rowIdentities(account.positions,'symbol'),empty:'No open positions yet.',selector:'tbody tr'},
      {title:'Equity Curve',rows:equity,samples:null,empty:'No equity history yet.',selector:'chart'},
    ]};
  }
  const [orders,trades,notifications]=bodies;
  if(!sourceRows(orders,'order')||!sourceRows(trades,'trade')||!plain(notifications)||notifications.executionSource!=='alpaca-paper'||
     !Array.isArray(notifications.events)||notifications.events.some(row=>!plain(row)||!textValue(row._id)||!textValue(row.subject)||
       !textValue(row.state)||!count(row.attempts)||!instant(row.createdAt)||!optionalInstant(row.nextAttemptAt)||!optionalInstant(row.providerAcceptedAt)))fail('OBSERVATION_FAILED');
  const activity=[...orders,...trades];
  return {sections:[
    {title:'Recent Activity',rows:activity,samples:rowIdentities(activity,'symbol'),empty:'No activity yet.',selector:'.rt-panel'},
    {title:'Alpaca paper notification delivery',rows:notifications.events,samples:rowIdentities(notifications.events,'subject'),empty:'No Alpaca paper notification events yet.',selector:'.rt-panel'},
  ]};
}
async function locatorCount(locator){return locator&&typeof locator.count==='function'?locator.count():0;}
async function waitCount(locator,predicate){for(let attempt=0;attempt<200;attempt++){const value=await locatorCount(locator);if(predicate(value))return value;
    await new Promise(resolve=>setTimeout(resolve,25));}fail('OBSERVATION_FAILED');}
async function waitVisible(locator){if(locator&&typeof locator.waitFor==='function')try{await locator.waitFor({state:'visible',timeout:5000});}catch{fail('OBSERVATION_FAILED');}
  if(!locator||typeof locator.isVisible!=='function'||await locator.isVisible()!==true)fail('OBSERVATION_FAILED');}
async function visibleMatches(locator,expected,predicate=value=>value>=expected){await waitCount(locator,predicate);
  for(let index=0;index<expected;index++){const selected=typeof locator.nth==='function'?locator.nth(index):index===0?locator:null;await waitVisible(selected);}}
async function sectionCard(page,title){const anchor=page.getByText(title,{exact:true});await visibleMatches(anchor,1);
  const selected=typeof anchor.first==='function'?anchor.first():anchor;
  if(typeof selected.locator!=='function')fail('OBSERVATION_FAILED');
  return selected.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," rh-card ")][1]');}
function money(value){return value===null||value===undefined||value===''||!Number.isFinite(Number(value))?'--':'$'+Number(value).toFixed(2);}
function curvePoints(path){
  if(!textValue(path))fail('OBSERVATION_FAILED');const points=[];
  for(const chunk of path.match(/[MLC][^MLCZ]*/gi)||[]){const values=(chunk.slice(1).match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)||[]).map(Number);
    if(values.some(value=>!Number.isFinite(value)))fail('OBSERVATION_FAILED');
    if(/^[ML]/i.test(chunk)){if(values.length!==2)fail('OBSERVATION_FAILED');points.push([values[0],values[1]]);}
    else {if(values.length<6||values.length%6!==0)fail('OBSERVATION_FAILED');for(let index=0;index<values.length;index+=6)points.push([values[index+4],values[index+5]]);}
  }
  return points;
}
function assertCurveHistory(path,rows){const points=curvePoints(path);if(points.length!==rows.length)fail('OBSERVATION_FAILED');
  for(let index=1;index<points.length;index++)if(points[index][0]<=points[index-1][0])fail('OBSERVATION_FAILED');
  const equities=rows.map(row=>row.equity),dataMin=Math.min(...equities),dataMax=Math.max(...equities);
  const ys=points.map(point=>point[1]),pixelMin=Math.min(...ys),pixelMax=Math.max(...ys);
  if(dataMax===dataMin){if(pixelMax-pixelMin>0.01)fail('OBSERVATION_FAILED');return;}
  if(pixelMax===pixelMin)fail('OBSERVATION_FAILED');
  for(let index=0;index<rows.length;index++){
    const expected=(equities[index]-dataMin)/(dataMax-dataMin),rendered=(pixelMax-ys[index])/(pixelMax-pixelMin);
    if(Math.abs(expected-rendered)>0.02)fail('OBSERVATION_FAILED');
  }}
// The response status is checked from the observed response (fixedResponse / meResponse), so that a
// non-200 answer is classified by the action that made the GET.
async function fixedGet(page,url){if(typeof page.evaluate!=='function')fail('OBSERVATION_FAILED');
  await page.evaluate(async target=>{const response=await fetch(target,{method:'GET',credentials:'include',redirect:'error',headers:{accept:'application/json'}});
    await response.arrayBuffer();},url);}
// T13 I-9: measured, not assumed. A role=alert or role=status element that does not settle at zero
// within the same 200 x 25 ms bound waitCount uses is a measured error state.
async function settlesAtZero(locator){for(let attempt=0;attempt<200;attempt++){if(await locatorCount(locator)===0)return true;
    await new Promise(resolve=>setTimeout(resolve,25));}return false;}
// The view runs only after the phase's SESSION_READINESS (the caller checks it); `facts` are the
// phase's PAPER-health facts (from its ROBO view), or none.
async function observeFixedView(page,context,backend,frontend,phase,view,sequence,facts,boundSession,sessionKey){
  const spec=VIEW_SPECS[view];if(!spec)fail('ACTION_DENIED');
  const beforeSession=await sessionFingerprint(context,backend,sessionKey);
  if(beforeSession.fingerprint!==boundSession.fingerprint)fail('SESSION_CHANGED');
  const pending=spec.routes.map(([path,query])=>page.waitForResponse(response=>viewResponse(response,backend,path,query),{timeout:10000}));
  const links=page.getByRole('link',{name:spec.nav,exact:true}),link=typeof links.first==='function'?links.first():links;
  if(!link||typeof link.click!=='function')fail('OBSERVATION_FAILED');await link.click();
  if(typeof page.url==='function'){let current;try{current=new URL(page.url());}catch{fail('OBSERVATION_FAILED');}
    if(current.origin!==frontend||current.pathname!==spec.path||current.search||current.hash)fail('OBSERVATION_FAILED');}
  const responses=await Promise.all(pending),bodies=[];
  for(const response of responses){let body;try{body=await response.json();}catch{fail('OBSERVATION_FAILED');}bodies.push(body);}
  const validated=validateViewBodies(view,bodies);
  const heading=page.getByRole('heading',{name:spec.heading,exact:true});await waitVisible(heading);
  const noError=await settlesAtZero(page.getByRole('alert'))&&await settlesAtZero(page.getByRole('status'));
  let domRows=0;
  for(const section of validated.sections){
    const card=await sectionCard(page,section.title),rows=section.rows,samples=section.samples;
    if(rows.length===0){await visibleMatches(card.getByText(section.empty,{exact:true}),1);
      if(section.selector==='chart')await waitCount(card.locator('path.recharts-line-curve'),value=>value===0);
      else if(section.selector)await waitCount(card.locator(section.selector),value=>value===0);continue;}
    if(section.selector==='chart'){
      const curve=card.locator('path.recharts-line-curve');await visibleMatches(curve,1);
      const selected=typeof curve.first==='function'?curve.first():curve,d=typeof selected.getAttribute==='function'?await selected.getAttribute('d'):null;
      assertCurveHistory(d,rows);domRows+=rows.length;continue;
    }
    if(samples.length!==rows.length)fail('OBSERVATION_FAILED');
    const requiredText=new Map();for(const sample of samples)requiredText.set(sample,(requiredText.get(sample)||0)+1);
    for(const [sample,expected] of requiredText)await visibleMatches(card.getByText(sample,{exact:true}),expected);
    if(section.selector){const rowLocator=card.locator(section.selector);await visibleMatches(rowLocator,rows.length,value=>value===rows.length);}
    domRows+=rows.length;
  }
  for(const [label,value] of validated.accountValues||[]){const card=await sectionCard(page,label);
    await visibleMatches(card.getByText(money(value),{exact:true}),1);}
  const session=await sessionFingerprint(context,backend,sessionKey);
  if(session.fingerprint!==boundSession.fingerprint)fail('SESSION_CHANGED');
  // T13 I-9: no freshness is claimed. ROBO reports the facts derived from its own PAPER-health body;
  // the phase's later views report the same facts, or none before ROBO.
  const paper=validated.paper||facts||Object.freeze({source:null,brokerError:null});
  return Object.freeze({observed:Object.freeze({status:'VIEW_OBSERVED',view,phase,sequence,schemaValidation:true,renderedData:domRows>0,
    validEmptyState:domRows===0,noError,source:paper.source,brokerError:paper.brokerError,
    routeCount:spec.routes.length,renderedCount:domRows,fingerprint:session.fingerprint}),paper:validated.paper||null});
}
async function bounded(promise,milliseconds) {
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0)fail('CLEANUP_UNCERTAIN');
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('CLEANUP_UNCERTAIN'),{code:'CLEANUP_UNCERTAIN'})),milliseconds);timer.unref?.();})]);}
  finally{clearTimeout(timer);}
}
// T13 m-6: startup is bounded by the run binding's expiry. The injected clock
// alone decides expiry (wall ms against expiresAt); the timer only schedules the
// next clock check, so a stalled step still ends once the clock passes expiry.
// A failing, malformed or regressing sample counts as expired (fail closed).
function runExpiry(clock,expiresAt) {
  let timer=null,cleared=false,expired=false,last=null,reject;
  const promise=new Promise((_,no)=>{reject=no;});promise.catch(()=>{});
  function left(){
    let sample;try{sample=clock.sample();}catch{return 0;}
    if(!Array.isArray(sample)||sample.length!==2||!sample.every(value=>safe(value,0))||last&&(sample[0]<last[0]||sample[1]<last[1]))return 0;
    last=sample;return Math.max(0,expiresAt-sample[0]);
  }
  function expire(){expired=true;if(timer!==null)clearTimeout(timer);timer=null;reject(Object.assign(new Error('EXPIRED'),{code:'EXPIRED'}));}
  function check(){
    timer=null;if(cleared||expired)return;const milliseconds=left();
    if(milliseconds<1){expire();return;}
    timer=setTimeout(check,Math.min(milliseconds,2147483647));timer.unref?.();
  }
  check();
  return Object.freeze({
    race:operation=>Promise.race([operation,promise]),
    assert(){if(!cleared&&!expired&&left()<1)expire();if(expired)fail('EXPIRED');},
    clear(){cleared=true;if(timer!==null)clearTimeout(timer);timer=null;},
  });
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'assetBundle,assetEntries,paths,runBinding,runtime' || !equal(config.runtime, RUNTIME_PINS)) fail('CONFIG_INVALID');
  exact(config.paths, ['profile', 'support', 'cache', 'shm']);
  if (!equal(config.paths, { profile: '/run/acceptance/browser/profile', support: '/run/acceptance/browser/support', cache: '/run/acceptance/browser/cache', shm: '/dev/shm' })) fail('CONFIG_INVALID');
  exact(config.runBinding, ['runId', 'manifestIdentity', 'configIdentity', 'expiresAt', 'origins']);
  exact(config.runBinding.origins, ['FRONTEND', 'BACKEND']);
  if (!/^[0-9a-f]{32}$/.test(config.runBinding.runId) || !/^[0-9a-f]{64}$/.test(config.runBinding.manifestIdentity) ||
      !/^[0-9a-f]{64}$/.test(config.runBinding.configIdentity) || !safe(config.runBinding.expiresAt) || config.runBinding.origins.FRONTEND === config.runBinding.origins.BACKEND) fail('CONFIG_INVALID');
  for (const origin of Object.values(config.runBinding.origins)) {
    let parsed; try { parsed = new URL(origin); } catch { fail('CONFIG_INVALID'); }
    if (typeof origin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.pathname !== '/' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) fail('CONFIG_INVALID');
  }
  if (!Array.isArray(config.assetEntries) || config.assetEntries.length < 1 || config.assetEntries.length > 256) fail('CONFIG_INVALID');
  const paths = new Set();
  for (const entry of config.assetEntries) {
    exact(entry, ['path', 'hash', 'size', 'mime']);
    if (typeof entry.path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.includes('//') || entry.path.split('/').some(segment => segment === '.' || segment === '..') ||
        entry.path.endsWith('.map') || entry.path === '/static/js/acceptance-missing.js' || !/^[0-9a-f]{64}$/.test(entry.hash) || !safe(entry.size) || entry.size > 16777216 ||
        typeof entry.mime !== 'string' || entry.mime.length < 1 || entry.mime.length > 128 || /[\x00-\x20\x7f]/.test(entry.mime) || paths.has(entry.path)) fail('CONFIG_INVALID');
    paths.add(entry.path);
  }
}
// T13 I-6, m-1: a status is accepted only with all four Uid and all four Gid fields 10002,
// NoNewPrivs 1, Seccomp exactly 2 (SECCOMP_MODE_FILTER) and Seccomp_filters at least 1
// (Chromium stacks its own filters on the inherited one). Descriptor facts must all be zero:
// consoles, unattributed sockets, unreadable descriptors and leaked control pipes.
const ROLE_ID=10002;
function roleIds(value){return Array.isArray(value)&&value.length===4&&value.every(id=>id===ROLE_ID);}
function statusAccepted(value){
  return roleIds(value.uids)&&roleIds(value.gids)&&value.noNewPrivs===true&&value.seccomp===2&&safe(value.seccompFilters,1);
}
function descriptorsClean(value){
  return value.consoleFds===0&&value.unknownSocketFds===0&&value.unreadableFds===0&&value.unexpectedFds===0;
}
function audit(pipe) {
  if (!pipe || typeof pipe.audit !== 'function' || typeof pipe.inspectBrowserFamily !== 'function') fail('ROLE_INVALID');
  const value = pipe.audit();
  if (!value || value.version !== 1 || !statusAccepted(value) || value.capabilities !== 'EMPTY' ||
      value.procScope !== 'BROWSER_FAMILY_ONLY' || !descriptorsClean(value) || value.networkDeviceCount !== 0 || value.maxFrameBytes !== 16384 ||
      !Array.isArray(value.tmpfsPaths) || !equal([...value.tmpfsPaths].sort(), ['/dev/shm', '/run/acceptance/browser/cache', '/run/acceptance/browser/profile', '/run/acceptance/browser/support']) ||
      !/^[0-9a-f]{32}$/.test(value.runId)) fail('ROLE_INVALID');
  return value;
}
// T13 m-7: an unreadable family member (or any unreadable descriptor) is the explicit
// FAMILY_UNREADABLE; every other violation is ROLE_INVALID.
function inspectFamily(pipe) {
  let value;
  try { value = pipe.inspectBrowserFamily(); } catch (cause) { fail(cause?.code === 'FAMILY_UNREADABLE' ? 'FAMILY_UNREADABLE' : 'ROLE_INVALID', cause); }
  if (!value || !Number.isSafeInteger(value.workerPid) || value.workerPid < 1 || !Number.isSafeInteger(value.browserPid) || value.browserPid < 1 ||
      value.procScope !== 'BROWSER_FAMILY_ONLY' || !Array.isArray(value.members) || value.members.length < 2) fail('ROLE_INVALID');
  for (const member of value.members) if (member && Number.isSafeInteger(member.unreadableFds) && member.unreadableFds > 0) fail('FAMILY_UNREADABLE');
  for (const member of value.members) if (!member || !Number.isSafeInteger(member.pid) || member.pid < 1 || !statusAccepted(member) || !descriptorsClean(member)) fail('ROLE_INVALID');
  return value;
}
function auditApplication(pipe,runId) {
  if(!pipe||typeof pipe.audit!=='function')fail('ROLE_INVALID');const value=pipe.audit();
  if(!value||value.version!==1||value.kind!=='TASK13_BROWSER_APPLICATION'||value.runId!==runId||value.maxFrameBytes!==16384)fail('ROLE_INVALID');
  return value;
}
// The application pipe carries only the Task 13 frame form (auditApplication admits no other).
function rpc(pipe, facts) {
  let outgoing = 0, incoming = 0, sending=Promise.resolve();
  return Object.freeze({
    write(type, payload) {
      const operation=sending.then(async()=>{
        const body = Buffer.from(canonical({ version: 1, runId: facts.runId, sequence: ++outgoing, type, payload }), 'ascii');
        if (body.length > facts.maxFrameBytes) fail('FRAME_DENIED');
        const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); await pipe.write(Buffer.concat([prefix, body]));
      });
      sending=operation.catch(()=>{});return operation;
    },
    async read() {
      const bytes = await pipe.read();
      if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > facts.maxFrameBytes + 4 || bytes.readUInt32BE() !== bytes.length - 4) fail('FRAME_DENIED');
      const body = bytes.subarray(4); if (body.some(value => value > 127)) fail('FRAME_DENIED');
      const text = body.toString('ascii'); let frame; try { frame = JSON.parse(text); } catch { fail('FRAME_DENIED'); }
      if (canonical(frame) !== text) fail('FRAME_DENIED');
      exact(frame, ['version', 'runId', 'sequence', 'type', 'payload']);
      if (frame.version !== 1 || frame.runId !== facts.runId || frame.sequence !== incoming + 1 || !safe(frame.sequence) || typeof frame.type !== 'string') fail('FRAME_DENIED');
      incoming++;
      return frame;
    },
  });
}
function loginJSON(bytes) {
  if (bytes.length > 16384) return false;
  const token = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
  const pattern = new RegExp('^[ \\t\\r\\n]*\\{[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*,[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*:[ \\t\\r\\n]*(' + token + ')[ \\t\\r\\n]*\\}[ \\t\\r\\n]*$');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), match = pattern.exec(text);
    if (!match) return false;
    const keys = [JSON.parse(match[1]), JSON.parse(match[3])].sort();
    return keys[0] === 'password' && keys[1] === 'username';
  } catch { return false; }
}
function bodyProof(runId, requestId, sequence, method, url, headers, bytes) {
  // Header pairs pass through uncollapsed, so a repeated name reaches the policy.
  const contentTypes = headers.filter(([name]) => name === 'content-type');
  let schema = 'INVALID';
  if (method === 'POST' && new URL(url).pathname === '/api/login' && contentTypes.length === 1 && contentTypes[0][1] === 'application/json' && loginJSON(bytes)) schema = 'LOGIN_JSON';
  else if (bytes.length === 0) schema = 'ABSENT';
  return { runId, requestId, sequence, method, url, headers: headers.map(pair => [...pair]), byteLength: bytes.length, schema };
}
// Returns null when the request carries a header that must be aborted locally.
function factsFor(request, requestId) {
  const headers = Object.entries(request.headers()).map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  if (headers.some(([name]) => LOCAL_ABORT_HEADERS.includes(name) || name.startsWith('x-'))) return null;
  const method = request.method(), url = request.url();
  return { requestId, method, url, headers: headers.filter(([name]) => !BROWSER_GENERATED_HEADERS.includes(name))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])) };
}
function launchOptions(config) {
  return {
    executablePath: RUNTIME_PINS.chromium.executablePath,
    chromiumSandbox: true,
    headless: true,
    proxy: { server: 'http://127.0.0.1:3128', bypass: '' },
    ignoreDefaultArgs: ['--disable-dev-shm-usage'],
    args: ['--disable-extensions', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--enable-features=WebRtcHideLocalIpsWithMdns', '--proxy-bypass-list=<-loopback>'],
    env: { HOME: config.paths.support, TMPDIR: config.paths.profile, XDG_CACHE_HOME: config.paths.cache },
  };
}

function inheritedReader(fs,fd=3) {
  if(typeof fs.createReadStream!=='function')fail('CHANNEL_DENIED');
  const stream=fs.createReadStream(null,{fd,autoClose:false}),queue=[],waiters=[];let pending=Buffer.alloc(0),terminal;
  function settle(error){if(terminal)return;terminal=error||Object.assign(new Error('CHANNEL_EOF'),{code:'CHANNEL_EOF'});while(waiters.length)waiters.shift().reject(terminal);}
  stream.on('data',chunk=>{
    if(terminal||!Buffer.isBuffer(chunk))return settle(Object.assign(new Error('FRAME_DENIED'),{code:'FRAME_DENIED'}));
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=4){const length=pending.readUInt32BE();if(length<1||length>16384)return settle(Object.assign(new Error('FRAME_DENIED'),{code:'FRAME_DENIED'}));
      if(pending.length<length+4)break;const frame=Buffer.from(pending.subarray(0,length+4));pending=pending.subarray(length+4);
      const waiter=waiters.shift();if(waiter)waiter.resolve(frame);else queue.push(frame);
    }
  });
  stream.on('error',settle);stream.on('end',()=>settle());
  return Object.freeze({
    read(){if(queue.length)return Promise.resolve(queue.shift());if(terminal)return Promise.reject(terminal);return new Promise((resolve,reject)=>waiters.push({resolve,reject}));},
    drain(){const frames=queue.splice(0);return frames;},
    close(){stream.destroy();},
  });
}
function writeExactly(fs,fd,bytes) {
  let offset=0;while(offset<bytes.length){const count=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!Number.isSafeInteger(count)||count<1)fail('CHANNEL_EOF');offset+=count;}
}
function decodeInheritedInit(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.readUInt32BE()!==bytes.length-4)fail('CHANNEL_DENIED');
  const text=bytes.subarray(4).toString('ascii');let value;try{value=JSON.parse(text);}catch{fail('CHANNEL_DENIED');}
  if(canonical(value)!==text)fail('CHANNEL_DENIED');
  exact(value,['version','kind','binding','role','childId','pipeId','channelKeyHex']);
  if(value.version!==1||value.kind!=='BROWSER_WORKER_INIT'||value.role!=='BROWSER'||
      !/^[0-9a-f]{32}$/.test(value.childId)||!/^[0-9a-f]{32}$/.test(value.pipeId)||!/^[0-9a-f]{64}$/.test(value.channelKeyHex))fail('CHANNEL_DENIED');
  exact(value.binding,['version','runId','manifestDigest','configIdentity','rolePolicyDigest','epoch','expiresAtMs']);
  if(value.binding.version!==1||!/^[0-9a-f]{32}$/.test(value.binding.runId)||
      ['manifestDigest','configIdentity','rolePolicyDigest'].some(key=>!/^[0-9a-f]{64}$/.test(value.binding[key]))||
      !safe(value.binding.epoch)||!safe(value.binding.expiresAtMs))fail('CHANNEL_DENIED');
  return value;
}
// T13 I-6: descriptor classification observes the kernel's own tables. Linux 6.8 formats:
//  - descriptor links: net/socket.c:362 `socket:[%lu]`, fs/pipe.c:881 `pipe:[%lu]`.
//  - net/unix/af_unix.c:3282-3289: inode is the 7th field; net/ipv4/tcp_ipv4.c:2896 and :2945-2947,
//    net/ipv6/tcp_ipv6.c:2211 and :2270-2275, net/ipv4/udp.c:3082 and :3098-3100,
//    net/ipv6/datagram.c:1055 with include/net/transp_v6.h:59-64: inode is the 10th field.
//    Request and TIME_WAIT rows carry inode 0 (tcp_ipv4.c:2835, :2929) and attribute nothing.
// A socket is attributed only from these five tables. Any other socket, vsock included (it has
// no /proc/net table), is UNKNOWN_SOCKET. A readlink error is UNREADABLE. Both are failures.
const SOCKET_TABLES=Object.freeze([
  ['unix','UNIX',6,'Num RefCount Protocol Flags Type St Inode Path'],
  ['tcp','TCP',9,'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'],
  ['tcp6','TCP',9,'sl local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'],
  ['udp','UDP',9,'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode ref pointer drops'],
  ['udp6','UDP',9,'sl local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode ref pointer drops'],
].map(row=>Object.freeze(row)));
function classifyDescriptor(link,socketInodes) {
  if(typeof link!=='string'||link.length===0)return 'UNREADABLE';
  const socket=/^socket:\[([1-9][0-9]*)\]$/.exec(link);
  if(socket){const family=socketInodes&&typeof socketInodes.get==='function'?socketInodes.get(socket[1]):undefined;
    return family==='UNIX'||family==='TCP'||family==='UDP'?family:'UNKNOWN_SOCKET';}
  if(link.startsWith('socket:'))return 'UNKNOWN_SOCKET';
  if(/^pipe:\[[1-9][0-9]*\]$/.test(link))return 'PIPE';
  if(link==='/dev/null')return 'NULL';
  // The virtio console (hvc*, the guest's console=hvc0), virtio ports, /dev/console, every tty and pty.
  if(/^\/dev\/(?:hvc|vport|console|tty|pts\/)/.test(link))return 'CONSOLE';
  return 'OTHER';
}
function socketInodeFamilies(fs) {
  const families=new Map();
  for(const [table,family,column,header] of SOCKET_TABLES){
    let text;try{text=fs.readFileSync('/proc/net/'+table,'utf8');}catch(cause){fail('FAMILY_UNREADABLE',cause);}
    if(typeof text!=='string')fail('FAMILY_UNREADABLE');
    const rows=text.split('\n');
    if(rows[0].trim().split(/\s+/).join(' ')!==header)fail('FAMILY_UNREADABLE');
    for(const row of rows.slice(1)){
      const fields=row.trim().split(/\s+/);if(fields.length===1&&fields[0]==='')continue;
      const inode=fields[column];if(typeof inode!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(inode))fail('FAMILY_UNREADABLE');
      if(inode==='0')continue;
      const known=families.get(inode);if(known!==undefined&&known!==family)fail('FAMILY_UNREADABLE');
      families.set(inode,family);
    }
  }
  return families;
}
// m-1: fs/proc/array.c:189-196 prints four Uid and four Gid fields; :335-341 prints NoNewPrivs,
// Seccomp (include/uapi/linux/seccomp.h:12 SECCOMP_MODE_FILTER is 2) and Seccomp_filters.
// Each row must appear exactly once; a missing or malformed row reads as null.
function procStatus(fs,pid='self') {
  const text=fs.readFileSync('/proc/'+pid+'/status','utf8'),lines=String(text).split('\n');
  const field=name=>{const rows=lines.filter(line=>line.startsWith(name+':'));return rows.length===1?rows[0].slice(name.length+1).trim():null;};
  const decimal=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,9})$/.test(value)?Number(value):null;
  const ids=name=>{const value=field(name);if(value===null)return null;const parts=value.split(/\s+/);return parts.length===4?parts.map(decimal):null;};
  const capEff=field('CapEff');
  return {uids:ids('Uid'),gids:ids('Gid'),noNewPrivs:field('NoNewPrivs')==='1',seccomp:decimal(field('Seccomp')),
    seccompFilters:decimal(field('Seccomp_filters')),capabilities:typeof capEff==='string'&&/^0+$/.test(capEff)?'EMPTY':'PRESENT'};
}
// The listing stays open while each entry is read, so the reader's own listing descriptor (it
// appears in its own /proc/<pid>/fd) still resolves instead of reading as unreadable.
function descriptorLinks(fs,pid) {
  let directory;try{directory=fs.opendirSync('/proc/'+pid+'/fd');}catch(cause){fail('FAMILY_UNREADABLE',cause);}
  const links=[];
  try{
    for(let entry=directory.readSync();entry!==null;entry=directory.readSync()){
      if(entry.name==='.'||entry.name==='..')continue;
      if(!/^(?:0|[1-9][0-9]*)$/.test(entry.name))fail('FAMILY_UNREADABLE');
      let link=null;try{link=fs.readlinkSync('/proc/'+pid+'/fd/'+entry.name);}catch{link=null;}
      links.push(link);
    }
  }catch(cause){fail('FAMILY_UNREADABLE',cause);}
  finally{try{directory.closeSync();}catch{}}
  return links;
}
function forbiddenDescriptorCounts(fs,pid='self',forbiddenTargets=new Set(),socketInodes=socketInodeFamilies(fs)) {
  let consoleFds=0,unknownSocketFds=0,unreadableFds=0,unexpectedFds=0;
  for(const link of descriptorLinks(fs,pid)){
    const kind=classifyDescriptor(link,socketInodes);
    if(kind==='CONSOLE')consoleFds++;
    if(kind==='UNKNOWN_SOCKET')unknownSocketFds++;
    if(kind==='UNREADABLE')unreadableFds++;
    if(typeof link==='string'&&forbiddenTargets.has(link))unexpectedFds++;
  }
  return {consoleFds,unknownSocketFds,unreadableFds,unexpectedFds};
}
function tmpfsPaths(fs) {
  const required=['/dev/shm','/run/acceptance/browser/cache','/run/acceptance/browser/profile','/run/acceptance/browser/support'],mounts=[];
  for(const line of fs.readFileSync('/proc/self/mountinfo','utf8').split('\n')){const parts=line.split(' '),separator=parts.indexOf('-');
    if(separator>5)mounts.push({path:parts[4],type:parts[separator+1]});}
  return required.filter(path=>mounts.filter(row=>path===row.path||path.startsWith(row.path.endsWith('/')?row.path:row.path+'/'))
    .sort((a,b)=>b.path.length-a.path.length)[0]?.type==='tmpfs').sort();
}
// Fix round 1 (I-1): Linux files a child under the thread that forked it (kernel/fork.c:2632,
// :2690), and each task's `children` file lists only that task's children (fs/proc/array.c:720-770).
// So every thread under /proc/<pid>/task/ is read; the main thread's children come first.
function childPids(fs,pid) {
  const tids=fs.readdirSync('/proc/'+pid+'/task').map(String);
  if(tids.length<1||tids.some(tid=>!/^[1-9][0-9]{0,9}$/.test(tid)))fail('FAMILY_UNREADABLE');
  const ordered=[...tids].sort((a,b)=>(a===String(pid)?-1:b===String(pid)?1:Number(a)-Number(b))),children=[];
  for(const tid of ordered){
    const text=String(fs.readFileSync('/proc/'+pid+'/task/'+tid+'/children','ascii')).trim(),listed=text?text.split(/\s+/):[];
    if(listed.some(child=>!/^[1-9][0-9]{0,9}$/.test(child)))fail('FAMILY_UNREADABLE');
    for(const child of listed.map(Number))if(!children.includes(child))children.push(child);
  }
  return children;
}
// T13 I-6, m-7: every family member is read natively: its children, its status and each of its
// descriptors. A member that cannot be read (for example a Chromium child that is not dumpable
// to this UID, or one that exited mid-walk) is FAMILY_UNREADABLE, never skipped.
function inspectNativeFamily(fs,controlTargets,root=process.pid) {
  const socketInodes=socketInodeFamilies(fs),seen=new Set([root]),queue=[root],members=[];let browserPid=0;
  while(queue.length){const pid=queue.shift();let children,status;
    try{children=childPids(fs,pid);status=procStatus(fs,pid);}catch(cause){fail('FAMILY_UNREADABLE',cause);}
    if(pid===root&&children.length&&!browserPid)browserPid=children[0];
    for(const child of children)if(!seen.has(child)){seen.add(child);queue.push(child);}
    const fds=forbiddenDescriptorCounts(fs,pid,pid===root?new Set():controlTargets,socketInodes);
    members.push(Object.freeze({pid,...status,...fds}));
  }
  return Object.freeze({workerPid:root,browserPid,members:Object.freeze(members),procScope:'BROWSER_FAMILY_ONLY'});
}
function nativeTopology(fs,init) {
  const status=procStatus(fs),fds=forbiddenDescriptorCounts(fs),devices=fs.readFileSync('/proc/net/dev','utf8').split('\n').slice(2)
    .map(line=>line.split(':',1)[0].trim()).filter(name=>name&&name!=='lo').length;
  return Object.freeze({version:1,runId:init.binding.runId,maxFrameBytes:16384,...status,
    procScope:'BROWSER_FAMILY_ONLY',...fds,networkDeviceCount:devices,tmpfsPaths:Object.freeze(tmpfsPaths(fs))});
}
function inheritedPipe(fs,reader,init,initBytes,clock) {
  const command=Object.freeze({fd:3}),result=Object.freeze({fd:4}),queue=[initBytes];
  const controlTargets=new Set([fs.readlinkSync('/proc/self/fd/3'),fs.readlinkSync('/proc/self/fd/4')]);
  const topology=nativeTopology(fs,init),channel={
    audit:()=>Object.freeze({role:'BROWSER',childId:init.childId,pipeId:init.pipeId,channelKeyHex:init.channelKeyHex,
      binding:init.binding,command,result}),
    async read(){return queue.length?queue.shift():reader.read();},
    async write(bytes){writeExactly(fs,4,bytes);},
    drain(){return reader.drain();},
  };
  // P56/P5 (C1, E7): the one 60000 ms cleanup end starts only at the worker's
  // first terminal event (startTerminal, or a terminal clamp). A routine read
  // never allocates it: remaining() refuses until the terminal start.
  let cleanupEnd=null;
  const monotonic=()=>Number(process.hrtime.bigint()/1000000n);
  function startCleanup(){if(cleanupEnd===null)cleanupEnd=monotonic()+60000;return cleanupEnd;}
  const cleanup={
    get deadline(){return cleanupEnd;},
    startTerminal(){const end=startCleanup();return Math.max(0,end-monotonic());},
    remaining(){if(cleanupEnd===null)fail('CLEANUP_NOT_STARTED');return Math.max(0,cleanupEnd-monotonic());},
    clamp(end){if(!Number.isSafeInteger(end)||end<0)fail('CLEANUP_UNCERTAIN');startCleanup();cleanupEnd=Math.min(cleanupEnd,end);},
  };
  const pipe={audit:()=>topology,inspectBrowserFamily:()=>inspectNativeFamily(fs,controlTargets)};
  const launchClock=clock&&typeof clock.sample==='function'?clock:Object.freeze({sample:()=>[Date.now(),Number(process.hrtime.bigint()/1000000n)]});
  pipe.launchContext=Object.freeze({channel,expected:channel.audit(),clock:launchClock,cleanupBudget:cleanup});
  return pipe;
}

async function inheritedMain(args,bindings) {
  if(!Array.isArray(args)||args.length!==1||args[0]!=='--inherited')return 64;
  if(!bindings||bindings.platform!=='linux'||bindings.arch!=='arm64'||bindings.uid!==10002||!bindings.fs)return 1;
  let reader;
  try{
    writeExactly(bindings.fs,4,Buffer.from('WAITING\n','ascii'));
    reader=bindings.reader||inheritedReader(bindings.fs);
    const initBytes=await reader.read(),init=decodeInheritedInit(initBytes),result=await runBrowserWorker(inheritedPipe(bindings.fs,reader,init,initBytes,bindings.clock));
    return result?.status==='EXITED'?0:1;
  }catch{return 1;}
  finally{try{reader?.close();}catch{}for(const fd of [3,4])try{bindings.fs.closeSync(fd);}catch{}}
}
function systemBindings() {
  const fs=require('node:fs');return Object.freeze({fs,platform:process.platform,arch:process.arch,uid:typeof process.getuid==='function'?process.getuid():-1});
}
async function main(args=process.argv.slice(2)) {return inheritedMain(args,systemBindings());}

async function runBrowserWorker(pipe, config) {
  let wire, state, startup;
  try {
    const topology = audit(pipe);
    const launch = pipe.launchContext;
    if (!launch || !launch.channel) fail('BOOTSTRAP_REQUIRED');
    // T13 m-6: startup, through READY, is bounded by the run binding's expiry.
    const expiresAt = launch.expected?.binding?.expiresAtMs;
    if (!safe(expiresAt) || typeof launch.clock?.sample !== 'function') fail('BOOTSTRAP_REQUIRED');
    startup = runExpiry(launch.clock, expiresAt);
    const binding = await startup.race(bindBrowserWorkerChannel(launch.channel, launch.expected, launch.clock, launch.cleanupBudget));
    const prepareRecord=Buffer.isBuffer(launch.prepareRecord)?launch.prepareRecord:await startup.race(launch.channel.read());
    const reservation = await startup.race(binding.prepare(prepareRecord));
    const transported=typeof binding.inspectPreparedBrowserConfig==='function'?binding.inspectPreparedBrowserConfig(reservation):null;
    if(config===undefined||config===null)config=transported;
    else if(transported!==null&&!equal(config,transported))fail('CONFIG_INVALID');
    validateConfig(config);
    const imported=importBrowserAssetBundle(config.assetBundle,typeof launch.clock?.sample==='function'?()=>launch.clock.sample()[0]:undefined);
    if(!equal(imported.assets.entries,config.assetEntries))fail('CONFIG_INVALID');
    if (config.runBinding.runId !== topology.runId) fail('RUNTIME_IDENTITY_MISMATCH');
    if(launch.expected?.binding&&(config.runBinding.runId!==launch.expected.binding.runId||
        config.runBinding.configIdentity!==launch.expected.binding.configIdentity||
        config.runBinding.manifestIdentity!==launch.expected.binding.manifestDigest||
        config.runBinding.expiresAt!==launch.expected.binding.expiresAtMs))fail('RUNTIME_IDENTITY_MISMATCH');
    let launched, primaryPending=true, primary;
    // The commit is not raced: abandoning it could orphan a browser launched after
    // the race. It is bounded by its proof deadlines and the controller's P5
    // activation bound, and expiry is asserted as soon as it returns.
    const outcome = await binding.commitFixedBrowserLaunch(reservation, async () => {
      let browser, context;
      try {
        browser = await chromium.launch(launchOptions(config));
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
      } catch (cause) {
        try { if (context) await context.close(); } catch {}
        try { if (browser) await browser.close(); } catch {}
        fail('LAUNCH_FAILED', cause);
      }
      let closed = false,closing;
      const owner = Object.freeze({ async stopOwned(requested) {
        // Stopping the browser is terminal: it starts the one cleanup end (C1, P56).
        const budget=launch.cleanupBudget;
        const remaining=typeof budget?.startTerminal==='function'?budget.startTerminal():typeof budget?.remaining==='function'?budget.remaining():0;
        const allowance=requested===undefined?remaining:Math.min(remaining,requested);
        if(!closing)closing=Promise.allSettled([Promise.resolve().then(()=>context.close()),Promise.resolve().then(()=>browser.close())]);
        const outcomes=await bounded(closing,allowance);
        if(outcomes.some(value=>value.status!=='fulfilled'))fail('CLEANUP_UNCERTAIN');closed=true;
        return { status: 'STOPPED', runId: topology.runId };
      } });
      launched = { browser, context, owner, get closed() { return closed; } };
      return owner;
    });
    if (!outcome || outcome.status !== 'STARTED' || !launched) fail('LAUNCH_FAILED');state=launched;startup.assert();
    wire=rpc(outcome.applicationPipe,auditApplication(outcome.applicationPipe,topology.runId));
    inspectFamily(pipe);
    const decisions=new Map();launched.decisions=decisions;let ready=false,commandFailure,loginSpent=false,boundSession=null,activeAction=null;
    let readinessState=null,paperFacts=null,lastReadinessSequence=0;const readinessPhases=new Set();
    const sessionKey=randomBytes(32);
    let rejectActionFailure;
    const actionFailure=new Promise((_,reject)=>{rejectActionFailure=reject;});actionFailure.catch(()=>{});
    async function executeAction(actionId,action,payload){
      if(action==='LOGIN_SESSION'){
        if(loginSpent)fail('LOGIN_ALREADY_ATTEMPTED');loginSpent=true;
        const expectedOwner=Object.freeze({id:payload.ownerId,username:payload.username});
        const response=state.page.waitForResponse(value=>meResponse(value,config.runBinding.origins.BACKEND),{timeout:10000});
        let password=payload.password;
        try{await state.page.getByPlaceholder('Username').fill(payload.username);await state.page.getByPlaceholder('Password').fill(password);}
        finally{password=null;payload.password='';}
        await wire.write('FILLED',{actionId,status:'FILLED'});
        await state.page.getByRole('button',{name:'Log In',exact:true}).click();
        boundSession=await sessionSnapshot(state.context,await response,config.runBinding.origins.BACKEND,expectedOwner,sessionKey);
        boundSession=Object.freeze({...boundSession,expectedOwner});
        await wire.write('RESULT',{actionId,status:'SESSION_BOUND',fingerprint:boundSession.fingerprint});return;
      }
      if(!boundSession)fail('SESSION_INVALID');
      // T13 I-4/I-5 (C9): one worker readiness per phase (phases only advance, sequences only
      // increase); a view runs only after its own phase's readiness.
      if(action==='SESSION_READINESS'){
        if(readinessPhases.has(payload.phase)||payload.phase==='OBSERVE_BEFORE_RESTART'&&readinessPhases.has('OBSERVE_AFTER_RESTART')||
           payload.sequence<=lastReadinessSequence)fail('REPLAY');
        readinessPhases.add(payload.phase);lastReadinessSequence=payload.sequence;readinessState=null;paperFacts=null;
        const observed=await observeReadiness(state.page,state.context,config.runBinding.origins.BACKEND,payload.phase,payload.sequence,
          boundSession,sessionKey,launch.clock,topology.runId);
        readinessState=Object.freeze({phase:payload.phase,sequence:payload.sequence});
        await wire.write('RESULT',{actionId,...observed});return;
      }
      if(action==='OBSERVE_VIEW'){
        if(!readinessState||readinessState.phase!==payload.phase)fail('READINESS_FAILED');
        const facts=paperFacts&&paperFacts.phase===readinessState.phase&&paperFacts.sequence===readinessState.sequence?paperFacts:null;
        const {observed,paper}=await observeFixedView(state.page,state.context,config.runBinding.origins.BACKEND,
          config.runBinding.origins.FRONTEND,payload.phase,payload.view,readinessState.sequence,facts,boundSession,sessionKey);
        if(paper)paperFacts=Object.freeze({phase:readinessState.phase,sequence:readinessState.sequence,source:paper.source,brokerError:paper.brokerError});
        await wire.write('RESULT',{actionId,...observed});return;
      }
      const observed=await sessionFingerprint(state.context,config.runBinding.origins.BACKEND,sessionKey);
      await wire.write('RESULT',{actionId,status:'SESSION_OBSERVED',fingerprint:observed.fingerprint});
    }
    function dispatchAction(actionId,action,payload){
      const operation=executeAction(actionId,action,payload);activeAction=operation;
      operation.then(()=>{if(activeAction===operation)activeAction=null;},cause=>{
        (async()=>{try{await wire.write('ERROR',{actionId,code:cause?.code||'BROWSER_FAILED'});}
          finally{rejectActionFailure(cause);}})().catch(()=>{});
      });
    }
    const commandLoop=(async()=>{try{while(true){
      const frame=await Promise.race([wire.read(),actionFailure]);
      if(frame.type==='DECISION'){
        exact(frame.payload,['requestId','decision']);
        if(typeof frame.payload.requestId!=='string'||!['CONTINUE','ABORT'].includes(frame.payload.decision))fail('FRAME_DENIED');
        const slot=decisions.get(frame.payload.requestId);if(!slot)fail('FRAME_DENIED');decisions.delete(frame.payload.requestId);slot.resolve(frame.payload.decision);continue;
      }
      if(frame.type==='ACTION'){
        exact(frame.payload,['actionId','action','payload']);const {actionId,action,payload}=frame.payload;
        if(!ready||!safe(actionId)||activeAction){await wire.write('ERROR',{actionId,code:'ACTION_DENIED'});continue;}
        try{sessionAction(action,payload);}catch(cause){await wire.write('ERROR',{actionId,code:cause?.code||'ACTION_DENIED'});continue;}
        dispatchAction(actionId,action,payload);continue;
      }
      if(frame.type==='CLOSE'){exact(frame.payload,[]);if(activeAction)fail('ACTION_DENIED');const result=await state.owner.stopOwned();await wire.write('EXIT',{status:result.status,runId:result.runId});
        return Object.freeze({status:'EXITED',runId:topology.runId});}
      fail('FRAME_DENIED');
    }}catch(cause){commandFailure=cause;for(const slot of decisions.values())slot.reject(cause);decisions.clear();throw cause;}})();
    commandLoop.catch(()=>{});
    try {
      const validatedAssets = new Map(), assetTasks = [];
      let requestSequence = 0, assetFailure, documentValidated = false;
      const rejectedPages = new WeakSet();
      // T13 I-3: asset and document integrity holds for the whole run. Any failure,
      // before or after READY, ends the worker; its terminal ERROR then latches the
      // controller's session as OBSERVATION_FAILED.
      function assetFailed(cause) {
        const error=cause?.code==='OBSERVATION_FAILED'?cause:Object.assign(new Error('OBSERVATION_FAILED',{cause}),{code:'OBSERVATION_FAILED'});
        if(!assetFailure)assetFailure=error;rejectActionFailure(error);
      }
      // P70: Playwright never sends redirect hops through the route handler, so a
      // hop would reach its target without admission (307/308 keep the method and
      // body). The acceptance flow never redirects: any redirect ends the worker, and
      // its terminal ERROR latches the controller's session as ROUTE_DENIED.
      function redirected() {rejectActionFailure(Object.assign(new Error('ROUTE_DENIED'),{code:'ROUTE_DENIED'}));}
      launched.context.on('request', request => {
        let from;try{from=request.redirectedFrom();}catch{from=true;}
        if(from!==null)redirected();
      });
      launched.context.on('page', async page => { if (primaryPending) { primaryPending = false; primary = page; } else { rejectedPages.add(page); await page.close(); } });
      await startup.race(launched.context.routeWebSocket('**/*', async socket => socket.close()));
      await startup.race(launched.context.addInitScript(() => { Object.defineProperty(globalThis, 'WebTransport', { configurable: false, value: undefined }); }));
      await startup.race(launched.context.route('**/*', async route => {
        const request = route.request();
        if (typeof request.redirectedFrom === 'function') { let from; try { from = request.redirectedFrom(); } catch { from = true; }
          if (from !== null) { redirected(); return route.abort(); } }
        if (typeof request.frame === 'function') { let page; try { page=request.frame().page(); } catch { return route.abort(); }
          if(!page||rejectedPages.has(page)||primary&&page!==primary)return route.abort(); }
        const before=Buffer.from(request.postDataBuffer()||Buffer.alloc(0)),sequence=++requestSequence,requestId='browser-'+sequence;
        let facts,proof;
        try{facts=factsFor(request,requestId);if(facts)proof=bodyProof(topology.runId,requestId,sequence,facts.method,facts.url,facts.headers,before);}
        catch{return route.abort();}
        // T13 I-2: a credential or method-override header is aborted here, before any ROUTE frame.
        if(!facts||proof.schema==='INVALID'||decisions.size>=16)return route.abort();
        const digest=createHash('sha256').update(before).digest(),decision=new Promise((resolve,reject)=>decisions.set(requestId,{resolve,reject}));
        decision.catch(()=>{});
        // An unsendable ROUTE frame (for example one over the frame bound) never leaves the request pending.
        try{await wire.write('ROUTE',proof);}catch(cause){decisions.delete(requestId);await route.abort();rejectActionFailure(cause);return;}
        let selected;try{selected=await decision;}catch{selected='ABORT';}
        const after=Buffer.from(request.postDataBuffer()||Buffer.alloc(0));
        if(selected!=='CONTINUE'||before.length!==after.length||!timingSafeEqual(digest,createHash('sha256').update(after).digest()))await route.abort();else await route.continue();
      }));
      launched.context.on('response',response=>{
        // P70: a 3xx answer to a routed request is a redirect (every request is routed).
        let status;try{status=response.status();}catch{status=null;}
        if(Number.isSafeInteger(status)&&status>=300&&status<=399){redirected();return;}
        const task=(async()=>{
        if(!Number.isSafeInteger(status))fail('OBSERVATION_FAILED');
        const url=new URL(response.url()),isDocument=SPA_DOCUMENT_PATHS.includes(url.pathname);
        const index=config.assetEntries.findIndex(item=>item.path===(isDocument?INDEX_ENTRY_PATH:url.pathname));
        if(index<0){if(isDocument)fail('OBSERVATION_FAILED');return;}
        const entry=imported.assets.entries[index];if(url.origin!==config.runBinding.origins.FRONTEND||url.search||url.hash)fail('OBSERVATION_FAILED');
        const declared=response.headers()['content-length'];if(declared!==undefined&&(!/^(?:0|[1-9][0-9]*)$/.test(declared)||Number(declared)!==entry.size))fail('OBSERVATION_FAILED');
        const body=await response.body(),type=String(response.headers()['content-type']||'').split(';',1)[0];
        const proof=validateAssetResponse(entry,body,type);
        // Repeats are validated too; the first proof stands for the entry.
        if(!validatedAssets.has(entry.path))validatedAssets.set(entry.path,proof);
        if(isDocument)documentValidated=true;
      })().catch(assetFailed);if(!ready)assetTasks.push(task);});
      const page=await startup.race(launched.context.newPage());primary=primary||page;
      // T13 I-1: the first navigation is the login document, which phase P admits.
      await startup.race(page.goto(config.runBinding.origins.FRONTEND+'/login',{waitUntil:'domcontentloaded'}));
      if(typeof page.waitForLoadState==='function')await startup.race(page.waitForLoadState('load'));
      await startup.race(Promise.all(assetTasks));
      if(commandFailure)throw commandFailure;
      if(assetFailure||!documentValidated||validatedAssets.size!==config.assetEntries.length)fail('OBSERVATION_FAILED',assetFailure);
      // T13 m-7: the renderer and utility processes exist only now. The family is inspected
      // again after the first page load and before READY, so before any credential arrives.
      inspectFamily(pipe);
      launched.page=primary;launched.assetProofs=config.assetEntries.map(entry=>validatedAssets.get(entry.path));
    } catch(cause){try{await launched.owner.stopOwned();}catch{}throw cause;}
    await startup.race(wire.write('ASSETS', { proofs: state.assetProofs }));
    ready=true;
    await startup.race(wire.write('READY', { status: 'READY' }));
    startup.clear();
    return await commandLoop;
  } catch (cause) {
    startup?.clear();
    const code = cause && cause.code || 'BROWSER_FAILED';
    try { if (state && state.owner) await state.owner.stopOwned(); } catch {}
    try { if (wire) await wire.write('ERROR', { code }); } catch {}
    return Object.freeze({ status: 'FAILED', code });
  }
}

// The native readers are exported for the offline fake-/proc tests and the gated guest test.
module.exports = Object.freeze({ runBrowserWorker, inheritedMain, main,
  classifyDescriptor, socketInodeFamilies, procStatus, forbiddenDescriptorCounts, inspectNativeFamily, nativeTopology });
if(require.main===module)main().then(code=>{process.exitCode=code;},()=>{process.exitCode=1;});
