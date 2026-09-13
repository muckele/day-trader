const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileRoboOrders, submitProtectiveStopForEntry } = require('../robotrader/reconciliation');
const { normalizeOrder } = require('../services/orderLifecycleFinancial');
function fixture(intents, reconcile) {
  const projected = [], queries = [], calls = [];
  return { projected, queries, calls, deps: {
    createAlpacaBroker: () => ({ submitOrder: () => { throw new Error('Reconciler must delegate broker writes.'); } }),
    OrderIntent: { find: query => { queries.push(query); return { sort: () => ({ limit: async () => intents }) }; } },
    RoboTradeOrder: { updateOne: async (query, update) => projected.push({ query, ...update.$set }) },
    getOrderLifecycle: async () => ({ reconcile: async input => { calls.push(input); return reconcile(input); } })
  } };
}
test('robotrader reconciliation projects authoritative confirmed fills without simulator execution', async () => {
  const f=fixture([{_id:'intent-1'}],async()=>({intent:{status:'filled',filledQty:4},order:{externalOrderId:'alpaca-1',filled_qty:'4'}}));
  const result=await reconcileRoboOrders({userId:'owner'},f.deps);
  assert.equal(result.updatedCount,1); assert.equal(result.executionSource,'alpaca-paper');
  assert.deepEqual(f.calls,[{intentId:'intent-1'}]);
  assert.equal(f.projected[0].status,'filled'); assert.equal(f.projected[0].filledQty,4);
  assert.deepEqual(f.projected[0].query,{intentId:'intent-1'});
});
test('robotrader reconciliation delegates uncertain client ID recovery and keeps unresolved state', async () => {
  let found=false;
  const f=fixture([{_id:'intent-uncertain'}],async()=>({intent:{status:found?'acknowledged':'submission_uncertain',filledQty:0},order:found?{externalOrderId:'recovered'}:null}));
  await reconcileRoboOrders({userId:'owner'},f.deps);
  assert.equal(f.projected[0].status,'submission_uncertain');
  found=true; await reconcileRoboOrders({userId:'owner'},f.deps);
  assert.equal(f.projected[1].externalOrderId,'recovered'); assert.equal(f.calls.length,2);
});
test('robotrader reconciliation scopes authoritative intents by owner/account without importing unattributed orphans', async () => {
  const f=fixture([],async()=>{throw new Error('No attributed intent');});
  const result=await reconcileRoboOrders({userId:'owner',accountId:'paper-account'},f.deps);
  assert.deepEqual(f.queries[0],{userId:'owner',accountId:'paper-account',executionSource:'alpaca-paper'});
  assert.equal(result.updatedCount,0); assert.equal(f.projected.length,0);
});
test('fractional automated entries explicitly reject and legacy fractional projections cannot submit stops', async () => {
  assert.throws(()=>normalizeOrder({symbol:'AAPL',side:'buy',qty:1.25,orderType:'limit',limitPrice:200}),/whole share/);
  let writes=0;
  const result=await submitProtectiveStopForEntry({_id:'legacy',qty:1.25,filledQty:1.25,status:'filled',riskStopPrice:190},
    {broker:{submitOrder:async()=>{writes++;}}});
  assert.equal(result,null); assert.equal(writes,0);
});
test('duplicate reconciliation reuses the logical intent and never directly creates a protective exit', async () => {
  const f=fixture([{_id:'intent-4'}],async()=>({intent:{status:'partially_filled',filledQty:4},order:{externalOrderId:'entry-1'}}));
  await reconcileRoboOrders({userId:'owner'},f.deps); await reconcileRoboOrders({userId:'owner'},f.deps);
  assert.deepEqual(f.calls,[{intentId:'intent-4'},{intentId:'intent-4'}]);
  assert.equal(f.projected.length,2);
});
test('reconciliation errors remain visible and do not fabricate terminal broker status',async()=>{
  const f=fixture([{_id:'intent-1'}],async()=>{throw new Error('broker unavailable');});
  const result=await reconcileRoboOrders({userId:'owner'},f.deps);
  assert.equal(result.ok,false); assert.equal(result.discrepancyCount,1);
  assert.match(result.discrepancies[0].reason,/unavailable/); assert.equal(f.projected.length,0);
});
