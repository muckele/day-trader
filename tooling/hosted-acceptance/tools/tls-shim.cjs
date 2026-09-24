'use strict';
const diagnostic=require('./startup-diagnostics.cjs');
process.on('uncaughtExceptionMonitor',e=>diagnostic.failure('TLS-shim','H',e));
const https=require('node:https'),http=require('node:http'),fs=require('node:fs');
require('./config.cjs').load();
const {parseRequest}=require('./policy.cjs');const assets=JSON.parse(fs.readFileSync('/config/assets.json'));
const names=new Set(['day-trader-frontend.fly.dev','day-trader-backend.fly.dev','fonts.googleapis.com','fonts.gstatic.com']);
const server=https.createServer({key:fs.readFileSync('/tls/key.pem'),cert:fs.readFileSync('/tls/cert.pem'),minVersion:'TLSv1.2',maxHeaderSize:16384},(req,res)=>{
  const host=req.headers.host,sni=req.socket.servername;
  if(!names.has(host)||host!==sni||req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='host').length!==1){res.writeHead(421);return res.end();}
  if(!req.url.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);return res.end();}
  if(Object.keys(req.headers).some(k=>/^(x-http-method|x-method|x-forwarded|forwarded$|x-original|x-rewrite|proxy-)/i.test(k))){res.writeHead(403);return res.end();}
  const parsed=parseRequest({method:req.method,target:req.url,rawHeaders:req.rawHeaders},assets);if(!parsed){res.writeHead(403);return res.end();}
  const headers={};for(const k of ['host','origin','content-type','content-length','cookie','accept','accept-encoding','access-control-request-method','access-control-request-headers','if-none-match','if-modified-since','cache-control'])if(req.headers[k])headers[k]=req.headers[k];
  if(req.headers['transfer-encoding']){res.writeHead(400);return res.end();}
  const u=http.request({socketPath:'/gateway/gateway.sock',path:parsed.target,method:parsed.method,headers,timeout:12000},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  u.on('timeout',()=>u.destroy());u.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(u);
});
server.on('connect',(_,s)=>s.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
server.on('upgrade',(_,s)=>s.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
server.on('clientError',(_,s)=>s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
server.on('error',e=>{diagnostic.failure('TLS-shim','H',e);process.exitCode=1;});
server.listen(443,'127.0.0.1',()=>{const receipt={pid:process.pid,address:'127.0.0.1',port:443};fs.writeFileSync('/evidence/startup-tls-ready.json',JSON.stringify(receipt),{mode:0o600});diagnostic.record('TLS-shim','H','listen',receipt);});
