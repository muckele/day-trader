'use strict';
// Offline adoption of bootstrap-owned inherited pipes. No native/spawn/setuid
// API exists. The injected bootstrap authority is trusted same-process code;
// worker-authored booleans or copied handles cannot establish provenance.
const handoffs = new WeakMap(), usedGrants = new WeakSet(), ownedChildren = new WeakSet(), ownedPipes = new WeakSet();
const kinds = Object.freeze({ BROWSER: 10002, VERIFIER: 10003 });
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function object(v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); }
function privateHandle(value) {
  return Object.freeze(Object.defineProperty(value, 'toJSON', {value: () => fail('PRIVATE_HANDLE')}));
}
function factsValid(f, runId, waiting = true) {
  return f && Object.hasOwn(kinds, f.kind) && f.runId === runId &&
    f.uid === kinds[f.kind] && object(f.child) && object(f.privatePipe) &&
    f.waiting === waiting && f.confined === true;
}
function same(f, expected, waiting) {
  return factsValid(f, expected.runId, waiting) && f.kind === expected.kind &&
    f.child === expected.child && f.privatePipe === expected.privatePipe;
}
function bindRoleBootstrap(authority, runId) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{32}$/.test(runId) || !authority ||
      ['inspectHandoff','inspectGrant','activate','waitExit','stopOwned'].some(n=>typeof authority[n] !== 'function')) fail('HANDOFF_DENIED');
  // This is a trusted embedding API, not a generic bootstrap RPC or verifier
  // installed from incoming worker data. Capture the authority object so its
  // current independent observations can be rechecked before/after each await.
  return Object.freeze({audit(handoff) {
    if (!object(handoff) || handoffs.has(handoff)) fail('HANDOFF_DENIED');
    let f;
    try { f = authority.inspectHandoff(handoff); } catch { fail('HANDOFF_DENIED'); }
    if (!factsValid(f, runId) || ownedChildren.has(f.child) || ownedPipes.has(f.privatePipe)) fail('HANDOFF_DENIED');
    const expected = Object.freeze({ kind:f.kind, runId, uid:f.uid, child:f.child, privatePipe:f.privatePipe,
      waiting:true, confined:true });
    ownedChildren.add(f.child); ownedPipes.add(f.privatePipe);
    handoffs.set(handoff,{authority,expected,adopted:false});
    return handoff;
  }});
}
function adoptRole(kind, handoff) {
  if (arguments.length !== 2 || !Object.hasOwn(kinds,kind) || !object(handoff)) fail('HANDOFF_DENIED');
  const r=handoffs.get(handoff);
  if (!r || r.adopted || r.expected.kind !== kind) fail('HANDOFF_DENIED');
  function current(code, waiting = true) {
    try { if (!same(r.authority.inspectHandoff(handoff),r.expected,waiting)) fail(code); }
    catch { fail(code); }
  }
  current('HANDOFF_DENIED'); r.adopted=true;
  async function exit(operation, deadline, count) {
    const budget=r.authority.cleanupBudget;
    if (count !== 1 || !Number.isSafeInteger(deadline) || deadline < (budget ? 0 : 1) || deadline > 1200000) fail('EXIT_DENIED');
    if (budget) deadline=Math.min(deadline,budget.remaining());
    let result;
    try { result=await r.authority[operation](r.expected.child,deadline); } catch { fail('EXIT_DENIED'); }
    if (!result || typeof result !== 'object' || Reflect.ownKeys(result).length !== 3 ||
        !['status','runId','child'].every(key=>Object.hasOwn(result,key)) ||
        !['EXITED','STOPPED','TIMEOUT'].includes(result.status) || result.runId !== r.expected.runId || result.child !== r.expected.child) fail('EXIT_DENIED');
    return Object.freeze({status:result.status,runId:r.expected.runId});
  }
  const cleanup=privateHandle({
    async waitExit(deadline) { return exit('waitExit',deadline,arguments.length); },
    async stopOwned(deadline) { return exit('stopOwned',deadline,arguments.length); }});
  let consumed=false;
  return privateHandle({kind, async activateOnce(grant) {
    if (consumed) fail('ACTIVATION_DENIED');
    consumed=true; // Consume synchronously before any callback or await.
    try {
      // A waiting child already exists. Every failure after consume, including
      // pre-effect validation/inspection, uses its retained cleanup authority.
      if (arguments.length !== 1 || !object(grant) || usedGrants.has(grant)) fail('ACTIVATION_DENIED');
      usedGrants.add(grant);
      current('ACTIVATION_DENIED');
      const g=r.authority.inspectGrant(grant);
      if (!g || g.kind !== kind || g.runId !== r.expected.runId || g.child !== r.expected.child ||
          g.purpose !== (kind === 'BROWSER' ? 'CONFINEMENT_PROVED' : 'PRIOR_SESSION') ||
          (kind === 'VERIFIER' ? !object(g.session) : g.session !== null)) fail('ACTIVATION_DENIED');
      await r.authority.activate(r.expected.child,grant);
      current('ACTIVATION_DENIED',false);
    } catch (cause) {
      let stopped;
      try { stopped=await cleanup.stopOwned(r.authority.cleanupBudget ? r.authority.cleanupBudget.remaining() : 120000); } catch { /* explicitly uncertain below */ }
      if (!stopped || !['STOPPED','EXITED'].includes(stopped.status)) {
        const e=new Error('CLEANUP_UNCERTAIN',{cause}); e.code='CLEANUP_UNCERTAIN'; e.cleanup=cleanup; throw e;
      }
      const e=new Error('ACTIVATION_DENIED',{cause});e.code='ACTIVATION_DENIED';throw e;
    }
    return privateHandle({privatePipe:r.expected.privatePipe,
      waitExit:cleanup.waitExit, stopOwned:cleanup.stopOwned});
  }});
}
// Composition v1 is a finite original-pipe protocol. These constructors are
// trusted embedding boundaries; no wire record can install an authority, pipe,
// clock, fence or launch function. Native effect ordering remains unavailable
// unless the embedding can independently supply the required synchronous fence.
const {createHmac, timingSafeEqual, randomBytes} = require('node:crypto');
const ROLE_ORDER=Object.freeze(['CONTROLLER','BROWSER','VERIFIER','PROXY']);
const reservations=new WeakMap(), transactions=new WeakMap(), channels=new WeakSet();
const ID=/^[0-9a-f]{32}$/, DIGEST=/^[0-9a-f]{64}$/;
function exact(v,keys) {
  if (!v || typeof v!=='object' || Array.isArray(v) || Reflect.ownKeys(v).length!==keys.length || keys.some(k=>!Object.hasOwn(v,k))) fail('FRAME_DENIED');
}
function integer(n,min=1) {if (!Number.isSafeInteger(n)||Object.is(n,-0)||n<min) fail('FRAME_DENIED');return n;}
function hex(v,pattern=ID) {if(typeof v!=='string'||!pattern.test(v))fail('FRAME_DENIED');return v;}
function canonical(v) {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
function immutable(v) {if(v&&typeof v==='object'){for(const x of Object.values(v))immutable(x);Object.freeze(v);}return v;}
function bindingRecord(v) {
  exact(v,['version','runId','manifestDigest','configIdentity','rolePolicyDigest','epoch','expiresAtMs']);
  if(v.version!==1)fail('FRAME_DENIED');hex(v.runId);for(const k of ['manifestDigest','configIdentity','rolePolicyDigest'])hex(v[k],DIGEST);
  integer(v.epoch);integer(v.expiresAtMs);return immutable(JSON.parse(canonical(v)));
}
function decode(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>16388||bytes.readUInt32BE()!==bytes.length-4)fail('FRAME_DENIED');
  const body=bytes.subarray(4);if(body.some(x=>x>127))fail('FRAME_DENIED');
  const text=body.toString('ascii');let depth=0,quoted=false,escaped=false;
  for(const c of text){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='['){if(++depth>8)fail('FRAME_DENIED');}else if(c==='}'||c===']')depth--;}
  let value;try{value=JSON.parse(text);}catch{fail('FRAME_DENIED');}
  // A single canonical representation also rejects duplicate keys, alternate
  // number spellings and escaped/non-ASCII lookalikes before authentication.
  if(canonical(value)!==text)fail('FRAME_DENIED');return immutable(value);
}
function encode(v) {const bytes=Buffer.from(canonical(v),'ascii');if(!bytes.length||bytes.length>16384)fail('FRAME_DENIED');const prefix=Buffer.alloc(4);prefix.writeUInt32BE(bytes.length);return Buffer.concat([prefix,bytes]);}
function proofRecord(p) {
  exact(p,['proofDigest','generation','expiresAtMs','monotonicDeadlineMs']);hex(p.proofDigest,DIGEST);
  for(const k of ['generation','expiresAtMs','monotonicDeadlineMs'])integer(p[k]);return immutable({...p});
}
function prepareResult(p) {exact(p,['grantId','proofDigest','generation','expiresAtMs','monotonicDeadlineMs']);hex(p.grantId);proofRecord({proofDigest:p.proofDigest,generation:p.generation,expiresAtMs:p.expiresAtMs,monotonicDeadlineMs:p.monotonicDeadlineMs});return p;}
function checkpoint(v,binding,generation,original) {
  exact(v,['binding','generation','sequence','sourceIdentity','lostCount']);bindingRecord(v.binding);integer(v.generation);integer(v.sequence);integer(v.lostCount,0);hex(v.sourceIdentity);
  if(canonical(v.binding)!==canonical(binding)||v.generation!==generation||v.lostCount!==0)fail('AUTHORITY_LOST');
  if(original&&(v.sourceIdentity!==original.sourceIdentity||v.sequence<original.sequence||v.lostCount!==original.lostCount))fail('AUTHORITY_LOST');return v;
}
function clockReader(clock) {
  if(!clock||typeof clock.sample!=='function')fail('CLOCK');let last,failed=false;
  return ()=>{
    if(failed)fail('CLOCK');
    try{const s=clock.sample();if(!Array.isArray(s)||s.length!==2)fail('CLOCK');s.forEach(n=>integer(n,0));if(last&&(s[0]<last[0]||s[1]<last[1]))fail('CLOCK');last=[...s];return last;}
    catch{failed=true;fail('CLOCK');}
  };
}
function cleanupBoundary(budget,sample) {
  if(!budget||typeof budget.remaining!=='function'||typeof budget.clamp!=='function')fail('CLEANUP_UNCERTAIN');
  let end=null,realEnd=null,nonblocking=false;const busy=new Map();
  function revokeWait() {
    nonblocking=true;end=0;realEnd=0;
    // Admission clock loss must never disable the retained cleanup capability.
    // Zero is absolute, so even a later clock recovery cannot renew this end.
    try{budget.clamp(0);}catch{}
    return 0;
  }
  function remaining(delivered) {
    if(delivered!==undefined)integer(delivered,0);
    if(nonblocking)return 0;
    const real=Number(process.hrtime.bigint()/1000000n);
    try{
      const now=sample()[1];
      if(delivered!==undefined){budget.clamp(delivered);end=Math.min(end??delivered,delivered);}
      const allowance=integer(budget.remaining(),0);
      if(end===null)end=now+Math.min(60000,allowance);
      end=Math.min(end,integer(budget.deadline,0));
      realEnd=Math.min(realEnd??Infinity,real+Math.max(0,end-now));
      return Math.max(0,Math.min(end-now,realEnd-real,allowance));
    }catch{return revokeWait();}
  }
  async function call(owner,fn,requested=60000) {
    if(busy.has(owner))fail('CLEANUP_UNCERTAIN');const ms=Math.min(integer(requested,0),remaining());
    let timer;const pending=Promise.resolve().then(()=>fn(ms));busy.set(owner,pending);
    pending.finally(()=>{if(busy.get(owner)===pending)busy.delete(owner);}).catch(()=>{});
    try {return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('CLEANUP_UNCERTAIN'),{code:'CLEANUP_UNCERTAIN'})),ms);})]);}
    finally{clearTimeout(timer);}
  }
  return {remaining,call,revokeWait,get deadline(){remaining();return end;}};
}
function auditSnapshot(channel,role,binding,expected) {
  if(!channel||['audit','read','write'].some(k=>typeof channel[k]!=='function')||channels.has(channel))fail('CHANNEL_DENIED');
  const facts=channel.audit();if(!facts||facts.role!==role||!object(facts.command)||!object(facts.result)||facts.command===facts.result)fail('CHANNEL_DENIED');
  bindingRecord(facts.binding);hex(facts.childId);hex(facts.pipeId);hex(facts.channelKeyHex,DIGEST);
  if(canonical(facts.binding)!==canonical(binding))fail('CHANNEL_DENIED');
  const saved={...facts,binding,roles:role==='CONTROLLER'?immutable(JSON.parse(canonical(facts.roles))):undefined};
  if(expected&&['childId','pipeId','channelKeyHex','command','result'].some(k=>expected[k]!==saved[k]))fail('CHANNEL_DENIED');
  if(saved.roles){if(saved.roles.length!==4)fail('CHANNEL_DENIED');const ids=new Set();saved.roles.forEach((row,i)=>{exact(row,['role','childId','pipeId']);if(row.role!==ROLE_ORDER[i])fail('CHANNEL_DENIED');hex(row.childId);hex(row.pipeId);for(const id of [row.childId,row.pipeId]){if(ids.has(id))fail('CHANNEL_DENIED');ids.add(id);}});if(saved.roles[0].childId!==saved.childId||saved.roles[0].pipeId!==saved.pipeId)fail('CHANNEL_DENIED');}
  channels.add(channel);
  const check=()=>{const f=channel.audit();if(!f||['role','childId','pipeId','channelKeyHex','command','result'].some(k=>f[k]!==saved[k])||canonical(f.binding)!==canonical(binding)||(saved.roles&&canonical(f.roles)!==canonical(saved.roles)))fail('AUTHORITY_LOST');};
  return {saved,check};
}
async function originalChannel(channel,role,binding,expected) {
  const {saved,check}=auditSnapshot(channel,role,binding,expected);check();const init=decode(await channel.read());check();
  exact(init,role==='CONTROLLER'?['version','kind','binding','channelKeyHex','roles']:['version','kind','binding','role','childId','pipeId','channelKeyHex']);
  if(init.version!==1||init.kind!==(role==='CONTROLLER'?'BOOTSTRAP_INIT':'BROWSER_WORKER_INIT')||canonical(init.binding)!==canonical(binding)||init.channelKeyHex!==saved.channelKeyHex||(role==='CONTROLLER'?canonical(init.roles)!==canonical(saved.roles):['role','childId','pipeId'].some(k=>init[k]!==saved[k])))fail('CHANNEL_DENIED');
  let incoming=0,outgoing=0;
  const auth=(v,direction)=>createHmac('sha256',Buffer.from(saved.channelKeyHex,'hex')).update('acceptance:bootstrap-composition:v1\0'+role+':'+direction+'\0'+canonical(v)).digest('hex');
  function read(bytes) {
    check();const f=decode(bytes);exact(f,['version','binding','sequence','role','childId','pipeId','action','payload','mac']);
    const row=role==='CONTROLLER'?saved.roles.find(r=>r.role===f.role):saved;
    if(!row||f.role!==row.role||f.version!==1||canonical(f.binding)!==canonical(binding)||f.childId!==row.childId||f.pipeId!==row.pipeId||f.sequence!==incoming+1)fail('FRAME_DENIED');integer(f.sequence);hex(f.mac,DIGEST);
    const unsigned={...f};delete unsigned.mac;if(!timingSafeEqual(Buffer.from(f.mac,'hex'),Buffer.from(auth(unsigned,'FROM_BOOTSTRAP'),'hex')))fail('FRAME_DENIED');incoming++;return f;
  }
  function beginWrite(target,action,payload,reserve=()=>{}) {
    check();integer(outgoing+1);const row=role==='CONTROLLER'?saved.roles.find(r=>r.role===target):saved;
    if(!row||row.role!==target)fail('FRAME_DENIED');const f={version:1,binding,sequence:++outgoing,role:target,childId:row.childId,pipeId:row.pipeId,action,payload};
    reserve(f.sequence);
    return {sequence:f.sequence,completion:Promise.resolve(channel.write(encode({...f,mac:auth(f,'TO_BOOTSTRAP')}))).then(check)};
  }
  async function write(target,action,payload){const sent=beginWrite(target,action,payload);await sent.completion;return sent.sequence;}
  return {saved,check,read,write,beginWrite,async receive(){const bytes=await channel.read();if(bytes===undefined||bytes===null||bytes.length===0)fail('CHANNEL_EOF');return read(bytes);}};
}

