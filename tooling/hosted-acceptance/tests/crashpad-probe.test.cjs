'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const probe=require('../tools/crashpad-probe.cjs');
const hosted={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',PILOT_DIAGNOSTIC_ONLY:'1',PILOT_CRASHPAD_EXPERIMENT:'aba-v1'};
test('experiment requires all hosted diagnostic guards',()=>{
 assert.equal(probe.enabled(hosted),true);assert.equal(probe.enabled({}),false);
 for(const key of Object.keys(hosted))assert.equal(probe.enabled({...hosted,[key]:'false'}),false);
});
test('actual mount parser retains tmpfs type and both sets of effective flags',()=>{
 const text='91 90 0:33 / /profile/home/.config/google-chrome-for-testing/Crash\\040Reports rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k,mode=700,uid=501,gid=20\n';
 const m=probe.mountInfo(text);assert.equal(m.target,probe.target);assert.equal(m.type,'tmpfs');assert.ok(m.mountFlags.includes('noexec'));assert.ok(m.superOptions.includes('uid=501'));
 assert.throws(()=>probe.mountInfo(''),/CRASH_MOUNT_ABSENT/);
});
test('successful probe evaluates twice and closes before reporting success',async()=>{
 const calls=[],rows=[];
 const page={evaluate:async fn=>{calls.push('evaluate');return fn()},waitForTimeout:async ms=>{assert.equal(ms,250);calls.push('wait')}};
 await probe.finish({close:async()=>calls.push('close')},page,(...args)=>rows.push(args));
 assert.deepEqual(calls,['evaluate','wait','evaluate','close']);assert.equal(rows.at(-1)[2],'closed');assert.equal(rows.at(-1)[3].credentialsSubmitted,false);
});
test('unresponsive browser or failed close cannot report closed success',async()=>{
 for(const variant of ['evaluate','close']){
  const rows=[],page={evaluate:async()=>variant==='evaluate'?0:42,waitForTimeout:async()=>{}};
  await assert.rejects(probe.finish({close:async()=>{throw Error('close failed')}},page,(...args)=>rows.push(args)));
  assert.ok(!rows.some(r=>r[2]==='closed'));
 }
});
test('crash inspection reads metadata only, without opening file contents or printing names',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),records=[],reads=[];
 const fake={readFileSync:p=>{reads.push(p);return '91 90 0:33 / /profile/home/.config/google-chrome-for-testing/Crash\\040Reports rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k,mode=700,uid=501,gid=20'},readdirSync:()=>[{name:'private-crash-name'}],lstatSync:()=>({isDirectory:()=>false,isFile:()=>true,size:16,blocks:8})};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../tools/crashpad-probe.cjs'),'utf8'),{module,require:n=>n==='node:fs'?fake:n==='./startup-diagnostics.cjs'?{metadata:()=>({mode:'700'}),record:(...r)=>records.push(r)}:require(n),process:{env:hosted}});
 module.exports.metadata('after');assert.deepEqual(reads,['/proc/self/mountinfo']);assert.equal(records[0][3].counts.files,1);assert.equal(records[0][3].counts.bytes,16);assert.ok(!JSON.stringify(records).includes('private-crash-name'));
});
test('actual browser experiment path attests sandbox and exits before any app navigation',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),rows=[],navigations=[],calls=[];let closed=false;
 const fixture={url:'chrome://sandbox/',tableCount:1,evaluationCount:1,rows:[['Layer 1 Sandbox','Namespace'],['PID namespaces','Yes'],['Network namespaces','Yes'],['Seccomp-BPF sandbox','Yes']],assessment:'You are adequately sandboxed.'};
 const page={url:()=>fixture.url,setDefaultTimeout(){},goto:async url=>navigations.push(url),waitForFunction:async()=>{},evaluate:async fn=>fn.name==='readDom'?fixture:fn(),waitForTimeout:async()=>{}};
 const context={route:async()=>{},pages:()=>[page],on(){},close:async()=>{closed=true}};
 const diagnostic={record:(...r)=>rows.push(r),preflight(){},failure(){assert.fail('unexpected browser failure')}};
 const runtimeProbe={enabled:()=>true,metadata:phase=>calls.push(phase),finish:(ctx,p)=>probe.finish(ctx,p,diagnostic.record)};
 const fakeFs={readFileSync:p=>p==='/config/assets.json'?'[]':Buffer.from('synthetic binary'),writeFileSync(){},appendFileSync(){}};
 const req=n=>{
  if(n==='./sandbox-attestation.cjs')return {observeAndAssert:(p,id)=>require('../tools/sandbox-attestation.cjs').observeAndAssert(p,id,diagnostic.record)};
  if(n==='./startup-diagnostics.cjs')return diagnostic;if(n==='./crashpad-probe.cjs')return runtimeProbe;
  if(n==='fs')return fakeFs;if(n==='./config.cjs')return {load:()=>({run:'synthetic'})};
  if(n==='./policy.cjs')return {parseRequest(){},F:'frontend.invalid',B:'backend.invalid'};
  if(n==='/opt/acceptance/node_modules/playwright')return {chromium:{launchPersistentContext:async()=>context}};
  if(n==='/opt/acceptance/node_modules/playwright/package.json')return {version:'1.58.2'};
  if(n==='node:child_process')return {spawnSync:()=>({stdout:'Google Chrome for Testing 145.0.7632.6',status:0})};
  return require(n);
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../tools/browser.cjs'),'utf8'),{require:req,process:{on(){},exit(){assert.fail('unexpected exit')}},URL,setTimeout});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(closed,true);assert.deepEqual(navigations,['chrome://sandbox']);assert.deepEqual(calls,['before','after']);assert.ok(rows.some(r=>r[0]==='startup-probe'&&r[2]==='closed'));assert.ok(!rows.some(r=>['P','Q'].includes(r[1])));
});
