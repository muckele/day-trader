'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../../guest/role-ports.cjs');
const roles = fs.existsSync(modulePath) ? require(modulePath) : null;
const RUN = 'a'.repeat(32);
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
  const facts = { kind, runId: RUN, uid: kind === 'BROWSER' ? 10002 : 10003,
    child, privatePipe: pipe, waiting: true, confined: true, ...overrides };
  const authority = {
    inspectHandoff: h => h === handoff ? { ...facts } : null,
    inspectGrant: g => g === grant ? { kind, runId: RUN, child,
      purpose: kind === 'BROWSER' ? 'CONFINEMENT_PROVED' : 'PRIOR_SESSION', session: kind === 'VERIFIER' ? Object.freeze({}) : null } : null,
    activate: async (owned, value) => { assert.equal(owned, child); assert.equal(value, grant); activations++; facts.waiting=false; },
    waitExit: async (owned, deadline) => ({ status: 'EXITED', runId: RUN, child: owned }),
    stopOwned: async (owned, deadline) => { stops++; return { status: 'STOPPED', runId: RUN, child: owned }; },
  };
  const boundary = roles.bindRoleBootstrap(authority, RUN);
  boundary.audit(handoff);
  return { child, pipe, handoff, grant, facts, authority, boundary, count: () => activations, stops: () => stops };
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
    const f = fixture(); const p = roles.adoptRole('BROWSER', f.handoff);
    await assert.rejects(p.activateOnce({ ...f.grant, ...extra }), /ACTIVATION_DENIED/);
    assert.equal(f.count(), 0);
  }
});
test('exit_handle_bound_to_run_and_owned_child', async () => {
  const f = fixture(); const p = roles.adoptRole('BROWSER', f.handoff); const h = await p.activateOnce(f.grant);
  assert.equal(h.privatePipe, f.pipe);
  assert.deepEqual(await h.waitExit(100), { status: 'EXITED', runId: RUN });
  assert.deepEqual(await h.stopOwned(100), { status: 'STOPPED', runId: RUN });
  assert.equal(f.count(), 1);
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
  const g=fixture('VERIFIER');g.authority.inspectGrant=()=>({kind:'VERIFIER',runId:RUN,child:g.child,purpose:'CONFINEMENT_PROVED',session:null});
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
