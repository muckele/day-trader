'use strict';
// Hosted synthetic browser-only exceptions. No additional forwarded Home routes.
const {parseRequest,B,F}=require('./policy.cjs');
const HOME=['/api/recommendations','/api/watchlist/default'];
function safeResponse(response,phase){
 if(!response||response.headers?.['access-control-allow-origin']!=='https://'+F||response.headers?.['access-control-allow-credentials']!=='true'||Object.keys(response.headers).length!==2)throw Error('MARKET_RESPONSE_REJECTED');
 if(!/^application\/json(?:; charset=utf-8)?$/i.test(response.contentType)||typeof response.body!=='string'||Buffer.byteLength(response.body)>2048)throw Error('MARKET_RESPONSE_REJECTED');
 let body;try{body=JSON.parse(response.body);}catch{throw Error('MARKET_RESPONSE_REJECTED');}
 const valid=phase==='PREFLIGHT'?response.status===401&&Object.keys(body).join(',')==='message'&&body.message==='Missing authentication token':response.status===200&&['OPEN','CLOSED'].includes(body.status)&&body.source==='alpaca-clock'&&body.executionSource==='alpaca-paper'&&Number.isFinite(Date.parse(body.asOf))&&Math.abs(Date.now()-Date.parse(body.asOf))<=60000&&Object.keys(body).every(k=>['status','source','executionSource','asOf','nextOpen','nextClose'].includes(k));
 if(!valid)throw Error('MARKET_RESPONSE_REJECTED');
 return Object.freeze({status:response.status,contentType:response.contentType,body:response.body,headers:Object.freeze({...response.headers})});
}
function createEntryPolicy({now=Date.now,preauth=null,persistPreauth=()=>{}}={}){
 let transition='IDLE',deadline=0,pre=preauth?safeResponse(preauth,'PREFLIGHT'):null,auth=null,session=null,invalid=false;
 const denied=Object.fromEntries(HOME.map(p=>[p,0])),forwarded={PREFLIGHT:0,BEFORE:0};let preauthReplays=0,authenticatedReplays=0,authBlocks=0;
 function active(){return transition==='ACTIVE'&&now()<=deadline;}
 function invalidate(){auth=null;session=null;invalid=true;transition='CLOSED';}
 return {
  arm(){if(transition!=='IDLE'||invalid)throw Error('TRANSITION_REJECTED');transition='ARMED';deadline=now()+10000;},
  loginResponse(status){if(transition!=='ARMED'||now()>deadline||status!==200){transition='FAILED';return;}transition='ACTIVE';},
  complete(){return active()&&HOME.every(p=>denied[p]===1);},
  close(){if(!active()||!HOME.every(p=>denied[p]===1))throw Error('TRANSITION_REJECTED');transition='CLOSED';},
  invalidate,
  decide(req,phase,currentSession){
   // Reuse every existing method/header/host/target check for Home classification
   // by validating its otherwise identical envelope against the queryless /api/me.
   if(HOME.includes(req.target)){
    const envelope=parseRequest({...req,target:'/api/me'});
    if(active()&&phase==='AUTH'&&req.method==='GET'&&envelope?.host===B&&denied[req.target]===0){denied[req.target]++;return {kind:'transition-denied'};}
    return {kind:'unexpected'};
   }
   const d=parseRequest(req);if(d?.id!=='market-status')return {kind:'unexpected'};
   if(invalid)return {kind:'unexpected'};
   if(auth&&currentSession!==session){invalidate();return {kind:'unexpected'};}
   if(auth&&['BEFORE','HOLD','AFTER'].includes(phase))return ++authenticatedReplays<=32?{kind:'replay',response:auth}:{kind:'unexpected'};
   if(!currentSession&&pre&&['PREFLIGHT','AUTH'].includes(phase))return ++preauthReplays<=32?{kind:'replay',response:pre}:{kind:'unexpected'};
   if(phase==='AUTH')return ++authBlocks<=2?{kind:'block'}:{kind:'unexpected'};
   if(phase==='PREFLIGHT'&&!currentSession&&!pre&&forwarded.PREFLIGHT===0){forwarded.PREFLIGHT++;return {kind:'forward'};}
   if(phase==='BEFORE'&&currentSession&&!auth&&forwarded.BEFORE===0){forwarded.BEFORE++;session=currentSession;return {kind:'forward'};}
   return {kind:'unexpected'};
  },
  capture(phase,response,currentSession){
   if(invalid||forwarded[phase]!==1)throw Error('MARKET_RESPONSE_REJECTED');
   const receipt=safeResponse(response,phase);
   if(phase==='PREFLIGHT'&&!currentSession&&!pre){pre=receipt;persistPreauth(pre);}
   else if(phase==='BEFORE'&&currentSession===session&&!auth)auth=receipt;
   else throw Error('MARKET_RESPONSE_REJECTED');
  },
  ready(phase){return phase==='PREFLIGHT'?!!pre:!!auth&&!invalid;},
  facts(){return {transition,denied:{...denied},preauthReplays,authenticatedReplays,authBlocks,forwarded:{...forwarded}};}
 };
}
function dispatch(route,decision){
 if(decision.kind==='forward')return route.continue();
 if(decision.kind==='replay')return route.fulfill({status:decision.response.status,contentType:decision.response.contentType,body:decision.response.body,headers:decision.response.headers});
 return route.abort('blockedbyclient');
}
module.exports={createEntryPolicy,dispatch};
