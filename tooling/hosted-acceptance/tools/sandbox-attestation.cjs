'use strict';
// Source mapping pinned to Chromium 145.0.7632.6 (Linux):
// https://github.com/chromium/chromium/blob/145.0.7632.6/chrome/browser/resources/sandbox_internals/sandbox_internals.ts
// https://github.com/chromium/chromium/blob/145.0.7632.6/chrome/browser/ui/webui/sandbox/sandbox_internals_ui.cc
const d=require('./startup-diagnostics.cjs');
const REQUIRED={'Layer 1 Sandbox':'Namespace','PID namespaces':'Yes','Network namespaces':'Yes','Seccomp-BPF sandbox':'Yes'};
const INFORMATIONAL=['Seccomp-BPF sandbox supports TSYNC','Ptrace Protection with Yama LSM (Broker)','Ptrace Protection with Yama LSM (Non-broker)'];
const POSITIVE='You are adequately sandboxed.';
const normalize=s=>typeof s==='string'?s.replace(/\s+/g,' ').trim():null;
const isSandboxUrl=url=>url==='chrome://sandbox/'||url==='chrome://sandbox';
function parse(snapshot,readErrors=[]){
 const errors=[...readErrors],rows=Array.isArray(snapshot.rows)?snapshot.rows:[];
 if(!isSandboxUrl(snapshot.url))errors.push('UNEXPECTED_PAGE_URL');
 if(snapshot.tableCount!==1)errors.push('STATUS_TABLE_COUNT');
 if(snapshot.evaluationCount!==1)errors.push('EVALUATION_COUNT');
 if(snapshot.truncated||rows.length>16)errors.push('OBSERVATION_BOUNDS_EXCEEDED');
 if(!Array.isArray(snapshot.rows))errors.push('ROWS_MALFORMED');
 if(snapshot.malformedCells)errors.push('NON_TD_CELL');
 const seen=new Set();
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==2||row.some(x=>typeof x!=='string'||!normalize(x)||x.length>256)){errors.push('ROW_MALFORMED');continue;}
  const label=normalize(row[0]);if(seen.has(label))errors.push('DUPLICATE_LABEL');seen.add(label);
 }
 const values=label=>rows.filter(r=>Array.isArray(r)&&normalize(r[0])===label).map(r=>normalize(r[1]));
 const checks=Object.entries(REQUIRED).map(([label,expected])=>{const observed=values(label);return {label,expected,observed,pass:observed.length===1&&observed[0]===expected};});
 const assessment=typeof snapshot.assessment==='string'?snapshot.assessment:null;
 const overall={expected:POSITIVE,observed:assessment,pass:assessment!==null&&assessment.trim()===POSITIVE};
 const informational=INFORMATIONAL.map(label=>({label,observed:values(label)}));
 return {pageUrl:snapshot.url,tableCount:snapshot.tableCount,evaluationCount:snapshot.evaluationCount,truncated:!!snapshot.truncated,actualRows:rows,assessment,checks,overall,informational,errors:[...new Set(errors)],pass:errors.length===0&&checks.every(x=>x.pass)&&overall.pass};
}
// This function executes read-only in Chromium; it never changes the DOM or values.
function readDom(){
 if(location.href!=='chrome://sandbox/'&&location.href!=='chrome://sandbox')return {url:'<unexpected-page>',rows:[],tableCount:0,evaluationCount:0,assessment:'',truncated:false};
 const tables=document.querySelectorAll('#sandbox-status'),evaluations=document.querySelectorAll('#evaluation');
 const rows=tables.length===1?Array.from(tables[0].querySelectorAll('tr')):[];
 let truncated=rows.length>16,malformedCells=false;
 const bound=value=>{if(value.length>256)truncated=true;return value.slice(0,256);};
 const cells=rows.slice(0,16).map(row=>{const columns=Array.from(row.children);if(columns.length>4)truncated=true;return columns.slice(0,4).map(c=>{if(c.tagName!=='TD')malformedCells=true;return bound(c.textContent||'');});});
 const assessment=evaluations.length===1?bound(evaluations[0].textContent||''):'';
 return {url:location.href,rows:cells,tableCount:tables.length,evaluationCount:evaluations.length,assessment,truncated,malformedCells};
}
function populated(){
 return (location.href==='chrome://sandbox/'||location.href==='chrome://sandbox')&&document.querySelectorAll('#sandbox-status').length===1&&document.querySelectorAll('#sandbox-status tr').length>=4&&document.querySelectorAll('#evaluation').length===1&&!!document.querySelector('#evaluation').textContent.trim();
}
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DOM_READ_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
async function observeAndAssert(page,identity,record=d.record,timeoutMs=5000){
 const errors=[];let snapshot={url:isSandboxUrl(page.url())?page.url():'<unexpected-page>',rows:[],tableCount:0,evaluationCount:0,assessment:'',truncated:false};
 if(isSandboxUrl(page.url())){
  try{await page.waitForFunction(populated,undefined,{timeout:timeoutMs,polling:100});}catch(e){errors.push(e.name==='TimeoutError'?'TABLE_READINESS_TIMEOUT':'TABLE_READINESS_FAILED');}
  try{snapshot=await bounded(page.evaluate(readDom),timeoutMs);}catch(e){errors.push(e.message==='DOM_READ_TIMEOUT'?'DOM_READ_TIMEOUT':'DOM_READ_FAILED');}
 }
 if(identity.browserVersion!=='Google Chrome for Testing 145.0.7632.6'||identity.playwrightVersion!=='1.58.2')errors.push('UNSUPPORTED_BROWSER_VERSION');
 const result=parse(snapshot,errors);
 // The established host publication gate sanitizes this bounded private record.
 record('Chromium-sandbox','O','observed',{...identity,evidenceSource:'chrome://sandbox DOM',...result});
 if(!result.pass)throw Error('SANDBOX_ATTESTATION_FAILED');
 return result;
}
module.exports={REQUIRED,INFORMATIONAL,POSITIVE,parse,readDom,populated,observeAndAssert};
