const test = require('node:test');
const assert = require('node:assert/strict');
const { cents, periodKeys, normalizeOrder } = require('../services/orderLifecycleFinancial');
test('exact currency and UTC ISO boundaries', () => {
 assert.equal(cents('10.01'),1001); assert.throws(()=>cents(1.001));
 assert.deepEqual(periodKeys(new Date('2026-09-13T23:59:00Z')), {day:'2026-09-13',week:'2026-09-07',month:'2026-09'});
});
test('entry requires bounded whole-share equity limit',()=>{
 assert.throws(()=>normalizeOrder({symbol:'AAPL',side:'buy',qty:1,orderType:'market'}));
 assert.throws(()=>normalizeOrder({symbol:'AAPL',side:'buy',qty:.5,orderType:'limit',limitPrice:10}));
 assert.equal(normalizeOrder({symbol:'AAPL',side:'buy',qty:2,orderType:'limit',limitPrice:'10.01'}).ceilingCents,2002);
});
test('broker cumulative VWAP supports sub-cent precision with exact half-up cents',()=>{
 const {fillNotionalCents}=require('../services/orderLifecycleFinancial');
 assert.equal(fillNotionalCents(4,'9.50125'),3801);
 assert.equal(fillNotionalCents(4,'9.50124'),3800);
});
