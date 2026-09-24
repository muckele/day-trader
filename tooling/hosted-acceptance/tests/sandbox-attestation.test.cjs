'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const a=require('../tools/sandbox-attestation.cjs');
// Constructed source-derived fixtures from Chromium 145.0.7632.6 Linux TS/C++.
// These are NOT runtime observations from the previous B trial.
const fixture=()=>({url:'chrome://sandbox/',tableCount:1,evaluationCount:1,truncated:false,malformedCells:false,rows:[['Layer 1 Sandbox','Namespace'],['PID namespaces','Yes'],['Network namespaces','Yes'],['Seccomp-BPF sandbox','Yes'],['Seccomp-BPF sandbox supports TSYNC','Yes'],['Ptrace Protection with Yama LSM (Broker)','Yes'],['Ptrace Protection with Yama LSM (Non-broker)','No']],assessment:'You are adequately sandboxed.'});
const identity={browserVersion:'Google Chrome for Testing 145.0.7632.6',playwrightVersion:'1.58.2',executableSha256:'a'.repeat(64)};
test('version-correct source-derived fixture fails old matcher and passes table parser',()=>{
 const f=fixture();assert.equal(/Namespace Sandbox\s+Yes/i.test(f.rows.flat().join('\n')),false);assert.equal(a.parse(f).pass,true);
});
test('None, SUID and unrecognized required values fail closed',()=>{
 for(const value of ['None','SUID','namespace','Namespace Yes','']){const f=fixture();f.rows[0][1]=value;const r=a.parse(f);assert.equal(r.pass,false);assert.deepEqual(r.checks[0].observed,[value]);}
});
test('PID, network and enabled Seccomp required independently of TSYNC',()=>{
 for(const index of [1,2,3]){const f=fixture();f.rows[index][1]='No';const r=a.parse(f);assert.equal(r.pass,false);assert.equal(r.checks[index].pass,false);assert.deepEqual(r.checks[index].observed,['No']);assert.deepEqual(r.informational[0].observed,['Yes']);}
});
test('missing required rows, duplicates, contradiction and malformed cells fail',()=>{
 for(const mutate of [f=>f.rows.splice(0,1),f=>f.rows.push(['PID namespaces','Yes']),f=>f.rows.push(['PID namespaces','No']),f=>f.rows[1].push('extra'),f=>f.rows[1]=['PID namespaces'],f=>f.rows[1]=null,f=>f.tableCount=0,f=>f.evaluationCount=2,f=>f.rows=[],f=>f.malformedCells=true,f=>f.truncated=true]){
  const f=fixture();mutate(f);assert.equal(a.parse(f).pass,false);
 }
});
test('row ordering and harmless whitespace normalize, informational No does not fail',()=>{
 const f=fixture();f.rows.reverse();f.rows=f.rows.map(([k,v])=>[' \n'+k.replaceAll(' ','  ')+' ', '\t'+(a.INFORMATIONAL.includes(k)?'No':v)+'\n']);assert.equal(a.parse(f).pass,true);
});
test('negative or embellished overall assessment cannot pass on sandboxed substring',()=>{
 for(const value of ['You are NOT adequately sandboxed.','sandboxed.','You are adequately sandboxed. NOT','']){const f=fixture();f.assessment=value;const r=a.parse(f);assert.equal(r.pass,false);assert.equal(r.overall.observed,value);}
});
test('observations and each failed value are recorded before assertion throws',async()=>{
 const f=fixture();f.rows[1][1]='No';f.rows[3][1]='No';const events=[];
 const page={url:()=>f.url,waitForFunction:async()=>{},evaluate:async()=>f};
 await assert.rejects(a.observeAndAssert(page,identity,(...r)=>events.push(r)),/SANDBOX_ATTESTATION_FAILED/);
 assert.equal(events.length,1);const r=events[0][3];assert.deepEqual(r.actualRows,f.rows);assert.deepEqual(r.checks[1].observed,['No']);assert.deepEqual(r.checks[3].observed,['No']);assert.equal(r.checks[0].pass,true);assert.equal(r.assessment,f.assessment);
});
test('readiness/read errors and partial observations survive before failure',async()=>{
 const f=fixture();f.rows=f.rows.slice(0,1);const events=[];
 const page={url:()=>f.url,waitForFunction:async()=>{throw Object.assign(Error(),{name:'TimeoutError'})},evaluate:async()=>f};
 await assert.rejects(a.observeAndAssert(page,identity,(...r)=>events.push(r)));
 assert.ok(events[0][3].errors.includes('TABLE_READINESS_TIMEOUT'));assert.deepEqual(events[0][3].checks[0].observed,['Namespace']);assert.deepEqual(events[0][3].checks[1].observed,[]);
 page.evaluate=async()=>{throw Error('private-message-not-for-publication')};events.length=0;await assert.rejects(a.observeAndAssert(page,identity,(...r)=>events.push(r)));
 assert.ok(events[0][3].errors.includes('DOM_READ_FAILED'));assert.ok(!JSON.stringify(events).includes('private-message'));
});
test('unexpected URL is never read and version mismatch fails with evidence',async()=>{
 let read=false;const page={url:()=> 'https://private.invalid/',evaluate:async()=>{read=true}};const events=[];
 await assert.rejects(a.observeAndAssert(page,identity,(...r)=>events.push(r)));assert.equal(read,false);assert.equal(events[0][3].pageUrl,'<unexpected-page>');
 const f=fixture();const p={url:()=>f.url,waitForFunction:async()=>{},evaluate:async()=>f};events.length=0;
 await assert.rejects(a.observeAndAssert(p,{...identity,browserVersion:'other'},(...r)=>events.push(r)));assert.ok(events[0][3].errors.includes('UNSUPPORTED_BROWSER_VERSION'));
});
test('readonly DOM collector extracts actual cells and assessment without changing them',()=>{
 const vm=require('node:vm');const f=fixture();const rows=f.rows.map(cells=>({children:cells.map(textContent=>({tagName:'TD',textContent}))}));
 const document={querySelectorAll:s=>s==='#sandbox-status'?[{querySelectorAll:()=>rows}]:s==='#evaluation'?[{textContent:f.assessment}]:[]};
 const actual=vm.runInNewContext('('+a.readDom.toString()+')()',{location:{href:f.url},document});
 assert.deepEqual(JSON.parse(JSON.stringify(actual)),f);assert.equal(rows[0].children[1].textContent,'Namespace');
});
module.exports={fixture};
test('stalled DOM read is bounded and still records failure evidence',async()=>{
 const events=[],f=fixture();const page={url:()=>f.url,waitForFunction:async()=>{},evaluate:()=>new Promise(()=>{})};
 await assert.rejects(a.observeAndAssert(page,identity,(...r)=>events.push(r),5),/SANDBOX_ATTESTATION_FAILED/);
 assert.ok(events[0][3].errors.includes('DOM_READ_TIMEOUT'));assert.equal(events[0][3].pass,false);
});
