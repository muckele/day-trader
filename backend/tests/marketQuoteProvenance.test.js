const test=require('node:test');const assert=require('node:assert/strict');const axios=require('axios');const cache=require('../utils/cache');
function load(configured){for(const key of ['BROKER_API_KEY','APCA_API_KEY_ID','ALPACA_API_KEY','BROKER_API_SECRET','APCA_API_SECRET_KEY','ALPACA_API_SECRET'])delete process.env[key];if(configured){process.env.BROKER_API_KEY='test-dummy';process.env.BROKER_API_SECRET='test-dummy';}delete require.cache[require.resolve('../services/marketData')];return require('../services/marketData');}
test('equity quotes retain provider timestamps and missing quotes never become zero-priced data',async t=>{
 t.mock.method(cache,'getCache',()=>null);t.mock.method(cache,'setCache',()=>{});t.mock.method(axios,'get',async()=>({data:{quotes:{AAPL:{ap:100,bp:99.99,t:'2026-09-01T12:00:00Z'}}}}));
 const data=await load(true).fetchQuotes(['AAPL','MSFT']);assert.equal(data[0].asOf,'2026-09-01T12:00:00Z');assert.equal(data[0].source,'alpaca');assert.equal(data[0].change,null);assert.equal(data[0].changePercent,null);assert.equal(data[1].price,null);assert.equal(data[1].asOf,null);
});
test('unconfigured quote and sparkline provider fails instead of fabricating market prices',async t=>{
 t.mock.method(cache,'getCache',()=>null);const api=load(false);await assert.rejects(api.fetchQuotes(['AAPL']),{code:'DATA_UNAVAILABLE'});await assert.rejects(api.fetchSparkline('AAPL'),{code:'DATA_UNAVAILABLE'});
});
