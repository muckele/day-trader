'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../../guest/role-ports.cjs');
const roles = fs.existsSync(modulePath) ? require(modulePath) : null;
const RUN = 'a'.repeat(32);
// Task 16c (P76): the bootstrap's clean answer to the controller's BROWSER family request.
function cleanFamily(point) { return { point, ordinal: point === 'POST_LOAD' ? 2 : 3, status: 'CLEAN', members: 5 }; }
test('v1_shared_budget_clamps_existing_activate_once_compensation',async()=>{
  const f=fixture();let allowance;
  f.authority.cleanupBudget={remaining:()=>37};
  f.authority.stopOwned=async(child,ms)=>{allowance=ms;return {status:'STOPPED',runId:RUN,child};};
  await assert.rejects(roles.adoptRole('BROWSER',f.handoff).activateOnce({}));
  assert.equal(allowance,37,'composed activation must retain the shared cleanup end');
});
test('v1_activate_once_preserves_worker_cleanup_cause_after_original_compensation',async()=>{
  const f=fixture(),workerCleanup=Object.freeze({stopOwned:async()=>({status:'TIMEOUT',runId:RUN})});
  const cause=Object.assign(new Error('CLEANUP_UNCERTAIN'),{code:'CLEANUP_UNCERTAIN',cleanup:workerCleanup});
  f.authority.cleanupBudget={remaining:()=>0};f.authority.activate=async()=>{throw cause;};
  let error;try{await roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant);}catch(e){error=e;}
  assert.equal(error.code,'ACTIVATION_DENIED');assert.equal(error.cause,cause);assert.equal(error.cause.cleanup,workerCleanup);assert.equal(f.stops(),1);
});
// Every double is an injected bootstrap/pipe boundary, never a role-port policy.
function fixture(kind = 'BROWSER', overrides = {}) {
  assert.ok(roles, 'Task 8 inherited role-port behavior is absent');
  const child = Object.freeze({}), pipe = Object.freeze({});
  const handoff = Object.freeze({}), grant = Object.freeze({});
  let activations = 0;
  let stops = 0;
  const received = [];
  const facts = { kind, runId: RUN, uid: kind === 'BROWSER' ? 10002 : 10003,
    child, privatePipe: pipe, waiting: true, confined: true, ...overrides };
  const authority = {
    inspectHandoff: h => h === handoff ? { ...facts } : null,
    inspectGrant: g => g === grant ? { kind, runId: RUN, child,
      purpose: kind === 'BROWSER' ? 'CONFINEMENT_PROVED' : 'PRIOR_SESSION', session: kind === 'VERIFIER' ? Object.freeze({}) : null,
      remainingMs: 60000 } : null,
    // T8-11: record exactly what reaches activate (a frozen projection, never the caller's object).
    activate: async (owned, value) => { assert.equal(owned, child); received.push(value); activations++; facts.waiting=false; },
    waitExit: async (owned, deadline) => ({ status: 'EXITED', runId: RUN, child: owned }),
    stopOwned: async (owned, deadline) => { stops++; return { status: 'STOPPED', runId: RUN, child: owned }; },
    // Task 16c (P14): the bootstrap's clean answer to a BROWSER family request.
    inspectFamily: async (owned, point) => cleanFamily(point),
  };
  const boundary = roles.bindRoleBootstrap(authority, RUN);
  boundary.audit(handoff);
  return { child, pipe, handoff, grant, facts, authority, boundary, received, count: () => activations, stops: () => stops };
}

