const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeReplacementPayload } = require('../robotrader/alpacaBroker');
test('broker clock uses transport receipt evidence before unrelated interceptor delay',async t=>{
 const receipt=Date.parse('2026-09-17T17:36:30.562Z');
 let instant=receipt-10;t.mock.method(Date,'now',()=>instant);
 const clock={is_open:true,timestamp:'2026-09-17T17:36:31.563Z'};
 const {createAlpacaBroker}=require('../robotrader/alpacaBroker');
 const broker=createAlpacaBroker({env:{APCA_API_KEY_ID:'unit-test-key',APCA_API_SECRET_KEY:'unit-test-secret',ALPACA_EXPECTED_PAPER_ACCOUNT_ID:'unit-test-account'},httpClient:async()=>{
  instant=receipt+5000;
  return {data:clock,config:{acceptanceRow:{startedAt:new Date(receipt-10).toISOString(),endedAt:new Date(receipt).toISOString()}}};
 }});
 const result=await broker.getClock();
 const evaluated=require('../services/brokerClock').evaluateBrokerClock(result,{nowMs:instant});
 assert.equal(evaluated.valid,false);assert.equal(evaluated.detail,'EXCESSIVE_FUTURE_SKEW');assert.equal(evaluated.receiptAt,receipt);assert.equal(evaluated.requestStartedAt,receipt-10);
 assert.deepEqual(Object.keys(result),['is_open','timestamp']);
});
test('broker clock captures receipt at HTTP completion without transport evidence',async t=>{
 const receipt=Date.parse('2026-09-17T17:36:30.562Z');let instant=receipt-10;t.mock.method(Date,'now',()=>instant);
 const {createAlpacaBroker}=require('../robotrader/alpacaBroker');
 const broker=createAlpacaBroker({env:{APCA_API_KEY_ID:'unit-test-key',APCA_API_SECRET_KEY:'unit-test-secret',ALPACA_EXPECTED_PAPER_ACCOUNT_ID:'unit-test-account'},httpClient:async()=>{instant=receipt;return {data:{is_open:true,timestamp:'2026-09-17T17:36:30.593806133Z'}};}});
 const clock=await broker.getClock();instant=receipt+60001;
 const evaluated=require('../services/brokerClock').evaluateBrokerClock(clock,{nowMs:instant});
 assert.equal(evaluated.valid,false);assert.equal(evaluated.detail,'STALE_CLOCK');assert.equal(evaluated.receiptAt,receipt);
});

test('robotrader alpaca broker sanitizes order replacement payloads', () => {
  assert.deepEqual(
    sanitizeReplacementPayload({
      qty: 2,
      limitPrice: 201.25,
      timeInForce: 'GTC',
      symbol: 'MSFT',
      side: 'sell'
    }),
    {
      qty: '2',
      limit_price: '201.25',
      time_in_force: 'gtc'
    }
  );
});

test('robotrader alpaca broker rejects unsafe replacement payloads', () => {
  assert.throws(
    () => sanitizeReplacementPayload({ symbol: 'MSFT', side: 'sell' }),
    /at least one supported field/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ qty: -1 }),
    /qty must be a positive number/
  );
  assert.throws(
    () => sanitizeReplacementPayload({ trailPrice: 1, trailPercent: 2 }),
    /either trail_price or trail_percent/
  );
});
