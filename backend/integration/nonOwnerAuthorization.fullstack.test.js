const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('../node_modules/jsonwebtoken');
const {startHarness} = require('../../scripts/acceptance/harness.cjs');

// Historical-session negative API fixture only. No token is installed in a browser;
// successful browser authentication is tested separately through the real login form.
test('historical non-owner session cannot access real owner APIs or mutate persisted/broker state', async () => {
 const h = await startHarness();
 try {
  const token = jwt.sign({sub:h.otherId,userId:h.otherId,username:'other-user',sessionVersion:0},h.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'5m'});
  const Settings = require('../models/RoboSettings');
  const before = await Settings.findOne({userId:h.ownerId}).lean();
  const requestsBefore = h.provider.state.requests.length;
  const cases = [
   ['GET','/api/paper-trades/account'],
   ['GET','/api/paper-trades/positions'],
   ['POST','/api/paper-trades/order',{symbol:'AAPL',side:'buy',qty:1,orderType:'limit',limitPrice:100,idempotencyKey:'historical-nonowner'}],
   ['GET','/api/robotrader/settings'],
   ['PUT','/api/robotrader/settings',{mode:'paper',dailyLimit:99999,isEnabled:true}],
   ['POST','/api/robotrader/enable',{}],
   ['POST','/api/robotrader/disable',{}],
   ['POST','/api/robotrader/emergency-stop',{environment:'paper',cancelOpenOrders:true}],
   ['POST','/api/robotrader/positions/AAPL/close',{idempotencyKey:'nonowner-close'}],
   ['POST','/api/robotrader/cash/synchronize',{}],
   ['GET','/api/robotrader/position-closes'],
   ['GET','/api/trading-system/status'],
   ['GET','/api/robotrader/orders'],
   ['GET','/api/robotrader/notifications'],
   ['GET','/api/robotrader/audit']
  ];
  for (const [method,path,body] of cases) {
   for (const credential of [{authorization:`Bearer ${token}`},{cookie:`daytrader_session=${token}`}]) {
    const response = await fetch(h.baseURL+path,{method,headers:{...credential,origin:h.baseURL,'content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
    assert.equal(response.status,403,`${method} ${path}`);
    assert.match((await response.json()).message,/Owner access required/);
   }
  }
  assert.deepEqual(await Settings.findOne({userId:h.ownerId}).lean(),before);
  assert.equal(await require('../models/OrderIntent').countDocuments(),0);
  assert.equal(await require('../models/PositionClose').countDocuments(),0);
  assert.equal(h.provider.state.posts.length,0);
  assert.equal(h.provider.state.requests.length,requestsBefore);
 } finally {await h.close();}
});
