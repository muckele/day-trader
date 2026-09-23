'use strict';
// Runs only in the disposable internal test namespace. All endpoints are loopback.
const fs=require('fs'),https=require('https'),http=require('http'),assert=require('assert/strict');
const {forward}=require('../tools/transport.cjs');
const host='day-trader-backend.fly.dev';
const config={profile:'production-rehearsal',testCA:'/private/upstream/ca.pem',upstreams:{[host]:['127.0.0.1']}};
const d={host,method:'GET',target:'/health',headers:{host}};
(async()=>{
 for(const [name,dir,plain,pass] of [['trusted','upstream',false,true],['hostname','negative/wrong',false,false],['expired','negative/expired',false,false],['untrusted','negative/untrusted',false,false],['plaintext','upstream',true,false]]){
  config.testCA='/private/'+(['hostname','expired'].includes(name)?dir+'/cert.pem':'upstream/ca.pem');
  let received=0;
  const handler=(req,res)=>{received++;res.end('synthetic');};
  const opts={key:fs.readFileSync('/private/'+dir+'/key.pem'),cert:fs.readFileSync('/private/'+dir+'/cert.pem')};
  const server=plain?http.createServer(handler):https.createServer(opts,handler);
  await new Promise(r=>server.listen(443,'127.0.0.1',r));
  let success=false;
  try{await new Promise(async(resolve,reject)=>{try{const q=await forward(config,d,Buffer.alloc(0),r=>{r.resume();r.on('end',resolve)});q.on('error',reject)}catch(e){reject(e)}});success=true;}catch{}
  await new Promise(r=>server.close(r));
  assert.equal(success,pass,name);assert.equal(received,pass?1:0,'HTTP bytes before verified TLS: '+name);
 }
 console.log('TLS_TRANSPORT_PASS trusted hostname expired untrusted plaintext; invalid TLS received zero HTTP requests');
})().catch(()=>{console.log('TLS_TRANSPORT_FAILED');process.exit(1)});