// Breaks caught: accepting fabricated/cross-run handoffs, replayed grants,
// spawn options and foreign exit outcomes. Expectations are contract literals.
test('adopt_unaudited_handle_reject', () => {
  assert.ok(roles, 'Task 8 inherited role-port behavior is absent');
  assert.throws(() => roles.adoptRole('BROWSER', { audited: true, uid: 10002 }), /HANDOFF_DENIED/);
});
test('activation_second_consume_reject', async () => {
  const f = fixture(); const p = roles.adoptRole('BROWSER', f.handoff);
  await p.activateOnce(f.grant);
  await assert.rejects(p.activateOnce(f.grant), /ACTIVATION_DENIED/);
  assert.equal(f.count(), 1);
});
test('arbitrary_role_program_argv_fd_request_reject', async () => {
  for (const extra of [{ program: '/bin/sh' }, { argv: ['-c','echo'] }, { fd: 9 }, { uid: 0 }, { spawn: true }]) {
    // An identity authority: a copy carrying a request is not the grant, and nothing reaches activate.
    const f = fixture(); const p = roles.adoptRole('BROWSER', f.handoff);
    await assert.rejects(p.activateOnce({ ...f.grant, ...extra }), /ACTIVATION_DENIED/);
    assert.equal(f.count(), 0); assert.deepEqual(f.received, []);
    // T8-11 variant V1: an authority that recognises the copy structurally. Only a frozen projection of the
    // authority's own verified facts reaches activate; the requested program/argv/fd/uid/spawn never does.
    const g = fixture(); const q = roles.adoptRole('BROWSER', g.handoff), copy = { ...g.grant, ...extra };
    g.authority.inspectGrant = value => value === copy ? { kind: 'BROWSER', runId: RUN, child: g.child,
      purpose: 'CONFINEMENT_PROVED', session: null, remainingMs: 60000 } : null;
    await q.activateOnce(copy);
    assert.equal(g.count(), 1); assert.equal(g.received.length, 1);
    const value = g.received[0];
    assert.notEqual(value, copy); assert.ok(Object.isFrozen(value));
    assert.deepEqual(Reflect.ownKeys(value).sort(), ['child', 'kind', 'purpose', 'runId', 'session']);
    assert.equal(value.child, g.child); assert.equal(value.kind, 'BROWSER'); assert.equal(value.runId, RUN);
    assert.equal(value.purpose, 'CONFINEMENT_PROVED'); assert.equal(value.session, null);
    for (const key of Reflect.ownKeys(extra)) assert.equal(key in value, false, key);
  }
});
test('used_grant_replay_rejected', async () => {
  // J1: two original children under one authority that accepts the grant for whichever child it was last asked
  // about. Only the role ports' own used-grant record can refuse the replay on the second child.
  const grant = Object.freeze({}), children = [Object.freeze({}), Object.freeze({})], activated = [];
  const facts = children.map(child => ({ kind: 'BROWSER', runId: RUN, uid: 10002, child,
    privatePipe: Object.freeze({}), waiting: true, confined: true }));
  const handoffs = facts.map(() => Object.freeze({}));
  let asked = null;
  const authority = {
    inspectHandoff: h => { const i = handoffs.indexOf(h); if (i < 0) return null; asked = facts[i].child; return { ...facts[i] }; },
    inspectGrant: g => g === grant ? { kind: 'BROWSER', runId: RUN, child: asked, purpose: 'CONFINEMENT_PROVED',
      session: null, remainingMs: 60000 } : null,
    activate: async owned => { activated.push(owned); facts.find(x => x.child === owned).waiting = false; },
    waitExit: async owned => ({ status: 'EXITED', runId: RUN, child: owned }),
    stopOwned: async owned => ({ status: 'STOPPED', runId: RUN, child: owned }),
    inspectFamily: async (owned, point) => cleanFamily(point),
  };
  const boundary = roles.bindRoleBootstrap(authority, RUN);
  for (const handoff of handoffs) boundary.audit(handoff);
  const first = roles.adoptRole('BROWSER', handoffs[0]), second = roles.adoptRole('BROWSER', handoffs[1]);
  await first.activateOnce(grant);
  await assert.rejects(second.activateOnce(grant), /ACTIVATION_DENIED/);
  assert.equal(activated.length, 1); assert.equal(activated[0], children[0]);
});
test('activate_once_bounded_by_remaining_budget', async () => {
  // P5: an activation that never settles ends at the remaining activation time the authority reports. Only the
  // stop path that follows uses the shared cleanup budget, and a routine activation never starts it (C1).
  const f = fixture(); let allowance, starts = 0, reads = 0, guard;
  f.authority.inspectGrant = g => g === f.grant ? { kind: 'BROWSER', runId: RUN, child: f.child,
    purpose: 'CONFINEMENT_PROVED', session: null, remainingMs: 25 } : null;
  f.authority.activate = () => new Promise(() => {});
  f.authority.cleanupBudget = { remaining: () => { reads++; return 41; }, startTerminal: () => { starts++; return 41; } };
  f.authority.stopOwned = async (child, ms) => { allowance = ms; return { status: 'STOPPED', runId: RUN, child }; };
  const outcome = await Promise.race([
    roles.adoptRole('BROWSER', f.handoff).activateOnce(f.grant).then(() => 'activated', e => e.code),
    new Promise(resolve => { guard = setTimeout(() => resolve('unbounded'), 1000); })]);
  clearTimeout(guard);
  assert.equal(outcome, 'ACTIVATION_DENIED');
  assert.equal(allowance, 41); assert.ok(starts >= 1, 'only the stop path starts the shared end');
  for (const remainingMs of [undefined, 0, -1, 1.5, 2147483648, '25']) {
    const g = fixture();
    g.authority.inspectGrant = x => x === g.grant ? { kind: 'BROWSER', runId: RUN, child: g.child,
      purpose: 'CONFINEMENT_PROVED', session: null, ...(remainingMs === undefined ? {} : { remainingMs }) } : null;
    await assert.rejects(roles.adoptRole('BROWSER', g.handoff).activateOnce(g.grant), /ACTIVATION_DENIED/);
    assert.equal(g.count(), 0, String(remainingMs));
  }
  const h = fixture(); let hStarts = 0, hReads = 0;
  h.authority.cleanupBudget = { remaining: () => { hReads++; return 41; }, startTerminal: () => { hStarts++; return 41; } };
  await roles.adoptRole('BROWSER', h.handoff).activateOnce(h.grant);
  assert.equal(h.count(), 1); assert.equal(hStarts, 0); assert.equal(hReads, 0);
});
test('exit_handle_bound_to_run_and_owned_child', async () => {
  const f = fixture(); const p = roles.adoptRole('BROWSER', f.handoff); const h = await p.activateOnce(f.grant);
  assert.equal(h.privatePipe, f.pipe);
  assert.deepEqual(await h.waitExit(100), { status: 'EXITED', runId: RUN });
  assert.deepEqual(await h.stopOwned(100), { status: 'STOPPED', runId: RUN });
  assert.equal(f.count(), 1);
});
test('task13_private_application_pipe_keeps_original_identity_and_shared_cleanup_allowance', async () => {
  const f=fixture();let allowance;
  f.authority.cleanupBudget={remaining:()=>29};
  f.authority.stopOwned=async(child,deadline)=>{allowance=deadline;return {status:'STOPPED',runId:RUN,child};};
  const handle=await roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant);
  assert.equal(handle.privatePipe,f.pipe);
  assert.deepEqual(await handle.stopOwned(60000),{status:'STOPPED',runId:RUN});
  assert.equal(allowance,29);
});
test('cross_run_role_uid_or_child_attestation_reject', () => {
  for (const drift of [{runId:'b'.repeat(32)},{uid:0},{confined:false},{waiting:false},{kind:'PROXY'},{child:null},{privatePipe:null}]) {
    assert.throws(() => fixture('BROWSER',drift), /HANDOFF_DENIED/);
  }
});
test('handoff_copy_re_adoption_and_kind_confusion_reject', () => {
  const f=fixture();
  assert.throws(() => roles.adoptRole('BROWSER',{...f.handoff}),/HANDOFF_DENIED/);
  assert.throws(() => roles.adoptRole('VERIFIER',f.handoff),/HANDOFF_DENIED/);
  roles.adoptRole('BROWSER',f.handoff);
  assert.throws(() => roles.adoptRole('BROWSER',f.handoff),/HANDOFF_DENIED/);
});
test('verifier_requires_prior_session_one_use_grant', async () => {
  const f=fixture('VERIFIER');const p=roles.adoptRole('VERIFIER',f.handoff);
  assert.equal(p.kind,'VERIFIER');
  await p.activateOnce(f.grant);
  await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
  const g=fixture('VERIFIER');g.authority.inspectGrant=()=>({kind:'VERIFIER',runId:RUN,child:g.child,purpose:'CONFINEMENT_PROVED',session:null,remainingMs:60000});
  await assert.rejects(roles.adoptRole('VERIFIER',g.handoff).activateOnce(g.grant),/ACTIVATION_DENIED/);
});
test('invalid_grant_latches_before_any_await', async () => {
  const f=fixture(); const p=roles.adoptRole('BROWSER',f.handoff);
  await assert.rejects(p.activateOnce({}),/ACTIVATION_DENIED/);
  await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
  assert.equal(f.count(),0);
});
test('concurrent_activation_consumes_exactly_once', async () => {
  const f=fixture();const p=roles.adoptRole('BROWSER',f.handoff);
  const results=await Promise.allSettled([p.activateOnce(f.grant),p.activateOnce(f.grant)]);
  assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']); assert.equal(f.count(),1);
});
test('attestation_drift_before_or_during_activation_reject', async () => {
  const f=fixture();const p=roles.adoptRole('BROWSER',f.handoff);f.facts.uid=0;
  await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
  const g=fixture();const q=roles.adoptRole('BROWSER',g.handoff);
  g.authority.activate=async()=>{g.facts.runId='b'.repeat(32);};
  await assert.rejects(q.activateOnce(g.grant),/ACTIVATION_DENIED/);
});
test('foreign_or_malformed_exit_outcome_reject', async () => {
  for (const outcome of [{status:'EXITED',runId:'b'.repeat(32)},{status:'EXITED',runId:RUN,child:{}},{status:'OK',runId:RUN},{status:'EXITED',runId:RUN,secret:'forbidden'}]) {
    const f=fixture(); f.authority.waitExit=async()=>outcome;
    const h=await roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant);
    await assert.rejects(h.waitExit(100),/EXIT_DENIED/);
  }
});
test('fixed_handle_methods_require_bounded_deadline_and_no_extra_arguments', async () => {
  const f=fixture();const h=await roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant);
  for (const deadline of [0,-1,NaN,Infinity,true,1200001]) await assert.rejects(h.waitExit(deadline),/EXIT_DENIED/);
  await assert.rejects(h.stopOwned(100, {pid:1}),/EXIT_DENIED/);
  assert.throws(()=>JSON.stringify(h),/PRIVATE_HANDLE/);
});
test('duplicate_owned_child_or_pipe_handoff_reject', () => {
  const f=fixture();
  const other=Object.freeze({});
  f.authority.inspectHandoff=()=>({...f.facts});
  assert.throws(()=>f.boundary.audit(other),/HANDOFF_DENIED/);
  const g=fixture(); const third=Object.freeze({});
  g.authority.inspectHandoff=()=>({...g.facts,child:Object.freeze({})});
  assert.throws(()=>g.boundary.audit(third),/HANDOFF_DENIED/);
});
test('activation_requires_observed_transition_out_of_waiting', async () => {
  const f=fixture(); f.authority.activate=async()=>{};
  await assert.rejects(roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant),/ACTIVATION_DENIED/);
});
test('R2_owned_stop_survives_drift_and_terminal_wait_removes_live_facts',async()=>{
  const f=fixture();const h=await roles.adoptRole('BROWSER',f.handoff).activateOnce(f.grant);
  f.facts.confined=false;
  assert.deepEqual(await h.stopOwned(100),{status:'STOPPED',runId:RUN});
  assert.equal(f.stops(),1);
  const g=fixture();const q=await roles.adoptRole('BROWSER',g.handoff).activateOnce(g.grant);
  g.authority.waitExit=async owned=>{g.authority.inspectHandoff=()=>null;return {status:'EXITED',runId:RUN,child:owned};};
  assert.deepEqual(await q.waitExit(100),{status:'EXITED',runId:RUN});
});
test('R3_partial_activation_or_post_effect_drift_compensates_owned_stop',async()=>{
  for(const failure of ['throw','drift']){
    const f=fixture();const p=roles.adoptRole('BROWSER',f.handoff);
    f.authority.activate=async()=>{f.facts.waiting=false;f.facts.confined=false;if(failure==='throw')throw Error('partial effect');};
    await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
    assert.equal(f.stops(),1);
    await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
    assert.equal(f.stops(),1);
  }
});
test('R3_uncertain_compensation_exposes_only_original_owned_cleanup_handle',async()=>{
  const f=fixture();const p=roles.adoptRole('BROWSER',f.handoff);
  f.authority.activate=async()=>{throw Error('partial');};
  let calls=0;
  f.authority.stopOwned=async owned=>{assert.equal(owned,f.child);calls++;return {status:calls===1?'TIMEOUT':'STOPPED',runId:RUN,child:owned};};
  let failed;
  try{await p.activateOnce(f.grant);}catch(error){failed=error;}
  assert.equal(failed?.code,'CLEANUP_UNCERTAIN');
  assert.equal(typeof failed.cleanup?.stopOwned,'function');
  assert.deepEqual(await failed.cleanup.stopOwned(100),{status:'STOPPED',runId:RUN});
  await assert.rejects(failed.cleanup.stopOwned(100,{child:{}}),/EXIT_DENIED/);
  await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
});

