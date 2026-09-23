'use strict';
const https=require('https'),tls=require('tls'),fs=require('fs'),assert=require('assert/strict');
const host='day-trader-backend.fly.dev',ca=fs.readFileSync('/tls/cert.pem');
function get(){return new Promise((resolve,reject)=>{https.get({host:'127.0.0.1',port:443,servername:host,ca,path:'/api/me',headers:{host}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))}).on('error',reject)});}
function raw(request){return new Promise((resolve,reject)=>{const s=tls.connect({host:'127.0.0.1',port:443,servername:host,ca},()=>s.write(request));let b='';s.on('data',x=>{b+=x;if(b.includes('\r\n')){s.destroy();resolve(Number(b.split(' ')[1]))}});s.on('error',reject);s.setTimeout(5000,()=>s.destroy(Error('TIMEOUT')))});}
(async()=>{
 const mode=process.argv[2];
 if(mode==='framing'){
  for(const request of [
   `GET /api/me HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
   `GET /api/me?extra=1 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
   `GET /api/me HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
   `POST /api/paper-trades/order HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
   `GET /api/me HTTP/1.1\r\nHost: forbidden.invalid\r\nConnection: close\r\n\r\n`
  ]) assert.ok([400,403,421].includes(await raw(request)));
  assert.equal(await get(),401);
 }else if(mode==='uncertain'){
  // One valid DONE request already charged; eleven failed transports exhaust twelve.
  for(let i=0;i<11;i++)assert.equal(await get(),502);
  assert.equal(await get(),429);
 }else if(mode==='persisted')assert.equal(await get(),429);
 else throw Error('BAD_TEST_MODE');
 console.log('GATEWAY_'+mode.toUpperCase()+'_PASS');
})().catch(()=>{console.log('GATEWAY_NEGATIVE_FAILED');process.exit(1)});
