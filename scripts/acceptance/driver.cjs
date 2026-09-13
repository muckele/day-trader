const mongoose=require('../../backend/node_modules/mongoose');
const {executionReadiness}=require('../../backend/services/executionReadiness');
const {ensureTradingIndexes}=require('../../backend/services/tradingIndexService');
const {ensureResearchIndexes}=require('../../backend/services/researchIndexService');
async function main(){
 if(process.env.NODE_ENV!=='test'||!/^mongodb:\/\/127\.0\.0\.1:27189\/mvp_test_/.test(process.env.MONGO_URI||''))throw new Error('Disposable acceptance database required');
 await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:5000});
 try{await executionReadiness.bootstrap(async()=>(await Promise.all([ensureTradingIndexes(),ensureResearchIndexes()])).flat(),()=>mongoose.connection.collection('operationalreadiness').updateOne({_id:'process-probe'},{$set:{checkedAt:new Date()}},{upsert:true,writeConcern:{w:'majority'}}));
 executionReadiness.assertReady();
 const operation=process.argv[2];let result;
 if(operation==='reconcile')result=await require('../../backend/robotrader/reconciliation').reconcileRoboOrders({userId:process.env.OWNER_USER_ID});
 else if(operation==='worker')result=await require('../../backend/robotrader/worker').runRoboTraderForUser({userId:process.env.OWNER_USER_ID});
 else if(operation==='emergency-stop')result=await require('../../backend/robotrader/worker').emergencyStop({userId:process.env.OWNER_USER_ID,cancelOpenOrders:true,environment:'paper'});
 else throw new Error('Unknown process operation');
 process.stdout.write('\nACCEPTANCE_RESULT '+JSON.stringify(result)+'\n');
 }finally{await mongoose.disconnect();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
