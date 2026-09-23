'use strict';
// TEST ONLY server: original application responses, plus separate provider boundary.
const https=require('https'),http=require('http'),fs=require('fs');
const F='day-trader-frontend.fly.dev',B='day-trader-backend.fly.dev',P='paper-api.alpaca.markets';
const log=r=>fs.appendFileSync('/evidence/upstream.jsonl',JSON.stringify({at:new Date().toISOString(),...r})+'\n');
const server=https.createServer({key:fs.readFileSync('/certs/key.pem'),cert:fs.readFileSync('/certs/cert.pem')},(req,res)=>{
 const h=req.headers.host;if(h!==req.socket.servername||![F,B,P].includes(h)){res.writeHead(421);return res.end();}
 if(h===P){log({type:'provider',method:req.method,path:req.url});if(req.method!=='GET'){res.writeHead(405);return res.end();}
  let data;switch(req.url){case '/v2/account':data={id:'synthetic-paper-account',status:'ACTIVE',currency:'USD',equity:'10000',last_equity:'9900',cash:'9700',buying_power:'19400',trading_blocked:false,account_blocked:false};break;case '/v2/positions':data=[{symbol:'SYN',qty:'3',avg_entry_price:'90',current_price:'100',market_value:'300',unrealized_pl:'30'}];break;case '/v2/account/portfolio/history?period=1M&timeframe=1D&extended_hours=false':data={timestamp:[Math.floor(Date.now()/1000)-86400,Math.floor(Date.now()/1000)],equity:[9900,10000]};break;default:res.writeHead(403);return res.end();}
  res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(data));
 }
 if(fs.existsSync('/evidence/drop-response')){log({type:'uncertain-fixture',method:req.method,path:req.url});req.socket.destroy();return;}
 const u=http.request({hostname:'127.0.0.1',port:h===F?8080:5001,path:req.url,method:req.method,headers:req.headers},r=>{log({type:'application',host:h===F?'frontend':'backend',method:req.method,path:req.url,status:r.statusCode});res.writeHead(r.statusCode,r.headers);r.pipe(res);});u.on('error',()=>{res.writeHead(503);res.end();});req.pipe(u);
});server.listen(443,'0.0.0.0');

// Known listening forbidden port proves firewall denial rather than connection refusal.
require('net').createServer(s=>s.end('synthetic-canary')).listen(80,'0.0.0.0');
