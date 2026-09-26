'use strict';
const tls=require('tls'),https=require('https'),fs=require('fs');
const {noop}=require('./transport-observation.cjs');
// TLS handshake finishes and identity passes BEFORE any HTTP headers/body are sent.
function connect(c,host,trace=noop){return new Promise((resolve,reject)=>{
 const ips=c.upstreams[host];trace.event('GT01_DESTINATION_LOOKUP',{started:true,completed:true,success:!!ips});if(!ips)return reject(Error('DESTINATION_REJECTED'));
 let s;trace.event('GT02_TLS_SOCKET_CREATE',{started:true,completed:false});
 try{s=tls.connect({host:ips[0],port:443,servername:host,minVersion:'TLSv1.2',rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,...(c.profile==='production-rehearsal'?{ca:fs.readFileSync(c.testCA)}:{})});}
 catch(e){trace.event('GT02_TLS_SOCKET_CREATE',{completed:true,success:false,error:e});throw e;}
 trace.event('GT02_TLS_SOCKET_CREATE',{completed:true,success:true});trace.socket(s);
 s.setTimeout(8000,()=>{trace.event('GT11_TIMEOUT',{timeout:true,component:'socket'});s.destroy(Error('TLS_TIMEOUT'));});s.once('error',reject);s.once('secureConnect',()=>{if(!s.authorized){s.destroy();return reject(Error('TLS_REJECTED'));}s.removeListener('error',reject);resolve(s);});
 });}
async function forward(c,d,body,onResponse,trace=noop){const s=await connect(c,d.host,trace);const headers={};for(const k of ['host','origin','content-type','content-length','cookie','accept','accept-encoding','if-none-match','if-modified-since','cache-control','access-control-request-method','access-control-request-headers'])if(d.headers[k]!==undefined)headers[k]=d.headers[k];
 const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>s;
 let r;trace.event('GT06_HTTP_REQUEST_CREATE',{started:true,completed:false});
 try{r=https.request({hostname:d.host,port:443,path:d.target,method:d.method,headers,agent,timeout:10000},up=>{trace.event('GT08_RESPONSE_HEADERS',{success:true,httpStatus:up.statusCode});onResponse(up);});}
 catch(e){trace.event('GT06_HTTP_REQUEST_CREATE',{completed:true,success:false,error:e});throw e;}
 trace.event('GT06_HTTP_REQUEST_CREATE',{completed:true,success:true});trace.request(r);
 r.on('timeout',()=>{trace.event('GT11_TIMEOUT',{timeout:true,component:'request'});r.destroy(Error('UPSTREAM_TIMEOUT'));});r.on('close',()=>agent.destroy());r.once('finish',()=>body.fill(0));r.once('error',()=>body.fill(0));r.end(body);return r;
}
module.exports={connect,forward};
