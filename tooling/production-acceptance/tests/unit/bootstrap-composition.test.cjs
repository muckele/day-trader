'use strict';
// Only byte channels, clocks and launch/cleanup recorders are inert. Each side
// evaluates the real source in its own VM and owns disjoint nominal stores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../../guest/role-ports.cjs'), 'utf8');
const binding = {version:1,runId:'a'.repeat(32),manifestDigest:'b'.repeat(64),configIdentity:'c'.repeat(64),rolePolicyDigest:'d'.repeat(64),epoch:1,expiresAtMs:10000};
const map = ['CONTROLLER','BROWSER','VERIFIER','PROXY'].map((role,i)=>({role,childId:String(i+1).repeat(32),pipeId:String(i+5).repeat(32)}));
const canon = v => Array.isArray(v) ? '['+v.map(canon).join(',')+']' : v && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}' : JSON.stringify(v);
function frame(v) { const bytes=Buffer.from(canon(v)); const n=Buffer.alloc(4);n.writeUInt32BE(bytes.length);return Buffer.concat([n,bytes]); }
function mac(v,key,role,direction) { return crypto.createHmac('sha256',Buffer.from(key,'hex')).update('acceptance:bootstrap-composition:v1\0'+role+':'+direction+'\0'+canon(v)).digest('hex'); }
function context() {const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,require,Buffer,TextDecoder,setTimeout,clearTimeout,process});return module.exports;}
function budget(clock) {return {deadline:null,remaining(){if(this.deadline===null)this.deadline=clock.mono+60000;return Math.max(0,this.deadline-clock.mono);},clamp(end){this.deadline=Math.min(this.deadline??end,end);}};}
function fixture(options={}) {
  const controller=context(), worker=context(), clock={wall:100,mono:100,sample(){return [this.wall,this.mono];}}, stops=[], launches=[];
  const proof={proofDigest:'e'.repeat(64),generation:1,expiresAtMs:9000,monotonicDeadlineMs:9000};
  const checkpoint={binding,generation:1,sequence:1,sourceIdentity:'f'.repeat(32),lostCount:0};
  const grantId='a1'.repeat(16),commitId='b2'.repeat(16), keyC='c3'.repeat(32),keyW='d4'.repeat(32);
  let workerBinding, reservation, workerOutcome, controllerSeq=0, workerSeq=0, workerRead, reservationId,prepareBytes;
  const queue=[], pending=[];
  const original={command:{},result:{}};
  const workerFacts={...map[1],binding,channelKeyHex:keyW,...original};
  const controllerFacts={...map[0],binding,channelKeyHex:keyC,roles:map,command:{},result:{}};
  const make=(role,key,seq,action,payload,target)=>{const v={version:1,binding,sequence:seq,role:target.role,childId:target.childId,pipeId:target.pipeId,action,payload};return frame({...v,mac:mac(v,key,role,'FROM_BOOTSTRAP')});};
  const deliver=(action,payload)=>{const bytes=make('BROWSER',keyW,++workerSeq,action,payload,map[1]);if(workerRead){const r=workerRead;workerRead=null;r(bytes);}else queue.push(bytes);return bytes;};
  const hooks=options.hooks||{};
  const workerChannel={audit:()=>workerFacts,
    async read(){if(queue.length)return queue.shift();return new Promise(r=>{workerRead=r;});},
    async write(bytes){const v=JSON.parse(bytes.subarray(4));const unsigned={...v};delete unsigned.mac;assert.equal(v.mac,mac(unsigned,keyW,'BROWSER','TO_BOOTSTRAP'));
      if(v.action==='PREPARED'){reservationId=v.payload.reservationId;hooks.prepared?.(f);}
      if(v.action==='REFRESH'){hooks.refresh?.(f);deliver('CURRENT',{requestSequence:v.sequence,grantId,reservationId,commitId,...proof,eventCheckpoint:checkpoint});hooks.current?.(f);}
      if(v.action==='STARTED')hooks.started?.(f);
    },
    drain(){hooks.drain?.(f);return pending.splice(0);},
    effectFence(value){assert.equal(value.sourceIdentity,checkpoint.sourceIdentity);hooks.fence?.(f);return options.fence===false?null:checkpoint;},
    stopOwned:async remaining=>{stops.push(['worker-family',remaining]);return {status:'STOPPED',runId:binding.runId};}};
  queue.push(frame({version:1,kind:'BROWSER_WORKER_INIT',binding,...map[1],channelKeyHex:keyW}));
  const controllerQueue=[frame({version:1,kind:'BOOTSTRAP_INIT',binding,channelKeyHex:keyC,roles:map})];
  const controllerChannel={audit:()=>controllerFacts,read:async()=>controllerQueue.shift(),
    async write(bytes){const v=JSON.parse(bytes.subarray(4));const unsigned={...v};delete unsigned.mac;assert.equal(v.mac,mac(unsigned,keyC,'CONTROLLER','TO_BOOTSTRAP'));
      let result;
      if(v.action==='ADOPT') result={kind:v.role,runId:binding.runId,uid:v.role==='BROWSER'?10002:10003,childId:v.childId,pipeId:v.pipeId,waiting:true,confined:true,attestationDigest:'9'.repeat(64)};
      if(v.action==='PREPARE_BROWSER') {prepareBytes=deliver('PREPARE',{grantId,...proof});reservation=await workerBinding.prepare(prepareBytes);queue.shift();result={grantId,...proof};hooks.result?.(result,f);}
      if(v.action==='COMMIT_BROWSER') {deliver('COMMIT',{grantId,reservationId,commitId,generation:1});workerOutcome=await workerBinding.commitFixedBrowserLaunch(reservation,()=>{launches.push(1);const owner={stopOwned:async remaining=>{stops.push(['browser',remaining]);return {status:'STOPPED',runId:binding.runId};}};return hooks.launch?hooks.launch(f,owner):owner;});result={status:'ACTIVE',generation:1};}
      if(v.action==='STOP_OWNED'||v.action==='WAIT_EXIT'){stops.push([v.childId,v.payload.remainingMs]);result={status:options.stopTimeout?'TIMEOUT':'STOPPED',runId:binding.runId};}
      if(v.action==='CANCEL'){f.cancel();result={status:'CANCELLED',generation:1};}
      controllerQueue.push(make('CONTROLLER',keyC,++controllerSeq,'RESULT',{requestSequence:v.sequence,result},map.find(r=>r.role===v.role)));
    }};
  const f={controller,worker,clock,proof,checkpoint,stops,launches,workerFacts,controllerFacts,workerChannel,controllerChannel,
    cancelRecord(){return make('BROWSER',keyW,++workerSeq,'CANCEL',{generation:1,cleanupEndsAtMonotonicMs:clock.mono+123},map[1]);},
    cancel(){pending.push(make('BROWSER',keyW,++workerSeq,'CANCEL',{generation:1,cleanupEndsAtMonotonicMs:clock.mono+123},map[1]));},
    expire(){clock.mono=9000;},
    get reservation(){return reservation;},get outcome(){return workerOutcome;},get prepareBytes(){return prepareBytes;},
    async init(){assert.equal(typeof worker.bindBrowserWorkerChannel,'function','separate worker launch authority is absent');workerBinding=await worker.bindBrowserWorkerChannel(workerChannel,workerFacts,clock,budget(clock));this.workerBinding=workerBinding;this.bound=await controller.bindBootstrapComposition(controllerChannel,binding,clock,budget(clock));return this;}};
  return f;
}