// Break caught: moving any consumed pre-effect rejection outside the retained
// original-child compensation boundary strands a prestarted waiting worker.
for(const failure of ['invalid-grant','inspectGrant-throw','early-drift']) {
  test(`R3_${failure}_compensates_original_waiting_child`,async()=>{
    const f=fixture(),p=roles.adoptRole('BROWSER',f.handoff);let stops=0;
    f.authority.stopOwned=async(child,deadline)=>{
      assert.equal(child,f.child);assert.equal(deadline,120000);stops++;
      return {status:'STOPPED',runId:RUN,child};
    };
    if(failure==='inspectGrant-throw')f.authority.inspectGrant=()=>{throw Error('inert inspection failure');};
    if(failure==='early-drift')f.facts.confined=false;
    await assert.rejects(p.activateOnce(failure==='invalid-grant'?{}:f.grant),/ACTIVATION_DENIED/);
    assert.equal(stops,1);assert.equal(f.count(),0);
    await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
    assert.equal(stops,1);assert.equal(f.count(),0);
  });
  test(`R3_${failure}_uncertain_cleanup_retains_only_bounded_owned_authority`,async()=>{
    for(const outcome of ['timeout','throw','foreign-receipt']) {
      const f=fixture(),p=roles.adoptRole('BROWSER',f.handoff);let stops=0;
      f.authority.stopOwned=async(child,deadline)=>{
        assert.equal(child,f.child);assert.equal(deadline,stops===0?120000:100);stops++;
        if(stops===1&&outcome==='throw')throw Error('inert stop failure');
        return {status:stops===1&&outcome==='timeout'?'TIMEOUT':'STOPPED',runId:RUN,
          child:stops===1&&outcome==='foreign-receipt'?{}:child};
      };
      if(failure==='inspectGrant-throw')f.authority.inspectGrant=()=>{throw Error('inert inspection failure');};
      if(failure==='early-drift')f.facts.confined=false;
      let error;try{await p.activateOnce(failure==='invalid-grant'?{}:f.grant);}catch(e){error=e;}
      assert.equal(error?.code,'CLEANUP_UNCERTAIN');assert.equal(stops,1);assert.equal(f.count(),0);
      assert.deepEqual(Object.keys(error.cleanup).sort(),['stopOwned','waitExit']);
      assert.equal(error.cleanup.privatePipe,undefined);assert.equal(error.cleanup.activateOnce,undefined);
      for(const deadline of [0,true,Infinity,1200001])await assert.rejects(error.cleanup.stopOwned(deadline),/EXIT_DENIED/);
      await assert.rejects(error.cleanup.stopOwned(100,{child:{}}),/EXIT_DENIED/);
      assert.deepEqual(await error.cleanup.stopOwned(100),{status:'STOPPED',runId:RUN});
      await assert.rejects(p.activateOnce(f.grant),/ACTIVATION_DENIED/);
      assert.equal(stops,2);assert.equal(f.count(),0);
    }
  });
}

