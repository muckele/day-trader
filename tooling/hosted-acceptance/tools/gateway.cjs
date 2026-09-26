'use strict';
const fs=require('fs'),http=require('http'),net=require('net');const c=require('./config.cjs').load(),{parseRequest,limitFor,requestCost}=require('./policy.cjs'),{forward}=require('./transport.cjs');
const assets=JSON.parse(fs.readFileSync('/config/assets.json'));const statePath='/state/gateway.json';
let state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)): {run:c.run,lock:c.lock,phase:'PREFLIGHT',counts:{},paperReserved:c.paperAlready,attempts:0};if(state.run!==c.run||state.lock!==c.lock)throw Error('JOURNAL_MISMATCH');
function persist(){fs.writeFileSync(statePath+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(statePath+'.tmp',statePath);}
function log(x){fs.appendFileSync('/evidence/gateway.jsonl',JSON.stringify({at:new Date().toISOString(),run:c.run,...x})+'\n');}
persist();
const sequence=['PREFLIGHT','AUTH','BEFORE','HOLD','AFTER','LOGOUT','DONE'];
const control=net.createServer(s=>{let b='';s.setTimeout(2000,()=>s.destroy());s.on('data',x=>{b+=x;if(b.length>2048)return s.destroy();if(!b.includes('\n'))return;try{const q=JSON.parse(b);if(Object.keys(q).sort().join(',')!=='capability,phase,run'||q.run!==c.run||q.capability!==c.capability||sequence.indexOf(q.phase)!==sequence.indexOf(state.phase)+1)throw Error();state.phase=q.phase;persist();s.end('{"ok":true}');}catch{s.end('{"ok":false}');}});});
const server=http.createServer({maxHeaderSize:16384,requestTimeout:15000},async(req,res)=>{
 require('./security-probe.cjs').observeBoundary(req,res,'gateway');
 const d=parseRequest({method:req.method,target:req.url,rawHeaders:req.rawHeaders},assets);if(!d){log({event:'denied',...require('./private-leakage.cjs').routeMetadata('https://'+(req.headers.host||'invalid')+req.url,req.method,state.phase)});res.writeHead(403);return res.end();}
 const phase=state.phase,cost=requestCost(d,phase),key=phase+':'+d.id,count=state.counts[key]||0;
 // Login/logout ceiling is GLOBAL, including uncertain transport outcomes.
 const authCount=state.counts['global:'+d.id]||0;
 if(count>=limitFor(d.id,state.phase)||(['login','logout'].includes(d.id)&&authCount>=1)||state.paperReserved+cost>c.paperMaximum){log({event:'budget-denied',route:d.id});res.writeHead(429);return res.end();}
 state.counts[key]=count+1;state.counts['global:'+d.id]=authCount+1;state.paperReserved+=cost;state.attempts++;persist();
 const id=state.attempts,trace=require('./transport-observation.cjs').gatewayTrace(id,d);let body=Buffer.alloc(0),forwardStarted=false;try{
  for await(const chunk of req){if(body.length+chunk.length>4096)throw Error();body=Buffer.concat([body,chunk]);}
  if(Number(d.headers['content-length']||0)!==body.length)throw Error();
  forwardStarted=true;const r=await forward(c,d,body,up=>{if([300,301,302,303,305,307,308].includes(up.statusCode)){trace.branch('GATEWAY_REDIRECT_DENIED');up.resume();log({id,event:'redirect-denied',route:d.id,status:up.statusCode});res.writeHead(502);return res.end();}log({id,event:'forward',phase,route:d.id,method:d.method,status:up.statusCode,cost,paperReserved:state.paperReserved});res.writeHead(up.statusCode,up.headers);up.pipe(res);},trace);r.on('error',e=>{trace.branch('GATEWAY_UPSTREAM_REQUEST_ERROR',e);log({id,event:'upstream-error',route:d.id});if(!res.headersSent)res.writeHead(502);res.end();});
 }catch(e){trace.branch(forwardStarted?'GATEWAY_FORWARD_THROW':'GATEWAY_TRANSPORT_BODY_REJECTED',e);body.fill(0);log({id,event:'transport-rejected',route:d.id});if(!res.headersSent)res.writeHead(502);res.end();}
});
for(const ev of ['connect','upgrade'])server.on(ev,(_,s)=>s.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));server.on('clientError',(_,s)=>s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
for(const p of ['/gateway/gateway.sock','/gateway/control.sock'])if(fs.existsSync(p))fs.unlinkSync(p);
server.listen('/gateway/gateway.sock',()=>fs.chmodSync('/gateway/gateway.sock',0o600));control.listen('/gateway/control.sock',()=>fs.chmodSync('/gateway/control.sock',0o600));