test('v1_controller_and_worker_nominal_stores_are_disjoint',async()=>{
  const f=await fixture().init(), tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(f.workerBinding.commitFixedBrowserLaunch(tx,()=>{throw Error('foreign launch');}));
  assert.equal(f.launches.length,0);
});
test('v1_original_child_pipe_required_for_nominal_adoption',async()=>{
  const f=await fixture().init();f.controllerFacts.command={};
  await assert.rejects(f.bound.adopt('BROWSER'));assert.equal(f.launches.length,0);
});
test('v1_worker_init_requires_original_channel_and_role_key',async()=>{
  for(const field of ['command','channelKeyHex','childId','pipeId']){
    const f=fixture(),expected={...f.workerFacts,[field]:field==='command'?{}:'0'.repeat(field==='channelKeyHex'?64:32)};
    assert.equal(typeof f.worker.bindBrowserWorkerChannel,'function','separate worker init verification is absent');
    await assert.rejects(f.worker.bindBrowserWorkerChannel(f.workerChannel,expected,f.clock,budget(f.clock)));
  }
});
test('v1_foreign_replayed_copied_grant_denied',async()=>{
  for(const project of [tx=>({...tx.grant}),tx=>JSON.parse(JSON.stringify({grantId:'a1'.repeat(16)}))]){
    const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);
    await assert.rejects(tx.port.activateOnce(project(tx)));assert.equal(f.launches.length,0);assert.ok(f.stops.length);
  }
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);await tx.port.activateOnce(tx.grant);
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,1);
});
test('v1_expiry_cancel_generation_checked_at_fixed_launch',async()=>{
  for(const hop of ['prepared','refresh','current','drain','fence'])for(const action of ['cancel','expire','epoch','generation','wall']){
    const f=fixture({hooks:{[hop](f){if(action==='cancel')f.cancel();else if(action==='expire')f.expire();else if(action==='epoch')f.workerFacts.binding={...binding,epoch:2};else if(action==='generation')f.checkpoint.generation=2;else f.clock.wall=9000;}}});
    await f.init();let rejected=false;try{const tx=await f.bound.prepareBrowser(f.proof);await tx.port.activateOnce(tx.grant);}catch{rejected=true;}
    assert.equal(rejected,true,hop+'/'+action);assert.equal(f.launches.length,0,hop+'/'+action);
  }
});
test('v1_worker_guard_returns_local_cleanup_owner',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof),handle=await tx.port.activateOnce(tx.grant);
  assert.equal(f.launches.length,1);assert.equal(f.outcome.status,'STARTED');assert.equal(typeof f.outcome.browserOwner.stopOwned,'function');
  assert.notEqual(handle,f.outcome.browserOwner);assert.equal(typeof handle.privatePipe,'object');
});
test('v1_native_effect_fence_unavailable_has_zero_launches',async()=>{
  const f=await fixture({fence:false}).init(),tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0);
});
test('v1_prepare_result_requires_local_transaction_mint',async()=>{
  for(const change of [r=>{r.extra=true;},r=>{r.proofDigest='0'.repeat(64);},r=>{r.generation=2;},r=>{r.expiresAtMs=100;},(r,f)=>{f.clock.wall=9000;}]){
    const f=await fixture({hooks:{result:change}}).init();await assert.rejects(f.bound.prepareBrowser(f.proof));assert.equal(f.launches.length,0);
  }
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(tx.port.activateOnce({grantId:'a1'.repeat(16),...f.proof}));assert.equal(f.launches.length,0);
});
test('v1_late_activation_preserves_original_cleanup',async()=>{
  const f=await fixture({hooks:{started(f){f.clock.wall=9000;}}}).init(),tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,1);assert.ok(f.stops.some(x=>x[0]==='browser'));
});
test('v1_shared_cleanup_deadline_never_renews',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);f.cancel();
  await assert.rejects(tx.port.activateOnce(tx.grant));
  assert.ok(f.stops.filter(x=>x[0]==='worker-family').every(x=>x[1]<=123));
});
test('v1_replayed_prepare_invalidates_original_reservation',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(f.workerBinding.prepare(f.prepareBytes));
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0);
});
test('v1_eof_uses_nonblocking_cleanup_without_new_window',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);
  f.workerChannel.read=async()=>undefined;
  await assert.rejects(tx.port.activateOnce(tx.grant));
  assert.ok(f.stops.some(x=>x[0]==='worker-family'&&x[1]===0));assert.equal(f.launches.length,0);
});
test('v1_pending_launch_cleanup_cannot_claim_exit_and_late_owner_is_retained',async()=>{
  let settle,entered;const ready=new Promise(r=>{entered=r;});
  const f=await fixture({hooks:{launch(f,owner){entered();return new Promise(r=>{settle=()=>r(owner);});}}}).init();
  const tx=await f.bound.prepareBrowser(f.proof),activation=tx.port.activateOnce(tx.grant);
  await ready;const stopped=await f.workerBinding.stopOwned(100);
  assert.equal(stopped.status,'TIMEOUT','unsettled acquisition is still an obligation');
  settle();await assert.rejects(activation);assert.ok(f.stops.some(x=>x[0]==='browser'));
});
test('v1_authenticated_idle_cancel_emits_correlated_cancelled',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof),sent=[];
  const write=f.workerChannel.write;f.workerChannel.write=async bytes=>{sent.push(JSON.parse(bytes.subarray(4)));return write(bytes);};
  assert.equal(typeof f.workerBinding.cancel,'function','original worker cancel dispatcher is absent');
  const record=f.cancelRecord();await f.workerBinding.cancel(record);
  assert.equal(sent[0].action,'CANCELLED');assert.equal(sent[0].payload.requestSequence,JSON.parse(record.subarray(4)).sequence);
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0);
});
test('v1_pending_cleanup_keeps_one_original_stop_callback',async()=>{
  const f=await fixture().init();let entered,finish,calls=0;const started=new Promise(r=>{entered=r;});
  f.workerChannel.stopOwned=()=>{calls++;entered();return new Promise(r=>{finish=()=>r({status:'STOPPED',runId:binding.runId});});};
  const first=f.workerBinding.stopOwned(100);await started;
  await assert.rejects(f.workerBinding.stopOwned(100),/CLEANUP_UNCERTAIN/);assert.equal(calls,1);
  finish();assert.equal((await first).status,'STOPPED');
});
test('v1_controller_cancel_during_commit_reaches_original_worker',async()=>{
  let cancellation;
  const f=await fixture({hooks:{refresh(f){cancellation=f.bound.cancel();cancellation.catch(()=>{});}}}).init();
  const tx=await f.bound.prepareBrowser(f.proof);await assert.rejects(tx.port.activateOnce(tx.grant));
  await cancellation;assert.equal(f.launches.length,0);
});
test('v1_failed_preparation_retains_uncertain_original_cleanup',async()=>{
  const f=await fixture({stopTimeout:true,hooks:{result(r){r.extra=true;}}}).init();let error;
  try{await f.bound.prepareBrowser(f.proof);}catch(e){error=e;}
  assert.equal(typeof error?.cleanup?.stopOwned,'function');assert.equal(f.launches.length,0);
});
test('v1_event_generation_is_rechecked_after_final_channel_drain',async()=>{
  let atFinal=false;
  const f=await fixture({hooks:{fence(){atFinal=true;},drain(f){if(atFinal)f.checkpoint.generation=2;}}}).init();
  const tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(atFinal,true);assert.equal(f.launches.length,0);
});
