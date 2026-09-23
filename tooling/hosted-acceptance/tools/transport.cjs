'use strict';
const tls=require('tls'),https=require('https'),fs=require('fs');
// TLS handshake finishes and identity passes BEFORE any HTTP headers/body are sent.
function connect(c,host){return new Promise((resolve,reject)=>{
 const ips=c.upstreams[host];if(!ips)return reject(Error('DESTINATION_REJECTED'));
 const s=tls.connect({host:ips[0],port:443,servername:host,minVersion:'TLSv1.2',rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,...(c.profile==='production-rehearsal'?{ca:fs.readFileSync(c.testCA)}:{})});
 s.setTimeout(8000,()=>s.destroy(Error('TLS_TIMEOUT')));s.once('error',reject);s.once('secureConnect',()=>{if(!s.authorized){s.destroy();return reject(Error('TLS_REJECTED'));}s.removeListener('error',reject);resolve(s);});
 });}
async function forward(c,d,body,onResponse){const s=await connect(c,d.host);const headers={};for(const k of ['host','origin','content-type','content-length','cookie','accept','accept-encoding','if-none-match','if-modified-since','cache-control','access-control-request-method','access-control-request-headers'])if(d.headers[k]!==undefined)headers[k]=d.headers[k];
 const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>s;
 const r=https.request({hostname:d.host,port:443,path:d.target,method:d.method,headers,agent,timeout:10000},onResponse);r.on('timeout',()=>r.destroy(Error('UPSTREAM_TIMEOUT')));r.on('close',()=>agent.destroy());r.once('finish',()=>body.fill(0));r.once('error',()=>body.fill(0));r.end(body);return r;
}
module.exports={connect,forward};
