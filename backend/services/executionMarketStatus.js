const {getMarketStatus} = require('../utils/marketStatus');
const {evaluateBrokerClock} = require('./brokerClock');

async function getExecutionMarketStatus({
 alpacaMode = require('./alpacaTradingClient').shouldSyncPaperTradesToAlpaca(),
 broker,
 now = () => new Date()
} = {}) {
 if (!alpacaMode) return {...getMarketStatus(now()),source:'local-calendar',executionSource:'local-simulation'};
 try {
  const clock = await (broker || require('../robotrader/alpacaBroker').createAlpacaBroker({mode:'paper'})).getClock();
  if(!evaluateBrokerClock(clock,{nowMs:now().getTime()}).valid)throw new Error('Stale or malformed broker clock.');
  return {status:clock.is_open?'OPEN':'CLOSED',source:'alpaca-clock',executionSource:'alpaca-paper',asOf:clock.timestamp,nextOpen:clock.next_open||null,nextClose:clock.next_close||null};
 } catch {
  return {status:'UNAVAILABLE',source:'alpaca-clock',executionSource:'alpaca-paper',asOf:null,nextOpen:null,nextClose:null,error:'Fresh Alpaca market status is unavailable.'};
 }
}
module.exports={getExecutionMarketStatus};
