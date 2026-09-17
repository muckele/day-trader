const MAX_BROKER_CLOCK_AGE_MS = 60000;
const MAX_BROKER_CLOCK_FUTURE_SKEW_MS = 1000;
const timings = new WeakMap();

// Transport-owned metadata cannot be supplied or overwritten by the broker payload.
function recordClockTiming(clock, {requestStartedAt, responseReceivedAt} = {}) {
 if (clock && typeof clock === 'object' && Number.isSafeInteger(responseReceivedAt)) {
  timings.set(clock, {receiptAt:responseReceivedAt,requestStartedAt:Number.isSafeInteger(requestStartedAt)?requestStartedAt:null});
 }
 return clock;
}

function parseTimestamp(value) {
 if (typeof value !== 'string') return null;
 const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if (!match) return null;
 const [,year,month,day,hour,minute,second,fraction=''] = match;
 const leap = Number(year)%4===0 && (Number(year)%100!==0 || Number(year)%400===0);
 const days = [31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if (+month<1 || +month>12 || +day<1 || +day>days[+month-1] || +hour>23 || +minute>59 || +second>59) return null;
 const timestamp = Date.parse(value);
 if (!Number.isSafeInteger(timestamp)) return null;
 // Date.parse truncates after milliseconds. Preserve the remaining nanoseconds
 // separately so truncation cannot extend the inclusive 1000ms future limit.
 const nanos = BigInt(timestamp)*1000000n + BigInt(fraction.padEnd(9,'0').slice(3));
 return {timestamp,nanos};
}

function evaluateBrokerClock(clock, {nowMs = Date.now()} = {}) {
 const timing = clock && typeof clock==='object' ? timings.get(clock) : null;
 const receiptAt = timing?.receiptAt ?? nowMs;
 const result = {valid:false,reason:'FRESH_CLOCK_REQUIRED',detail:'MALFORMED_CLOCK',timestamp:null,receiptAt,requestStartedAt:timing?.requestStartedAt??null,rawAgeMs:null,effectiveAgeMs:null,futureSkewLimitMs:MAX_BROKER_CLOCK_FUTURE_SKEW_MS};
 if (!clock || typeof clock!=='object' || Array.isArray(clock) || typeof clock.is_open!=='boolean') return result;
 const parsed = parseTimestamp(clock.timestamp);
 if (!parsed || !Number.isSafeInteger(receiptAt) || !Number.isSafeInteger(nowMs)) return result;
 const rawAgeNanos = BigInt(receiptAt)*1000000n-parsed.nanos;
 const elapsedMs = Math.max(0,nowMs-receiptAt);
 result.timestamp = parsed.timestamp;
 result.rawAgeMs = Number(rawAgeNanos)/1000000;
 result.effectiveAgeMs = Math.max(0,result.rawAgeMs)+elapsedMs;
 if (rawAgeNanos < -BigInt(MAX_BROKER_CLOCK_FUTURE_SKEW_MS)*1000000n) return {...result,detail:'EXCESSIVE_FUTURE_SKEW'};
 if (result.effectiveAgeMs > MAX_BROKER_CLOCK_AGE_MS) return {...result,detail:'STALE_CLOCK'};
 return {...result,valid:true,reason:null,detail:null};
}

module.exports = {MAX_BROKER_CLOCK_AGE_MS,MAX_BROKER_CLOCK_FUTURE_SKEW_MS,recordClockTiming,evaluateBrokerClock};
