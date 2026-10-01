'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('../../guest/contracts.cjs');
const api = require('../../guest/receipts.cjs');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts/vectors.json')));
const kinds = ['RELEASE_RECEIPT','RESTART_RECEIPT','LEDGER_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'];
const clone = x => JSON.parse(JSON.stringify(x));
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const pair = crypto.generateKeyPairSync('ed25519');
const wrongPair = crypto.generateKeyPairSync('ed25519');
const rawKey = pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
const keyId = hash(rawKey);
const zero = '0'.repeat(128);
function signingBytes(frame) {
  const f = clone(frame); f.payload.signature = zero;
  const validated=contracts.decodeFrame(Buffer.from(JSON.stringify(f)), f.kind); const unsigned=clone(validated);delete unsigned.payload.signature;
  const encode=x=>Array.isArray(x)?'['+x.map(encode).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+encode(x[k])).join(',')+'}':JSON.stringify(x);
  return Buffer.concat([Buffer.from(`acceptance:v1:${f.kind}\0`),Buffer.from(encode(unsigned))]);
}
function sign(frame, signer=pair.privateKey) { const f=clone(frame); f.payload.signature=crypto.sign(null,signingBytes(f),signer).toString('hex');return f; }
const assetBody=Buffer.from('synthetic application bytes');
const assetFrame=JSON.parse(vectors.accepted.find(v=>v.name==='asset_manifest').json);
assetFrame.payload.entries=[{path:'/static/app.js',hash:hash(assetBody),size:assetBody.length,mime:'application/javascript'}];
const assetBytes=contracts.canonicalBytes(contracts.decodeFrame(Buffer.from(JSON.stringify(assetFrame)),'ASSET_MANIFEST'));
const frames=Object.fromEntries(kinds.map(k=>[k,JSON.parse(vectors.accepted.find(v=>v.kind===k).json)]));
for(const f of Object.values(frames)){ f.payload.keyId=keyId; }
frames.RELEASE_RECEIPT.payload.assetManifestDigest=hash(assetBytes);
// These templates are the test authority's independent configuration, pinned before candidates exist.
const expected=clone(frames);
for(const f of Object.values(expected))for(const k of ['issuedAt','expiresAt','keyId','signature'])delete f.payload[k];
const options = {publicKeys:Object.fromEntries(kinds.map(k=>[k,rawKey.toString('hex')])),expected,maxAgeMs:100,deadline:200};
function trust(now=160,override={}) { return api.createTrustContext({...clone(options),...override,now:()=>now}); }
function bytes(f){return Buffer.from(JSON.stringify(f));}
function verified(kind='RELEASE_RECEIPT',t=trust()){return api.verifyReceipt(bytes(sign(frames[kind])),kind,t);}
const negatives=[];
function bad(name,kind,mutate,{unsigned=false,clock=160,override}={}) {
  const f=clone(frames[kind]);mutate(f); let candidate;
  try{candidate=bytes(unsigned?f:sign(f));}catch{candidate=bytes(f);}
  negatives.push({name,kind,json:candidate.toString(),clock,override});
}
for(const kind of kinds){
  bad('bad_signature_'+kind,kind,f=>{f.payload.signature='1'.repeat(128);},{unsigned:true});
  const f=sign(frames[kind],wrongPair.privateKey);negatives.push({name:'wrong_signer_'+kind,kind,json:JSON.stringify(f),clock:160});
  bad('expired_'+kind,kind,f=>{f.payload.expiresAt=159;});
  bad('future_issuance_'+kind,kind,f=>{f.payload.issuedAt=161;});
  bad('stale_'+kind,kind,f=>{f.payload.issuedAt=1;});
  bad('wrong_run_'+kind,kind,f=>{f.runId='3'.repeat(32);});
  bad('wrong_sequence_'+kind,kind,f=>{f.sequence=2;});
  bad('key_in_receipt_cannot_replace_pinned_key_'+kind,kind,f=>{f.payload.keyId='b'.repeat(64);});
  bad('unknown_fields_'+kind,kind,f=>{f.payload.publicKey=rawKey.toString('hex');},{unsigned:true});
  const json=JSON.stringify(sign(frames[kind])).replace('"version":1','"version":1,"version":1');
  negatives.push({name:'duplicate_fields_'+kind,kind,json,clock:160});
  const cross=sign(frames[kind]);cross.payload.signature=crypto.sign(null,Buffer.concat([Buffer.from('acceptance:v1:OTHER\0'),signingBytes(cross).subarray(Buffer.byteLength(`acceptance:v1:${kind}\0`))]),pair.privateKey).toString('hex');
  negatives.push({name:'wrong_domain_'+kind,kind,json:JSON.stringify(cross),clock:160});
}
for(const field of Object.keys(expected.RELEASE_RECEIPT.payload))bad('release_binding_'+field,'RELEASE_RECEIPT',f=>{
 const p=f.payload;if(field==='origins')p.origins.FRONTEND='https://other.example.test';else if(field==='expectedInstances')p[field]=['other'];else p[field]=field==='environment'?'staging':field==='appSHA'?'c'.repeat(40):typeof p[field]==='string'&&p[field].length===64?'c'.repeat(64):'other';
});
for(const field of ['nonce','approvedOperationId','action','intendedApp','environment','backendRegistryDigest','backendPlatformDigest'])bad('restart_binding_'+field,'RESTART_RECEIPT',f=>{f.payload[field]=f.payload[field].length===64?'c'.repeat(64):'other';});
for(const field of ['sameConfig','success'])bad('restart_predicate_'+field,'RESTART_RECEIPT',f=>{f.payload[field]=false;});
bad('missing_instance','RESTART_RECEIPT',f=>{f.payload.postInstances=[{id:'other',startedAt:140}];});
bad('unchanged_start_time','RESTART_RECEIPT',f=>{f.payload.postInstances[0].startedAt=90;});
bad('future_completion','RESTART_RECEIPT',f=>{f.payload.completedAt=170;});
bad('completion_before_post_start','RESTART_RECEIPT',f=>{f.payload.completedAt=130;});
for(const kind of ['MAINTENANCE_RECEIPT','DB_RECEIPT']) {
 for(const [key,value]of Object.entries(frames[kind].payload))if(typeof value==='boolean')bad('predicate_'+kind+'_'+key,kind,f=>{f.payload[key]=false;});
 for(const field of ['authority','configIdentity','identityComparisonId'])bad('comparison_binding_'+kind+'_'+field,kind,f=>{f.payload[field]=field==='authority'?'other':'c'.repeat(64);});
 bad('comparison_incomplete_scope_'+kind,kind,f=>{delete f.payload.comparisonScope.orders;},{unsigned:true});
 bad('unapproved_delta_'+kind,kind,f=>{f.payload.allowedDeltas.startupBookkeeping=1;});
}
bad('db_observed_delta','DB_RECEIPT',f=>{f.payload.observedDeltas.ownerSessionGenerationIncrement=1;});
bad('db_wrong_interval','DB_RECEIPT',f=>{f.payload.interval='AFTER';});
bad('ledger_inconsistent_remaining','LEDGER_RECEIPT',f=>{f.payload.PAPER.remaining=4;});
bad('ledger_wrong_authority','LEDGER_RECEIPT',f=>{f.payload.authority='other';});
bad('ledger_wrong_config','LEDGER_RECEIPT',f=>{f.payload.configIdentity='c'.repeat(64);});
bad('ledger_insufficient_envelope','LEDGER_RECEIPT',f=>{f.payload.PAPER.fullRunReserved=13;f.payload.PAPER.remaining=4;});
bad('ledger_stock_envelope','LEDGER_RECEIPT',f=>{f.payload.stock.ceiling=1;f.payload.stock.fullRunReserved=1;});
for(const kind of kinds)test('valid_'+kind,()=>{const h=verified(kind);assert.equal(api.inspectReceipt(h,kind,trust()),null,'other trust cannot adopt a handle');const t=trust();assert.equal(api.inspectReceipt(verified(kind,t),kind,t).kind,kind);});
for(const v of negatives)test(v.name,()=>assert.throws(()=>api.verifyReceipt(Buffer.from(v.json),v.kind,trust(v.clock,v.override)),Error));
test('replay_denied_all_kinds_and_nonce_once',()=>{for(const kind of kinds){const t=trust();const f=bytes(sign(frames[kind]));api.verifyReceipt(f,kind,t);assert.throws(()=>api.verifyReceipt(f,kind,t),Error);}});
test('forged_copied_and_expired_handles_denied_at_later_use',()=>{let now=160;const t=api.createTrustContext({...clone(options),now:()=>now});const h=verified('RELEASE_RECEIPT',t);assert.equal(api.inspectReceipt({},'RELEASE_RECEIPT',t),null);assert.equal(api.inspectReceipt({...h},'RELEASE_RECEIPT',t),null);assert.throws(()=>JSON.stringify(h),Error);now=200;assert.equal(api.inspectReceipt(h,'RELEASE_RECEIPT',t),null);});
test('assets_are_bound_and_response_is_exact_private_proof',()=>{const t=trust(),r=verified('RELEASE_RECEIPT',t),a=api.verifyAssets(assetBytes,r);assert.equal(api.inspectAssets(a,r).digest,hash(assetBytes));assert.equal(api.inspectAssets({...a},r),null);const e=a.entries[0];const p=api.validateAssetResponse(e,assetBody,e.mime);assert.deepEqual(Object.keys(p).sort(),['entryId','hash','hashMatch','mimeMatch','sizeMatch'].sort());assert.equal(p.hashMatch,true);assert.throws(()=>api.validateAssetResponse({...e},assetBody,e.mime),Error);});
test('asset_bytes_size_mime_hash_mismatch_denied',()=>{const t=trust(),a=api.verifyAssets(assetBytes,verified('RELEASE_RECEIPT',t));const e=a.entries[0];for(const [body,mime]of [[Buffer.from('wrong'),e.mime],[Buffer.alloc(e.size),e.mime],[assetBody,'text/plain'],[null,e.mime]])assert.throws(()=>api.validateAssetResponse(e,body,mime),Error);});
test('missing_asset_manifest_or_response_unavailable_denied',()=>{const t=trust(),r=verified('RELEASE_RECEIPT',t);assert.throws(()=>api.verifyAssets(null,r),Error);const f=clone(assetFrame);f.payload.entries=[];assert.throws(()=>api.verifyAssets(bytes(f),r),Error);assert.throws(()=>api.verifyAssets(assetBytes,{...r}),Error);});
test('asset_release_expiry_and_binding_revalidated',()=>{let now=160;const t=api.createTrustContext({...clone(options),now:()=>now}),r=verified('RELEASE_RECEIPT',t),a=api.verifyAssets(assetBytes,r);now=200;assert.equal(api.inspectAssets(a,r),null);assert.throws(()=>api.validateAssetResponse(a.entries[0],assetBody,a.entries[0].mime),Error);});
test('task2_adapters_use_real_nominal_receipts_and_exact_bindings',()=>{const t=trust(),ad=api.createReceiptAdapters(t),r=verified('RELEASE_RECEIPT',t),a=api.verifyAssets(assetBytes,r),m=verified('MAINTENANCE_RECEIPT',t),restart=verified('RESTART_RECEIPT',t);assert.equal(ad.verifyRelease(r).runId,frames.RELEASE_RECEIPT.runId);assert.equal(ad.verifyAssets(a,r).digest,hash(assetBytes));const b={runId:frames.RELEASE_RECEIPT.runId,configIdentity:frames.RELEASE_RECEIPT.payload.configIdentity,wallMs:160,expiresAt:200};assert.equal(ad.verifyGate('maintenance',m,b),true);assert.equal(ad.verifyGate('restart',restart,b),true);assert.equal(ad.verifyGate('maintenance',{...m},b),false);assert.equal(ad.verifyGate('maintenance',m,{...b,configIdentity:'c'.repeat(64)}),false);assert.equal(ad.verifyGate('readiness',{},b),false);});
test('restart_cannot_pin_a_different_key_even_if_evidence_authority_trusts_it',()=>{
 const keys=clone(options.publicKeys);keys.RESTART_RECEIPT=wrongPair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');keys.DB_RECEIPT=keys.RESTART_RECEIPT;
 assert.throws(()=>trust(160,{publicKeys:keys}),Error);
});
test('semantic_predicates_required_even_if_independent_expected_values_are_false',()=>{
 for(const kind of ['RESTART_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'])for(const [field,value]of Object.entries(frames[kind].payload))if(typeof value==='boolean'){
  const exp=clone(expected),candidate=clone(frames[kind]);exp[kind].payload[field]=false;candidate.payload[field]=false;
  const t=trust(160,{expected:exp});assert.throws(()=>api.verifyReceipt(bytes(sign(candidate)),kind,t),Error,kind+':'+field);
 }
});
test('nonce_replay_across_distinct_valid_signed_bytes_and_shared_contexts_denied',()=>{
 const consumedNonces=new Set(),consumedReceipts=new Set(),first=trust(160,{consumedNonces,consumedReceipts});verified('RESTART_RECEIPT',first);
 const candidate=clone(frames.RESTART_RECEIPT);candidate.payload.issuedAt=101;
 assert.throws(()=>api.verifyReceipt(bytes(sign(candidate)),'RESTART_RECEIPT',trust(160,{consumedNonces,consumedReceipts})),{code:'REPLAY'});
 assert.equal(consumedNonces.size,1);assert.equal(consumedReceipts.size,1);
});
test('complete_multi_instance_restart_coverage_and_all_start_times_required',()=>{
 const exp=clone(expected),candidate=clone(frames.RESTART_RECEIPT);exp.RELEASE_RECEIPT.payload.expectedInstances=['fixture','second'];candidate.payload.preInstances.push({id:'second',startedAt:80});candidate.payload.postInstances.push({id:'second',startedAt:145});exp.RESTART_RECEIPT=bindingsForTest(candidate);
 const t=trust(160,{expected:exp});assert.equal(api.inspectReceipt(api.verifyReceipt(bytes(sign(candidate)),'RESTART_RECEIPT',t),'RESTART_RECEIPT',t).kind,'RESTART_RECEIPT');
 candidate.payload.postInstances.pop();assert.throws(()=>api.verifyReceipt(bytes(sign(candidate)),'RESTART_RECEIPT',trust(160,{expected:exp})),Error);
});
function bindingsForTest(f){const result=clone(f);for(const k of ['issuedAt','expiresAt','keyId','signature'])delete result.payload[k];return result;}
test('trust_pins_are_snapshotted_not_mutated_by_caller_and_clock_rollback_denied',()=>{
 let now=160;const config={...clone(options),now:()=>now},t=api.createTrustContext(config),r=verified('RELEASE_RECEIPT',t);config.expected.RELEASE_RECEIPT.payload.configIdentity='c'.repeat(64);assert.ok(api.inspectReceipt(r,'RELEASE_RECEIPT',t));now=159;assert.equal(api.inspectReceipt(r,'RELEASE_RECEIPT',t),null);
});
test('canonical_signature_bytes_are_fixed_full_envelopes_and_not_arbitrary_objects',()=>{
 const hashes=['531a9ee685524c8aa10f6ba99366687c01f6ad58c3f3f7c861ac3975508bc262','6acfbd00b53e5d5629054e47b026a76e7e9cfc3689dc56c8a434183536ed0cfd','606479840f537bb81e5577c06387ddd32ffd53d46f7acfd3cf06ae1bf2e031d9','f0a3ed4e7431f17360ed4a739b9ee417e18e4ddbfd017190475814593a71193e','2b90177772eb4ecf6f1501b63e6ca1d17f98d7e93f53bbda7b72fbbc704009e2'];
 kinds.forEach((kind,i)=>{const f=contracts.decodeFrame(Buffer.from(vectors.accepted.find(v=>v.kind===kind).json),kind),b=contracts.receiptSigningBytes(f);assert.equal(hash(b),hashes[i]);assert.deepEqual(b,signingBytes(f));});
 assert.throws(()=>contracts.receiptSigningBytes(frames.RELEASE_RECEIPT),Error);assert.throws(()=>contracts.receiptSigningBytes(contracts.decodeFrame(assetBytes,'ASSET_MANIFEST')),Error);
});
test('private_clock_errors_are_normalized_to_fixed_receipt_failure',()=>{
 const t=api.createTrustContext({...clone(options),now:()=>{throw new Error('private owner data');}});
 assert.throws(()=>verified('RELEASE_RECEIPT',t),e=>['EXPIRED','INTERNAL_FAILURE'].includes(e.code)&&e.message===e.code);
});
test('receipt_kind_confusion_and_untrusted_ledger_initialization_denied',()=>{
 for(let i=0;i<kinds.length;i++)assert.throws(()=>api.verifyReceipt(bytes(sign(frames[kinds[i]])),kinds[(i+1)%kinds.length],trust()),{code:'INVALID_FRAME'});
 const t=trust(),ad=api.createReceiptAdapters(t),ledger=verified('LEDGER_RECEIPT',t);assert.equal(ad.verifyLedger(ledger).PAPER.fullRunReserved,14);assert.equal(ad.verifyLedger({...ledger}),null);assert.equal(ad.verifyLedger({kind:'LEDGER_RECEIPT',PAPER:frames.LEDGER_RECEIPT.payload.PAPER}),null);
});
const postOptions=clone(options);postOptions.expected.MAINTENANCE_RECEIPT.sequence=2;postOptions.notBefore=Object.fromEntries(kinds.map(k=>[k,k==='MAINTENANCE_RECEIPT'?150:0]));
const postMaintenance=clone(frames.MAINTENANCE_RECEIPT);postMaintenance.sequence=2;postMaintenance.payload.issuedAt=151;
test('selected_postrestart_trust_rejects_unexpired_old_maintenance_and_requires_new_expected_sequence',()=>{
 const before=trust(),old=verified('MAINTENANCE_RECEIPT',before),binding={runId:frames.RELEASE_RECEIPT.runId,configIdentity:frames.RELEASE_RECEIPT.payload.configIdentity,wallMs:160,expiresAt:200,phase:'OBSERVE_AFTER_RESTART'};
 assert.equal(api.createReceiptAdapters(before).verifyGate('maintenance',old,binding),true,'still fresh in its own old context');
 const after=api.createTrustContext({...clone(postOptions),now:()=>160}),ad=api.createReceiptAdapters(after);
 assert.equal(ad.verifyGate('maintenance',old,binding),false,'postrestart independently selected trust rejects pre-restart handle');
 assert.throws(()=>api.verifyReceipt(bytes(sign(frames.MAINTENANCE_RECEIPT)),'MAINTENANCE_RECEIPT',after),{code:'EXPIRED'});
 const early=clone(postMaintenance);early.payload.issuedAt=149;assert.throws(()=>api.verifyReceipt(bytes(sign(early)),'MAINTENANCE_RECEIPT',after),{code:'EXPIRED'});
 const fresh=api.verifyReceipt(bytes(sign(postMaintenance)),'MAINTENANCE_RECEIPT',after);assert.equal(ad.verifyGate('maintenance',fresh,binding),true);
});
if(process.env.RECEIPT_EXCHANGE){fs.mkdirSync(process.env.RECEIPT_EXCHANGE,{recursive:true});fs.writeFileSync(path.join(process.env.RECEIPT_EXCHANGE,'node.json'),JSON.stringify({options,positive:kinds.map(kind=>({kind,json:JSON.stringify(sign(frames[kind])),signingBytes:signingBytes(frames[kind]).toString('hex')})),negative:negatives,asset:assetBytes.toString(),assetBody:assetBody.toString('hex'),postMaintenance:{options:postOptions,json:JSON.stringify(sign(postMaintenance)),earlyJSON:JSON.stringify(sign({...postMaintenance,payload:{...postMaintenance.payload,issuedAt:149}}))}}));}
if(process.env.RECEIPT_SWIFT_INPUT)test('actual_swift_generated_all_five_verified_node_and_tamper_domain_signer_denied',()=>{
 const produced=JSON.parse(fs.readFileSync(process.env.RECEIPT_SWIFT_INPUT));assert.equal(produced.positive.length,5);assert.equal(produced.negative.length,15);
 for(const row of produced.positive){const t=api.createTrustContext({...produced.options,now:()=>160}),buffer=Buffer.from(row.json);assert.equal(api.inspectReceipt(api.verifyReceipt(buffer,row.kind,t),row.kind,t).kind,row.kind);assert.equal(contracts.receiptSigningBytes(contracts.decodeFrame(buffer,row.kind)).toString('hex'),row.signingBytes);}
 for(const row of produced.negative)assert.throws(()=>api.verifyReceipt(Buffer.from(row.json),row.kind,api.createTrustContext({...produced.options,now:()=>160})),{code:'SIGNATURE_INVALID'});
});
