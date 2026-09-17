'use strict';
// Acceptance-only quantity authority. A broker position is a consistency witness,
// never evidence that this run owns the position's excess over its baseline.
const Q=require('../services/shareQuantity');
const fail=()=>Object.assign(new Error('ACCEPTANCE BASELINE DRIFT / OWNERSHIP AMBIGUOUS'),{code:'ACCEPTANCE_BASELINE_DRIFT',beforeTransport:true});
function assertBaselineDelta({baselineQty,currentQty,availableQty,ownedQty,requestedQty}){
 if(ownedQty===undefined||Q.compare(currentQty,Q.add(baselineQty,ownedQty))!==0)throw fail();
 if(requestedQty!==undefined){
  if(!Q.positive(requestedQty)||Q.compare(requestedQty,ownedQty)>0||Q.compare(requestedQty,availableQty??currentQty)>0||Q.units(currentQty)-Q.units(requestedQty)<Q.units(baselineQty))throw fail();
  return Q.normalize(requestedQty);
 }
 return Q.normalize(ownedQty);
}
function ownedFillQuantity({intents,brokerOrders,fills,accountId,userId,symbol,identities}){
 let buys=0n,sells=0n;
 for(const intent of intents){
  const identity=identities.get(intent.clientOrderId);
  if(!identity||String(identity.intent._id)!==String(intent._id)||intent.accountId!==accountId||String(intent.userId)!==String(userId)||intent.executionSource!=='alpaca-paper'||intent.symbol!==symbol)throw fail();
  const records=brokerOrders.filter(b=>String(b.intentId)===String(intent._id));
  const rows=fills.filter(f=>String(f.intentId)===String(intent._id));let total=0n;
  for(const f of rows){
   const b=records.find(b=>String(b._id)===String(f.brokerOrderId));
   if(!b||b.accountId!==accountId||b.executionSource!=='alpaca-paper'||b.clientOrderId!==intent.clientOrderId||b.externalOrderId!==f.externalOrderId||b.symbol!==symbol||b.side!==intent.side||f.accountId!==accountId||f.executionSource!=='alpaca-paper'||f.symbol!==symbol||f.side!==intent.side||!Q.positive(f.qty))throw fail();
   total+=Q.units(f.qty);
  }
  if(total!==Q.units(intent.filledQty??0)||total>Q.units(intent.qty))throw fail();
  if(intent.side==='buy')buys+=total;else if(intent.side==='sell')sells+=total;else throw fail();
 }
 if(sells>buys)throw fail();return Q.format(buys-sells);
}
module.exports={assertBaselineDelta,ownedFillQuantity};