// Task 16c (owner decision 2026-11-20, P76): the bootstrap inspects the BROWSER family; the controller asks for
// POST_LOAD and FINAL through the BROWSER activation handle, and accepts only the bootstrap's exact clean result.
test('browser_family_result_shape_bound', async () => {
  const f = fixture(), h = await roles.adoptRole('BROWSER', f.handoff).activateOnce(f.grant), asked = [];
  assert.equal(typeof h.inspectFamily, 'function');
  f.authority.inspectFamily = async (child, point, ...rest) => { asked.push([child, point, rest.length]); return cleanFamily(point); };
  for (const point of ['POST_LOAD', 'FINAL']) {
    const value = await h.inspectFamily(point);
    assert.deepEqual({ ...value }, { point, ordinal: cleanFamily(point).ordinal, members: 5 });
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(asked, [[f.child, 'POST_LOAD', 0], [f.child, 'FINAL', 0]]);
  for (const members of [2, 256]) {
    f.authority.inspectFamily = async (child, point) => ({ ...cleanFamily(point), members });
    assert.equal((await h.inspectFamily('POST_LOAD')).members, members);
  }
  for (const [name, point, answer] of [
    ['status DIRTY', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), status: 'DIRTY' })],
    ['point mismatch', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), point: 'FINAL' })],
    ['POST_LOAD with ordinal 3', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), ordinal: 3 })],
    ['FINAL with ordinal 2', 'FINAL', () => ({ ...cleanFamily('FINAL'), ordinal: 2 })],
    ['extra key', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), attempts: 1 })],
    ['missing key', 'POST_LOAD', () => ({ point: 'POST_LOAD', ordinal: 2, status: 'CLEAN' })],
    ['members 1', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), members: 1 })],
    ['members 257', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), members: 257 })],
    ['members 2.5', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), members: 2.5 })],
    ['members text', 'POST_LOAD', () => ({ ...cleanFamily('POST_LOAD'), members: '5' })],
    ['null', 'POST_LOAD', () => null],
    ['array', 'POST_LOAD', () => []],
    ['rejection', 'POST_LOAD', () => { throw Object.assign(new Error('FAMILY_DENIED'), { code: 'FAMILY_DENIED' }); }],
  ]) {
    const g = fixture(), q = await roles.adoptRole('BROWSER', g.handoff).activateOnce(g.grant);
    g.authority.inspectFamily = async () => answer();
    await assert.rejects(q.inspectFamily(point), { code: 'ROLE_INVALID' }, name);
  }
  // Only the two controller points, one argument each; the authority is never asked otherwise.
  for (const args of [['LAUNCH'], ['PERIODIC'], [], ['POST_LOAD', {}]]) {
    const g = fixture(), q = await roles.adoptRole('BROWSER', g.handoff).activateOnce(g.grant);
    let calls = 0; g.authority.inspectFamily = async (child, point) => { calls++; return cleanFamily(point); };
    await assert.rejects(q.inspectFamily(...args), { code: 'ROLE_INVALID' }, JSON.stringify(args));
    assert.equal(calls, 0, JSON.stringify(args));
  }
  // The VERIFIER handle has none.
  const v = fixture('VERIFIER'), vh = await roles.adoptRole('VERIFIER', v.handoff).activateOnce(v.grant);
  assert.equal('inspectFamily' in vh, false);
  // An authority without it is not a bootstrap authority.
  const { inspectFamily, ...partial } = fixture().authority;
  assert.equal(typeof inspectFamily, 'function');
  assert.throws(() => roles.bindRoleBootstrap(partial, RUN), /HANDOFF_DENIED/);
  assert.throws(() => roles.bindRoleBootstrap({ ...partial, inspectFamily: true }, RUN), /HANDOFF_DENIED/);
});

