'use strict';
// Fixed-schema observations only. This module never publishes exception text or payloads.
const STAGES=['SP01_STAGE_CHECK','SP02_PAGE_CREATE','SP03_HEALTH_NAVIGATION','SP04_INTERCEPTION_REMOVE','SP05_DENIED_FETCH','SP06_CONTROL_FETCH','SP07_INTERCEPTION_RESTORE','SP08_PAGE_CLOSE','SP09_ASSERT_DENIED_STATUS','SP10_ASSERT_CONTROL_STATUS'];
const BACK='https://day-trader-backend.fly.dev';
function safeError(e){
 const name=['Error','TypeError','SyntaxError','TimeoutError','AbortError','SecurityError','DOMException'].includes(e?.name)?e.name:'OtherError';
 const text=String(e?.message||'');
 const codes=['ERR_CERT_AUTHORITY_INVALID','ERR_CERT_COMMON_NAME_INVALID','ERR_CERT_DATE_INVALID','ERR_CONNECTION_REFUSED','ERR_CONNECTION_CLOSED','ERR_NAME_NOT_RESOLVED','ERR_BLOCKED_BY_RESPONSE','ERR_BLOCKED_BY_CLIENT','ERR_FAILED'];
 const code=codes.find(x=>text.includes('net::'+x))||(/Content Security Policy|content security policy/.test(text)?'CONTENT_SECURITY_POLICY':text.includes('Failed to fetch')?'FETCH_REJECTED':name==='TimeoutError'?'TIMEOUT':'UNCLASSIFIED');
 return {errorClass:name,safeErrorCode:code};
}
// Serialized unchanged by Playwright: one evaluation, same two sequential fetch calls.
async function fetchPair(){
 const stages=[];
 for(const [stage,pathId,path] of [['SP05_DENIED_FETCH','denied-recommendations-query','/api/recommendations?x=1'],['SP06_CONTROL_FETCH','control-me','/api/me']]){
  const row={stage,pathId,started:true,completed:false,success:false,requestResolved:false,responseReceived:false};stages.push(row);
  try{const response=await fetch(path);row.httpStatus=response.status;row.requestResolved=true;row.responseReceived=true;row.success=true;row.completed=true;}
  catch(e){row.completed=true;row.errorClass=['Error','TypeError','SyntaxError','AbortError','SecurityError'].includes(e?.name)?e.name:'OtherError';row.safeErrorCode=String(e?.message||'').includes('Failed to fetch')?'FETCH_REJECTED':'UNCLASSIFIED';return {stages};}
 }
 return {stages};
}
async function securityProbe({context,intercept,currentStage,invalidate,record,healthOnly=false}){
 const stages=STAGES.map(stage=>({stage,started:false,completed:false,success:null}));
 stages[2].pathId='health';stages[4].pathId='denied-recommendations-query';stages[5].pathId='control-me';
 stages[8].expectedStatus=403;stages[8].actualStatus=null;stages[9].expectedStatus=401;stages[9].actualStatus=null;
 let sequence=0,p=null,removalAttempted=false,failed=false,restorationFatal=false,evidenceWriteFailed=false;const browserErrors=[];
 const publish=()=>{try{record({version:1,stages:stages.map(x=>({...x})),firstFailure:stages.filter(x=>x.success===false).sort((a,b)=>a.finishedOrder-b.finishedOrder)[0]?.stage||null,restorationFatal,evidenceWriteFailed,browserErrors:[...browserErrors],pass:!failed&&stages.every(x=>x.success===true)});}catch{evidenceWriteFailed=true;failed=true;}};
 const begin=n=>{Object.assign(stages[n-1],{started:true,startedOrder:++sequence});publish();};
 const end=(n,success,fields={})=>{Object.assign(stages[n-1],{completed:true,success,finishedOrder:++sequence,...fields});if(!success)failed=true;publish();};
 const operation=async(n,fn,fields=()=>({}))=>{begin(n);try{const result=await fn();end(n,true,fields(result));return result;}catch(e){end(n,false,safeError(e));throw e;}};
 const consoleError=message=>{const facts=safeError({name:'Error',message:message.text()});if(facts.safeErrorCode!=='UNCLASSIFIED'&&browserErrors.length<8){browserErrors.push(facts.safeErrorCode);publish();}};
 try{
  await operation(1,async()=>{if(currentStage()!=='AWAIT_CREDENTIAL')throw Error();});
  p=await operation(2,()=>context.newPage());p.on('console',consoleError);
  await operation(3,()=>p.goto(BACK+'/health'),response=>({responseReceived:!!response,httpStatus:response?.status()??null,expectedOriginReached:(()=>{try{return new URL(p.url()).origin===BACK;}catch{return false;}})()}));
  if(!healthOnly)try{
   removalAttempted=true;await operation(4,()=>context.unroute('**/*',intercept));
   // A returned unroute call is recorded, not treated as proof that routing is absent.
   let fetched;
   try{fetched=await p.evaluate(fetchPair);}catch(e){begin(5);end(5,false,{...safeError(e),evaluationRejected:true,requestResolved:false,responseReceived:false});throw e;}
   for(const row of fetched.stages){
    const n=row.stage==='SP05_DENIED_FETCH'?5:6;begin(n);
    const fields={pathId:n===5?'denied-recommendations-query':'control-me',requestResolved:row.requestResolved===true,responseReceived:row.responseReceived===true};
    if(Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599){fields.httpStatus=row.httpStatus;stages[n===5?8:9].actualStatus=row.httpStatus;}
    if(row.success!==true)Object.assign(fields,{errorClass:['Error','TypeError','SyntaxError','AbortError','SecurityError'].includes(row.errorClass)?row.errorClass:'OtherError',safeErrorCode:row.safeErrorCode==='FETCH_REJECTED'?'FETCH_REJECTED':'UNCLASSIFIED'});
    end(n,row.success===true,fields);
   }
   if(stages[4].success!==true||stages[5].success!==true)throw Error();
  }finally{
   if(removalAttempted){try{await operation(7,()=>context.route('**/*',intercept));}catch(e){restorationFatal=true;invalidate();publish();throw e;}}
  }
 }catch{failed=true;}
 finally{if(p){try{await operation(8,()=>p.close());}catch{failed=true;}finally{p.off('console',consoleError);}}}
 if(!failed&&!healthOnly){
  for(const n of [9,10]){begin(n);const ok=stages[n-1].actualStatus===stages[n-1].expectedStatus;end(n,ok,ok?{}:{errorClass:'Error',safeErrorCode:'STATUS_MISMATCH'});if(!ok)break;}
 }
 publish();if(evidenceWriteFailed)throw Error('SECURITY_PROBE_EVIDENCE_FAILED');if(failed)throw Error();if(healthOnly)return {healthOnly:true,pass:false};return {denied:stages[8].actualStatus,control:stages[9].actualStatus,pass:true};
}
function observeBoundary(req,res,boundary,write){
 const pathId={'/health':'health','/api/recommendations?x=1':'denied-recommendations-query','/api/me':'control-me'}[req.url];
 if(req.method!=='GET'||req.headers.host!=='day-trader-backend.fly.dev'||!pathId||!['tls','gateway','backend'].includes(boundary))return;
 write=write||((row)=>require('node:fs').appendFileSync('/evidence/security-boundary-'+boundary+'.jsonl',JSON.stringify(row)+'\n'));
 const base={boundary,pathId,method:'GET'};write({...base,event:'handler'});
 res.once('finish',()=>write({...base,event:'response',httpStatus:res.statusCode}));
}
module.exports={securityProbe,fetchPair,observeBoundary,safeError,STAGES};
