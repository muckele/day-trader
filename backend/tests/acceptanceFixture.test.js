const test=require('node:test'),assert=require('node:assert/strict');
const guard=(...args)=>require('../scripts/acceptanceFixture').assertBaselineDelta(...args);
test('baseline-floor protection',()=>{
 assert.equal(guard({baselineQty:'17.582774',currentQty:'18.082774',availableQty:'18.082774',ownedQty:'0.5',requestedQty:'0.5'}),'0.5');
 for(const requestedQty of ['0.500000001','18.082774'])assert.throws(()=>guard({baselineQty:'17.582774',currentQty:'18.082774',availableQty:'18.082774',ownedQty:'0.5',requestedQty}));
});
test('baseline consistency alone cannot mint acceptance ownership',()=>{
 assert.throws(()=>guard({baselineQty:'17.582774',currentQty:'18.082774',availableQty:'18.082774',requestedQty:'0.5'}));
});
test('exact fractional baseline does not round a ninth-decimal delta',()=>{
 assert.equal(guard({baselineQty:'0.625441',currentQty:'0.958774333',availableQty:'0.958774333',ownedQty:'0.333333333',requestedQty:'0.333333333'}),'0.333333333');
});
test('canonical acceptance fill identity is required rather than symbol match',()=>{
 const {ownedFillQuantity}=require('../scripts/acceptanceFixture');
 const intent={_id:'intent',accountId:'test-paper',userId:'test-owner',executionSource:'alpaca-paper',symbol:'NVDA',side:'buy',qty:1,filledQty:'0.5',clientOrderId:'run-client'};
 const broker={_id:'record',intentId:'intent',accountId:'test-paper',executionSource:'alpaca-paper',symbol:'NVDA',side:'buy',clientOrderId:'run-client',externalOrderId:'broker-1'};
 const fill={intentId:'intent',brokerOrderId:'record',accountId:'test-paper',executionSource:'alpaca-paper',symbol:'NVDA',side:'buy',externalOrderId:'broker-1',qty:'0.5'};
 const args={intents:[intent],brokerOrders:[broker],fills:[fill],accountId:'test-paper',userId:'test-owner',symbol:'NVDA',identities:new Map([['run-client',{intent}]])};
 assert.equal(ownedFillQuantity(args),'0.5');
 for(const patch of [{externalOrderId:'foreign'},{brokerOrderId:'foreign'},{accountId:'foreign'},{intentId:'foreign'},{side:'sell'},{qty:'0.6'}])assert.throws(()=>ownedFillQuantity({...args,fills:[{...fill,...patch}]}));
 assert.throws(()=>ownedFillQuantity({...args,identities:new Map()}));
});
