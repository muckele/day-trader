const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('../../scripts/acceptance/harness.cjs');
const Settings = require('../models/RoboSettings');
const Intent = require('../models/OrderIntent');
const BrokerOrder = require('../models/BrokerOrder');
const Capacity = require('../models/AccountCapacity');
test('real API durably rejects risk admission, preserves that identity, and permits a corrected ticket', { timeout: 45000 }, async () => {
 const h = await startHarness();
 try {
  const login=await fetch(h.baseURL+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:h.baseURL},body:JSON.stringify({username:'acceptance-owner',password:'local-test-password'})});
  assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
  const submit=async(key,qty)=>{const response=await fetch(h.baseURL+'/api/paper-trades/order',{method:'POST',headers:{'Content-Type':'application/json',Origin:h.baseURL,Cookie:cookie,'Idempotency-Key':key},body:JSON.stringify({symbol:'AAPL',side:'buy',qty,assetClass:'equity',orderType:'limit',limitPrice:100,timeInForce:'day',allowExtendedHours:false})});return {status:response.status,data:await response.json()};};
  await Settings.updateOne({userId:h.ownerId},{$set:{maxTradeAmount:150}});
  const failures=await Promise.all([submit('rejected-logical-key',2),submit('rejected-logical-key',2)]);
  assert.ok(failures.some(x=>x.data.admissionOutcome?.state==='rejected_without_submission'));
  assert.equal(h.provider.state.posts.length,0);
  const rejected=await Intent.findOne({idempotencyKey:'rejected-logical-key'}).lean();assert.equal(rejected.status,'rejected');assert.equal(rejected.reservedCents,0);
  assert.equal(await Intent.countDocuments({idempotencyKey:'rejected-logical-key'}),1);assert.equal(await BrokerOrder.countDocuments(),0);assert.equal((await Capacity.findOne().lean()).reservedCents,0);
  await Settings.updateOne({userId:h.ownerId},{$set:{maxTradeAmount:1000}});
  const retry=await submit('rejected-logical-key',2);assert.equal(retry.data.order.status,'rejected');assert.equal(h.provider.state.posts.length,0);
  const corrected=await submit('corrected-logical-key',1);assert.equal(corrected.status,200);assert.equal(corrected.data.order.status,'acknowledged');assert.equal(h.provider.state.posts.length,1);
  assert.notEqual(h.provider.state.posts[0].client_order_id,rejected.clientOrderId);
 } finally {await h.close();}
});
