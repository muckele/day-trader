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
function context() {const module={exports:{}},localRequire=name=>name==='node:crypto'?{...crypto,randomBytes:n=>Buffer.alloc(n,0x66)}:require(name);vm.runInNewContext(source,{module,exports:module.exports,require:localRequire,Buffer,TextDecoder,setTimeout,clearTimeout,process});return module.exports;}
function budget(clock) {return {deadline:null,remaining(){if(this.deadline===null)this.deadline=clock.mono+60000;return Math.max(0,this.deadline-clock.mono);},clamp(end){this.deadline=Math.min(this.deadline??end,end);}};}
function pythonTranscript(){
  const input=process.env.BOOTSTRAP_V1_INPUT;
  if(!input)return undefined;
  const transcript=JSON.parse(fs.readFileSync(input,'ascii'));
  assert.deepEqual(Object.keys(transcript).sort(),['binding','cancelVariants','frameEncoding','frameSHA256','frames','nominalContexts','order','producer','roles','version']);
  assert.equal(transcript.version,1);assert.equal(transcript.producer,'python-original-role-set-forwarder');
  assert.equal(transcript.frameEncoding,'length-prefixed-canonical-ascii');
  assert.deepEqual(transcript.nominalContexts,['PYTHON_BOOTSTRAP','CONTROLLER_JS','BROWSER_WORKER_JS']);
  const expected=['controllerInit','workerInit','controllerAdopt','controllerAdoptResult',
    'controllerPrepare','browserPrepare','browserPrepared','controllerPrepareResult',
    'controllerCommit','browserCommit','browserRefresh','browserCurrent','browserStarted',
    'controllerCommitResult'];
  const cancelled=['controllerInit','workerInit','controllerAdopt','controllerAdoptResult',
    'controllerPrepare','browserPrepare','browserPrepared','controllerPrepareResult',
    'controllerCancel','browserCancel','browserCancelled','controllerCancelResult'];
  const cancelOrders={PREPARED:cancelled,
    REFRESH:[...cancelled.slice(0,8),'controllerCommit','browserCommit','browserRefresh',...cancelled.slice(8)],
    CURRENT:[...cancelled.slice(0,8),'controllerCommit','browserCommit','browserRefresh','browserCurrent',...cancelled.slice(8)]};
  function validate(record,names,keys){
    assert.deepEqual(Object.keys(record).sort(),keys);
    assert.deepEqual(Object.keys(record.frames).sort(),[...names].sort());
    assert.deepEqual(Object.keys(record.frameSHA256).sort(),[...names].sort());
    assert.deepEqual(record.order,names);
    for(const [name,hex] of Object.entries(record.frames))assert.equal(crypto.createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex'),record.frameSHA256[name]);
  }
  validate(transcript,expected,['binding','cancelVariants','frameEncoding','frameSHA256','frames','nominalContexts','order','producer','roles','version']);
  assert.deepEqual(Object.keys(transcript.cancelVariants).sort(),['CURRENT','PREPARED','REFRESH']);
  for(const [hop,variant] of Object.entries(transcript.cancelVariants))
    validate(variant,cancelOrders[hop],['binding','frameSHA256','frames','order','roles']);
  return transcript;
}
function fixture(options={}) {
  const transcript=options.transcript;
  const controller=context(), worker=context(), clock={wall:100,mono:100,sample(){return [this.wall,this.mono];}}, stops=[], launches=[];
  const recorded=name=>Buffer.from(transcript.frames[name],'hex');
  const decoded=name=>JSON.parse(recorded(name).subarray(4));
  const initC=transcript?decoded('controllerInit'):null,initW=transcript?decoded('workerInit'):null;
  const runBinding=transcript?transcript.binding:binding,roleMap=transcript?transcript.roles:map;
  const preparePayload=transcript?decoded('browserPrepare').payload:null;
  const proof=transcript?Object.fromEntries(Object.entries(preparePayload).filter(([key])=>key!=='grantId')):
    {proofDigest:'e'.repeat(64),generation:1,expiresAtMs:9000,monotonicDeadlineMs:9000};
  const checkpoint=transcript&&transcript.frames.browserCurrent?decoded('browserCurrent').payload.eventCheckpoint:
    {binding:runBinding,generation:1,sequence:1,sourceIdentity:'f'.repeat(32),lostCount:0};
  const grantId=transcript?preparePayload.grantId:'a1'.repeat(16);
  const commitId=transcript&&transcript.frames.browserCommit?decoded('browserCommit').payload.commitId:'b2'.repeat(16);
  const keyC=transcript?initC.channelKeyHex:'c3'.repeat(32),keyW=transcript?initW.channelKeyHex:'d4'.repeat(32);
  let workerBinding, reservation, workerOutcome, controllerCancellation,
    controllerSeq=0, workerSeq=0, workerRead, reservationId,prepareBytes;
  const queue=[], pending=[],workerAppChunks=[];
  const original={command:{},result:{}};
  const workerFacts={...roleMap[1],binding:runBinding,channelKeyHex:keyW,...original};
  const controllerFacts={...roleMap[0],binding:runBinding,channelKeyHex:keyC,roles:roleMap,command:{},result:{}};
  const make=(role,key,seq,action,payload,target)=>{const v={version:1,binding:runBinding,sequence:seq,role:target.role,childId:target.childId,pipeId:target.pipeId,action,payload};return frame({...v,mac:mac(v,key,role,'FROM_BOOTSTRAP')});};
  const deliver=(action,payload)=>{const bytes=make('BROWSER',keyW,++workerSeq,action,payload,roleMap[1]);if(workerRead){const r=workerRead;workerRead=null;r(bytes);}else queue.push(bytes);return bytes;};
  const hooks=options.hooks||{};
  const workerChannel={audit:()=>workerFacts,
    async read(){const bytes=queue.length?queue.shift():await new Promise(r=>{workerRead=r;});
      if(options.cancelAt==='CURRENT'&&JSON.parse(bytes.subarray(4)).action==='CURRENT')await f.cancelFromController();
      return bytes;},
    async write(bytes){const v=JSON.parse(bytes.subarray(4));const unsigned={...v};delete unsigned.mac;assert.equal(v.mac,mac(unsigned,keyW,'BROWSER','TO_BOOTSTRAP'));
      if(transcript){const names={PREPARED:'browserPrepared',REFRESH:'browserRefresh',STARTED:'browserStarted',CANCELLED:'browserCancelled'};assert.deepEqual(bytes,recorded(names[v.action]));}
      if(v.action==='PREPARED'){reservationId=v.payload.reservationId;hooks.prepared?.(f);}
      if(v.action==='REFRESH'){hooks.refresh?.(f);if(transcript){if(options.cancelAt==='REFRESH')await f.cancelFromController();else if(transcript.frames.browserCurrent)queue.push(recorded('browserCurrent'));hooks.current?.(f);}else{deliver('CURRENT',{requestSequence:v.sequence,grantId,reservationId,commitId,...proof,eventCheckpoint:checkpoint});hooks.current?.(f);}}
      if(v.action==='STARTED')hooks.started?.(f);
      if(v.action==='APP_CHUNK')workerAppChunks.push(v.payload);
    },
    drain(){hooks.drain?.(f);return pending.splice(0);},
    effectFence(value){assert.equal(value.sourceIdentity,checkpoint.sourceIdentity);hooks.fence?.(f);return options.fence===false?null:checkpoint;},
    stopOwned:async remaining=>{stops.push(['worker-family',remaining]);return {status:'STOPPED',runId:runBinding.runId};}};
  queue.push(transcript?recorded('workerInit'):frame({version:1,kind:'BROWSER_WORKER_INIT',binding:runBinding,...roleMap[1],channelKeyHex:keyW}));
  const controllerQueue=[transcript?recorded('controllerInit'):frame({version:1,kind:'BOOTSTRAP_INIT',binding:runBinding,channelKeyHex:keyC,roles:roleMap})];
  const controllerChannel={audit:()=>controllerFacts,read:async()=>controllerQueue.shift(),
    async write(bytes){const v=JSON.parse(bytes.subarray(4));const unsigned={...v};delete unsigned.mac;assert.equal(v.mac,mac(unsigned,keyC,'CONTROLLER','TO_BOOTSTRAP'));
      let result,recorded;
      if(transcript){const names={ADOPT:'controllerAdopt',PREPARE_BROWSER:'controllerPrepare',COMMIT_BROWSER:'controllerCommit',CANCEL:'controllerCancel'};assert.deepEqual(bytes,Buffer.from(transcript.frames[names[v.action]],'hex'));}
      if(v.action==='ADOPT') {result={kind:v.role,runId:runBinding.runId,uid:v.role==='BROWSER'?10002:10003,childId:v.childId,pipeId:v.pipeId,waiting:true,confined:true,attestationDigest:'9'.repeat(64)};if(transcript)recorded=Buffer.from(transcript.frames.controllerAdoptResult,'hex');}
      if(v.action==='PREPARE_BROWSER') {const browserConfig=v.payload.browserConfig;prepareBytes=transcript?Buffer.from(transcript.frames.browserPrepare,'hex'):deliver('PREPARE',{grantId,...proof,...(browserConfig===undefined?{}:{browserConfig})});if(transcript)workerSeq=1;reservation=await workerBinding.prepare(prepareBytes);if(!transcript)queue.shift();result={grantId,...proof};hooks.result?.(result,f);if(transcript)recorded=Buffer.from(transcript.frames.controllerPrepareResult,'hex');}
      if(v.action==='COMMIT_BROWSER') {if(transcript)queue.push(Buffer.from(transcript.frames.browserCommit,'hex'));else deliver('COMMIT',{grantId,reservationId,commitId,generation:1});workerOutcome=await workerBinding.commitFixedBrowserLaunch(reservation,()=>{launches.push(1);const owner={stopOwned:async remaining=>{stops.push(['browser',remaining]);return {status:'STOPPED',runId:runBinding.runId};}};return hooks.launch?hooks.launch(f,owner):owner;});result={status:'ACTIVE',generation:1};if(transcript?.frames.controllerCommitResult)recorded=Buffer.from(transcript.frames.controllerCommitResult,'hex');}
      if(v.action==='STOP_OWNED'||v.action==='WAIT_EXIT'){stops.push([v.childId,v.payload.remainingMs]);result={status:options.stopTimeout?'TIMEOUT':'STOPPED',runId:runBinding.runId};}
      if(v.action==='CANCEL'){if(transcript){await workerBinding.cancel(Buffer.from(transcript.frames.browserCancel,'hex'));recorded=Buffer.from(transcript.frames.controllerCancelResult,'hex');}else f.cancel();result={status:'CANCELLED',generation:1};}
      if(v.action==='APP_WRITE'){deliver('APP_CHUNK',v.payload);result={acceptedStreamSequence:v.payload.streamSequence};}
      if(v.action==='APP_POLL')result=workerAppChunks.length?{status:'CHUNK',chunk:workerAppChunks.shift()}:{status:'EMPTY'};
      if(recorded){controllerSeq=JSON.parse(recorded.subarray(4)).sequence;controllerQueue.push(recorded);}
      else controllerQueue.push(make('CONTROLLER',keyC,++controllerSeq,'RESULT',{requestSequence:v.sequence,result},roleMap.find(r=>r.role===v.role)));
    }};
  function cancellationRecord(){
    if(transcript?.frames.browserCancel)return Buffer.from(transcript.frames.browserCancel,'hex');
    return make('BROWSER',keyW,++workerSeq,'CANCEL',{generation:1,cleanupEndsAtMonotonicMs:clock.mono+123},roleMap[1]);
  }
  const f={controller,worker,clock,proof,checkpoint,stops,launches,workerFacts,controllerFacts,workerChannel,controllerChannel,
    cancelRecord(){return cancellationRecord();},
    cancel(){pending.push(cancellationRecord());},
    async cancelFromController(){
      if(!controllerCancellation)controllerCancellation=this.bound.cancel();
      return controllerCancellation;
    },
    expire(){clock.mono=9000;},
    get reservation(){return reservation;},get outcome(){return workerOutcome;},get prepareBytes(){return prepareBytes;},
    async init(){assert.equal(typeof worker.bindBrowserWorkerChannel,'function','separate worker launch authority is absent');workerBinding=await worker.bindBrowserWorkerChannel(workerChannel,workerFacts,clock,budget(clock));this.workerBinding=workerBinding;this.bound=await controller.bindBootstrapComposition(controllerChannel,runBinding,clock,budget(clock));return this;}};
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
test('v1_task13_application_bytes_are_chunked_over_original_authenticated_channels',async()=>{
  const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof),handle=await tx.port.activateOnce(tx.grant);
  const controllerPipe=handle.privatePipe,workerPipe=f.outcome.applicationPipe;
  assert.equal(controllerPipe.audit().kind,'TASK13_BROWSER_APPLICATION');
  const fromWorker=Buffer.alloc(10000,0x57);await workerPipe.write(fromWorker);
  assert.deepEqual(await controllerPipe.read(),fromWorker);
  const fromController=Buffer.alloc(9000,0x43);await controllerPipe.write(fromController);
  assert.deepEqual(await workerPipe.read(),fromController);
  await assert.rejects(controllerPipe.write(Buffer.alloc(16385)),/FRAME_DENIED/);
});
test('v1_task13_signed_browser_configuration_uses_the_existing_prepare_channel',async()=>{
  const f=await fixture().init(),config={version:1,assetBundle:{release:'public-signed-bytes'}};
  const tx=await f.bound.prepareBrowser(f.proof,config);
  assert.equal(JSON.stringify(f.workerBinding.inspectPreparedBrowserConfig(f.reservation)),JSON.stringify({assetBundle:config.assetBundle,version:1}));
  await tx.port.activateOnce(tx.grant);
  await assert.rejects(async()=>f.workerBinding.inspectPreparedBrowserConfig(f.reservation),/AUTHORITY_LOST/);
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

test('v1_rejected_worker_entry_terminally_consumes_original_reservation',async()=>{
  for(const misuse of ['bytes','mac','sequence','action','payload','foreign','copy','callback']){
    const f=await fixture().init(),tx=await f.bound.prepareBrowser(f.proof);
    if(['foreign','copy','callback'].includes(misuse)){
      await assert.rejects(f.workerBinding.commitFixedBrowserLaunch(misuse==='foreign'?tx:misuse==='copy'?{...f.reservation}:f.reservation,misuse==='callback'?null:()=>assert.fail('foreign launch')));
    }else{
      let record=f.cancelRecord();
      if(misuse==='bytes')record=Buffer.from('bad');
      else{const v=JSON.parse(record.subarray(4));if(misuse==='sequence')v.sequence++;if(misuse==='action')v.action='UNKNOWN';if(misuse==='payload')v.payload.generation=2;delete v.mac;v.mac=misuse==='mac'?'0'.repeat(64):mac(v,f.workerFacts.channelKeyHex,'BROWSER','FROM_BOOTSTRAP');record=frame(v);}
      await assert.rejects(f.workerBinding.cancel(record));
    }
    await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0,misuse);
    assert.ok(f.stops.some(x=>x[0]==='worker-family'),misuse+' retains original cleanup');
  }
});
test('v1_early_controller_prepare_failure_cleans_original_child_and_cannot_retry',async()=>{
  const f=await fixture().init();
  await assert.rejects(f.bound.prepareBrowser({...f.proof,extra:true}));
  assert.ok(f.stops.some(x=>x[0]===map[1].childId));
  await assert.rejects(f.bound.prepareBrowser(f.proof));assert.equal(f.launches.length,0);
  assert.equal(f.stops.filter(x=>x[0]===map[1].childId).length,1,'successful original stop is not repeated');
});
test('v1_clock_failure_after_acquisition_cannot_bypass_original_cleanup',async()=>{
  const faults=[f=>{f.clock.mono=99;},f=>{f.clock.wall=99;},f=>{f.clock.sample=()=>{throw Error('clock failed');};},f=>{f.clock.sample=()=>[];}];
  for(const fault of faults)for(const phase of ['sync','pending-before','pending-after']){
    let entered,settle;const ready=new Promise(r=>{entered=r;});
    const f=await fixture({hooks:{launch(f,owner){if(phase==='sync'){fault(f);return owner;}entered();return new Promise(r=>{settle=()=>r(owner);});},started(f){if(phase==='pending-after')fault(f);}}}).init();
    const tx=await f.bound.prepareBrowser(f.proof),activation=tx.port.activateOnce(tx.grant);
    if(phase!=='sync'){await ready;if(phase==='pending-before'){fault(f);assert.equal((await f.workerBinding.stopOwned(100)).status,'TIMEOUT');}settle();}
    await assert.rejects(activation);assert.equal(f.launches.length,1);
    for(const target of ['browser','worker-family',map[1].childId]){
      const stops=f.stops.filter(x=>x[0]===target);assert.equal(stops.length,1,target+' cleaned once');assert.equal(stops[0][1],0,target+' nonblocking after clock loss');
    }
  }
});
test('v1_failed_browser_stop_retains_owner_and_still_stops_original_family',async()=>{
  let calls=0;
  const f=await fixture({hooks:{launch(f,owner){owner.stopOwned=async ms=>{calls++;assert.equal(ms,0);throw Error('pending original browser');};f.clock.mono=99;return owner;}}}).init();
  const tx=await f.bound.prepareBrowser(f.proof);let error;
  try{await tx.port.activateOnce(tx.grant);}catch(e){error=e;}
  assert.equal(calls,1);assert.ok(f.stops.some(x=>x[0]==='worker-family'));
  assert.equal(typeof error?.cause?.cleanup?.stopOwned,'function','original worker cleanup remains local on the typed cause');
  f.clock.mono=100; // Clock recovery must not restore the failed cleanup end.
  await assert.rejects(error.cause.cleanup.stopOwned(10));assert.equal(calls,2);
});
test('v1_opaque_post_launch_failure_cannot_replace_typed_cleanup_chain',async()=>{
  for(const cause of [undefined,Object.freeze(new Error('inert transport failure'))]){
    const f=await fixture({hooks:{started(){throw cause;}}}).init(),tx=await f.bound.prepareBrowser(f.proof);let error;
    try{await tx.port.activateOnce(tx.grant);}catch(e){error=e;}
    assert.equal(f.launches.length,1);assert.ok(f.stops.some(x=>x[0]==='browser'));
    assert.equal(typeof error?.cause?.cleanup?.stopOwned,'function');
    assert.equal(error.cause.cause,cause);
  }
});
test('v1_failure_report_keeps_first_terminal_instant_before_compensation',async()=>{
  const sent=[];
  const f=await fixture({hooks:{launch(f,owner){f.clock.wall=9000;const stop=owner.stopOwned;owner.stopOwned=async ms=>{f.clock.mono+=10;return stop(ms);};return owner;}}}).init();
  const write=f.workerChannel.write;f.workerChannel.write=async bytes=>{sent.push(JSON.parse(bytes.subarray(4)));return write(bytes);};
  const tx=await f.bound.prepareBrowser(f.proof);await assert.rejects(tx.port.activateOnce(tx.grant));
  assert.equal(sent.find(v=>v.action==='FAILED').payload.failedAtMonotonicMs,100);
});
test('v1_malformed_current_does_not_fabricate_correlated_failed_reply',async()=>{
  const f=await fixture().init(),sent=[],tx=await f.bound.prepareBrowser(f.proof);
  const read=f.workerChannel.read,write=f.workerChannel.write;
  f.workerChannel.read=async()=>{const bytes=await read();return JSON.parse(bytes.subarray(4)).action==='CURRENT'?Buffer.from('bad'):bytes;};
  f.workerChannel.write=async bytes=>{sent.push(JSON.parse(bytes.subarray(4)));return write(bytes);};
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0);
  assert.ok(f.stops.some(x=>x[0]==='worker-family'));
  assert.equal(sent.some(v=>v.action==='FAILED'),false,'an unreadable CURRENT cannot borrow the previous COMMIT sequence');
});
test('v1_first_terminal_instant_caps_cleanup_before_compensation_starts',async()=>{
  // Removing the local first-terminal clamp leaves the correct FAILED time,
  // but grants a fresh60000ms after1000ms of that original budget has elapsed.
  const sent=[];let reads=0;
  const f=await fixture({hooks:{launch(f,owner){
    f.clock.wall=9000;
    f.clock.sample=function(){if(++reads===3)this.mono=1100;return [this.wall,this.mono];};
    return owner;
  }}}).init();
  const write=f.workerChannel.write;f.workerChannel.write=async bytes=>{sent.push(JSON.parse(bytes.subarray(4)));return write(bytes);};
  const tx=await f.bound.prepareBrowser(f.proof);await assert.rejects(tx.port.activateOnce(tx.grant));
  assert.equal(sent.find(v=>v.action==='FAILED').payload.failedAtMonotonicMs,100);
  for(const target of ['browser','worker-family']){
    const stops=f.stops.filter(v=>v[0]===target);assert.equal(stops.length,1);
    assert.ok(stops[0][1]<=59000,target+' must use60100 minus current1100, not a new60000');
  }
});
test('v1_direct_worker_stop_reuses_first_terminal_absolute_end',async()=>{
  const f=await fixture().init();await f.bound.prepareBrowser(f.proof);let reads=0;
  f.clock.sample=function(){if(++reads===2)this.mono=1100;return [this.wall,this.mono];};
  const stop=f.workerChannel.stopOwned;
  f.workerChannel.stopOwned=async ms=>({...await stop(ms),status:'TIMEOUT'});
  await assert.rejects(f.workerBinding.stopOwned(60000),/CLEANUP_UNCERTAIN/);
  assert.ok(f.stops[0][1]<=59000,'direct stop must establish the first terminal end');
  f.clock.mono=1200;
  await assert.rejects(f.workerBinding.stopOwned(60000),/CLEANUP_UNCERTAIN/);
  assert.equal(f.stops.length,2);assert.ok(f.stops[1][1]<=58900,'retry cannot renew the first end');
});
test('v1_terminal_deadline_preserves_earlier_authenticated_cancel_end',async()=>{
  const f=await fixture().init();await f.bound.prepareBrowser(f.proof);
  const record=f.cancelRecord();let reads=0;
  f.clock.sample=function(){if(++reads===2)this.mono=1100;return [this.wall,this.mono];};
  await f.workerBinding.cancel(record);
  assert.equal(f.stops.find(v=>v[0]==='worker-family')[1],0,'authenticated end223 is earlier than local end60100');
});
test('v1_unrepresentable_terminal_end_only_allows_nonblocking_cleanup',async()=>{
  const f=await fixture().init();await f.bound.prepareBrowser(f.proof);f.clock.mono=Number.MAX_SAFE_INTEGER;
  await f.workerBinding.stopOwned(60000);
  assert.equal(f.stops.find(v=>v[0]==='worker-family')[1],0,'an unsafe absolute end must not allocate a fresh window');
});

test('v1_python_frames_adopt_original_role_and_guard_launch_once',async()=>{
  const transcript=pythonTranscript();
  if(transcript){
    const substituted=JSON.parse(JSON.stringify(transcript));
    const init=JSON.parse(Buffer.from(substituted.frames.controllerInit,'hex').subarray(4));
    init.roles[1].childId='0'.repeat(32);
    substituted.frames.controllerInit=frame(init).toString('hex');
    substituted.frameSHA256.controllerInit=crypto.createHash('sha256').update(frame(init)).digest('hex');
    await assert.rejects(fixture({transcript:substituted}).init());
  }
  const f=await fixture({transcript}).init(),tx=await f.bound.prepareBrowser(f.proof);
  assert.equal(typeof tx.port.activateOnce,'function');
  assert.equal(tx.constructor.name,'ControllerBrowserTransaction');
  assert.equal(f.reservation.constructor.name,'WorkerLaunchReservation');
  assert.notEqual(tx,f.reservation,'decoded PrepareBrowserResult must mint a controller-local transaction');
  await tx.port.activateOnce(tx.grant);
  await assert.rejects(tx.port.activateOnce(tx.grant));
  assert.equal(f.launches.length,1);
});

test('v1_python_expiry_between_worker_hops_denies_launch',async()=>{
  const transcript=pythonTranscript();
  for(const hop of ['prepared','refresh','current']){
    const f=fixture({transcript,hooks:{[hop](state){state.expire();}}});
    await f.init();
    await assert.rejects(async()=>{const tx=await f.bound.prepareBrowser(f.proof);await tx.port.activateOnce(tx.grant);});
    assert.equal(f.launches.length,0,hop);
  }
});

test('v1_python_authenticated_cancel_at_each_forwarder_window_is_terminal',async()=>{
  const transcript=pythonTranscript();if(!transcript)return;
  for(const hop of ['PREPARED','REFRESH','CURRENT']){
    const f=await fixture({transcript:transcript.cancelVariants[hop],
                           cancelAt:hop==='PREPARED'?undefined:hop}).init();
    const tx=await f.bound.prepareBrowser(f.proof);
    if(hop==='PREPARED')await f.bound.cancel();
    else await assert.rejects(tx.port.activateOnce(tx.grant));
    await assert.rejects(tx.port.activateOnce(tx.grant));
    assert.equal(f.launches.length,0,hop);
  }
});

test('v1_python_transcript_each_hop_substitution_and_replay_are_denied',async()=>{
  const transcript=pythonTranscript();if(!transcript)return;
  for(const variant of ['success','PREPARED','REFRESH','CURRENT']){
    const base=variant==='success'?transcript:transcript.cancelVariants[variant];
    for(const name of base.order){
      const changed=JSON.parse(JSON.stringify(base)),bytes=Buffer.from(changed.frames[name],'hex');
      bytes[bytes.length-1]^=1;changed.frames[name]=bytes.toString('hex');
      changed.frameSHA256[name]=crypto.createHash('sha256').update(bytes).digest('hex');
      let rejected=false,launches=0;
      try{
        const f=fixture({transcript:changed,
          cancelAt:['REFRESH','CURRENT'].includes(variant)?variant:undefined});await f.init();
        const tx=await f.bound.prepareBrowser(f.proof);
        if(variant==='success')await tx.port.activateOnce(tx.grant);
        else if(variant==='PREPARED')await f.bound.cancel();
        else await tx.port.activateOnce(tx.grant);
        launches=f.launches.length;
      }catch{rejected=true;}
      assert.equal(rejected,true,variant+'/'+name);assert.ok(launches<=1,variant+'/'+name);
    }
  }
  const f=await fixture({transcript}).init(),tx=await f.bound.prepareBrowser(f.proof);
  await assert.rejects(f.workerBinding.prepare(f.prepareBytes));
  await assert.rejects(tx.port.activateOnce(tx.grant));assert.equal(f.launches.length,0);
});
