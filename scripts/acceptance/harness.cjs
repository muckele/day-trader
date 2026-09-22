const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const mongoose = require('../../backend/node_modules/mongoose');
const bcrypt = require('../../backend/node_modules/bcryptjs');
const { createProvider } = require('./provider.cjs');
const root = path.resolve(__dirname, '../..');
const listen = server => new Promise(r => server.listen(0,'127.0.0.1',()=>r(server.address().port)));
async function startHarness() {
 const workers=new Set();
 let provider,frontend,child,dbName;
 const stop=async p=>{if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await new Promise(r=>{const timer=setTimeout(()=>{p.kill('SIGKILL');r();},3000);p.once('exit',()=>{clearTimeout(timer);r();});});};
 const cleanup=async()=>{
  await Promise.all([...workers].map(stop));await stop(child);
  if(frontend?.listening){frontend.closeAllConnections();await new Promise(r=>frontend.close(r));}
  if(provider?.server.listening){provider.server.closeAllConnections();await new Promise(r=>provider.server.close(r));}
  if(mongoose.connection.readyState===1&&mongoose.connection.name===dbName)await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
 };
 try {
 provider=createProvider(); const providerPort=await provider.listen();
 dbName='mvp_test_browser_'+randomUUID().replaceAll('-','');
 const mongoUri=`mongodb://127.0.0.1:27189/${dbName}?replicaSet=mvp&directConnection=true`;
 await mongoose.connect(mongoUri,{serverSelectionTimeoutMS:5000});
 const User=require('../../backend/models/User'); const RoboSettings=require('../../backend/models/RoboSettings');
 const ownerId=new mongoose.Types.ObjectId().toString(); const otherId=new mongoose.Types.ObjectId().toString();
 await User.create([{_id:ownerId,username:'acceptance-owner',email:'owner@example.test',hash:await bcrypt.hash('local-test-password',10),sessionVersion:0},{_id:otherId,username:'other-user',email:'other@example.test',hash:await bcrypt.hash('other-password',10),sessionVersion:0}]);
 await RoboSettings.create({userId:ownerId,mode:'paper',isEnabled:false,enabled:false,dailyLimit:2000,weeklyLimit:5000,monthlyLimit:10000,maxTradeAmount:1000,maxPositionSize:5000,maxDailyLoss:500,maxOpenPositions:5,maxTradesPerDay:20,allowFractionalShares:false,allowExtendedHours:false,allowedAssetClasses:['stocks']});
 const reserve=http.createServer();const backendPort=await listen(reserve);await new Promise(r=>reserve.close(r));
 frontend=http.createServer((req,res)=>{
  if(req.url.startsWith('/api/')||req.url.startsWith('/health')){
   const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
   upstream.on('error',()=>{res.writeHead(503);res.end('Backend unavailable');});req.pipe(upstream);return;
  }
  const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const base=path.join(root,'frontend/build');
  const file=path.resolve(base,'.'+requested);const selected=file.startsWith(base+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?file:path.join(base,'index.html');
  const type=selected.endsWith('.js')?'application/javascript':selected.endsWith('.css')?'text/css':selected.endsWith('.svg')?'image/svg+xml':'text/html';
  res.setHeader('Content-Type',type);fs.createReadStream(selected).on('error',()=>res.end('Production build missing')).pipe(res);
 });
 const frontendPort=await listen(frontend);const baseURL=`http://127.0.0.1:${frontendPort}`;
 const env={ROBOTRADER_SYMBOL_UNIVERSE:'AAPL',ROBOTRADER_MAX_SYMBOLS_PER_RUN:'1',PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',PORT:String(backendPort),MONGO_LOCAL_URI:mongoUri,MONGO_URI:mongoUri,MONGO_PREFER_LOCAL:'true',JWT_SECRET:randomUUID()+randomUUID(),OWNER_USER_ID:ownerId,FRONTEND_ORIGIN:baseURL,BROKER_API_KEY:'acceptance-dummy',BROKER_API_SECRET:'acceptance-dummy-secret',ALPACA_BASE_URL:'https://paper-api.alpaca.markets',ALPACA_EXPECTED_PAPER_ACCOUNT_ID:'acceptance-paper',ALPACA_DATA_URL:'https://data.alpaca.markets',APCA_DATA_URL:'https://data.alpaca.markets',APP_PAPER_TRADES_SYNC_TO_ALPACA:'true',ROBO_SCHEDULER_DISABLED:'true',ACCEPTANCE_PROVIDER_URL:`http://127.0.0.1:${providerPort}`,AUTH_RATE_LIMIT_PER_WINDOW:'200',PUBLIC_DATA_RATE_LIMIT_PER_MINUTE:'2000'};
 child=spawn(process.execPath,['--require',path.join(__dirname,'transport.cjs'),'backend/server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 let ready=false;let cookie;
 for(let i=0;i<100;i++){
  try{
   if(!cookie){const login=await fetch(baseURL+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',origin:baseURL},body:JSON.stringify({username:'acceptance-owner',password:'local-test-password'})});if(login.ok)cookie=login.headers.get('set-cookie')?.split(';')[0];}
   if(cookie){const check=await fetch(baseURL+'/api/readiness',{headers:{cookie}});const state=await check.json();if(check.ok&&state.contractVersion===2&&state.runtimeReady&&state.maintenanceReady){ready=true;break;}}
  }catch{}
  if(child.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,100));
 }
 if(!ready)throw new Error('Actual backend readiness never became healthy: '+logs);
 return {baseURL,provider,ownerId,otherId,mongoUri,env,child,get logs(){return logs;},
  advanceServerClock:offsetMs=>new Promise(resolve=>{child.once('message',resolve);child.send({type:'acceptance-clock',offsetMs});}),
  control:async body=>(await fetch(env.ACCEPTANCE_PROVIDER_URL+'/control',{method:'POST',body:JSON.stringify(body)})).json(),
  spawn:(operation,extraEnv={})=>{
   const processChild=spawn(process.execPath,['--require',path.join(__dirname,'transport.cjs'),path.join(__dirname,'driver.cjs'),operation],{cwd:root,env:{...env,...extraEnv},stdio:['ignore','pipe','pipe','ipc']});
   workers.add(processChild);let output='';const messages=[];
   processChild.on('message',message=>messages.push(message));
   processChild.stdout.on('data',d=>output+=d);processChild.stderr.on('data',d=>output+=d);
   const completed=new Promise(resolve=>{
    processChild.once('error',error=>resolve({code:null,error:error.message,output}));
    processChild.once('exit',(code,signal)=>{workers.delete(processChild);resolve({code,signal,output});});
   });
   return {child:processChild,messages,completed,send:message=>processChild.send(message),get output(){return output;}};
  },
  run:operation=>new Promise((resolve,reject)=>{
   const processChild=spawn(process.execPath,['--require',path.join(__dirname,'transport.cjs'),path.join(__dirname,'driver.cjs'),operation],{cwd:root,env,stdio:['ignore','pipe','pipe']});
   workers.add(processChild);let output='';const timer=setTimeout(()=>processChild.kill('SIGKILL'),30000);
   processChild.stdout.on('data',d=>output+=d);processChild.stderr.on('data',d=>output+=d);
   processChild.on('error',error=>{clearTimeout(timer);workers.delete(processChild);reject(error);});
   processChild.on('exit',code=>{clearTimeout(timer);workers.delete(processChild);code===0?resolve(output):reject(new Error(output||'Acceptance worker timed out'));});
  }),
  close:cleanup
 };
 } catch(error){await cleanup();throw error;}
}
module.exports={startHarness};
