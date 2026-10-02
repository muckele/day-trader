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
    if (count !== 1 || !Number.isSafeInteger(deadline) || deadline <= 0 || deadline > 1200000) fail('EXIT_DENIED');
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
    if (arguments.length !== 1 || !object(grant) || usedGrants.has(grant)) fail('ACTIVATION_DENIED');
    usedGrants.add(grant);
    current('ACTIVATION_DENIED');
    let g;
    try { g=r.authority.inspectGrant(grant); } catch { fail('ACTIVATION_DENIED'); }
    if (!g || g.kind !== kind || g.runId !== r.expected.runId || g.child !== r.expected.child ||
        g.purpose !== (kind === 'BROWSER' ? 'CONFINEMENT_PROVED' : 'PRIOR_SESSION') ||
        (kind === 'VERIFIER' ? !object(g.session) : g.session !== null)) fail('ACTIVATION_DENIED');
    try {
      await r.authority.activate(r.expected.child,grant);
      current('ACTIVATION_DENIED',false);
    } catch {
      let stopped;
      try { stopped=await cleanup.stopOwned(120000); } catch { /* explicitly uncertain below */ }
      if (!stopped || !['STOPPED','EXITED'].includes(stopped.status)) {
        const e=new Error('CLEANUP_UNCERTAIN'); e.code='CLEANUP_UNCERTAIN'; e.cleanup=cleanup; throw e;
      }
      fail('ACTIVATION_DENIED');
    }
    return privateHandle({privatePipe:r.expected.privatePipe,
      waitExit:cleanup.waitExit, stopOwned:cleanup.stopOwned});
  }});
}
module.exports = Object.freeze({bindRoleBootstrap,adoptRole});