async function bindBootstrapComposition(channel,input,clock,cleanupBudget) {
  const binding=bindingRecord(input),sample=clockReader(clock),cleanup=cleanupBoundary(cleanupBudget,sample);
  const wire=await originalChannel(channel,'CONTROLLER',binding);let terminal=false,inflight=false,prepared=false,reading=false,cancelling=false;
  const pending=new Map();
  const local=new Map(),grants=new WeakMap(),stopped=new WeakSet();
  function current(p) {wire.check();const [wall,mono]=sample();if(terminal||wall>=binding.expiresAtMs||(p&&(p.generation!==1||wall>=p.expiresAtMs||mono>=p.monotonicDeadlineMs)))fail('AUTHORITY_LOST');}
  async function responses() {
    if(reading)return;reading=true;
    try{while(pending.size){const f=await wire.receive();exact(f.payload,['requestSequence','result']);const slot=pending.get(f.payload.requestSequence);
      if(!slot||f.action!=='RESULT'||f.role!==slot.role)fail('FRAME_DENIED');pending.delete(f.payload.requestSequence);slot.resolve(f.payload.result);}}
    catch(e){terminal=true;if(e.code==='CHANNEL_EOF')cleanup.revokeWait();else cleanup.remaining();for(const slot of pending.values())slot.reject(e);pending.clear();}
    finally{reading=false;}
  }
  async function request(role,action,payload,cleaning=false) {
    const isCancel=action==='CANCEL';
    if((isCancel&&cancelling)||(!isCancel&&inflight)||pending.size>=2)fail('FRAME_DENIED');if(!cleaning)current();
    if(isCancel)cancelling=true;else inflight=true;
    let sequence,resolve,reject;const answer=new Promise((yes,no)=>{resolve=yes;reject=no;});answer.catch(()=>{});
    try{const sent=wire.beginWrite(role,action,payload,seq=>{sequence=seq;pending.set(seq,{role,resolve,reject});});
      await sent.completion;responses();const result=await answer;if(!cleaning)current();return result;
    }catch(e){terminal=true;if(sequence!==undefined)pending.delete(sequence);reject(e);throw e;}
    finally{if(isCancel)cancelling=false;else inflight=false;}
  }
  async function stop(kind,ms,operation='STOP_OWNED') {
    const row=wire.saved.roles.find(r=>r.role===kind);integer(ms,0);
    if(stopped.has(row))return {status:'STOPPED',runId:binding.runId};
    return cleanup.call(row,async allowance=>{const r=await request(kind,operation,{remainingMs:allowance,cleanupEndsAtMonotonicMs:cleanup.deadline},true);exact(r,['status','runId']);if(!['STOPPED','EXITED','TIMEOUT'].includes(r.status)||r.runId!==binding.runId)fail('CLEANUP_UNCERTAIN');if(r.status!=='TIMEOUT')stopped.add(row);return r;},ms);
  }
  const authority={cleanupBudget:cleanup,
    inspectHandoff(h){current();const r=local.get(h);return r?{kind:r.kind,runId:binding.runId,uid:kinds[r.kind],child:r.child,privatePipe:r.pipe,waiting:!r.active,confined:true}:null;},
    inspectGrant(g){const r=grants.get(g);if(!r)return null;current(r.proof);return {kind:'BROWSER',runId:binding.runId,child:r.child,purpose:'CONFINEMENT_PROVED',session:null};},
    async activate(child,g){const r=grants.get(g);if(!r||r.child!==child||r.used)fail('ACTIVATION_DENIED');r.used=true;current(r.proof);const result=await request('BROWSER','COMMIT_BROWSER',{grantId:r.grantId,generation:r.proof.generation});current(r.proof);exact(result,['status','generation']);if(result.status!=='ACTIVE'||result.generation!==1)fail('ACTIVATION_DENIED');r.active=true;},
    async stopOwned(child,ms){const r=[...local.values()].find(r=>r.child===child);if(!r)fail('EXIT_DENIED');return {...await stop(r.kind,ms),child};},
    async waitExit(child,ms){const r=[...local.values()].find(r=>r.child===child);if(!r)fail('EXIT_DENIED');return {...await stop(r.kind,ms,'WAIT_EXIT'),child};}};
  const bootstrap=bindRoleBootstrap(authority,binding.runId), adopted=new Map();
  async function adopt(kind) {
    if(!Object.hasOwn(kinds,kind)||adopted.has(kind))fail('HANDOFF_DENIED');current();adopted.set(kind,null);
    const result=await request(kind,'ADOPT',{}),row=wire.saved.roles.find(r=>r.role===kind);
    exact(result,['kind','runId','uid','childId','pipeId','waiting','confined','attestationDigest']);hex(result.attestationDigest,DIGEST);
    if(result.kind!==kind||result.runId!==binding.runId||result.uid!==kinds[kind]||result.childId!==row.childId||result.pipeId!==row.pipeId||result.waiting!==true||result.confined!==true)fail('HANDOFF_DENIED');
    const handoff=privateHandle({}),r={kind,child:privateHandle({}),pipe:privateHandle({}),active:false};local.set(handoff,r);bootstrap.audit(handoff);const port=adoptRole(kind,handoff);adopted.set(kind,{port,r});return port;
  }
  return privateHandle({adopt,async prepareBrowser(value){
    try{if(prepared)fail('ACTIVATION_DENIED');prepared=true;const p=proofRecord(value);current(p);
      if(!adopted.has('BROWSER'))await adopt('BROWSER');const entry=adopted.get('BROWSER');if(!entry)fail('HANDOFF_DENIED');
      const result=prepareResult(await request('BROWSER','PREPARE_BROWSER',p));current(p);
      if(['proofDigest','generation','expiresAtMs','monotonicDeadlineMs'].some(k=>result[k]!==p[k]))fail('AUTHORITY_LOST');
      const grant=privateHandle({});Object.assign(entry.r,{proof:p,grantId:result.grantId,used:false});grants.set(grant,entry.r);
      const tx=privateHandle({port:entry.port,grant,stopOwned:ms=>stop('BROWSER',ms)});transactions.set(tx,entry.r);return tx;
    }catch(e){terminal=true;try{const receipt=await stop('BROWSER',cleanup.remaining());if(!['STOPPED','EXITED'].includes(receipt.status))fail('CLEANUP_UNCERTAIN');}catch{e.cleanup=privateHandle({stopOwned:ms=>stop('BROWSER',ms)});}throw e;}
  },async cancel(){terminal=true;const result=await request('BROWSER','CANCEL',{generation:1,cleanupEndsAtMonotonicMs:cleanup.deadline},true);exact(result,['status','generation']);if(result.status!=='CANCELLED'||result.generation!==1)fail('FRAME_DENIED');return result;},stopOwned:ms=>stop('BROWSER',ms)});
}

