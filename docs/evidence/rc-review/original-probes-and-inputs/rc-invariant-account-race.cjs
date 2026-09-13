const root='/Users/Matt/Projects/day-trader';
const {startHarness}=require(root+'/scripts/acceptance/harness.cjs');
const Settings=require(root+'/backend/models/RoboSettings');
const Lock=require(root+'/backend/models/RoboLock');
const Intent=require(root+'/backend/models/OrderIntent');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const h=await startHarness();
 try {
  await Settings.updateOne({userId:h.ownerId},{$set:{isEnabled:true,enabled:true,riskLevel:'balanced'}});
  await h.control({patch:{trend:true,...(process.argv[2]?{holdPath:'/v2/account',holdOccurrence:Number(process.argv[2])}:{})}});
  if(!process.argv[2]){console.log(await h.run('worker'));console.log(JSON.stringify(h.provider.state.requests));return;}
  const running=h.run('worker').catch(e=>({error:e.message}));
  for(let n=0;n<200&&!h.provider.state.held;n++)await pause(50);
  if(!h.provider.state.held)throw new Error('No held account request');
  console.log('Held:',h.provider.state.held,'intents:',JSON.stringify(await Intent.find().lean()));
  if(process.argv[3]==='lease')await Lock.updateOne({userId:h.ownerId},{$set:{owner:'replacement-worker',lockedUntil:new Date(Date.now()+60000)}});
  else console.log('Emergency stop:',await h.run('emergency-stop'));
  console.log('POSTs before releasing account response:',h.provider.state.posts.length);
  await h.control({releaseHold:true});
  console.log('Worker:',await running);
  console.log('POSTs after stop/lease loss:',h.provider.state.posts.length);
  console.log('Settings enabled:',(await Settings.findOne({userId:h.ownerId}).lean()).isEnabled);
  console.log('Orders:',JSON.stringify(h.provider.state.orders));
 }finally{await h.control({releaseHold:true}).catch(()=>{});await h.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
