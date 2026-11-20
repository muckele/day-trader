'use strict';
const crypto = require('node:crypto');
const {decodeFrame,canonicalBytes,receiptSigningBytes} = require('./contracts.cjs');
const kinds = ['RELEASE_RECEIPT','RESTART_RECEIPT','LEDGER_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'];
const admissionGuards = new WeakMap(), browserBundles = new WeakMap(), browserConfigs = new WeakMap();
const trusts = new WeakMap(), receipts = new WeakMap(), manifests = new WeakMap(), entries = new WeakMap();
// Task 17 (P20): the WorkerGateHandle brand registry, the private release trust of each browser
// controller config, and the release trust each BrowserSession was opened under.
const workerGates = new WeakMap(), configReleases = new WeakMap(), sessionTrusts = new WeakMap();
const WORKER_GATE_KINDS = Object.freeze({ readiness: 'READINESS_GATE', owner: 'OWNER_GATE' });
const OBSERVE_PHASES = Object.freeze(['OBSERVE_BEFORE_RESTART', 'OBSERVE_AFTER_RESTART']);
let workerGateAuthorityClaimed = false;
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const safe = x => Number.isSafeInteger(x) && x >= 0;
function fail(code='IDENTITY_MISMATCH') { const e = new Error(code);e.code=code;throw e; }
function freeze(x) { if(x && typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x; }
function copy(x) { return JSON.parse(JSON.stringify(x)); }
function equal(a,b) { if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k])); }
function opaque(kind) { return Object.freeze(Object.defineProperty({kind},'toJSON',{value:()=>fail('PRIVACY_FAILED')})); }
function bindings(frame) { const f=copy(frame);for(const k of ['issuedAt','expiresAt','keyId','signature'])delete f.payload[k];return f; }
function predicates(frame,expected) {
  const p=frame.payload;
  if(frame.kind==='RESTART_RECEIPT') {
    if(p.sameConfig!==true||p.success!==true||p.action!=='backend-restart-only')fail();
    const ids=expected.RELEASE_RECEIPT.payload.expectedInstances;
    for(const rows of [p.preInstances,p.postInstances])if(rows.length!==ids.length||!ids.every(id=>rows.some(x=>x.id===id)))fail();
    for(const pre of p.preInstances){const post=p.postInstances.find(x=>x.id===pre.id);if(!post||post.startedAt<=pre.startedAt||post.startedAt>p.completedAt)fail();}
  }
  if(frame.kind==='MAINTENANCE_RECEIPT'||frame.kind==='DB_RECEIPT') {
    for(const value of Object.values(p))if(typeof value==='boolean'&&value!==true)fail('READINESS_FAILED');
    if(Object.values(p.comparisonScope).some(v=>v!==true))fail('READINESS_FAILED');
    if(p.allowedDeltas.ownerSessionGenerationIncrement!==(frame.kind==='DB_RECEIPT'&&p.interval==='LOGOUT'?1:0))fail();
    if(frame.kind==='DB_RECEIPT'&&!equal(p.observedDeltas,p.allowedDeltas))fail();
  }
  if(frame.kind==='LEDGER_RECEIPT'&&(p.canonicalAdapter!=='alpaca-paper'||p.PAPER.fullRunReserved!==14||p.stock.fullRunReserved!==0))fail('BUDGET_EXCEEDED');
}
// Configuration comes exclusively from the trusted caller, never from a candidate.
function createTrustContext(options) {
  try {
    if(!options||typeof options.now!=='function'||!safe(options.maxAgeMs)||options.maxAgeMs<1||!safe(options.deadline)||options.deadline<1)fail();
    const expected=copy(options.expected), keys=copy(options.publicKeys);
    const notBefore=options.notBefore===undefined?Object.fromEntries(kinds.map(k=>[k,0])):copy(options.notBefore);
    if(!equal(Object.keys(notBefore).sort(),[...kinds].sort())||Object.values(notBefore).some(t=>!safe(t)||t>=options.deadline))fail();
    if(!equal(Object.keys(expected).sort(),[...kinds].sort())||!equal(Object.keys(keys).sort(),[...kinds].sort()))fail();
    if(keys.RELEASE_RECEIPT!==keys.RESTART_RECEIPT)fail('SIGNATURE_INVALID');
    const publicKeys={};
    for(const kind of kinds) {
      if(!/^[0-9a-f]{64}$/.test(keys[kind]))fail('SIGNATURE_INVALID');
      const raw=Buffer.from(keys[kind],'hex');publicKeys[kind]=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
      const template=copy(expected[kind]);
      if(!template?.payload||['issuedAt','expiresAt','keyId','signature'].some(k=>Object.hasOwn(template.payload,k)))fail();
      Object.assign(template.payload,{issuedAt:0,expiresAt:1,keyId:hash(raw),signature:'0'.repeat(128)});
      const decoded=decodeFrame(Buffer.from(JSON.stringify(template)),kind);
      if(!equal(bindings(decoded),expected[kind]))fail();
    }
    const release=expected.RELEASE_RECEIPT;
    for(const kind of kinds)if(expected[kind].runId!==release.runId)fail();
    for(const kind of ['LEDGER_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'])if(expected[kind].payload.configIdentity!==release.payload.configIdentity)fail();
    const restart=expected.RESTART_RECEIPT.payload;
    for(const key of ['intendedApp','environment','backendRegistryDigest','backendPlatformDigest'])if(restart[key]!==release.payload[key])fail();
    if(expected.MAINTENANCE_RECEIPT.payload.identityComparisonId!==expected.DB_RECEIPT.payload.identityComparisonId)fail();
    const consumedNonces=options.consumedNonces??new Set(), consumedReceipts=options.consumedReceipts??new Set();
    if(!(consumedNonces instanceof Set)||!(consumedReceipts instanceof Set))fail();
    const handle=opaque('TRUST_CONTEXT');trusts.set(handle,{expected:freeze(expected),keys:freeze(keys),notBefore:freeze(notBefore),publicKeys,now:options.now,maxAgeMs:options.maxAgeMs,deadline:options.deadline,consumedNonces,consumedReceipts,lastNow:null});return handle;
  }catch(e){fail(e.code==='INVALID_FRAME'?'INVALID_FRAME':e.code==='SIGNATURE_INVALID'?'SIGNATURE_INVALID':'IDENTITY_MISMATCH');}
}
function sampleTime(state) {
  let now;try { now=state.now(); } catch { fail('EXPIRED'); }
  if(!safe(now)||state.lastNow!==null&&now<state.lastNow)fail('EXPIRED');state.lastNow=now;
  return now;
}
function timeAt(frame,state,now) {
  if(!safe(now)||state.lastNow!==null&&now<state.lastNow)fail('EXPIRED');
  const p=frame.payload;if(now>=state.deadline||p.issuedAt<state.notBefore[frame.kind]||p.issuedAt>now||p.expiresAt<=now||p.expiresAt>state.deadline||now-p.issuedAt>state.maxAgeMs)fail('EXPIRED');
  if(frame.kind==='RESTART_RECEIPT'&&p.completedAt>now)fail('EXPIRED');return now;
}
function time(frame,state) {return timeAt(frame,state,sampleTime(state));}
function validate(frame,state) {time(frame,state);if(!equal(bindings(frame),state.expected[frame.kind]))fail();predicates(frame,state.expected);}
function verifyReceipt(bytes,kind,trust) {
  const state=trusts.get(trust);if(!state||!kinds.includes(kind))fail();
  const frame=decodeFrame(bytes,kind), raw=Buffer.from(state.keys[kind],'hex');
  if(frame.payload.keyId!==hash(raw))fail('SIGNATURE_INVALID');
  if(!crypto.verify(null,receiptSigningBytes(frame),state.publicKeys[kind],Buffer.from(frame.payload.signature,'hex')))fail('SIGNATURE_INVALID');
  validate(frame,state);
  const replay=hash(receiptSigningBytes(frame));if(state.consumedReceipts.has(replay)||kind==='RESTART_RECEIPT'&&state.consumedNonces.has(frame.payload.nonce))fail('REPLAY');
  state.consumedReceipts.add(replay);if(kind==='RESTART_RECEIPT')state.consumedNonces.add(frame.payload.nonce);
  const handle=opaque(kind);receipts.set(handle,{frame,trust});return handle;
}
function inspectReceipt(handle,kind,trust) {
  try {const saved=receipts.get(handle),state=trusts.get(trust);if(!saved||saved.trust!==trust||!state||saved.frame.kind!==kind)return null;validate(saved.frame,state);
    const p=copy(saved.frame.payload);for(const k of ['signature','nonce','identityComparisonId','preInstances','postInstances'])delete p[k];
    if(kind==='RESTART_RECEIPT')p.configIdentity=state.expected.RELEASE_RECEIPT.payload.configIdentity;
    return freeze({kind,runId:saved.frame.runId,sequence:saved.frame.sequence,...p});
  }catch{return null;}
}
function verifyAssets(bytes,release) {
  const saved=receipts.get(release);if(!saved||!inspectReceipt(release,'RELEASE_RECEIPT',saved.trust))fail();
  const f=decodeFrame(bytes,'ASSET_MANIFEST'),digest=hash(canonicalBytes(f));
  if(f.runId!==saved.frame.runId||digest!==saved.frame.payload.assetManifestDigest)fail();
  if(f.payload.entries.some(e=>e.path.endsWith('.map')||e.path==='/static/js/acceptance-missing.js'||['/','/login','/robo','/portfolio','/activity'].includes(e.path)||e.path.includes('//')||e.path.includes('/../')||e.path.includes('/./')))fail();
  const list=f.payload.entries.map(e=>{const entry=freeze({...e});entries.set(entry,{release});return entry;});
  const handle=Object.freeze(Object.defineProperty({kind:'ASSET_MANIFEST',entries:Object.freeze(list)},'toJSON',{value:()=>fail('PRIVACY_FAILED')}));manifests.set(handle,{release,runId:f.runId,digest});return handle;
}
function inspectAssets(handle,release) {const m=manifests.get(handle),r=receipts.get(release);if(!m||m.release!==release||!r||!inspectReceipt(release,'RELEASE_RECEIPT',r.trust))return null;return freeze({runId:m.runId,digest:m.digest,entries:handle.entries});}
function validateAssetResponse(entry,body,contentType) {
  const e=entries.get(entry),r=e&&receipts.get(e.release);if(!e||!r||!inspectReceipt(e.release,'RELEASE_RECEIPT',r.trust)||!Buffer.isBuffer(body))fail('OBSERVATION_FAILED');
  if(body.length!==entry.size||hash(body)!==entry.hash||contentType!==entry.mime)fail('OBSERVATION_FAILED');
  return freeze({entryId:'frontend-asset:'+entry.path,hash:entry.hash,sizeMatch:true,hashMatch:true,mimeMatch:true});
}
function createBrowserAssetBundle(release,assets,trust,releaseBytes,assetBytes) {
  const saved=receipts.get(release),state=trusts.get(trust),manifest=manifests.get(assets);
  if(!saved||saved.trust!==trust||!state||saved.frame.kind!=='RELEASE_RECEIPT'||!manifest||manifest.release!==release||
      !Buffer.isBuffer(releaseBytes)||!Buffer.isBuffer(assetBytes))fail();
  const releaseFrame=decodeFrame(releaseBytes,'RELEASE_RECEIPT'),assetFrame=decodeFrame(assetBytes,'ASSET_MANIFEST');
  if(!equal(releaseFrame,saved.frame)||hash(canonicalBytes(assetFrame))!==manifest.digest||assetFrame.runId!==saved.frame.runId||
      !equal(assetFrame.payload.entries,assets.entries))fail();
  const bundle=freeze({version:1,verifiedAt:sampleTime(state),releaseReceiptHex:releaseBytes.toString('hex'),assetManifestHex:assetBytes.toString('hex'),
    releasePublicKeyHex:state.keys.RELEASE_RECEIPT,maxAgeMs:state.maxAgeMs,deadline:state.deadline});
  browserBundles.set(bundle,{release,assets,trust});return bundle;
}
function importBrowserAssetBundle(candidate,now) {
  try {
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||Reflect.ownKeys(candidate).length!==7||
        !['version','verifiedAt','releaseReceiptHex','assetManifestHex','releasePublicKeyHex','maxAgeMs','deadline'].every(k=>Object.hasOwn(candidate,k))||candidate.version!==1||
        !safe(candidate.verifiedAt)||typeof candidate.releaseReceiptHex!=='string'||typeof candidate.assetManifestHex!=='string'||
        !/^[0-9a-f]{64}$/.test(candidate.releasePublicKeyHex)||!safe(candidate.maxAgeMs)||candidate.maxAgeMs<1||!safe(candidate.deadline)||candidate.deadline<1||
        now!==undefined&&typeof now!=='function')fail();
    const releaseFrame=decodeFrame(Buffer.from(candidate.releaseReceiptHex,'hex'),'RELEASE_RECEIPT'),raw=Buffer.from(candidate.releasePublicKeyHex,'hex');
    if(releaseFrame.payload.keyId!==hash(raw)||!crypto.verify(null,receiptSigningBytes(releaseFrame),crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'}),Buffer.from(releaseFrame.payload.signature,'hex')))fail('SIGNATURE_INVALID');
    const trust=opaque('TRUST_CONTEXT'),state={expected:{RELEASE_RECEIPT:freeze(bindings(releaseFrame))},keys:{RELEASE_RECEIPT:candidate.releasePublicKeyHex},
      notBefore:{RELEASE_RECEIPT:0},publicKeys:{RELEASE_RECEIPT:crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'})},
      now:now??(()=>candidate.verifiedAt),maxAgeMs:candidate.maxAgeMs,deadline:candidate.deadline,consumedNonces:new Set(),consumedReceipts:new Set(),lastNow:null};
    trusts.set(trust,state);validate(releaseFrame,state);state.consumedReceipts.add(hash(receiptSigningBytes(releaseFrame)));
    const release=opaque('RELEASE_RECEIPT');receipts.set(release,{frame:releaseFrame,trust});
    const assets=verifyAssets(Buffer.from(candidate.assetManifestHex,'hex'),release);
    return Object.freeze({trust,release,assets});
  } catch(error) { fail(error?.code); }
}
function createBrowserControllerConfig(release,assets,trust,bundle,candidate,compositionBinding) {
  const r=inspectReceipt(release,'RELEASE_RECEIPT',trust),a=inspectAssets(assets,release),saved=browserBundles.get(bundle);
  if(!r||!a||!saved||saved.release!==release||saved.assets!==assets||saved.trust!==trust||!candidate||
      typeof candidate!=='object'||Array.isArray(candidate)||Reflect.ownKeys(candidate).length!==2||
      !Object.hasOwn(candidate,'runtime')||!Object.hasOwn(candidate,'paths')||!compositionBinding||typeof compositionBinding!=='object'||
      Array.isArray(compositionBinding)||Reflect.ownKeys(compositionBinding).sort().join(',')!=='configIdentity,epoch,expiresAtMs,manifestDigest,rolePolicyDigest,runId,version'||
      compositionBinding.version!==1||compositionBinding.runId!==r.runId||compositionBinding.configIdentity!==r.configIdentity||
      compositionBinding.expiresAtMs!==r.expiresAt||!/^[0-9a-f]{64}$/.test(compositionBinding.manifestDigest)||
      !/^[0-9a-f]{64}$/.test(compositionBinding.rolePolicyDigest)||!Number.isSafeInteger(compositionBinding.epoch)||compositionBinding.epoch<1)fail();
  const value=freeze({runBinding:{runId:r.runId,manifestIdentity:compositionBinding.manifestDigest,configIdentity:r.configIdentity,
      expiresAt:compositionBinding.expiresAtMs,origins:copy(r.origins)},runtime:copy(candidate.runtime),paths:copy(candidate.paths),
    assetEntries:copy(a.entries),assetBundle:copy(bundle)});
  const handle=opaque('BROWSER_CONFIG');browserConfigs.set(handle,value);
  // T13 m-9: the config privately keeps the release trust it was made under; it never leaves this module.
  configReleases.set(handle,{trust,release});return handle;
}
function inspectBrowserControllerConfig(handle) {
  const value=browserConfigs.get(handle);if(!value)fail();return value;
}
// This guard is only for the real budget/policy composition. Its receipt frames,
// original trusts and asset/release binding never leave the private module maps.
function createAdmissionReceiptGuard(ledger,trust,release,assets,maintenance,restart=null) {
  const manifest=manifests.get(assets);
  if(!manifest||manifest.release!==release)fail();
  const candidates=[[ledger,'LEDGER_RECEIPT'],[release,'RELEASE_RECEIPT'],[maintenance,'MAINTENANCE_RECEIPT']];
  if(restart!==null)candidates.push([restart,'RESTART_RECEIPT']);
  const records=candidates.map(([handle,kind])=>{
    const saved=receipts.get(handle),state=saved&&trusts.get(saved.trust);
    if(!saved||!state||saved.frame.kind!==kind||kind==='LEDGER_RECEIPT'&&saved.trust!==trust)fail();
    if(!equal(bindings(saved.frame),state.expected[kind]))fail();predicates(saved.frame,state.expected);
    return {frame:saved.frame,state};
  });
  const runId=records[0].frame.runId,config=records[0].frame.payload.configIdentity;
  if(records.some(r=>r.frame.runId!==runId||(r.frame.kind==='RESTART_RECEIPT'?r.state.expected.RELEASE_RECEIPT.payload.configIdentity:r.frame.payload.configIdentity)!==config))fail();
  if(manifest.runId!==runId||manifest.digest!==records[1].frame.payload.assetManifestDigest)fail();
  const guard=opaque('ADMISSION_RECEIPT_GUARD');
  admissionGuards.set(guard,{records,sampled:false,used:false});return guard;
}
function sampleAdmissionReceiptGuard(guard) {
  const saved=admissionGuards.get(guard);if(!saved||saved.sampled||saved.used)fail('REPLAY');
  saved.sampled=true;
  // One bounded pass: ledger first, then each distinct policy receipt trust.
  const states=[...new Set(saved.records.map(r=>r.state))];
  try {saved.wallMs=Math.max(...states.map(sampleTime));return saved.wallMs;}
  catch(error) {saved.used=true;throw error;}
}
function validateAdmissionReceiptGuard(guard,wallMs) {
  const saved=admissionGuards.get(guard);if(!saved||!saved.sampled||saved.used)fail('REPLAY');
  saved.used=true;
  if(!safe(wallMs)||wallMs<saved.wallMs)fail('EXPIRED');
  // No clock or verifier callback here. Include all later known samples made by
  // policy capabilities, and reject instead of dropping a later observed time.
  for(const {frame,state} of saved.records)timeAt(frame,state,wallMs);
}
// T13 m-9: a trust context is bound to a session's release trust when it is that context, or a
// context (such as the independently selected post-restart one) for the same expected release
// under the same pinned public keys.
function releaseBound(candidate,release) {
  const a=trusts.get(candidate),b=trusts.get(release);
  return !!(a&&b&&(candidate===release||equal(a.expected.RELEASE_RECEIPT,b.expected.RELEASE_RECEIPT)&&equal(a.keys,b.keys)));
}
// T13 m-9: receipts read for a BrowserSession are inspected under the trust they were verified
// under, which must be one context for all of them, release-bound to the session's private
// release trust. No caller supplies the trust.
function inspectSessionReceipts(session,pairs) {
  try {
    const bound=sessionTrusts.get(session);if(!bound||!Array.isArray(pairs)||pairs.length<1)return null;
    const saved=pairs.map(pair=>Array.isArray(pair)&&pair.length===2?receipts.get(pair[0]):undefined);
    if(saved.some(item=>!item||item.trust!==saved[0].trust)||!releaseBound(saved[0].trust,bound.trust))return null;
    const values=pairs.map(([handle,kind])=>inspectReceipt(handle,kind,saved[0].trust));
    return values.every(Boolean)?Object.freeze(values):null;
  } catch { return null; }
}
// T13 I-4/I-5 (P20): browser.cjs claims the WorkerGateHandle minting authority once, at load; no
// later caller can claim it, so no gate can be minted from a literal. A session is bound to the
// release trust of the config it was opened with; a gate names its session, phase and sequence.
function claimWorkerGateAuthority() {
  if(workerGateAuthorityClaimed)fail('REPLAY');
  workerGateAuthorityClaimed=true;
  return Object.freeze({
    bindSession(session,config) {
      const bound=configReleases.get(config);
      if(!bound||!session||typeof session!=='object'||sessionTrusts.has(session))fail();
      sessionTrusts.set(session,bound);
    },
    mint(kind,facts) {
      if(!Object.hasOwn(WORKER_GATE_KINDS,kind)||!facts||typeof facts!=='object'||!sessionTrusts.has(facts.session)||
          typeof facts.runId!=='string'||!/^[0-9a-f]{32}$/.test(facts.runId)||typeof facts.configIdentity!=='string'||!/^[0-9a-f]{64}$/.test(facts.configIdentity)||
          !OBSERVE_PHASES.includes(facts.phase)||!safe(facts.sequence)||facts.sequence<1||typeof facts.digest!=='string'||!/^[0-9a-f]{64}$/.test(facts.digest)||
          !safe(facts.checkedAtMonotonicMs))fail();
      const handle=opaque(WORKER_GATE_KINDS[kind]);
      workerGates.set(handle,{kind,session:facts.session,runId:facts.runId,configIdentity:facts.configIdentity,phase:facts.phase,
        sequence:facts.sequence,digest:facts.digest,checkedAtMonotonicMs:facts.checkedAtMonotonicMs,retired:false});
      return handle;
    },
    retire(handle) { const gate=workerGates.get(handle);if(!gate)fail();gate.retired=true; },
  });
}
function inspectWorkerGate(handle,session) {
  const gate=workerGates.get(handle);if(!gate||gate.session!==session)return null;
  return Object.freeze({kind:gate.kind,runId:gate.runId,configIdentity:gate.configIdentity,phase:gate.phase,sequence:gate.sequence,
    digest:gate.digest,checkedAtMonotonicMs:gate.checkedAtMonotonicMs,current:gate.retired===false});
}
// The readiness and owner kinds: only a current WorkerGateHandle of that kind, minted for the
// binding's BrowserSession (checked with the injected brand) and phase, of the binding's run and
// config, under adapters whose trust is release-bound to that session's release trust.
function workerGateCurrent(kind,handle,binding,trust,isBrowserSession) {
  try {
    const gate=workerGates.get(handle),bound=gate&&sessionTrusts.get(gate.session);
    return !!(gate&&bound&&gate.kind===kind&&gate.retired===false&&typeof isBrowserSession==='function'&&binding&&typeof binding==='object'&&
      isBrowserSession(binding.sessionHandle)===true&&gate.session===binding.sessionHandle&&gate.phase===binding.phase&&
      gate.runId===binding.runId&&gate.configIdentity===binding.configIdentity&&releaseBound(trust,bound.trust)&&
      safe(binding.wallMs)&&safe(binding.expiresAt)&&binding.wallMs<binding.expiresAt);
  } catch { return false; }
}
// P20: verifyGate keeps its three arguments for every kind. The BrowserSession brand is injected
// (browser.cjs's isBrowserSession), never required here: browser.cjs already requires this module.
function createReceiptAdapters(trust,isBrowserSession) {
  if(!trusts.has(trust)||isBrowserSession!==undefined&&typeof isBrowserSession!=='function')fail();return Object.freeze({
    verifyRelease:handle=>{const r=inspectReceipt(handle,'RELEASE_RECEIPT',trust);return r&&freeze({runId:r.runId,origins:r.origins,expiresAt:r.expiresAt,configIdentity:r.configIdentity,assetManifestDigest:r.assetManifestDigest});},
    verifyAssets:(assets,release)=>inspectReceipt(release,'RELEASE_RECEIPT',trust)&&inspectAssets(assets,release),
    verifyLedger:handle=>inspectReceipt(handle,'LEDGER_RECEIPT',trust),
    verifyGate:(kind,handle,binding)=>{if(kind==='readiness'||kind==='owner')return workerGateCurrent(kind,handle,binding,trust,isBrowserSession);const receiptKind={maintenance:'MAINTENANCE_RECEIPT',restart:'RESTART_RECEIPT'}[kind];if(!receiptKind)return false;const r=inspectReceipt(handle,receiptKind,trust);return !!(r&&binding&&r.runId===binding.runId&&r.configIdentity===binding.configIdentity&&safe(binding.wallMs)&&binding.wallMs>=r.issuedAt&&binding.wallMs<r.expiresAt&&safe(binding.expiresAt)&&binding.wallMs<binding.expiresAt);}
  });
}
module.exports={createAdmissionReceiptGuard,sampleAdmissionReceiptGuard,validateAdmissionReceiptGuard,createTrustContext,verifyReceipt,inspectReceipt,verifyAssets,inspectAssets,validateAssetResponse,createBrowserAssetBundle,importBrowserAssetBundle,createBrowserControllerConfig,inspectBrowserControllerConfig,createReceiptAdapters,
  claimWorkerGateAuthority,inspectWorkerGate,inspectSessionReceipts};
