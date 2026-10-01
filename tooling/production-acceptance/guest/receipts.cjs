'use strict';
const crypto = require('node:crypto');
const {decodeFrame,canonicalBytes,receiptSigningBytes} = require('./contracts.cjs');
const kinds = ['RELEASE_RECEIPT','RESTART_RECEIPT','LEDGER_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'];
const trusts = new WeakMap(), receipts = new WeakMap(), manifests = new WeakMap(), entries = new WeakMap();
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
function time(frame,state) {
  let now;try { now=state.now(); } catch { fail('EXPIRED'); }
  if(!safe(now)||state.lastNow!==null&&now<state.lastNow)fail('EXPIRED');state.lastNow=now;
  const p=frame.payload;if(now>=state.deadline||p.issuedAt<state.notBefore[frame.kind]||p.issuedAt>now||p.expiresAt<=now||p.expiresAt>state.deadline||now-p.issuedAt>state.maxAgeMs)fail('EXPIRED');
  if(frame.kind==='RESTART_RECEIPT'&&p.completedAt>now)fail('EXPIRED');return now;
}
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
function createReceiptAdapters(trust) {
  if(!trusts.has(trust))fail();return Object.freeze({
    verifyRelease:handle=>{const r=inspectReceipt(handle,'RELEASE_RECEIPT',trust);return r&&freeze({runId:r.runId,origins:r.origins,expiresAt:r.expiresAt,configIdentity:r.configIdentity,assetManifestDigest:r.assetManifestDigest});},
    verifyAssets:(assets,release)=>inspectReceipt(release,'RELEASE_RECEIPT',trust)&&inspectAssets(assets,release),
    verifyLedger:handle=>inspectReceipt(handle,'LEDGER_RECEIPT',trust),
    verifyGate:(kind,handle,binding)=>{const receiptKind={maintenance:'MAINTENANCE_RECEIPT',restart:'RESTART_RECEIPT'}[kind];if(!receiptKind)return false;const r=inspectReceipt(handle,receiptKind,trust);return !!(r&&binding&&r.runId===binding.runId&&r.configIdentity===binding.configIdentity&&safe(binding.wallMs)&&binding.wallMs>=r.issuedAt&&binding.wallMs<r.expiresAt&&safe(binding.expiresAt)&&binding.wallMs<binding.expiresAt);}
  });
}
module.exports={createTrustContext,verifyReceipt,inspectReceipt,verifyAssets,inspectAssets,validateAssetResponse,createReceiptAdapters};
