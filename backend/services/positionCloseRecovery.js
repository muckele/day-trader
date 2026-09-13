const PositionClose = require('../models/PositionClose');
const OrderIntent = require('../models/OrderIntent');

async function recoverPositionCloses({ownerId=process.env.OWNER_USER_ID,accountId=process.env.ALPACA_EXPECTED_PAPER_ACCOUNT_ID}={},deps={}) {
 if(!ownerId||!accountId)return [];
 // Idle recovery performs a scoped Mongo existence read only, never a provider read.
 if(!await PositionClose.exists({accountId,userId:String(ownerId),$or:[{active:true},{needsProtectionRecovery:true}]}))return [];
 const broker=(deps.brokerFactory||require('../robotrader/alpacaBroker').createAlpacaBroker)({mode:'paper'});
 const lifecycle=(deps.lifecycleFactory||require('./orderLifecycleService').getOrderLifecycle)({broker,ownerId,expectedAccountId:accountId});
 const results=await lifecycle.resumeCloses();
 const pending=await PositionClose.find({accountId,userId:String(ownerId),active:false,needsProtectionRecovery:true});
 if(pending.length){
  const protection=require('./orderProtectionService').createOrderProtection({broker,ownerId,expectedAccountId:accountId});
  for(const close of pending){
   const entries=await OrderIntent.find({accountId,userId:String(ownerId),executionSource:'alpaca-paper',side:'buy',filledQty:{$gt:0},symbol:close.symbol});
   let confirmed=true;
   for(const entry of entries){const result=await protection.reconcile({intentId:entry._id});if(result&&!['protected','flat'].includes(result.state))confirmed=false;}
   if(confirmed)await PositionClose.updateOne({_id:close._id,active:false},{$set:{needsProtectionRecovery:false}});
  }
 }
 return results;
}
module.exports={recoverPositionCloses};
