'use strict';
// Offline adoption of bootstrap-owned inherited pipes. No native/spawn/setuid
// API exists. The injected bootstrap authority is trusted same-process code;
// worker-authored booleans or copied handles cannot establish provenance.
const handoffs = new WeakMap(), usedGrants = new WeakSet(), ownedChildren = new WeakSet(), ownedPipes = new WeakSet();
// T8-11: authority.activate receives only a frozen projection of the facts the
// authority itself verified; the caller's grant object never reaches it. Only
// this module can map a projection back to the grant it verified.
const projectedGrants = new WeakMap();
const GRANT_FACTS = Object.freeze(['kind','runId','child','purpose','session','remainingMs']);
const browserApplicationPipes = new WeakMap(), browserRequestEvidence = new WeakMap();
// T13 I-8: the provenance brand. It holds the activateOnce handles adoptRole returns and
// the application pipes this module adopted (from a trusted authority's BROWSER handoff, or
// built by browserApplicationPipe). Nothing outside this module can add to it.
const adoptedRolePorts = new WeakSet();
function inspectAdoptedRolePort(value) { return adoptedRolePorts.has(value); }
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
  // installed from incoming worker data. Capture the authority object; the
  // facts it reports are rechecked before and after each await. Role ports do
  // not observe the child themselves: the authority's facts are the evidence.
  return Object.freeze({audit(handoff) {
    if (!object(handoff) || handoffs.has(handoff)) fail('HANDOFF_DENIED');
    let f;
    try { f = authority.inspectHandoff(handoff); } catch { fail('HANDOFF_DENIED'); }
    if (!factsValid(f, runId) || ownedChildren.has(f.child) || ownedPipes.has(f.privatePipe)) fail('HANDOFF_DENIED');
    const expected = Object.freeze({ kind:f.kind, runId, uid:f.uid, child:f.child, privatePipe:f.privatePipe,
      waiting:true, confined:true });
    if(f.kind==='BROWSER'&&typeof f.privatePipe.audit==='function'){
      const app=f.privatePipe.audit();
      if(!app||app.kind!=='TASK13_BROWSER_APPLICATION'||app.version!==1||app.runId!==runId||app.maxFrameBytes!==16384)fail('HANDOFF_DENIED');
      if(!browserApplicationPipes.has(f.privatePipe))browserApplicationPipes.set(f.privatePipe,{runId});
      adoptedRolePorts.add(f.privatePipe);
    }
    ownedChildren.add(f.child); ownedPipes.add(f.privatePipe);
    handoffs.set(handoff,{authority,expected,adopted:false});
    return handoff;
  }});
}
// Terminal-path allowance from an embedder budget: start its shared end first
// when it supports the terminal-start rule (C1).
function terminalRemaining(budget) {
  return typeof budget.startTerminal==='function'?budget.startTerminal():budget.remaining();
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
    if (budget) deadline=Math.min(deadline,terminalRemaining(budget));
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
  const port=privateHandle({kind, async activateOnce(grant) {
    if (consumed) fail('ACTIVATION_DENIED');
    consumed=true; // Consume synchronously before any callback or await.
    try {
      // A waiting child already exists. Every failure after consume, including
      // pre-effect validation/inspection, uses its retained cleanup authority.
      if (arguments.length !== 1 || !object(grant) || usedGrants.has(grant)) fail('ACTIVATION_DENIED');
      usedGrants.add(grant);
      current('ACTIVATION_DENIED');
      const g=r.authority.inspectGrant(grant);
      if (!object(g) || Reflect.ownKeys(g).length !== GRANT_FACTS.length || GRANT_FACTS.some(k=>!Object.hasOwn(g,k)) ||
          g.kind !== kind || g.runId !== r.expected.runId || g.child !== r.expected.child ||
          g.purpose !== (kind === 'BROWSER' ? 'CONFINEMENT_PROVED' : 'PRIOR_SESSION') ||
          (kind === 'VERIFIER' ? !object(g.session) : g.session !== null) ||
          !Number.isSafeInteger(g.remainingMs) || g.remainingMs < 1 || g.remainingMs > 2147483647) fail('ACTIVATION_DENIED');
      const projection=Object.freeze({kind:g.kind,runId:g.runId,child:g.child,purpose:g.purpose,session:g.session});
      projectedGrants.set(projection,grant);
      // P5 (C1): bounded by the activation/run deadline the authority reports,
      // never by the shared cleanup budget, which only the stop path below uses.
      let timer;
      try {
        await Promise.race([Promise.resolve().then(()=>r.authority.activate(r.expected.child,projection)),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('ACTIVATION_DENIED'),{code:'ACTIVATION_DENIED'})),g.remainingMs);})]);
      } finally { clearTimeout(timer); }
      current('ACTIVATION_DENIED',false);
    } catch (cause) {
      let stopped;
      try { stopped=await cleanup.stopOwned(r.authority.cleanupBudget ? terminalRemaining(r.authority.cleanupBudget) : 120000); } catch { /* explicitly uncertain below */ }
      if (!stopped || !['STOPPED','EXITED'].includes(stopped.status)) {
        const e=new Error('CLEANUP_UNCERTAIN',{cause}); e.code='CLEANUP_UNCERTAIN'; e.cleanup=cleanup; throw e;
      }
      const e=new Error('ACTIVATION_DENIED',{cause});e.code='ACTIVATION_DENIED';throw e;
    }
    return privateHandle({privatePipe:r.expected.privatePipe,
      // Called only on browser close/stop paths (terminal).
      cleanupRemaining(){const budget=r.authority.cleanupBudget;return budget?terminalRemaining(budget):120000;},
      waitExit:cleanup.waitExit, stopOwned:cleanup.stopOwned});
  }});
  adoptedRolePorts.add(port);
  return port;
}
// Composition v1 is a finite original-pipe protocol. These constructors are
// trusted embedding boundaries; no wire record can install an authority, pipe,
// clock, fence or launch function. Native effect ordering remains unavailable
// unless the embedding can independently supply the required synchronous fence.
const {createHmac, timingSafeEqual, randomBytes} = require('node:crypto');
const ROLE_ORDER=Object.freeze(['CONTROLLER','BROWSER','VERIFIER','PROXY']);
const reservations=new WeakMap(), transactions=new WeakMap(), channels=new WeakSet();
const CONTROLLER_TRANSACTION_SEAL={}, WORKER_RESERVATION_SEAL={};
class ControllerBrowserTransaction {
  constructor(port,grant,stopOwned,seal) {
    if(seal!==CONTROLLER_TRANSACTION_SEAL)fail('AUTHORITY_LOST');
    this.port=port;this.grant=grant;this.stopOwned=stopOwned;
    return privateHandle(this);
  }
}
class WorkerLaunchReservation {
  constructor(seal) {
    if(seal!==WORKER_RESERVATION_SEAL)fail('AUTHORITY_LOST');
    return privateHandle(this);
  }
}
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
function preparedPayload(p) {
  if(!p||typeof p!=='object'||Array.isArray(p))fail('FRAME_DENIED');
  const keys=Reflect.ownKeys(p).sort().join(',');
  if(!['expiresAtMs,generation,grantId,monotonicDeadlineMs,proofDigest','browserConfig,expiresAtMs,generation,grantId,monotonicDeadlineMs,proofDigest'].includes(keys))fail('FRAME_DENIED');
  const proof=prepareResult({grantId:p.grantId,proofDigest:p.proofDigest,generation:p.generation,expiresAtMs:p.expiresAtMs,monotonicDeadlineMs:p.monotonicDeadlineMs});
  if(!Object.hasOwn(p,'browserConfig'))return {proof,browserConfig:null};
  if(!p.browserConfig||typeof p.browserConfig!=='object'||Array.isArray(p.browserConfig))fail('FRAME_DENIED');
  return {proof,browserConfig:immutable(JSON.parse(canonical(p.browserConfig)))};
}
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
// One shared cleanup end per side (C1). It is allocated only by startTerminal()
// at the first terminal event (stop, cancel, failure, drift or expiry); routine
// work never reads or starts it, and a later start never moves it.
function cleanupBoundary(budget,sample) {
  if(!budget||typeof budget.remaining!=='function'||typeof budget.clamp!=='function')fail('CLEANUP_UNCERTAIN');
  let end=null,realEnd=null,nonblocking=false,started=false;const busy=new Map();
  function revokeWait() {
    started=true;nonblocking=true;end=0;realEnd=0;
    // Admission clock loss must never disable the retained cleanup capability.
    // Zero is absolute, so even a later clock recovery cannot renew this end.
    try{budget.clamp(0);}catch{}
    return 0;
  }
  function startTerminal() {
    if(started)return remaining();
    started=true;
    const real=Number(process.hrtime.bigint()/1000000n);
    try{
      const now=sample()[1];
      const allowance=integer(typeof budget.startTerminal==='function'?budget.startTerminal():budget.remaining(),0);
      end=Math.min(now+Math.min(60000,allowance),integer(budget.deadline,0));
      realEnd=real+Math.max(0,end-now);
      return Math.max(0,Math.min(end-now,realEnd-real,allowance));
    }catch{return revokeWait();}
  }
  function remaining(delivered) {
    if(!started)fail('CLEANUP_NOT_STARTED');
    if(delivered!==undefined)integer(delivered,0);
    if(nonblocking)return 0;
    const real=Number(process.hrtime.bigint()/1000000n);
    try{
      const now=sample()[1];
      if(delivered!==undefined){budget.clamp(delivered);end=Math.min(end,delivered);}
      const allowance=integer(budget.remaining(),0);
      end=Math.min(end,integer(budget.deadline,0));
      realEnd=Math.min(realEnd,real+Math.max(0,end-now));
      return Math.max(0,Math.min(end-now,realEnd-real,allowance));
    }catch{return revokeWait();}
  }
  async function call(owner,fn,requested=60000) {
    startTerminal();
    if(busy.has(owner))fail('CLEANUP_UNCERTAIN');const ms=Math.min(integer(requested,0),remaining());
    let timer;const pending=Promise.resolve().then(()=>fn(ms));busy.set(owner,pending);
    pending.finally(()=>{if(busy.get(owner)===pending)busy.delete(owner);}).catch(()=>{});
    try {return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('CLEANUP_UNCERTAIN'),{code:'CLEANUP_UNCERTAIN'})),ms);})]);}
    finally{clearTimeout(timer);}
  }
  return {startTerminal,remaining,call,revokeWait,get deadline(){remaining();return end;}};
}
function browserApplicationPipe(runId,sendChunk,receiveChunk,isCurrent) {
  let outgoingStream=0,outgoingMessage=0,incomingStream=0,incomingMessage=0,writing=false,reading=false;
  const MAX_MESSAGE=16384,CHUNK=4096;
  function chunk(value) {
    exact(value,['streamSequence','messageSequence','chunkIndex','final','bytesHex']);
    integer(value.streamSequence);integer(value.messageSequence);integer(value.chunkIndex,0);
    if(typeof value.final!=='boolean'||typeof value.bytesHex!=='string'||value.bytesHex.length>CHUNK*2||
        value.bytesHex.length%2||!/^[0-9a-f]*$/.test(value.bytesHex))fail('FRAME_DENIED');
    return value;
  }
  const pipe={
    audit(){return immutable({version:1,kind:'TASK13_BROWSER_APPLICATION',runId,maxFrameBytes:MAX_MESSAGE});},
    async write(bytes){
      if(writing||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>MAX_MESSAGE)fail('FRAME_DENIED');
      writing=true;const messageSequence=++outgoingMessage;
      try{for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++){
        isCurrent();const payload={streamSequence:++outgoingStream,messageSequence,chunkIndex:index,
          final:offset+CHUNK>=bytes.length,bytesHex:bytes.subarray(offset,offset+CHUNK).toString('hex')};
        await sendChunk(payload);isCurrent();
      }}finally{writing=false;}
    },
    async read(){
      if(reading)fail('FRAME_DENIED');reading=true;let parts=[],size=0,index=0,messageSequence=incomingMessage+1;
      try{while(true){isCurrent();const value=chunk(await receiveChunk());isCurrent();
        if(value.streamSequence!==incomingStream+1||value.messageSequence!==messageSequence||value.chunkIndex!==index)fail('FRAME_DENIED');
        const bytes=Buffer.from(value.bytesHex,'hex');size+=bytes.length;if(size>MAX_MESSAGE)fail('FRAME_DENIED');
        incomingStream++;index++;parts.push(bytes);if(value.final){incomingMessage++;return Buffer.concat(parts,size);}
      }}finally{reading=false;}
    }};
  const handle=privateHandle(pipe);browserApplicationPipes.set(handle,{runId});adoptedRolePorts.add(handle);return handle;
}
function claimBrowserRequestEvidence(pipe,bytes,payload) {
  const state=browserApplicationPipes.get(pipe);
  if(!state||!Buffer.isBuffer(bytes)||!payload||typeof payload!=='object')fail('IDENTITY_MISMATCH');
  const frame=decode(bytes),keys=Reflect.ownKeys(frame).sort().join(',');
  // Only the Task 13 application frame form; the MAC'd form left with browser.cjs's MAC path (P28).
  if(keys!=='payload,runId,sequence,type,version'||
      frame.version!==1||frame.runId!==state.runId||frame.type!=='ROUTE'||canonical(frame.payload)!==canonical(payload))fail('IDENTITY_MISMATCH');
  exact(payload,['runId','requestId','sequence','method','url','headers','byteLength','schema']);
  if(payload.runId!==state.runId||typeof payload.requestId!=='string'||!integer(payload.sequence)||
      typeof payload.method!=='string'||typeof payload.url!=='string'||!Array.isArray(payload.headers)||
      // integer() throws on an invalid length; 0 (no body) is valid, so its result is not tested for truthiness.
      integer(payload.byteLength,0)<0||!['LOGIN_JSON','ABSENT'].includes(payload.schema))fail('IDENTITY_MISMATCH');
  const evidence=privateHandle({});browserRequestEvidence.set(evidence,immutable(JSON.parse(canonical(payload))));return evidence;
}
function inspectBrowserRequestEvidence(evidence) {
  const value=browserRequestEvidence.get(evidence);return value?immutable(JSON.parse(canonical(value))):null;
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
  let appTail=Promise.resolve();
  function appOperation(operation){const result=appTail.then(operation);appTail=result.catch(()=>{});return result;}
  function current(p) {wire.check();const [wall,mono]=sample();if(terminal||wall>=binding.expiresAtMs||(p&&(p.generation!==1||wall>=p.expiresAtMs||mono>=p.monotonicDeadlineMs)))fail('AUTHORITY_LOST');}
  async function responses() {
    if(reading)return;reading=true;
    try{while(pending.size){const f=await wire.receive();exact(f.payload,['requestSequence','result']);const slot=pending.get(f.payload.requestSequence);
      if(!slot||f.action!=='RESULT'||f.role!==slot.role)fail('FRAME_DENIED');pending.delete(f.payload.requestSequence);slot.resolve(f.payload.result);}}
    catch(e){terminal=true;if(e.code==='CHANNEL_EOF')cleanup.revokeWait();else cleanup.startTerminal();for(const slot of pending.values())slot.reject(e);pending.clear();}
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
    inspectGrant(g){const r=grants.get(g);if(!r)return null;current(r.proof);const [wall,mono]=sample();
      // P5: the remaining activation time is the earliest of the proof's guest
      // monotonic deadline, its wall expiry and the run binding's expiry.
      const remainingMs=Math.min(r.proof.monotonicDeadlineMs-mono,r.proof.expiresAtMs-wall,binding.expiresAtMs-wall);
      return {kind:'BROWSER',runId:binding.runId,child:r.child,purpose:'CONFINEMENT_PROVED',session:null,remainingMs};},
    async activate(child,p){const g=projectedGrants.get(p),r=g&&grants.get(g);if(!r||r.child!==child||r.used)fail('ACTIVATION_DENIED');r.used=true;current(r.proof);const result=await request('BROWSER','COMMIT_BROWSER',{grantId:r.grantId,generation:r.proof.generation});current(r.proof);exact(result,['status','generation']);if(result.status!=='ACTIVE'||result.generation!==1)fail('ACTIVATION_DENIED');r.active=true;},
    async stopOwned(child,ms){const r=[...local.values()].find(r=>r.child===child);if(!r)fail('EXIT_DENIED');return {...await stop(r.kind,ms),child};},
    async waitExit(child,ms){const r=[...local.values()].find(r=>r.child===child);if(!r)fail('EXIT_DENIED');return {...await stop(r.kind,ms,'WAIT_EXIT'),child};}};
  const bootstrap=bindRoleBootstrap(authority,binding.runId), adopted=new Map();
  const applicationPipe=browserApplicationPipe(binding.runId,
    payload=>appOperation(async()=>{const result=await request('BROWSER','APP_WRITE',payload);exact(result,['acceptedStreamSequence']);if(result.acceptedStreamSequence!==payload.streamSequence)fail('FRAME_DENIED');}),
    async()=>{while(true){const result=await appOperation(()=>request('BROWSER','APP_POLL',{}));
      if(result&&result.status==='EMPTY'&&Reflect.ownKeys(result).length===1){await new Promise(resolve=>setTimeout(resolve,0));continue;}
      exact(result,['status','chunk']);if(result.status!=='CHUNK')fail('FRAME_DENIED');return result.chunk;}},
    ()=>{current();const entry=adopted.get('BROWSER');if(!entry?.r.active)fail('AUTHORITY_LOST');});
  async function adopt(kind) {
    if(!Object.hasOwn(kinds,kind)||adopted.has(kind))fail('HANDOFF_DENIED');current();adopted.set(kind,null);
    const result=await request(kind,'ADOPT',{}),row=wire.saved.roles.find(r=>r.role===kind);
    exact(result,['kind','runId','uid','childId','pipeId','waiting','confined','attestationDigest']);hex(result.attestationDigest,DIGEST);
    if(result.kind!==kind||result.runId!==binding.runId||result.uid!==kinds[kind]||result.childId!==row.childId||result.pipeId!==row.pipeId||result.waiting!==true||result.confined!==true)fail('HANDOFF_DENIED');
    const handoff=privateHandle({}),r={kind,child:privateHandle({}),pipe:kind==='BROWSER'?applicationPipe:privateHandle({}),active:false};local.set(handoff,r);bootstrap.audit(handoff);const port=adoptRole(kind,handoff);adopted.set(kind,{port,r});return port;
  }
  return privateHandle({adopt,async prepareBrowser(value,browserConfig){
    try{if(prepared)fail('ACTIVATION_DENIED');prepared=true;const p=proofRecord(value);current(p);
      if(!adopted.has('BROWSER'))await adopt('BROWSER');const entry=adopted.get('BROWSER');if(!entry)fail('HANDOFF_DENIED');
      let payload=p;
      if(browserConfig!==undefined){if(!browserConfig||typeof browserConfig!=='object'||Array.isArray(browserConfig))fail('FRAME_DENIED');payload={...p,browserConfig:JSON.parse(canonical(browserConfig))};}
      const result=prepareResult(await request('BROWSER','PREPARE_BROWSER',payload));current(p);
      if(['proofDigest','generation','expiresAtMs','monotonicDeadlineMs'].some(k=>result[k]!==p[k]))fail('AUTHORITY_LOST');
      const grant=privateHandle({});Object.assign(entry.r,{proof:p,grantId:result.grantId,used:false});grants.set(grant,entry.r);
      const tx=new ControllerBrowserTransaction(entry.port,grant,ms=>stop('BROWSER',ms),CONTROLLER_TRANSACTION_SEAL);transactions.set(tx,entry.r);return tx;
    }catch(e){terminal=true;try{const receipt=await stop('BROWSER',cleanup.startTerminal());if(!['STOPPED','EXITED'].includes(receipt.status))fail('CLEANUP_UNCERTAIN');}catch{e.cleanup=privateHandle({stopOwned:ms=>stop('BROWSER',ms)});}throw e;}
  },async cancel(){terminal=true;cleanup.startTerminal();const result=await request('BROWSER','CANCEL',{generation:1,cleanupEndsAtMonotonicMs:cleanup.deadline},true);exact(result,['status','generation']);if(result.status!=='CANCELLED'||result.generation!==1)fail('FRAME_DENIED');return result;},stopOwned:ms=>stop('BROWSER',ms)});
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
      try{firstTerminalAt=sample()[1];cleanup.startTerminal();cleanup.remaining(firstTerminalAt+60000);}
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
  const applicationPipe=browserApplicationPipe(binding.runId,
    payload=>wire.write('BROWSER','APP_CHUNK',payload),
    async()=>{const frame=await wire.receive();if(frame.action!=='APP_CHUNK')fail('FRAME_DENIED');return frame.payload;},
    ()=>{if(!active||terminal)fail('AUTHORITY_LOST');wire.check();});
  return privateHandle({async prepare(record){
    try{if(preparing)fail('AUTHORITY_LOST');preparing=true;current();const f=wire.read(record);if(f.action!=='PREPARE')fail('FRAME_DENIED');const prepared=preparedPayload(f.payload),p=prepared.proof;current(p);
      const reservation=new WorkerLaunchReservation(WORKER_RESERVATION_SEAL),r={binding,proof:p,browserConfig:prepared.browserConfig,reservationId:randomBytes(16).toString('hex'),used:false,effect:false};reservations.set(reservation,r);
      originalReservation=r;
      await wire.write('BROWSER','PREPARED',{requestSequence:f.sequence,grantId:p.grantId,reservationId:r.reservationId,generation:1});drain();current(p);return reservation;
    }catch(e){return failed(e);}
  },inspectPreparedBrowserConfig(reservation){
    const r=reservations.get(reservation);if(!r||r.binding!==binding||r.used)fail('AUTHORITY_LOST');
    return r.browserConfig===null?null:immutable(JSON.parse(canonical(r.browserConfig)));
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
      return privateHandle({status:'STARTED',browserOwner:active,applicationPipe});
    }catch(e){return failed(e,requestSequence);}
  },async cancel(record){try{cancel(wire.read(record));await cleanup.call(wire,acknowledgeCancel);return await stop(cleanup.remaining());}catch(e){return failed(e);}},stopOwned:stop});
}
module.exports = Object.freeze({bindRoleBootstrap,adoptRole,inspectAdoptedRolePort,bindBootstrapComposition,bindBrowserWorkerChannel,claimBrowserRequestEvidence,inspectBrowserRequestEvidence,cleanupBoundary});