// A composition controller channel over the real bindBootstrapComposition. APP_POLL requests are held until the
// test answers them; ADOPT, PREPARE_BROWSER, COMMIT_BROWSER and BROWSER_FAMILY are answered at once.
function compositionChannel() {
  const crypto = require('node:crypto');
  const binding = { version: 1, runId: RUN, manifestDigest: 'b'.repeat(64), configIdentity: 'c'.repeat(64), rolePolicyDigest: 'd'.repeat(64), epoch: 1, expiresAtMs: 10000 };
  const map = ['CONTROLLER', 'BROWSER', 'VERIFIER', 'PROXY'].map((role, i) => ({ role, childId: String(i + 1).repeat(32), pipeId: String(i + 5).repeat(32) }));
  const key = 'c3'.repeat(32), command = {}, result = {}, queue = [], readers = [], sent = [], held = [], timeline = [];
  const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
  const frame = v => { const bytes = Buffer.from(canon(v)), n = Buffer.alloc(4); n.writeUInt32BE(bytes.length); return Buffer.concat([n, bytes]); };
  const deliver = bytes => { const reader = readers.shift(); if (reader) reader(bytes); else queue.push(bytes); };
  let sequence = 0;
  function reply(request, value) {
    const bare = { version: 1, binding, sequence: ++sequence, role: request.role, childId: request.childId, pipeId: request.pipeId, action: 'RESULT',
      payload: { requestSequence: request.sequence, result: value } };
    const mac = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update('acceptance:bootstrap-composition:v1\0CONTROLLER:FROM_BOOTSTRAP\0' + canon(bare)).digest('hex');
    timeline.push('RESULT:' + request.action); deliver(frame({ ...bare, mac }));
  }
  const proof = { proofDigest: 'e'.repeat(64), generation: 1, expiresAtMs: 9000, monotonicDeadlineMs: 9000 };
  queue.push(frame({ version: 1, kind: 'BOOTSTRAP_INIT', binding, channelKeyHex: key, roles: map }));
  const channel = {
    audit: () => ({ role: 'CONTROLLER', childId: map[0].childId, pipeId: map[0].pipeId, channelKeyHex: key, binding, roles: map, command, result }),
    read: async () => queue.length ? queue.shift() : new Promise(resolve => readers.push(resolve)),
    async write(bytes) {
      const v = JSON.parse(bytes.subarray(4)); sent.push(v); timeline.push(v.action);
      if (v.action === 'ADOPT') reply(v, { kind: v.role, runId: RUN, uid: 10002, childId: v.childId, pipeId: v.pipeId, waiting: true, confined: true, attestationDigest: '9'.repeat(64) });
      if (v.action === 'PREPARE_BROWSER') reply(v, { grantId: 'a1'.repeat(16), ...proof });
      if (v.action === 'COMMIT_BROWSER') reply(v, { status: 'ACTIVE', generation: 1 });
      if (v.action === 'BROWSER_FAMILY') reply(v, { members: 5, ordinal: 2, point: v.payload.point, status: 'CLEAN' });
      if (v.action === 'APP_POLL') held.push(v);
    } };
  const clock = { wall: 100, mono: 100, sample() { return [this.wall, this.mono]; } };
  const budget = { deadline: null, remaining() { if (this.deadline === null) this.deadline = clock.mono + 60000; return Math.max(0, this.deadline - clock.mono); },
    clamp(end) { this.deadline = Math.min(this.deadline ?? end, end); } };
  return { channel, binding, clock, budget, proof, sent, held, timeline, reply };
}

