const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBrokerClock, recordClockTiming } = require('../services/brokerClock');
const receipt = Date.parse('2026-09-17T17:36:30.562Z');
const clockAt = offset => ({ is_open: true, timestamp: new Date(receipt + offset).toISOString() });

for (const [offset, valid] of [[0,true],[1,true],[31,true],[250,true],[999,true],[1000,true],[1001,false],[5000,false],[-59999,true],[-60000,true],[-60001,false]]) {
 test(`broker clock ${offset}ms from receipt ${valid ? 'passes' : 'fails closed'}`, () => {
  const result = evaluateBrokerClock(clockAt(offset), {nowMs:receipt});
  assert.equal(result.valid, valid);
  if (!valid) assert.equal(result.reason, 'FRESH_CLOCK_REQUIRED');
 });
}
test('observed 31ms broker future skew accepted at nanosecond precision', () => {
 const result = evaluateBrokerClock({is_open:true,timestamp:'2026-09-17T17:36:30.593806133Z'}, {nowMs:receipt});
 assert.equal(result.valid,true); assert.equal(result.rawAgeMs,-31.806133); assert.equal(result.effectiveAgeMs,0);
});
test('future boundary does not admit even one extra nanosecond', () => {
 const result = evaluateBrokerClock({is_open:true,timestamp:'2026-09-17T17:36:31.562000001Z'}, {nowMs:receipt});
 assert.equal(result.valid,false); assert.equal(result.detail,'EXCESSIVE_FUTURE_SKEW');
});
test('recorded response receipt anchors skew and elapsed time still expires freshness', () => {
 const clock = recordClockTiming(clockAt(31), {requestStartedAt:receipt-10,responseReceivedAt:receipt});
 const fresh = evaluateBrokerClock(clock,{nowMs:receipt+60000});
 assert.equal(fresh.valid,true); assert.equal(fresh.rawAgeMs,-31); assert.equal(fresh.effectiveAgeMs,60000);
 assert.equal(fresh.receiptAt,receipt); assert.equal(fresh.requestStartedAt,receipt-10);
 const stale = evaluateBrokerClock(clock,{nowMs:receipt+60001});
 assert.equal(stale.valid,false); assert.equal(stale.detail,'STALE_CLOCK');
});
test('later evaluation cannot launder excessive skew at response receipt', () => {
 const clock = recordClockTiming(clockAt(5000), {requestStartedAt:receipt-10,responseReceivedAt:receipt});
 assert.equal(evaluateBrokerClock(clock,{nowMs:receipt+5000}).valid,false);
});
test('untrusted payload timing cannot make a stale clock fresh', () => {
 const clock = {...clockAt(-60001),responseReceivedAt:receipt-60001,receiptAt:receipt-60001};
 assert.equal(evaluateBrokerClock(clock,{nowMs:receipt}).valid,false);
});
test('missing malformed unsupported and invalid calendar clock shapes fail closed', () => {
 for(const clock of [null,[],{}, {is_open:true}, {is_open:'true',timestamp:clockAt(0).timestamp}, {is_open:true,timestamp:receipt}, {is_open:true,timestamp:'bad'}, {is_open:true,timestamp:'2026-02-30T12:00:00Z'}]) {
  assert.equal(evaluateBrokerClock(clock,{nowMs:receipt}).valid,false);
 }
});
test('closed market retains broker openness while bounded skew remains fresh', () => {
 const clock = {...clockAt(31),is_open:false};
 assert.equal(evaluateBrokerClock(clock,{nowMs:receipt}).valid,true); assert.equal(clock.is_open,false);
});