async function bindBrowserWorkerChannel(channel,expected,clock,cleanupBudget) {
  const binding=bindingRecord(expected.binding),sample=clockReader(clock),cleanup=cleanupBoundary(cleanupBudget,sample);
  const wire=await originalChannel(channel,'BROWSER',binding,expected);let terminal=false,preparing=false,active=null,acquiring=false,pendingCancel=null,originalReservation=null;
  const stopped=new WeakSet();let terminalRecorded=false,firstTerminalAt=null;
  function current(p) {wire.check();const [wall,mono]=sample();if(terminal)fail('CANCELLED');if(wall>=binding.expiresAtMs||(p&&(wall>=p.expiresAtMs||mono>=p.monotonicDeadlineMs)))fail('EXPIRED');if(p&&p.generation!==1)fail('AUTHORITY_LOST');}
  function cancel(f) {if(f.action!=='CANCEL'||pendingCancel!==null)fail('FRAME_DENIED');exact(f.payload,['generation','cleanupEndsAtMonotonicMs']);if(f.payload.generation!==1)fail('FRAME_DENIED');invalidate();pendingCancel=f.sequence;cleanup.remaining(f.payload.cleanupEndsAtMonotonicMs);}
  async function acknowledgeCancel() {if(pendingCancel!==null){const seq=pendingCancel;pendingCancel=null;await wire.write('BROWSER','CANCELLED',{requestSequence:seq,generation:1});}}
  function drain() {if(typeof channel.drain!=='function')fail('NATIVE_EFFECT_FENCE_UNAVAILABLE');const pending=channel.drain();if(!Array.isArray(pending)||pending.length>16)fail('FRAME_DENIED');for(const bytes of pending)cancel(wire.read(bytes));}
  function invalidate() {
    terminal=true;if(originalReservation)originalReservation.used=true;
    if(!terminalRecorded){
      terminalRecorded=true;
      // The reported terminal instant also fixes the local absolute end. A
      // later cleanup sample can spend this budget, never start it again.
      try{firstTerminalAt=sample()[1];cleanup.remaining(firstTerminalAt+60000);}
      catch{cleanup.revokeWait();}
    }
  }
  async function stop(ms) {
    invalidate();let uncertain=false;
    // A failed browser stop must not suppress the original-family stop. Each
    // owner remains reserved until its callback settles, even after timeout.
    for(const owner of active?[active,channel]:[channel]){
      if(object(owner)&&stopped.has(owner))continue;
      try{await cleanup.call(owner,async allowance=>{
        if(!object(owner)||typeof owner.stopOwned!=='function')fail('CLEANUP_UNCERTAIN');
        const r=await owner.stopOwned(allowance);exact(r,['status','runId']);
        if(!['STOPPED','EXITED'].includes(r.status)||r.runId!==binding.runId)fail('CLEANUP_UNCERTAIN');stopped.add(owner);
      },ms);}catch{uncertain=true;}
    }
    if(uncertain)fail('CLEANUP_UNCERTAIN');return {status:acquiring?'TIMEOUT':'STOPPED',runId:binding.runId};
  }
  async function failed(cause,requestSequence=0) {
    const code=object(cause)&&['FRAME_DENIED','AUTHORITY_LOST','CLOCK','CANCELLED','EXPIRED','NATIVE_EFFECT_FENCE_UNAVAILABLE','LAUNCH_FAILED','CLEANUP_UNCERTAIN','CHANNEL_EOF'].includes(cause.code)?cause.code:'LAUNCH_FAILED';
    const error=Object.assign(new Error(code,{cause}),{code});
    if(error.code==='CHANNEL_EOF')cleanup.revokeWait();
    invalidate();cleanup.remaining();
    // Failure reporting is best effort; it cannot precede ownership retention
    // or let a second clock exception bypass compensation.
    error.cleanup=privateHandle({stopOwned:stop});
    try{await stop(cleanup.remaining());}catch{}
    if(pendingCancel!==null){try{await cleanup.call(wire,acknowledgeCancel);}catch{}}
    // Framing/EOF failures have no authenticated correlation of their own;
    // never borrow an earlier COMMIT/CURRENT sequence for their failure reply.
    else if(requestSequence&&firstTerminalAt!==null&&!['FRAME_DENIED','CHANNEL_EOF'].includes(code))try{await cleanup.call(wire,()=>wire.write('BROWSER','FAILED',{requestSequence,generation:1,code:['CANCELLED','EXPIRED','AUTHORITY_LOST','CLEANUP_UNCERTAIN'].includes(error.code)?error.code:'LAUNCH_FAILED',failedAtMonotonicMs:firstTerminalAt}));}catch{}
    throw error;
  }
  return privateHandle({async prepare(record){
    try{if(preparing)fail('AUTHORITY_LOST');preparing=true;current();const f=wire.read(record);if(f.action!=='PREPARE')fail('FRAME_DENIED');const p=prepareResult(f.payload);current(p);
      const reservation=privateHandle({}),r={binding,proof:p,reservationId:randomBytes(16).toString('hex'),used:false,effect:false};reservations.set(reservation,r);
      originalReservation=r;
      await wire.write('BROWSER','PREPARED',{requestSequence:f.sequence,grantId:p.grantId,reservationId:r.reservationId,generation:1});drain();current(p);return reservation;
    }catch(e){return failed(e);}
  },async commitFixedBrowserLaunch(reservation,launchPinnedBrowser){
    let requestSequence=0;
    try{const r=reservations.get(reservation);
      if(!r||r.binding!==binding||r.used||typeof launchPinnedBrowser!=='function')fail('AUTHORITY_LOST');r.used=true;
      drain();current(r.proof);const commit=await wire.receive();requestSequence=commit.sequence;current(r.proof);
      if(commit.action==='CANCEL'){cancel(commit);fail('CANCELLED');}
      exact(commit.payload,['grantId','reservationId','commitId','generation']);const p=commit.payload;hex(p.commitId);
      if(commit.action!=='COMMIT'||p.grantId!==r.proof.grantId||p.reservationId!==r.reservationId||p.generation!==1)fail('AUTHORITY_LOST');
      const refresh=await wire.write('BROWSER','REFRESH',{requestSequence:commit.sequence,...p});drain();current(r.proof);
      const response=await wire.receive();requestSequence=response.sequence;current(r.proof);const v=response.payload;
      exact(v,['requestSequence','grantId','reservationId','commitId','generation','proofDigest','eventCheckpoint','expiresAtMs','monotonicDeadlineMs']);
      if(response.action!=='CURRENT'||v.requestSequence!==refresh||['grantId','reservationId','commitId','generation'].some(k=>v[k]!==p[k])||v.proofDigest!==r.proof.proofDigest||v.expiresAtMs!==r.proof.expiresAtMs||v.monotonicDeadlineMs!==r.proof.monotonicDeadlineMs)fail('AUTHORITY_LOST');
      checkpoint(v.eventCheckpoint,binding,1);drain();
      if(typeof channel.effectFence!=='function')fail('NATIVE_EFFECT_FENCE_UNAVAILABLE');
      const fence=channel.effectFence(v.eventCheckpoint);if(!fence||typeof fence.then==='function')fail('NATIVE_EFFECT_FENCE_UNAVAILABLE');checkpoint(fence,binding,1,v.eventCheckpoint);
      // All channel/fence callbacks precede the final local clock/latch guard.
      // No await or callback occurs between this guard and the captured launch.
      drain();current(r.proof);checkpoint(fence,binding,1,v.eventCheckpoint);if(r.effect)fail('AUTHORITY_LOST');r.effect=true;
      acquiring=true;
      try{const launched=launchPinnedBrowser();active=await launched;}finally{acquiring=false;}
      if(!object(active)||typeof active.stopOwned!=='function')fail('LAUNCH_FAILED');drain();current(r.proof);
      await wire.write('BROWSER','STARTED',{requestSequence:response.sequence,...p});drain();current(r.proof);
      return privateHandle({status:'STARTED',browserOwner:active});
    }catch(e){return failed(e,requestSequence);}
  },async cancel(record){try{cancel(wire.read(record));await cleanup.call(wire,acknowledgeCancel);return await stop(cleanup.remaining());}catch(e){return failed(e);}},stopOwned:stop});
}
module.exports = Object.freeze({bindRoleBootstrap,adoptRole,bindBootstrapComposition,bindBrowserWorkerChannel});