test('browser_family_request_is_serialized_with_application_pipe', async () => {
  const c = compositionChannel();
  const bound = await roles.bindBootstrapComposition(c.channel, c.binding, c.clock, c.budget);
  const tx = await bound.prepareBrowser(c.proof), handle = await tx.port.activateOnce(tx.grant);
  assert.equal(typeof handle.inspectFamily, 'function', 'the BROWSER handle has no bootstrap family inspection');
  const reading = handle.privatePipe.read();
  for (let turn = 0; turn < 20 && !c.held.length; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.held.length, 1, 'an APP_POLL is in flight');
  const family = handle.inspectFamily('POST_LOAD');
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.sent.some(v => v.action === 'BROWSER_FAMILY'), false, 'no BROWSER_FAMILY while the poll is in flight');
  c.reply(c.held.shift(), { status: 'CHUNK', chunk: { streamSequence: 1, messageSequence: 1, chunkIndex: 0, final: true, bytesHex: '41' } });
  assert.deepEqual(await reading, Buffer.from('A'));
  assert.deepEqual({ ...(await family) }, { point: 'POST_LOAD', ordinal: 2, members: 5 });
  const at = c.timeline.indexOf('BROWSER_FAMILY');
  assert.ok(at > c.timeline.indexOf('RESULT:APP_POLL'), c.timeline.join(','));
  const request = c.sent.find(v => v.action === 'BROWSER_FAMILY');
  assert.equal(request.role, 'BROWSER'); assert.deepEqual(request.payload, { generation: 1, point: 'POST_LOAD' });
  assert.equal(c.budget.deadline, null, 'a routine inspection never starts the shared cleanup end');
});
