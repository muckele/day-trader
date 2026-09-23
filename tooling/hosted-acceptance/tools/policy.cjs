'use strict';
const F='day-trader-frontend.fly.dev',B='day-trader-backend.fly.dev',VERSION='production-observational-v2';
const routes={
 '/api/me':{id:'me',cost:0},'/api/readiness':{id:'readiness',cost:0},'/health':{id:'health',cost:0},
 '/api/robotrader/settings':{id:'settings',cost:0},
 '/api/robotrader/decisions':{id:'decisions',query:{environment:'paper',limit:'25'},cost:0},
 '/api/robotrader/orders':{id:'robo-orders',query:{environment:'paper',limit:'25'},cost:0},
 '/api/robotrader/performance':{id:'performance',query:{environment:'paper'},cost:2},
 '/api/robotrader/audit':{id:'audit',query:{limit:'25'},cost:0},
 '/api/robotrader/health':{id:'robo-health',cost:1},
 '/api/robotrader/reconciliation-status':{id:'reconciliation',query:{environment:'paper'},cost:0},
 '/api/robotrader/notifications':{id:'notifications',cost:0},
 '/api/paper-trades/account':{id:'portfolio-account',cost:2},'/api/paper-trades/equity':{id:'portfolio-equity',cost:2},
 '/api/paper-trades/orders':{id:'activity-orders',cost:1},'/api/paper-trades/trades':{id:'activity-trades',cost:1}
};
const shell=new Set(['/','/login','/robo','/portfolio','/activity','/favicon.ico','/manifest.json','/logo192.png','/logo512.png','/static/js/acceptance-missing.js']);
function parseRequest(req,assets=[]){
 const {method,target,rawHeaders}=req;if(!['GET','HEAD','POST','OPTIONS'].includes(method)||!Array.isArray(rawHeaders)||rawHeaders.length%2)return null;
 const h={};for(let i=0;i<rawHeaders.length;i+=2){const k=String(rawHeaders[i]).toLowerCase(),v=String(rawHeaders[i+1]);if(Object.hasOwn(h,k)||/[\r\n\x00]/.test(v))return null;h[k]=v;}
 if(![F,B].includes(h.host))return null;
 if(Object.keys(h).some(k=>/^(x-http-method|x-method|x-forwarded|forwarded$|x-original|x-rewrite|proxy-|upgrade$|transfer-encoding$|te$|trailer$|expect$)/i.test(k)))return null;
 if(h.connection&&!['keep-alive','close'].includes(h.connection.toLowerCase()))return null;
 if(typeof target!=='string'||!target.startsWith('/')||target.startsWith('//')||/[\\\s#%\x00-\x1f\x7f]/.test(target))return null;
 const parts=target.split('?');if(parts.length>2||(parts.length===2&&!parts[1]))return null;
 const path=parts[0];if(path.includes('//')||path.split('/').some(x=>x==='.'||x==='..'))return null;
 if(h.origin&&h.origin!=='https://'+F)return null;
 let definition;
 if(h.host===F){if(!['GET','HEAD'].includes(method)||parts.length!==1||(!shell.has(path)&&!assets.includes(path)))return null;definition={id:path==='/static/js/acceptance-missing.js'?'missing-static':'static:'+path,cost:0};}
 else if(['POST','OPTIONS'].includes(method)){
  if(!['/api/login','/api/logout'].includes(path)||parts.length!==1||h.origin!=='https://'+F)return null;
  if(method==='OPTIONS'){if(h['access-control-request-method']!=='POST'||(h['access-control-request-headers']||'').toLowerCase()!=='content-type')return null;}
  else if(!/^(0|[1-9][0-9]{0,3})$/.test(h['content-length']||'')||Number(h['content-length'])>4096||(path==='/api/login'&&h['content-type']!=='application/json'))return null;
  definition={id:method==='OPTIONS'?'preflight:'+path:path==='/api/login'?'login':'logout',cost:0};
 }else{if(method!=='GET'||!Object.hasOwn(routes,path))return null;definition=routes[path];}
 if(['GET','HEAD','OPTIONS'].includes(method)&&h['content-length']&&h['content-length']!=='0')return null;
 const params=new URLSearchParams(parts[1]||''),expect=definition.query||{},keys=[...params.keys()];
 if(new Set(keys).size!==keys.length||keys.length!==Object.keys(expect).length||keys.some(k=>!Object.hasOwn(expect,k)||params.get(k)!==expect[k]))return null;
 const query=Object.keys(expect).sort().map(k=>k+'='+expect[k]).join('&');
 return Object.freeze({host:h.host,method,path,target:path+(query?'?'+query:''),id:definition.id,cost:definition.cost,headers:h});
}
function limitFor(id,phase){
 if(id.startsWith('static:'))return 5;
 if(['me','health'].includes(id))return 12;
 if(id==='readiness')return ['BEFORE','AFTER'].includes(phase)?2:0;
 if(id==='login')return phase==='AUTH'?1:0;
 if(id==='logout')return phase==='LOGOUT'?1:0;
 if(id.startsWith('preflight:'))return ['AUTH','LOGOUT'].includes(phase)?2:0;
 if(id==='missing-static')return phase==='BEFORE'?1:0;
 if(phase==='BEFORE')return 1;
 if(phase==='AFTER'&&['settings','decisions','robo-orders','performance','audit','robo-health','reconciliation'].includes(id))return 1;
 return 0;
}
module.exports={parseRequest,limitFor,routes,F,B,VERSION};
